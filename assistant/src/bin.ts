#!/usr/bin/env node
/**
 * AI 助手进程 — 启动入口（launcher）
 *
 * 流程:
 *   1. 解析 CLI 参数 (--port, --host, --name, --console-url, --session-id...)
 *   2. 若配置了控制台，启动前拉取配置中心的 resolved config
 *   3. 冷字段 (persona/agentMd/maxTokens) 注入 CLI overlay：
 *      - persona     → system-prompt
 *      - agentMd     → 每个助手独立的 $DSH_HOME/AGENTS.md
 *      - maxTokens   → agent-loop agent options
 *   4. provider/model 同时注入 agent-default-model / agent-loop（初始值），
 *      运行时热切换由 assistant-config 插件负责
 *   5. 凭证文件按助手隔离：credentials-local path → data/credentials/{sessionId}.yaml
 *   6. boot() 启动 Cordis 插件树，agent-loop 恢复或创建专属 Agent
 *
 * 用法:
 *   node lib/bin.js --port 3001 --name "我的助手"
 *   tsx src/bin.ts --port 3001 --console-url http://127.0.0.1:3000
 *
 * @module assistant/bin
 */

import { resolve, dirname } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import {
  boot,
  installFailLoud,
  loadOverlayPatches,
} from '@deepseek-ai/dsh-app-boot'
import type { PatchOptions } from '@deepseek-ai/cordis-plugin-include'
import { createLaunchEnvironmentSnapshot, DSH_LAUNCH_ENVIRONMENT_KEY } from '@deepseek-ai/dsh-launch-environment'
import { provideCmdline } from '@deepseek-ai/dsh-cmdline'
import { CONFIGURED_AGENT_IDENTITIES_KEY } from '@deepseek-ai/dsh-agent-loop'
import { SessionId } from '@deepseek-ai/dsh-session'
import { fetchResolvedConfig } from './config/fetch.js'
import type { AssistantConfig, PiAiProviderSettings, ProviderSettings } from './config/types.js'
import { addWebSearchCredential } from './config/apply/web-search.js'

// ── 路径解析 ───────────────────────────────────────────────────────────────

const ROOT_DIR = dirname(fileURLToPath(import.meta.url))
const ASSISTANT_DIR = resolve(ROOT_DIR, '..')
// 每个助手一个独立目录：~/.assistant/assistants/{sessionId}/。
// 助手的全部落盘文件（凭证/会话/记忆/agentMd）都写在这个目录里，
// 与控制台目录（~/.assistant/console/）及其它助手目录完全隔离。
const ASSISTANTS_ROOT = resolve(homedir(), '.assistant', 'assistants')
const CORDIS_PATH = resolve(ASSISTANT_DIR, 'cordis.yml')
const OUR_PATCH_PATH = resolve(ASSISTANT_DIR, 'cordis.patch.yml')
const DSH_ROOT = resolve(ASSISTANT_DIR, '..', '..', '..', 'deepseek-harness')
// bareModuleBaseUrl 必须指向我们的 node_modules，我们的 dsh 包在这里
const OUR_MODULES = resolve(ASSISTANT_DIR, 'node_modules')

const DEFAULT_DEEPSEEK_API_KEY_ENV = 'DEEPSEEK_API_KEY'
/** agentMd 注入走 agent-instructions 的 user-global AGENTS.md，预算放宽到 1MB。 */
const AGENT_INSTRUCTIONS_MAX_BYTES = 1_000_000

// ── CLI 参数解析 ───────────────────────────────────────────────────────────

interface AssistantArgs {
  port: number
  httpPort?: number
  stagePort?: number
  host: string
  name: string
  provider?: string
  model?: string
  persona?: string
  maxTokens?: number
  consoleUrl?: string
  sessionId?: string
  channels?: string[]
  sourceDir?: string
}

