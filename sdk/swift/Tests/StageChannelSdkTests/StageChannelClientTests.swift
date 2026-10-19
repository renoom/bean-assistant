import XCTest
@testable import StageChannelSdk

/// 状态机 / 命令路由测试：注入 `MockStageTransport`，完全无网络。
final class StageChannelClientTests: XCTestCase {
    // MARK: - 握手

    func testAssistantHandshakeRegistersAndActivates() async throws {
        let mock = MockStageTransport()
        let recorder = EventRecorder()
        let registration = makeRegistration()
        await installDefaultResponder(mock)
        let client = makeClient(mock: mock, recorder: recorder, registration: registration)

        try await client.connect()

        let state = await client.state
        XCTAssertEqual(state, .active)
        let activeStageId = await client.activeStageId
        XCTAssertEqual(activeStageId, "town:meadow")
        let snapshot = await client.snapshot
        XCTAssertEqual(snapshot?.id, "town:meadow")
        XCTAssertEqual(snapshot?.status, .active)
        let registeredStages = await client.registeredStageIds
        XCTAssertEqual(registeredStages, ["town:meadow"])

        // 出站帧顺序：hello → stage_register → stage_activate。
        let sent = await mock.sentTexts
        let messages = sent.compactMap { try? StageCodec.decode($0) }
        XCTAssertEqual(messages.map(\.type), ["hello", "stage_register", "stage_activate"])

        guard case .hello(let hello) = messages[0] else { return XCTFail("第一帧应为 hello") }
        XCTAssertEqual(hello.channel, "stage")
        XCTAssertEqual(hello.clientId, "swift-1")
        XCTAssertEqual(hello.role, .assistant)
        XCTAssertEqual(hello.assistantId, "assistant-1")
        XCTAssertEqual(hello.name, "Swift 测试")
        XCTAssertEqual(hello.clientType, "swift")

        guard case .stageRegister(let register) = messages[1] else { return XCTFail("第二帧应为 stage_register") }
        XCTAssertEqual(register.stage.id, "town:meadow")
        XCTAssertEqual(register.stage.kind, "town")
        XCTAssertEqual(register.stage.environment?.text, "萤火镇")
        XCTAssertEqual(register.stage.commands.first?.name, "say")
        XCTAssertNotNil(register.requestId)

        guard case .stageActivate(let activate) = messages[2] else { return XCTFail("第三帧应为 stage_activate") }
        XCTAssertEqual(activate.stageId, "town:meadow")
        XCTAssertEqual(activate.mode, .afterTurn)
        XCTAssertNotNil(activate.requestId)

        // 传输层拿到的连接参数。
        let opens = await mock.openCalls
        XCTAssertEqual(opens.first?.url.absoluteString, "ws://127.0.0.1:41232/ws")
        XCTAssertEqual(opens.first?.headers["X-API-Key"], "key-1")

        // 回调。
        XCTAssertEqual(recorder.connectedEvents.count, 1)
        XCTAssertEqual(recorder.connectedEvents.first?.state, .active)
        XCTAssertEqual(recorder.connectedEvents.first?.bridgeId, "stage:swift-1:town:meadow")
        XCTAssertEqual(recorder.registerResults.first?.kind, "registered")
        XCTAssertEqual(recorder.activateResults.first?.kind, "changed")
        XCTAssertTrue(recorder.errors.isEmpty)
    }

    func testUserRoleSkipsActivation() async throws {
        let mock = MockStageTransport()
        let recorder = EventRecorder()
        await installDefaultResponder(mock)
        let client = makeClient(mock: mock, recorder: recorder, role: .user, registration: makeRegistration())

        try await client.connect()

        let state = await client.state
        XCTAssertEqual(state, .registered)
        let sent = await mock.sentTexts
        XCTAssertEqual(sent.compactMap { try? StageCodec.decode($0).type }, ["hello", "stage_register"])
        XCTAssertEqual(recorder.connectedEvents.count, 1)
        XCTAssertEqual(recorder.connectedEvents.first?.state, .registered)
        XCTAssertTrue(recorder.activateResults.isEmpty)
    }

