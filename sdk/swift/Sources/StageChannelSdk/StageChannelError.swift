import Foundation

/// StageChannel 客户端错误。
///
/// `disconnected` 回调与抛出的错误都使用该类型；网关替换连接时
/// `closeCode == StageChannelProtocol.replacedCloseCode`（4001）。
public enum StageChannelError: Error, Sendable, Equatable, LocalizedError {
    /// 本地状态不允许该操作（例如未 connect 就 registerStage）。
    case invalidState(operation: String, expected: String, actual: StageConnectionState)
    /// URL / 路径 / 端口不合法。
    case invalidURL(String)
    /// 传输层错误（DNS、TLS、socket 关闭前未知原因等）。
    case transport(String)
    /// 发现接口返回非 2xx。
    case httpStatus(code: Int, body: String?)
    /// JSON 解码失败。
    case decoding(String)
    /// JSON 编码失败。
    case encoding(String)
    /// 握手（hello → hello_ack → register → activate）在 30 秒内未完成。
    case handshakeTimeout(phase: StageConnectionState)
    /// 单个请求在 `requestTimeout` 内没有收到 `*_result`。
    case requestTimeout(operation: String)
    /// 服务端下发 `error` 帧。
    case serverError(requestId: String?, message: String)
    /// 服务端下发 `event_rejected` 帧。
    case eventRejected(reason: String)
    /// 握手阶段的 `stage_register` 被服务端拒绝。
    case registrationRejected(reason: String)
    /// 握手阶段的 `stage_activate` 被服务端拒绝。
    case activationRejected(reason: String)
    /// 连接已关闭；`code` 为 WebSocket 关闭码（服务端替换 clientId 时为 4001）。
    case connectionClosed(code: Int?, reason: String?)
    /// 收到不符合协议的帧。
    case protocolViolation(String)
    /// 尚未建立连接。
    case notConnected

    public var errorDescription: String? {
        switch self {
        case .invalidState(let operation, let expected, let actual):
            return "\(operation) 状态不合法：期望 \(expected)，当前 \(actual.rawValue)"
        case .invalidURL(let detail):
            return "地址不合法：\(detail)"
        case .transport(let detail):
            return "传输层错误：\(detail)"
        case .httpStatus(let code, let body):
            if let body, !body.isEmpty {
                return "HTTP \(code)：\(body)"
            }
            return "HTTP \(code)"
        case .decoding(let detail):
            return "协议解码失败：\(detail)"
        case .encoding(let detail):
            return "协议编码失败：\(detail)"
        case .handshakeTimeout(let phase):
            return "握手超时（阶段 \(phase.rawValue)）"
        case .requestTimeout(let operation):
            return "\(operation) 请求超时"
        case .serverError(_, let message):
            return "服务端错误：\(message)"
        case .eventRejected(let reason):
            return "事件被服务端拒绝：\(reason)"
        case .registrationRejected(let reason):
            return "Stage 注册被拒绝：\(reason)"
        case .activationRejected(let reason):
            return "Stage 激活被拒绝：\(reason)"
        case .connectionClosed(let code, let reason):
            var detail = "连接已关闭"
            if let code { detail += " (code=\(code)" }
            if let reason, !reason.isEmpty { detail += code == nil ? " (\(reason)" : ", reason=\(reason)" }
            if code != nil || (reason?.isEmpty == false) { detail += ")" }
            return detail
        case .protocolViolation(let detail):
            return "协议错误：\(detail)"
        case .notConnected:
            return "尚未连接"
        }
    }

    /// WebSocket 关闭码（仅 `connectionClosed` 携带）。
    public var closeCode: Int? {
        if case .connectionClosed(let code, _) = self { return code }
        return nil
    }

    /// 服务端是否因为重复 `clientId` 替换了本连接（关闭码 4001）。
    public var isClientReplaced: Bool {
        closeCode == StageChannelProtocol.replacedCloseCode
    }
}
