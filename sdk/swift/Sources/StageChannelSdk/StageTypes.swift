import Foundation

// MARK: - 协议常量

/// 与 `../spec/protocol.md` 对齐的协议常量。
public enum StageChannelProtocol {
    /// 通道名；`hello.channel` / `hello_ack.channel` 必须是该值。
    public static let channelName = "stage"
    /// 直连模式的默认 WebSocket 路径。
    public static let defaultPath = "/ws"
    /// Console 发现接口路径。
    public static let assistantsPath = "/api/assistants"
    /// 服务端因重复 clientId 替换旧连接时使用的关闭码。
    public static let replacedCloseCode = 4001
    /// 默认握手超时（秒）。
    public static let handshakeTimeout: TimeInterval = 30
    /// 默认单个请求超时（秒）。
    public static let requestTimeout: TimeInterval = 30
}

// MARK: - 连接状态

/// 客户端的连接状态机。
///
/// ```text
/// disconnected → connecting → helloSent → acknowledged → registered → active
/// ```
public enum StageConnectionState: String, Sendable, Equatable, CaseIterable, CustomStringConvertible {
    case disconnected
    case connecting
    case helloSent
    case acknowledged
    case registered
    case active

    public var description: String { rawValue }

    /// 是否已经完成 hello/register 握手（可以收发帧）。
    public var isConnected: Bool {
        switch self {
        case .acknowledged, .registered, .active: return true
        case .disconnected, .connecting, .helloSent: return false
        }
    }

    /// 是否处于握手过程中。
    public var isHandshaking: Bool {
        switch self {
        case .connecting, .helloSent: return true
        case .disconnected, .acknowledged, .registered, .active: return false
        }
    }
}

// MARK: - 角色 / 状态

/// Stage 参与者角色。服务端把未知角色归为 `client`，这里保留原值以免丢信息。
public enum StageRole: Sendable, Equatable, Hashable {
    case assistant
    case user
    case client
    case other(String)

    public init(rawValue: String) {
        switch rawValue {
        case "assistant": self = .assistant
        case "user": self = .user
        case "client": self = .client
        default: self = .other(rawValue)
        }
    }

    public var rawValue: String {
        switch self {
        case .assistant: return "assistant"
        case .user: return "user"
        case .client: return "client"
        case .other(let value): return value
        }
    }
}

extension StageRole: Codable {
    public init(from decoder: Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        self.init(rawValue: raw)
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        try container.encode(rawValue)
    }
}

/// Stage 快照状态。
public enum StageStatus: Sendable, Equatable, Hashable {
    case empty
    case active
    case suspended
    case other(String)

    public init(rawValue: String) {
        switch rawValue {
        case "empty": self = .empty
        case "active": self = .active
        case "suspended": self = .suspended
        default: self = .other(rawValue)
        }
    }

    public var rawValue: String {
        switch self {
        case .empty: return "empty"
        case .active: return "active"
        case .suspended: return "suspended"
        case .other(let value): return value
        }
    }
}

extension StageStatus: Codable {
    public init(from decoder: Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        self.init(rawValue: raw)
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        try container.encode(rawValue)
    }
}

/// `stage_activate` / `stage_transition` 的切换模式。
public enum StageTransitionMode: String, Codable, Sendable, Equatable {
    /// 等当前回合结束再切换（服务端默认）。
    case afterTurn = "after-turn"
    /// 立即打断当前回合。
    case interrupt
}

/// `stage_transition` 的目标；目前协议只定义回到默认空环境。
public enum StageTransitionTarget: String, Codable, Sendable, Equatable {
    case empty
}

// MARK: - 共享类型（protocol.md §3.3）

/// `environment` 文本描述。
public struct StageEnvironment: Codable, Sendable, Equatable {
    public var text: String

    public init(text: String) {
        self.text = text
    }
}