    func testHelloAckWithoutRegistrationCompletesAtHello() async throws {
        let mock = MockStageTransport()
        let recorder = EventRecorder()
        await installDefaultResponder(mock)
        let client = makeClient(mock: mock, recorder: recorder, registration: nil)

        try await client.connect()

        let state = await client.state
        XCTAssertEqual(state, .acknowledged)
        let sent = await mock.sentTexts
        XCTAssertEqual(sent.compactMap { try? StageCodec.decode($0).type }, ["hello"])
        XCTAssertEqual(recorder.connectedEvents.count, 1)
        XCTAssertEqual(recorder.connectedEvents.first?.state, .acknowledged)
        XCTAssertEqual(recorder.connectedEvents.first?.snapshot?.id, "empty")
    }

    func testHandshakeTimeoutFailsAndDisconnects() async throws {
        let mock = MockStageTransport()
        let recorder = EventRecorder()
        await mock.setResponder { _ in [] }
        let client = makeClient(
            mock: mock,
            recorder: recorder,
            registration: makeRegistration(),
            handshakeTimeout: 0.2
        )

        do {
            try await client.connect()
            XCTFail("无 hello_ack 应超时")
        } catch let error as StageChannelError {
            guard case .handshakeTimeout(let phase) = error else {
                return XCTFail("应为 handshakeTimeout，实际 \(error)")
            }
            XCTAssertEqual(phase, .helloSent)
        }

        let state = await client.state
        XCTAssertEqual(state, .disconnected)
        XCTAssertEqual(recorder.disconnectedEvents.count, 1)
        XCTAssertTrue(recorder.errors.contains { if case .handshakeTimeout = $0 { return true }; return false })
        let closeCalls = await mock.closeCalls
        XCTAssertFalse(closeCalls.isEmpty)
    }

    func testServerErrorDuringHandshakeFailsConnect() async throws {
        let mock = MockStageTransport()
        let recorder = EventRecorder()
        await mock.setResponder { text in
            guard case .hello? = try? StageCodec.decode(text) else { return [] }
            return inbound(FrameBuilder.serverError(message: "invalid api key"))
        }
        let client = makeClient(mock: mock, recorder: recorder, registration: makeRegistration())

        do {
            try await client.connect()
            XCTFail("服务端 error 应失败")
        } catch let error as StageChannelError {
            guard case .serverError(let requestId, let message) = error else {
                return XCTFail("应为 serverError，实际 \(error)")
            }
            XCTAssertNil(requestId)
            XCTAssertEqual(message, "invalid api key")
        }

        XCTAssertEqual(recorder.disconnectedEvents.count, 1)
        XCTAssertTrue(recorder.errors.contains { if case .serverError = $0 { return true }; return false })
    }

    func testWrongHelloAckChannelFailsHandshake() async throws {
        let mock = MockStageTransport()
        let recorder = EventRecorder()
        await mock.setResponder { text in
            guard case .hello(let hello)? = try? StageCodec.decode(text) else { return [] }
            return inbound(FrameBuilder.helloAck(clientId: hello.clientId, channel: "ai-town"))
        }
        let client = makeClient(mock: mock, recorder: recorder, registration: nil)

        do {
            try await client.connect()
            XCTFail("hello_ack.channel 不是 stage 应失败")
        } catch let error as StageChannelError {
            guard case .protocolViolation = error else {
                return XCTFail("应为 protocolViolation，实际 \(error)")
            }
        }
        XCTAssertEqual(recorder.disconnectedEvents.count, 1)
        XCTAssertTrue(recorder.errors.contains { if case .protocolViolation = $0 { return true }; return false })
    }

    func testRegistrationRejectedDuringHandshake() async throws {
        let mock = MockStageTransport()
        let recorder = EventRecorder()
        await mock.setResponder { text in
            guard let message = try? StageCodec.decode(text) else { return [] }
            switch message {
            case .hello(let hello):
                return inbound(FrameBuilder.helloAck(clientId: hello.clientId))
            case .stageRegister(let request):
                return inbound(FrameBuilder.registerRejected(
                    requestId: request.requestId ?? "",
                    reason: "stage is already registered"
                ))
            default:
                return []
            }
        }
        let client = makeClient(mock: mock, recorder: recorder, registration: makeRegistration())

        do {
            try await client.connect()
            XCTFail("注册被拒绝应失败握手")
        } catch let error as StageChannelError {
            guard case .registrationRejected(let reason) = error else {
                return XCTFail("应为 registrationRejected，实际 \(error)")
            }
            XCTAssertEqual(reason, "stage is already registered")
        }
        XCTAssertEqual(recorder.disconnectedEvents.count, 1)
        XCTAssertEqual(recorder.registerResults.first?.kind, "rejected")
        XCTAssertTrue(recorder.errors.contains {
            if case .registrationRejected = $0 { return true }
            return false
        })
    }

