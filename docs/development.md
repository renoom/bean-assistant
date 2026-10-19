# AI 助手开发指南

`assistant/` 是独立 Cordis 工程，`console/` 负责注册、管理、配置和网关。助手内部使用原生 `agent-loop` 创建/恢复的一个 dsh Agent、一个持久 Session 和独立 StageRegistry。

## 启动

推荐先启动控制台，在页面中配置供应商、模型和角色，然后创建助手。Console 会读取配置并传入启动参数。手动启动也必须连接同一个配置中心，并提供已配置的供应商、模型与稳定会话 ID：

```bash
cd console
npm start
```

> 需要 Console 登录自启、崩溃自动重启、`/api/health` 健康监控时，
> 用 `./console/ops/macos/install-console-daemon.sh` 安装 launchd 守护，
> 详见 [守护进程.md](./守护进程.md)。

```bash
cd assistant
npm run dev -- --name "我的助手" --console-url http://127.0.0.1:3000 --provider <已配置供应商> --model <已配置模型> --session-id <稳定会话ID> --port 3001 --channels http,stage
```

`--port` 是管理 API；`--http-port` 是 HttpChannel；`--stage-port` 是 StageChannel。后两者默认 `0` 自动分配。新部署使用 `--channels http,stage`，旧别名仍兼容。

## 运行时检查

启动日志分别打印管理 API、http 和 stage 地址。注册状态中的 `channelEndpoints` 是发现来源。普通聊天调用 http 端点的 `/api/message` 与 `/api/stream`；Godot 连接 stage 端点的 `/ws`。管理端口用于状态、配置、Stage 查询、历史和下载；console 网关自身仍使用 console 端口。

```bash
curl http://127.0.0.1:3001/api/status
curl -X POST http://127.0.0.1:${HTTP_PORT}/api/message -H 'Content-Type: application/json' -d '{"text":"你好"}'
curl http://127.0.0.1:${HTTP_PORT}/api/stream
```

## 修改边界

HttpChannel 只负责聊天 HTTP/SSE；StageChannel 只负责 /ws 的 hello、注册、激活、事件、Bridge 命令结果和聊天输出；管理绑定保持在 `http-capability-bindings.ts`。新增 Stage 能力应扩展 Stage 类型和 Registry 交互，并保持注册与激活分离。

```bash
npm run build
npm test
```

控制台网关与真实 Godot 协议测试分别为：

```bash
cd console
node --import tsx --test src/gateway.test.ts
```

```bash
cd examples/godot-demo
./run.sh test
node tests/protocol_smoke.mjs
```

协议测试使用测试 Agent，不请求模型。运行之前需要 `assistant` 已 build，并安装 Godot（脚本支持本机 Steam 安装目录）。

重点检查 TypeScript 类型、三种端口独立监听、`channelEndpoints` 完整，以及 Godot 的 hello → stage_register → stage_activate → event/command_result 流程。