/// Stage 能力（对应协议中的 `CommandSpec`）。
public struct CommandSpec: Codable, Sendable, Equatable {
    public var name: String
    public var description: String?
    /// JSON Schema 风格的参数声明；原样透传。
    public var parameters: JSONValue?
    public var returns: String?
    public var example: JSONValue?

    public init(
        name: String,
        description: String? = nil,
        parameters: JSONValue? = nil,
        returns: String? = nil,
        example: JSONValue? = nil
    ) {
        self.name = name
        self.description = description
        self.parameters = parameters
        self.returns = returns
        self.example = example
    }
}

/// Stage 中的一个参与者。
public struct StageParticipant: Codable, Sendable, Equatable {
    public var id: String
    public var role: StageRole
    public var name: String?
    public var online: Bool

    public init(id: String, role: StageRole, name: String? = nil, online: Bool = true) {
        self.id = id
        self.role = role
        self.name = name
        self.online = online
    }
}

/// 服务端当前 Stage 快照。
public struct StageSnapshot: Codable, Sendable, Equatable {
    public var id: String
    public var kind: String
    public var revision: Int
    public var status: StageStatus
    public var participants: [StageParticipant]
    public var capabilities: [CommandSpec]
    public var environment: StageEnvironment?

    public init(
        id: String,
        kind: String = "empty",
        revision: Int = 0,
        status: StageStatus = .empty,
        participants: [StageParticipant] = [],
        capabilities: [CommandSpec] = [],
        environment: StageEnvironment? = nil
    ) {
        self.id = id
        self.kind = kind
        self.revision = revision
        self.status = status
        self.participants = participants
        self.capabilities = capabilities
        self.environment = environment
    }

    /// 是否处于激活态。
    public var isActive: Bool { status == .active }

    /// 是否为默认空环境。
    public var isEmptyStage: Bool { id == "empty" || status == .empty }
}

/// 服务端登记的 Stage（`hello_ack.registrations` / `stage_register_result.result.registration`）。
public struct Registration: Codable, Sendable, Equatable {
    public var id: String
    public var stageId: String
    public var stageKind: String
    public var environment: StageEnvironment
    public var capabilities: [CommandSpec]

    public init(
        id: String,
        stageId: String,
        stageKind: String,
        environment: StageEnvironment,
        capabilities: [CommandSpec] = []
    ) {
        self.id = id
        self.stageId = stageId
        self.stageKind = stageKind
        self.environment = environment
        self.capabilities = capabilities
    }
}

/// 客户端声明 Stage 时发送的内容（`stage_register.stage`）。
public struct StageRegistration: Codable, Sendable, Equatable {
    public var id: String
    public var kind: String
    public var environment: StageEnvironment?
    public var commands: [CommandSpec]

    public init(
        id: String,
        kind: String = "external",
        environment: StageEnvironment? = nil,
        commands: [CommandSpec] = []
    ) {
        self.id = id
        self.kind = kind
        self.environment = environment
        self.commands = commands
    }

    /// 常用调试/开发 Stage。
    public static func development(
        id: String = "swift:default",
        kind: String = "swift",
        text: String = "Swift 客户端调试环境",
        commands: [CommandSpec] = []
    ) -> StageRegistration {
        StageRegistration(id: id, kind: kind, environment: StageEnvironment(text: text), commands: commands)
    }
}

// MARK: - 结果类型

/// `stage_register_result.result`。
public enum StageRegisterResult: Sendable, Equatable {
    case registered(Registration)
    case updated(Registration)
    case unchanged(Registration)
    case rejected(reason: String)
    /// 向前兼容：未来新增的 `kind`。
    case other(kind: String, raw: JSONValue)

    /// 成功登记后的 Registration（rejected / other 为 nil）。
    public var registration: Registration? {
        switch self {
        case .registered(let value), .updated(let value), .unchanged(let value): return value
        case .rejected, .other: return nil
        }
    }

    public var kind: String {
        switch self {
        case .registered: return "registered"
        case .updated: return "updated"
        case .unchanged: return "unchanged"
        case .rejected: return "rejected"
        case .other(let kind, _): return kind
        }
    }

