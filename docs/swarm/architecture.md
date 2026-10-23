# 蜂群系统架构设计（v1）

> 状态：设计稿，待确认后分阶段实施
> 日期：2026-10-21
> 范围：Console 团队（助手间）+ Assistant 蜂群（助手内 subagent）+ 双端 UI

## 0. 术语与整体关系

| 概念 | 层级 | 说明 |
|---|---|---|
| **团队 Team** | Console 层 | 多个助手组成的协作单元：1 个 leader + N 个成员，可设角色；成员间可自由通信。控制台给助手打团队标记。 |
| **蜂群 Swarm** | Assistant 内部 | 每个助手自己的 subagent 团队，由该助手的 Subagent 能力驱动，是助手内部的一个独立系统。 |
| **Leader** | 团队角色 | 部门老大：对接外部需求、思考、拆解分发、给成员安排角色、招募新助手；**不做具体执行工作**。 |
| **成员助手** | 团队角色 | 接收 leader 分派的任务；把复杂任务继续拆给**自己的蜂群**执行。 |

```text
Console ── Team（团队）
  ├─ leader 助手 ── 对外接需求 / 拆解 / 分发 / 招募 / 定角色
  ├─ 成员助手 A ── Swarm A（自己的 subagent 蜂群）
  ├─ 成员助手 B ── Swarm B
  └─ 成员助手 C ── Swarm C
```

三层职责：**Leader 不干活 → 成员助手负责拆解与交付 → 蜂群负责具体子任务**。

---

## 1. 总体架构

```text
┌──────────────────────────────── Console (3000) ────────────────────────────────┐
│  Web SPA                                                                       │
│   ├─ 助手网格（App 式卡片，点击弹窗打开助手 WebUI）                              │
│   ├─ 团队页（上：成员卡；下：助手间通讯记录）                                     │
│   └─ 配置中心（含每助手「蜂群」配置）                                             │
│                                                                                │
│  Team Center                                                                   │
│   ├─ teams.json（团队 / 成员 / 角色 / leader）                                  │
│   ├─ team messages（JSONL，按团队追加）                                         │
│   ├─ 投递队列（离线排队 + 上线补投 + ack）                                       │
│   └─ 内部 API（助手调用）：roster / send / inbox / recruit / assign-role        │
│  Registry + Spawner（已有）                                                     │
└───────────────▲──────────────────────────────▲─────────────────────────────────┘
                │ HTTP(loopback internal)       │ HTTP 管理/网关
┌───────────────┴──────────── Assistant 进程 ───┴─────────────────────────────────┐
│  Team Runtime                                                                  │
│   ├─ 工具：team_roster / team_send / team_recruit / team_assign_role           │
│   ├─ 收件箱：/api/team/inbox → 落成 team-message 事件 → enqueueOrFollowup        │
│   └─ 团队上下文注入（我是谁 / leader / 角色 / 成员列表）                         │
│                                                                                │
│  Swarm Runtime（助手内独立系统）                                                 │
│   ├─ 后台创建入口：swarm_dispatch + 限额/完成标记                               │
│   ├─ 观察：ctx.subagents.listChildren/listDescendants + subagent 事件           │
│   ├─ API：/api/swarm、/api/swarm/member/:id、/api/swarm/member/:id/stream       │
│   └─ 复用 DSH 原生 subagent（spawn/fork/continuable）                            │
│                                                                                │
│  WebUI：对话 / 上下文 / 团队 / 蜂群（蜂群详情抽屉里才看子代理 SSE）               │
└────────────────────────────────────────────────────────────────────────────────┘
```

通信原则：

1. **助手之间不直连**，一律经 Console 消息总线：统一鉴权、离线排队、统一历史、UI 只读一份事实。
2. **助手与蜂群之间**复用 DSH 原生 subagent 通道（进程内），不经 Console。
3. 团队消息是**工具行为**，不是助手 stream 输出；面板只展示工具产生的通信记录。

---

## 2. 团队（Console 层）

### 2.1 数据模型

`~/.assistant/console/teams.json`：

```json
{
  "revision": 3,
  "teams": [
    {
      "id": "team-7f3a",
      "name": "萤火镇开发组",
      "goal": "把萤火镇做出来并验收",
      "leaderId": "assistant-80e592d8",
      "createdAt": "2026-10-21T02:00:00.000Z",
      "members": [
        { "assistantId": "assistant-80e592d8", "role": "leader", "joinedAt": "..." },
        { "assistantId": "assistant-a1b2", "role": "产品", "joinedAt": "..." }
      ]
    }
  ]
}
```

- 助手与团队：**一个助手只能属于一个团队**（已确认；团队标记唯一、UI 简单）；换队需先移出再加入。
- 角色是自由文本（产品 / 开发 / 测试 / 验收…），由 leader 或控制台人类设置。
- 团队标记由成员关系派生，不重复写进 `assistants.json`；API 返回助手时附带 `team` 字段。

团队消息 `~/.assistant/console/teams/messages.jsonl`：

```json
{"id":"msg-...","teamId":"team-7f3a","fromKind":"assistant","from":"assistant-a1b2",
 "fromName":"产品小助","to":"assistant-80e592d8","toName":"leader","kind":"direct",
 "text":"需求文档已更新...","threadId":"th-...","replyTo":null,"hop":0,
 "createdAt":"...","deliveredAt":"..."}
```

- `fromKind`: `assistant` | `human`。人类只能从 Console 团队页给 **leader** 发消息；`from="console:user"`、`to=leaderId`。
- 人类是「虚拟通信方」，不是团队成员：不出现在成员卡与 `team_roster` 里；人类消息**只投递给 leader**，不进入其他成员上下文；成员不能给人类发消息；只有 leader 可以回复人类（`to="human"`，Console 收件箱展示）。
- `kind`: `direct` | `broadcast`。`direct` 是 1:1 直发；`broadcast` 是**团队广播**（`to=null`、`toName="全组"`），投递给团队内除发送者外的所有助手。人类只能 direct 发给 leader。
- 文本上限 20,000 字符；整条消息上限 64 KB。
- 历史只追加；API 分页 `?since=<id>&limit=200`。

### 2.2 团队生命周期

| 操作 | 入口 | 规则 |
|---|---|---|
| 创建团队 | Console UI | 名称必填；创建者可指定首个 leader |
| 加入助手 | Console UI / leader 招募 | 已在其他团队则先移出；离线助手也可加入 |
| 指定 leader | Console UI | 必须是成员；一个团队只有一个 leader；改派时旧 leader 降为成员 |
| 设置角色 | Console UI / `team_assign_role` | leader 才能改；角色文本上限 50 字 |
| 招募新助手 | leader 工具 `team_recruit` | Console 校验调用者是 leader → 用**公共配置** spawn 新助手（leader 可指定 persona）→ 加入团队并设角色；spawn 失败不落成员 |
| 人类发言 | Console 团队页 | 人类**只能发给 leader**；leader 用 `team_send(to="human")` 回复；成员不可发给人类 |
| 移出 / 解散 | Console UI | 移出后该助手团队工具返回「未加入团队」；消息历史保留 |

### 2.3 消息总线

```text
助手 A 的 team_send
   │ POST /api/team/messages {teamId, from, to, text, replyTo?}
   ▼
Console Team Center
   ├─ 校验：A 在团队、目标在团队、内容/频率限制、hop 限制
   ├─ 追加 messages.jsonl（先落盘）
   ├─ UI 侧：团队页轮询 /api/teams/:id/messages?since=
   └─ 投递：POST http://<assistant-B>/api/team/inbox {message}
        ├─ 在线：B ack {messageId} → 标记 deliveredAt
        └─ 离线/失败：进入 pending 队列；B 注册/心跳时补投（at-least-once）
```

