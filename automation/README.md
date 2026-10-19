# 自动化验证（automation）

`automation/` 是本仓库的**回归验证与内核升级工具集**。目标只有一个：

> 升级 dsh 内核或调整依赖后，用最少的命令确认「控制台 + 助手」没有回归。

全部脚本零第三方依赖，直接使用 Node 22+ 内置能力运行；输出默认面向人，加 `--json` 面向机器（可接 CI）。

---

## 快速开始

```bash
# 1. 环境与依赖链接是否健康（换机器 / 新克隆后先跑这个）
node automation/setup-links.mjs --check

# 2. 一次跑完 类型检查 + 全部测试（assistant 49 项 + console 13 项）
node automation/verify.mjs

# 3. 提交前安全扫描（verify 默认也会执行）
node automation/check-secrets.mjs

# 4. 看看内核/依赖有没有新版本
node automation/check-updates.mjs
```

正常输出示例：

```
测试合计：62 通过 / 0 失败 / 62 项 · 总耗时 1.9s
✔ 验证通过
```

退出码：`0` 通过，`1` 有失败/回归，`2` 环境或脚本异常。

---

## 脚本

### `verify.mjs` —— 回归验证

| 步骤 | assistant | console |
| --- | --- | --- |
| TypeScript 类型检查 | `tsc --noEmit` | `tsc --noEmit` |
| 测试（自动发现） | `node --import tsx --test "src/**/*.test.ts"` | 同左 |

特性：

- **自动发现测试文件**，不再依赖 `package.json` 里手写的文件清单；同时会对比 `npm test` 脚本，**新增测试漏登记会给出警告**。
- 读取 `kernel-pin.json`：内核 HEAD 与 pin 不一致时提醒；测试通过数低于 `baselines` 时判定为疑似回归。
- 检查 `node_modules/@deepseek-ai/*` 链接健康度，链接失效时直接给出修复命令。
- 支持 `--only assistant|console`、`--no-typecheck`、`--json`、`--kernel <目录>`。

### `check-updates.mjs` —— 依赖版本巡检

- 读取 `assistant/package.json` 的 94 个内核包 + 7 个第三方依赖，逐一查询 npm registry。
- 展示 `latest` / `next` / `alpha` 标签，并区分「候选升级线」与「退役/独立版本线」。
- 对本地未发布的开发快照、实际安装版本不满足声明范围（pnpm 提升导致）等情况给出提示。
- 结果缓存到 `automation/.cache/`，默认 6 小时；`--refresh` 强制刷新，`--offline` 离线读缓存。
- `--fail-on-update` 可用于流水线门禁；`--all` 打印全部内核包明细。

> 注意：dsh 的 npm `latest` 标签存在历史遗留（部分包停在 `0.0.1-rc.1`），不要把 `latest` 当作唯一升级依据。脚本会以「实际最大版本」给出候选线。

### `check-secrets.mjs` —— 安全扫描

提交/推送前扫描**已跟踪文件**，拦截密钥、私钥、敏感文件与本机隐私路径：

- 高危（退出码 1）：私钥块、`sk-*` / GitHub Token / AWS / Google / Slack / JWT、`ask_*` 平台 Key、`Bearer` 实值、密钥变量赋值（带熵过滤，排除代码表达式）；`.env`、`*.pem`、`*.p12`、`*.mobileprovision`、`*.sqlite`、`*.ipa` 等文件一旦被跟踪也会报错。
- 警告：`/Users/<name>/`、`/home/<name>/`、`C:\\Users\\...`、设备 UDID 等本机隐私信息（`--strict` 下同样失败）。
- `--all` 同时扫描未跟踪但未忽略的文件；`--json` 输出机器可读结果；`verify.mjs` 默认会执行本扫描，可用 `--no-secrets` 跳过。

> 这是仓库自检，不能替代 GitHub 的 Secret Scanning / Push Protection；发现密钥曾经推送时，必须在服务端吊销并清理历史，而不是只删文件。

