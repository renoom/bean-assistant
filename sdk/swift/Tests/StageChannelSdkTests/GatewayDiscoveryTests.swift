import XCTest
@testable import StageChannelSdk

/// 用 URLProtocol stub 验证发现接口的 URL / Header，不需要真实网络。
final class GatewayDiscoveryTests: XCTestCase {
    private static let assistantsJSON = """
    [
      {
        "sessionId": "assistant-3101-c4908fa8",
        "name": "编码助手",
        "status": "online",
        "channels": ["http", "stage"],
        "gatewayBase": "/a/assistant-3101-c4908fa8",
        "gatewayWsPath": "/a/assistant-3101-c4908fa8/ws",
        "channelEndpoints": [
          {"id": "http", "protocol": "http", "host": "127.0.0.1", "port": 41231, "path": "/api/message"},
          {"id": "stage", "protocol": "ws", "host": "127.0.0.1", "port": 41232, "path": "/ws"}
        ]
      },
      {
        "sessionId": "assistant-offline",
        "name": "已离线",
        "status": "offline",
        "channels": ["stage"],
        "gatewayWsPath": "/a/assistant-offline/ws"
      },
      {
        "sessionId": "assistant-http-only",
        "name": "只有 HTTP",
        "status": "online",
        "channels": ["http"],
        "gatewayWsPath": "/a/assistant-http-only/ws"
      },
      {
        "sessionId": "assistant-legacy",
        "name": "旧版 Console",
        "status": "online",
        "channels": ["stage"]
      }
    ]
    """

    private final class RequestLog: @unchecked Sendable {
        private let lock = NSLock()
        private var storage: [URLRequest] = []

        func append(_ request: URLRequest) {
            lock.lock()
            storage.append(request)
            lock.unlock()
        }

        var requests: [URLRequest] {
            lock.lock()
            defer { lock.unlock() }
            return storage
        }
    }

    override func setUp() {
        super.setUp()
        StubURLProtocol.handler = nil
        StubURLProtocol.requestCount = 0
    }

    override func tearDown() {
        StubURLProtocol.handler = nil
        StubURLProtocol.requestCount = 0
        super.tearDown()
    }

    // MARK: - 发现接口

    func testFetchAssistantsBuildsRequestFiltersAndDecodes() async throws {
        let log = RequestLog()
        StubURLProtocol.handler = { request in
            log.append(request)
            return (200, Data(Self.assistantsJSON.utf8))
        }
        let discovery = GatewayDiscovery(
            baseURL: URL(string: "http://127.0.0.1:3000")!,
            apiKey: "ask_test",
            session: makeSession()
        )
        let assistants = try await discovery.fetchAssistants()

        // 过滤：只保留 online + channels 包含 stage。
        XCTAssertEqual(assistants.map(\.sessionId), ["assistant-3101-c4908fa8", "assistant-legacy"])
        XCTAssertEqual(assistants[0].name, "编码助手")
        XCTAssertTrue(assistants[0].isDiscoverable)
        XCTAssertTrue(assistants[0].supportsStage)
        XCTAssertEqual(assistants[0].gatewayBase, "/a/assistant-3101-c4908fa8")
        XCTAssertEqual(assistants[0].gatewayWsPath, "/a/assistant-3101-c4908fa8/ws")
        XCTAssertEqual(assistants[0].resolvedGatewayWsPath, "/a/assistant-3101-c4908fa8/ws")
        XCTAssertEqual(assistants[0].stageEndpoint()?.protocol, "ws")
        XCTAssertEqual(assistants[0].stageEndpoint()?.port, 41232)
        XCTAssertEqual(assistants[0].channelEndpoints?.count, 2)
        XCTAssertEqual(assistants[1].resolvedGatewayWsPath, "/a/assistant-legacy/ws")

        let request = try XCTUnwrap(log.requests.first)
        XCTAssertEqual(request.httpMethod, "GET")
        XCTAssertEqual(request.url?.absoluteString, "http://127.0.0.1:3000/api/assistants")
        XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer ask_test")
        XCTAssertEqual(request.value(forHTTPHeaderField: "Accept"), "application/json")
    }

    func testFetchAssistantsUsesXAPIKeyHeader() async throws {
        let log = RequestLog()
        StubURLProtocol.handler = { request in
            log.append(request)
            return (200, Data("[]".utf8))
        }
        _ = try await GatewayDiscovery.fetchAssistants(
            baseURL: URL(string: "https://console.example.com")!,
            apiKey: "ask_header",
            style: .xAPIKey,
            session: makeSession()
        )
        let request = try XCTUnwrap(log.requests.first)
        XCTAssertEqual(request.value(forHTTPHeaderField: "X-API-Key"), "ask_header")
        XCTAssertNil(request.value(forHTTPHeaderField: "Authorization"))
    }