- B 侧按 `messageId` 去重，重复投递只落一次事件。
- **两种投递**：`direct` 的 `to` 必填单个成员；`broadcast`（团队广播）`to=null`，Console 拆成 N 个私有点对点投递（每个成员各自一条 team-message 事件），但历史里只记一条广播消息。成员回复广播时默认 direct 回到发送者，不默认广播。
- 投递失败不阻塞发送方：`team_send` / `team_broadcast` 只返回「已受理 + messageId」；离线成员各自排队。

### 2.4 助手通信事件

在助手会话里新增一种消息来源：

```ts
declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'team-message': {
      kind: 'team-message'
      teamId: string
      teamName: string
      messageId: string
      fromKind: 'assistant' | 'human'
      from: { assistantId?: string; name: string; role?: string }
      to: { assistantId?: string; name: string } | null
      threadId: string
      replyTo: string | null
      hop: number
      createdAt: string
    }
  }
}
```

收到消息时：

1. 追加 `user/message`，`source.kind = 'team-message'`（模型可见发送者/团队/角色/hop）；
2. 用现有 `enqueueOrFollowup()` 唤醒或排队；
3. `session-events.ts` 把它转换成一个 `team_message` SSE 帧，助手 UI 渲染成「团队通信」卡片；团队视角的完整通讯记录在 Console 团队页；
4. **不自动回复**：收件助手跑完这一个 turn 就结束；回不回由模型决定。

这样"助手通信事件"既是模型输入，也是可检索的会话历史，不需要第二套消息存储。

### 2.5 通信工具（助手侧）

| 工具 | 参数 | 行为 | 权限 |
|---|---|---|---|
| `team_roster` | — | 返回团队名/目标、leader、全部成员（id/name/role/在线状态/模型）以及自己的角色 | 团队内所有助手 |
| `team_send` | `to`（成员 id 或名字，leader 另可用 `human`）、`message`、`replyTo?` | 1:1 直发，经 Console 投递，立即返回 `{messageId, accepted}`；不等待对方回复。成员不可发给 `human` | 团队内所有助手 |
| `team_broadcast` | `message` | 团队广播：投递给团队内除自己外的所有助手；历史里只记一条 `kind:"broadcast"`。返回 `{messageId, recipients}` | 团队内所有助手（限频更严） |
| `team_assign_role` | `assistantId`、`role` | 改成员角色，Console 校验调用者是 leader | 仅 leader |
| `team_recruit` | `name`、`role`、`persona?` | 用公共配置 spawn 新助手 + 加入团队 + 设角色/人设；返回新助手 id（starting） | 仅 leader |

工具注册在独立的 `assistant/src/team/` 插件里，随助手启动加载；未加入团队时工具仍在，但调用返回明确的「当前未加入团队」。

系统提示附加一段 `team:context`（团队名、目标、leader、成员、自己的角色、leader 职责说明）。成员变化时刷新。

### 2.6 防无限循环

1. **不自动回复**：消息投递只产生一个 turn，助手可以选择什么都不做；回信必须显式调用 `team_send` / `team_broadcast`。
2. **线程深度**：新话题 `hop=0`；回复 `replyTo` 指向原消息时 `hop = 原 hop + 1`。超过 `maxHop`（默认 8）时 Console 拒绝受理并返回错误，模型可据此终止。
3. **频率限制**：1:1 每助手每分钟最多 20 条；团队广播每助手每分钟最多 3 条、每团队每分钟 10 条；超限 429，工具返回错误。
4. **广播回复收敛**：回复广播默认发给发送者本人（direct），不默认广播；广播本身不触发任何自动回复。
5. **同内容去重**：同一发送者 30 秒内重复文本视为重复，返回已有 messageId。

### 2.7 团队界面

**Console 团队页**（参考 DSH 编队界面）：

```text
┌ 团队：萤火镇开发组   [新建团队] [加入助手] [设 leader] ─────────────┐
│ 成员（卡片网格）                                                    │
│  ┌─────────┐ ┌─────────┐ ┌─────────┐ ┌─────────┐                  │
│  │ 👑 leader│ │ 产品     │ │ 开发     │ │ 测试     │                  │
│  │ 在线·flash│ │ 在线     │ │ 离线     │ │ 在线     │                  │
│  └─────────┘ └─────────┘ └─────────┘ └─────────┘                  │
├────────────────────────────────────────────────────────────────────┤
│ 通讯记录（时间正序，聊天室）                                        │
│  10:21  leader → 产品小助   「先出需求文档」                        │
│  10:25  产品小助 → leader   「需求已发，见附件」                     │
│  10:28  leader → 全组 📢    「今晚 20:00 统一验收」                  │
│  10:30  leader → 开发小助   「按需求实现 A 模块」                    │
└────────────────────────────────────────────────────────────────────┘
```

- 顶部成员卡：头像/首字、名字、角色标签、leader 皇冠、在线状态、模型。
- 底部通讯记录：只展示工具产生的消息（不含助手 stream），时间正序、自动滚底、按成员过滤；广播行显示 `发送者 → 全组` 并用独立样式标出。
- 管理操作放团队页顶部；底部提供**人类 → leader** 的发言框（只有 leader 是合法收件人；没有 leader 时禁用）。人类消息以 `fromKind:"human"` 进入通讯记录，投递给 leader；leader 可用 `team_send(to="human")` 回复。

**团队 UI 只在 Console**：助手 WebUI 不设「团队」tab（只保留 对话 / 上下文 / 蜂群）。团队消息在助手自己的对话流里以「团队通信」卡片出现，但团队观察、人类发言、成员管理全部在 Console 团队页完成。

### 2.8 Leader 规范

- 团队提示词明确：**leader 不做具体执行**，只负责接外部需求、拆解、分发、定角色、招募、验收协调。
- leader 的常规工具仍在（需要思考和读写文件），但 prompt 层约束其不直接承接实现任务。
- 成员提示词：收到任务先判断是否需要拆给蜂群；完成后向 leader 汇报（`team_send`）。

---

## 3. 蜂群（Assistant 内部）

> 注：2026-10-21 第二批需求对蜂群章节做了修订（共享上下文、完成标记、归档、UI 布局）。
> 与本章冲突处以 **§11** 为准。

### 3.1 复用 DSH 原生 subagent

| 场景 | 模式 |
|---|---|
| 长驻蜂群成员（可反复派活） | `subagent` continuable（后台、持久 childId、send_message 续聊） |
| 一次性子任务 | `subagent` one-shot（前台/后台 Task） |
| 需要父会话上下文的一次性分析 | `subagent_fork` one-shot |

蜂群不重新造 Agent 运行时，只做**观察、限额、UI、配置**四件事。

### 3.2 蜂群配置

助手私有配置新增（热字段）：

```json
"swarm": {
  "maxDepth": 3,       // subagent 递归层级：主助手 0 → 成员 1 → 成员的下属 2 ...
  "maxMembers": 5,     // 同时存活的直接子代理数量上限
  "maxPerTask": 20     // 预留：单次任务累计可创建数
}
```

- Console 助手配置页新增「蜂群」分组：两个数字输入 + 说明 + 范围校验。
- 热生效：配置中心 push → 助手的 Swarm 服务更新限额，无需重启。
- 蜂群配置页的限额有**绝对上限**（默认 `maxDepth 10` / `maxMembers 20`），配置页只能收紧、不能突破。

### 3.3 限额执行：唯一后台入口 `swarm_dispatch`（取代 SwarmGate）

原生模型工具实例全部禁用（见 §11.12），不存在模型可绕过的前台创建路径。限额/深度/工具过滤/共享上下文都在唯一入口 `swarm_dispatch` 内完成：

