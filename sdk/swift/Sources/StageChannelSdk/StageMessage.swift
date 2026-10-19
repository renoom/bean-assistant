import Foundation

// MARK: - 客户端 → 服务端帧

/// `hello`：握手第一帧。
public struct StageHello: Codable, Sendable, Equatable {
    public var type: String
    public var channel: String
    /// 实例唯一、跨重连保持不变。
    public var clientId: String
    public var role: StageRole?
    public var assistantId: String?
    public var name: String?
    public var clientType: String?
    // 旧版兼容字段：服务端仍接受在 hello 里携带 Stage 声明。
    public var stageId: String?
    public var stageKind: String?
    public var environment: StageEnvironment?
    public var commands: [CommandSpec]?
    public var activateStage: Bool?

    public init(
        type: String = "hello",
        channel: String = StageChannelProtocol.channelName,
        clientId: String,
        role: StageRole? = nil,
        assistantId: String? = nil,
        name: String? = nil,
        clientType: String? = nil,
        stageId: String? = nil,
        stageKind: String? = nil,
        environment: StageEnvironment? = nil,
        commands: [CommandSpec]? = nil,
        activateStage: Bool? = nil
    ) {
        self.type = type
        self.channel = channel
        self.clientId = clientId
        self.role = role
        self.assistantId = assistantId
        self.name = name
        self.clientType = clientType
        self.stageId = stageId
        self.stageKind = stageKind
        self.environment = environment
        self.commands = commands
        self.activateStage = activateStage
    }
}

/// `stage_register`。
public struct StageRegisterRequest: Codable, Sendable, Equatable {
    public var type: String
    public var requestId: String?
    public var stage: StageRegistration

    public init(type: String = "stage_register", requestId: String? = nil, stage: StageRegistration) {
        self.type = type
        self.requestId = requestId
        self.stage = stage
    }
}

/// `stage_unregister`。
public struct StageUnregisterRequest: Codable, Sendable, Equatable {
    public var type: String
    public var requestId: String?
    public var stageId: String

    public init(type: String = "stage_unregister", requestId: String? = nil, stageId: String) {
        self.type = type
        self.requestId = requestId
        self.stageId = stageId
    }
}

/// `stage_activate`。
public struct StageActivateRequest: Codable, Sendable, Equatable {
    public var type: String
    public var requestId: String?
    public var stageId: String
    public var mode: StageTransitionMode?
    public var expectedStageId: String?
    public var expectedRevision: Int?

    public init(
        type: String = "stage_activate",
        requestId: String? = nil,
        stageId: String,
        mode: StageTransitionMode? = nil,
        expectedStageId: String? = nil,
        expectedRevision: Int? = nil
    ) {
        self.type = type
        self.requestId = requestId
        self.stageId = stageId
        self.mode = mode
        self.expectedStageId = expectedStageId
        self.expectedRevision = expectedRevision
    }
}

/// `stage_transition`（回到默认环境）。
public struct StageTransitionRequest: Codable, Sendable, Equatable {
    public var type: String
    public var requestId: String?
    public var stageId: String
    public var target: StageTransitionTarget?
    public var mode: StageTransitionMode?
    public var expectedStageId: String?
    public var expectedRevision: Int?

    public init(
        type: String = "stage_transition",
        requestId: String? = nil,
        stageId: String,
        target: StageTransitionTarget? = .empty,
        mode: StageTransitionMode? = nil,
        expectedStageId: String? = nil,
        expectedRevision: Int? = nil
    ) {
        self.type = type
        self.requestId = requestId
        self.stageId = stageId
        self.target = target
        self.mode = mode
        self.expectedStageId = expectedStageId
        self.expectedRevision = expectedRevision
    }
}

/// `event`：上行一条 Stage 事件。
public struct StageEventFrame: Codable, Sendable, Equatable {
    public var type: String
    public var stageId: String?
    public var event: StageEvent

    public init(type: String = "event", stageId: String? = nil, event: StageEvent) {
        self.type = type
        self.stageId = stageId
        self.event = event
    }
}

/// `command_result`：命令回执。
public struct StageCommandResultFrame: Codable, Sendable, Equatable {
    public var type: String
    public var commandId: String
    public var ok: Bool
    public var result: JSONValue
    public var error: String?

    public init(
        type: String = "command_result",
        commandId: String,
        ok: Bool,
        result: JSONValue = .null,
        error: String? = nil
    ) {
        self.type = type
        self.commandId = commandId
        self.ok = ok
        self.result = result
        self.error = error
    }
}

// MARK: - 服务端 → 客户端帧

/// `hello_ack`。
public struct StageHelloAckFrame: Codable, Sendable, Equatable {
    public var type: String
    public var channel: String
    public var clientId: String
    public var bridgeId: String?
    public var registrations: [Registration]
    public var stage: StageSnapshot
    public var transition: StageTransitionResult?

