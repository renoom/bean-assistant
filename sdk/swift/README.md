# StageChannelSdk（Swift）

StageChannel 协议的 Swift 客户端实现（SwiftPM 包，无第三方依赖）。

协议唯一源：[`../spec/protocol.md`](../spec/protocol.md) 与 [`../spec/fixtures/`](../spec/fixtures/)（只读）。
本包与其保持逐帧一致，并通过 fixtures 一致性测试。

- 支持 **网关模式**（`wss://<console>/a/{id}/ws?api_key=…`）与 **直连模式**（`ws://host:port/ws`）
- 支持 `Authorization: Bearer` 与 `X-API-Key` 两种发现鉴权头
- 默认传输层 `URLSessionWebSocketTask`，传输接口可注入 mock
- 完整握手状态机：`hello → hello_ack → stage_register → stage_activate`（`role=user` 跳过激活）
- 30 秒握手超时；命令 `stageId` 不匹配自动回 `ok:false`；4001（clientId 被替换）关闭码透出
- 未知 `type` / 未知字段容忍（向前兼容）

## 环境要求

| 项 | 要求 |
| --- | --- |
| Swift | 6.x（开发验证：Swift 6.4 / Xcode 27） |
| 平台 | iOS 16+ / macOS 13+ |
| 依赖 | 无（仅 Foundation） |

## 安装

### 本地路径（monorepo 内）

```swift
// Package.swift
dependencies: [
    .package(path: "../assistant/sdk/swift"),
],
targets: [
    .target(name: "YourApp", dependencies: [
        .product(name: "StageChannelSdk", package: "StageChannelSdk"),
    ]),
]
```

Xcode：`File → Add Package Dependencies… → Add Local…`，选择 `sdk/swift` 目录。

### Git URL

```swift
dependencies: [
    .package(url: "https://<your-git-host>/assistant.git", from: "0.1.0"),
]
```

> 若仓库未打 tag，可改用 `.package(url: ..., branch: "main")` 或本地路径。

## 快速开始（iOS / macOS）

```swift
import StageChannelSdk

let consoleURL = URL(string: "https://console.example.com")!
let apiKey = "ask_xxxxxxxx"

// 1) 发现：只返回 status == "online" 且 channels 含 "stage" 的助手
let assistants = try await GatewayDiscovery.fetchAssistants(
    baseURL: consoleURL,
    apiKey: apiKey
)
guard let assistant = assistants.first,
      let wsPath = assistant.resolvedGatewayWsPath else {
    print("没有可用的在线 Stage 助手")
    return
}

// 2) 构造网关连接（http → ws / https → wss，并自动追加 ?api_key=）
let connection = try GatewayDiscovery.gatewayConnection(
    baseURL: consoleURL,
    gatewayWsPath: wsPath,
    apiKey: apiKey
)

// 3) 声明 Stage 与能力
let registration = StageRegistration(
    id: "glasses:default",
    kind: "glasses",
    environment: StageEnvironment(text: "雷鸟眼镜"),
    commands: [
        CommandSpec(name: "notify", description: "在眼镜上显示提示"),
        CommandSpec(name: "show", description: "在镜片显示内容"),
    ]
)

// 4) 创建客户端（clientId 必须实例唯一、跨重连保持不变）
let client = StageChannelClient(
    connection: connection,
    configuration: .init(
        clientId: UIDevice.current.identifierForVendor?.uuidString ?? UUID().uuidString,
        role: .assistant,
        assistantId: assistant.sessionId,
        name: "雷鸟眼镜",
        registration: registration
    )
)

// 5) 注册回调（delegate 闭包风格，回调在 SDK 后台执行器触发）
await client.setEventHandler { event in
    switch event {
    case .connected(let info):
        print("已就绪 state=\(info.state) snapshot=\(String(describing: info.snapshot?.id))")

    case .disconnected(let reason, let code):
        print("连接关闭：\(reason) code=\(String(describing: code))")
        if code == StageChannelProtocol.replacedCloseCode {
            print("clientId 被新连接替换（4001），不要用同一 clientId 重连")
        }

    case .command(let command):
        // 命令必须在 UI 线程之外执行；回执越早越好（服务端 30s 超时）
        Task {
            let result: JSONValue = ["ok": true]
            try? await client.sendCommandResult(command, ok: true, result: result)
        }

    case .llmEvent(let event):
        // 完整 SessionEvent / 可读事件，原样透传，仅建议调试面板消费
        print("llm_event: \(event["type"]?.stringValue ?? "?")")

    case .registerResult(let result):
        print("stage_register_result: \(result.kind)")

    case .activateResult(let result):
        print("stage_activate/transition_result: \(result.kind)")

    case .error(let error):
        print("错误：\(error.localizedDescription)")
    }
}

// 6) 连接并完成握手（内部按 role 自动 register / activate）
try await client.connect()

// 7) 上报事件
try await client.sendEvent(kind: "user_said", fields: [
    "text": "你好",
    "participantId": "user-1",
])
```

