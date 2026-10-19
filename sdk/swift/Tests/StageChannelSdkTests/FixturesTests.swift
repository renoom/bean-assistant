import XCTest
@testable import StageChannelSdk

/// 与 `sdk/spec/fixtures/` 的一致性测试（协议唯一源）。
final class FixturesTests: XCTestCase {
    func testManifestListsEveryFixture() throws {
        let manifest = try Fixtures.manifest()
        XCTAssertEqual(manifest.version, 1)
        XCTAssertEqual(manifest.fixtures.count, 12)
        XCTAssertEqual(Set(manifest.fixtures.map(\.file)).count, manifest.fixtures.count)

        for entry in manifest.fixtures {
            XCTAssertNoThrow(try Fixtures.data(entry.file), "fixture 缺失：\(entry.file)")
            XCTAssertTrue(
                entry.direction == "client_to_server" || entry.direction == "server_to_client",
                "未知方向：\(entry.file)"
            )
        }

        // manifest 与实际目录内容一致（不能有未登记的 fixture）。
        let files = try FileManager.default.contentsOfDirectory(atPath: Fixtures.directory.path)
            .filter { $0.hasSuffix(".json") && $0 != "manifest.json" }
        XCTAssertEqual(Set(files), Set(manifest.fixtures.map(\.file)))
    }

    func testEveryFixtureDecodesToManifestType() throws {
        for entry in try Fixtures.manifest().fixtures {
            let message = try StageCodec.decode(try Fixtures.data(entry.file))
            XCTAssertEqual(message.type, entry.type, "\(entry.file) 的 type 不匹配")
        }
    }

    func testServerToClientFixturesExposeKeyFields() throws {
        for entry in try Fixtures.manifest().fixtures where entry.direction == "server_to_client" {
            let message = try StageCodec.decode(try Fixtures.data(entry.file))
            switch message {
            case .helloAck(let frame):
                XCTAssertEqual(frame.channel, "stage", entry.file)
                XCTAssertEqual(frame.clientId, "godot-1", entry.file)
                XCTAssertEqual(frame.stage.id, "empty", entry.file)
                XCTAssertEqual(frame.stage.status, .empty, entry.file)
                XCTAssertTrue(frame.registrations.isEmpty, entry.file)
            case .stageRegisterResult(let frame):
                XCTAssertEqual(frame.requestId, "r1", entry.file)
                guard case .registered(let registration) = frame.result else {
                    return XCTFail("\(entry.file) 应为 registered")
                }
                XCTAssertEqual(registration.id, "stage:godot-1:town:meadow", entry.file)
                XCTAssertEqual(registration.stageId, "town:meadow", entry.file)
                XCTAssertEqual(registration.stageKind, "town", entry.file)
                XCTAssertEqual(registration.environment.text, "萤火镇", entry.file)
                XCTAssertEqual(registration.capabilities.first?.name, "say", entry.file)
                XCTAssertEqual(frame.stage.id, "empty", entry.file)
            case .stageActivateResult(let frame):
                XCTAssertEqual(frame.requestId, "a1", entry.file)
                guard case .changed(let stage) = frame.result else {
                    return XCTFail("\(entry.file) 应为 changed")
                }
                XCTAssertEqual(stage.id, "town:meadow", entry.file)
                XCTAssertEqual(stage.kind, "town", entry.file)
                XCTAssertEqual(stage.revision, 1, entry.file)
                XCTAssertEqual(stage.status, .active, entry.file)
                XCTAssertEqual(stage.environment?.text, "萤火镇", entry.file)
                XCTAssertEqual(stage.participants.first?.role, .assistant, entry.file)
                XCTAssertEqual(stage.participants.first?.online, true, entry.file)
                XCTAssertEqual(stage.capabilities.first?.name, "say", entry.file)
            case .command(let frame):
                XCTAssertEqual(frame.commandId, "stage-1750000000000-1", entry.file)
                XCTAssertEqual(frame.bridgeId, "stage:godot-1:town:meadow", entry.file)
                XCTAssertEqual(frame.stageId, "town:meadow", entry.file)
                XCTAssertEqual(frame.command, "say", entry.file)
                XCTAssertEqual(frame.args["text"]?.stringValue, "你好", entry.file)
            case .llmEvent(let frame):
                XCTAssertEqual(frame.event["type"]?.stringValue, "assistant_message", entry.file)
                XCTAssertEqual(frame.event.value(at: ["data", "turn"])?.intValue, 2, entry.file)
                XCTAssertEqual(frame.event.value(at: ["data", "step"])?.intValue, 1, entry.file)
                XCTAssertEqual(
                    frame.event.value(at: ["data", "message", "content"])?.arrayValue?.first?.value(at: ["text"])?.stringValue,
                    "你好，我在。",
                    entry.file
                )
            case .error(let frame):
                XCTAssertEqual(frame.requestId, "r2", entry.file)
                XCTAssertEqual(frame.error, "stage is not registered by this client", entry.file)
            default:
                XCTFail("未预期的服务端帧：\(entry.file) -> \(entry.type)")
            }
        }
    }

    func testClientToServerFixturesRoundTrip() throws {
        for entry in try Fixtures.manifest().fixtures where entry.direction == "client_to_server" {
            let message = try StageCodec.decode(try Fixtures.data(entry.file))
            let encoded = try StageCodec.encode(message)
            let encodedValue = try StageCodec.jsonValue(from: encoded)
            let fixtureValue = try Fixtures.value(entry.file)
            XCTAssertEqual(encodedValue, fixtureValue, "\(entry.file) 重编码后与 fixture 不等价")
        }
    }

