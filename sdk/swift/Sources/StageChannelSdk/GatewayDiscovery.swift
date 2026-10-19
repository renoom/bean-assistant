import Foundation

// MARK: - 连接目标

/// 一条已解析好的 StageChannel 连接配置。
///
/// - 网关模式：`wss://<console>/a/{sessionId}/ws?api_key=<key>`，
///   不使用发现结果里的内部 host/port。
/// - 直连模式：`ws://<assistantHost>:<stagePort>/ws`，Key 通过 Header 传递。
public struct StageChannelConnection: Sendable, Equatable {
    public enum Mode: String, Sendable, Equatable, Codable {
        case gateway
        case direct
    }

    public var mode: Mode
    public var url: URL
    /// 握手附加 HTTP 头（如 `Authorization: Bearer …` / `X-API-Key: …`）。
    public var headers: [String: String]

    public init(mode: Mode, url: URL, headers: [String: String] = [:]) {
        self.mode = mode
        self.url = url
        self.headers = headers
    }
}

// MARK: - 发现模型

/// Console `channelEndpoints` 中的一项（仅直连开发模式使用）。
public struct AssistantChannelEndpoint: Codable, Sendable, Equatable, Identifiable {
    public var id: String
    /// 协议号，取值 `http` / `ws`。
    public var `protocol`: String
    public var host: String
    public var port: Int
    public var path: String

    public init(id: String, protocol: String, host: String, port: Int, path: String) {
        self.id = id
        self.protocol = `protocol`
        self.host = host
        self.port = port
        self.path = path
    }

    public var isWebSocket: Bool { `protocol` == "ws" }
}

/// `GET /api/assistants` 返回数组中的一个助手。
public struct AssistantDescriptor: Codable, Sendable, Equatable, Identifiable {
    public var sessionId: String
    public var name: String?
    public var status: String
    public var channels: [String]
    public var gatewayBase: String?
    public var gatewayWsPath: String?
    public var channelEndpoints: [AssistantChannelEndpoint]?
    // 以下字段来自注册表，部分 Console 版本会返回。
    public var model: String?
    public var provider: String?
    public var host: String?
    public var port: Int?

    public init(
        sessionId: String,
        name: String? = nil,
        status: String,
        channels: [String] = [],
        gatewayBase: String? = nil,
        gatewayWsPath: String? = nil,
        channelEndpoints: [AssistantChannelEndpoint]? = nil,
        model: String? = nil,
        provider: String? = nil,
        host: String? = nil,
        port: Int? = nil
    ) {
        self.sessionId = sessionId
        self.name = name
        self.status = status
        self.channels = channels
        self.gatewayBase = gatewayBase
        self.gatewayWsPath = gatewayWsPath
        self.channelEndpoints = channelEndpoints
        self.model = model
        self.provider = provider
        self.host = host
        self.port = port
    }

    public var id: String { sessionId }

    /// 是否在线（`status == "online"`）。
    public var isOnline: Bool { status == "online" }

    /// 是否声明了 StageChannel。
    public var supportsStage: Bool { channels.contains(StageChannelProtocol.channelName) }

    /// 发现接口的筛选规则：在线且支持 stage。
    public var isDiscoverable: Bool { isOnline && supportsStage }

    /// 网关 WebSocket 路径；缺失时按 sessionId 推导（旧版 Console 兼容）。
    public var resolvedGatewayWsPath: String? {
        if let gatewayWsPath, !gatewayWsPath.isEmpty { return gatewayWsPath }
        guard !sessionId.isEmpty else { return nil }
        return "/a/\(sessionId)/ws"
    }

    /// 直连开发模式可用的 Stage WebSocket 端点。
    public func stageEndpoint() -> AssistantChannelEndpoint? {
        let endpoints = channelEndpoints ?? []
        if let endpoint = endpoints.first(where: { $0.id == StageChannelProtocol.channelName && $0.isWebSocket }) {
            return endpoint
        }
        return endpoints.first(where: \.isWebSocket)
    }
}

// MARK: - 发现 / URL 构造

/// Console 发现接口与 WebSocket URL 构造。
///
/// ```swift
/// let assistants = try await GatewayDiscovery.fetchAssistants(
///     baseURL: URL(string: "https://console.example.com")!,
///     apiKey: "ask_xxx"
/// )
/// guard let assistant = assistants.first, let path = assistant.resolvedGatewayWsPath else { … }
/// let connection = try GatewayDiscovery.gatewayConnection(
///     baseURL: URL(string: "https://console.example.com")!,
///     gatewayWsPath: path,
///     apiKey: "ask_xxx"
/// )
/// ```
public struct GatewayDiscovery: Sendable {
    public var baseURL: URL
    public var auth: StageChannelAuth
    public var session: URLSession

    public init(baseURL: URL, auth: StageChannelAuth = .none, session: URLSession = .shared) {
        self.baseURL = baseURL
        self.auth = auth
        self.session = session
    }