1. 入口加**串行准入锁**（进程内 Promise 队列），防止并发创建突破上限；
2. `listChildren(调用方会话)` 统计 `activity === 'running'` 的直接子代理数，达到 `maxMembers` 就抛错（错误信息可直接给模型：「蜂群并发已达上限 5，请先回收成员或调高配置」）；
3. `mode='task'`：`ctx.jobs.start` + `ctx.subagents.start`，把 `maxDepth` 注入/收紧到请求里，共享上下文拼在 prompt 头部，返回 `{jobId, memberId}`；
4. `mode='resident'`：`startContinuable`，先做父深度检查（超过 `maxDepth` 拒绝）与并发检查，共享上下文拼在 prompt 头部，返回 `{childId}`；
5. 成员递归创建下级也走同一个 `swarm_dispatch`（受 `maxDepth` 限制），不做原生工具旁路；
6. 配置页限额热生效（Swarm 服务从配置中心读），无需重启。

因为模型侧不存在原生 subagent 工具，**不需要 provider 包装**；原生 `spawn`/`fork` provider 只被 `swarm_dispatch` 内部调用。

### 3.4 蜂群数据与 API

`GET /api/swarm`（蜂群页首屏 + 轮询）：

```json
{
  "limits": { "maxDepth": 3, "maxMembers": 5 },
  "members": [
    {
      "id": "session-...", "label": "开发小蜂", "mode": "one-shot",
      "status": "done", "depth": 1, "parentId": "session-main",
      "provider": "spawn", "model": "deepseek-flash",
      "tokens": 12345, "activeMs": 65000, "jobId": "subagent-3",
      "lastMessage": "已完成 A 模块...", "hasChildren": false
    }
  ],
  "comms": [
    { "id": "c1", "kind": "delegate", "from": "main", "fromName": "贾维斯",
      "to": "session-...", "toName": "开发小蜂", "text": "实现 A 模块...",
      "time": "..." },
    { "id": "c2", "kind": "settle", "from": "session-...", "fromName": "开发小蜂",
      "to": "main", "toName": "贾维斯", "text": "已完成 A 模块", "time": "..." }
  ]
}
```

- `members` 来自 `ctx.subagents.listChildren/listDescendants` + `subagent` 身份投影 + `subagentTiming` + session summary。
- `comms` 来自主会话的 `subagent/start`、`subagent/end` 与 `send_message` 工具调用：委派记录 = 任务 label/prompt 摘要；回收记录 = 结算通知/最终输出摘要。**不包含子代理的流式内容**。
- 列表只放摘要，满足"蜂群页不直接看 subagent SSE"。

子代理详情：

| API | 用途 |
|---|---|
| `GET /api/swarm/member/:id` | 详情首屏：header + 最近 N 条会话事件（从 session 存储读） |
| `GET /api/swarm/member/:id/stream` | 详情 SSE：先回放历史，再实时转发该子会话事件；子代理不在了就自然结束 |
| `POST /api/swarm/member/:id/interrupt`（可选） | 停当前 turn（不影响 inbox） |

实时转发实现：`ctx.agents.get(childId)` 拿到活着的子 Agent，监听 `agent.ctx.on('session/event')` 并过滤该 session；历史从 session persistence 读。**只有抽屉打开时才建立这条 SSE**。

### 3.5 蜂群界面（助手 WebUI「蜂群」tab）

```text
统计条：N 个成员 · M 运行中 · 上限 5 · 深度 3
┌ 成员卡片（网格） ───────────────────────────────────────────────┐
│  ● 开发小蜂   running   continuable   12.3k tok · 1m05s · depth 1 │
│  ○ 测试小蜂   idle      continuable    4.1k tok · 0m42s · depth 1 │
└─────────────────────────────────────────────────────────────────┘
┌ 通讯记录（聊天室，时间正序） ────────────────────────────────────┐
│ 10:21 贾维斯 → 开发小蜂：实现 A 模块…                            │
│ 10:25 开发小蜂 → 贾维斯：已完成 A 模块（停止原因 completed）      │
└─────────────────────────────────────────────────────────────────┘
```

- 空状态：`还没有子 Agent — 当主助手通过 subagent 工具委派任务时，蜂群会在这里展开`（对齐 DSH 文案）。
- 点成员卡 → 右侧抽屉：成员 header（label/status/model/tokens/耗时/深度）+ 该子代理的完整会话流（SSE）+ 停止按钮；**SSE 只在这里出现**。
- 通讯记录过滤：按成员、按类型（委派/回收）；自动滚底。

### 3.6 蜂群与团队的关系

- 团队成员助手的蜂群记录只在该助手自己的 WebUI 可见（Console 团队页不展示蜂群内部流）。
- Leader 的蜂群同样存在，但 leader 职责决定它通常只有"分析/拆解"类子任务。

---

## 4. Console UI 重构

### 4.1 助手网格（App 式）

- 移除「左侧列表 + 右侧常驻 iframe」布局。
- 主视图为卡片网格：`grid-template-columns: repeat(auto-fill, minmax(280px, 1fr))`。
- 卡片内容：在线点、名字、**团队标记**（团队名 + 角色 + leader 皇冠）、模型、最近活动、快捷操作（⋯：重启 / 停止 / 配置 / 打开）。
- 点击卡片 → **同页面 modal 弹窗**（`90vw × 90vh`）内嵌助手 WebUI；不新开标签页。弹窗头部显示名字/团队标记/关闭。
- 复用现有 iframe 缓存逻辑：每个助手一个常驻 iframe，卡片点击只把对应 iframe 移入 modal 显示；关闭 modal 只是隐藏，不卸载、不重载、不断 SSE。
- 弹窗打开时网格仍在背景；ESC / 点遮罩 / 关闭按钮退出，焦点回到触发卡片。
- 配置编辑、创建助手、停止/重启保持现有逻辑，入口改为卡片菜单 / 弹窗。

### 4.2 团队页

- 顶部导航：`助手 | 团队`。
- 团队列表 → 团队详情（成员卡在上、通讯记录在下，见 2.7）。
- 团队管理弹窗：新建团队、添加/移出助手、指定 leader、编辑角色。

### 4.3 响应式

- 网格宽度自适应；弹窗小屏全屏；团队页成员卡在窄屏单列。

---

## 5. 关键时序

```text
助手A 模型调用 team_send(to=B, text)
  → 助手A Team Runtime → Console POST /api/team/messages
  → Console 校验 + 落盘 messages.jsonl
  → Console POST 助手B /api/team/inbox
  → 助手B 去重 → 追加 team-message 事件 → enqueueOrFollowup
  → 助手B 模型看到消息（可选择不回复）→ turn 结束
  → 若回复：助手B team_send → 回到 Console（新消息，hop+1）
```

```text
助手主 Agent 调用 swarm_dispatch（唯一后台入口）
  → 准入（并发/深度）+ 拼共享上下文 → ctx.jobs / startContinuable（原生）
  → 蜂群页轮询 /api/swarm：成员卡 + 通讯记录
  → 点成员卡：打开 /api/swarm/member/:id/stream（仅详情）
```

---

## 6. 安全 / 边界

- Console 内部 API 仅本机 loopback 免 Key；远程仍走平台 Key。
- leader 权限（招募/改角色）由 Console 根据 `leaderId` 校验，不能只信助手自报。
- 招募的参数做白名单：**不接受 model/provider**（一律用公共配置）；persona 长度限制；role 长度限制。
- 消息频率/长度/线程深度限制见 2.6；历史不删（v1），后续加保留策略。
- 跨团队通信一律拒绝；不在团队的助手调用团队工具返回明确错误。
- 蜂群限额/深度/工具过滤由唯一入口 `swarm_dispatch` 在进程内强制；原生前台创建工具全部禁用（§11.12），不依赖模型自觉。