    func testActivationRejectedDuringHandshake() async throws {
        let mock = MockStageTransport()
        let recorder = EventRecorder()
        await mock.setResponder { text in
            guard let message = try? StageCodec.decode(text) else { return [] }
            switch message {
            case .hello(let hello):
                return inbound(FrameBuilder.helloAck(clientId: hello.clientId))
            case .stageRegister(let request):
                return inbound(FrameBuilder.registerResult(requestId: request.requestId ?? ""))
            case .stageActivate(let request):
                return inbound(FrameBuilder.activateRejected(
                    requestId: request.requestId ?? "",
                    reason: "stage is not registered by this client"
                ))
            default:
                return []
            }
        }
        let client = makeClient(mock: mock, recorder: recorder, registration: makeRegistration())

        do {
            try await client.connect()
            XCTFail("激活被拒绝应失败握手")
        } catch let error as StageChannelError {
            guard case .activationRejected(let reason) = error else {
                return XCTFail("应为 activationRejected，实际 \(error)")
            }
            XCTAssertEqual(reason, "stage is not registered by this client")
        }
        XCTAssertEqual(recorder.disconnectedEvents.count, 1)
        XCTAssertTrue(recorder.errors.contains {
            if case .activationRejected = $0 { return true }
            return false
        })
    }

    // MARK: - 命令路由

    func testCommandStageMismatchIsAutoRejected() async throws {
        let mock = MockStageTransport()
        let recorder = EventRecorder()
        await installDefaultResponder(mock)
        let client = makeClient(mock: mock, recorder: recorder, registration: makeRegistration())
        try await client.connect()

        await mock.push(text: try StageCodec.encodeString(FrameBuilder.command(stageId: "other:stage")))
        let resultText = try await mock.waitForSentText { text in
            guard case .commandResult? = try? StageCodec.decode(text) else { return false }
            return true
        }
        guard case .commandResult(let result) = try StageCodec.decode(resultText) else {
            return XCTFail("应自动回 command_result")
        }
        XCTAssertFalse(result.ok)
        XCTAssertEqual(result.error, StageChannelClient.stageMismatchReason)
        XCTAssertEqual(result.commandId, "stage-1")
        // 不匹配的命令不交付业务回调。
        XCTAssertTrue(recorder.commands.isEmpty)
    }

    func testCommandIsDeliveredAndResultCanBeSent() async throws {
        let mock = MockStageTransport()
        let recorder = EventRecorder()
        await installDefaultResponder(mock)
        let client = makeClient(mock: mock, recorder: recorder, registration: makeRegistration())
        try await client.connect()

        await mock.push(text: try StageCodec.encodeString(FrameBuilder.command()))
        let command = try await waitForCommand(recorder)
        XCTAssertEqual(command.commandId, "stage-1")
        XCTAssertEqual(command.stageId, "town:meadow")
        XCTAssertEqual(command.command, "say")
        XCTAssertEqual(command.args["text"]?.stringValue, "你好")
        XCTAssertEqual(command.bridgeId, "stage:godot-1:town:meadow")

        try await client.sendCommandResult(command, ok: true, result: ["accepted": true])
        let sent = await mock.sentTexts
        guard case .commandResult(let result) = try XCTUnwrap(sent.last.flatMap { try? StageCodec.decode($0) }) else {
            return XCTFail("最后一帧应为 command_result")
        }
        XCTAssertTrue(result.ok)
        XCTAssertEqual(result.result, ["accepted": true])
        XCTAssertNil(result.error)
        XCTAssertEqual(result.commandId, "stage-1")
    }

