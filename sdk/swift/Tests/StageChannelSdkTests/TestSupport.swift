import Foundation
@testable import StageChannelSdk

/// 可注入的 WebSocket 传输层 mock。
///
/// - `send(text:)` 会记录所有出站帧；如果设置了 `responder`，同一个调用里会
///   生成入站帧（先入队、后由 `receive()` 取走），用于脚本化握手。
/// - `push(...)` 用于测试中主动模拟服务端推送（命令、llm_event、关闭帧等）。
actor MockStageTransport: StageSocketTransport {
    struct OpenCall: Sendable, Equatable {
        var url: URL
        var headers: [String: String]
    }

    struct CloseCall: Sendable, Equatable {
        var code: Int
        var reason: String
    }

    private(set) var openCalls: [OpenCall] = []
    private(set) var sentTexts: [String] = []
    private(set) var closeCalls: [CloseCall] = []
    private(set) var isOpen = false
    private(set) var receiveFinished = false

    private var responder: (@Sendable (String) async -> [StageSocketInbound])?
    private var buffered: [StageSocketInbound] = []
    private var waiters: [CheckedContinuation<StageSocketInbound, Error>] = []

    /// 安装脚本化响应器：`send` 时按出站帧内容返回入站帧。
    func setResponder(_ responder: @escaping @Sendable (String) async -> [StageSocketInbound]) {
        self.responder = responder
    }

    func clearResponder() {
        responder = nil
    }

    // MARK: StageSocketTransport

    func open(url: URL, headers: [String: String]) async throws {
        openCalls.append(OpenCall(url: url, headers: headers))
        isOpen = true
    }

    func send(text: String) async throws {
        guard isOpen else { throw StageChannelError.notConnected }
        sentTexts.append(text)
        if let responder {
            for inbound in await responder(text) {
                push(inbound)
            }
        }
    }

    func receive() async throws -> StageSocketInbound {
        guard isOpen else { throw StageChannelError.notConnected }
        if !buffered.isEmpty {
            return buffered.removeFirst()
        }
        return try await withCheckedThrowingContinuation { continuation in
            waiters.append(continuation)
        }
    }

    func close(code: Int, reason: String) async {
        closeCalls.append(CloseCall(code: code, reason: reason))
        guard isOpen else { return }
        isOpen = false
        deliver(.closed(code: code, reason: reason))
        // 关闭后不再有挂起接收者，避免 continuation 泄漏。
        let pending = waiters
        waiters.removeAll()
        for waiter in pending {
            waiter.resume(throwing: StageChannelError.notConnected)
        }
    }

    // MARK: Test helpers

    func push(_ inbound: StageSocketInbound) {
        deliver(inbound)
    }

    private func deliver(_ inbound: StageSocketInbound) {
        if waiters.isEmpty {
            buffered.append(inbound)
            return
        }
        let waiter = waiters.removeFirst()
        waiter.resume(returning: inbound)
    }

    func push(text: String) {
        push(.text(text))
    }

    /// 模拟服务端主动关闭（例如 4001）。
    func pushServerClose(code: Int, reason: String) {
        deliver(.closed(code: code, reason: reason))
        isOpen = false
        let pending = waiters
        waiters.removeAll()
        for waiter in pending {
            waiter.resume(throwing: StageChannelError.notConnected)
        }
    }

    /// 等待出现满足条件的出站帧（用于断言异步发送）。
    func waitForSentText(
        timeout: TimeInterval = 2,
        where predicate: (String) -> Bool
    ) async throws -> String {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if let text = sentTexts.first(where: predicate) {
                return text
            }
            try await Task.sleep(for: .milliseconds(5))
        }
        throw MockTimeout.sentText
    }

    /// 等待出站帧数量达到指定值。
    func waitForSentCount(_ count: Int, timeout: TimeInterval = 2) async throws {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if sentTexts.count >= count { return }
            try await Task.sleep(for: .milliseconds(5))
        }
        throw MockTimeout.sentCount
    }

    enum MockTimeout: Error {
        case sentText
        case sentCount
        case event
    }
}

/// 记录客户端回调（同步、有序）。
final class EventRecorder: @unchecked Sendable {
    private let lock = NSLock()
    private var storage: [StageClientEvent] = []

    func record(_ event: StageClientEvent) {
        lock.lock()
        storage.append(event)
        lock.unlock()
    }

    var events: [StageClientEvent] {
        lock.lock()
        defer { lock.unlock() }
        return storage
    }

    var errors: [StageChannelError] {
        events.compactMap {
            if case .error(let error) = $0 { return error }
            return nil
        }
    }

    var commands: [StageCommand] {
        events.compactMap {
            if case .command(let command) = $0 { return command }
            return nil
        }
    }

    var disconnectedEvents: [(reason: String, code: Int?)] {
        events.compactMap {
            if case .disconnected(let reason, let code) = $0 { return (reason, code) }
            return nil
        }
    }

    var connectedEvents: [StageConnectionInfo] {
        events.compactMap {
            if case .connected(let info) = $0 { return info }
            return nil
        }
    }

    var registerResults: [StageRegisterResult] {
        events.compactMap {
            if case .registerResult(let result) = $0 { return result }
            return nil
        }
    }

    var activateResults: [StageTransitionResult] {
        events.compactMap {
            if case .activateResult(let result) = $0 { return result }
            return nil
        }
    }

    var llmEvents: [JSONValue] {
        events.compactMap {
            if case .llmEvent(let event) = $0 { return event }
            return nil
        }
    }

