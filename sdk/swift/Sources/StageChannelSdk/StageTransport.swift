import Foundation

// MARK: - 传输层输入

/// 传输层收到的入站内容。
public enum StageSocketInbound: Sendable, Equatable {
    /// 文本帧（协议帧）。
    case text(String)
    /// 二进制帧；协议要求文本帧，SDK 会尝试按 UTF-8 解析以容忍宽松实现。
    case binary(Data)
    /// 连接已关闭（携带关闭码 / 原因）。
    case closed(code: Int?, reason: String?)
}

// MARK: - 传输层抽象

/// WebSocket 传输层抽象。
///
/// 默认实现是 `URLSessionStageTransport`（`URLSessionWebSocketTask`）；
/// 测试可注入 mock（见 `Tests/StageChannelSdkTests/MockStageTransport.swift`）。
public protocol StageSocketTransport: Sendable {
    /// 建立连接。`headers` 为握手附加 HTTP 头（Bearer / X-API-Key）。
    func open(url: URL, headers: [String: String]) async throws
    /// 发送一条文本帧。
    func send(text: String) async throws
    /// 接收下一条入站内容（挂起直到有数据 / 关闭 / 出错）。
    func receive() async throws -> StageSocketInbound
    /// 关闭连接。
    func close(code: Int, reason: String) async
}

/// 传输层工厂，便于测试注入 mock。
public typealias StageTransportFactory = @Sendable (_ url: URL, _ headers: [String: String]) -> any StageSocketTransport

// MARK: - URLSessionWebSocketTask 实现

/// 基于 `URLSessionWebSocketTask` 的默认传输实现。
///
/// 服务端主动关闭时（例如重复 clientId 的 4001），`receive()` 抛出的错误会先读取
/// `closeCode` / `closeReason`，保证关闭码能透出到 `disconnected` 回调。
public final class URLSessionStageTransport: StageSocketTransport, @unchecked Sendable {
    private let session: URLSession
    private let lock = NSLock()
    private var task: URLSessionWebSocketTask?

    public init(sessionConfiguration: URLSessionConfiguration = .default) {
        self.session = URLSession(configuration: sessionConfiguration)
    }

    public func open(url: URL, headers: [String: String]) async throws {
        var request = URLRequest(url: url)
        for (name, value) in headers {
            request.setValue(value, forHTTPHeaderField: name)
        }
        let task = session.webSocketTask(with: request)
        setTask(task)
        task.resume()
    }

    public func send(text: String) async throws {
        guard let task = currentTask() else {
            throw StageChannelError.notConnected
        }
        do {
            try await task.send(.string(text))
        } catch {
            throw map(error, task: task)
        }
    }

    public func receive() async throws -> StageSocketInbound {
        guard let task = currentTask() else {
            throw StageChannelError.notConnected
        }
        do {
            let message = try await task.receive()
            switch message {
            case .string(let text):
                return .text(text)
            case .data(let data):
                return .binary(data)
            @unknown default:
                throw StageChannelError.transport("不支持的 WebSocket 消息类型")
            }
        } catch let error as StageChannelError {
            throw error
        } catch {
            throw map(error, task: task)
        }
    }

    public func close(code: Int, reason: String) async {
        let task = currentTask()
        setTask(nil)
        let closeCode = URLSessionWebSocketTask.CloseCode(rawValue: code) ?? .normalClosure
        task?.cancel(with: closeCode, reason: Data(reason.utf8))
        session.invalidateAndCancel()
    }

    private func currentTask() -> URLSessionWebSocketTask? {
        lock.lock()
        defer { lock.unlock() }
        return task
    }

    private func setTask(_ newTask: URLSessionWebSocketTask?) {
        lock.lock()
        task = newTask
        lock.unlock()
    }

    private func map(_ error: Error, task: URLSessionWebSocketTask) -> StageChannelError {
        let code = task.closeCode
        if code != .invalid {
            let reason = task.closeReason.map { String(decoding: $0, as: UTF8.self) }
            return .connectionClosed(code: code.rawValue, reason: reason)
        }
        return .transport(error.localizedDescription)
    }
}