    func testCommandRejectedWhenNoStageRegistered() async throws {
        let mock = MockStageTransport()
        let recorder = EventRecorder()
        await installDefaultResponder(mock)
        let client = makeClient(mock: mock, recorder: recorder, registration: nil)
        try await client.connect()

        await mock.push(text: try StageCodec.encodeString(FrameBuilder.command(stageId: "town:meadow")))
        let resultText = try await mock.waitForSentText { text in
            guard case .commandResult? = try? StageCodec.decode(text) else { return false }
            return true
        }
        guard case .commandResult(let result) = try StageCodec.decode(resultText) else {
            return XCTFail("应自动回 command_result")
        }
        XCTAssertFalse(result.ok)
        XCTAssertTrue(recorder.commands.isEmpty)
    }

    func testLlmEventIsDelivered() async throws {
        let mock = MockStageTransport()
        let recorder = EventRecorder()
        await installDefaultResponder(mock)
        let client = makeClient(mock: mock, recorder: recorder, registration: makeRegistration())
        try await client.connect()

        await mock.push(text: try StageCodec.encodeString(FrameBuilder.llmEvent()))
        _ = try await recorder.waitFor { event in
            if case .llmEvent = event { return true }
            return false
        }
        XCTAssertEqual(recorder.llmEvents.first?["type"]?.stringValue, "assistant_message")
        XCTAssertEqual(recorder.llmEvents.first?["data"]?["turn"]?.intValue, 2)
    }

    func testServerErrorFrameAfterHandshakeIsReportedWithoutDisconnect() async throws {
        let mock = MockStageTransport()
        let recorder = EventRecorder()
        await installDefaultResponder(mock)
        let client = makeClient(mock: mock, recorder: recorder, registration: makeRegistration())
        try await client.connect()

        await mock.push(text: try StageCodec.encodeString(FrameBuilder.serverError(message: "unsupported interaction")))
        _ = try await recorder.waitFor { event in
            if case .error(.serverError(_, let message)) = event { return message == "unsupported interaction" }
            return false
        }
        let state = await client.state
        XCTAssertEqual(state, .active)
        XCTAssertTrue(recorder.disconnectedEvents.isEmpty)
    }

    // MARK: - 事件 / 切换

    func testSendEventUsesActiveStageId() async throws {
        let mock = MockStageTransport()
        let recorder = EventRecorder()
        await installDefaultResponder(mock)
        let client = makeClient(mock: mock, recorder: recorder, registration: makeRegistration())
        try await client.connect()

        try await client.sendEvent(kind: "user_said", fields: ["text": "你好"])
        let sent = await mock.sentTexts
        guard case .event(let frame) = try XCTUnwrap(sent.last.flatMap { try? StageCodec.decode($0) }) else {
            return XCTFail("最后一帧应为 event")
        }
        XCTAssertEqual(frame.stageId, "town:meadow")
        XCTAssertEqual(frame.event.kind, "user_said")
        XCTAssertEqual(frame.event.fields["text"]?.stringValue, "你好")
    }

    func testTransitionToEmpty() async throws {
        let mock = MockStageTransport()
        let recorder = EventRecorder()
        await installDefaultResponder(mock)
        let client = makeClient(mock: mock, recorder: recorder, registration: makeRegistration())
        try await client.connect()

        let result = try await client.transitionToEmpty(mode: .interrupt)
        guard case .changed(let stage) = result else {
            return XCTFail("应切回空环境")
        }
        XCTAssertEqual(stage.id, "empty")
        XCTAssertEqual(stage.status, .empty)

        let state = await client.state
        XCTAssertEqual(state, .registered)
        let activeStageId = await client.activeStageId
        XCTAssertNil(activeStageId)

        let sent = await mock.sentTexts
        guard case .stageTransition(let frame) = try XCTUnwrap(sent.last.flatMap { try? StageCodec.decode($0) }) else {
            return XCTFail("最后一帧应为 stage_transition")
        }
        XCTAssertEqual(frame.target, .empty)
        XCTAssertEqual(frame.mode, .interrupt)
        XCTAssertEqual(frame.stageId, "town:meadow")
    }

    func testRequestTimeoutWhenServerDoesNotAnswer() async throws {
        let mock = MockStageTransport()
        let recorder = EventRecorder()
        await installDefaultResponder(mock)
        let client = makeClient(
            mock: mock,
            recorder: recorder,
            registration: makeRegistration(),
            requestTimeout: 0.2
        )
        try await client.connect()
        await mock.clearResponder()

        do {
            _ = try await client.activateStage(stageId: "town:meadow")
            XCTFail("无响应应超时")
        } catch let error as StageChannelError {
            guard case .requestTimeout(let operation) = error else {
                return XCTFail("应为 requestTimeout，实际 \(error)")
            }
            XCTAssertEqual(operation, "stage_activate")
        }
        let state = await client.state
        XCTAssertEqual(state, .active)
    }

