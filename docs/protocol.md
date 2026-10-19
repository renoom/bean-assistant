# 进程间通信协议

协议由管理 HTTP、聊天 HTTP/SSE 和 Stage WebSocket 三部分组成，监听独立端口，端口通过 `channelEndpoints` 发现。

## 管理 API（config.port）

管理端口提供健康、状态、配置、Stage 查询、历史、观测和附件/生成图片下载。控制台网关自身运行在 console 端口，管理请求再以上游方式访问助手管理端口；管理端口不提供聊天 POST、SSE 或 Stage transition。助手 status 或发送给控制台的注册请求中包含端点描述，例如：

```json
{"channelEndpoints":[{"id":"http","protocol":"http","host":"127.0.0.1","port":41231,"path":"/api/message"},{"id":"stage","protocol":"ws","host":"127.0.0.1","port":41232,"path":"/ws"}]}
```

## HttpChannel（id http）

`POST /api/message` 接收 text、images、clientId，返回接受状态和回合信息；`GET /api/stream` 返回 SSE，推送模型和会话事件。控制台网关聊天/SSE 路由转发到该端点。

## StageChannel（id stage，WebSocket /ws）

Godot 连接后先发送 `hello`，服务端回复 `hello_ack`。客户端发送 `stage_register`，收到 registered/updated/unchanged/rejected 结果；注册不会自动激活。发送 `stage_activate` 或 `stage_transition` 激活本连接注册的 Stage。

典型握手、注册和激活：

```json
{"type":"hello","clientId":"godot-1","role":"assistant"}
```
```json
{"type":"hello_ack","channel":"stage","clientId":"godot-1","registrations":[],"stage":{"id":"empty","status":"empty"}}
```
```json
{"type":"stage_register","requestId":"r1","stage":{"id":"town:meadow","kind":"town","environment":{"text":"萤火镇"},"commands":[{"name":"say","description":"在场景中说话","parameters":{"type":"object"}}]}}
```
```json
{"type":"stage_register_result","requestId":"r1","result":{"kind":"registered"},"stage":{"id":"empty","status":"empty"}}
```
注册不会改变当前 Stage。激活必须显式发送：
```json
{"type":"stage_activate","requestId":"a1","stageId":"town:meadow","mode":"after-turn","expectedStageId":"empty","expectedRevision":0}
```
助手向客户端请求 Bridge 命令，客户端返回结果：
```json
{"type":"command","commandId":"c1","command":"say","args":{"text":"你好"}}
```
```json
{"type":"command_result","commandId":"c1","ok":true,"result":{"accepted":true}}
```
客户端事件示例：
```json
{"type":"event","stageId":"town:meadow","event":{"kind":"enter","actorId":"assistant"}}
```
连接断开后 Stage 可为 suspended；恢复连接并重新注册后再激活，Registry 恢复 Bridge，未变化的上下文不会重复写入缓存。

`clientId` 是连接身份，应在不同客户端实例间唯一；`assistantId` 是可选的场景参与者身份，二者不应混用。新连接使用已连接的 `clientId` 时，旧连接会以 `4001 / clientId replaced by a new connection` 关闭。服务端记录断开码和原因，客户端也应展示这些信息。`llm_event` 包括完整的模型请求，接收端需要为大型上下文消息配置足够的 WebSocket 缓冲，不能按普通文字片段大小估算。

| 方向 | 帧 | 用途 |
|---|---|---|
| 客户端 → 助手 | stage_register / stage_unregister | 管理环境注册 |
| 客户端 → 助手 | stage_activate / stage_transition | 激活或回到 empty |
| 客户端 → 助手 | event | 当前场景事件 |
| 助手 → 客户端 | command | 请求执行 StageBridge 能力 |
| 客户端 → 助手 | command_result | 命令回执 |
| 助手 → 客户端 | llm_event | 模型和会话事件 |
| 双向 | chat / chat_result | Stage 客户端聊天及结果 |

只有 Registry 当前激活项接收事件并投影到 Agent 上下文。网关 `/a/:id/ws` 映射到助手 `/ws`。新配置使用 `channels: ["http", "stage"]`；旧值映射到对应新 Channel。
