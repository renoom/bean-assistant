import Foundation

/// Internal JSON helper used by the SDK. Kept internal so the public surface stays small.
enum StageJSON {
    static func makeEncoder() -> JSONEncoder {
        let encoder = JSONEncoder()
        // Stable output makes logs and fixture comparisons deterministic.
        encoder.outputFormatting = [.sortedKeys]
        return encoder
    }

    static func makeDecoder() -> JSONDecoder {
        JSONDecoder()
    }

    static func encode<T: Encodable>(_ value: T) throws -> Data {
        try makeEncoder().encode(value)
    }

    static func decode<T: Decodable>(_ type: T.Type, from data: Data) throws -> T {
        try makeDecoder().decode(type, from: data)
    }
}

/// A lossless-enough, type-erased JSON value.
///
/// Used for protocol fields whose payload is open-ended (`llm_event.event`,
/// `command.args`, `command_result.result`, command parameter schemas …).
/// Integer and floating point numbers are kept apart so re-encoding a frame does
/// not turn `0` into `0.0`.
public enum JSONValue: Sendable, Equatable {
    case null
    case bool(Bool)
    case int(Int)
    case double(Double)
    case string(String)
    case array([JSONValue])
    case object([String: JSONValue])
}

// MARK: - Convenience accessors

public extension JSONValue {
    var isNull: Bool {
        if case .null = self { return true }
        return false
    }

    var boolValue: Bool? {
        if case .bool(let value) = self { return value }
        return nil
    }

    var intValue: Int? {
        switch self {
        case .int(let value): return value
        case .double(let value) where value == value.rounded() && value.magnitude < Double(Int.max): return Int(value)
        default: return nil
        }
    }

    var doubleValue: Double? {
        switch self {
        case .double(let value): return value
        case .int(let value): return Double(value)
        default: return nil
        }
    }

    var stringValue: String? {
        if case .string(let value) = self { return value }
        return nil
    }

    var arrayValue: [JSONValue]? {
        if case .array(let value) = self { return value }
        return nil
    }

    var objectValue: [String: JSONValue]? {
        if case .object(let value) = self { return value }
        return nil
    }

    subscript(key: String) -> JSONValue? {
        guard case .object(let object) = self else { return nil }
        return object[key]
    }

    /// Encode this value as UTF-8 JSON (sorted keys).
    func encoded() throws -> Data {
        try StageJSON.encode(self)
    }

    /// Encode this value as a JSON string (sorted keys).
    func encodedString() throws -> String {
        String(decoding: try encoded(), as: UTF8.self)
    }

    /// Re-decode this JSON value into a concrete `Decodable` model.
    func decoded<T: Decodable>(_ type: T.Type) throws -> T {
        let data = try encoded()
        do {
            return try StageJSON.decode(type, from: data)
        } catch {
            throw StageChannelError.decoding("JSON 解码 \(String(describing: type)) 失败：\(error)")
        }
    }

    /// Build a JSON value from any `Encodable` value.
    init<T: Encodable>(encoding value: T) throws {
        let data: Data
        do {
            data = try StageJSON.encode(value)
        } catch {
            throw StageChannelError.encoding("JSON 编码 \(String(describing: type(of: value))) 失败：\(error)")
        }
        self = try StageJSON.decode(JSONValue.self, from: data)
    }
}

// MARK: - Codable

extension JSONValue: Codable {
    public init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if container.decodeNil() {
            self = .null
            return
        }
        if let value = try? container.decode(Bool.self) {
            self = .bool(value)
            return
        }
        if let value = try? container.decode(Int.self) {
            self = .int(value)
            return
        }
        if let value = try? container.decode(Double.self) {
            self = .double(value)
            return
        }
        if let value = try? container.decode(String.self) {
            self = .string(value)
            return
        }
        if let value = try? container.decode([JSONValue].self) {
            self = .array(value)
            return
        }
        if let value = try? container.decode([String: JSONValue].self) {
            self = .object(value)
            return
        }
        throw DecodingError.dataCorruptedError(
            in: container,
            debugDescription: "不支持的 JSON 值类型"
        )
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        switch self {
        case .null: try container.encodeNil()
        case .bool(let value): try container.encode(value)
        case .int(let value): try container.encode(value)
        case .double(let value): try container.encode(value)
        case .string(let value): try container.encode(value)
        case .array(let value): try container.encode(value)
        case .object(let value): try container.encode(value)
        }
    }
}

// MARK: - Equatable

public extension JSONValue {
    static func == (lhs: JSONValue, rhs: JSONValue) -> Bool {
        switch (lhs, rhs) {
        case (.null, .null):
            return true
        case (.bool(let lhs), .bool(let rhs)):
            return lhs == rhs
        case (.string(let lhs), .string(let rhs)):
            return lhs == rhs
        case (.int(let lhs), .int(let rhs)):
            return lhs == rhs
        case (.double(let lhs), .double(let rhs)):
            return lhs == rhs
        case (.int(let lhs), .double(let rhs)):
            return Double(lhs) == rhs
        case (.double(let lhs), .int(let rhs)):
            return lhs == Double(rhs)
        case (.array(let lhs), .array(let rhs)):
            return lhs == rhs
        case (.object(let lhs), .object(let rhs)):
            return lhs == rhs
        default:
            return false
        }
    }
}

// MARK: - Literal ergonomics

extension JSONValue: ExpressibleByNilLiteral {
    public init(nilLiteral: ()) { self = .null }
}

extension JSONValue: ExpressibleByBooleanLiteral {
    public init(booleanLiteral value: Bool) { self = .bool(value) }
}

extension JSONValue: ExpressibleByIntegerLiteral {
    public init(integerLiteral value: Int) { self = .int(value) }
}

extension JSONValue: ExpressibleByFloatLiteral {
    public init(floatLiteral value: Double) { self = .double(value) }
}

extension JSONValue: ExpressibleByStringLiteral {
    public init(stringLiteral value: String) { self = .string(value) }
}

extension JSONValue: ExpressibleByArrayLiteral {
    public init(arrayLiteral elements: JSONValue...) { self = .array(elements) }
}

extension JSONValue: ExpressibleByDictionaryLiteral {
    public init(dictionaryLiteral elements: (String, JSONValue)...) {
        self = .object(Dictionary(uniqueKeysWithValues: elements))
    }
}
