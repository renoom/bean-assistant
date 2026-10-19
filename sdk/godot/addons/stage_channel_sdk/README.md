# StageChannelSdk（Godot 4 addon）

Godot 4 的 StageChannel 客户端 SDK：WebSocket 协议编解码、网关 / 直连两种连接方式、
Console 发现、命令回执与 LLM 事件流。

协议唯一源是仓库内的 [`sdk/spec/protocol.md`](../../spec/protocol.md) 与
[`sdk/spec/fixtures/`](../../spec/fixtures/)，本 addon 与 Swift / npm SDK 行为一致。

## 安装

把整个 `addons/stage_channel_sdk/` 目录复制到你的 Godot 4 项目的 `addons/` 下：

```
your-godot-project/
└── addons/
    └── stage_channel_sdk/
        ├── plugin.cfg
        ├── plugin.gd
        ├── stage_channel_protocol.gd
        ├── stage_channel_client.gd
        └── stage_channel_discovery.gd
```

三个脚本用 `class_name` 暴露全局类，**不需要在 Project Settings 里启用插件**也能使用：

- `StageChannelProtocol`
- `StageChannelClient`（`extends Node`）
- `StageChannelDiscovery`（`extends Node`）

> **class_name 与类缓存**：Godot 的全局类名依赖编辑器生成的
> `.godot/global_script_class_cache.cfg`。用编辑器打开过一次的项目可以直接写
> `StageChannelClient.new()`；全新的 headless 项目（从未用编辑器打开）请改用
> `preload("res://addons/stage_channel_sdk/stage_channel_client.gd")`。
> 本 README 的示例都用 preload，两种环境都能跑；SDK 内部也全部使用 preload。
>
> addon 内部用 `res://addons/stage_channel_sdk/...` 做 preload，因此请保持目录名不变。
> 如果你在同一个项目里还留有旧 demo 的 `StageChannelClient`（`class_name` 同名），
> 两者只能保留一套。

## 快速开始：网关模式（推荐）

```gdscript
extends Node

const StageChannelClient := preload("res://addons/stage_channel_sdk/stage_channel_client.gd")
const StageChannelDiscovery := preload("res://addons/stage_channel_sdk/stage_channel_discovery.gd")

var _client


func _ready() -> void:
    # 1) 发现：GET {console}/api/assistants，过滤 online + stage
    var discovery = StageChannelDiscovery.new()
    add_child(discovery)
    discovery.listed.connect(_on_listed)
    discovery.failed.connect(func(reason): push_error(reason))
    discovery.discover("http://127.0.0.1:3000", "platform-api-key")


func _on_listed(assistants: Array) -> void:
    if assistants.is_empty():
        return
    var info: Dictionary = assistants[0]
    # 2) 网关只使用发现结果的 gatewayWsPath，绝不使用 channelEndpoints 的内部 host/port
    var url := StageChannelDiscovery.gateway_ws_url(
        "http://127.0.0.1:3000",
        StageChannelDiscovery.gateway_ws_path(info),
        "platform-api-key",
    )
    # 3) 连接
    _client = StageChannelClient.new()
    add_child(_client)
    _client.connected.connect(func(): print("stage ready"))
    _client.disconnected.connect(func(reason): print("disconnected: ", reason))
    _client.command_received.connect(_on_command)
    _client.llm_event_received.connect(func(event): print("llm event: ", event))
    _client.open_gateway(
        url,
        "godot-client-1",                                   # clientId：实例唯一、跨重连保持稳定
        [{"name": "say", "description": "在场景中说话"}],    # CommandSpec[]
        "assistant",                                        # role: assistant | user
        "assistant-1", "编码助手", "",
        "town:meadow", "town", {"text": "萤火镇"},
    )


func _process(_delta: float) -> void:
    if _client != null:
        _client.poll()          # WebSocketPeer 必须每帧轮询


func _on_command(command: Dictionary) -> void:
    print(command.command, command.args)
    _client.send_result(command.commandId, true, {"accepted": true})
```

## 快速开始：直连模式（本地 / 无 Console）

