# 内核插件版本检查（2026-10-20）

> 对象：`assistant/package.json` 中 94 个 `@deepseek-ai/*` 内核依赖。
> 这些依赖以 `workspace:*` 链接本地内核仓库 `../../deepseek-harness`（本地同级目录）（HEAD `47f9438`，版本号 0.1.0-rc.5，2026-08-13；另有 37 处未提交自定义改动）。
> 上游最新：GitHub `deepseek-ai/deepseek-harness` tag `dsh-v0.2.1-rc.2`（`687f282e`，2026-10-17），距本地 HEAD **10,102 个提交 / 65 天**；桌面端 DeepSeek Harness 已安装 0.2.1-rc.2，内置 296 个内核包同为 0.2.1-rc.2。

## 结论

**是，94 个内核包全部有更新**，但分三条版本线，不能简单理解为"一条命令升级"：

| 分组 | 数量 | 本地版本 | 最新可用版本 | 说明 |
|---|---|---|---|---|
| dsh-* 核心包 | 81 | 0.1.0-rc.5 | **0.2.1-rc.2** | npm `next` 线，与桌面端一致；`latest` 标签多为历史遗留（0.0.1/0.1.0-rc.6），不可作为升级依据 |
| vendor 框架包 | 9 | cordis 4.0.1 等 | **cordis 4.0.5 / cosmokit 1.8.6 / schemastery 3.18.5 / cordis-plugin-* +4 补丁** | 独立版本线，随 0.2.1 一起发布 |
| 已退役 dsh 包 | 4 | 0.1.0-rc.5 | 见下表（0.2.1 线不再发布） | 被新包替代，升级时需从依赖清单移除/替换 |

另外：npm 上 0.1.0-rc.6 发布于 2026-08-13T12:11Z，仅比本地 HEAD 提交晚 **33 分钟**，即 **0.1.0-rc.6 ≈ 当前代码**，升它零风险也零收益；真正的升级目标是 **0.2.1-rc.2**。

## 1. dsh-* 核心包（81 个，均有 0.2.1-rc.2）