---

## 7. 实施阶段

| 阶段 | 内容 | 验收 |
|---|---|---|
| **P1 Console 团队底座** | `teams.json` + 团队 API + 消息总线/队列 + Console 团队页 + 助手网格/弹窗改造 | 能建团队、加助手、设 leader；团队页能看到成员卡与消息；助手卡片点击弹窗打开 WebUI |
| **P2 助手团队通信** | team-message 事件 + 收件箱 + 4 个工具 + leader/角色提示词 + 招募/改角色 + Console 团队页人类发言 | 两个助手能互发消息，Console 团队页聊天室按序显示；人类只能发给 leader；leader 能招募、改角色；不回复不会自动循环 |
| **P3 蜂群后端** | 禁用原生前台工具 + `swarm_dispatch` 唯一后台入口 + swarm 配置字段 + 共享上下文 + `/api/swarm` + 详情 SSE | 配置页改上限后即时生效；V1/V2 都能创建且全部后台；蜂群页能看到成员与完成标记；详情能看子代理流 |
| **P4 蜂群前端 + 收尾** | 蜂群 tab + 成员卡 + 通讯记录 + 详情抽屉 + 配置页；测试、协议文档、截图 | 全链路演示：leader 接需求 → 分派成员 → 成员拆给蜂群 → 结果回收；`verify.mjs` 全绿 |

依赖：P2 依赖 P1，P3/P4 可与 P2 并行（P4 的前端依赖 P3 的 API）。

---

## 8. 已确认决策（2026-10-21）

1. **团队归属**：一个助手**只能属于一个团队**；换队需先移出。
2. **人类发言**：人类**只能给 leader 发言**；leader 可用 `team_send(to="human")` 回复；成员不能给人类发消息。
3. **招募继承**：新助手使用**公共配置**；leader 可在招募时指定 persona（模型/provider 不开放）。
4. **UI 归属**：团队 UI **只在 Console**；助手 WebUI 只保留 对话 / 上下文 / 蜂群，不做团队 tab。
5. **Console 弹窗**：复用现有常驻 iframe，**同页面 modal** 展示，不重载、不断 SSE。

蜂群层面仍有 4 个待确认项，见 §11.8。

---

## 9. 改动清单（预估）

**Console**
- 新增：`src/teams.ts`（团队中心 + 消息总线 + 投递队列）
- 修改：`src/server.ts`（团队 API、内部 API、启动加载）、`src/bin.ts`（teams 路径）、`src/spawner.ts`（招募复用）、`src/static/index.html`（网格 + 弹窗 + 团队页）
- 测试：`src/teams.test.ts`、`src/server.test.ts` 增补

**Assistant**
- 新增：`src/team/`（events / client / tools / receiver / plugin）、`src/swarm/`（limits / gate / manager / api / streams）
- 修改：`src/plugin.ts`（装配）、`src/service/http-capability-bindings.ts`（swarm/team API）、`src/service/capabilities.ts`、`src/service/session-events.ts`（team_message 帧）、`src/config/types.ts` + `src/config/plugin.ts`（swarm 热配置）、`assistant/cordis.patch.yml`（禁用原生前台 subagent/workflow/ralph 工具 + 注册 `swarm_dispatch`）、`web-ui/index.html`（蜂群 tab + 抽屉；团队 UI 在 Console）
- 测试：team 消息事件、swarm 限额、API 形状

**文档**
- `docs/protocol.md`（团队内部 API + team-message 事件）
- `docs/architecture.md`（新增团队/蜂群两层）
- `docs/swarm/*`（本文 + 后续实现说明）
- `automation/verify.mjs`（新增检查项）

---

## 10. 设计取舍记录

- **为什么消息走 Console 而不是助手直连**：离线补投、统一日志、鉴权与限额集中、UI 只读一份事实；代价是 Console 成为团队通信的单点（控制台本来就在线要求）。
- **为什么复用 team-message 作为会话消息而不是另建事件容器**：模型必须看到消息才能决策；DSH 的 `MessageSource` 可扩展，天然支持"特殊来源 + 模型可见 + UI 特判"。
- **为什么蜂群不另造运行时**：DSH subagent 已有 continuable/结算/取消/深度/工具过滤；我们只补限额、观察和展示。
- **为什么所有创建收口到 `swarm_dispatch`**：原生工具允许前台等待，会阻塞主 agent 的 turn；收口后后台是唯一路径，限额/深度/共享上下文/标记纪律也只有一个实现点。代价是模型工具 schema 由我们维护，但内部仍完全复用原生 `ctx.subagents`。
- **为什么详情才给 SSE**：蜂群页是"编队视图"（成员 + 通讯），不是日志流；大量子代理并发时的流式内容会把页面淹没，也会让轮询负载失控。

---

## 11. 蜂群第二批需求评审与修订（2026-10-21）

### 11.0 结论

| # | 需求 | 判断 | 修订要点 |
|---|---|---|---|
| 1 | 共享上下文，写入必须经主 agent，防止无限膨胀 | **合理，采纳** | 成员只能「提案」，主 agent 审核后写入；硬上限 + 版本号 + 注入快照 |
| 2 | 成员网格；悬停选中才显示上下游；默认只展示 1 级；主 agent 放标题 | **合理，采纳** | 加点击/键盘固定选择（触屏可用）；上下游关系单独 API |
| 3 | UI 现代一点 | **合理** | 给出设计 token / 动效 / 深色模式规范，P4 先出视觉稿再实现 |
| 4 | 蜂群只和主 agent 通信 | **合理，已是 DSH 的树形模型** | 明确：2 级成员只和它的父成员通信，不越级找主 agent；用工具过滤兜底 |
| 5 | 完成不直接报结果，只报完成标记，主 agent 主动拉取 | **非常合理，且 DSH 有现成形态** | 默认用 one-shot 后台任务 worker：原生完成通知很小、结果只能 `job_output` 拉取；再叠加聚合标记 |
| 6 | 确认弃用后归档子会话 | **合理，但只能逻辑归档** | DSH 没有删除 API；归档 = 状态 + 会话导出 + 移出活跃列表，不做物理删除 |

一句话：**六条都合理，其中第 5 条最关键也最容易踩坑——DSH continuable 子代理的结算通知会自动携带最终回复内容**，所以"只报标记"不能靠 continuable 的默认行为，必须换生命周期或强约束。

### 11.1 共享上下文（黑板）

目标：给蜂群一份受控的公共知识，不让每个子代理各自膨胀上下文；写入权只在主 agent。

**存储**：`{dataDir}/swarm/shared-context.json`

```json
{
  "version": 7,
  "updatedAt": "...",
  "entries": [
    {
      "id": "ctx-01",
      "key": "api-convention",
      "title": "接口约定",
      "content": "REST 路径统一 /api/v1/...，错误码见 docs/...",
      "tags": ["backend"],
      "author": "member-3f2a",
      "approvedBy": "main",
      "createdAt": "...",
      "updatedAt": "..."
    }
  ]
}
```

**硬边界**（默认值，可进配置）：

| 项 | 默认 | 行为 |
|---|---|---|
| 总字节 | 8 KB | 写满后拒绝写入，主 agent 必须显式删除/合并后才可继续 |
| 条目数 | 50 | 同上，不静默淘汰 |
| 单条正文 | 1 KB | 超长写入直接拒绝 |
| 注入方式 | 派发时快照 | 子代理拿到的是 `version` 快照，放在其上下文**头部**（先于任务描述）；运行中不热改，避免提示词漂移 |

**读写规则**：