```gdscript
client.open_direct(
    "127.0.0.1", 41232,          # assistant Stage host / port
    "godot-client-1",
    [{"name": "say"}],
    "assistant", "assistant-1", "编码助手", "",
    "town:meadow", "town", {"text": "萤火镇"},
    "/ws",                       # ws_path
    false,                       # use_tls
)
```

demo 兼容的 `open(host, port, client_id, commands, role, assistant_id, display_name,
sprite_path, stage_id, stage_kind, environment, ws_path, use_tls)` 与
`open_direct` 等价，可直接替换 demo 里的旧客户端。

## 状态机

```
CONNECTING → HELLO_SENT → ACKED → REGISTERED → ACTIVE
```

1. WebSocket open 后发送 `hello`（`channel="stage"`、`clientId`、`role`、`assistantId`/`name`/`spritePath`）；
2. 收到 `hello_ack` → 发送 `stage_register`（`requestId="initial-register"`）；
3. 注册成功（`registered` / `updated` / `unchanged`）→ 发送 `stage_activate`
   （`requestId="initial-activate"`）；`role="user"` 跳过这一步；
4. 激活成功（`changed` / `unchanged`）→ 发出 `connected` 信号。

- 握手超时 **30 秒**（`HANDSHAKE_TIMEOUT_MSEC`），超时发出 `disconnected("... timed out ...")` 并关闭连接；
- 注册 / 激活被拒或握手期收到 `error` 帧同样走 `disconnected(reason)`；
- 服务端关闭时 `disconnected(reason)` 会带上关闭码与原因（例如 `code=4001, reason=clientId replaced by a new connection`），
  同时可通过 `last_close_code` / `last_close_reason` 读取。

## 信号

| 信号 | 说明 |
| --- | --- |
| `connected()` | 握手完成、Stage 已激活（role=user 时注册完成即可）。 |
| `disconnected(reason: String)` | 握手失败或连接关闭；包含关闭码与原因。 |
| `command_received(command: Dictionary)` | `{commandId, command, args}`；`stageId` 不属于本客户端注册的 Stage 时自动回 `ok=false`，不会派发。 |
| `llm_event_received(event: Dictionary)` | 原始 LLM / 场景事件流。 |
| `register_result(result: Dictionary)` | `stage_register_result.result`（主动注册时也发）。 |
| `activate_result(result: Dictionary)` | `stage_activate_result.result` / `stage_transition_result.result`。 |
| `error_received(message: Dictionary)` | 连接就绪后服务端发来的 `error` 帧。 |
| `event_rejected(reason: String)` | 服务端拒绝本客户端的 `event`。 |

## 方法

| 方法 | 说明 |
| --- | --- |
| `poll()` | **必须每帧调用**，驱动 WebSocketPeer 与握手超时。 |
| `close()` | 关闭连接。 |
| `send_result(command_id, ok, result, error="")` | 回执 `command_result`。 |
| `send_event(event: Dictionary)` | 上报场景事件（`stageId` 取当前激活 Stage）。 |
| `register_stage(stage_id="", stage_kind="", environment={}, commands=[], request_id="")` | 主动注册 / 更新 Stage。 |
| `activate_stage(stage_id="", mode="", expected_stage_id="", expected_revision=-1, request_id="")` | 激活 Stage；省略参数时使用构造时的配置。 |
| `transition_to_empty(stage_id="", mode="", expected_stage_id="", expected_revision=-1, request_id="")` | `stage_transition(target="empty")`。 |
| `open` / `open_direct` / `open_gateway` / `open_url` | 打开连接（见上）。 |
| `is_ready()` / `get_phase()` / `get_url()` / `get_client_id()` / `get_stage_snapshot()` / `get_active_stage_id()` / `get_registered_stage_ids()` | 只读访问。 |

## 传输参数（协议 §5）

- 入站缓冲 `INBOUND_BUFFER_BYTES = 8 MiB`（默认 64 KiB 会截断大 `llm_event`）；
- 出站缓冲 `OUTBOUND_BUFFER_BYTES = 1 MiB`；
- 排队包上限 `MAX_QUEUED_PACKETS = 4096`；
- 文本帧、UTF-8 JSON、一条帧一个完整消息。

