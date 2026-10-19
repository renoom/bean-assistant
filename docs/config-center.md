# 配置中心技术设计文档

> 状态：已评审 · 2026-09-05
> 关联文档：[architecture.md](architecture.md) · [protocol.md](protocol.md)
> 网络搜索配置与验证：[network-search.md](network-search.md)（`webSearch` 为热字段）。

## 1. 概述

配置中心是控制台的第三个核心职责（注册中心 + 管理中心 + 配置中心）。它让每个助手的模型、provider、APIKey、人设、指令、技能等**一切可配置项**，都从控制台统一获取，而不是在助手本地写死。

当前问题：模型/provider/persona 硬编码在 `assistant/cordis.patch.yml`，APIKey 在 `~/.dsh/.credentials.yaml`，每个助手无法在控制台差异化配置。

配置中心提供以下能力：

- **公共配置 + 私有配置**：控制台持有一份公共默认配置，每个助手可声明私有覆盖项。
- **继承覆盖**：助手配了字段就用助手的，没配就用公共的。
- **热切换**：`provider`/`model`/`apiKey`/`skills` 改完立即生效，不重启。
- **冷切换 + 手动重启**：`persona`/`agentMd`/`maxTokens` 等在 agent 创建时固化，改后需在控制台**手动点「重启」**，会话 resume 保留历史。
- **技能下发**：控制台维护技能库，按助手配置下发技能到运行时注册。
- **可扩展**：后续新增配置字段 = 扩展 schema + 对应 hot/cold 应用器。

## 2. 设计目标与架构原则

### 2.1 设计目标

1. 配置与代码解耦：所有可配置项走配置中心，助手本地只留 fallback。
2. 差异化配置：每个助手可独立配置，互不影响。
3. 最小中断：能热切换的字段不重启，必须重启的字段由用户手动触发。
4. 高内聚、功能隔离：配置中心是独立的内聚单元，不侵入其它模块。
5. 可扩展：加配置字段不改变架构，只扩展 schema 和应用器。

### 2.2 架构原则（高内聚、功能隔离）

配置中心在**控制台**和**助手**两端都是独立、内聚的功能单元，不侵入其它模块。

#### 模块划分

```
控制台端                             助手端
─────────                           ─────────
console/src/                        assistant/src/
├── registry.ts   注册表             ├── bin.ts        launcher（启动时冷字段注入）
├── spawner.ts    进程管理           ├── plugin.ts     assistant（Agent+HTTP+上报）
├── store.ts      元数据持久化        ├── server.ts     HTTP
├── server.ts     路由               ├── registration.ts
└── config.ts     ★配置中心          ├── memory/       记忆系统
                                    └── config/       ★配置中心（独立内聚）
                                       ├── types.ts      schema + hot/cold 元数据
                                       ├── fetch.ts      拉取 + 合并（纯函数）
                                       ├── plugin.ts     assistant-config 插件
                                       └── apply/
                                           ├── model.ts       模型热切换
                                           ├── credential.ts  apiKey 热切换
                                           └── skills.ts      技能下发
```

#### 职责边界

| 模块 | 职责 | 明确不做 |
|------|------|---------|
| launcher `bin.ts` | 启动时拉配置 → 冷字段注入 agent-loop/system-prompt | 不处理运行时变更 |
| assistant `plugin.ts` | Agent 获取 + HTTP 服务 + 上报 + 暴露 `ctx.assistant` | 不掺配置获取/应用/热切换 |
| config `config/plugin.ts` | 运行时轮询配置、分发变更、热字段应用、冷字段待重启标记 | 不碰 agent 创建、HTTP |
| apply/ 子模块 | 各自一类字段的热应用，独立内聚 | 互相不依赖 |

#### 解耦方式

- config 插件通过 Cordis `inject` 声明依赖（`['assistant', 'credentials', 'skills']`），从 `ctx.assistant.agent` 拿 agent。
- apply/ 子模块各自只依赖 dsh 的一个子系统。
- 控制台 `config.ts` 与 registry/spawner 零耦合，只经 server 路由暴露。

## 3. 核心概念

| 术语 | 说明 |
|------|------|
| **公共配置（public）** | 控制台持有的默认配置，所有助手继承。 |
| **私有配置（private）** | 每个助手的覆盖项，key = 助手 `sessionId`。 |
| **有效配置（resolved）** | 公共 + 私有合并后的最终配置，助手实际使用。 |
| **热字段** | 变更后立即生效的字段（模型/provider/apiKey/技能）。 |
| **冷字段** | 变更后需重启才生效的字段（人设/指令/maxTokens）。 |
| **待重启（pending restart）** | 冷字段已变更、但助手尚未重启的状态标记。 |
| **技能库（skill library）** | 控制台维护的技能清单（name → 正文），助手配置引用技能名。 |

## 4. 配置数据模型