### `setup-links.mjs` —— 依赖链接重建

本工程的 `workspace:*` 依赖实际由 `node_modules/@deepseek-ai/*` 指向本地 `deepseek-harness` 源码目录（软链）。换机器、CI 或切换内核目录后，用本脚本重建：

```bash
node automation/setup-links.mjs --apply                              # 按默认内核目录重建
node automation/setup-links.mjs --kernel ../deepseek-harness-next --apply  # 指向候选内核
node automation/setup-links.mjs --check                              # 只检查
node automation/setup-links.mjs --apply --dry-run                    # 只打印计划
```

- 扫描内核仓库全部 package（`packages/*/*`、`vendor/*`、`apps/*`、`native/...`）建立包名 → 目录映射。
- 第三方依赖（express / ws / tsx / typescript / @types/*）从内核 pnpm store 解析。
- 只删除并重建**符号链接**，拒绝覆盖真实目录；重建后写 `node_modules/.automation-links.json` 清单。
- 内核里已删除的包会报错，提示同步修改 `assistant/package.json`。

---

## 内核升级 SOP

```bash
# 0. 看有哪些新版本（以及新版本落在哪条线）
node automation/check-updates.mjs

# 1. 准备候选内核：本地 deepseek-harness 切到目标 tag/提交（或克隆到新目录）
#    git -C ../../deepseek-harness checkout dsh-v0.2.1-rc.2

# 2. 重建依赖链接（--kernel 可指向任意内核目录）
node automation/setup-links.mjs --apply --kernel ../../deepseek-harness

# 3. 跑回归（类型检查 + 62 项测试）
node automation/verify.mjs

# 4. 通过后同步锁定信息
#    修改 automation/kernel-pin.json：commit / shortCommit / version / baselines
```

回滚：

```bash
git -C ../../deepseek-harness checkout <旧提交>
node automation/setup-links.mjs --apply
node automation/verify.mjs
```

## 目录结构

```
automation/
├── verify.mjs            # 回归验证入口（安全扫描 + 类型检查 + 测试 + 基线比对）
├── check-secrets.mjs     # 安全扫描（密钥 / 敏感文件 / 本机路径）
├── check-updates.mjs     # npm 版本巡检（内核 / vendor / 第三方）
├── setup-links.mjs       # node_modules 链接重建
├── kernel-pin.json       # 内核锁定信息与测试基线
├── lib/
│   ├── util.mjs          # 路径 / 参数 / 进程 / 表格
│   ├── semver.mjs        # 轻量 SemVer
│   └── registry.mjs      # npm registry 访问 + 缓存
└── .cache/               # registry 缓存（已 gitignore）
```

## 常见问题

| 现象 | 原因 / 处理 |
| --- | --- |
| `node_modules/@deepseek-ai` 链接失效 | 内核目录移动或内核升级；运行 `setup-links.mjs --apply` |
| 测试报 `EPERM`（监听本机端口失败） | 受限沙箱禁止监听端口；给 Node 放行本机监听权限后重跑 |
| `verify` 提示「通过数低于基线」 | 有测试被删/跳过；确认是预期变更后更新 `kernel-pin.json` 的 `baselines` |
| `check-updates` 提示本地版本未发布 | 本地内核是开发快照（如 `0.1.0-rc.5`）；以 `kernel-pin.json` 为准 |
| 第三方依赖「声明范围不满足」 | 实际版本由 dsh workspace 提升决定（如 typescript 6.x）；升级时统一调整声明 |
| 安全扫描提示本机路径 | 把 `/Users/<name>/...` 改为 `~/...` 或仓库内相对路径；不要提交个人目录、设备 UDID |
| 安全扫描提示密钥 | 立即删除/替换；若已推送，先吊销密钥再清理历史，并检查服务端是否已有滥用 |
