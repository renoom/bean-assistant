# assistant-godot

Godot 4.7 的场景客户端。客户端先选择 Stage，再在 Stage 内邀请一个或多个助手；Stage 与助手会话没有绑定关系。

## 生命周期

```text
启动客户端
  → 选择 Stage
  → 渲染场景与互动热点
  → 从 Console 选择在线助手
  → 为该助手建立 StageChannel / StageBridge
  → 助手调用 draw_image 生成自己的 NPC 形象
  → 助手先调用 draw_sprite_animation，再调用 stage_action.enter_stage
  → NPC 正式进入场景并可以移动、互动、说话
```

Bridge 连接成功只表示助手已经获得当前 Stage 的环境信息和工具。首次 `enter_stage` 成功之前，助手没有可见 NPC，也不能调用场景中的说话、移动或互动能力。NPC 形象按 `stageId + assistantId` 的语义保存在该 Stage 存档里，重连时可以恢复。

## 内置 Stage

### AI 萤火镇

原创的俯视角像素小镇，包含八个可互动地点：

- 暖阳咖啡馆
- 社区公告栏
- 星光喷泉
- 齿轮工坊
- 共享温室
- 社区菜园
- 微光图书馆
- 河畔木桥

小镇向助手提供这些 Stage 命令：

- `enter_stage`：提交助手自己生成的 `animation.json` 并以四方向序列帧 NPC 入场
- `get_stage_state`：读取地点和在场 NPC
- `move_npc`：移动自己的 NPC，支持直接前往某个地点
- `interact_at`：在地点执行行为，并通知其他在场 NPC
- `change_npc_appearance`：重新生成并替换自己的序列帧形象
- `leave_stage`：NPC 离开场景，助手会话保持连接
- `say` / `say_to`：公开或定向说话

Stage 不向助手开放创建、切换或覆盖场景的命令。背景、地点与能力都由 Stage 自身定义。

### 空白舞台

只提供 NPC 入场、移动、换装和说话能力，用于验证新角色或开发新的 Stage。

## 运行

```sh
cd assistant-godot
./run.sh test   # 无网络测试
./run.sh        # 打开 Stage 选择页
```

进入场景后：

- `F4`：查询 Console 并邀请在线助手
- `F5`：打开连接设置，修改 Console 地址和 API Key
- `F3`：显示完整调试事件
- `F2`：返回 Stage 选择页
- `Enter`：发送消息
- `Tab`：切换说话目标

Console 默认地址是 `http://127.0.0.1:3000`。当前 Console 同时承担网关：客户端只需要配置 Console 地址和 `api_key`，助手 host/port 由 Console 自动解析。Godot 通过 StageChannel 的 `/ws` 端点连接；Console 返回 `/a/{id}/ws` 网关路径。

首次使用或连接不上 Console 时，在 Stage 选择页底部点击「连接设置」。填入 Console 地址，并从 Console 复制平台 API Key；Key 输入框默认隐藏，可临时切换显示。保存后写入 `user://config.json`，下次启动会自动回填。清空 Key 并保存即可删除旧 Key。客户端不会读取平台的 Key 文件，也不会自动轮换 Key 或启动模型。

进入场景后，输入栏旁也有「连接设置」，邀请助手弹窗中可以刷新列表。请求返回 HTTP 401 时会自动打开设置窗口；保存后自动重新查询。没有在线助手、在线助手未启用 StageChannel、以及助手已全部加入场景，会分别显示对应原因。

地址必须以 `http://` 或 `https://` 开头，支持 `localhost`、域名、IPv4、方括号 IPv6 和端口，例如 `http://localhost:3000`、`https://console.example.com` 或 `http://[::1]:3000`。也可以手动编辑 `user://config.json` 或使用 `-- --api-key=ask_xxx`；网关会统一校验。

## 目录

| 路径 | 内容 |
|---|---|
| `core/stage/stage_catalog.gd` | Stage 定义、预制地点和场景工具声明 |
| `core/stage/stage.gd` | 场景状态、NPC、互动热点和渲染 |
| `core/stage/stage_store.gd` | 按 `stageId` 保存场景状态 |
| `core/transport/stage_channel.gd` | Godot StageChannel 协议客户端 |
| `core/scene/vn_client_manager.gd` | 多助手 StageBridge 路由 |
| `scenes/picker.gd` | Stage 选择页 |
| `scenes/main.gd` | 当前 Stage 的 UI、命令执行与助手邀请流程 |
| `assets/town/ai_meadow_town.png` | AI 萤火镇背景图 |
| `tests/probe_town_entry.gd` | 真实的生图与 NPC 入场链路探针 |

## Channel 与环境注册

Godot 通过 StageChannel 独立监听器的 `/ws` 端点连接，或由 Console `/a/:id/ws` 网关转发，依次执行 `hello`、`stage_register` 和 `stage_activate`。`hello.channel=stage` 是握手元数据；StageChannel 不按客户端类型或场景类型分流。StageCatalog 提供环境说明和工具目录。就绪信号表示场景已激活。Godot 也可以访问 HTTP 会话能力，以及独立管理 API 的历史和附件等能力。

`clientId` 标识当前 Godot 实例的通信连接，`assistantId` 标识场景中的助手。不同 Godot 实例连接同一助手时使用不同 `clientId`，避免互相替换连接。断开提示会包含 WebSocket 关闭码和原因；服务端主动替换相同 `clientId` 时使用 `4001`。

完整模型请求会包含 system、messages 和工具目录，单帧可能超过 Godot 默认约 64 KiB 的缓冲。客户端使用 8 MiB 接收缓冲、1 MiB 发送缓冲、4096 个排队包，不过滤或截断事件。超出有限容量仍可能关闭连接，`1009 / Message too big` 表示消息过大，可据实际消息大小调整 `StageChannelClient` 的缓冲常量。

无模型调用的真实通信测试（先构建 assistant）：

```sh
node assistant-godot/tests/protocol_smoke.mjs
node assistant-godot/tests/console_discovery_smoke.mjs
node assistant-godot/tests/ws_lifecycle_smoke.mjs
```

测试启动本机 Steam Godot，验证环境注册、激活、工具下发和回执。可通过 `GODOT_BIN` 指定其他 Godot 路径。

第二个测试使用隔离的数据目录和模拟 Console，验证缺少 Key 的 401 提示、设置保存后自动刷新、Stage 助手筛选和空列表提示，不改动现有客户端配置。

第三个测试使用隔离项目和本机模拟服务，复现旧缓冲的 `1009` 断开，验证修复后的 128 KiB 消息、连续 256 个事件、关闭原因、连接失败及实例身份。测试不发送真实助手消息或调用模型。