    // MARK: - 关闭 / 4001

    func testRemoteClose4001IsSurfaced() async throws {
        let mock = MockStageTransport()
        let recorder = EventRecorder()
        await installDefaultResponder(mock)
        let client = makeClient(mock: mock, recorder: recorder, registration: makeRegistration())
        try await client.connect()

        await mock.pushServerClose(code: 4001, reason: "clientId replaced by a new connection")
        _ = try await recorder.waitFor { event in
            if case .disconnected = event { return true }
            return false
        }
        XCTAssertEqual(recorder.disconnectedEvents.count, 1)
        XCTAssertEqual(recorder.disconnectedEvents.first?.code, 4001)
        XCTAssertEqual(recorder.disconnectedEvents.first?.reason.contains("4001"), true)

        let state = await client.state
        XCTAssertEqual(state, .disconnected)
        let closeCalls = await mock.closeCalls
        XCTAssertEqual(closeCalls.last?.code, 4001)

        do {
            try await client.sendCommandResult(commandId: "x", ok: true)
            XCTFail("断开后发送应失败")
        } catch let error as StageChannelError {
            guard case .invalidState = error else {
                return XCTFail("应为 invalidState，实际 \(error)")
            }
        }
    }

    func testCloseEmitsDisconnectedOnce() async throws {
        let mock = MockStageTransport()
        let recorder = EventRecorder()
        await installDefaultResponder(mock)
        let client = makeClient(mock: mock, recorder: recorder, registration: makeRegistration())
        try await client.connect()

        await client.close()
        XCTAssertEqual(recorder.disconnectedEvents.count, 1)
        XCTAssertEqual(recorder.disconnectedEvents.first?.code, 1000)

        await client.close()
        XCTAssertEqual(recorder.disconnectedEvents.count, 1)

        let state = await client.state
        XCTAssertEqual(state, .disconnected)
        let sentBefore = await mock.sentTexts.count
        do {
            try await client.sendEvent(kind: "user_said")
            XCTFail("断开后 sendEvent 应失败")
        } catch let error as StageChannelError {
            guard case .invalidState = error else {
                return XCTFail("应为 invalidState，实际 \(error)")
            }
        }
        let sentAfter = await mock.sentTexts.count
        XCTAssertEqual(sentBefore, sentAfter)
    }

    func testInvalidStateBeforeConnect() async throws {
        let mock = MockStageTransport()
        let recorder = EventRecorder()
        let client = makeClient(mock: mock, recorder: recorder, registration: makeRegistration())

        do {
            _ = try await client.registerStage(makeRegistration())
            XCTFail("未连接时 registerStage 应失败")
        } catch let error as StageChannelError {
            guard case .invalidState(let operation, _, let actual) = error else {
                return XCTFail("应为 invalidState，实际 \(error)")
            }
            XCTAssertEqual(operation, "registerStage")
            XCTAssertEqual(actual, .disconnected)
        }
    }

    func testConnectTwiceWhileConnectedThrows() async throws {
        let mock = MockStageTransport()
        let recorder = EventRecorder()
        await installDefaultResponder(mock)
        let client = makeClient(mock: mock, recorder: recorder, registration: makeRegistration())
        try await client.connect()

        do {
            try await client.connect()
            XCTFail("重复 connect 应失败")
        } catch let error as StageChannelError {
            guard case .invalidState(let operation, _, let actual) = error else {
                return XCTFail("应为 invalidState，实际 \(error)")
            }
            XCTAssertEqual(operation, "connect()")
            XCTAssertEqual(actual, .active)
        }
        await client.close()
    }

    // MARK: - 容忍性