| 包 | 本地 | 最新 |
|---|---|---|
| `@deepseek-ai/dsh-agent` | 0.1.0-rc.5 | 0.2.1-rc.2 |
| `@deepseek-ai/dsh-agent-default-model` | 0.1.0-rc.5 | 0.2.1-rc.2 |
| `@deepseek-ai/dsh-agent-instructions` | 0.1.0-rc.5 | 0.2.1-rc.2 |
| `@deepseek-ai/dsh-agent-loop` | 0.1.0-rc.5 | 0.2.1-rc.2 |
| `@deepseek-ai/dsh-api-gateway` | 0.1.0-rc.5 | 0.2.1-rc.2 |
| `@deepseek-ai/dsh-app-boot` | 0.1.0-rc.5 | 0.2.1-rc.2 |
| `@deepseek-ai/dsh-attachment` | 0.1.0-rc.5 | 0.2.1-rc.2 |
| `@deepseek-ai/dsh-attachment-local` | 0.1.0-rc.5 | 0.2.1-rc.2 |
| `@deepseek-ai/dsh-bash-sandbox` | 0.1.0-rc.5 | 0.2.1-rc.2 |
| `@deepseek-ai/dsh-cmdline` | 0.1.0-rc.5 | 0.2.1-rc.2 |
| `@deepseek-ai/dsh-command-compact` | 0.1.0-rc.5 | 0.2.1-rc.2 |
| `@deepseek-ai/dsh-command-feedback` | 0.1.0-rc.5 | 0.2.1-rc.2 |
| `@deepseek-ai/dsh-command-goal` | 0.1.0-rc.5 | 0.2.1-rc.2 |
| `@deepseek-ai/dsh-commands` | 0.1.0-rc.5 | 0.2.1-rc.2 |
| `@deepseek-ai/dsh-compaction` | 0.1.0-rc.5 | 0.2.1-rc.2 |
| `@deepseek-ai/dsh-compaction-basic` | 0.1.0-rc.5 | 0.2.1-rc.2 |
| `@deepseek-ai/dsh-compaction-tool-result-pruner` | 0.1.0-rc.5 | 0.2.1-rc.2 |
| `@deepseek-ai/dsh-credentials-local` | 0.1.0-rc.5 | 0.2.1-rc.2 |
| `@deepseek-ai/dsh-fs-local` | 0.1.0-rc.5 | 0.2.1-rc.2 |
| `@deepseek-ai/dsh-fs-observation-policy` | 0.1.0-rc.5 | 0.2.1-rc.2 |
| `@deepseek-ai/dsh-fs-sandbox` | 0.1.0-rc.5 | 0.2.1-rc.2 |
| `@deepseek-ai/dsh-goal` | 0.1.0-rc.5 | 0.2.1-rc.2 |
| `@deepseek-ai/dsh-goal-round-driver` | 0.1.0-rc.5 | 0.2.1-rc.2 |
| `@deepseek-ai/dsh-home-paths` | 0.1.0-rc.5 | 0.2.1-rc.2 |
| `@deepseek-ai/dsh-jobs-local` | 0.1.0-rc.5 | 0.2.1-rc.2 |
| `@deepseek-ai/dsh-launch-environment` | 0.1.0-rc.5 | 0.2.1-rc.2 |
| `@deepseek-ai/dsh-llm` | 0.1.0-rc.5 | 0.2.1-rc.2 |
| `@deepseek-ai/dsh-llm-deepseek` | 0.1.0-rc.5 | 0.2.1-rc.2 |
| `@deepseek-ai/dsh-llm-pi-ai` | 0.1.0-rc.5 | 0.2.1-rc.2 |
| `@deepseek-ai/dsh-llm-retry` | 0.1.0-rc.5 | 0.2.1-rc.2 |
| `@deepseek-ai/dsh-permission-presets` | 0.1.0-rc.5 | 0.2.1-rc.2 |
| `@deepseek-ai/dsh-plan-mode` | 0.1.0-rc.5 | 0.2.1-rc.2 |
| `@deepseek-ai/dsh-pwsh-sandbox` | 0.1.0-rc.5 | 0.2.1-rc.2 |
| `@deepseek-ai/dsh-repeat-tool-reminder` | 0.1.0-rc.5 | 0.2.1-rc.2 |
| `@deepseek-ai/dsh-sandbox-local` | 0.1.0-rc.5 | 0.2.1-rc.2 |
| `@deepseek-ai/dsh-sandbox-policy` | 0.1.0-rc.5 | 0.2.1-rc.2 |
| `@deepseek-ai/dsh-session` | 0.1.0-rc.5 | 0.2.1-rc.2 |
| `@deepseek-ai/dsh-session-checkpoint-policy` | 0.1.0-rc.5 | 0.2.1-rc.2 |
| `@deepseek-ai/dsh-session-persistence-jsonl` | 0.1.0-rc.5 | 0.2.1-rc.2 |
| `@deepseek-ai/dsh-session-projection` | 0.1.0-rc.5 | 0.2.1-rc.2 |
| `@deepseek-ai/dsh-session-query-sqlite` | 0.1.0-rc.5 | 0.2.1-rc.2 |
| `@deepseek-ai/dsh-session-stats` | 0.1.0-rc.5 | 0.2.1-rc.2 |
| `@deepseek-ai/dsh-session-telemetry-otel` | 0.1.0-rc.5 | 0.2.1-rc.2 |
| `@deepseek-ai/dsh-session-title` | 0.1.0-rc.5 | 0.2.1-rc.2 |
| `@deepseek-ai/dsh-session-title-first-prompt-llm` | 0.1.0-rc.5 | 0.2.1-rc.2 |
| `@deepseek-ai/dsh-settings` | 0.1.0-rc.5 | 0.2.1-rc.2 |
| `@deepseek-ai/dsh-shell-env` | 0.1.0-rc.5 | 0.2.1-rc.2 |
| `@deepseek-ai/dsh-skill` | 0.1.0-rc.5 | 0.2.1-rc.2 |
| `@deepseek-ai/dsh-skill-badge` | 0.1.0-rc.5 | 0.2.1-rc.2 |
| `@deepseek-ai/dsh-skill-filesystem` | 0.1.0-rc.5 | 0.2.1-rc.2 |
| `@deepseek-ai/dsh-spill-local` | 0.1.0-rc.5 | 0.2.1-rc.2 |
| `@deepseek-ai/dsh-spill-policy` | 0.1.0-rc.5 | 0.2.1-rc.2 |
| `@deepseek-ai/dsh-subagent` | 0.1.0-rc.5 | 0.2.1-rc.2 |
| `@deepseek-ai/dsh-subagent-fork-in-process` | 0.1.0-rc.5 | 0.2.1-rc.2 |
| `@deepseek-ai/dsh-subagent-spawn-in-process` | 0.1.0-rc.5 | 0.2.1-rc.2 |
| `@deepseek-ai/dsh-subprocess-local` | 0.1.0-rc.5 | 0.2.1-rc.2 |
| `@deepseek-ai/dsh-system-prompt` | 0.1.0-rc.5 | 0.2.1-rc.2 |
| `@deepseek-ai/dsh-token-meter` | 0.1.0-rc.5 | 0.2.1-rc.2 |
| `@deepseek-ai/dsh-tool-bash` | 0.1.0-rc.5 | 0.2.1-rc.2 |
| `@deepseek-ai/dsh-tool-call-timeout-policy` | 0.1.0-rc.5 | 0.2.1-rc.2 |
| `@deepseek-ai/dsh-tool-fs` | 0.1.0-rc.5 | 0.2.1-rc.2 |
| `@deepseek-ai/dsh-tool-fs-search` | 0.1.0-rc.5 | 0.2.1-rc.2 |
| `@deepseek-ai/dsh-tool-goal` | 0.1.0-rc.5 | 0.2.1-rc.2 |
| `@deepseek-ai/dsh-tool-jobs` | 0.1.0-rc.5 | 0.2.1-rc.2 |
| `@deepseek-ai/dsh-tool-pwsh` | 0.1.0-rc.5 | 0.2.1-rc.2 |
| `@deepseek-ai/dsh-tool-ralph` | 0.1.0-rc.5 | 0.2.1-rc.2 |
| `@deepseek-ai/dsh-tool-skill` | 0.1.0-rc.5 | 0.2.1-rc.2 |
| `@deepseek-ai/dsh-tool-str-replace-editor` | 0.1.0-rc.5 | 0.2.1-rc.2 |
| `@deepseek-ai/dsh-tool-subagent` | 0.1.0-rc.5 | 0.2.1-rc.2 |
| `@deepseek-ai/dsh-tool-subagent-control` | 0.1.0-rc.5 | 0.2.1-rc.2 |
| `@deepseek-ai/dsh-tool-todo` | 0.1.0-rc.5 | 0.2.1-rc.2 |
| `@deepseek-ai/dsh-tool-web` | 0.1.0-rc.5 | 0.2.1-rc.2 |
| `@deepseek-ai/dsh-tool-workflow` | 0.1.0-rc.5 | 0.2.1-rc.2 |
| `@deepseek-ai/dsh-tools` | 0.1.0-rc.5 | 0.2.1-rc.2 |
| `@deepseek-ai/dsh-typert-loader` | 0.1.0-rc.5 | 0.2.1-rc.2 |
| `@deepseek-ai/dsh-typert-registry` | 0.1.0-rc.5 | 0.2.1-rc.2 |
| `@deepseek-ai/dsh-user-approval` | 0.1.0-rc.5 | 0.2.1-rc.2 |
| `@deepseek-ai/dsh-user-questions` | 0.1.0-rc.5 | 0.2.1-rc.2 |
| `@deepseek-ai/dsh-web` | 0.1.0-rc.5 | 0.2.1-rc.2 |
| `@deepseek-ai/dsh-web-fetch-http` | 0.1.0-rc.5 | 0.2.1-rc.2 |
| `@deepseek-ai/dsh-web-search-deepseek` | 0.1.0-rc.5 | 0.2.1-rc.2 |