    public init(
        type: String = "hello_ack",
        channel: String = StageChannelProtocol.channelName,
        clientId: String,
        bridgeId: String? = nil,
        registrations: [Registration] = [],
        stage: StageSnapshot,
        transition: StageTransitionResult? = nil
    ) {
        self.type = type
        self.channel = channel
        self.clientId = clientId
        self.bridgeId = bridgeId
        self.registrations = registrations
        self.stage = stage
        self.transition = transition
    }
}

/// `stage_register_result`。
public struct StageRegisterResultFrame: Codable, Sendable, Equatable {
    public var type: String
    public var requestId: String?
    public var result: StageRegisterResult
    public var stage: StageSnapshot

    public init(
        type: String = "stage_register_result",
        requestId: String? = nil,
        result: StageRegisterResult,
        stage: StageSnapshot
    ) {
        self.type = type
        self.requestId = requestId
        self.result = result
        self.stage = stage
    }
}

/// `stage_unregister_result`。
public struct StageUnregisterResultFrame: Codable, Sendable, Equatable {
    public var type: String
    public var requestId: String?
    public var removed: Bool
    public var stage: StageSnapshot

    public init(
        type: String = "stage_unregister_result",
        requestId: String? = nil,
        removed: Bool,
        stage: StageSnapshot
    ) {
        self.type = type
        self.requestId = requestId
        self.removed = removed
        self.stage = stage
    }
}

/// `stage_activate_result`。
public struct StageActivateResultFrame: Codable, Sendable, Equatable {
    public var type: String
    public var requestId: String?
    public var result: StageTransitionResult

    public init(
        type: String = "stage_activate_result",
        requestId: String? = nil,
        result: StageTransitionResult
    ) {
        self.type = type
        self.requestId = requestId
        self.result = result
    }
}

/// `stage_transition_result`。
public struct StageTransitionResultFrame: Codable, Sendable, Equatable {
    public var type: String
    public var requestId: String?
    public var result: StageTransitionResult

    public init(
        type: String = "stage_transition_result",
        requestId: String? = nil,
        result: StageTransitionResult
    ) {
        self.type = type
        self.requestId = requestId
        self.result = result
    }
}

/// `command`：服务端要求客户端执行 Stage 能力。
public struct StageCommandFrame: Codable, Sendable, Equatable {
    public var type: String
    public var commandId: String
    public var bridgeId: String?
    public var stageId: String
    public var command: String
    public var args: JSONValue

    public init(
        type: String = "command",
        commandId: String,
        bridgeId: String? = nil,
        stageId: String,
        command: String,
        args: JSONValue = .object([:])
    ) {
        self.type = type
        self.commandId = commandId
        self.bridgeId = bridgeId
        self.stageId = stageId
        self.command = command
        self.args = args
    }

    public var stageCommand: StageCommand {
        StageCommand(commandId: commandId, bridgeId: bridgeId, stageId: stageId, command: command, args: args)
    }
}

/// `llm_event`：模型/Session 事件（结构开放，原样透传）。
public struct StageLlmEventFrame: Codable, Sendable, Equatable {
    public var type: String
    public var event: JSONValue

    public init(type: String = "llm_event", event: JSONValue) {
        self.type = type
        self.event = event
    }
}

/// `event_rejected`。
public struct StageEventRejectedFrame: Codable, Sendable, Equatable {
    public var type: String
    public var reason: String

    public init(type: String = "event_rejected", reason: String) {
        self.type = type
        self.reason = reason
    }
}

/// `error`。
public struct StageErrorFrame: Codable, Sendable, Equatable {
    public var type: String
    public var requestId: String?
    public var error: String

    public init(type: String = "error", requestId: String? = nil, error: String) {
        self.type = type
        self.requestId = requestId
        self.error = error
    }
}

/// 未知类型的帧：保留原始 JSON，保证向前兼容（只用于解码观察，客户端会忽略）。
public struct StageUnknownFrame: Sendable, Equatable {
    public var type: String
    public var raw: JSONValue

    public init(type: String, raw: JSONValue) {
        self.type = type
        self.raw = raw
    }
}

extension StageUnknownFrame: Codable {
    public init(from decoder: Decoder) throws {
        let raw = try JSONValue(from: decoder)
        guard let type = raw["type"]?.stringValue, !type.isEmpty else {
            throw StageChannelError.decoding("帧缺少 type 字段")
        }
        self.init(type: type, raw: raw)
    }

    public func encode(to encoder: Encoder) throws {
        try raw.encode(to: encoder)
    }
}

// MARK: - 统一帧枚举

