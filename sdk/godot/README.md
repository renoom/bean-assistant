# StageChannelSdk for Godot 4

Godot 4 / GDScript 版 StageChannel SDK。与 Swift / npm SDK 对齐，协议唯一源是
[`sdk/spec/protocol.md`](../spec/protocol.md) 与 [`sdk/spec/fixtures/`](../spec/fixtures/)；
服务端权威实现见 [`assistant/src/channel/stage-channel.ts`](../../assistant/src/channel/stage-channel.ts)。

```
sdk/godot/
├── project.godot                       # 最小 Godot 4 项目（headless 测试用）
├── addons/stage_channel_sdk/
│   ├── plugin.cfg                      # name="StageChannelSdk"
│   ├── plugin.gd                       # EditorPlugin 最小实现
│   ├── stage_channel_protocol.gd       # class_name StageChannelProtocol
│   ├── stage_channel_client.gd         # class_name StageChannelClient
│   ├── stage_channel_discovery.gd      # class_name StageChannelDiscovery
│   └── README.md                       # 完整 API / 用法 / 安装
├── tests/
│   ├── run_tests.gd                    # 无网络单测
│   ├── recording_client.gd             # 测试辅助（记录出站帧）
│   └── run_tests.tscn
└── README.md                           # 本文件
```

## 安装

把 `addons/stage_channel_sdk/` 复制到你的 Godot 4 项目的 `addons/` 目录即可：

```bash
cp -R sdk/godot/addons/stage_channel_sdk /path/to/your-project/addons/
```

三个脚本都带 `class_name`，不启用编辑器插件也能使用；`plugin.cfg` / `plugin.gd`
只是让编辑器「项目设置 → 插件」里能看到并启用它。详细 API 见
[addons/stage_channel_sdk/README.md](addons/stage_channel_sdk/README.md)。

> **关于 class_name**：Godot 的全局类名依赖编辑器生成的类缓存
> （`.godot/global_script_class_cache.cfg`）。用编辑器打开过一次的项目可以直接写
> `StageChannelClient`；全新的 headless 项目（从未用编辑器打开）请像上面的示例一样用
> `preload("res://addons/stage_channel_sdk/...")` 引用。SDK 内部全部使用 preload，
> 因此拷贝 addon 后无需额外配置。

## 两条连接路径

| 模式 | 地址 | 用法 |
| --- | --- | --- |
| **网关模式（推荐）** | `wss://<console>/a/{sessionId}/ws?api_key=<key>` | 先 `StageChannelDiscovery.discover()`，再用 `gateway_ws_url()` + `open_gateway()` |
| **直连模式** | `ws://<assistantHost>:<stagePort>/ws` | `open_direct()`（或 demo 兼容的 `open()`） |

网关模式下客户端只使用发现结果的 `gatewayWsPath` / `gatewayBase`，**不得**使用
`channelEndpoints` 里的内部 host/port。

## 最小示例

```gdscript
extends Node

const StageChannelClient := preload("res://addons/stage_channel_sdk/stage_channel_client.gd")

var client

func _ready() -> void:
    client = StageChannelClient.new()
    add_child(client)
    client.connected.connect(func(): print("ready"))
    client.disconnected.connect(func(reason): print("closed: ", reason))
    client.command_received.connect(func(command):
        client.send_result(command.commandId, true, {"accepted": true})
    )
    client.llm_event_received.connect(func(event): print(event))
    client.open_direct(
        "127.0.0.1", 41232, "godot-client-1",
        [{"name": "say"}], "assistant", "assistant-1", "编码助手", "",
        "town:meadow", "town", {"text": "萤火镇"},
    )

func _process(_delta: float) -> void:
    client.poll()   # 必须每帧调用
```

## 协议行为

- 握手：`hello` → `hello_ack` → `stage_register` → `stage_activate`；
  `role="user"` 注册成功后跳过激活，直接 `connected`。
- 握手超时 30 秒；超时 / 注册被拒 / 激活被拒 / 握手期 `error` 都会以
  `disconnected(reason)` 报告。
- 入站缓冲 8 MiB、出站 1 MiB、排队包上限 4096（协议 §5）。
- `command.stageId` 不属于本客户端注册的 Stage 时自动回 `command_result{ok:false}`。
- 未知 `type` / 未知字段全部容忍；服务端 `4001`（clientId 被新连接替换）的关闭原因
  会出现在 `disconnected(reason)` 里，也可读 `last_close_code` / `last_close_reason`。
- demo 兼容：保留 `open(host, port, client_id, commands, role, assistant_id, display_name,
  sprite_path, stage_id, stage_kind, environment, ws_path, use_tls)` 签名与
  `connected` / `disconnected(reason)` / `command_received(command)` /
  `llm_event_received(event)` 信号。

## 测试

无网络 headless 单测，覆盖 fixtures 一致性、帧构造 / 校验、未知字段容忍、
握手 / 激活 / 命令路由状态机、4001 关闭原因、握手超时、发现 URL 与 online+stage 过滤。

```bash
cd <repo-root>
"$HOME/Library/Application Support/Steam/steamapps/common/Godot Engine/Godot.app/Contents/MacOS/Godot" \
    --headless --path sdk/godot res://tests/run_tests.tscn
```

输出末行示例：

```
════ 215 passed / 0 failed ════
```

退出码 `0` 表示全部通过。fixtures 在项目目录外，测试默认拼接
`<ProjectSettings.globalize_path("res://")>/../spec/fixtures`；也可显式指定：

```bash
STAGE_CHANNEL_FIXTURES=/abs/path/to/sdk/spec/fixtures \
  godot --headless --path sdk/godot res://tests/run_tests.tscn
```

测试通过数会随断言增减，以实际输出为准。

除单测外，还用本地临时 ws 服务器做过一次手工端到端验证（不入测试命令）：
`hello → hello_ack → stage_register → stage_activate → command → llm_event → 4001 close`，
客户端正确派发 command / llm_event，并在 `disconnected(reason)` 中透出
`code=4001, reason=clientId replaced by a new connection`。

## 已知限制

- 不自动重连；断线后由调用方重新 `open_*()`（重连必须重新 hello → 注册 → 激活）。
- 需要宿主每帧调用 `poll()`；SDK 不接管 `_process`。
- 一个 `StageChannelClient` 实例对应一条连接 / 一个 `clientId`。
- 发现只实现 `GET /api/assistants`，不含 spawn 等管理 API。
- `open_direct` 的 `api_key` 只为兼容旧 demo 的 `?api_key=`；直连模式服务端不校验。
- 若项目里同时存在旧 demo 的同名 `StageChannelClient`（`class_name` 冲突），只能保留一套。