## Discovery

```gdscript
var discovery = StageChannelDiscovery.new()
add_child(discovery)                       # HTTPRequest 必须在场景树里
discovery.listed.connect(func(items): ...) # 已过滤 status=="online" 且支持 stage
discovery.failed.connect(func(reason): ...)
discovery.discover("https://console.example.com", api_key)
```

`supports_stage()` 规则：有 `channelEndpoints` 元数据时以元数据为准（存在 `id="stage"`、
`protocol="ws"`、`port>0` 的端点）；否则要求 `channels` 包含 `"stage"`。
`channelEndpoints` 只用于直连开发模式。

静态地址工具：

- `gateway_ws_url(base, ws_path, api_key="")`：`http→ws`、`https→wss`，保留 Console 的
  反向代理路径前缀，`api_key` 做 URL 编码后作为 `?api_key=`。
- `direct_ws_url(host, port, path="/ws", use_tls=false, api_key="")`：IPv6 自动加方括号。
- `gateway_ws_path(info)`：优先 `gatewayWsPath`，回退 `gatewayBase + "/ws"`。
- `assistants_url(base)`：`{base}/api/assistants`。
- `online_stage_assistants(list)` / `supports_stage(info)` / `stage_endpoint(info)`。

## Protocol 工具

`StageChannelProtocol` 是纯函数工具类（`extends RefCounted`）：

- 常量：所有帧 `TYPE_*`、`CHANNEL`、`ROLE_*`、`MODE_*`、`REGISTER_OK_KINDS`、`TRANSITION_OK_KINDS`；
- `decode(text)` / `decode_bytes(bytes)` / `encode(frame)`；
- 帧构造：`hello`、`stage_register`、`stage_unregister`、`stage_activate`、`stage_transition`、
  `transition_to_empty`、`event_frame`、`command_result_frame`；
- 读取：`frame_type`、`command_payload`、`llm_event_payload`、`stage_snapshot`、`result_object`、
  `rejected_reason`；
- 校验：`validate_server_frame` / `validate_client_frame`（未知 type 视为通过）；
- `equivalent(a, b)`：字段顺序无关、int/float 等价的深比较（fixtures 一致性测试用）。

## 测试

本仓库 `sdk/godot` 自带无网络 headless 单测（fixtures 一致性 + 状态机 + URL/过滤）：

```bash
cd <repo-root>
"$HOME/Library/Application Support/Steam/steamapps/common/Godot Engine/Godot.app/Contents/MacOS/Godot" \
    --headless --path sdk/godot res://tests/run_tests.tscn
```

fixtures 在项目目录外，默认按 `<res://>/../spec/fixtures` 查找；也可覆盖：

```bash
STAGE_CHANNEL_FIXTURES=/abs/path/to/sdk/spec/fixtures godot --headless --path sdk/godot res://tests/run_tests.tscn
```

全部通过时退出码为 `0`，末行打印 `N passed / 0 failed`。
（测试里有一条故意传入非法 JSON 的用例，Godot 会向 stderr 打一条 `Parse JSON failed`，
这是预期噪声，不会导致失败。）

## 已知限制

- 不自动重连：断线后需要调用方重新 `open_*()`（协议要求重连后重新 hello → 注册 → 激活）。
- `poll()` 需要调用方每帧驱动；addon 不注册 `_process` 自动轮询，避免和宿主的调度冲突。
- 只支持一条 WebSocket 连接 / 一个客户端实例；多助手请创建多个 `StageChannelClient`。
- 发现接口只做 `GET /api/assistants`，不含 spawn / 管理 API。
- `open_direct` 的 `api_key` 仅用于兼容旧 demo 的 `?api_key=`，直连模式服务端不校验。
- 主动 `register_stage()` / `activate_stage()` 的请求是“即发即忘”，异步结果通过
  `register_result` / `activate_result` 信号给出。
