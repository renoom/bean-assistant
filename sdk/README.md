# StageChannelSdk

Stage 接入层的统一实现：**一份协议契约 + 三个语言 SDK**。Godot、Swift（雷鸟 iO 眼镜）、TypeScript/JavaScript 客户端共用同一套发现、鉴权、握手、注册、激活、事件与命令语义。

```
sdk/
├── spec/     # 唯一协议源：protocol.md + fixtures/（一致性测试数据）
├── godot/    # Godot 4 addon：StageChannelSdk
├── swift/    # Swift Package：StageChannelSdk（iOS 16+ / macOS 13+）
└── npm/      # npm 包：stage-channel-sdk（浏览器 + Node 22+）
```

## 为什么是三个 SDK

npm 包无法被 GDScript 和 Swift 在运行时直接 import，所以共享的是**协议契约与一致性测试**，而不是同一份可执行代码：

- `sdk/spec/protocol.md` 定义所有帧、字段、状态机与错误码；
- `sdk/spec/fixtures/` 提供 golden 帧，三个 SDK 的测试都必须解析/构造它们；
- 服务端权威实现是 `assistant/src/channel/stage-channel.ts`。

改协议的顺序固定：**spec → 服务端 → 三个 SDK**。

## 快速开始

### Godot 4

```bash
cp -R sdk/godot/addons/stage_channel_sdk <你的项目>/addons/
```

```gdscript
var client := StageChannelClient.new()
add_child(client)
client.connected.connect(func(): print("stage ready"))
client.command_received.connect(func(cmd): client.send_result(cmd.commandId, true, {"accepted": true}))
client.open_gateway(gateway_url, gateway_ws_path, api_key, "godot-1", stage_definition)
```

详见 [sdk/godot/README.md](godot/README.md)。

### Swift

```swift
// Package.swift
.package(path: "../bean-assistant/sdk/swift")
```

```swift
import StageChannelSdk

let assistants = try await GatewayDiscovery.fetchAssistants(baseURL: consoleURL, apiKey: key)
let client = StageChannelClient(options: .init(
    clientId: "glasses-1",
    stage: .init(id: "glasses:default", kind: "glasses", environment: .init(text: "雷鸟 iO")),
    connection: .gateway(baseURL: consoleURL, wsPath: assistants[0].gatewayWsPath, apiKey: key)
))
try await client.connect()
```

详见 [sdk/swift/README.md](swift/README.md)。

### npm / TypeScript

```bash
npm i stage-channel-sdk
```

```ts
import { fetchAssistants, StageChannelClient, buildGatewayWsUrl } from 'stage-channel-sdk'

const assistants = await fetchAssistants({ baseUrl, apiKey })
const client = new StageChannelClient({
  clientId: 'web-1',
  stage: { id: 'web:main', kind: 'web', environment: { text: '浏览器' } },
  connection: { gatewayWsUrl: buildGatewayWsUrl(baseUrl, assistants[0].gatewayWsPath, apiKey) },
})
client.on('connected', () => console.log('stage ready'))
client.on('command', (cmd) => client.sendCommandResult(cmd.commandId, true, { accepted: true }))
await client.connect()
```

详见 [sdk/npm/README.md](npm/README.md)。

## 协议速览

```
发现 GET /api/assistants ──► gatewayBase / gatewayWsPath / channelEndpoints
连接 ws(s)://.../ws（网关带 api_key）──► hello
   ◄── hello_ack
stage_register ──► stage_register_result
stage_activate ──► stage_activate_result（role=user 可跳过）
   ◄── command / llm_event / event_rejected / error
   ──► command_result / event
```

- 网关模式：`wss://<console>/a/{sessionId}/ws?api_key=<key>`，客户端不使用助手内部 host/port。
- 直连模式：`ws://<assistantHost>:<stagePort>/ws`，适用于本地开发或无 Console 部署。
- 握手超时 30s；重复 `clientId` 旧连接以 `4001` 关闭；`command` 的 `stageId` 不属于本客户端时回 `ok:false`。
- `llm_event` 可能携带完整模型上下文，WebSocket 入站缓冲建议 ≥ 8 MiB。

完整契约：[spec/protocol.md](spec/protocol.md)。

## 一致性测试

```bash
# Swift
cd sdk/swift && swift test

# Godot（headless）
"$GODOT" --headless --path sdk/godot res://tests/run_tests.tscn

# npm
cd sdk/npm && node --experimental-strip-types --test test/*.test.ts
```

三者都必须覆盖 `sdk/spec/fixtures/` 的全部 golden 帧（见 `fixtures/manifest.json`）。

## 发布

| 语言 | 分发 | 命令 |
| --- | --- | --- |
| npm | npm registry | `cd sdk/npm && npm run build && npm publish` |
| Godot | addon 目录拷贝 / Asset Library | 打包 `sdk/godot/addons/stage_channel_sdk` |
| Swift | Swift Package（git tag） | `git tag stage-channel-sdk-v1.0.0` 后由客户端按 tag 引用 |

版本号独立于服务端内核；协议不兼容变更必须同时升三个 SDK 的 major。

## 目录状态

| 目录 | 状态 |
| --- | --- |
| `spec/` | 协议 v1 + 12 个 golden fixtures |
| `godot/` | Godot 4 addon + 215 项 headless 单测 |
| `swift/` | SwiftPM 包 + 48 项单测（iOS 16+ / macOS 13+） |
| `npm/` | TypeScript 包 + 40 项 node:test 单测（浏览器 / Node 22+） |
