# 插件依赖完整清单

本文档完整列出 `assistant` 工程的全部插件依赖。这是权威清单，`assistant/package.json` 的 `dependencies` 与此一一对应。

依赖分四层，共 **89 个 `@deepseek-ai` 包 + 2 个第三方运行时包 + 5 个开发依赖**。

## 1. Cordis 框架层（vendor/，9 个包）

dsh 的插件框架，vendored 在 dsh 仓库 `vendor/` 目录下。

| 包名 | 职责 |
|------|------|
| `@deepseek-ai/cordis` | Cordis 插件框架核心（Context、Service、事件、effect） |
| `@deepseek-ai/cordis-plugin-loader` | 插件加载器（从 cordis.yml 加载并管理插件生命周期） |
| `@deepseek-ai/cordis-plugin-include` | YAML 配置解析（`!!js` 表达式、补丁层） |
| `@deepseek-ai/cordis-plugin-group` | 分组与 `isolate` 隔离域 |
| `@deepseek-ai/cordis-plugin-timer` | 定时器服务 |
| `@deepseek-ai/cordis-plugin-hmr` | 热重载（开发期） |
| `@deepseek-ai/cordis-plugin-logger-console` | 控制台日志 |
| `@deepseek-ai/cosmokit` | 零依赖工具库 |
| `@deepseek-ai/schemastery` | Schema 校验（插件 Config 验证） |

## 2. Boot 引导层（5 个包）

应用启动引导，由 `assistant/src/bin.ts` 直接 import。

| 包名 | 职责 |
|------|------|
| `@deepseek-ai/dsh-app-boot` | 应用启动引导（`boot()` 函数、补丁加载、fail-loud） |
| `@deepseek-ai/dsh-launch-environment` | 启动环境快照 |
| `@deepseek-ai/dsh-home-paths` | dsh home 路径解析（`dshHomePath`） |
| `@deepseek-ai/dsh-cmdline` | 命令行参数注入 |
| `@deepseek-ai/dsh-invariants` | 运行时不变量检查（app-boot 的 peer dep） |

## 3. dsh-base Bundle 插件层（75 个包）

通过 `assistant/src/bin.ts` 加载的 `dsh-base/cordis.patch.yml` 引用的全部插件。
这些是数字人能力基座的全部来源。

### 3.1 Agent 系统核心（4）

| 包名 | 职责 |
|------|------|
| `@deepseek-ai/dsh-agent` | Agent 接口、注册表、`agent/*` 事件 |
| `@deepseek-ai/dsh-agent-loop` | Agent 循环驱动（turn/step 生命周期） |
| `@deepseek-ai/dsh-agent-default-model` | 默认模型选择 |
| `@deepseek-ai/dsh-agent-instructions` | 工作区指令上下文 |

### 3.2 会话系统（8）

| 包名 | 职责 |
|------|------|
| `@deepseek-ai/dsh-session` | 追加式 `SessionEvent` 日志 + 内存存储 |
| `@deepseek-ai/dsh-session-persistence-jsonl` | 会话 JSONL 持久化 |
| `@deepseek-ai/dsh-session-projection` | 会话投影注册表 |
| `@deepseek-ai/dsh-session-query-sqlite` | 会话检索（全文搜索，可选） |
| `@deepseek-ai/dsh-session-checkpoint-policy` | 持久化检查点 |
| `@deepseek-ai/dsh-session-title` | 会话标题生成 |
| `@deepseek-ai/dsh-session-title-first-prompt-llm` | 首条提示词生成标题 |
| `@deepseek-ai/dsh-session-telemetry-otel` | 会话遥测（默认禁用） |

### 3.3 LLM 能力（4）

| 包名 | 职责 |
|------|------|
| `@deepseek-ai/dsh-llm` | LLM 服务定义 + 流式词汇表 + 适配器 seam |
| `@deepseek-ai/dsh-llm-deepseek` | DeepSeek API 适配器 |
| `@deepseek-ai/dsh-llm-pi-ai` | pi-ai 多提供商适配器（休眠） |
| `@deepseek-ai/dsh-llm-retry` | LLM 重试逻辑 |

### 3.4 工具与提示词（3）

