/**
 * assistant Cordis 插件 — AI 助手的核心
 *
 * 职责:
 *   1. 获取由 agent-loop 创建的专属 Agent (处理竞态: 可能已创建或即将创建)
 *   2. 启动独立监听的交互 Channel 与独立管理 API
 *   3. 提供 ctx.assistant 服务 (供其他插件使用)
 *
 * Agent 由 agent-loop 配置驱动创建 (cordis.patch.yml):
 *   agent-loop.config.agents: [{ id: main, sessionId: assistant-main-session }]
 *
 * 所有 dsh Agent 能力 (session/subagent/llm/tools/skill/preset/compaction/...)
 * 都是原生完整的；这里负责助手产品的通信、环境与通用能力装配。
 *
 * @module assistant/plugin
 */

import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { GenerateOptions } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
// 仅引入类型：把 ctx.systemPrompt / ctx.agents 的声明合并带进作用域
import type {} from '@deepseek-ai/dsh-system-prompt'
import type { Channel, ChannelEndpoint } from './channel/types.js'
import { HttpChannel } from './channel/http-channel.js'
import { StageChannel } from './channel/stage-channel.js'
import { StageRegistry } from './stage/manager.js'
import { AssistantCapabilities } from './service/capabilities.js'
import { AssistantEventHub } from './service/event-hub.js'
import { HttpService } from './service/http-service.js'
import { bindManagementApi } from './service/http-capability-bindings.js'
import { registerMemoryTools } from './memory/tools.js'
import { setMemoriesDir } from './memory/store.js'
import { setTranscriptDir, installTranscriptRecorder } from './memory/transcript.js'
import { installRecallPlugin } from './memory/recall.js'
import { installCompactionHook } from './memory/compaction.js'
import { installIdleCompaction } from './memory/idle.js'
import { bindAgent } from './memory/gate.js'
import { registerKnowledgeTools } from './knowledge/tools.js'
import { registerDrawImageTool } from './media/draw-image-tool.js'
import { registerCodexSpriteTool } from './media/codex-sprite-tool.js'
import type { MediaConfig } from './config/types.js'
import { registerWithConsole } from './registration.js'
import { collectObservability } from './observability.js'
import { enableFullAccess, permissionStatus } from './permissions.js'
import { registerSchedulerTools } from './scheduler/tools.js'
import { ScheduledWakeService } from './scheduler/wake.js'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

// ── 配置记忆系统目录 ───────────────────────────────────────────────────────
// 每个助手的记忆写在它自己的目录下: {dataDir}/memories/。
// dataDir 由 launcher 注入为 ~/.assistant/assistants/{sessionId}/（无兜底，缺失即拒绝启动）。

// ── 配置 ────────────────────────────────────────────────────────────────────

export const name = 'assistant'
export const inject = ['agents', 'sessionProjections', 'tokenMeter', 'attachments', 'compaction', 'llm', 'permissionPresets']

export interface Config {
  port: number
  host: string
  name: string
  /** 控制台地址 (如 http://127.0.0.1:3000), 提供则启动后上报注册 */
  consoleUrl?: string
  /** 专属会话 ID (每个助手唯一且稳定), 由 launcher 派生 */
  sessionId?: string
  /** 本助手独立目录（凭证/会话/记忆/agentMd 都在这下面），由 launcher 注入。 */
  dataDir?: string
  /** 启用的交互 Channel。管理 API 无论是否启用 Channel 都独立运行。 */
  channels?: string[]
  /** 独立 Channel 监听端口；缺省由系统分配。 */
  httpPort?: number
  stagePort?: number
  /** 助手源代码目录（系统信息，由 console spawn 时注入）。 */
  sourceDir?: string
  /** 环境信息描述（公共配置，不可私有覆盖）。 */
  environment?: string
}

// ── 服务接口 ────────────────────────────────────────────────────────────────

export interface AssistantService {
  /** 已就绪的 Agent；resume 完成前访问会抛错，用 whenAgentReady() 等待。 */
  readonly agent: Agent
  readonly name: string
  /** 控制台地址；配置中心插件据此轮询配置。 */
  readonly consoleUrl?: string
  /** 稳定会话 ID。 */
  readonly sessionId: string
  /** agent 就绪后 resolve（resume 读磁盘是异步的）。 */
  whenAgentReady(): Promise<Agent>
  sendMessage(text: string): void
  cancel(): void
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    assistant: AssistantService
  }
}

