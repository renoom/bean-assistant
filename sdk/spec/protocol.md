# StageChannel 协议契约（v1）

> 这是 **Godot SDK / Swift SDK 共用的唯一协议源**。两个 SDK 的实现和测试都以此为准；
> 协议变更必须先改本文件与 `fixtures/`，再改两端 SDK，最后由 `assistant/src/channel/stage-channel.ts` 的服务端行为验证。

## 1. 两条连接路径

| 模式 | 地址 | 鉴权 | 适用 |
| --- | --- | --- | --- |
| **网关模式（推荐）** | `wss://<console>/a/{sessionId}/ws?api_key=<key>` | 网关校验平台 API Key（`Authorization: Bearer` 或 `?api_key=`） | 公网 / 多助手部署 |
| **直连模式** | `ws://<assistantHost>:<stagePort>/ws` | StageChannel 本身不校验 Key | 本地开发 / 无 Console 的独立部署 |

网关模式下客户端**不得**使用 `channelEndpoints` 里的内部 host/port；只使用发现接口返回的 `gatewayBase` / `gatewayWsPath`。

## 2. 发现（Console HTTP API）

```
GET /api/assistants
Authorization: Bearer <platformKey>      （或 X-API-Key）
```

返回一个数组，每项至少包含：

```json
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
}
```

客户端选择规则：`status === "online"` 且 `channels` 包含 `"stage"`；优先使用 `gatewayWsPath`。`channelEndpoints` 仅用于直连开发模式。

## 3. 帧格式

所有帧都是 JSON 对象，必须包含 `type`。未知 `type` 必须被忽略（向前兼容），未知字段必须被忽略。

### 3.1 客户端 → 服务端

| type | 字段 |
| --- | --- |
| `hello` | `channel: "stage"`、`clientId`（必填、实例唯一）、`role?: "assistant" \| "user"`、`assistantId?`、`name?`、`clientType?`、`stageId?` / `stageKind?` / `environment?` / `commands?`（旧版兼容字段）、`activateStage?: boolean` |
| `stage_register` | `requestId?`、`stage: { id, kind, environment?: {text}, commands?: CommandSpec[] }` |
| `stage_unregister` | `requestId?`、`stageId` |
| `stage_activate` | `requestId?`、`stageId`、`mode?: "after-turn" \| "interrupt"`、`expectedStageId?`、`expectedRevision?` |
| `stage_transition` | 同 `stage_activate`，另加 `target?: "empty"`（回到默认环境） |
| `event` | `stageId?`、`event: { kind: string, ...payload }` |
| `command_result` | `commandId`、`ok: boolean`、`result: any`、`error?: string` |
| `chat` / `message`（可选） | `requestId?`、`text`、`images?` |

`clientId` 规则：同一客户端实例跨重连保持不变；不同实例必须不同。服务端收到重复 `clientId` 时关闭旧连接（关闭码 **4001**，reason `clientId replaced by a new connection`）。

### 3.2 服务端 → 客户端

| type | 字段 |
| --- | --- |
| `hello_ack` | `channel: "stage"`、`clientId`、`bridgeId?`、`registrations: Registration[]`、`stage: StageSnapshot`、`transition?: TransitionResult` |
| `stage_register_result` | `requestId?`、`result: {kind: "registered" \| "updated" \| "unchanged" \| "rejected", registration?, reason?}`、`stage` |
| `stage_unregister_result` | `requestId?`、`removed: boolean`、`stage` |
| `stage_activate_result` / `stage_transition_result` | `requestId?`、`result: TransitionResult` |
| `command` | `commandId`、`bridgeId`、`stageId`、`command`、`args` |
| `llm_event` | `event`：原始 SessionEvent 或可读事件（`chunk` / `assistant_message` / `tool_call` / `tool_result` / `scene_event` / `system_event` / `model_input` …） |
| `event_rejected` | `reason` |
| `error` | `requestId?`、`error` |
| `chat_result`（可选） | `requestId?`、`accepted`、`turn?`、`error?` |

### 3.3 共享类型

```ts
type StageSnapshot = {
  id: string
  kind: "empty" | string
  revision: number
  status: "empty" | "active" | "suspended"
  participants: { id: string; role: "assistant" | "user" | "client"; name?: string; online: boolean }[]
  capabilities: CommandSpec[]
  environment?: { text: string }
}

type CommandSpec = {
  name: string
  description?: string
  parameters?: JSONSchemaLike
  returns?: string
  example?: Record<string, unknown>
}

type Registration = {
  id: string
  stageId: string
  stageKind: string
  environment: { text: string }
  capabilities: CommandSpec[]
}

type TransitionResult =
  | { kind: "changed" | "unchanged"; stage: StageSnapshot }
  | { kind: "rejected"; reason: string; stage?: StageSnapshot }

type RegisterResult = { kind: "registered" | "updated" | "unchanged"; registration: Registration } | { kind: "rejected"; reason: string }
```

## 4. 状态机

```
DISCONNECTED
  └─ connect() → CONNECTING
       └─ socket open → HELLO_SENT（发送 hello）
            ├─ hello_ack → ACKED
            │    └─ stage_register → REGISTERED
            │         └─ stage_activate → ACTIVE（role=user 可跳过激活）
            └─ error / 30s 超时 → DISCONNECTED（handshake failed）
ACTIVE
  ├─ command → 执行 → command_result
  ├─ event（仅当前 Stage 会被接受）
  ├─ llm_event（持续）
  └─ socket closed → DISCONNECTED（服务端 Stage 进入 suspended）
```

- 握手超时：**30 秒**。
- 命令执行超时（服务端侧）：**30 秒**；客户端应尽快回执。
- 断线后重连：新连接重新 `hello` → 注册 → 激活；注册不自动恢复。
- `event` 的 `stageId` 必须等于当前激活的 Stage，否则服务端回 `event_rejected`。
- `command` 的 `stageId` 不是本客户端注册的 Stage 时，客户端应回 `ok:false` 并说明原因。

## 5. 传输要求

- WebSocket 文本帧，UTF-8 JSON；一条帧一个完整消息，不做分片协议。
- 入站缓冲建议 **≥ 8 MiB**（`llm_event` 可能携带完整模型上下文；默认 64 KiB 会断）。
- 出站缓冲建议 ≥ 1 MiB；排队包上限 ≥ 4096。
- 客户端每帧调用 `poll()`（Godot `WebSocketPeer` 需要轮询）。

## 6. Fixtures（一致性测试）

`fixtures/manifest.json` 列出全部样例帧及方向；两个 SDK 的测试必须：

1. 解析每个 `server_to_client` 帧，断言 `type` 与关键字段；
2. 构造每个 `client_to_server` 帧，断言 JSON 与样例等价（字段顺序无关）；
3. 对未知 `type` / 未知字段保持容忍。

## 7. 变更流程

1. 改本文件 + `fixtures/`；
2. 改 `assistant/src/channel/stage-channel.ts`（服务端权威实现）；
3. 改 `sdk/godot` 与 `sdk/swift`；
4. 两边测试通过 + 服务端协议测试通过后发布新版本。
