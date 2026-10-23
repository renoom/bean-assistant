# DSH Subagent 能力评估（蜂群系统前置调研）

> 调研对象：本地内核 `deepseek-harness`（assistant 实际链接版本 `0.1.0-rc.5`）的 subagent 家族。
> 对照：桌面端 DSH `0.2.1-rc.2`（仅作参考，assistant 未升级）。
> 日期：2026-10-21。

## 结论摘要

| 你的要求 | 结论 | 一句话 |
|---|---|---|
| 1. subagent 是独立线程 | ⚠️ 部分满足 | **独立 Agent + 独立 Session + 独立上下文**，但跑在同一个 Node 进程/事件循环里，异步并发，不是 OS 线程。真线程/真进程有 `workflow` worker 和 out-of-process provider 可选。 |
| 2. 无状态，即用即弃 | ✅ 满足（one-shot 模式） | one-shot 一次运行一个结果，不可续聊、不可恢复；但子会话日志会持久化落盘，不会自动删除——"逻辑上即用即弃"不等于"没有痕迹"。 |
| 3. 有可管理的口子 | ✅ 强满足 | `ctx.subagents` 服务 API + 6 个模型工具 + 事件/投影 + 深度/工具/模型/persona/取消控制。**但只提供"子代理原语"，不提供"蜂群语义"**（编队、角色、成员间通信、调度、配额、可视化），这层要我们自己写。 |

**最重要的实测发现**：assistant 已经通过 `dsh-base` 全量挂载了 subagent 能力。线上助手「贾维斯」当前 43 个工具里已包含 `subagent`、`subagent_fork`、`send_message`、`interrupt_agent`、`list_agents`、`workflow`、`ralph`。做蜂群**不需要改内核、不需要装新依赖**，只需要在我们自己的插件里加控制面和 UI。

---

## 1. "独立线程"：逻辑独立、执行异步、物理共享

### 1.1 独立的是什么

`spawn` provider 的实现（`subagent-spawn-in-process`）会创建一个**全新的 child Agent**：

- 独立的 **Session**（独立会话日志、独立上下文窗口、独立 turn 队列）；
- 看不到父会话历史（`spawn`），`fork` 则会把父会话**已完成 turn** 的前缀 seed 给子会话；
- 继承父的 cwd、session lineage、默认 model、全局工具/服务；
- 子代理的中间步骤不会进入父上下文，父只拿最终输出（one-shot）或结算通知（continuable）。

所以"独立线程"在**会话/上下文层面是成立的**——这也是蜂群最需要的隔离。

### 1.2 但执行不是线程

- 所有 in-process subagent 与父代理共享**同一个 Node.js 进程和事件循环**；靠 async 并发，不是 OS 线程。
- 父代理发起一笔**前台** subagent 调用时，该 turn 会等 `run.result`；**后台**（Task / continuable）则不阻塞，父可以继续干活，多个兄弟 delegation 可并行（每个 Agent 的滚动并发池 `maxParallelToolCalls` 默认 10）。
- CPU 密集的操作会卡住整个进程（包括所有子代理）。这是 in-process 模式的硬边界。
- 子代理之间的隔离是**组合隔离**（独立 session/context），不是安全隔离：共享服务、共享 cwd、共享进程内存。

### 1.3 真线程 / 真进程的选项

| 需求 | 现成能力 | 状态 |
|---|---|---|
| 脚本编排不阻塞事件循环 | `dsh-workflow-worker-thread`：每次 workflow run 起一个真正的 Node **worker thread** 执行编排脚本；child agent 仍在 host | assistant 已挂载 |
| 子代理进程隔离 | out-of-process providers：`subagent-dsh-sdk` / `subagent-codex` / `subagent-claude-code` / `subagent-acp` | 内核有，**assistant 未安装** |
| CPU 隔离 | 只能靠上述 worker thread 或 out-of-process | 同上 |

> 注意：workflow 的 worker thread 只隔离**编排脚本**，不隔离 child agent。如果蜂群成员需要跑重 CPU 工具，要么把成员换成 out-of-process provider，要么把重活拆给 workflow worker。

---

## 2. "无状态，即用即弃"：两种生命周期可自由选