    func waitFor(
        timeout: TimeInterval = 2,
        _ predicate: @escaping (StageClientEvent) -> Bool
    ) async throws -> StageClientEvent {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if let event = events.first(where: predicate) {
                return event
            }
            try await Task.sleep(for: .milliseconds(5))
        }
        throw MockStageTransport.MockTimeout.event
    }
}

// MARK: - JSON path helper

extension JSONValue {
    /// 按 key 路径读取嵌套对象（便于测试断言）。
    func value(at path: [String]) -> JSONValue? {
        var current: JSONValue? = self
        for key in path {
            guard let node = current, case .object(let object) = node else { return nil }
            current = object[key]
        }
        return current
    }
}

// MARK: - Fixture helpers

enum Fixtures {
    /// `#filePath` 位于 sdk/swift/Tests/StageChannelSdkTests/，向上三级即 sdk/。
    static var directory: URL {
        URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .appendingPathComponent("../../../spec/fixtures")
            .standardizedFileURL
    }

    static func data(_ name: String) throws -> Data {
        try Data(contentsOf: directory.appendingPathComponent(name))
    }

    static func text(_ name: String) throws -> String {
        String(decoding: try data(name), as: UTF8.self)
    }

    static func value(_ name: String) throws -> JSONValue {
        try StageCodec.jsonValue(from: try data(name))
    }

    static func manifest() throws -> FixtureManifest {
        try StageJSON.decode(FixtureManifest.self, from: try data("manifest.json"))
    }
}

struct FixtureManifest: Codable, Sendable, Equatable {
    struct Entry: Codable, Sendable, Equatable {
        var file: String
        var direction: String
        var type: String
    }

    var version: Int
    var fixtures: [Entry]
}

// MARK: - Frame helpers

enum FrameBuilder {
    static func encode(_ message: StageMessage) throws -> String {
        try StageCodec.encodeString(message)
    }

    static func helloAck(
        clientId: String = "godot-1",
        bridgeId: String? = nil,
        registrations: [Registration] = [],
        stage: StageSnapshot = .emptyStage,
        channel: String = StageChannelProtocol.channelName
    ) -> StageMessage {
        .helloAck(StageHelloAckFrame(
            channel: channel,
            clientId: clientId,
            bridgeId: bridgeId,
            registrations: registrations,
            stage: stage
        ))
    }

    static func registerResult(
        requestId: String,
        stageId: String = "town:meadow",
        stageKind: String = "town",
        stage: StageSnapshot = .emptyStage
    ) -> StageMessage {
        let registration = Registration(
            id: "stage:godot-1:\(stageId)",
            stageId: stageId,
            stageKind: stageKind,
            environment: StageEnvironment(text: "萤火镇"),
            capabilities: [CommandSpec(name: "say")]
        )
        return .stageRegisterResult(StageRegisterResultFrame(
            requestId: requestId,
            result: .registered(registration),
            stage: stage
        ))
    }

    static func registerRejected(requestId: String, reason: String) -> StageMessage {
        .stageRegisterResult(StageRegisterResultFrame(
            requestId: requestId,
            result: .rejected(reason: reason),
            stage: .emptyStage
        ))
    }

    static func activateResult(
        requestId: String,
        stageId: String = "town:meadow",
        status: StageStatus = .active,
        revision: Int = 1
    ) -> StageMessage {
        let snapshot = StageSnapshot(
            id: stageId,
            kind: "town",
            revision: revision,
            status: status,
            participants: [StageParticipant(id: "assistant-1", role: .assistant, name: "编码助手", online: true)],
            capabilities: [CommandSpec(name: "say")],
            environment: StageEnvironment(text: "萤火镇")
        )
        return .stageActivateResult(StageActivateResultFrame(
            requestId: requestId,
            result: .changed(snapshot)
        ))
    }

    static func transitionResult(requestId: String) -> StageMessage {
        .stageTransitionResult(StageTransitionResultFrame(
            requestId: requestId,
            result: .changed(.emptyStage)
        ))
    }

    static func command(
        commandId: String = "stage-1",
        stageId: String = "town:meadow",
        command: String = "say",
        args: JSONValue = .object(["text": .string("你好")])
    ) -> StageMessage {
        .command(StageCommandFrame(
            commandId: commandId,
            bridgeId: "stage:godot-1:town:meadow",
            stageId: stageId,
            command: command,
            args: args
        ))
    }

    static func activateRejected(requestId: String, reason: String) -> StageMessage {
        .stageActivateResult(StageActivateResultFrame(
            requestId: requestId,
            result: .rejected(reason: reason, stage: .emptyStage)
        ))
    }

    static func llmEvent() -> StageMessage {
        .llmEvent(StageLlmEventFrame(event: .object([
            "type": .string("assistant_message"),
            "data": .object([
                "turn": .int(2),
                "step": .int(1),
                "message": .object([
                    "role": .string("assistant"),
                    "content": .array([
                        .object(["type": .string("text"), "text": .string("你好，我在。")]),
                    ]),
                ]),
            ]),
        ])))
    }

    static func serverError(requestId: String? = nil, message: String) -> StageMessage {
        .error(StageErrorFrame(requestId: requestId, error: message))
    }
}

extension StageSnapshot {
    static let emptyStage = StageSnapshot(
        id: "empty",
        kind: "empty",
        revision: 0,
        status: .empty,
        participants: [],
        capabilities: []
    )
}

extension StageMessage {
    /// 解码为 `StageMessage` 便于断言。
    static func decode(_ text: String) throws -> StageMessage {
        try StageCodec.decode(text)
    }
}
