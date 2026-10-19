# Stage 客户端与接入约定

Bean Assistant 的 Stage 协议目前有 **两个正式客户端**：Godot 场景客户端与雷鸟 iO 眼镜客户端。两者共用同一套发现、鉴权、握手、注册、激活与事件/命令语义。

## 客户端一览

| 客户端 | 位置 | 形态 | 技术栈 | 连接方式 | 自带验证 |
| --- | --- | --- | --- | --- | --- |
| Godot 场景客户端「萤火镇」 | [`assistant-godot/`](../assistant-godot/) | 桌面 / 游戏客户端 | Godot 4 · GDScript | Console 网关 `/a/{sessionId}/ws` | `./run.sh test` + `tests/*_smoke.mjs` |
| 雷鸟 iO 眼镜客户端 | 同级独立工程 `glasses/RayNeoCustomApp` | iPhone App（BLE 驱动眼镜显示/收音） | SwiftUI · RayNeoKit · `RayneoNet.framework` | Console 网关；独立部署可手动 WS | Swift 单测 + `scripts/verify-*` |

> 雷鸟 iO 眼镜客户端不在本仓库内，是同级目录的独立 Xcode 工程。App 只负责采集、显示与场景声明；模型、记忆、工具都在助手侧，因此客户端不依赖 dsh 内核。

## 统一连接契约

1. **发现**：客户端请求 Console 的 `GET /api/assistants`（`Authorization: Bearer <平台 Key>` 或 `X-API-Key`），拿到 `gatewayBase`、`gatewayWsPath`、`channels` 与 `channelEndpoints`。
2. **连接**：连接 `ws(s)://<console>/a/{sessionId}/ws?api_key=...`（公网必须 WSS）；Console 网关校验 Key 后，把 Upgrade 代理到助手内网 StageChannel 的 `/ws`。
3. **握手**：`hello`（`clientId` 跨重连保持稳定）→ `hello_ack`，其中 `channel` 必须是 `stage`。
4. **注册**：`stage_register`，可一次注册多个 Stage，声明 `id` / `kind` / `environment` / `commands` / `capabilities`；注册只表示"声明能力"，不改变当前 Stage。
5. **激活**：`stage_activate` / `stage_transition`，支持 `after-turn` / `interrupt` 与 `expectedStageId` / `expectedRevision` 乐观并发。
6. **事件与命令**：客户端用 `event` 上报 `user_said` 与场景事件；助手下发 `command`，客户端回 `command_result`；模型与显示事件通过 `llm_event` / readable `scene_event` 送达。
7. **断线恢复**：连接失效后 Stage 进入 `suspended`；重连后重新 `hello` → 注册 → 激活。

**地址来源**：公网部署下客户端只使用发现结果里的网关路径，绝不使用 `channelEndpoints` 中的内部 host/port；独立部署（无 Console）时可用手动 WS 直连助手 Stage 端口，协议与状态机完全一致。

## Godot 场景客户端

- 位置：[`assistant-godot/`](../assistant-godot/)，Game 场景 + Stage 协议适配。
- 负责 Stage 注册与激活、Bridge 命令执行、场景事件上报、SSE 聊天输出渲染。
- 验证：`./run.sh test`（headless 单测）+ `tests/protocol_smoke.mjs` / `ws_lifecycle_smoke.mjs` / `console_discovery_smoke.mjs`。

## 雷鸟 iO 眼镜客户端

- 位置：同级独立工程 `glasses/RayNeoCustomApp`（iOS）。
- 连接：App 通过厂商 `RayneoNet.framework` 走 BLE 与眼镜通信；`RayNeoKit` 封装 Wire / Business / Capability / Session；`LoopbackTransport` 支持无真机模拟。
- 与助手：经 Console 网关接入，使用同一套 Stage 协议，注册两个 Stage：
  - `glasses:default`（kind `glasses`）：常驻 Stage，能力含 `notify` 等；
  - `glasses:voice`（kind `glasses`）：语音对话 Stage，能力含 `show`；
  - `show` 与 `notify` 按 Stage 互斥，避免助手选择不一致；写操作受「允许助手操作 App」开关约束。
- 语音链路：眼镜麦克风 → iPhone Opus 解码 → MiniMax 云端 / Apple 离线识别 → 助手（`user_said`）→ `show` 回到镜片。
- 构建与验收：`scripts/build-sideload-ipa.sh` 产出未签名 IPA；`RayNeoKit` / `App` 有独立 Swift 单测，另有 `scripts/verify-*` 轻量验证；真机验收步骤见该工程 README 与 `docs/`。

## 与内核升级的关系

客户端只依赖 HTTP / WebSocket 协议，不 import dsh 内核。因此：

- 内核升级的自动化回归范围仍然是 **console + assistant**（[automation/](../automation/)）；
- 只有**协议契约**变化时才需要回归客户端，例如通道名（`ai-town` → `stage`）、`hello_ack.channel`、`command_result` 结构、`channelEndpoints` 字段；
- 客户端各自的单测（Godot headless、Swift）由各工程自己维护，不在本仓库的 `automation/verify.mjs` 链路内。

## 已知文档漂移

- 雷鸟客户端 `App/README.md` 「网关地址与 API Key」一节仍写「选择开放 `ai-town` 通道的助手」，但当前代码已使用 `stage` 通道（`AssistantProtocol.stageChannelName = "stage"`）。
- 该工程 `docs/06-助手Stage架构完整改造方案.md` 状态行仍写「尚未执行」，实际 `AssistantProtocol` / `AssistantBridge` 已落地 Stage 接入。