    public init(
        baseURL: URL,
        apiKey: String?,
        style: StageChannelAuth.Style = .bearer,
        session: URLSession = .shared
    ) {
        self.init(baseURL: baseURL, auth: StageChannelAuth(apiKey: apiKey, style: style), session: session)
    }

    // MARK: 发现

    /// 查询 Console，返回 **在线且支持 stage** 的助手。
    ///
    /// 非 2xx 抛 `StageChannelError.httpStatus`（401 通常表示 Key 无效）。
    public func fetchAssistants() async throws -> [AssistantDescriptor] {
        try await Self.fetchAssistants(
            baseURL: baseURL,
            auth: auth,
            session: session
        )
    }

    /// 静态便捷入口。
    public static func fetchAssistants(
        baseURL: URL,
        apiKey: String?,
        style: StageChannelAuth.Style = .bearer,
        session: URLSession = .shared
    ) async throws -> [AssistantDescriptor] {
        try await fetchAssistants(
            baseURL: baseURL,
            auth: StageChannelAuth(apiKey: apiKey, style: style),
            session: session
        )
    }

    /// 带完整鉴权配置的静态入口。
    public static func fetchAssistants(
        baseURL: URL,
        auth: StageChannelAuth,
        session: URLSession = .shared
    ) async throws -> [AssistantDescriptor] {
        var request = URLRequest(url: try assistantsURL(baseURL: baseURL))
        request.httpMethod = "GET"
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        auth.apply(to: &request)

        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await session.data(for: request)
        } catch {
            throw StageChannelError.transport(error.localizedDescription)
        }
        guard let http = response as? HTTPURLResponse else {
            throw StageChannelError.httpStatus(code: -1, body: nil)
        }
        guard (200..<300).contains(http.statusCode) else {
            throw StageChannelError.httpStatus(
                code: http.statusCode,
                body: String(decoding: data.prefix(2048), as: UTF8.self)
            )
        }
        do {
            let all = try StageJSON.decode([AssistantDescriptor].self, from: data)
            return all.filter(\.isDiscoverable)
        } catch {
            throw StageChannelError.decoding("发现接口返回无法解析：\(error)")
        }
    }

    /// `GET {baseURL}/api/assistants`（保留 baseURL 已有的 path 前缀）。
    public static func assistantsURL(baseURL: URL) throws -> URL {
        guard var components = URLComponents(url: baseURL, resolvingAgainstBaseURL: false),
              let host = components.host, !host.isEmpty,
              let scheme = components.scheme, !scheme.isEmpty
        else {
            throw StageChannelError.invalidURL("Console baseURL 必须包含 scheme 与 host：\(baseURL.absoluteString)")
        }
        var basePath = components.path
        if basePath.hasSuffix("/") { basePath.removeLast() }
        if !basePath.isEmpty && !basePath.hasPrefix("/") { basePath = "/" + basePath }
        components.path = basePath + StageChannelProtocol.assistantsPath
        components.queryItems = nil
        components.fragment = nil
        guard let url = components.url else {
            throw StageChannelError.invalidURL("无法构造发现接口 URL：\(baseURL.absoluteString)")
        }
        return url
    }

    // MARK: URL 构造

    /// 网关模式 WebSocket URL。
    ///
    /// `http → ws`、`https → wss`，并追加 `?api_key=<key>`；
    /// `gatewayWsPath` 也可以是完整的 `ws(s)://` / `http(s)://` URL。
    public static func gatewayWebSocketURL(
        baseURL: URL,
        gatewayWsPath: String,
        apiKey: String?
    ) throws -> URL {
        let rawPath = gatewayWsPath.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !rawPath.isEmpty else {
            throw StageChannelError.invalidURL("gatewayWsPath 不能为空")
        }

        // 完整 URL 的情况。
        if let absolute = URLComponents(string: rawPath),
           let host = absolute.host, !host.isEmpty,
           let scheme = absolute.scheme,
           let mapped = webSocketScheme(for: scheme) {
            var components = absolute
            components.scheme = mapped
            components.queryItems = queryItems(components.queryItems, apiKey: apiKey)
            components.fragment = nil
            guard let url = components.url else {
                throw StageChannelError.invalidURL("gatewayWsPath 无法解析：\(rawPath)")
            }
            return url
        }

        guard var components = URLComponents(url: baseURL, resolvingAgainstBaseURL: false),
              let host = components.host, !host.isEmpty
        else {
            throw StageChannelError.invalidURL("Console baseURL 必须包含 host：\(baseURL.absoluteString)")
        }
        guard let scheme = webSocketScheme(for: components.scheme) else {
            throw StageChannelError.invalidURL("baseURL scheme 必须是 http(s):// 或 ws(s)://：\(baseURL.absoluteString)")
        }
        let relative = URLComponents(string: rawPath)
        var path = relative?.path ?? rawPath
        if !path.hasPrefix("/") { path = "/" + path }
        components.scheme = scheme
        components.path = path
        components.queryItems = queryItems(relative?.queryItems, apiKey: apiKey)
        components.fragment = nil
        guard let url = components.url else {
            throw StageChannelError.invalidURL("无法构造网关 WebSocket URL：\(baseURL.absoluteString) + \(rawPath)")
        }
        return url
    }

    /// 直连模式 WebSocket URL：`ws(s)://host:port/path`。
    ///
    /// Key 不走 query，由 `StageChannelAuth` 转换成握手 Header。
    public static func directWebSocketURL(
        host: String,
        port: Int,
        path: String = StageChannelProtocol.defaultPath,
        useTLS: Bool = false
    ) throws -> URL {
        var hostPart = host.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !hostPart.isEmpty else {
            throw StageChannelError.invalidURL("host 不能为空")
        }
        guard (1...65535).contains(port) else {
            throw StageChannelError.invalidURL("port 必须在 1...65535：\(port)")
        }
        // IPv6 字面量需要方括号。
        if hostPart.contains(":") && !hostPart.hasPrefix("[") {
            hostPart = "[\(hostPart)]"
        }
        var normalizedPath = path.trimmingCharacters(in: .whitespacesAndNewlines)
        if normalizedPath.isEmpty { normalizedPath = StageChannelProtocol.defaultPath }
        if !normalizedPath.hasPrefix("/") { normalizedPath = "/" + normalizedPath }
        let scheme = useTLS ? "wss" : "ws"
        guard let url = URL(string: "\(scheme)://\(hostPart):\(port)\(normalizedPath)") else {
            throw StageChannelError.invalidURL("无法构造直连 WebSocket URL：\(host):\(port)\(normalizedPath)")
        }
        return url
    }

    // MARK: 便捷连接构造

    /// 网关连接（推荐）。`apiKey` 同时用于 `?api_key=` 与鉴权 Header。
    public static func gatewayConnection(
        baseURL: URL,
        gatewayWsPath: String,
        apiKey: String?,
        authStyle: StageChannelAuth.Style = .bearer
    ) throws -> StageChannelConnection {
        let url = try gatewayWebSocketURL(baseURL: baseURL, gatewayWsPath: gatewayWsPath, apiKey: apiKey)
        return StageChannelConnection(
            mode: .gateway,
            url: url,
            headers: StageChannelAuth(apiKey: apiKey, style: authStyle).httpHeaders
        )
    }

    /// 针对发现结果构造网关连接。
    public static func gatewayConnection(
        for assistant: AssistantDescriptor,
        baseURL: URL,
        apiKey: String?,
        authStyle: StageChannelAuth.Style = .bearer
    ) throws -> StageChannelConnection {
        guard let path = assistant.resolvedGatewayWsPath else {
            throw StageChannelError.invalidURL("助手 \(assistant.sessionId) 没有 gatewayWsPath")
        }
        return try gatewayConnection(
            baseURL: baseURL,
            gatewayWsPath: path,
            apiKey: apiKey,
            authStyle: authStyle
        )
    }

    /// 直连连接（本地开发 / 无 Console 部署）。
    public static func directConnection(
        host: String,
        port: Int,
        path: String = StageChannelProtocol.defaultPath,
        useTLS: Bool = false,
        auth: StageChannelAuth = .none
    ) throws -> StageChannelConnection {
        let url = try directWebSocketURL(host: host, port: port, path: path, useTLS: useTLS)
        return StageChannelConnection(mode: .direct, url: url, headers: auth.httpHeaders)
    }

    /// 针对发现结果的 `channelEndpoints.stage` 构造直连连接。
    public static func directConnection(
        for assistant: AssistantDescriptor,
        auth: StageChannelAuth = .none
    ) throws -> StageChannelConnection {
        guard let endpoint = assistant.stageEndpoint() else {
            throw StageChannelError.invalidURL("助手 \(assistant.sessionId) 没有 ws stage 端点")
        }
        return try directConnection(
            host: endpoint.host,
            port: endpoint.port,
            path: endpoint.path,
            useTLS: false,
            auth: auth
        )
    }

    // MARK: 内部

    private static func webSocketScheme(for scheme: String?) -> String? {
        switch scheme?.lowercased() {
        case "http", "ws": return "ws"
        case "https", "wss": return "wss"
        default: return nil
        }
    }

    private static func queryItems(_ existing: [URLQueryItem]?, apiKey: String?) -> [URLQueryItem]? {
        var items = (existing ?? []).filter { $0.name != "api_key" }
        if let apiKey, !apiKey.isEmpty {
            items.append(URLQueryItem(name: "api_key", value: apiKey))
        }
        return items.isEmpty ? nil : items
    }
}

/// 兼容命名：部分文档称其为 `AssistantDiscovery`。
public typealias AssistantDiscovery = GatewayDiscovery