- 成员（含 2 级）只有 `swarm_context_read`（读当前快照）和 `swarm_context_propose`（提交候选）；
- 候选进入 `pending` 池，不直接进正文；成员会话结束也不自动落库；
- 主 agent 通过 `swarm_collect` 看到候选摘要，用 `swarm_context_write` 决定采纳/合并/丢弃；
- 每次写入 bump `version` 并写一条 log-only 会话事件（`swarm/context-write`），供 UI 审计；
- 主 agent 可以删除条目，但同样受上限约束（删除后腾出配额）。

**注入位置**：

- V1 任务蜂（one-shot）：`swarm_dispatch` 在 `request.prompt` 最前面插入一段共享上下文快照（纯文本块），再放主 agent 的任务描述；
- V2 常驻蜂（continuable）：`registerContinuableSetup` 给子代理注册一个 child-scoped system prompt section，快照文本在子代理创建时定格，排在身份/人设之后、任务相关内容之前；
- 快照带 `version`，同一成员一次任务内不更新；主 agent 改共享上下文后，对下一次派发生效。

**空间不够时**：写入直接失败，并返回当前用量、条目列表和最旧/最少使用条目；由主 agent 决定合并、删除还是放弃写入。系统**不做静默淘汰**。

**UI**：蜂群页顶部一个可折叠的「共享上下文」面板：版本号、容量进度条（如 `3.2 KB / 8 KB`）、条目列表、待审候选数角标。面板只读，写操作由主 agent 在对话里完成。

### 11.2 完成标记与拉取式回收

> 创建入口以 §11.9 为准：统一走 `swarm_dispatch(mode, shared_context)`；本节只描述两种生命周期的完成语义差异。

**核心原则**：成员结束只产生一个轻量标记；结果留在成员自己的会话里；主 agent 主动拉取，且先拿列表、再按需拿详情。

**成员状态机**：

```text
running → done（完成标记） → collected（主 agent 已拉取） → retired（确认弃用） → archived
```

**成员模式：V1 默认任务蜂，V2 由主 agent 决策**

两种模式都通过唯一后台入口 `swarm_dispatch` 创建，内部调用原生 `ctx.subagents`：

| 模式 | 创建方式 | 生命周期 | 完成信号 | 最终内容是否自动进主 agent |
|---|---|---|---|---|
| **V1 任务蜂（默认）** | `swarm_dispatch(mode='task')`，内部 one-shot 后台任务 | 一次任务，后台执行，结束后不再承接 | 原生后台任务完成通知（很小） | ❌ 不进；要 `job_output` / `swarm_result` 主动拉 |
| **V2 常驻蜂（主 agent 选择）** | `swarm_dispatch(mode='resident')`，内部 `startContinuable` | 持久 childId，可用 `send_message` 再派活 | 原生结算通知（含最终 assistant 内容） | ⚠️ 会进；用「结束只写标记」约束压小 |

主 agent 的选择规则写进提示词：**默认 `mode='task'` 派一次性任务；确实需要反复派活/对话的成员才用 `mode='resident'`**。

**V1 的完成标记**就是 DSH 原生后台任务通知：

```text
background job <jobId> (swarm: <label>) finished [status: completed]. Read its output with job_output.
```

- 通知本身很小，不携带最终输出；
- **V1 固定后台**：`swarm_dispatch(mode='task')` 没有前台选项（§11.12），不存在"忘记加 run_in_background"的误用路径；
- 主 agent 可以用 `swarm_collect` 统一拉取（SwarmManager 把 member 与 child session 关联，不必逐个记 jobId）；
- 完整结果在成员自己的 Session 里，用 `swarm_result(id)` 或原生 `job_output(jobId)` 读取；
- 多个任务同时完成时，DSH 会把通知注入到主 agent 的下一步，不额外开 turn。

**V2 的标记纪律**：

- `registerContinuableSetup` 给常驻蜂注册一条 child-scoped prompt section：*“任务结束时最后一条消息只输出 `[DONE] <taskId> <≤120字摘要>`，详细结果留在你的会话里，不要复述。”*
- DSH continuable 的结算通知仍会自动携带最终 assistant 内容，无法拦截；标记纪律只能把它压小；
- SwarmManager 在结算时检查最终消息长度，超阈值标记 `warning`，UI 提示「该成员未遵守标记纪律」；
- 这是主 agent 选择 V2 时接受的代价；V1 没有这个问题。

**主 agent 拉取工具**：

| 工具 | 行为 |
|---|---|
| `swarm_collect(cursor?)` | 返回自上次拉取以来所有 `done` 成员（V1 + V2）：id、label、mode、任务摘要、stopReason、完成时间、是否有待审上下文提案。**不含完整输出。** 返回 `nextCursor` |
| `swarm_result(id, detail?)` | 返回该成员最终输出（默认截断 4 KB，`detail:'full'` 最多 8 KB）与最近工具轨迹摘要 |
| `swarm_context_*` | 共享上下文读写/提案 |
| `swarm_retire(id)` | 确认弃用：停止未结束的成员，标记 retired，随后归档 |

> 设计取舍：不做自定义的“聚合器通知”，因为它会引入第二套后台/唤醒机制；原生通知已经足够小，`swarm_collect` 只是给主 agent 的聚合视图，不新增自动消息。

### 11.3 通信拓扑、原生通讯能力与工具过滤

- 只允许树边通信：主 agent ↔ 1 级成员；1 级成员 ↔ 2 级成员。**不允许兄弟互发、不允许 2 级越级找主 agent**。
- 1 级成员是平级的（UI 默认只展示它们），但通信上各自只连自己的父/子。

**DSH 原生有哪些"蜂群通讯工具"**：

| 能力 | 原生支持 | 说明 |
|---|---|---|
| 主 agent → 子代理派活 | ✅ `swarm_dispatch`（内部原生 `ctx.subagents`，永远后台） | 创建即投递首轮任务，主 agent 不等待 |
| 主 agent → 常驻子代理追加任务 | ✅ `send_message` | 只对 continuable 有效；V1 任务蜂没有 |
| 常驻子代理 → 主 agent 主动汇报 | ✅ `report`（子代理侧工具）+ 结算通知 | continuable 专用 |
| 任务蜂 → 主 agent 完成标记 | ✅ 后台任务完成通知 | one-shot 原生行为，很小；结果用 `job_output` 拉 |
| 主 agent 查询成员 | ✅ `list_agents`（模型工具，只列 continuable）、服务 `listChildren/listDescendants`（含 one-shot） | UI 用服务层，不受模型工具限制 |
| 平级互发 / 广播 / 群聊 / 共享上下文 | ❌ 原生没有 | 蜂群层不做平级通信；**助手团队**的 1:1 直发与团队广播由 Console 团队层提供（§2.5） |
| 完成标记 + 主动拉取 | ✅ 仅 one-shot 后台任务形态 | continuable 的结算通知会带最终内容 |

> 结论：**原生已经有父子通讯工具，不需要重造通讯层**。我们做的是：新增一个 one-shot 的 native 工具实例（V1 任务蜂）、共享上下文、完成标记的聚合视图、归档和蜂群 UI。

- 工具过滤：通过两个 native 工具实例的 `toolFilter` 配置收窄（dsh-base 的 `tool-subagent` 支持）：
  - 隐藏 `team_*`（团队是助手间的事，蜂群成员不参与）；
  - 隐藏 `swarm_collect` / `swarm_result` / `swarm_context_write` / `swarm_retire`（主 agent 专用）；
  - 保留 `swarm_context_read` / `swarm_context_propose` 和任务所需工具；
  - 递归子代理继承同样的过滤，防止越权。
- 最终输出：V1 不自动进主 agent；V2 的结算通知会进（标记纪律只能压小）；无论哪种，蜂群页都不显示子代理 stream，完整内容只在详情抽屉。