function parseArgs(argv: string[]): AssistantArgs {
  const args: AssistantArgs = { port: 3001, host: '127.0.0.1', name: 'AI 助手' }
  for (let i = 0; i < argv.length; i++) {
    const val = argv[i + 1]
    switch (argv[i]) {
      case '--port': args.port = parseInt(val, 10); i++; break
      case '--http-port': args.httpPort = parseInt(val, 10); i++; break
      case '--stage-port': args.stagePort = parseInt(val, 10); i++; break
      case '--host': args.host = val; i++; break
      case '--name': args.name = val; i++; break
      case '--provider': args.provider = val; i++; break
      case '--model': args.model = val; i++; break
      case '--persona': args.persona = val; i++; break
      case '--max-tokens': args.maxTokens = parseInt(val, 10); i++; break
      case '--console-url': args.consoleUrl = val; i++; break
      case '--session-id': args.sessionId = val; i++; break
      case '--channels': args.channels = val.split(',').filter(Boolean); i++; break
      case '--source-dir': args.sourceDir = val; i++; break
      case '--help':
        console.log('用法: assistant [选项]')
        console.log('  --port <port>          管理 API 端口 (默认: 3001)')
        console.log('  --http-port <port>     HTTP 会话端口 (默认: 系统分配)')
        console.log('  --stage-port <port>    Stage 交互端口 (默认: 系统分配)')
        console.log('  --host <host>          HTTP 地址 (默认: 127.0.0.1)')
        console.log('  --name <name>          助手名称 (默认: AI 助手)')
        console.log('  --provider <provider>  LLM 提供商（必填，无兜底）')
        console.log('  --model <model>        模型（必填，无兜底）')
        console.log('  --persona <persona>    系统人设')
        console.log('  --max-tokens <n>       最大输出 token')
        console.log('  --console-url <url>    控制台地址（必填，配置中心为唯一事实源）')
        console.log('  --session-id <id>      稳定会话 ID (默认随机; 重启 resume 需显式传入)')
        console.log('  --channels <a,b>       启用交互 Channel (默认: http,stage；空值关闭全部)')
        console.log('  --source-dir <dir>     助手源代码目录（系统信息）')
        process.exit(0)
    }
  }
  return args
}

// ── 启动前配置准备 ─────────────────────────────────────────────────────────

interface PreparedConfig {
  remote: AssistantConfig | null
  /** 本助手独立目录（凭证/会话/记忆/agentMd 都在这下面）。 */
  assistantDir: string
  agentMdHome: string
  credentialsPath: string
  sessionsDir: string
}

async function prepareConfig(cliArgs: AssistantArgs, sessionId: string): Promise<PreparedConfig> {
  const assistantDir = resolve(ASSISTANTS_ROOT, sessionId)
  const agentMdHome = resolve(assistantDir, 'home')
  const credentialsPath = resolve(assistantDir, 'credentials.yaml')
  const sessionsDir = resolve(assistantDir, 'sessions')

  await mkdir(assistantDir, { recursive: true })

  let remote: AssistantConfig | null = null
  if (cliArgs.consoleUrl) {
    const envelope = await fetchResolvedConfig(cliArgs.consoleUrl, sessionId, 2500, { throwOnError: true })
      .catch(error => {
        const detail = error instanceof Error ? error.message : String(error)
        throw new Error(`读取配置中心失败: ${cliArgs.consoleUrl} (session=${sessionId}): ${detail}，拒绝启动`, { cause: error })
      })
    if (!envelope) {
      // 无兜底：配置中心是唯一事实源，不可达或响应非法直接拒绝启动，立刻暴露问题。
      throw new Error(`配置中心不可达或响应非法: ${cliArgs.consoleUrl} (session=${sessionId})，拒绝启动`)
    }
    remote = envelope.config
    console.log(`[assistant:${cliArgs.name}] 已从配置中心获取有效配置 (session=${sessionId})`)
  }

  if (remote) {
    // 冷字段 agentMd → 每助手独立的 user-global AGENTS.md。
    // 有 console 配置时固定 patch agent-instructions 的 dshHome，避免读取 ~/.dsh/AGENTS.md。
    await mkdir(agentMdHome, { recursive: true })
    const agentMdFile = resolve(agentMdHome, 'AGENTS.md')
    if (typeof remote.agentMd === 'string' && remote.agentMd.trim()) {
      await writeFile(agentMdFile, remote.agentMd, 'utf-8')
    } else {
      await rm(agentMdFile, { force: true })
    }

    // 供应商密钥预写入隔离的凭证文件（每供应商一个 apiKeyEnv），
    // 保证 agent 创建后的第一个 LLM 请求即可用；运行时变更由
    // assistant-config 插件通过 ctx.credentials.set 热切换。
    const credentialEntries = collectProviderCredentials(remote.providers)
    addWebSearchCredential(credentialEntries, remote.webSearch, remote.providers)
    await writeCredentialsFile(credentialsPath, credentialEntries)
  }

  return { remote, assistantDir, agentMdHome, credentialsPath, sessionsDir }
}