UI 更新：

```swift
await client.setEventHandler { event in
    Task { @MainActor in
        // 回调可能来自任意后台线程，切回主线程再更新 UI
    }
}
```

## 网关模式 vs 直连模式

| 模式 | 地址 | 鉴权 | 适用 |
| --- | --- | --- | --- |
| 网关（推荐） | `wss://<console>/a/{sessionId}/ws?api_key=<key>` | 网关校验平台 Key（Bearer / `?api_key=`） | 公网 / 多助手部署 |
| 直连 | `ws://<assistantHost>:<stagePort>/ws` | StageChannel 不校验 Key（可自行加 Header） | 本地开发 / 无 Console |

网关模式下**不要**使用发现结果 `channelEndpoints` 里的内部 host/port，只使用 `gatewayBase` / `gatewayWsPath`。

```swift
// 网关
let gateway = try GatewayDiscovery.gatewayConnection(
    baseURL: URL(string: "https://console.example.com")!,
    gatewayWsPath: "/a/assistant-3101-c4908fa8/ws",
    apiKey: "ask_xxx"
)

// 直连（含 Header 鉴权；StageChannel 本身不校验 Key）
let direct = try GatewayDiscovery.directConnection(
    host: "127.0.0.1",
    port: 41232,
    path: "/ws",
    useTLS: false,
    auth: StageChannelAuth(apiKey: "ask_xxx", style: .xAPIKey)
)
```

URL 构造 API：

```swift
// https → wss、http → ws，并追加 api_key query
GatewayDiscovery.gatewayWebSocketURL(
    baseURL: consoleURL, gatewayWsPath: "/a/x/ws", apiKey: "ask_xxx")

// ws://host:port/path（useTLS = true 时为 wss）
GatewayDiscovery.directWebSocketURL(host: "127.0.0.1", port: 41232, path: "/ws", useTLS: false)
```

## 鉴权

```swift
// 默认：Authorization: Bearer <key>
StageChannelAuth(apiKey: "ask_xxx")

// 或：X-API-Key: <key>
StageChannelAuth(apiKey: "ask_xxx", style: .xAPIKey)

// 无鉴权（直连开发）
StageChannelAuth.none
```

- `GatewayDiscovery.fetchAssistants(baseURL:apiKey:)` 默认 Bearer；需要 `X-API-Key` 时用
  `fetchAssistants(baseURL:apiKey:style: .xAPIKey)`。
- 网关 WebSocket URL 会同时携带 `?api_key=`（协议推荐方式）；`connection.headers` 也会带鉴权头，
  浏览器/系统 WebSocket 实现会把它放进 Upgrade 请求。
- Console 返回 **401** 时抛 `StageChannelError.httpStatus(code: 401, …)`，请引导用户检查 Key。

## 状态机与时序

```text
disconnected
  └─ connect() → connecting
       └─ socket open → helloSent（发送 hello）
            ├─ hello_ack → acknowledged
            │    └─ stage_register → registered
            │         └─ stage_activate → active（role == .user 跳过激活）
            └─ error / 30s 超时 → disconnected（error + disconnected 回调，connect() 抛错）
active
  ├─ command → 执行 → command_result
  ├─ event（stageId 必须是当前 Stage）
  ├─ llm_event（持续）
  └─ socket closed → disconnected（服务端 Stage 进入 suspended）
```

- **握手超时 30 秒**（`Configuration.handshakeTimeout`），覆盖 hello / register / activate 全程。
- `connect()` 行为取决于配置：
  - `registration != nil`：自动 `register`，`role != .user` 时继续 `activate`，随后触发 `connected`；
  - `registration == nil`：`hello_ack` 后即触发 `connected`（可由调用方手动调 `registerStage` / `activateStage`）；
  - `role == .user` 时只注册、不激活。
- 每个请求有独立 30 秒超时（`Configuration.requestTimeout`），超时抛 `requestTimeout`。
- **断线不会自动重连**，也不自动恢复注册；请新建客户端重新走 `connect()`（`clientId` 保持同一实例值）。

## API 参考

### GatewayDiscovery