| 包名 | 职责 |
|------|------|
| `@deepseek-ai/dsh-tools` | 工具注册表 + `defineTool` + 执行管道 |
| `@deepseek-ai/dsh-system-prompt` | 系统提示词组装 |
| `@deepseek-ai/dsh-token-meter` | Token 计量 |

### 3.5 执行环境（Shell / 文件 / 沙箱，9）

| 包名 | 职责 |
|------|------|
| `@deepseek-ai/dsh-bash-sandbox` | Bash 执行（沙箱） |
| `@deepseek-ai/dsh-pwsh-sandbox` | PowerShell 执行（沙箱，Windows） |
| `@deepseek-ai/dsh-subprocess-local` | 本地子进程管理 |
| `@deepseek-ai/dsh-fs-local` | 文件系统 provider |
| `@deepseek-ai/dsh-fs-sandbox` | 沙箱文件系统 provider |
| `@deepseek-ai/dsh-fs-observation-policy` | 文件系统观察策略 |
| `@deepseek-ai/dsh-sandbox-local` | 本地沙箱 |
| `@deepseek-ai/dsh-sandbox-policy` | 沙箱策略（工作区写权限） |
| `@deepseek-ai/dsh-shell-env` | Shell 环境变量 |

### 3.6 工具集（模型可调用，18）

| 包名 | 工具 |
|------|------|
| `@deepseek-ai/dsh-tool-bash` | `bash` |
| `@deepseek-ai/dsh-tool-pwsh` | `pwsh` |
| `@deepseek-ai/dsh-tool-fs` | 文件读写（`read_file`/`write_file`/`edit`） |
| `@deepseek-ai/dsh-tool-fs-search` | 文件搜索（`grep`/`glob`） |
| `@deepseek-ai/dsh-tool-str-replace-editor` | `str_replace_editor` |
| `@deepseek-ai/dsh-tool-web` | `web_search`/`web_fetch` |
| `@deepseek-ai/dsh-tool-skill` | skill 目录/加载 |
| `@deepseek-ai/dsh-tool-todo` | `todo_write` |
| `@deepseek-ai/dsh-tool-goal` | 目标工具 |
| `@deepseek-ai/dsh-tool-ralph` | Ralph 循环 |
| `@deepseek-ai/dsh-tool-subagent` | 子代理委派 |
| `@deepseek-ai/dsh-tool-subagent-control` | 子代理控制 |
| `@deepseek-ai/dsh-tool-subagent-report` | 子代理报告 |
| `@deepseek-ai/dsh-tool-jobs` | 后台任务控制 |
| `@deepseek-ai/dsh-tool-workflow` | 工作流 |
| `@deepseek-ai/dsh-tool-call-timeout-policy` | 工具超时策略 |
| `@deepseek-ai/dsh-repeat-tool-reminder` | 重复调用提醒 |
| `@deepseek-ai/dsh-compaction-tool-result-pruner` | 工具结果裁剪 |

### 3.7 技能系统（3）

| 包名 | 职责 |
|------|------|
| `@deepseek-ai/dsh-skill` | Skill 注册表 |
| `@deepseek-ai/dsh-skill-filesystem` | 文件系统 skill 发现 |
| `@deepseek-ai/dsh-skill-badge` | skill 徽章（默认禁用） |

### 3.8 子代理系统（3）

| 包名 | 职责 |
|------|------|
| `@deepseek-ai/dsh-subagent` | 子代理能力 seam |
| `@deepseek-ai/dsh-subagent-spawn-in-process` | 进程内 spawn 子代理 |
| `@deepseek-ai/dsh-subagent-fork-in-process` | 进程内 fork 子代理 |

### 3.9 上下文与压缩（2）

| 包名 | 职责 |
|------|------|
| `@deepseek-ai/dsh-compaction-basic` | 上下文压缩 |
| `@deepseek-ai/dsh-spill-local` | spill 本地存储 |
| `@deepseek-ai/dsh-spill-policy` | spill 策略 |

### 3.10 目标 / 计划 / 工作流（5）

| 包名 | 职责 |
|------|------|
| `@deepseek-ai/dsh-goal` | 目标持久化 |
| `@deepseek-ai/dsh-goal-round-driver` | 目标轮次驱动 |
| `@deepseek-ai/dsh-plan-mode` | 计划模式 |
| `@deepseek-ai/dsh-workflow-worker-thread` | 工作流引擎 |
| `@deepseek-ai/dsh-jobs-local` | 后台任务运行时 |