## 2. vendor 框架包（9 个）

| 包 | 本地 | 最新 |
|---|---|---|
| `@deepseek-ai/cordis` | 4.0.1 | 4.0.5 |
| `@deepseek-ai/cordis-plugin-group` | 1.0.1 | 1.0.5 |
| `@deepseek-ai/cordis-plugin-hmr` | 1.0.16 | 1.0.20 |
| `@deepseek-ai/cordis-plugin-include` | 1.0.6 | 1.0.10 |
| `@deepseek-ai/cordis-plugin-loader` | 1.0.2 | 1.0.6 |
| `@deepseek-ai/cordis-plugin-logger-console` | 1.0.1 | 1.0.5 |
| `@deepseek-ai/cordis-plugin-timer` | 1.1.3 | 1.1.7 |
| `@deepseek-ai/cosmokit` | 1.8.2 | 1.8.6 |
| `@deepseek-ai/schemastery` | 3.18.1 | 3.18.5 |

## 3. 已退役（0.2.1 线无发布，4 个）

| 包 | 本地 | 最后版本 | 上游处置 |
|---|---|---|---|
| `@deepseek-ai/dsh-invariants` | 0.1.0-rc.5 | 0.2.0-rc.2 | 0.2.1-alpha.1 移除运行时 invariant 插件与各包 `./invariant` 导出，连 peerDeps 一起删除 |
| `@deepseek-ai/dsh-settings-file` | 0.1.0-rc.5 | 0.1.5-rc.3 | 由 `dsh-settings` + `dsh-storage`/`storage-json` 替代（本工程本就禁用文件后端） |
| `@deepseek-ai/dsh-tool-subagent-report` | 0.1.0-rc.5 | 0.1.1-rc.2 | 包已删除，报告并入 `dsh-tool-subagent` |
| `@deepseek-ai/dsh-workflow-worker-thread` | 0.1.0-rc.5 | 0.1.5-rc.3 | 由 `dsh-workflow-ptc` 替代 |