DSH 的 subagent 不是只有一种模式，而是明确分成 **one-shot** 和 **continuable** 两类。你的"无状态即用即弃"对应 one-shot；蜂群里需要长驻角色的成员则应该用 continuable。

| 维度 | one-shot（一次性） | continuable（可续聊） |
|---|---|---|
| 生命周期 | `start()` 发布子会话 → 跑一个 turn → `result` → `dispose()` | 持久化子 Session + 最多一个进程内 Activation；多轮 FIFO turn |
| 结果 | 一个终态 `SubagentResult`（output/structured/stopReason） | 没有统一 result；输出留在子会话，靠结算通知/report 回传 |
| 后续交互 | ❌ 无跟进、无恢复、无 steer | ✅ `followup`（send_message）、`interrupt`、`report`、冷恢复 |
| 上下文 | 父只看最终输出 | 父只收结算通知；子会话可单独打开查看 |
| 管理 | `SubagentRun`（result + dispose） | `childId` 常驻；`listChildren`/`listDescendants` 可枚举 |
| 持久化 | Session 日志仍会落盘（origin=subagent） | 同上，且 descriptor 支持冷恢复 |
| 典型用途 | 一次性任务 worker、批处理、fork 继承上下文做单次分析 | 蜂群成员、长驻角色、可反复派活的下属 |

### 2.1 无状态的三个 caveat

1. **日志不删**：`session-persistence-jsonl` 明确"Nothing deletes session files"——one-shot 子会话也持久化，没有 GC/删除 API。蜂群规模化后需要我们自己定保留策略（或定期外部清理）。
2. **不是"零成本"**：每次 spawn 都是一份全新的系统提示 + 工具定义 + 任务上下文；子代理不继承父历史（fork 才继承），所以"即用即弃"的代价是每次都重新付上下文钱。适合短任务，不适合反复派同一角色。
3. **不共享状态**：子代理之间没有内存共享/黑板；共享要通过外部服务（文件、HTTP、我们已有的 memory/knowledge、自定义 store）。

---

## 3. "可管理的口子"：四层控制面，够搭蜂群底座

### 3.1 程序服务 API（做蜂群控制器最该用的一层）

`ctx.subagents`（`SubagentRuntime`）暴露：

| API | 作用 |
|---|---|
| `start(provider, request)` | 启动 one-shot 子代理，返回 `SubagentRun`（result + dispose） |
| `startContinuable(spec)` | 创建持久化子代理并投递初始 prompt，返回 `{ childId, messageId }` |
| `followup(parent, childId, content, opts)` | 给子代理追加一轮 FIFO 任务（不打断当前 turn） |
| `interrupt(sessionId, authority)` | 只停当前 turn，保留 inbox 和子会话，可继续派活 |
| `reportFrom(child, content, opts)` | 子代理主动向父汇报（quiet 注入 / waking 开新 turn） |
| `listChildren(parentSessionId)` | 枚举直接子代理（one-shot + continuable，含 activity） |
| `listDescendants(rootSessionId)` | 展开整棵子代理树（稳定先序 + depth + parentId） |
| `drainContinuableDescendants(parents)` | 关闭准入并 child-first 回收整片森林（蜂群解散用） |
| `registerProvider` / `registerContinuableSetup` | 注册新的 transport / 组合能力 |

`start` 的请求还支持：`label`、`prompt`、`parent`、`signal`（取消通道）、`agentOptions{provider,model,maxTokens}`、`outputSchema`（结构化输出）、`maxDepth`、`toolFilter`、`persona`。**异构蜂群（不同角色不同模型/工具/人设）必须走这层**——模型工具的参数里没有这些。

### 3.2 模型工具层（已经生效，可直接让主代理用）

| 工具 | 模式 | 说明 |
|---|---|---|
| `subagent` | spawn / **continuable** | 默认后台，立即返回持久 childId；结束时父收到结算通知；`run_in_background:false` 才前台等结果 |
| `subagent_fork` | fork / **one-shot** | 带父会话历史的一次性委托，默认前台，可后台 Task |
| `send_message` | 控制 | 给 continuable 子代理追加 FIFO turn |
| `interrupt_agent` | 控制 | 停子代理当前 turn，保留 inbox |
| `list_agents` | 控制 | 列 continuable 子代理（children/descendants） |
| `report` | 子→父 | 子代理主动汇报 |
| `workflow` | 扇出 | JS 脚本批量跑 subagent，worker thread 执行，返回最终 JSON |
| `ralph` | 迭代 | 固定脚本的 fresh-agent 循环（最多 64 轮） |