    func testUnknownTypeAndFieldsAreTolerated() async throws {
        let mock = MockStageTransport()
        let recorder = EventRecorder()
        await mock.setResponder { text in
            guard case .hello(let hello)? = try? StageCodec.decode(text) else { return [] }
            let json = """
            {"type":"hello_ack","channel":"stage","clientId":"\(hello.clientId)","registrations":[],\
            "stage":{"id":"empty","kind":"empty","revision":0,"status":"empty","participants":[],"capabilities":[]},\
            "futureField":{"nested":1}}
            """
            return [.text(json)]
        }
        let client = makeClient(mock: mock, recorder: recorder, registration: nil)
        try await client.connect()

        let state = await client.state
        XCTAssertEqual(state, .acknowledged)

        await mock.push(text: #"{"type":"future_frame","payload":{"x":1}}"#)
        try await Task.sleep(for: .milliseconds(100))
        XCTAssertTrue(recorder.errors.isEmpty)
        let stateAfter = await client.state
        XCTAssertEqual(stateAfter, .acknowledged)

        // 连接仍可用。
        try await client.sendEvent(kind: "user_said", fields: ["text": "仍然可用"])
        let sent = await mock.sentTexts
        guard case .event = try XCTUnwrap(sent.last.flatMap { try? StageCodec.decode($0) }) else {
            return XCTFail("未知帧后应仍能发送 event")
        }
    }

    func testMalformedFrameReportsErrorButKeepsConnection() async throws {
        let mock = MockStageTransport()
        let recorder = EventRecorder()
        await installDefaultResponder(mock)
        let client = makeClient(mock: mock, recorder: recorder, registration: makeRegistration())
        try await client.connect()

        await mock.push(text: "not-json")
        _ = try await recorder.waitFor { event in
            if case .error(.decoding) = event { return true }
            return false
        }
        let state = await client.state
        XCTAssertEqual(state, .active)
    }

    // MARK: - Helpers

    private func makeRegistration(id: String = "town:meadow") -> StageRegistration {
        StageRegistration(
            id: id,
            kind: "town",
            environment: StageEnvironment(text: "萤火镇"),
            commands: [CommandSpec(name: "say", description: "在场景中说话")]
        )
    }

    private func makeClient(
        mock: MockStageTransport,
        recorder: EventRecorder,
        role: StageRole = .assistant,
        registration: StageRegistration? = nil,
        handshakeTimeout: TimeInterval = StageChannelProtocol.handshakeTimeout,
        requestTimeout: TimeInterval = StageChannelProtocol.requestTimeout,
        clientId: String = "swift-1"
    ) -> StageChannelClient {
        let connection = StageChannelConnection(
            mode: .direct,
            url: URL(string: "ws://127.0.0.1:41232/ws")!,
            headers: ["X-API-Key": "key-1"]
        )
        let configuration = StageChannelClient.Configuration(
            clientId: clientId,
            role: role,
            assistantId: "assistant-1",
            name: "Swift 测试",
            registration: registration,
            handshakeTimeout: handshakeTimeout,
            requestTimeout: requestTimeout
        )
        return StageChannelClient(
            connection: connection,
            configuration: configuration,
            transportFactory: { _, _ in mock },
            eventHandler: { event in recorder.record(event) }
        )
    }

    private func installDefaultResponder(_ mock: MockStageTransport) async {
        await mock.setResponder { text in
            guard let message = try? StageCodec.decode(text) else { return [] }
            switch message {
            case .hello(let hello):
                return inbound(FrameBuilder.helloAck(
                    clientId: hello.clientId,
                    bridgeId: "stage:\(hello.clientId):town:meadow"
                ))
            case .stageRegister(let request):
                return inbound(FrameBuilder.registerResult(requestId: request.requestId ?? ""))
            case .stageActivate(let request):
                return inbound(FrameBuilder.activateResult(requestId: request.requestId ?? ""))
            case .stageTransition(let request):
                return inbound(FrameBuilder.transitionResult(requestId: request.requestId ?? ""))
            default:
                return []
            }
        }
    }

    private func waitForCommand(_ recorder: EventRecorder) async throws -> StageCommand {
        let event = try await recorder.waitFor { event in
            if case .command = event { return true }
            return false
        }
        guard case .command(let command) = event else {
            throw MockStageTransport.MockTimeout.event
        }
        return command
    }
}

/// 把消息编码为入站文本帧。
private func inbound(_ message: StageMessage) -> [StageSocketInbound] {
    guard let text = try? StageCodec.encodeString(message) else { return [] }
    return [.text(text)]
}