### 11.4 UI v2：网格 + 悬停上下游 + 现代视觉

**布局**：

```text
┌ 蜂群 · 主助手：贾维斯   ● 在线   5 成员 · 2 运行 · 3 完成 · 上下文 v7 ─ [共享上下文 ▾] ┐
├──────────────────────────────────────────────────────────────────────────────────────┤
│  ┌────────┐ ┌────────┐ ┌────────┐ ┌────────┐ ┌────────┐                              │
│  │ 开发小蜂│ │ 测试小蜂│ │ 调研小蜂│ │ 归档…  │ │  + 派发 │                              │
│  │ ● 运行  │ │ ✓ 完成  │ │ ✓ 完成  │ │        │ │        │                              │
│  └────────┘ └────────┘ └────────┘ └────────┘ └────────┘                              │
│         （悬停/点击某成员：其余变暗，画出 主助手↑ 与它的下游↓ 连线）                    │
├──────────────────────────────────────────────────────────────────────────────────────┤
│ 通讯 / 完成标记（时间正序）                                                            │
│  10:21 主助手 → 开发小蜂：实现 A 模块…                                                │
│  10:25 开发小蜂 → 主助手：✓ 完成 · A 模块已实现…                                       │
│  10:26 主助手 → 共享上下文：采纳「接口约定」v7                                          │
└──────────────────────────────────────────────────────────────────────────────────────┘
```

**交互规则**：

- 默认只渲染 1 级成员，**主 agent 只出现在页头标题**，不做网络图节点；
- 悬停/键盘聚焦/点击任一成员：进入"聚焦态"——该成员高亮，向页头画一条上游线（主 agent），向下方画它自己的子代理（2 级）卡片与连线；其余成员变暗；
- 鼠标移出还原；点击可"钉住"聚焦态，再点空白/ESC 退出（触屏与无障碍都靠这个）；
- 2 级成员默认不展示，只有聚焦其父时才出现；点击 2 级可打开详情；
- 卡片信息：状态、名字/label、任务摘要一行、模型、token、耗时、完成/归档徽章、**共享上下文开关徽章**（ctx: on/off）；
- 底部通讯记录只放"派发 / 完成标记 / 上下文采纳"这类事件，不放子代理 stream；点成员开右侧详情抽屉，抽屉里才是该子代理的完整 SSE。

**视觉规范（现代、不老旧）**：

- 设计 token：中性灰底 `#f6f7f9`（深色 `#0f1115`）、卡片 `#fff`（深色 `#171a21`）、圆角 16px、柔和阴影、1px 低对比描边；
- 主色 `#5b5bd6`（靛蓝）// 状态色：运行 `#22c55e`、完成 `#3b82f6`、失败 `#ef4444`、归档 `#94a3b8`；
- 字号层级 20/14/13/12，数字用 tabular-nums；卡片 hover 上浮 2px + 状态光晕；连线用 1.5px 渐变，聚焦时 200ms 过渡；
- 全站统一 SVG 图标（与上下文页同一套），不用 emoji 当图标；
- 支持深色模式、`prefers-reduced-motion`、键盘焦点环、ARIA 标签；
- 移动端：网格单列，聚焦态变为底部抽屉。

### 11.5 归档

- DSH 的 Session 是 append-only，**没有删除 API**；归档只能是逻辑归档 + 导出：
  1. `swarm_retire(id)`：确认弃用；如果成员还在运行，先 `interrupt` 再 dispose；有子代理则 child-first 回收；
  2. 状态置 `archived`，从活跃成员列表/并发计数中移除（释放 maxMembers 名额）；
  3. 会话 JSONL 复制到 `{dataDir}/swarm/archive/{memberId}.jsonl`，并写 `archive.json` 索引（label / 任务 / 完成时间 / stopReason / 耗时）；
  4. 主 agent 会话里写一条 log-only 归档事件；共享上下文里该成员贡献的条目保留 provenance；
  5. UI 提供「归档」视图，只读查看归档会话与详情（回放，不建立 SSE 实时连接）。
- 待审的上下文提案在归档时一并标记为丢弃（需主 agent 确认或自动丢弃并记录）。
- `swarm_retire` 只能由主 agent 调用（或控制台人类操作）；成员自己不能归档自己。

### 11.6 工具 / API 增量

**主 agent 工具（唯一创建入口 + 蜂群管理）**：

- 创建：`swarm_dispatch(mode='task' | 'resident', shared_context='full' | 'none')`——唯一创建入口，永远后台
- 原生通讯：`send_message`、`interrupt_agent`、`list_agents`（对 continuable 成员）
- 拉取：原生 `job_output`（**禁止 `wait: true`**）、`swarm_collect`、`swarm_result`
- 蜂群管理：`swarm_context_list` / `swarm_context_write`、`swarm_retire`

**成员工具**：`swarm_context_read`、`swarm_context_propose`、`swarm_dispatch`（递归创建下级，受 maxDepth 限制）；V2 常驻蜂另有原生 `report`；主 agent 专用工具通过 `toolFilter` 隐藏。

**助手 API**：

| API | 内容 |
|---|---|
| `GET /api/swarm` | 主 agent 信息、限额、共享上下文摘要、活跃成员、完成数、归档数、待审候选数 |
| `GET /api/swarm/relations?id=` | 该成员的父（主 agent 或成员）与直接子代理（悬停上下游用） |
| `GET /api/swarm/context` | 共享上下文条目 + 待审候选（只读） |
| `GET /api/swarm/member/:id` / `/stream` | 详情首屏 / 详情 SSE（仍然只有抽屉使用） |
| `GET /api/swarm/archive` | 归档列表与只读会话入口 |

### 11.7 实施影响

- **创建入口：`swarm_dispatch` 薄封装**（见 §11.9）：内部按 `mode` 调用 `ctx.subagents.start`（task，后台任务语义）或 `ctx.subagents.startContinuable`（resident）；共享上下文开关、`maxDepth`、`toolFilter`、标记纪律都在入口完成。**不重造 subagent 运行时**。
- **原生通讯保留**：`send_message` / `report` / 结算通知 / `interrupt_agent` / `list_agents` 对 resident 成员仍然有效。
- **原生前台创建工具全部禁用**：`tool-subagent` / `tool-subagent-fork` / `tool-workflow` / `tool-ralph`（§11.12）；唯一创建入口 `swarm_dispatch`，成员递归也走它，不存在原生工具旁路。
- **SwarmManager 观察成员**：`listChildren/listDescendants` + `subagent/start|end`，维护 V1/V2、完成标记、`swarm_collect/result`、共享上下文、归档和 UI。
- **完成通知**：task 模式沿用原生后台任务通知（很小）；resident 模式沿用原生结算通知（标记纪律压小）；`swarm_collect` 不注入额外消息。
- P3 新增：`swarm_dispatch`、共享上下文存储 + 注入、成员状态机、collect/result、归档模块；
- P4 UI 按 §11.4 出视觉稿后再实现；
- 测试新增：两种模式的创建、上下文开关、完成标记、拉取分页、共享上下文上限/注入位置、提案审批、归档后计数释放、2 级工具过滤、V2 标记违例检测。

### 11.8 已确认（2026-10-21）

1. **成员模式**：V1 任务蜂由 `swarm_dispatch(mode='task')` 创建（one-shot 后台）；V2 常驻蜂由主 agent 按需选 `mode='resident'`。
2. **共享上下文**：默认拿**完整快照**，放在其上下文**头部**；默认 8 KB / 50 条硬上限；写满时由主 agent 决定合并、删除或放弃，系统不静默淘汰。
3. **创建方式**：创建入口是蜂群薄封装 `swarm_dispatch`（内部仍走原生 `ctx.subagents`）；原生 `subagent` / `subagent_fork` / `workflow` / `ralph` 模型工具全部禁用（§11.12），只保留原生通讯/拉取工具。**不重造通讯层**，原生通讯能力见 §11.3。
4. **归档**：逻辑归档 + 会话导出（默认）；不做物理删除。
5. **共享上下文开关（追加）**：每次创建由主 agent 决定是否提供，见 §11.9。