// ── 插件入口 ────────────────────────────────────────────────────────────────

export function apply(ctx: Context, config: Config): void {
  // 专属会话 ID — 由 launcher 派生 (端口只是 channel，不再作身份来源), 覆盖 patch 里的固定值
  const mainSessionId = SessionId(config.sessionId ?? 'assistant-main-session')

  // ── 同步提供 assistant 服务（agent 延迟绑定）────────────────────────────
  // resume 读磁盘是异步的, 若等 agent 就绪才 provide, 会让依赖 assistant 的
  // 插件 (assistant-config) 在插件树加载时 pending。所以这里同步 provide,
  // agent 用 getter 延迟解析, 消费者通过 whenAgentReady() 等待就绪。
  let agentRef: Agent | undefined
  let stagesRef: StageRegistry | undefined
  let eventHubRef: AssistantEventHub | undefined
  let resolveAgentReady: ((agent: Agent) => void) | undefined
  const agentReady = new Promise<Agent>((resolve) => { resolveAgentReady = resolve })

  ctx.provide('assistant', {
    get agent(): Agent {
      if (agentRef === undefined) throw new Error('assistant agent not ready')
      return agentRef
    },
    name: config.name,
    consoleUrl: config.consoleUrl,
    sessionId: String(config.sessionId ?? 'assistant-main-session'),
    whenAgentReady(): Promise<Agent> {
      return agentReady
    },
    sendMessage(text: string): void {
      if (!text.trim()) return
      stagesRef?.deliverUser(text)
    },
    cancel(): void {
      agentRef?.cancel({ kind: 'user' })
    },
  } satisfies AssistantService)

  // 观测真正送往模型的完整请求。只广播给控制台，不写回 Session，避免让
  // 调试数据反过来污染上下文或破坏 provider 的前缀缓存。
  ctx.on('llm/stream', (options: GenerateOptions, next) => {
    if (options.sessionId === undefined || String(options.sessionId) !== String(mainSessionId)) return next()
    eventHubRef?.emit({
      type: 'model_request',
      data: {
        provider: options.provider,
        model: options.model,
        purpose: options.purpose ?? 'conversation',
        system: options.system ?? '',
        messages: options.messages,
        tools: options.tools ?? [],
        settings: {
          reasoningEffort: options.reasoningEffort,
          temperature: options.temperature,
          maxTokens: options.maxTokens,
          stop: options.stop,
        },
      },
    })
    return next()
  })

  // agent 就绪后填充引用并启动 HTTP（可能已存在, 也可能即将创建）
  const onAgentReady = (agent: Agent): void => {
    if (agentRef !== undefined) return
    agentRef = agent
    resolveAgentReady?.(agent)
    void startServer(ctx, agent, config)
  }

  // 处理竞态: agent-loop 可能已创建 Agent, 或即将创建
  const existing = ctx.agents.get(mainSessionId)
  if (existing) {
    console.log(`[assistant] Agent 已存在: ${existing.id}`)
    onAgentReady(existing)
  } else {
    ctx.on('agent/created', ({ agent }) => {
      if (agent.id !== mainSessionId) return
      console.log(`[assistant] Agent 新建: ${agent.id}`)
      onAgentReady(agent)
    })
  }

  // 优雅关闭
  let serverDispose: (() => Promise<void>) | undefined
  let registrationDispose: (() => void) | undefined
  ctx.effect(() => () => {
    console.log('[assistant] 正在清理...')
    registrationDispose?.()
    return serverDispose?.()
  }, 'assistant.shutdown')

  // ── 启动 HTTP 服务器 ────────────────────────────────────────────────────

  async function startServer(_ctx: Context, agent: Agent, cfg: Config): Promise<void> {
    if (!cfg.dataDir) throw new Error('assistant 缺少 dataDir 配置，拒绝启动（无兜底）')
    const configured = cfg.channels ?? ['http', 'stage']
    const legacy = configured.some(id => ['ws', 'vn', 'ai-town', 'webui', 'web-ui'].includes(id))
    const enabled = new Set(configured.map(id => ['ws', 'vn', 'ai-town'].includes(id) ? 'stage' : ['webui', 'web-ui'].includes(id) ? 'http' : id))
    if (legacy) enabled.add('http')
    for (const id of enabled) {
      if (id !== 'http' && id !== 'stage') throw new Error(`unknown interaction channel: ${id}`)
    }
    bindAgent(agent)
    enableFullAccess(ctx, agent)
    const stages = new StageRegistry(agent, { dataDir: cfg.dataDir })
    await stages.restore()
    stagesRef = stages
    const channels: Channel[] = []
    const endpoints: ChannelEndpoint[] = []
    const scheduledWake = await ScheduledWakeService.create(agent, cfg.dataDir)
    ctx.effect(() => () => scheduledWake.dispose(), 'assistant.scheduler-receiver')
    let idleCompaction: ReturnType<typeof installIdleCompaction> | undefined
    const memoryStatus = () => ({ idleCompaction: idleCompaction?.snapshot() })
    const capabilities = new AssistantCapabilities(agent, stages, {
      name: cfg.name,
      imagesDir: cfg.dataDir ? resolve(cfg.dataDir, 'images') : undefined,
      attachments: ctx.attachments,
      getChannelEndpoints: () => endpoints.map(endpoint => ({ ...endpoint })),
      getMemoryStatus: memoryStatus,
      getPermissions: () => permissionStatus(ctx, agent),
      onScheduledWake: input => scheduledWake.accept(input),
      getRuntimeModel: () => {
        const service = ctx.get('assistantConfig') as
          | { currentModel(): { provider?: string; model?: string } | undefined }
          | undefined
        return service?.currentModel()
      },
      onConfigPush: async (raw) => {
        // 延迟解析：ingest 在 agent 就绪后由 assistant-config 插件提供。
        const service = ctx.get('assistantConfig') as
          | { ingest(raw: unknown): Promise<void> }
          | undefined
        if (!service) throw new Error('config service not ready')
        await service.ingest(raw)
      },
      getObservability: () => ({ ...collectObservability(ctx, agent), memory: memoryStatus() }),
      dshApi: {
        settingsDescribe: () => {
          const settings = ctx.get('settings') as { describe(options?: unknown): unknown } | undefined
          return settings?.describe({ redactSecrets: true }) ?? []
        },
        providers: () => {
          const llm = ctx.get('llm') as { listConfigurableProviders(): unknown } | undefined
          return llm?.listConfigurableProviders() ?? []
        },
        models: async (provider: string) => {
          const llm = ctx.get('llm') as { listModels(provider: string): Promise<unknown> } | undefined
          return llm?.listModels(provider) ?? []
        },
        resolveModel: async (provider: string, model: string) => {
          const llm = ctx.get('llm') as {
            resolveModelInfo(provider: string, model: string): Promise<{ inputModalities?: readonly string[] }>
          } | undefined
          if (!llm) throw new Error('llm service not ready')
          return llm.resolveModelInfo(provider, model)
        },
      },
    })
    const events = new AssistantEventHub(agent)
    eventHubRef = events
    const management = new HttpService({ host: cfg.host, port: cfg.port })
    const disposeManagementApi = bindManagementApi(management, capabilities)
    if (enabled.has('http')) channels.push(new HttpChannel({ host: cfg.host, port: cfg.httpPort ?? 0 }, capabilities, events))
    if (enabled.has('stage')) channels.push(new StageChannel({ host: cfg.host, port: cfg.stagePort ?? 0 }, capabilities, events, stages))
    serverDispose = async () => {
      for (const channel of [...channels].reverse()) await channel.dispose()
      disposeManagementApi()
      await management.dispose()
      events.dispose()
      if (eventHubRef === events) eventHubRef = undefined
      await stages.flush()
      stages.dispose()
      if (stagesRef === stages) stagesRef = undefined
    }
    try {
      for (const channel of channels) endpoints.push(await channel.start())
      await management.listen()
    } catch (error) {
      await serverDispose()
      throw error
    }

    // 环境信息注入系统提示词（源代码目录 + 数据目录 + 环境描述，公共不可覆盖）
    const envLines: string[] = [
      `- 源代码目录: ${cfg.sourceDir ?? '未知'}`,
      `- 数据目录: ${cfg.dataDir ?? '未知'}`,
    ]
    if (cfg.environment && cfg.environment.trim()) {
      envLines.push(`- 环境描述: ${cfg.environment}`)
    }
    agent.ctx.systemPrompt.section({
      name: 'assistant:environment',
      order: -10,
      text: `[环境信息]\n${envLines.join('\n')}`,
    })

    // 每助手独立记忆目录: {dataDir}/memories/（无兜底，缺失即拒绝启动）
    const memoriesDir = resolve(cfg.dataDir, 'memories')
    setMemoriesDir(memoriesDir)
    setTranscriptDir(memoriesDir)

    // 注册私有记忆系统工具到 Agent 的 scoped context
    registerMemoryTools(agent.ctx)
    console.log(`[assistant] 私有记忆系统已就绪, 目录: ${memoriesDir}`)

    // 会话原文记录器 (一份 append-only 可读原文, 记忆条目的 sourceRange 指向它)
    installTranscriptRecorder(ctx, String(mainSessionId), agent.session)

    // 实时召回 (每轮用户消息自动召回相关记忆, 判重注入)
    installRecallPlugin(ctx, String(mainSessionId))

    // 压缩门控绑定主 agent + 压缩记忆化 (含 LLM 提取)
    installCompactionHook(ctx, String(mainSessionId), agent)

    // 闲置压缩 (LLM stop 后闲置 30 分钟主动压缩)
    idleCompaction = installIdleCompaction(ctx, String(mainSessionId), agent)

    // 注册公共知识库工具 (读 + 申请写, 经控制台加锁)
    registerKnowledgeTools(agent.ctx, {
      consoleUrl: cfg.consoleUrl,
      sessionId: String(mainSessionId),
    })
    registerSchedulerTools(agent.ctx, {
      consoleUrl: cfg.consoleUrl,
      sessionId: String(mainSessionId),
      apiKey: process.env.ASSISTANT_CONSOLE_API_KEY,
    })
    scheduledWake.resume()

    // 图片生成工具（draw_image）：懒读 resolved 配置，热切换厂家（minimax / siliconflow）
    registerDrawImageTool(agent.ctx, {
      imagesDir: resolve(cfg.dataDir, 'images'),
      getImageGen: () => {
        try {
          const service = ctx.get('assistantConfig') as { media(): MediaConfig | undefined } | undefined
          return service?.media()?.imageGen
        } catch {
          return undefined
        }
      },
    })

    // 场景角色序列帧工具：通过本机 Codex 调用 imagegen，输出固定 4×4 动画协议。
    registerCodexSpriteTool(agent.ctx, {
      imagesDir: resolve(cfg.dataDir, 'images'),
      codexBin: process.env.CODEX_BIN,
    })

    // 上报注册到控制台 (若配置了 consoleUrl)
    if (cfg.consoleUrl) {
      const registration = await registerWithConsole(cfg.consoleUrl, {
        name: cfg.name,
        host: cfg.host,
        port: cfg.port,
        model: String(agent.options.model ?? 'unknown'),
        provider: String(agent.options.provider ?? 'unknown'),
        sessionId: String(agent.session.id),
        channels: endpoints.map(endpoint => endpoint.id),
        channelEndpoints: endpoints,
      })
      if (registration) registrationDispose = registration.dispose
    }

    console.log(`[assistant] 管理 API 已启动: http://${cfg.host}:${cfg.port}`)
    for (const endpoint of endpoints) console.log(`[assistant] ${endpoint.id} Channel 已启动: ${endpoint.protocol}://${endpoint.host}:${endpoint.port}${endpoint.path}`)
    console.log(`[assistant] 打开浏览器访问 ↑ 即可开始对话`)
    console.log(`[assistant] dsh Agent 能力全开: agent, session, subagent, llm, tools, skill, preset, compaction...`)
  }
}