| API | 说明 |
| --- | --- |
| `fetchAssistants(baseURL:apiKey:) async throws -> [AssistantDescriptor]` | `GET /api/assistants`，过滤 online + stage |
| `fetchAssistants(baseURL:apiKey:style:)` | 指定 Bearer / X-API-Key |
| `gatewayWebSocketURL(baseURL:gatewayWsPath:apiKey:) throws -> URL` | 网关 URL（含 api_key） |
| `directWebSocketURL(host:port:path:useTLS:) throws -> URL` | 直连 URL |
| `gatewayConnection(baseURL:gatewayWsPath:apiKey:)` | 组装 `StageChannelConnection` |
| `directConnection(host:port:path:useTLS:auth:)` | 直连连接 |
| `gatewayConnection(for:baseURL:apiKey:)` | 从发现结果直接构造 |

`AssistantDescriptor` 常用字段：`sessionId`、`name`、`status`、`channels`、`gatewayBase`、
`gatewayWsPath`、`resolvedGatewayWsPath`（缺失时按 sessionId 推导）、`channelEndpoints`、
`isDiscoverable`、`supportsStage`、`stageEndpoint()`。

### StageChannelClient（actor）

| API | 说明 |
| --- | --- |
| `init(connection:configuration:transportFactory:eventHandler:)` | 创建；可注入 mock 传输层 |
| `setEventHandler(_:)` | 设置/替换事件回调 |
| `connect() async throws` | 连接并完成握手 |
| `close(reason:) async` | 主动关闭，触发 `disconnected` |
| `registerStage(_:) async throws -> StageRegisterResult` | 声明 Stage |
| `activateStage(stageId:mode:expectedStageId:expectedRevision:) async throws -> StageTransitionResult` | 激活 Stage |
| `transitionToEmpty(mode:expectedStageId:expectedRevision:) async throws -> StageTransitionResult` | 回到默认环境 |
| `sendEvent(_:stageId:) / sendEvent(kind:fields:stageId:) async throws` | 上报 `event` |
| `sendCommandResult(commandId:ok:result:error:) async throws` | 回执 `command_result` |
| `sendCommandResult(_:ok:result:error:) async throws` | 直接回执一条 `StageCommand` |
| `state` / `snapshot` / `helloAck` / `registeredStageIds` / `activeStageId` / `primaryStageId` | 只读状态（`await`） |

### 回调事件（delegate 闭包，二选一选定的方式）

`StageClientEvent`：

| 事件 | 触发时机 |
| --- | --- |
| `.connected(StageConnectionInfo)` | 握手完成 |
| `.disconnected(reason: String, code: Int?)` | 连接关闭；4001 表示 clientId 被替换 |
| `.command(StageCommand)` | 收到属于本客户端 Stage 的命令 |
| `.llmEvent(JSONValue)` | `llm_event` 原始事件 |
| `.registerResult(StageRegisterResult)` | `stage_register_result` |
| `.activateResult(StageTransitionResult)` | `stage_activate_result` / `stage_transition_result` |
| `.error(StageChannelError)` | 协议错误 / 服务端 `error` / `event_rejected` / 解码失败 |

回调是同步 `@Sendable` 闭包，在 SDK 后台执行器触发，**不要在其中阻塞或直接操作 UI**；需要主线程时自行
`Task { @MainActor in … }`。

### 命令处理约定

服务端下发 `command` 时：

1. `stageId` 属于本客户端注册的 Stage → 触发 `.command` 回调；
2. `stageId` 不属于 → **不交付回调**，SDK 自动回
   `{"type":"command_result","commandId":…,"ok":false,"result":null,"error":"该场景未在此客户端加载"}`
   （`StageChannelClient.stageMismatchReason`）。

命令回执建议尽快发送（服务端侧执行超时为 30 秒）：

```swift
try await client.sendCommandResult(command.commandId, ok: true, result: ["accepted": true])
```

### 事件上报

`event.stageId` 必须等于当前激活的 Stage，否则服务端回 `event_rejected`（SDK 转成 `.error(.eventRejected)`）。
SDK 在未显式传 `stageId` 时使用 `activeStageId ?? primaryStageId`。

## 错误处理

`StageChannelError`（实现 `LocalizedError`）：