线上「贾维斯」实测的 `subagent` 工具描述已确认：*"runs in the background by default, immediately returns a durable subagent id... `send_message` starts a later turn in the same child conversation"*——即 continuable 模式已生效。

### 3.3 事件、投影、持久化（做观测/UI 的基础）

- 生命周期事件：`subagent/start`、`subagent/end`（共享 runId，带 provider/local）、`subagent/provider-added`、`subagent/provider-removed`。
- 会话事件：子会话完整 log（`parentSession`、`delegationDepth`、`origin: 'subagent'`、log-only 的 `subagent/descriptor`）。
- 投影：`subagent`（身份 mode/label）与 `subagentTiming`（活跃 turn 时长）已注册进 `sessionProjections`；`listChildren/listDescendants` 直接读 store/persistence，不加载子代理。
- 结算通知：continuable 子代理结束时，runtime 无条件给父发一条 `subagent-settled` notice（含停止原因 + 最终回复），不依赖子代理是否调用 `report`。
- UI 参考：`@deepseek-ai/dsh-client-ui-subagent` 在 DSH Web 里做了一棵子代理目录树（展开、状态、token、耗时、打开子会话、续聊输入框）。assistant 的自研 UI 没有这个包，但可以照它的交互自己实现。

### 3.4 策略与护栏

- 深度：`maxDepth` 默认 **3**（相对深度，0 禁止再委托）；持久化 header 的 `delegationDepth` 只增不减。
- 并发：每个 Agent 的 `maxParallelToolCalls` 默认 **10**；workflow 的 `maxConcurrentAgents` 默认按 CPU 并行度，`maxTotalAgents` 默认 1000。
- 子代理组合：`toolFilter`（隐藏工具，可见性非权限）、`persona`（覆盖部署人设）、`agentOptions`（模型/maxTokens）、`outputSchema`。
- 权限：子代理继承父的 sandbox override；approval 固定 `'never'`（子代理的 ask 会确定性拒绝，不会挂起等人）。
- 生命周期：取消走 request signal；`dispose()` 幂等；continuable 是 child-first 回收；还有 `drainContinuableDescendants` 做整片树关闭。

---

## 4. 蜂群系统还缺什么（内核没有、要我们建）

1. **只有树，没有网**：通信严格父↔子（`send_message` 只下行、`report` 只上行），没有兄弟/平级消息、广播、共享黑板。
2. **没有编队/角色/成员组身份**：Session 树只有 parent/depth，没有 "swarm id / 角色 / 席位"；要自己维护 roster。
3. **没有调度器**：没有任务队列、负载均衡、配额/预算、重试/故障转移、准入控制；`maxParallelToolCalls` 和 depth 只是被动上限。
4. **模型工具的动态性有限**：`subagent` 只接受 `description`/`prompt`/`run_in_background`；模型/persona/toolFilter/maxDepth 是**插件实例级配置**，不是每次调用参数。异构蜂群要用 3.1 的服务 API，或挂多个不同配置的工具实例。
5. **没有蜂群控制台**：assistant UI 目前看不到子代理树/状态/历史；DSH Web 的 subagent 抽屉只属于桌面端。
6. **Session 无 GC**：成员越跑越多，日志只增不减；需要保留/归档策略。
7. **无资源隔离**：同进程、同事件循环、同内存；重活需 out-of-process 或 workflow worker。
8. **Console 级看不到单助手内部的 subagent**：除非 assistant 暴露 `listChildren` 的 HTTP API，或 Console 直接读同一个 session store。

---

## 5. 建议的蜂群架构（在现有原语上薄薄加一层）