function collectProviderCredentials(providers: ProviderSettings | undefined): Map<string, string> {
  const out = new Map<string, string>()
  const deepseek = providers?.deepseek
  if (deepseek?.apiKey !== undefined) {
    out.set(deepseek.apiKeyEnv || DEFAULT_DEEPSEEK_API_KEY_ENV, deepseek.apiKey)
  }
  for (const profile of Object.values(providers?.piAi?.providers ?? {})) {
    if (profile.apiKey === undefined) continue
    if (!profile.apiKeyEnv) {
      console.warn(`[assistant] pi-ai 供应商缺少 apiKeyEnv，忽略其 apiKey`)
      continue
    }
    out.set(profile.apiKeyEnv, profile.apiKey)
  }
  return out
}

async function writeCredentialsFile(path: string, entries: Map<string, string>): Promise<void> {
  const lines: string[] = []
  for (const [ref, value] of entries) {
    if (value.length === 0) continue
    lines.push(`${ref}: ${JSON.stringify(value)}`)
  }
  if (lines.length === 0) {
    await rm(path, { force: true })
    return
  }
  // credentials-local 要求凭证文件 owner-only, 否则拒绝加载
  await writeFile(path, lines.join('\n') + '\n', { encoding: 'utf-8', mode: 0o600 })
}

function deepseekPluginConfig(config: ProviderSettings['deepseek']): Record<string, unknown> {
  if (!config) return {}
  const out: Record<string, unknown> = {}
  for (const key of [
    'apiKeyEnv',
    'baseURL',
    'thinking',
    'reasoningEffort',
    'maxTokens',
    'defaultContextWindow',
    'models',
    'streamIdleTimeoutMs',
  ] as const) {
    if (config[key] !== undefined) out[key] = config[key]
  }
  return out
}

function piAiPluginConfig(providers: Record<string, PiAiProviderSettings> | undefined): { providers: Record<string, unknown> } {
  if (!providers) return { providers: {} }
  const out: Record<string, unknown> = {}
  for (const [route, profile] of Object.entries(providers)) {
    const section: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(profile)) {
      if (key === 'apiKey') continue
      section[key] = value
    }
    out[route] = section
  }
  return { providers: out }
}