> 至此团队与蜂群的设计决策全部锁定，可以进入实施。

### 11.9 共享上下文注入开关（追加，2026-10-21）

**需求**：主 agent 在创建蜜蜂时自行决定要不要提供共享上下文。

**约束**：原生 `subagent` / `subagent_task` 的 schema 只有 `description` / `prompt` / `run_in_background`，没有"是否带共享上下文"的参数；而且这些原生工具现已全部禁用（§11.12），模型唯一的创建入口就是我们自己的薄封装。

**采用方案 A（推荐）：蜂群专用薄封装 `swarm_dispatch`**

```
swarm_dispatch(
  label,
  prompt,
  mode: 'task' | 'resident' = 'task',
  shared_context: 'full' | 'none' = 'full'
)
```

- `mode: 'task'`（默认 V1）：内部创建 one-shot 后台任务（原生 `ctx.subagents.start` + 后台任务语义），完成通知仍然很小，结果主动拉取；
- `mode: 'resident'`（V2）：内部 `ctx.subagents.startContinuable`，原生 `send_message` / `report` / 结算通知全部保留；
- `shared_context: 'full'`：完整快照放在成员上下文**头部**；
- `shared_context: 'none'`：不注入快照，并且在该成员的 `toolFilter` 中移除 `swarm_context_read` / `swarm_context_propose`，成员完全看不到共享上下文；
- 原生 `subagent` / `subagent_fork` **模型工具不再暴露**（它们允许前台等待）；所有创建只走 `swarm_dispatch`，内部用原生 `ctx.subagents`。

**为什么不用方案 B（两个原生工具实例：带上下文 / 不带上下文）**：

- 工具 schema 翻倍（每个 native `tool-subagent` 实例都带完整 schema），工具列表更吵；
- V2 的隔离需要按 provider 区分 `registerContinuableSetup`，实现别扭；
- 每次创建的模式（task/resident）+ 上下文开关总共 4 种组合，实例法会变成 4 个工具。

**边界说明**：这不是重造 subagent 运行时——创建、执行、取消、结算全部仍走 `ctx.subagents`；只是模型可调用的创建入口换成我们自己的薄工具，用来携带每次创建的参数。此前 §11.2 / §11.6 中"直接用原生工具创建"的表述由本节修正。

---

## 12. 最终工具清单（模型可见）

> 注：§11.10–§11.12 为后续追加设计；本节已按「全后台」同步。

| 工具 | 归属 | 用途 |
|---|---|---|
| `swarm_dispatch` | 新增 | **唯一创建入口**：mode + shared_context 开关；永远后台 |
| `swarm_collect` | 新增 | 聚合拉取已完成成员（不含全文） |
| `swarm_result` | 新增 | 按需拉取单个成员结果（截断） |
| `swarm_context_list` / `swarm_context_write` | 新增 | 主 agent 读/写共享上下文 |
| `swarm_retire` | 新增 | 确认弃用并归档成员 |
| `send_message` / `interrupt_agent` / `list_agents` | 原生 | V2 常驻蜂的追加任务 / 停止 / 列表（均非阻塞） |
| `job_output` / `job_list` / `job_kill` | 原生 | 任务蜂结果拉取/列表/停止；**禁止 `job_output(wait: true)`** |
| ~~`subagent` / `subagent_fork`~~ | 已禁用 | 原生工具允许前台等待，违反 §11.12，不再对模型暴露 |
| ~~`workflow` / `ralph`~~ | 已禁用 | 同步阻塞主 turn，违反 §11.12 |

成员侧可见：`swarm_context_read` / `swarm_context_propose` / `swarm_dispatch`（递归，受 maxDepth），以及任务所需工具；`shared_context:'none'` 时上下文工具也被过滤。

### 11.10 one-shot 的拉取方案（定稿，2026-10-21）

**结论：完全复用 DSH 原生后台任务协议，不另造通知/拉取通道。**

`swarm_dispatch(mode='task')` 的内部实现：

1. 用 `ctx.jobs.start({ kind:'swarm', label, owner: 主 agent, outputLimitBytes: 8KB, run })` 注册后台任务；
2. `run()` 内部调用原生 `ctx.subagents.start('spawn', request)`，`request.prompt` 头部拼共享上下文快照（`shared_context='full'` 时）+ 结束标记纪律；
3. dispatch 等待子代理发布后返回 `{ jobId, memberId }`（memberId = 子会话 id）；
4. 子代理结束 → 原生 `tool-jobs` 生成一条极小的完成通知：

```text
background job swarm-3 (swarm: 开发小蜂：实现 A 模块) finished [status: completed]. Read its output with job_output.
```

**主 agent 的拉取路径（三档，按需选择）**：

| 路径 | 工具 | 返回 | 用途 |
|---|---|---|---|
| 直接拉结果 | 原生 `job_output(jobId)` | 最终输出文本，受 `outputLimitBytes` 截断；幂等 | 最直接，收到通知后拉单个成员 |
| 先看全局 | `swarm_collect(cursor?)` | 自上次以来的 `done` 成员列表：`jobId` / `memberId` / label / stopReason / 耗时 / 200 字摘要 / 待审上下文提案数；**不含完整输出** | 建议先调一次，批量处理多个完成成员 |
| 按需详情 | `swarm_result(memberId)` | 截断的最终输出（默认 4KB）+ 工具轨迹摘要；job 丢失/归档后从子会话读取 | 需要细节或 job 记录已不在时 |

**流程**：

```text
主 agent: swarm_dispatch(mode='task', prompt=...)
   ← { jobId: 'swarm-3', memberId: 'session-...' }
   ...（主 agent 继续做别的事）
完成通知: background job swarm-3 ... finished ... Read its output with job_output.
主 agent: swarm_collect()              # 一次拿到所有已完成成员 + 待审提案
主 agent: job_output('swarm-3')        # 或 swarm_result(memberId)，只拉需要的
主 agent: swarm_context_write(...)     # 采纳有用的提案
主 agent: swarm_retire(memberId)       # 确认弃用 → 归档
```

**防轰炸**：

- 完成通知本身不带结果，只有 jobId/标签/状态；
- 主 agent 忙碌时通知注入下一步；空闲时唤醒有 `maxConsecutiveWakes` 上限（tool-jobs 原生行为），多个任务同时完成只花一步；
- `swarm_collect` 是一次聚合查询，不会自动新增消息；
- 完整结果永远在子会话/job 输出里，只有主 agent 显式 `job_output` / `swarm_result` 才进入上下文；
- 重启后 job 记录（进程内）会丢，但子会话持久化；SwarmManager 从 session 事件重建成员状态，`swarm_collect` / `swarm_result` 仍可从子会话读取。

> 补充：任务蜂的完成通知由原生 `tool-jobs` 发出，我们**不重复发**自定义通知；`swarm_dispatch` 只负责“创建 + 拼 prompt + 记账”。

### 11.11 V2 常驻蜂的等待语义（问答补充）

**默认不等待。** 正常 V2 路径（`swarm_dispatch(mode='resident')`，内部 `startContinuable`）：