    public var isSuccess: Bool { registration != nil }

    public var rejectionReason: String? {
        if case .rejected(let reason) = self { return reason }
        return nil
    }
}

extension StageRegisterResult: Codable {
    public init(from decoder: Decoder) throws {
        let raw = try JSONValue(from: decoder)
        guard let kind = raw["kind"]?.stringValue else {
            throw StageChannelError.decoding("stage_register_result.result 缺少 kind")
        }
        switch kind {
        case "registered", "updated", "unchanged":
            guard let registrationValue = raw["registration"] else {
                throw StageChannelError.decoding("stage_register_result.result(kind=\(kind)) 缺少 registration")
            }
            let registration = try registrationValue.decoded(Registration.self)
            switch kind {
            case "registered": self = .registered(registration)
            case "updated": self = .updated(registration)
            default: self = .unchanged(registration)
            }
        case "rejected":
            self = .rejected(reason: raw["reason"]?.stringValue ?? "")
        default:
            self = .other(kind: kind, raw: raw)
        }
    }

    public func encode(to encoder: Encoder) throws {
        let raw: JSONValue
        switch self {
        case .registered(let registration):
            raw = .object(["kind": .string("registered"), "registration": try JSONValue(encoding: registration)])
        case .updated(let registration):
            raw = .object(["kind": .string("updated"), "registration": try JSONValue(encoding: registration)])
        case .unchanged(let registration):
            raw = .object(["kind": .string("unchanged"), "registration": try JSONValue(encoding: registration)])
        case .rejected(let reason):
            raw = .object(["kind": .string("rejected"), "reason": .string(reason)])
        case .other(_, let value):
            raw = value
        }
        try raw.encode(to: encoder)
    }
}

/// `stage_activate_result.result` / `stage_transition_result.result`。
public enum StageTransitionResult: Sendable, Equatable {
    case changed(StageSnapshot)
    case unchanged(StageSnapshot)
    case rejected(reason: String, stage: StageSnapshot?)
    /// 向前兼容：未来新增的 `kind`。
    case other(kind: String, raw: JSONValue)

    public var kind: String {
        switch self {
        case .changed: return "changed"
        case .unchanged: return "unchanged"
        case .rejected: return "rejected"
        case .other(let kind, _): return kind
        }
    }

    public var stage: StageSnapshot? {
        switch self {
        case .changed(let stage), .unchanged(let stage): return stage
        case .rejected(_, let stage): return stage
        case .other: return nil
        }
    }

    public var isSuccess: Bool {
        switch self {
        case .changed, .unchanged: return true
        case .rejected, .other: return false
        }
    }

    public var rejectionReason: String? {
        if case .rejected(let reason, _) = self { return reason }
        return nil
    }
}

extension StageTransitionResult: Codable {
    public init(from decoder: Decoder) throws {
        let raw = try JSONValue(from: decoder)
        guard let kind = raw["kind"]?.stringValue else {
            throw StageChannelError.decoding("transition result 缺少 kind")
        }
        switch kind {
        case "changed", "unchanged":
            guard let stageValue = raw["stage"] else {
                throw StageChannelError.decoding("transition result(kind=\(kind)) 缺少 stage")
            }
            let stage = try stageValue.decoded(StageSnapshot.self)
            self = kind == "changed" ? .changed(stage) : .unchanged(stage)
        case "rejected":
            let stage = try raw["stage"]?.decoded(StageSnapshot.self)
            self = .rejected(reason: raw["reason"]?.stringValue ?? "", stage: stage)
        default:
            self = .other(kind: kind, raw: raw)
        }
    }

    public func encode(to encoder: Encoder) throws {
        let raw: JSONValue
        switch self {
        case .changed(let stage):
            raw = .object(["kind": .string("changed"), "stage": try JSONValue(encoding: stage)])
        case .unchanged(let stage):
            raw = .object(["kind": .string("unchanged"), "stage": try JSONValue(encoding: stage)])
        case .rejected(let reason, let stage):
            var object: [String: JSONValue] = ["kind": .string("rejected"), "reason": .string(reason)]
            if let stage { object["stage"] = try JSONValue(encoding: stage) }
            raw = .object(object)
        case .other(_, let value):
            raw = value
        }
        try raw.encode(to: encoder)
    }
}

