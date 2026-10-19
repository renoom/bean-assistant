import Foundation

/// Console / 网关鉴权。
///
/// 协议要求 HTTP 发现接口接受 `Authorization: Bearer <key>` 或 `X-API-Key: <key>`
/// （`protocol.md` §2）；网关 WebSocket 还接受 `?api_key=<key>`。
public struct StageChannelAuth: Sendable, Equatable {
    /// 鉴权头风格。
    public enum Style: String, Sendable, Equatable, CaseIterable, Codable {
        case bearer
        case xAPIKey

        /// HTTP 头名称。
        public var headerName: String {
            switch self {
            case .bearer: return "Authorization"
            case .xAPIKey: return "X-API-Key"
            }
        }

        /// 生成 header 值。
        public func headerValue(apiKey: String) -> String {
            switch self {
            case .bearer: return "Bearer \(apiKey)"
            case .xAPIKey: return apiKey
            }
        }
    }

    public var apiKey: String?
    public var style: Style

    public init(apiKey: String? = nil, style: Style = .bearer) {
        self.apiKey = apiKey
        self.style = style
    }

    /// 不带鉴权。
    public static let none = StageChannelAuth(apiKey: nil)

    public var isEmpty: Bool {
        guard let apiKey else { return true }
        return apiKey.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    /// 是否需要附加鉴权头。
    public var httpHeaders: [String: String] {
        guard let apiKey, !apiKey.isEmpty else { return [:] }
        return [style.headerName: style.headerValue(apiKey: apiKey)]
    }

    /// 给 `URLRequest` 应用鉴权头。
    public func apply(to request: inout URLRequest) {
        for (name, value) in httpHeaders {
            request.setValue(value, forHTTPHeaderField: name)
        }
    }
}