## 4. 升级到 0.2.1-rc.2 的主要影响（摘要）

### 4.1 包清单
- dsh-base bundle 直接依赖 **77 → 95**（新增 26、移除 8），`workspace:^` 统一改为 `workspace:*`。
- 新增包示例：`dsh-hmr`（替代 cordis-plugin-hmr）、`dsh-settings`、`dsh-storage`/`dsh-storage-domain`/`dsh-storage-json`、`dsh-plugin-manager`、`dsh-authorization`、`dsh-tool-present`、`dsh-tool-working-directory`、`dsh-mcp-resources`、`dsh-ptc-runtime-node`、`dsh-workflow-ptc`、`dsh-web-deepseek-api`、`dsh-web-fetch-http` 等。
- `dsh-llm-deepseek` 仍发布 0.2.1-rc.2，但已拆分为 `llm-deepseek-api-key` / `llm-deepseek-account` + `deepseek-llm-api-extensions`。

### 4.2 API（本工程具名耦合 37 个符号 / 16 包，实测 33 个兼容，4 个需改）
| 本地用法 | 0.2.1 状态 | 动作 |
|---|---|---|
| `CallId`（dsh-llm） | 改名 `ToolCallId` | 改导入 |
| `effectiveSandboxMode`（dsh-sandbox-policy） | 改名 `setSandboxMode` | 改调用 |
| `effectiveApprovalPolicy`（dsh-user-approval） | 改名 `setApprovalPolicy` | 改调用 |
| `SettingsProvider`（dsh-settings） | 移除，改为 `SettingsForms`/存储域 | 重写 `src/config/settings-provider.ts` |
| `agentLoop.create()` | 变为 async | 改启动流程 |

### 4.3 配置 / 会话格式
- 配置键：`spill-policy.maxInlineBytes` → `maxInlineTokens`；`system-prompt.persona` → `personaPrefix`（+ `personaSuffix`）；`tool-web.search` 失效；`web` 新增 `fetchProvider`；本工程 patch 手工 insert 的 `web-fetch-http` 与 base 内置行重复。
- 会话格式：本地 `SESSION_FORMAT_VERSION = 0` → 上游 **V4**，带 v0→v4 自动迁移链，但**升级后旧内核无法读取新日志（不可降级）**；事件词表删除 `assistant/chunk`、`todo/write`。

### 4.4 本地 37 处自定义改动
- 约 24 处为 docs/README/i18n/快照，可重新生成。
- 3 组核心补丁与上游重写正面冲突：
  1. `agent-loop` 运行时上下文压缩后重投影（未被上游吸收，需按新结构移植）；
  2. `llm-deepseek` data-URL 图片输入（**上游已改为 Messages API + Files API，并新增 `dsh-compaction-image-offload`，建议删除自研补丁**）；
  3. `session-persistence` seed 前缀比较（seed/handle/格式 V4 已重写，需重新评估）。

## 5. 建议

- **只想保持现状**：不需要动。0.1.0-rc.6 与当前代码等价，升级无收益。
- **要与上游/桌面端对齐**：直接切到 tag `dsh-v0.2.1-rc.2`（不要升 rc.6），然后按上表适配；粗估 **4–6 人日**（API/配置适配 1–2d、settings 后端重写 0.5–1d、agent-loop 补丁移植 1–2d、图片补丁删除 0.5d、会话迁移与回归 1d）。
- **上线前必须先做**：在会话副本上验证 V0→V4 迁移；确认可接受"新日志无法回退旧内核"；用 `--dump-config-schema` / `verify-cordis-config` 校验配置；回归图片输入与压缩恢复链路。

## 6. 数据来源

- npm registry：`https://registry.npmjs.org/@deepseek-ai/*`（dist-tags / versions / time），抓取时间 2026-10-20。
- GitHub API：`compare/47f9438...687f282e`、tags、commits search；raw.githubusercontent 对比 `packages/bundle/base/package.json`。
- 桌面端：`/Applications/DeepSeek Harness.app`（0.2.1-rc.2）的 `app.asar` 内置 296 个内核包版本解析。
- 详细上游变更分析：`/tmp/upstream-analysis.md`（108 行，含 31 份 Release 归纳）。