// MARK: - 运行时类型

/// 一条服务端下发的 Stage 命令。
public struct StageCommand: Sendable, Equatable, Codable {
    public var commandId: String
    public var bridgeId: String?
    public var stageId: String
    public var command: String
    public var args: JSONValue

    public init(
        commandId: String,
        bridgeId: String? = nil,
        stageId: String,
        command: String,
        args: JSONValue = .object([:])
    ) {
        self.commandId = commandId
        self.bridgeId = bridgeId
        self.stageId = stageId
        self.command = command
        self.args = args
    }

    public static func == (lhs: StageCommand, rhs: StageCommand) -> Bool {
        lhs.commandId == rhs.commandId
            && lhs.bridgeId == rhs.bridgeId
            && lhs.stageId == rhs.stageId
            && lhs.command == rhs.command
            && lhs.args == rhs.args
    }
}

/// 客户端上行的一条 Stage 事件：`kind` + 任意字段。
public struct StageEvent: Sendable, Equatable {
    public var kind: String
    public var fields: [String: JSONValue]

    public init(kind: String, fields: [String: JSONValue] = [:]) {
        self.kind = kind
        self.fields = fields
    }

    /// 合并后的 JSON 对象（包含 `kind`）。
    public var jsonObject: [String: JSONValue] {
        var object = fields
        object["kind"] = .string(kind)
        return object
    }
}

extension StageEvent: Codable {
    public init(from decoder: Decoder) throws {
        let raw = try JSONValue(from: decoder)
        guard let object = raw.objectValue else {
            throw StageChannelError.decoding("event 必须是 JSON 对象")
        }
        guard let kind = object["kind"]?.stringValue, !kind.isEmpty else {
            throw StageChannelError.decoding("event.kind 缺失")
        }
        var fields = object
        fields.removeValue(forKey: "kind")
        self.init(kind: kind, fields: fields)
    }

    public func encode(to encoder: Encoder) throws {
        try JSONValue.object(jsonObject).encode(to: encoder)
    }
}

/// `connected` 回调携带的握手结果。
public struct StageConnectionInfo: Sendable, Equatable {
    public var clientId: String
    public var bridgeId: String?
    public var state: StageConnectionState
    public var snapshot: StageSnapshot?
    public var registrations: [Registration]

    public init(
        clientId: String,
        bridgeId: String? = nil,
        state: StageConnectionState,
        snapshot: StageSnapshot? = nil,
        registrations: [Registration] = []
    ) {
        self.clientId = clientId
        self.bridgeId = bridgeId
        self.state = state
        self.snapshot = snapshot
        self.registrations = registrations
    }
}

/// 客户端回调事件。
///
/// 回调以 `@Sendable` 闭包形式在 SDK 的后台执行器上触发；闭包里不要长时间阻塞，
/// 需要切线程时自行派发到主线程。
public enum StageClientEvent: Sendable, Equatable {
    /// 握手完成（assistant 为 register + activate 后；role=user 为 register 后；
    /// 未配置 `registration` 时在 hello_ack 后）。
    case connected(StageConnectionInfo)
    /// 连接关闭；`code` 为 WebSocket 关闭码（重复 clientId 时 4001）。
    case disconnected(reason: String, code: Int?)
    /// 收到本客户端 Stage 的命令。
    case command(StageCommand)
    /// 收到服务端 llm_event（原始事件对象）。
    case llmEvent(JSONValue)
    /// `stage_register_result`。
    case registerResult(StageRegisterResult)
    /// `stage_activate_result` / `stage_transition_result`。
    case activateResult(StageTransitionResult)
    /// 协议或服务端错误。
    case error(StageChannelError)
}