/// 协议帧。`type` 之外的所有未知字段都会被忽略；未知 `type` 解码为 `.unknown`。
public enum StageMessage: Sendable, Equatable {
    case hello(StageHello)
    case helloAck(StageHelloAckFrame)
    case stageRegister(StageRegisterRequest)
    case stageRegisterResult(StageRegisterResultFrame)
    case stageUnregister(StageUnregisterRequest)
    case stageUnregisterResult(StageUnregisterResultFrame)
    case stageActivate(StageActivateRequest)
    case stageTransition(StageTransitionRequest)
    case stageActivateResult(StageActivateResultFrame)
    case stageTransitionResult(StageTransitionResultFrame)
    case command(StageCommandFrame)
    case commandResult(StageCommandResultFrame)
    case event(StageEventFrame)
    case eventRejected(StageEventRejectedFrame)
    case llmEvent(StageLlmEventFrame)
    case error(StageErrorFrame)
    case unknown(StageUnknownFrame)

    /// 帧的 `type` 字符串。
    public var type: String {
        switch self {
        case .hello(let frame): return frame.type
        case .helloAck(let frame): return frame.type
        case .stageRegister(let frame): return frame.type
        case .stageRegisterResult(let frame): return frame.type
        case .stageUnregister(let frame): return frame.type
        case .stageUnregisterResult(let frame): return frame.type
        case .stageActivate(let frame): return frame.type
        case .stageTransition(let frame): return frame.type
        case .stageActivateResult(let frame): return frame.type
        case .stageTransitionResult(let frame): return frame.type
        case .command(let frame): return frame.type
        case .commandResult(let frame): return frame.type
        case .event(let frame): return frame.type
        case .eventRejected(let frame): return frame.type
        case .llmEvent(let frame): return frame.type
        case .error(let frame): return frame.type
        case .unknown(let frame): return frame.type
        }
    }

    /// 按 `type` 构造具体帧；未知 `type` 得到 `.unknown`。
    public static func make(type: String, raw: JSONValue) throws -> StageMessage {
        switch type {
        case "hello": return .hello(try raw.decoded(StageHello.self))
        case "hello_ack": return .helloAck(try raw.decoded(StageHelloAckFrame.self))
        case "stage_register": return .stageRegister(try raw.decoded(StageRegisterRequest.self))
        case "stage_register_result": return .stageRegisterResult(try raw.decoded(StageRegisterResultFrame.self))
        case "stage_unregister": return .stageUnregister(try raw.decoded(StageUnregisterRequest.self))
        case "stage_unregister_result": return .stageUnregisterResult(try raw.decoded(StageUnregisterResultFrame.self))
        case "stage_activate": return .stageActivate(try raw.decoded(StageActivateRequest.self))
        case "stage_transition": return .stageTransition(try raw.decoded(StageTransitionRequest.self))
        case "stage_activate_result": return .stageActivateResult(try raw.decoded(StageActivateResultFrame.self))
        case "stage_transition_result": return .stageTransitionResult(try raw.decoded(StageTransitionResultFrame.self))
        case "command": return .command(try raw.decoded(StageCommandFrame.self))
        case "command_result": return .commandResult(try raw.decoded(StageCommandResultFrame.self))
        case "event": return .event(try raw.decoded(StageEventFrame.self))
        case "event_rejected": return .eventRejected(try raw.decoded(StageEventRejectedFrame.self))
        case "llm_event": return .llmEvent(try raw.decoded(StageLlmEventFrame.self))
        case "error": return .error(try raw.decoded(StageErrorFrame.self))
        default: return .unknown(StageUnknownFrame(type: type, raw: raw))
        }
    }
}

extension StageMessage: Codable {
    public init(from decoder: Decoder) throws {
        let raw = try JSONValue(from: decoder)
        guard let type = raw["type"]?.stringValue else {
            throw StageChannelError.decoding("帧缺少 type 字段")
        }
        self = try StageMessage.make(type: type, raw: raw)
    }

    public func encode(to encoder: Encoder) throws {
        switch self {
        case .hello(let frame): try frame.encode(to: encoder)
        case .helloAck(let frame): try frame.encode(to: encoder)
        case .stageRegister(let frame): try frame.encode(to: encoder)
        case .stageRegisterResult(let frame): try frame.encode(to: encoder)
        case .stageUnregister(let frame): try frame.encode(to: encoder)
        case .stageUnregisterResult(let frame): try frame.encode(to: encoder)
        case .stageActivate(let frame): try frame.encode(to: encoder)
        case .stageTransition(let frame): try frame.encode(to: encoder)
        case .stageActivateResult(let frame): try frame.encode(to: encoder)
        case .stageTransitionResult(let frame): try frame.encode(to: encoder)
        case .command(let frame): try frame.encode(to: encoder)
        case .commandResult(let frame): try frame.encode(to: encoder)
        case .event(let frame): try frame.encode(to: encoder)
        case .eventRejected(let frame): try frame.encode(to: encoder)
        case .llmEvent(let frame): try frame.encode(to: encoder)
        case .error(let frame): try frame.encode(to: encoder)
        case .unknown(let frame): try frame.encode(to: encoder)
        }
    }
}