// ── 主入口 ─────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const cliArgs = parseArgs(process.argv.slice(2))
  const BIN_NAME = `assistant:${cliArgs.name}`

  // 1. 无兜底：apiKey 只来自配置中心（经 HTTP 下发写入隔离凭证文件），
  //    不再读取 assistant/.env 作为 credential 回退源。

  // 2. 会话 ID — 每个助手唯一且稳定。端口只是众多 channel 之一，不再是身份来源；
  //    默认随机生成，重启要 resume 同一会话需显式传 --session-id。
  const sessionId = cliArgs.sessionId ?? `assistant-${randomUUID().slice(0, 8)}`

  // 3. 从配置中心拉取有效配置（含冷字段预注入准备）
  const { remote, assistantDir, agentMdHome, credentialsPath, sessionsDir } = await prepareConfig(cliArgs, sessionId)

  // 4. 加载 dsh-base bundle 补丁 (所有 dsh 核心插件)
  const basePatchPath = resolve(DSH_ROOT, 'packages', 'bundle', 'base', 'cordis.patch.yml')
  const basePatches = loadOverlayPatches(BIN_NAME, basePatchPath)

  // 5. 加载我们自己的补丁
  const ourPatches = loadOverlayPatches(BIN_NAME, OUR_PATCH_PATH)

  // 6. CLI / 配置中心 overlay (最后面的叠加层，优先级最高)
  // 无兜底：provider/model 必须由配置中心（remote 或 spawn 参数）显式提供，缺失即拒绝启动。
  const provider = remote?.provider ?? cliArgs.provider
  const model = remote?.model ?? cliArgs.model
  if (!provider || !model) {
    throw new Error(`缺少 provider/model 配置 (provider=${provider ?? '<空>'}, model=${model ?? '<空>'})，拒绝启动（无兜底）`)
  }
  const persona = remote?.persona ?? cliArgs.persona
  const maxTokens = remote?.maxTokens ?? cliArgs.maxTokens
  // 环境信息描述：公共专用字段，只来自配置中心（不可被私有覆盖）
  const environment = remote?.environment

  const cliOverlay: PatchOptions[] = [{
    id: 'agent-default-model',
    config: { provider, model },
  }, {
    id: 'agent-loop',
    config: {
      agents: [{
        id: 'main',
        sessionId,
        cwd: assistantDir,
        provider,
        model,
        ...(maxTokens !== undefined && Number.isFinite(maxTokens) && maxTokens > 0
          ? { maxTokens }
          : {}),
      }],
    },
  }, {
    id: 'session-persistence-jsonl',
    config: { root: sessionsDir },
  }, {
    // 会话投影缓存 / workspace 等 KV 存储也落在助手自己的目录。
    id: 'storage-json',
    config: { root: resolve(assistantDir, 'storage') },
  }, {
    // 图片附件等持久化字节落在助手自己的目录。
    id: 'attachment-local',
    config: { dshHome: assistantDir },
  }, {
    id: 'credentials',
    config: { path: credentialsPath },
  }, {
    id: 'assistant',
    config: {
      port: cliArgs.port,
      host: cliArgs.host,
      name: cliArgs.name,
      consoleUrl: cliArgs.consoleUrl,
      sessionId,
      dataDir: assistantDir,
      channels: cliArgs.channels ?? ['http', 'stage'],
      httpPort: cliArgs.httpPort,
      stagePort: cliArgs.stagePort,
      sourceDir: cliArgs.sourceDir,
      environment,
    },
  }, {
    // 工作空间兜底：无 cwd 的会话（老会话 resume）也落在 data 目录，
    // 而不是 base bundle 里的 process.cwd()（代码目录）。
    id: 'sandbox-policy',
    config: { workspaceRoot: assistantDir, mode: 'danger-full-access' },
  }, {
    id: 'approval',
    config: { policy: 'never' },
  }, {
    id: 'permission',
    config: { defaultPreset: 'danger-full-access' },
  }]

  if (persona !== undefined) {
    cliOverlay.push({ id: 'system-prompt', config: { persona } })
  }

  if (remote?.providers) {
    // 直接使用 dsh 模型配置插件：把供应商配置作为 composition 层注入，
    // 运行时可继续经 settings 热更新。
    const deepseek = deepseekPluginConfig(remote.providers.deepseek)
    if (Object.keys(deepseek).length > 0) {
      cliOverlay.push({ id: 'llm-deepseek', config: deepseek })
    }
    const piAi = piAiPluginConfig(remote.providers.piAi?.providers)
    cliOverlay.push({ id: 'llm-pi-ai', config: piAi })
  }

  if (remote) {
    cliOverlay.push({
      id: 'agent-instructions',
      config: {
        dshHome: agentMdHome,
        maxBytes: AGENT_INSTRUCTIONS_MAX_BYTES,
      },
    })
  }

  // 7. 安装 fail-loud 处理
  installFailLoud(BIN_NAME)

  // 8. 启动 Cordis 插件树
  const ctx = await boot(
    BIN_NAME,
    CORDIS_PATH,
    [...basePatches, ...ourPatches, ...cliOverlay],
    (hostCtx) => {
      // 环境快照 — 只提供进程环境，不注入 .env 回退源（无兜底）。
      hostCtx.provide(DSH_LAUNCH_ENVIRONMENT_KEY, createLaunchEnvironmentSnapshot([
        { source: 'process', values: { ...process.env } as Record<string, string> },
      ]))
      // 命令行参数 — 可供插件注入读取
      provideCmdline(hostCtx, { args: [], exit: (code) => process.exit(code) })
      // Launcher 持有的会话身份 — 覆盖 cordis.patch.yml 里的固定 sessionId
      // resume:false → 走 restore-or-create (有历史则 resume, 无则新建)
      hostCtx.provide(CONFIGURED_AGENT_IDENTITIES_KEY, {
        main: { id: SessionId(sessionId), resume: false },
      })
    },
    pathToFileURL(OUR_MODULES).href,  // bareModuleBaseUrl → Loader 从我们的 node_modules 解析插件
  )

  // 9. 进程生命周期
  console.log(`[${BIN_NAME}] 插件树已就绪`)

  let exiting = false
  const shutdown = async () => {
    if (exiting) return
    exiting = true
    console.log(`[${BIN_NAME}] 正在关闭...`)
    await ctx.fiber.dispose()
    process.exit(0)
  }
  process.on('SIGTERM', shutdown)
  process.on('SIGINT', shutdown)
}

main().catch((error) => {
  console.error('[assistant] 启动失败:', error instanceof Error ? error.message : String(error))

  // 展开 AggregateError 链，打印每个失败插件的具体错误
  function logErrors(err: unknown, depth: number): void {
    if (depth > 5) return
    if (err instanceof AggregateError) {
      console.error(`${'  '.repeat(depth)}AggregateError: ${err.errors.length} errors`)
      for (const e of err.errors) {
        console.error(`${'  '.repeat(depth)}  - ${e instanceof Error ? e.message : String(e)}`)
        if (e instanceof Error && e.cause) logErrors(e.cause, depth + 1)
      }
    }
    if (err instanceof Error && (err as any).cause) {
      logErrors((err as any).cause, depth + 1)
    }
  }

  logErrors(error, 0)
  process.exit(1)
})
