import Foundation

/// StageChannel 帧编解码。
///
/// - 文本帧内容为 UTF-8 JSON（`protocol.md` §5）。
/// - 解码时未知字段自动忽略；未知 `type` 落到 `StageMessage.unknown`。
public enum StageCodec {
    /// 编码一帧为 JSON Data。
    public static func encode(_ message: StageMessage) throws -> Data {
        do {
            return try StageJSON.encode(message)
        } catch let error as StageChannelError {
            throw error
        } catch {
            throw StageChannelError.encoding(error.localizedDescription)
        }
    }

    /// 编码一帧为 JSON 字符串（WebSocket 文本帧内容）。
    public static func encodeString(_ message: StageMessage) throws -> String {
        String(decoding: try encode(message), as: UTF8.self)
    }

    /// 从 JSON Data 解码一帧。
    public static func decode(_ data: Data) throws -> StageMessage {
        do {
            return try StageJSON.decode(StageMessage.self, from: data)
        } catch let error as StageChannelError {
            throw error
        } catch {
            throw StageChannelError.decoding(error.localizedDescription)
        }
    }

    /// 从 JSON 文本解码一帧。
    public static func decode(_ text: String) throws -> StageMessage {
        guard let data = text.data(using: .utf8) else {
            throw StageChannelError.decoding("帧不是合法的 UTF-8")
        }
        return try decode(data)
    }

    /// 解析任意 JSON 文本为 `JSONValue`（fixture 对比、调试用）。
    public static func jsonValue(from text: String) throws -> JSONValue {
        guard let data = text.data(using: .utf8) else {
            throw StageChannelError.decoding("文本不是合法的 UTF-8")
        }
        return try jsonValue(from: data)
    }

    /// 解析任意 JSON Data 为 `JSONValue`。
    public static func jsonValue(from data: Data) throws -> JSONValue {
        do {
            return try StageJSON.decode(JSONValue.self, from: data)
        } catch let error as StageChannelError {
            throw error
        } catch {
            throw StageChannelError.decoding(error.localizedDescription)
        }
    }

    /// 规范化 JSON 文本（key 排序），便于日志与测试对比。
    public static func canonicalString(_ value: JSONValue) throws -> String {
        String(decoding: try StageJSON.encode(value), as: UTF8.self)
    }
}