    func testConstructedClientFramesMatchFixtures() throws {
        let hello = StageMessage.hello(StageHello(
            clientId: "godot-1",
            role: .assistant,
            assistantId: "assistant-1",
            name: "编码助手"
        ))
        try assertFrame(hello, equalsFixture: "hello.client.json")

        let parameters: JSONValue = [
            "type": "object",
            "properties": ["text": ["type": "string"]],
            "required": ["text"],
        ]
        let registration = StageRegistration(
            id: "town:meadow",
            kind: "town",
            environment: StageEnvironment(text: "萤火镇"),
            commands: [
                CommandSpec(name: "say", description: "在场景中说话", parameters: parameters),
            ]
        )
        let register = StageMessage.stageRegister(StageRegisterRequest(requestId: "r1", stage: registration))
        try assertFrame(register, equalsFixture: "stage-register.client.json")

        let activate = StageMessage.stageActivate(StageActivateRequest(
            requestId: "a1",
            stageId: "town:meadow",
            mode: .afterTurn,
            expectedStageId: "empty",
            expectedRevision: 0
        ))
        try assertFrame(activate, equalsFixture: "stage-activate.client.json")

        let commandResult = StageMessage.commandResult(StageCommandResultFrame(
            commandId: "stage-1750000000000-1",
            ok: true,
            result: ["accepted": true]
        ))
        try assertFrame(commandResult, equalsFixture: "command-result.client.json")

        let event = StageMessage.event(StageEventFrame(
            stageId: "town:meadow",
            event: StageEvent(kind: "user_said", fields: [
                "text": .string("你好"),
                "participantId": .string("user-1"),
            ])
        ))
        try assertFrame(event, equalsFixture: "event.client.json")

        let transition = StageMessage.stageTransition(StageTransitionRequest(
            requestId: "t1",
            stageId: "town:meadow",
            target: .empty,
            mode: .interrupt
        ))
        try assertFrame(transition, equalsFixture: "stage-transition.client.json")
    }

    func testUnknownTypeIsToleratedAndPreserved() throws {
        let text = #"{"type":"future_frame","futureField":{"nested":1},"items":[1,true,null,"x"]}"#
        let message = try StageCodec.decode(text)
        XCTAssertEqual(message.type, "future_frame")
        guard case .unknown(let frame) = message else {
            return XCTFail("未知 type 应落到 .unknown")
        }
        XCTAssertEqual(frame.raw.value(at: ["futureField", "nested"])?.intValue, 1)
        XCTAssertEqual(frame.raw.value(at: ["items"])?.arrayValue?.count, 4)
        XCTAssertEqual(frame.raw.value(at: ["items"])?.arrayValue?[3].stringValue, "x")

        let reencoded = try StageCodec.jsonValue(from: try StageCodec.encode(message))
        XCTAssertEqual(reencoded, try StageCodec.jsonValue(from: text))
    }

    func testUnknownFieldsAreIgnored() throws {
        let fixture = try Fixtures.value("hello-ack.server.json")
        guard var object = fixture.objectValue else {
            return XCTFail("hello_ack fixture 不是对象")
        }
        object["futureField"] = .object(["x": .int(1)])
        object["futureArray"] = .array([.int(1), .int(2)])

        let message = try StageCodec.decode(try StageCodec.canonicalString(.object(object)))
        guard case .helloAck(let frame) = message else {
            return XCTFail("应解码为 hello_ack")
        }
        XCTAssertEqual(frame.clientId, "godot-1")
        XCTAssertEqual(frame.stage.id, "empty")

        // 未知字段被忽略：重新编码时不出现。
        let reencoded = try StageCodec.jsonValue(from: try StageCodec.encode(message))
        XCTAssertNil(reencoded["futureField"])
        XCTAssertNil(reencoded["futureArray"])
    }

    func testJSONValuePreservesIntegerAndFloat() throws {
        let value = try StageCodec.jsonValue(from: #"{"a":0,"b":1.5,"c":[1,2,3],"d":null,"e":true}"#)
        XCTAssertEqual(value["a"], .int(0))
        XCTAssertEqual(value["b"], .double(1.5))
        XCTAssertEqual(value["c"]?.arrayValue?.count, 3)
        XCTAssertEqual(value["d"], .null)
        XCTAssertEqual(value["e"], .bool(true))
        XCTAssertEqual(
            try StageCodec.canonicalString(value),
            #"{"a":0,"b":1.5,"c":[1,2,3],"d":null,"e":true}"#
        )
    }

    func testMalformedFrameThrowsDecodingError() {
        XCTAssertThrowsError(try StageCodec.decode("不是 JSON")) { error in
            guard case .decoding = error as? StageChannelError else {
                return XCTFail("应为 decoding 错误，实际：\(error)")
            }
        }
        XCTAssertThrowsError(try StageCodec.decode(#"{"no_type":true}"#)) { error in
            guard case .decoding = error as? StageChannelError else {
                return XCTFail("缺少 type 应为 decoding 错误，实际：\(error)")
            }
        }
    }

    // MARK: - Helpers

    private func assertFrame(
        _ message: StageMessage,
        equalsFixture name: String,
        file: StaticString = #filePath,
        line: UInt = #line
    ) throws {
        let fixtureValue = try Fixtures.value(name)
        let encodedValue = try StageCodec.jsonValue(from: try StageCodec.encode(message))
        XCTAssertEqual(encodedValue, fixtureValue, "\(name) 构造帧与 fixture 不等价", file: file, line: line)
    }
}