| case | 含义 | 建议处理 |
| --- | --- | --- |
| `.invalidState(operation:expected:actual:)` | 本地状态不合法 | 修正调用顺序 |
| `.invalidURL(String)` | URL/端口不合法 | 检查 Console 地址、路径、端口 |
| `.transport(String)` | 传输层错误 | 检查网络，退避重连 |
| `.httpStatus(code:body:)` | 发现接口非 2xx | 401 → 检查 API Key |
| `.decoding / .encoding` | JSON 编解码失败 | 记录日志；升级 SDK |
| `.handshakeTimeout(phase:)` | 30 秒握手超时 | 检查网关/服务端，重连 |
| `.requestTimeout(operation:)` | 单请求超时 | 重试或重新握手 |
| `.serverError(requestId:message:)` | 服务端 error 帧 | 展示 message |
| `.eventRejected(reason:)` | 事件被拒 | 检查 `event.stageId` |
| `.registrationRejected / .activationRejected` | 握手阶段被拒 | 检查 Stage 冲突 / 并发 |
| `.connectionClosed(code:reason:)` | 连接关闭 | `code == 4001` 时换 clientId |
| `.protocolViolation(String)` | 帧不符合协议 | 记录日志 |
| `.notConnected` | 未连接 | 先 `connect()` |

关闭码 4001 透出示例：

```swift
case .disconnected(let reason, let code):
    if code == StageChannelProtocol.replacedCloseCode { /* 4001：clientId 被新连接替换 */ }
```

`connect()` 失败时同时触发 `.error` + `.disconnected` 回调并抛出错误；断开后 `client.state == .disconnected`
（`await` 读取）。

## 测试

```sh
cd sdk/swift
swift test
```

无外网依赖，测试覆盖：

- `Tests/StageChannelSdkTests/FixturesTests.swift`
  - 读取 `../../../spec/fixtures/`（按 `#filePath` 定位）与 `manifest.json`
  - 每个 `server_to_client` 帧解析并断言关键字段
  - 每个 `client_to_server` 帧用类型化 API 构造，与 fixture JSON 语义等价（字段顺序无关）
  - 未知 `type` / 未知字段容忍、整数/浮点保真、坏帧报错
- `Tests/StageChannelSdkTests/GatewayDiscoveryTests.swift`
  - 用 `URLProtocol` stub 验证 `GET /api/assistants` 的 URL、Bearer / X-API-Key Header、401 处理、筛选规则
  - 网关/直连 URL 构造（http→ws、https→wss、api_key 编码、IPv6、端口校验）
- `Tests/StageChannelSdkTests/StageChannelClientTests.swift`
  - 注入 `MockStageTransport` 验证 hello → register → activate 全流程、user 跳过激活
  - 30s 握手超时（测试用 0.2s）、服务端 error、错误 channel、注册/激活被拒
  - command 路由（stageId 匹配/不匹配自动回 ok:false）、llm_event、event、transitionToEmpty
  - 4001 关闭码、主动 close、状态非法、未知帧容忍、坏帧不断连

查看真实输出中的通过数：`swift test` 结尾的 `Executed N tests, with 0 failures`。

## 目录结构

```text
sdk/swift/
├── Package.swift
├── Sources/StageChannelSdk/
│   ├── StageTypes.swift        # 共享类型 + 结果类型 + 回调事件
│   ├── StageMessage.swift      # 全部帧 + 未知 type 容忍
│   ├── StageCodec.swift        # 编解码
│   ├── JSONValue.swift         # 开放 JSON 值
│   ├── GatewayDiscovery.swift  # 发现 + URL/连接构造
│   ├── StageChannelClient.swift# actor 客户端 / 状态机
│   ├── StageChannelError.swift
│   ├── StageChannelAuth.swift
│   └── StageTransport.swift    # 传输抽象 + URLSessionWebSocketTask
├── Tests/StageChannelSdkTests/
└── README.md
```

## 已知限制

- 本仓库中 `glasses/RayNeoCustomApp` 参考 Swift 实现不存在（该目录未随仓库提供），本包完全依据
  `sdk/spec` 与服务端 `assistant/src/channel/stage-channel.ts` 实现。
- 回调采用 **delegate 闭包**（非 AsyncStream）；回调在后台执行器触发，需自行切主线程。
- 不自动重连、不自动恢复注册；`clientId` 由调用方负责在同一实例上保持稳定（重复 clientId 会触发 4001）。
- 默认传输层 `URLSession` 无法自定义入站缓冲大小；协议建议的 8 MiB 入站缓冲由系统处理，
  超大帧（> 系统上限）会以 `1009 / Message too big` 关闭，可由 `disconnected.code` 观察。
- 二进制帧会尝试按 UTF-8 解析为文本帧（宽松兼容），不符合协议时应由服务端修正。
- 单测不启动真实 WebSocket 服务端（`swift test` 完全无网络）；真实传输层依赖
  `URLSessionWebSocketTask`，已通过编译与接口层验证，真机联调请结合 Console / 助手实测。