控制台持久化到 `data/config.json`：

```json
{
  "public": {
    "provider": "deepseek-official",
    "model": "deepseek-v4-flash",
    "apiKey": "",
    "persona": "你是一个 AI 助手…",
    "agentMd": "# 助手指令\n…",
    "maxTokens": 256000,
    "skills": ["code-review"]
  },
  "assistants": {
    "assistant-3101": {
      "model": "deepseek-v4-r1",
      "persona": "你是一个编码助手…"
    }
  },
  "skillLibrary": {
    "code-review": {
      "name": "code-review",
      "description": "代码审查技能",
      "content": "# 技能正文 markdown…"
    }
  }
}
```

- `public`：公共配置（缺省值），所有助手继承。
- `assistants`：每助手私有配置，key = 助手 `sessionId`（`assistant-{port}`）。
- `skillLibrary`：技能库（name → 正文），助手配置只引用技能名。

### 4.1 配置字段 schema

```ts
interface AssistantConfig {
  provider?: string    // LLM 提供商（热）
  model?: string       // 模型名（热）
  apiKey?: string      // API Key（热，敏感）
  persona?: string     // 系统人设（冷）
  agentMd?: string     // agent.md 指令内容（冷）
  maxTokens?: number   // 最大输出 token（冷）
  skills?: string[]    // 技能名列表（热下发）
}
```

### 4.2 继承合并（浅覆盖）

```ts
function resolveConfig(publicCfg, privateCfg): AssistantConfig {
  // 标量字段：私有非 undefined 则覆盖公共
  // skills 数组：私有定义（含空数组）则整组替换，否则用公共
  return { ...publicCfg, ...privateCfg }
}
```

## 5. 热/冷字段

字段的 hot/cold 属性集中在 `config/types.ts` 一处定义，是配置中心的元数据契约。

| 字段 | 生效 | 应用器 | dsh 机制 |
|------|------|--------|---------|
| `provider` / `model` | **热** | `apply/model.ts` | `installModelSelection` → 改 `selection.current`，下一步生效 |
| `apiKey` | **热** | `apply/credential.ts` | `ctx.credentials.set`，凭证按请求重新解析 |
| `skills` | **热下发** | `apply/skills.ts` | `ctx.skills.register`/dispose diff |
| `persona` | 冷 | launcher | `system-prompt` config（启动组装） |
| `agentMd` | 冷 | launcher | instructions 注入（启动加载） |
| `maxTokens` | 冷 | launcher | `AgentOptions.maxTokens`（创建固化） |

## 6. 控制台设计

### 6.1 config.ts（配置存储与合并）

`ConfigCenter` 类内聚配置中心逻辑：

- `ConfigStore` 类型（public + assistants + skillLibrary）。
- 加载/持久化 `data/config.json`（原子写，复用 store.ts 模式）。
- `resolveConfig(sessionId)` 合并公共 + 私有。
- `updatePublic(patch)` / `updateAssistant(sessionId, patch)`，返回是否含冷字段。
- `upsertSkill(skill)` 维护技能库。
- `markPendingRestart` / `clearPendingRestart` / `isPendingRestart` 跟踪待重启状态（内存态）。

### 6.2 API

| 方法 | 路径 | 说明 |
|------|------|------|
| `GET` | `/api/config` | 获取公共配置 |
| `PUT` | `/api/config` | 更新公共配置 |
| `GET` | `/api/assistants/:id/config` | 获取助手私有配置 |
| `PUT` | `/api/assistants/:id/config` | 更新助手私有配置 |
| `GET` | `/api/config/resolve?sessionId=` | 合并后完整配置（**助手拉取用**） |
| `POST` | `/api/assistants/:id/restart` | 手动重启（复用 spawner kill+spawn） |
| `GET` | `/api/skills` | 技能库列表 |
| `PUT` | `/api/skills/:name` | 新增/更新技能 |

### 6.3 管理界面

助手卡片增加「配置」面板：

- 显示该助手合并后的**有效配置**，可切换「继承公共」或「私有覆盖」。
- 表单按 schema 渲染，每个字段标注「热」或「冷」。
- 冷字段改动后，卡片显示「待重启」徽标 + 「重启」按钮。
- 技能：从技能库勾选，下发到该助手。

## 7. 助手设计

### 7.1 config/types.ts

配置 schema + hot/cold 元数据，与控制台共享同一份字段语义。

### 7.2 config/fetch.ts

纯函数模块，被 launcher 和 config 插件复用：

```ts
fetchResolvedConfig(consoleUrl, sessionId): Promise<AssistantConfig | null>
merge(publicCfg, privateCfg): AssistantConfig
```

### 7.3 bin.ts（launcher）