    func testFetchAssistantsFailsOn401() async throws {
        StubURLProtocol.handler = { _ in
            (401, Data(#"{"error":"invalid api key"}"#.utf8))
        }
        do {
            _ = try await GatewayDiscovery.fetchAssistants(
                baseURL: URL(string: "http://127.0.0.1:3000")!,
                apiKey: "bad",
                session: makeSession()
            )
            XCTFail("401 应抛错")
        } catch let error as StageChannelError {
            guard case .httpStatus(let code, let body) = error else {
                return XCTFail("应为 httpStatus，实际 \(error)")
            }
            XCTAssertEqual(code, 401)
            XCTAssertEqual(body, #"{"error":"invalid api key"}"#)
        }
    }

    func testFetchAssistantsFailsOnMalformedJSON() async throws {
        StubURLProtocol.handler = { _ in (200, Data("not-json".utf8)) }
        do {
            _ = try await GatewayDiscovery.fetchAssistants(
                baseURL: URL(string: "http://127.0.0.1:3000")!,
                apiKey: nil,
                session: makeSession()
            )
            XCTFail("无效 JSON 应抛错")
        } catch let error as StageChannelError {
            guard case .decoding = error else {
                return XCTFail("应为 decoding，实际 \(error)")
            }
        }
    }

    func testAssistantsURLKeepsBasePath() throws {
        let url = try GatewayDiscovery.assistantsURL(
            baseURL: URL(string: "http://127.0.0.1:3000/console/")!
        )
        XCTAssertEqual(url.absoluteString, "http://127.0.0.1:3000/console/api/assistants")
    }

    func testDescriptorFilters() {
        let offline = AssistantDescriptor(sessionId: "a", status: "offline", channels: ["stage"])
        XCTAssertFalse(offline.isDiscoverable)
        let httpOnly = AssistantDescriptor(sessionId: "b", status: "online", channels: ["http"])
        XCTAssertFalse(httpOnly.isDiscoverable)
        XCTAssertTrue(httpOnly.isOnline)
        XCTAssertFalse(httpOnly.supportsStage)
        let stage = AssistantDescriptor(sessionId: "c", status: "online", channels: ["stage"])
        XCTAssertTrue(stage.isDiscoverable)
        XCTAssertNil(stage.stageEndpoint())
    }

    // MARK: - 网关 URL

    func testGatewayWebSocketURLMapsHTTPToWS() throws {
        let url = try GatewayDiscovery.gatewayWebSocketURL(
            baseURL: URL(string: "http://127.0.0.1:3000")!,
            gatewayWsPath: "/a/assistant-1/ws",
            apiKey: "ask_key"
        )
        XCTAssertEqual(url.scheme, "ws")
        XCTAssertEqual(url.host, "127.0.0.1")
        XCTAssertEqual(url.port, 3000)
        XCTAssertEqual(url.path, "/a/assistant-1/ws")
        let components = try XCTUnwrap(URLComponents(url: url, resolvingAgainstBaseURL: false))
        XCTAssertEqual(components.queryItems?.first(where: { $0.name == "api_key" })?.value, "ask_key")
    }

    func testGatewayWebSocketURLMapsHTTPSToWSSAndKeepsPort() throws {
        let url = try GatewayDiscovery.gatewayWebSocketURL(
            baseURL: URL(string: "https://console.example.com:8443")!,
            gatewayWsPath: "a/assistant-2/ws",
            apiKey: nil
        )
        XCTAssertEqual(url.scheme, "wss")
        XCTAssertEqual(url.host, "console.example.com")
        XCTAssertEqual(url.port, 8443)
        XCTAssertEqual(url.path, "/a/assistant-2/ws")
        XCTAssertNil(URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems)
    }

    func testGatewayWebSocketURLPercentEncodesAPIKey() throws {
        let apiKey = "a b&c=d/中文"
        let url = try GatewayDiscovery.gatewayWebSocketURL(
            baseURL: URL(string: "http://127.0.0.1:3000")!,
            gatewayWsPath: "/a/assistant-1/ws",
            apiKey: apiKey
        )
        let components = try XCTUnwrap(URLComponents(url: url, resolvingAgainstBaseURL: false))
        XCTAssertEqual(components.queryItems?.first(where: { $0.name == "api_key" })?.value, apiKey)
        XCTAssertTrue(url.absoluteString.contains("%26") || url.absoluteString.contains("%20"))
    }

    func testGatewayWebSocketURLAcceptsAbsoluteURL() throws {
        let url = try GatewayDiscovery.gatewayWebSocketURL(
            baseURL: URL(string: "http://127.0.0.1:3000")!,
            gatewayWsPath: "wss://other.example.com/a/assistant-3/ws",
            apiKey: "ask_absolute"
        )
        XCTAssertEqual(url.scheme, "wss")
        XCTAssertEqual(url.host, "other.example.com")
        XCTAssertEqual(url.path, "/a/assistant-3/ws")
        let components = try XCTUnwrap(URLComponents(url: url, resolvingAgainstBaseURL: false))
        XCTAssertEqual(components.queryItems?.first(where: { $0.name == "api_key" })?.value, "ask_absolute")
    }

    func testGatewayWebSocketURLRejectsEmptyPath() {
        XCTAssertThrowsError(try GatewayDiscovery.gatewayWebSocketURL(
            baseURL: URL(string: "http://127.0.0.1:3000")!,
            gatewayWsPath: " ",
            apiKey: nil
        )) { error in
            guard case .invalidURL = error as? StageChannelError else {
                return XCTFail("应为 invalidURL，实际 \(error)")
            }
        }
    }

    // MARK: - 直连 URL

    func testDirectWebSocketURL() throws {
        let url = try GatewayDiscovery.directWebSocketURL(host: "127.0.0.1", port: 41232)
        XCTAssertEqual(url.absoluteString, "ws://127.0.0.1:41232/ws")

        let tlsURL = try GatewayDiscovery.directWebSocketURL(host: "assistant.local", port: 443, path: "/stage/ws", useTLS: true)
        XCTAssertEqual(tlsURL.absoluteString, "wss://assistant.local:443/stage/ws")
    }

    func testDirectWebSocketURLWrapsIPv6() throws {
        let url = try GatewayDiscovery.directWebSocketURL(host: "::1", port: 41232)
        XCTAssertEqual(url.absoluteString, "ws://[::1]:41232/ws")
        XCTAssertEqual(url.host, "::1")
    }

    func testDirectWebSocketURLRejectsInvalidPort() {
        XCTAssertThrowsError(try GatewayDiscovery.directWebSocketURL(host: "127.0.0.1", port: 0)) { error in
            guard case .invalidURL = error as? StageChannelError else {
                return XCTFail("应为 invalidURL，实际 \(error)")
            }
        }
        XCTAssertThrowsError(try GatewayDiscovery.directWebSocketURL(host: "", port: 1)) { error in
            guard case .invalidURL = error as? StageChannelError else {
                return XCTFail("应为 invalidURL，实际 \(error)")
            }
        }
    }

    // MARK: - 连接构造

    func testGatewayConnectionCarriesGatewayModeHeadersAndUrl() throws {
        let connection = try GatewayDiscovery.gatewayConnection(
            baseURL: URL(string: "https://console.example.com")!,
            gatewayWsPath: "/a/assistant-1/ws",
            apiKey: "ask_key"
        )
        XCTAssertEqual(connection.mode, .gateway)
        XCTAssertEqual(connection.url.scheme, "wss")
        XCTAssertEqual(connection.headers["Authorization"], "Bearer ask_key")
        let components = try XCTUnwrap(URLComponents(url: connection.url, resolvingAgainstBaseURL: false))
        XCTAssertEqual(components.queryItems?.first(where: { $0.name == "api_key" })?.value, "ask_key")
    }

    func testDirectConnectionCarriesHeaderAuth() throws {
        let connection = try GatewayDiscovery.directConnection(
            host: "127.0.0.1",
            port: 41232,
            auth: StageChannelAuth(apiKey: "ask_direct", style: .xAPIKey)
        )
        XCTAssertEqual(connection.mode, .direct)
        XCTAssertEqual(connection.url.absoluteString, "ws://127.0.0.1:41232/ws")
        XCTAssertEqual(connection.headers["X-API-Key"], "ask_direct")
        XCTAssertNil(connection.headers["Authorization"])
    }

    func testGatewayConnectionForDescriptor() throws {
        let descriptor = AssistantDescriptor(
            sessionId: "assistant-1",
            status: "online",
            channels: ["stage"],
            gatewayWsPath: "/a/assistant-1/ws"
        )
        let connection = try GatewayDiscovery.gatewayConnection(
            for: descriptor,
            baseURL: URL(string: "http://localhost:3000")!,
            apiKey: "ask_key"
        )
        XCTAssertEqual(connection.url.absoluteString, "ws://localhost:3000/a/assistant-1/ws?api_key=ask_key")
    }

    // MARK: - Helpers

    private func makeSession() -> URLSession {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [StubURLProtocol.self]
        return URLSession(configuration: configuration)
    }
}

/// 无网络 URLProtocol stub；测试串行执行，因此用 `nonisolated(unsafe)` 共享 handler。
final class StubURLProtocol: URLProtocol {
    nonisolated(unsafe) static var handler: (@Sendable (URLRequest) throws -> (Int, Data))?
    nonisolated(unsafe) static var requestCount = 0

    override class func canInit(with request: URLRequest) -> Bool { true }

    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        Self.requestCount += 1
        guard let handler = Self.handler else {
            client?.urlProtocol(self, didFailWithError: URLError(.unknown))
            return
        }
        do {
            let (status, body) = try handler(request)
            let response = HTTPURLResponse(
                url: request.url!,
                statusCode: status,
                httpVersion: "HTTP/1.1",
                headerFields: ["Content-Type": "application/json"]
            )!
            client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
            client?.urlProtocol(self, didLoad: body)
            client?.urlProtocolDidFinishLoading(self)
        } catch {
            client?.urlProtocol(self, didFailWithError: error)
        }
    }

    override func stopLoading() {}
}