### 3.11 交互 / 权限 / 命令（7）

| 包名 | 职责 |
|------|------|
| `@deepseek-ai/dsh-user-approval` | 用户审批 |
| `@deepseek-ai/dsh-user-questions` | 用户问答 |
| `@deepseek-ai/dsh-permission-presets` | 权限预设 |
| `@deepseek-ai/dsh-commands` | 命令注册表 |
| `@deepseek-ai/dsh-command-feedback` | 反馈命令 |
| `@deepseek-ai/dsh-command-compact` | `/compact` 命令 |
| `@deepseek-ai/dsh-command-goal` | `/goal` 命令 |

### 3.12 配置 / 凭证 / 附件（3）

| 包名 | 职责 |
|------|------|
| `@deepseek-ai/dsh-settings-file` | 用户设置（文件后端） |
| `@deepseek-ai/dsh-credentials-local` | 凭证管理（env/.env） |
| `@deepseek-ai/dsh-attachment-local` | 附件存储 |

### 3.13 Web 能力（3）

| 包名 | 职责 |
|------|------|
| `@deepseek-ai/dsh-web` | Web 能力 seam |
| `@deepseek-ai/dsh-web-search-deepseek` | DeepSeek 搜索 provider |
| `@deepseek-ai/dsh-web-fetch-http` | 助手补丁启用的 HTTP 网页读取 provider |
| `@deepseek-ai/dsh-api-gateway` | Typert RPC 网关（复用其类型系统） |

### 3.14 Typert 类型系统（2）

| 包名 | 职责 |
|------|------|
| `@deepseek-ai/dsh-typert-registry` | Typert 类型注册表 |
| `@deepseek-ai/dsh-typert-loader` | Typert 加载器 |

## 4. 第三方运行时依赖（2）

| 包名 | 职责 |
|------|------|
| `express` | HTTP 服务器（^5.1.0） |
| `ws` | WebSocket 服务器（^8.18.0） |

## 5. 开发依赖（5）

| 包名 | 职责 |
|------|------|
| `typescript` | TS 编译（^5.9.0） |
| `tsx` | TS 直接运行（^4.19.0） |
| `@types/node` | Node 类型 |
| `@types/express` | Express 类型 |
| `@types/ws` | ws 类型 |

---

## 补充说明

### 依赖来源的对应关系

- **第 1 层（9 个）** + **第 2 层（5 个）** + **第 3 层（75 个）** = 89 个 `@deepseek-ai` 包
- 第 3 层的 75 个包 = `dsh-base` bundle 的 `package.json` `dependencies`（77 个）减去第 1 层已含的 2 个 cordis 插件（`cordis-plugin-hmr`、`cordis-plugin-timer`）
- 所有包在 `assistant/package.json` 中以 `"workspace:*"` 引用，通过 dsh 的 pnpm workspace 解析

### 为什么列这么多依赖？

Cordis Loader 从 `cordis.patch.yml`（dsh-base bundle）按裸包名加载插件，每个插件必须能从我们的 `node_modules` 解析。pnpm 的严格隔离意味着只有 `package.json` 显式声明的包才会出现在 `node_modules` 中，因此必须把所有被 Loader 引用的包都列为直接依赖。

### 可裁剪的插件

以下插件对"纯对话数字人"非必需，可在 `cordis.patch.yml` 中禁用（`disabled: true`）：

- `@deepseek-ai/dsh-session-telemetry-otel` — 遥测（已禁用）
- `@deepseek-ai/dsh-skill-badge` — 徽章（已禁用）
- `@deepseek-ai/dsh-llm-pi-ai` — pi-ai 多提供商（休眠）
- `@deepseek-ai/dsh-tool-ralph` — Ralph 循环
- `@deepseek-ai/dsh-tool-workflow` / `@deepseek-ai/dsh-workflow-worker-thread` — 工作流
- `@deepseek-ai/dsh-goal` / `@deepseek-ai/dsh-goal-round-driver` / `@deepseek-ai/dsh-tool-goal` / `@deepseek-ai/dsh-command-goal` — 目标
- `@deepseek-ai/dsh-pwsh-sandbox` / `@deepseek-ai/dsh-tool-pwsh` — Windows 专属