- 启动时用 fetch 拉配置，冷字段注入 CLI overlay（patch `agent-loop` / `system-prompt` / `agent-default-model`）。
- 凭证文件按助手隔离：credentials-local `path` 指向 `data/credentials/{sessionId}.yaml`，避免多助手共享 `~/.dsh/.credentials.yaml` 互相覆盖 apiKey。

### 7.4 config/plugin.ts（assistant-config 插件）

```ts
export const name = 'assistant-config'
export const inject = ['assistant', 'credentials', 'skills']
```

- agent 就绪后装 `installModelSelection`。
- 轮询（5s）`/api/config/resolve` 检测变更。
- 热字段变更 → 分发到 apply/ 子模块。
- 冷字段变更 → 标记「待重启」（由控制台 UI 提示用户重启）。

### 7.5 config/apply/*.ts

三个独立应用器，各自只依赖一个 dsh 子系统：

- **model.ts**：`installModelSelection(agent.ctx, selection)`，热切换时改 `selection.current = { provider, model }`。
- **credential.ts**：`ctx.credentials.set('DEEPSEEK_API_KEY', value)`。
- **skills.ts**：对配置里的技能名逐个 `ctx.skills.register({ name, content, description })`，与上次 diff，卸载移除的、注册新增的。

## 8. 配置变更生效流程

```
控制台 UI 改配置
  ├─ 仅热字段（model/provider/apiKey/skills）
  │    → PUT config → 助手轮询 resolve 检测变更 → config 插件走 apply/ 立即应用
  └─ 含冷字段（persona/agentMd/maxTokens）
       → config.ts 标记「待重启」→ 用户点「重启」
       → POST restart → kill + spawn 同 sessionId → launcher 拉新配置 → 冷字段生效 → resume
```

### 8.1 手动重启语义

- 重启 = 控制台 kill 旧助手进程 + spawn 新进程，**同一个 `sessionId`**。
- 助手重启后走 `restore-or-create`：会话历史从持久化日志 resume，不丢失。
- 冷字段（persona/agentMd/maxTokens）在 agent 创建时应用，重启后生效。

## 9. 技能下发

技能库是控制台维护的「技能名 → markdown 正文」映射。助手配置里的 `skills: ["code-review"]` 只引用技能名。

下发数据流：

```
控制台技能库（name → content）
  → 助手 resolve 配置得到 skills 名列表
  → 助手 config/apply/skills.ts 从控制台拉技能正文
  → ctx.skills.register({ name, content, description })
  → agent 工具列表出现该技能
```

技能是热下发：改 `skills` 列表立即 register/unregister diff，无需重启。

## 10. 安全与凭证隔离

- 本地部署；API Key 鉴权已启用，但仍建议配合反向代理做 TLS、限流和访问控制。
- `apiKey` 是敏感字段：控制台与助手间 HTTP 明文传输，仅适用于可信本地网络。
- **凭证隔离**：每个助手用独立的凭证文件（credentials-local `path` → `data/credentials/{sessionId}.yaml`），多助手间 apiKey 不互相覆盖。
- apiKey 热切换依赖 dsh credentials 的「按请求重新解析」特性，`ctx.credentials.set` 后下次 LLM 请求即用新 key。

## 11. 可扩展性

新增配置字段的步骤（不改变架构）：

1. 在 `config/types.ts` 的 `AssistantConfig` 里加字段。
2. 在 hot/cold 元数据里声明该字段的生效方式。
3. 若为热字段：在 `apply/` 下新增一个应用器（或扩展现有）。
4. 若为冷字段：在 launcher 的冷字段注入逻辑里补一条。
5. 控制台 UI 的表单自动按 schema 渲染。

## 12. 实施计划

1. 控制台 `config.ts`：类型 + 持久化 + `resolveConfig` + 待重启标记。
2. 控制台路由：config / resolve / restart / skills。
3. 助手 `config/types.ts` + `config/fetch.ts`。
4. 助手 `bin.ts`：launcher 拉配置注入冷字段；凭证文件隔离。
5. 助手 `config/plugin.ts` + `apply/*`：运行时轮询 + 热应用。
6. 控制台 UI：配置面板 + 重启按钮 + 技能勾选。
7. 端到端验证。

## 13. 验证方式

1. spawn 助手 A（公共 model=flash）→ 改公共 model → A 热切换（`/api/status` model 更新 + 对话用新模型）。
2. 改 A 私有 persona → 显示「待重启」→ 点「重启」→ resume 且 persona 生效。
3. 改 apiKey → 热切换 → 下次请求用新 key（错误 key 报错、正确 key 恢复）。
4. 技能库加技能 → A 勾选下发 → agent 工具列表出现该技能。
5. spawn 助手 B，B 私有 model 覆盖 → 只影响 B（继承覆盖正确）。
6. 重启控制台 → 配置不丢（data/config.json 正确加载）。
7. **内聚性检查**：config 逻辑全部在 `config/` 目录，`plugin.ts` 不含任何配置获取/应用代码。
