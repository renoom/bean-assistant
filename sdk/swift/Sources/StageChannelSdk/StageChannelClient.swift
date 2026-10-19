import Foundation

/// StageChannel WebSocket 客户端。
///
/// 使用 actor 隔离内部状态；对外是 `async/await` API + `@Sendable` 回调闭包。
/// 默认传输层是 `URLSessionWebSocketTask`，测试可以注入 `StageSocketTransport` mock。
///
/// ```swift
/// let connection = try GatewayDiscovery.gatewayConnection(
///     baseURL: consoleURL, gatewayWsPath: path, apiKey: key
/// )
/// let client = StageChannelClient(
///     connection: connection,
///     configuration: .init(
///         clientId: UUID().uuidString,
///         role: .assistant,
///         assistantId: "assistant-1",
///         name: "Swift 客户端",
///         registration: .development(id: "town:meadow", kind: "town")
///     )
/// )
/// await client.setEventHandler { event in
///     switch event {
///     case .connected(let info): print("connected", info.state)
///     case .command(let command): Task { await handle(command) }
///     case .disconnected(let reason, let code): print("closed", reason, code as Any)
///     default: break
///     }
/// }
/// try await client.connect()
/// ```
public actor StageChannelClient {
    // MARK: - 配置

    /// 客户端配置。
    public struct Configuration: Sendable, Equatable {
        /// 实例唯一，跨重连保持不变；不同实例必须不同（服务端据此判定 4001）。
        public var clientId: String
        /// `assistant` 会在 register 后自动 activate；`user` 跳过激活。
        public var role: StageRole
        public var assistantId: String?
        public var name: String?
        public var clientType: String
        /// 非 nil 时 `connect()` 自动完成 `stage_register`（以及 assistant 的 `stage_activate`）。
        public var registration: StageRegistration?
        public var activationMode: StageTransitionMode
        public var handshakeTimeout: TimeInterval
        public var requestTimeout: TimeInterval

        public init(
            clientId: String,
            role: StageRole = .assistant,
            assistantId: String? = nil,
            name: String? = nil,
            clientType: String = "swift",
            registration: StageRegistration? = nil,
            activationMode: StageTransitionMode = .afterTurn,
            handshakeTimeout: TimeInterval = StageChannelProtocol.handshakeTimeout,
            requestTimeout: TimeInterval = StageChannelProtocol.requestTimeout
        ) {
            self.clientId = clientId
            self.role = role
            self.assistantId = assistantId
            self.name = name
            self.clientType = clientType
            self.registration = registration
            self.activationMode = activationMode
            self.handshakeTimeout = handshakeTimeout
            self.requestTimeout = requestTimeout
        }
    }

    // MARK: - 常量

    /// command 的 stageId 不属于本客户端注册的 Stage 时的回执原因。
    public static let stageMismatchReason = "该场景未在此客户端加载"

    /// 默认传输层工厂：`URLSessionWebSocketTask`。
    public static let defaultTransportFactory: StageTransportFactory = { _, _ in
        URLSessionStageTransport()
    }

    // MARK: - 状态

    private struct PendingRequest {
        let operation: String
        let continuation: CheckedContinuation<StageMessage, Error>
    }

    public private(set) var state: StageConnectionState = .disconnected
    public private(set) var snapshot: StageSnapshot?
    public private(set) var helloAck: StageHelloAckFrame?
    public private(set) var registeredStageIds: Set<String> = []
    public private(set) var primaryStageId: String?
    public private(set) var activeStageId: String?

    private let connection: StageChannelConnection
    private let configuration: Configuration
    private let transportFactory: StageTransportFactory

    private var eventHandler: (@Sendable (StageClientEvent) -> Void)?
    private var transport: (any StageSocketTransport)?
    private var receiveTask: Task<Void, Never>?
    private var watchdogTask: Task<Void, Never>?
    private var requestTimeoutTasks: [String: Task<Void, Never>] = [:]
    private var pending: [String: PendingRequest] = [:]
    private var helloAckContinuation: CheckedContinuation<StageHelloAckFrame, Error>?
    private var handshakeError: StageChannelError?
    private var handshakeCompleted = false
    private var disconnectReported = false
    private var requestSequence = 0

    // MARK: - Init

    public init(
        connection: StageChannelConnection,
        configuration: Configuration,
        transportFactory: @escaping StageTransportFactory = StageChannelClient.defaultTransportFactory,
        eventHandler: (@Sendable (StageClientEvent) -> Void)? = nil
    ) {
        self.connection = connection
        self.configuration = configuration
        self.transportFactory = transportFactory
        self.eventHandler = eventHandler
    }

    // MARK: - 回调

    /// 设置事件回调（覆盖 init 中的 handler）。回调为 `@Sendable`，在 SDK 的后台执行器触发。
    public func setEventHandler(_ handler: (@Sendable (StageClientEvent) -> Void)?) {
        eventHandler = handler
    }

    // MARK: - 连接生命周期

    /// 建立连接并完成握手。
    ///
    /// 流程：`hello → hello_ack`；若配置了 `registration`，继续
    /// `stage_register`，assistant（非 `role == .user`）再 `stage_activate`。
    /// 整个握手受 `handshakeTimeout`（默认 30 秒）约束；失败会抛错并触发
    /// `error` + `disconnected` 回调。
    public func connect() async throws {
        guard state == .disconnected else {
            throw StageChannelError.invalidState(
                operation: "connect()",
                expected: "disconnected",
                actual: state
            )
        }
        state = .connecting
        disconnectReported = false
        handshakeCompleted = false
        handshakeError = nil
        helloAck = nil
        snapshot = nil
        registeredStageIds.removeAll()
        primaryStageId = nil
        activeStageId = nil

        let transport = transportFactory(connection.url, connection.headers)
        do {
            try await transport.open(url: connection.url, headers: connection.headers)
        } catch {
            state = .disconnected
            throw mapError(error)
        }
        self.transport = transport
        receiveTask = Task { [weak self] in
            guard let self else { return }
            await self.receiveLoop(transport)
        }
        startHandshakeWatchdog()

        do {
            let ack = try await waitForHelloAck()
            // handshake 状态（snapshot / registrations）已在 handle(.helloAck) 中更新。
            if let registration = configuration.registration {
                let registerResult = try await registerStage(registration)
                switch registerResult {
                case .rejected(let reason):
                    throw StageChannelError.registrationRejected(reason: reason)
                case .other(let kind, _):
                    throw StageChannelError.registrationRejected(reason: "未知注册结果：\(kind)")
                case .registered, .updated, .unchanged:
                    break
                }
                if configuration.role != .user {
                    let activation = try await activateStage(
                        stageId: registration.id,
                        mode: configuration.activationMode
                    )
                    switch activation {
                    case .rejected(let reason, _):
                        throw StageChannelError.activationRejected(reason: reason)
                    case .other(let kind, _):
                        throw StageChannelError.activationRejected(reason: "未知激活结果：\(kind)")
                    case .changed, .unchanged:
                        break
                    }
                }
            }
            _ = ack
            completeHandshake()
        } catch {
            let mapped = mapError(error)
            handshakeError = handshakeError ?? mapped
            await failHandshake(with: mapped)
            throw mapped
        }
    }

    /// 主动关闭连接。触发 `disconnected` 回调。
    public func close(reason: String = "client closed") async {
        guard state != .disconnected else { return }
        await finishDisconnected(reason: reason, code: 1000)
    }

    // MARK: - 协议操作

    /// 声明一个 Stage 能力（不改变当前激活的 Stage）。
    public func registerStage(_ registration: StageRegistration) async throws -> StageRegisterResult {
        try ensureConnected(operation: "registerStage")
        let requestId = nextRequestId(prefix: "register")
        let request = StageRegisterRequest(requestId: requestId, stage: registration)
        let response = try await performRequest(
            .stageRegister(request),
            requestId: requestId,
            operation: "stage_register"
        )
        guard case .stageRegisterResult(let frame) = response else {
            throw StageChannelError.protocolViolation("stage_register 收到意外帧：\(response.type)")
        }
        return frame.result
    }

    /// 激活已注册的 Stage。
    public func activateStage(
        stageId: String,
        mode: StageTransitionMode = .afterTurn,
        expectedStageId: String? = nil,
        expectedRevision: Int? = nil
    ) async throws -> StageTransitionResult {
        try ensureConnected(operation: "activateStage")
        let requestId = nextRequestId(prefix: "activate")
        let request = StageActivateRequest(
            requestId: requestId,
            stageId: stageId,
            mode: mode,
            expectedStageId: expectedStageId,
            expectedRevision: expectedRevision
        )
        let response = try await performRequest(
            .stageActivate(request),
            requestId: requestId,
            operation: "stage_activate"
        )
        guard case .stageActivateResult(let frame) = response else {
            throw StageChannelError.protocolViolation("stage_activate 收到意外帧：\(response.type)")
        }
        return frame.result
    }

    /// 切回默认空环境（`stage_transition` + `target=empty`）。
    public func transitionToEmpty(
        mode: StageTransitionMode = .afterTurn,
        expectedStageId: String? = nil,
        expectedRevision: Int? = nil
    ) async throws -> StageTransitionResult {
        try ensureConnected(operation: "transitionToEmpty")
        let requestId = nextRequestId(prefix: "transition")
        let request = StageTransitionRequest(
            requestId: requestId,
            stageId: activeStageId ?? primaryStageId ?? "",
            target: .empty,
            mode: mode,
            expectedStageId: expectedStageId,
            expectedRevision: expectedRevision
        )
        let response = try await performRequest(
            .stageTransition(request),
            requestId: requestId,
            operation: "stage_transition"
        )
        guard case .stageTransitionResult(let frame) = response else {
            throw StageChannelError.protocolViolation("stage_transition 收到意外帧：\(response.type)")
        }
        return frame.result
    }

    /// 上报一条 Stage 事件（`event`）。
    public func sendEvent(_ event: StageEvent, stageId: String? = nil) async throws {
        try ensureConnected(operation: "sendEvent")
        let effectiveStageId = stageId ?? activeStageId ?? primaryStageId
        try await send(.event(StageEventFrame(stageId: effectiveStageId, event: event)))
    }

    /// 便捷重载：`kind` + 任意字段。
    public func sendEvent(
        kind: String,
        fields: [String: JSONValue] = [:],
        stageId: String? = nil
    ) async throws {
        try await sendEvent(StageEvent(kind: kind, fields: fields), stageId: stageId)
    }

    /// 回复一条命令回执（`command_result`）。
    public func sendCommandResult(
        commandId: String,
        ok: Bool,
        result: JSONValue = .null,
        error: String? = nil
    ) async throws {
        try ensureConnected(operation: "sendCommandResult")
        try await send(.commandResult(StageCommandResultFrame(
            commandId: commandId,
            ok: ok,
            result: result,
            error: error
        )))
    }

    /// 便捷重载：直接回执某条 `StageCommand`。
    public func sendCommandResult(
        _ command: StageCommand,
        ok: Bool,
        result: JSONValue = .null,
        error: String? = nil
    ) async throws {
        try await sendCommandResult(commandId: command.commandId, ok: ok, result: result, error: error)
    }

    // MARK: - 握手

    private func waitForHelloAck() async throws -> StageHelloAckFrame {
        try await withCheckedThrowingContinuation { continuation in
            helloAckContinuation = continuation
            if let error = handshakeError {
                helloAckContinuation = nil
                continuation.resume(throwing: error)
                return
            }
            Task { [weak self] in
                guard let self else { return }
                do {
                    try await self.sendHelloFrame()
                } catch {
                    await self.failHello(with: error)
                }
            }
        }
    }

    private func sendHelloFrame() async throws {
        state = .helloSent
        let hello = StageHello(
            clientId: configuration.clientId,
            role: configuration.role,
            assistantId: configuration.assistantId,
            name: configuration.name,
            clientType: configuration.clientType
        )
        try await send(.hello(hello))
    }

    private func failHello(with error: Error) async {
        let mapped = mapError(error)
        if let continuation = helloAckContinuation {
            helloAckContinuation = nil
            continuation.resume(throwing: mapped)
        }
    }

    private func completeHandshake() {
        guard !handshakeCompleted else { return }
        handshakeCompleted = true
        watchdogTask?.cancel()
        watchdogTask = nil
        handshakeError = nil
        emit(.connected(StageConnectionInfo(
            clientId: configuration.clientId,
            bridgeId: helloAck?.bridgeId,
            state: state,
            snapshot: snapshot,
            registrations: helloAck?.registrations ?? []
        )))
    }

    private func startHandshakeWatchdog() {
        watchdogTask?.cancel()
        let timeout = max(configuration.handshakeTimeout, 0.001)
        watchdogTask = Task { [weak self] in
            try? await Task.sleep(for: .seconds(timeout))
            guard !Task.isCancelled else { return }
            await self?.handshakeWatchdogFired()
        }
    }

    private func handshakeWatchdogFired() async {
        guard !handshakeCompleted, !disconnectReported else { return }
        let error = StageChannelError.handshakeTimeout(phase: state)
        handshakeError = error
        failAllPending(with: error)
        if helloAckContinuation == nil && pending.isEmpty {
            emit(.error(error))
            await finishDisconnected(reason: error.localizedDescription, code: nil)
        }
    }

    private func failHandshake(with error: StageChannelError) async {
        guard !disconnectReported else { return }
        emit(.error(error))
        await finishDisconnected(reason: error.localizedDescription, code: error.closeCode)
    }

    // MARK: - 请求 / 响应

    private func performRequest(
        _ message: StageMessage,
        requestId: String,
        operation: String
    ) async throws -> StageMessage {
        try await withCheckedThrowingContinuation { continuation in
            pending[requestId] = PendingRequest(operation: operation, continuation: continuation)
            scheduleRequestTimeout(requestId: requestId, operation: operation)
            if let error = handshakeError {
                resolvePending(requestId: requestId, throwing: error)
                return
            }
            Task { [weak self] in
                guard let self else { return }
                do {
                    try await self.send(message)
                } catch {
                    await self.failRequest(requestId: requestId, error: error)
                }
            }
        }
    }

    private func scheduleRequestTimeout(requestId: String, operation: String) {
        let timeout = max(configuration.requestTimeout, 0.001)
        requestTimeoutTasks[requestId] = Task { [weak self] in
            try? await Task.sleep(for: .seconds(timeout))
            guard !Task.isCancelled else { return }
            await self?.requestTimedOut(requestId: requestId, operation: operation)
        }
    }

    private func requestTimedOut(requestId: String, operation: String) {
        guard let waiter = pending.removeValue(forKey: requestId) else { return }
        requestTimeoutTasks.removeValue(forKey: requestId)?.cancel()
        waiter.continuation.resume(throwing: StageChannelError.requestTimeout(operation: operation))
    }

    private func failRequest(requestId: String, error: Error) async {
        let mapped = mapError(error)
        guard let waiter = pending.removeValue(forKey: requestId) else { return }
        requestTimeoutTasks.removeValue(forKey: requestId)?.cancel()
        waiter.continuation.resume(throwing: mapped)
        emit(.error(mapped))
    }

    private func resolvePending(requestId: String, with message: StageMessage) {
        guard let waiter = pending.removeValue(forKey: requestId) else { return }
        requestTimeoutTasks.removeValue(forKey: requestId)?.cancel()
        waiter.continuation.resume(returning: message)
    }

    private func resolvePending(requestId: String?, with message: StageMessage) {
        guard let requestId else { return }
        resolvePending(requestId: requestId, with: message)
    }

    private func resolvePending(requestId: String, throwing error: StageChannelError) {
        guard let waiter = pending.removeValue(forKey: requestId) else { return }
        requestTimeoutTasks.removeValue(forKey: requestId)?.cancel()
        waiter.continuation.resume(throwing: error)
    }

    private func failAllPending(with error: StageChannelError) {
        if let continuation = helloAckContinuation {
            helloAckContinuation = nil
            continuation.resume(throwing: error)
        }
        let waiters = pending
        pending.removeAll()
        for (requestId, waiter) in waiters {
            requestTimeoutTasks.removeValue(forKey: requestId)?.cancel()
            waiter.continuation.resume(throwing: error)
        }
    }

    // MARK: - 接收循环

    private func receiveLoop(_ transport: any StageSocketTransport) async {
        while !Task.isCancelled {
            let inbound: StageSocketInbound
            do {
                inbound = try await transport.receive()
            } catch let error as StageChannelError {
                await handleTransportFailure(error)
                return
            } catch {
                await handleTransportFailure(.transport(error.localizedDescription))
                return
            }
            switch inbound {
            case .text(let text):
                await handleInboundText(text)
            case .binary(let data):
                if let text = String(data: data, encoding: .utf8) {
                    await handleInboundText(text)
                } else {
                    emit(.error(.decoding("收到非 UTF-8 的二进制帧")))
                }
            case .closed(let code, let reason):
                await handleRemoteClose(code: code, reason: reason)
                return
            }
        }
    }

    private func handleInboundText(_ text: String) async {
        let message: StageMessage
        do {
            message = try StageCodec.decode(text)
        } catch {
            emit(.error(.decoding("无法解析服务端帧：\(error.localizedDescription)")))
            return
        }
        await handle(message)
    }

    private func handle(_ message: StageMessage) async {
        switch message {
        case .helloAck(let frame):
            guard state == .helloSent || state == .connecting || state == .acknowledged else { return }
            if frame.channel != StageChannelProtocol.channelName {
                let error = StageChannelError.protocolViolation(
                    "hello_ack.channel 必须为 \(StageChannelProtocol.channelName)，实际为 \(frame.channel)"
                )
                helloAck = frame
                snapshot = frame.stage
                state = .acknowledged
                if let continuation = helloAckContinuation {
                    helloAckContinuation = nil
                    continuation.resume(throwing: error)
                }
                return
            }
            helloAck = frame
            snapshot = frame.stage
            for registration in frame.registrations {
                registeredStageIds.insert(registration.stageId)
            }
            state = .acknowledged
            if let continuation = helloAckContinuation {
                helloAckContinuation = nil
                continuation.resume(returning: frame)
            }

        case .stageRegisterResult(let frame):
            snapshot = frame.stage
            if let registration = frame.result.registration {
                registeredStageIds.insert(registration.stageId)
                primaryStageId = registration.stageId
            }
            if state == .acknowledged {
                state = .registered
            }
            resolvePending(requestId: frame.requestId, with: message)
            emit(.registerResult(frame.result))

        case .stageUnregisterResult(let frame):
            snapshot = frame.stage
            if let stageId = primaryStageId, frame.stage.id == stageId {
                primaryStageId = nil
            }
            resolvePending(requestId: frame.requestId, with: message)

        case .stageActivateResult(let frame):
            applyTransition(frame.result, activating: true)
            resolvePending(requestId: frame.requestId, with: message)
            emit(.activateResult(frame.result))

        case .stageTransitionResult(let frame):
            applyTransition(frame.result, activating: false)
            resolvePending(requestId: frame.requestId, with: message)
            emit(.activateResult(frame.result))

        case .command(let frame):
            let command = frame.stageCommand
            let commandStageId = frame.stageId
            if !commandStageId.isEmpty && !registeredStageIds.contains(commandStageId) {
                // 不属于本客户端注册的 Stage：自动回 ok:false，不交付业务回调。
                try? await sendCommandResult(
                    commandId: frame.commandId,
                    ok: false,
                    result: .null,
                    error: StageChannelClient.stageMismatchReason
                )
                return
            }
            emit(.command(command))

        case .llmEvent(let frame):
            emit(.llmEvent(frame.event))

        case .eventRejected(let frame):
            emit(.error(.eventRejected(reason: frame.reason)))

        case .error(let frame):
            let error = StageChannelError.serverError(requestId: frame.requestId, message: frame.error)
            if let requestId = frame.requestId {
                resolvePending(requestId: requestId, throwing: error)
            } else if helloAckContinuation != nil {
                await failHello(with: error)
            }
            emit(.error(error))
            if !handshakeCompleted && pending.isEmpty && state != .disconnected {
                await finishDisconnected(reason: error.localizedDescription, code: nil)
            }

        case .hello, .stageRegister, .stageUnregister, .stageActivate, .stageTransition,
             .commandResult, .event, .unknown:
            // 未知 type / 客户端方向帧：容忍并忽略。
            break
        }
    }

    private func applyTransition(_ result: StageTransitionResult, activating: Bool) {
        switch result {
        case .changed(let stage), .unchanged(let stage):
            snapshot = stage
            if activating {
                activeStageId = stage.isEmptyStage ? nil : stage.id
                state = .active
            } else {
                activeStageId = nil
                state = .registered
            }
        case .rejected(_, let stage):
            if let stage { snapshot = stage }
        case .other:
            break
        }
    }

    // MARK: - 断开

    private func handleTransportFailure(_ error: StageChannelError) async {
        guard !disconnectReported else { return }
        failAllPending(with: error)
        await finishDisconnected(reason: error.localizedDescription, code: error.closeCode)
    }

    private func handleRemoteClose(code: Int?, reason: String?) async {
        guard !disconnectReported else { return }
        let error = StageChannelError.connectionClosed(code: code, reason: reason)
        failAllPending(with: error)
        await finishDisconnected(reason: Self.closeDescription(code: code, reason: reason), code: code)
    }

    private func finishDisconnected(reason: String, code: Int?) async {
        guard !disconnectReported else { return }
        disconnectReported = true
        state = .disconnected
        handshakeError = nil
        watchdogTask?.cancel()
        watchdogTask = nil
        let task = receiveTask
        receiveTask = nil
        task?.cancel()
        for timeoutTask in requestTimeoutTasks.values { timeoutTask.cancel() }
        requestTimeoutTasks.removeAll()
        failAllPending(with: .connectionClosed(code: code, reason: reason))
        // 先发回调再关闭传输层：保证调用方在 await/throw 返回前收到 disconnected。
        emit(.disconnected(reason: reason, code: code))
        let transport = self.transport
        self.transport = nil
        if let transport {
            await transport.close(code: code ?? 1000, reason: reason)
        }
    }

    private static func closeDescription(code: Int?, reason: String?) -> String {
        var description = "WebSocket 已关闭"
        if let code { description += " (code=\(code)" }
        if let reason, !reason.isEmpty { description += code == nil ? " (\(reason)" : ", reason=\(reason)" }
        if code != nil || (reason?.isEmpty == false) { description += ")" }
        return description
    }

    // MARK: - 工具

    private func ensureConnected(operation: String) throws {
        guard transport != nil, state.isConnected else {
            throw StageChannelError.invalidState(
                operation: operation,
                expected: "acknowledged/registered/active",
                actual: state
            )
        }
    }

    private func nextRequestId(prefix: String) -> String {
        requestSequence += 1
        return "\(prefix)-\(configuration.clientId)-\(requestSequence)"
    }

    private func send(_ message: StageMessage) async throws {
        guard let transport else { throw StageChannelError.notConnected }
        let text = try StageCodec.encodeString(message)
        do {
            try await transport.send(text: text)
        } catch let error as StageChannelError {
            throw error
        } catch {
            throw StageChannelError.transport(error.localizedDescription)
        }
    }

    private func emit(_ event: StageClientEvent) {
        eventHandler?(event)
    }

    private func mapError(_ error: Error) -> StageChannelError {
        if let error = error as? StageChannelError { return error }
        return .transport(error.localizedDescription)
    }
}