1. `ctx.subagents.startContinuable()` 在**子代理 inbox 接受初始 prompt** 时就返回 `{ childId, messageId }`，不等子代理跑完；
2. 主 agent 的这次 tool call 立即返回，继续做别的事；如果它没有别的事，就是**空闲（idle）**，不是阻塞等待；
3. 子代理在同一个 Node 进程、同一个事件循环里异步执行；主 agent 与它可以并发，互不阻塞（CPU 密集任务除外，会卡整个事件循环）；
4. 子代理结束 → 原生结算通知：
   - 主 agent 忙碌：注入到下一步的 inbox，不打断当前 turn；
   - 主 agent 空闲：follow-up 开一个新 turn（有 wake 预算），不是"主 agent 一直在等"；
5. 主 agent 的 turn 可以先结束，常驻子代理由 continuation manager 持有，继续跑自己的 turn；进程不退出，子代理就不会因为父 turn 结束而中断；
6. **子代理干活期间，主 agent 仍能接收外界消息**：主 agent 空闲时外部消息立即唤醒/开新 turn；主 agent 正在自己的 turn 里时按 agent-loop 规则排队到本 turn 结束——这是正常 turn 语义，不是子代理造成的阻塞。

**两个例外**：

- **显式前台**：原生 `subagent` 工具传 `run_in_background: false` 时会前台等待；该工具**已被禁用**（§11.12），`swarm_dispatch(mode='resident')` 也永远用 `startContinuable` 后台路径，不存在这个前台模式。
- **嵌套常驻**：一个 V2 子代理自己还有存活的子代理时，continuation manager 会把它记为 `waiting`（quiescent 但仍拥有子代理），这是**运行时驻留状态**，不是它在跑模型或阻塞事件循环。

**关闭时**：主 agent 被 dispose 时，manager 会 child-first 回收它的常驻子代理（`drainContinuableDescendants`），此时 teardown 会等子代理释放；这是关闭语义，不是日常等待。

### 11.12 全后台硬约束（定稿，2026-10-21）

**规则：所有 subagent 的创建与执行只允许后台；任何会阻塞主 agent turn 的入口一律禁用。**

**禁用清单**（在 `assistant/cordis.patch.yml` 里置 `disabled: true`）：

| 行 | 原因 |
|---|---|
| dsh-base `tool-subagent` | 原生 subagent 工具允许 `run_in_background: false` 前台等待 |
| dsh-base `tool-subagent-fork` | 同上 |
| `tool-workflow` | workflow 同步等整个 run 完成，会阻塞主 agent 的 turn |
| `tool-ralph` | 同步循环，会阻塞主 agent 的 turn |

**保留**：`tool-jobs`（后台任务/完成通知）、`send_message`、`interrupt_agent`、`list_agents`、`tool-subagent-report`（子代理侧汇报），以及 `job_output` / `job_list` / `job_kill`。

**唯一创建入口：`swarm_dispatch`（永远后台，不暴露 `run_in_background` 参数）**

- `mode='task'`：`ctx.jobs.start` + `ctx.subagents.start`；返回 `{jobId, memberId}` 的时机是**子代理发布后**，不是任务完成后；
- `mode='resident'`：`startContinuable`；返回 `{childId}` 的时机是**子代理 inbox 接受初始 prompt 后**；
- 递归：成员也可以调用 `swarm_dispatch` 创建它的下级（受 `maxDepth` 限制），同样只能后台；主 agent 专用管理工具对成员过滤；
- 成员如果要等下级结果，也不能前台等待：只能收完成通知后用 `job_output` / `swarm_result` 拉取。

**主 agent 接收外界消息的保证**：

1. subagent 在后台跑，**不占用主 agent 的 turn**；`swarm_dispatch` 返回后主 agent 的 turn 可以立即结束；
2. 外部消息（HTTP `/api/message`、Stage 事件）走主 agent 的 inbox：
   - 主 agent 空闲 → 立即唤醒/开新 turn；
   - 主 agent 正在自己的 turn 里 → 按 agent-loop 规则排队到本 turn 结束（这是正常 turn 语义，不是 subagent 阻塞）；
3. subagent 的完成通知与外部消息都是异步 inbox 事件，主 agent 不轮询、不 sleep；
4. 拉取工具全部非阻塞：`swarm_collect` / `swarm_result` 立即返回（没完成就返回空），不允许 `job_output(wait: true)` 或忙等；
5. `swarm_retire` 只做标记 + 发 interrupt，立即返回；真正的释放/归档异步完成，不卡主 agent；
6. 子代理的 CPU 密集工作仍会和主 agent 共享事件循环（in-process 的固有限制）；需要真 CPU 隔离时换 out-of-process provider，这不在 v1。

**系统提示词**需要写死两条：

- "You never wait for a subagent to finish; dispatch then continue or end the turn."
- "Never call job_output with wait=true or busy-poll; use swarm_collect when you are ready."

---

## 13. 实现状态（2026-10-21）

### 已完成

| 阶段 | 交付 |
|---|---|
| P1 Console 团队底座 | `console/src/teams.ts`（teams.json + messages.jsonl）；团队 API；助手列表团队标记；App 网格 + 同页面 modal iframe；团队页（成员卡 + 通讯记录 + 新建/加成员/设 leader/改角色/移出/删除 + 人类→leader 发言） |
| P2 助手团队通信 | team-message 事件；Console 内部团队 API（roster/messages/role/recruit/pending）；离线 pending + 注册/心跳补投；`team_roster/team_send/team_broadcast/team_assign_role/team_recruit`；leader/团队上下文提示词；助手 UI 团队通信卡片 |
| P3 蜂群后端 | 原生前台工具禁用（`tool-subagent` / `tool-subagent-fork` / `tool-workflow` / `tool-ralph`）；`swarm_dispatch` 唯一后台入口；task（job）/resident（startContinuable）双模式；共享上下文 + 提案/采纳 + 硬上限；`swarm_collect/swarm_result/swarm_context_*/swarm_retire`；`/api/swarm`、member、relations、context、archive、member SSE；archive 会话导出 |
| P4 蜂群 UI | 助手 WebUI「蜂群」tab：主助手 header、共享上下文折叠面板、默认只渲染 1 级成员网格、悬停/聚焦显示上下游、通讯/完成标记 feed、成员详情抽屉（SSE）；Console 配置页「蜂群」分组（热生效） |

### 验证证据

- `node automation/verify.mjs`：**74/74 通过**（assistant 58 / console 16 / 安全扫描）。
- 隔离 Console + 真实助手进程端到端：
  - 团队：建团队、加成员、设 leader、人类消息、广播、角色、招募、非 leader 403；
  - 蜂群：task/resident 创建、共享上下文注入/隔离、上下文硬上限、collect/result、retire 归档、`/api/swarm`、成员 SSE；
  - 原生前台工具已从模型工具列表消失；子代理工具过滤后只保留 `swarm_dispatch` 与上下文读写，无主 agent/团队工具；
  - 配置热更新（maxDepth/maxMembers）即时反映到 `/api/swarm.limits`。
- 助手 WebUI 与 Console 配置页用无头 Edge 截图验证：蜂群 tab、hover 上下游、详情抽屉、配置保存。

### 实现说明 / 偏差

- 完成标记使用原生后台 job 通知（kind=`subagent`）；没有重复自建通知。
- 归档为**逻辑归档 + 会话导出到 `{dataDir}/swarm/archive/`**；DSH 无删除 API，不做物理删除。
- 子代理递归创建仍走全局 `swarm_dispatch`（depth 检查）；默认 UI 只展示 1 级，2 级在聚焦时出现。
- 验收专用 HTTP 入口（`/api/swarm/dev/*`）仅在 `ASSISTANT_SWARM_DEV_API=1` 时开放，普通部署不存在。
- 正在运行的线上助手需要重启才能加载本批代码；本轮只在隔离环境验证，未擅自重启线上进程。