```text
Console 级编队（跨助手，另一个层次）
  └─ Assistant 进程（贾维斯）
       ├─ SwarmController（我们新增的 Cordis 服务）
       │    ├─ Roster：成员 ID / 角色 / 模型 / 工具 / 任期
       │    ├─ TaskBoard：任务池、分配、优先级、依赖
       │    ├─ Scheduler：并发准入、预算、重试、超时、故障剔除
       │    └─ 直接调用 ctx.subagents（startContinuable/followup/interrupt/list/drain）
       ├─ Worker Agents：continuable spawn 子代理（每个成员一个持久会话）
       ├─ 共享面：memory / knowledge / 外部 store / 文件——不进子代理上下文
       └─ HTTP + SSE /api/swarm/* + WebUI「蜂群」页（拓扑、成员卡、派活、日志）
```

关键取舍：

- **成员用 continuable，任务用 one-shot**；批量扇出用 `workflow`，不要用模型工具一轮轮派。
- **控制器用代码，不用模型工具驱动**：直接调 `ctx.subagents` 才能拿到 childId、控制模型/工具/深度、做可测试的调度。
- **深度建议**：主代理(0) → 蜂群成员(1) → 成员自己的子任务(2)，保持 `maxDepth` 默认 3。
- **共享状态走外部服务**：subagent 之间不共享上下文；memory/knowledge 已验证可作为跨会话共享面。
- **隔离按需升级**：先 in-process；CPU/高风险成员后续挂 `subagent-dsh-sdk`（独立进程）或交给 workflow worker。
- **Console 级编队以 assistant 为节点**：跨助手协作走 HTTP；不要试图从 Console 直接操纵 assistant 内部的 subagent。

---

## 6. 下一步可选方向

| 选项 | 内容 | 适合 |
|---|---|---|
| **A（推荐）** | 单助手内最小蜂群 MVP：`SwarmController` + `/api/swarm` + 蜂群 UI + 3~5 个成员，先跑通"派活/收活/监控/解散" | 验证原语和体验 |
| B | 只做观测面：用 `listChildren/listDescendants` 在现有 UI 展示子代理树和会话 | 低成本、先看见 |
| C | 直接做 Console 级多助手编队（以 assistant 为节点） | 跨助手协作 |
| D | 先把内核升到 0.2.1-rc.2 再评估上游 Team/Agent 层能否复用 | 升级周期不确定 |

A 与 C 不冲突：可以先在单助手里把蜂群成员/调度跑通，再把 Controller 提升到 Console 层。

---

## 7. 证据索引

**内核源码/文档**（`/Users/maoling99/Documents/myworkspace/deepseek-harness`）：

- `packages/subagent/README.md` — subagent 家族总览（provider 列表）
- `packages/subagent/subagent/README.md` — `ctx.subagents` 服务 API、continuable、descriptor、事件
- `docs/subsystems/subagent.md` — 子系统参考（one-shot/continuable/descriptor/列表/结果）
- `packages/subagent/subagent-spawn-in-process/README.md` — spawn：新进程内子代理、无父历史
- `packages/subagent/tool-subagent/README.md` — 模型工具、前台/后台、continuable 路由
- `packages/subagent/tool-subagent-control/README.md` — send_message / interrupt_agent / list_agents
- `packages/bundle/base/cordis.patch.yml:292-341` — dsh-base 默认挂载的 subagent 组合
- `packages/core/agent-loop/README.md:40` — `maxParallelToolCalls` 默认 10
- `packages/workflow/workflow-worker-thread/README.md` — 真 worker thread、并发/总量上限
- `packages/session/session-persistence-jsonl/README.md:75` — 无删除 API
- `packages/client/ui-subagent/README.md` — DSH Web 子代理目录树/会话/续聊交互

**本项目**：

- `assistant/package.json` — 已依赖 `dsh-subagent`、spawn/fork、tool-subagent、control、report、workflow、ralph
- `assistant/cordis.patch.yml` — 继承 `dsh-base`，未禁用 subagent
- `docs/kernel-version-audit.md` — 内核 0.1.0-rc.5 vs 上游 0.2.1-rc.2

**线上实测**（2026-10-21，贾维斯 `127.0.0.1:3105`）：

- `GET /api/context`：43 个工具 schema，含 `subagent` / `subagent_fork` / `send_message` / `interrupt_agent` / `list_agents` / `workflow` / `ralph`
- `GET /api/context/node?id=tool-schema:subagent`：continuable 模式描述（后台默认、持久 id、send_message 续聊）

> 本次调研未修改任何代码，仅新增本文档。
