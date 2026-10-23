/**
 * 上下文快照 — 把 dsh 已经算好的 token-meter / session 投影折叠成「上下文浏览器」数据。
 *
 * 数据来源都是 dsh 原生能力，本模块只做读取与归类，不重复实现计量：
 *   - tokenMeter.measure(session): 当前 surface 每个节点的精确启发式 token
 *   - contextPressure:           上下文窗口与当前占用
 *   - contextBreakdown:          系统提示词 / 工具定义 / 消息的 token 分项
 *   - tokenUsage / sessionStats: 实际用量与会话统计
 *   - session.events:            request/header（系统提示词 + 工具 schema）、消息内容、压缩/剪枝事件
 *
 * 节点 id 约定（供 /api/context/node 读取完整内容）：
 *   - `system`                    当前系统提示词
 *   - `tool-schema:<name>`        某个工具的完整 JSON schema
 *   - `evt:<seq>`                 某个持久事件（用户消息 / 助手回复 / 工具结果 / 注入…）
 *
 * @module assistant/context-inspector
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
// Type-only: 激活 ctx.sessionProjections 及投影 key 声明合并
import type {} from '@deepseek-ai/dsh-session-projection'
// Type-only: 激活 ctx.tokenMeter 及 tokenUsage/contextPressure/contextBreakdown 声明
import type {} from '@deepseek-ai/dsh-token-meter'
// Type-only: 激活 sessionStats projection key 声明
import type {} from '@deepseek-ai/dsh-session-stats'

/** 与 dsh-context 对齐的上下文分类。 */
export type ContextCategory = 'system' | 'tools' | 'user' | 'inject' | 'skill' | 'assistant' | 'tool'

export const CONTEXT_CATEGORY_LABELS: Record<ContextCategory, string> = {
  system: '系统提示词',
  tools: '工具定义',
  user: '用户消息',
  inject: '注入上下文',
  skill: '技能注入',
  assistant: '助手回复',
  tool: '工具结果',
}

const GROUP_ORDER: readonly ContextCategory[] = ['system', 'tools', 'user', 'inject', 'skill', 'assistant', 'tool']
const PREVIEW_LIMIT = 240
const DETAIL_TEXT_LIMIT = 1_000_000
const MAX_ITEMS_PER_GROUP = 600
const MAX_REQUESTS = 300
const MAX_EVENTS = 200

/** 一个可展开的上下文节点（快照里只带预览，完整内容走 /api/context/node）。 */
export interface ContextItem {
  id: string
  kind: ContextCategory
  seq?: number
  title: string
  subtitle?: string
  tokens: number
  preview: string
  truncated: boolean
  estimated?: boolean
  /** 助手特色分类，供 UI 标记。 */
  feature?: ContextFeature
  meta?: Record<string, unknown>
}

export interface ContextGroup {
  key: ContextCategory
  label: string
  tokens: number
  items: ContextItem[]
  /** 超出上限被丢弃的节点数。 */
  dropped: number
}

/** 助手自己的上下文特色：记忆召回、Stage 场景、定时任务、知识库、压缩摘要、技能。 */
export type ContextFeature = 'memory' | 'stage' | 'schedule' | 'knowledge' | 'compact' | 'skill' | 'other'

export interface ContextEvent {
  seq: number
  time?: number
  kind: 'inject' | 'compaction' | 'prune' | 'model' | 'mode'
  label: string
  detail?: string
  tokens?: number
  /** 注入事件的特色分类。 */
  feature?: ContextFeature
  /** 可在上下文浏览器里定位到的节点 id。 */
  itemId?: string
}

export interface ContextRequest {
  seq: number
  time?: number
  turn?: number
  step?: number
  provider?: string
  model?: string
  /** 输入侧实际 token（input + cacheRead + cacheWrite）。 */
  prompt?: number
  output?: number
  cacheRead?: number
  /** 打开本轮的用户输入（截断预览）。 */
  userText?: string
  /** 本次回复的文本预览。 */
  assistantText?: string
}

export interface ContextSnapshot {
  generatedAt: number
  eventCount: number
  model: {
    provider: string
    model: string
    contextWindow?: number
    maxOutputTokens?: number
  }
  occupancy: {
    usedTokens: number
    contextWindow?: number
    percent?: number
    remainingTokens?: number
  }
  current: Record<ContextCategory, number> & { total: number; categorized: number }
  tokens: {
    uncachedInput: number
    cacheRead: number
    cacheWrite: number
    output: number
    cacheHitRate: number
    totalTokens: number
    surfaceTokens: number
  }
  stats: {
    turns: number
    steps: number
    requests: number
    humanInputs: number
    assistantMessages: number
    toolCalls: number
    toolResults: number
    skills: number
    compactions: number
    prunes: number
    modelSwitches: number
    injections: number
  }
  groups: ContextGroup[]
  events: ContextEvent[]
  requests: ContextRequest[]
  /** 全量会话里的输入输出与工具调用计数。 */
  usage: {
    userInputs: number
    assistantReplies: number
    reads: number
    writes: number
    searches: number
    images: number
    skillsLoaded: number
    toolCalls: number
    toolCallsByTool: Array<{ name: string; count: number }>
  }
  /** 耗时统计（来自 sessionStats / tokenUsage）。 */
  timing: {
    llmMs: number
    toolMs: number
    ttftMs: number
    decodeMs: number
    decodeTokens: number
    outputTokens: number
    tokensPerSecond: number
    avgTtftMs: number
    activeMs: number
  }
  /** 当前上下文里助手特色注入的计数。 */
  features: Record<ContextFeature, number>
  /** 文件活动（读/写/搜索/图片 + 行数变化），按最近使用排序。 */
  files: ContextFileActivity[]
  /** 事件筛选计数（全量历史）。 */
  eventCounts: Record<ContextEvent['kind'], number>
}

export interface ContextFileActivity {
  path: string
  reads: number
  writes: number
  searches: number
  images: number
  added: number
  removed: number
  lastSeq?: number
  lastTime?: number
}

export interface ContextNode {
  id: string
  kind: ContextCategory | 'tool-schema'
  title: string
  subtitle?: string
  tokens?: number
  text: string
  truncated: boolean
  raw?: unknown
}

type RawEvent = { type: string; seq: number; time?: number; data?: any; surfaceOp?: unknown; sourceEventSeqs?: number[] }
type CacheEntry = { eventCount: number; headerSeq: number; modelKey: string; snapshot: ContextSnapshot }

/** 会话事件数不变时复用快照；事件追加后自然失效。 */
const snapshotCache = new WeakMap<Session, CacheEntry>()

/** 收集当前会话的完整上下文快照；runtimeModel 为配置中心当前生效的模型（热切换后优先）。 */
export function collectContextSnapshot(
  ctx: Context,
  agent: Agent,
  runtimeModel?: { provider?: string; model?: string },
): ContextSnapshot {
  const session = agent.session
  const events = session.events as unknown as readonly RawEvent[]
  const headerEvents = events.filter(event => event.type === 'request/header')
  const latestHeaderEvent = headerEvents.at(-1)
  const headerSeq = latestHeaderEvent?.seq ?? -1
  const modelKey = `${runtimeModel?.provider ?? ''}/${runtimeModel?.model ?? ''}`
  const cached = snapshotCache.get(session)
  if (cached !== undefined
    && cached.eventCount === events.length
    && cached.headerSeq === headerSeq
    && cached.modelKey === modelKey) {
    return cached.snapshot
  }

  const snapshot = buildSnapshot(ctx, agent, events, runtimeModel)
  snapshotCache.set(session, { eventCount: events.length, headerSeq, modelKey, snapshot })
  return snapshot
}

/** 读取一个节点的完整内容（点击上下文条目时按需请求）。 */
export function readContextNode(ctx: Context, agent: Agent, id: string): ContextNode | null {
  const events = agent.session.events as unknown as readonly RawEvent[]
  const header = readHeader(events)

  if (id === 'system') {
    const system = typeof header?.data?.header?.system === 'string' ? header.data.header.system : ''
    const breakdown = readProjections(ctx, agent).breakdown
    const tokens = breakdown?.systemTokens ?? estimateTextTokens(system)
    return {
      id,
      kind: 'system',
      title: '系统提示词',
      tokens,
      text: system || '(当前没有系统提示词)',
      truncated: false,
      raw: header?.data?.header ?? null,
    }
  }

  if (id.startsWith('tool-schema:')) {
    const name = id.slice('tool-schema:'.length)
    const tools = Array.isArray(header?.data?.header?.tools) ? header.data.header.tools : []
    const tool = tools.find((entry: any) => entry?.name === name)
    if (!tool) return null
    const text = JSON.stringify(tool, null, 2)
    return {
      id,
      kind: 'tool-schema',
      title: `工具定义 · ${name}`,
      subtitle: typeof tool.description === 'string' ? tool.description : undefined,
      tokens: estimateTextTokens(text),
      text,
      truncated: false,
      raw: tool,
    }
  }

  if (id.startsWith('evt:')) {
    const seq = Number(id.slice('evt:'.length))
    if (!Number.isFinite(seq)) return null
    const event = events.find(item => item.seq === seq)
    if (event === undefined) return null
    const callNames = buildCallNames(events)
    const category = categorize(event)
    const text = renderEventText(event, category, callNames)
    const truncated = text.length > DETAIL_TEXT_LIMIT
    return {
      id,
      kind: category,
      title: itemTitle(event, category, callNames),
      subtitle: itemSubtitle(event, category),
      tokens: findNodeTokens(ctx, agent, seq),
      text: truncated ? text.slice(0, DETAIL_TEXT_LIMIT) + '\n…（内容过长，已截断）' : text,
      truncated,
      raw: event.data ?? null,
    }
  }

  return null
}

// ── 快照构建 ─────────────────────────────────────────────────────────────────

function buildSnapshot(
  ctx: Context,
  agent: Agent,
  events: readonly RawEvent[],
  runtimeModel?: { provider?: string; model?: string },
): ContextSnapshot {
  const session = agent.session
  const measurement = ctx.tokenMeter.measure(session)
  const projections = readProjections(ctx, agent)
  const header = readHeader(events)
  const callNames = buildCallNames(events)
  const eventBySeq = new Map<number, RawEvent>()
  for (const event of events) eventBySeq.set(event.seq, event)
  const nodeTokensBySeq = new Map<number, number>()
  for (const node of measurement.nodes) nodeTokensBySeq.set(node.seq, node.tokens)
  const turnUserText = new Map<number, string>()
  let lastUserText = ''

  const items: Record<ContextCategory, ContextItem[]> = {
    system: [], tools: [], user: [], inject: [], skill: [], assistant: [], tool: [],
  }
  const sums: Record<ContextCategory, number> = {
    system: 0, tools: 0, user: 0, inject: 0, skill: 0, assistant: 0, tool: 0,
  }

  // 1) 系统提示词
  const systemText = typeof header?.data?.header?.system === 'string' ? header.data.header.system : ''
  if (systemText.length > 0) {
    const tokens = projections.breakdown?.systemTokens ?? estimateTextTokens(systemText)
    items.system.push({
      id: 'system',
      kind: 'system',
      title: '系统提示词',
      subtitle: modelLabel(header),
      tokens,
      preview: previewText(systemText),
      truncated: systemText.length > PREVIEW_LIMIT,
    })
    sums.system = tokens
  }

  // 2) 工具定义：逐个估算后按 contextBreakdown.toolsTokens 归一，保证分项合计与 dsh 一致。
  const rawTools = Array.isArray(header?.data?.header?.tools) ? header.data.header.tools : []
  if (rawTools.length > 0) {
    const estimates = rawTools.map((tool: any) => {
      const text = typeof tool === 'string' ? tool : JSON.stringify(tool)
      return estimateTextTokens(text)
    })
    const estimateSum = estimates.reduce((sum: number, value: number) => sum + value, 0)
    const exactTotal = projections.breakdown?.toolsTokens ?? estimateSum
    const ratio = estimateSum > 0 ? exactTotal / estimateSum : 1
    let scaleCarry = 0
    rawTools.forEach((tool: any, index: number) => {
      const name = typeof tool?.name === 'string' ? tool.name : `tool-${index + 1}`
      const raw = estimates[index] * ratio + scaleCarry
      const tokens = Math.max(1, Math.round(raw))
      scaleCarry = raw - tokens
      items.tools.push({
        id: `tool-schema:${name}`,
        kind: 'tools',
        title: name,
        subtitle: typeof tool?.description === 'string' ? tool.description : undefined,
        tokens,
        preview: typeof tool?.description === 'string'
          ? previewText(tool.description)
          : previewText(JSON.stringify(tool)),
        truncated: typeof tool?.description !== 'string' && JSON.stringify(tool).length > PREVIEW_LIMIT,
        estimated: true,
      })
      sums.tools += tokens
    })
    sums.tools = exactTotal
  }

  // 3) 当前 surface 的事件节点
  for (const node of measurement.nodes) {
    const event = eventBySeq.get(node.seq)
    const category: ContextCategory = event === undefined ? 'inject' : categorize(event)
    const item = buildItem(event, node.seq, node.tokens, category, callNames)
    items[category].push(item)
    sums[category] += node.tokens
  }

  // 4) 分组（保序、限量）
  const groups: ContextGroup[] = GROUP_ORDER.map(category => {
    const all = items[category]
    const limited = all.length > MAX_ITEMS_PER_GROUP ? all.slice(all.length - MAX_ITEMS_PER_GROUP) : all
    return {
      key: category,
      label: CONTEXT_CATEGORY_LABELS[category],
      tokens: sums[category],
      items: limited,
      dropped: all.length - limited.length,
    }
  })

  const categorized = GROUP_ORDER.reduce((sum, key) => sum + sums[key], 0)
  const contextWindow = projections.pressure?.contextWindow
  // DSH 的上下文占用取 prompt 侧压力（input + cache，不含 output），与 Web 的上下文环一致。
  // tokenMeter.measure().totalTokens 含最近一次输出，直接当占用会偏高。
  const usedTokens = projections.pressure?.projectedTokens
    ?? projections.pressure?.pressureTokens
    ?? measurement.totalTokens

  const requests: ContextRequest[] = []
  const contextEvents: ContextEvent[] = []
  const eventCounts: Record<ContextEvent['kind'], number> = { inject: 0, compaction: 0, prune: 0, model: 0, mode: 0 }
  let previousHeader: any
  let modelSwitches = 0
  let compactions = 0
  let prunes = 0

  for (const event of events) {
    const data = event.data ?? {}
    // 注入事件：非 user/tool 来源的 user/message（记忆召回、Stage 快照、定时任务、知识库、压缩摘要、技能…）
    if (event.type === 'user/message') {
      const source = data.source ?? {}
      if (source.kind === 'user') {
        const turn = numberOrUndefined(data.turn)
        const text = blocksToText(blocksOf(event)).trim()
        if (text.length > 0) lastUserText = text
        if (turn !== undefined && text.length > 0) turnUserText.set(turn, text)
      } else if (source.kind !== 'tool') {
        const category = categorize(event)
        const feature = featureOf(event, category, callNames)
        const tokens = nodeTokensBySeq.get(event.seq)
        contextEvents.push({
          seq: event.seq,
          time: event.time,
          kind: 'inject',
          label: featureLabel(feature, event, category),
          detail: previewText(renderEventText(event, category, callNames), 360),
          tokens,
          feature,
          itemId: tokens !== undefined ? `evt:${event.seq}` : undefined,
        })
        eventCounts.inject += 1
      }
      continue
    }
    if (event.type === 'request/header') {
      const next = data.header ?? {}
      const previousModel = previousHeader?.config?.model
      const previousProvider = previousHeader?.config?.provider
      const nextModel = next?.config?.model
      const nextProvider = next?.config?.provider
      if (previousHeader !== undefined && (previousModel !== nextModel || previousProvider !== nextProvider)) {
        modelSwitches += 1
        eventCounts.model += 1
        contextEvents.push({
          seq: event.seq,
          time: event.time,
          kind: 'model',
          label: `模型切换 · ${previousProvider ?? '?'}/${previousModel ?? '?'} → ${nextProvider ?? '?'}/${nextModel ?? '?'}`,
        })
      }
      previousHeader = next
      continue
    }
    if (event.type === 'assistant/message') {
      const usage = data.usage ?? data.message?.usage
      if (usage && typeof usage === 'object') {
        const input = number(usage.inputTokens)
        const cacheRead = number(usage.cacheReadTokens)
        const cacheWrite = number(usage.cacheWriteTokens)
        const output = number(usage.outputTokens)
        const turn = numberOrUndefined(data.turn)
        const replyBlocks = blocksOf(event).filter(block => block?.type === 'text')
        const assistantText = (replyBlocks.length > 0 ? blocksToText(replyBlocks) : blocksToText(blocksOf(event))).trim()
        const userText = turn !== undefined && turnUserText.has(turn) ? turnUserText.get(turn)! : lastUserText
        requests.push({
          seq: event.seq,
          time: event.time,
          turn,
          step: numberOrUndefined(data.step),
          provider: data.message?.source?.provider,
          model: data.message?.source?.model,
          prompt: input + cacheRead + cacheWrite,
          output,
          cacheRead,
          ...userText.length > 0 ? { userText: previewText(userText, 360) } : {},
          ...assistantText.length > 0 ? { assistantText: previewText(assistantText, 360) } : {},
        })
      }
      continue
    }
    if (event.type === 'compaction/summary' || event.type === 'compaction/prune') {
      const isPrune = event.type === 'compaction/prune'
      if (isPrune) { prunes += 1; eventCounts.prune += 1 }
      else { compactions += 1; eventCounts.compaction += 1 }
      const text = renderEventText(event, 'inject', callNames)
      contextEvents.push({
        seq: event.seq,
        time: event.time,
        kind: isPrune ? 'prune' : 'compaction',
        label: isPrune ? '上下文剪枝' : '上下文压缩',
        detail: previewText(text, 400),
        tokens: numberOrUndefined(data.shadowedTokenCount) || numberOrUndefined(data.shadowedTokens),
      })
      continue
    }
    if (event.type === 'plan/mode' && typeof data.active === 'boolean') {
      eventCounts.mode += 1
      contextEvents.push({
        seq: event.seq,
        time: event.time,
        kind: 'mode',
        label: data.active ? '进入计划模式' : '退出计划模式',
      })
    }
  }

  contextEvents.sort((left, right) => left.seq - right.seq)

  const activity = collectActivity(events)
  const features: Record<ContextFeature, number> = { memory: 0, stage: 0, schedule: 0, knowledge: 0, compact: 0, skill: 0, other: 0 }
  for (const key of ['inject', 'skill'] as const) {
    for (const item of items[key]) {
      if (item.feature !== undefined) features[item.feature] += 1
    }
  }

  const humanInputs = items.user.length
  const assistantMessages = items.assistant.length
  const toolResults = items.tool.length
  const skills = items.skill.length
  const toolCalls = countToolCalls(eventBySeq, measurement.nodes.map(node => node.seq))

  const stats = projections.stats
  const usage = projections.usage
  const decodeMs = number(stats?.decodeMs)
  const decodeTokens = number(stats?.decodeTokens)
  const ttftMs = number(stats?.ttftMs)
  const llmMs = number(stats?.llmMs)
  const toolMs = number(stats?.toolMs)
  const outputTokens = number(usage?.outputTokens)

  return {
    generatedAt: Date.now(),
    eventCount: events.length,
    model: {
      provider: runtimeModel?.provider
        ?? (typeof header?.data?.header?.config?.provider === 'string'
          ? header.data.header.config.provider
          : (agent.options.provider ?? 'unknown')),
      model: runtimeModel?.model
        ?? (typeof header?.data?.header?.config?.model === 'string'
          ? header.data.header.config.model
          : (agent.options.model ?? 'unknown')),
      contextWindow,
      maxOutputTokens: numberOrUndefined(header?.data?.header?.config?.maxTokens),
    },
    occupancy: {
      usedTokens,
      contextWindow,
      percent: contextWindow && contextWindow > 0 ? usedTokens / contextWindow : undefined,
      remainingTokens: contextWindow !== undefined ? Math.max(0, contextWindow - usedTokens) : undefined,
    },
    current: {
      system: sums.system,
      tools: sums.tools,
      user: sums.user,
      inject: sums.inject,
      skill: sums.skill,
      assistant: sums.assistant,
      tool: sums.tool,
      total: usedTokens,
      categorized,
    },
    tokens: {
      uncachedInput: usage?.uncachedInputTokens ?? 0,
      cacheRead: usage?.cacheReadTokens ?? 0,
      cacheWrite: usage?.cacheWriteTokens ?? 0,
      output: usage?.outputTokens ?? 0,
      cacheHitRate: cacheHitRate(usage),
      totalTokens: usedTokens,
      surfaceTokens: measurement.surfaceTokens,
    },
    stats: {
      turns: stats?.turns ?? 0,
      steps: stats?.steps ?? 0,
      requests: requests.length,
      humanInputs,
      assistantMessages,
      toolCalls,
      toolResults,
      skills,
      compactions,
      prunes,
      modelSwitches,
      injections: eventCounts.inject,
    },
    groups,
    events: contextEvents.slice(-MAX_EVENTS),
    requests: requests.slice(-MAX_REQUESTS),
    usage: activity.usage,
    timing: {
      llmMs,
      toolMs,
      ttftMs,
      decodeMs,
      decodeTokens,
      outputTokens,
      tokensPerSecond: decodeMs > 0 ? decodeTokens / (decodeMs / 1000) : 0,
      avgTtftMs: number(stats?.ttftSteps) > 0 ? ttftMs / number(stats?.ttftSteps) : 0,
      activeMs: llmMs + toolMs,
    },
    features,
    files: activity.files,
    eventCounts,
  }
}

function buildItem(
  event: RawEvent | undefined,
  seq: number,
  tokens: number,
  category: ContextCategory,
  callNames: Map<string, string>,
): ContextItem {
  const id = `evt:${seq}`
  if (event === undefined) {
    return { id, seq, kind: category, title: CONTEXT_CATEGORY_LABELS[category], tokens, preview: '', truncated: false }
  }
  const text = renderEventText(event, category, callNames)
  const feature = featureOf(event, category, callNames)
  return {
    id,
    seq,
    kind: category,
    title: itemTitle(event, category, callNames),
    subtitle: itemSubtitle(event, category),
    tokens,
    preview: previewText(text),
    truncated: text.length > PREVIEW_LIMIT,
    ...feature === 'other' ? {} : { feature },
    meta: itemMeta(event, category),
  }
}

function itemTitle(event: RawEvent, category: ContextCategory, callNames: Map<string, string>): string {
  if (category === 'assistant') {
    const step = numberOrUndefined(event.data?.step)
    return step ? `助手回复 · step ${step}` : '助手回复'
  }
  if (category === 'user') return '用户消息'
  if (category === 'skill') {
    const name = event.data?.source?.name
    return typeof name === 'string' && name.length > 0 ? `技能注入 · ${name}` : '技能注入'
  }
  if (category === 'tool') {
    const name = callNames.get(String(event.data?.message?.source?.callId ?? event.data?.source?.callId ?? ''))
    return name ? `工具结果 · ${name}` : '工具结果'
  }
  if (category === 'inject') {
    const source = event.data?.source ?? {}
    const detail = source.plugin ?? source.name ?? source.form ?? source.kind
    return typeof detail === 'string' && detail.length > 0 ? `注入上下文 · ${detail}` : '注入上下文'
  }
  return CONTEXT_CATEGORY_LABELS[category]
}

function itemSubtitle(event: RawEvent, category: ContextCategory): string | undefined {
  const turn = numberOrUndefined(event.data?.turn)
  const step = numberOrUndefined(event.data?.step)
  const parts: string[] = []
  if (turn !== undefined) parts.push(`turn ${turn}`)
  if (step !== undefined) parts.push(`step ${step}`)
  if (category === 'user') {
    const source = event.data?.source ?? {}
    if (typeof source.kind === 'string' && source.kind !== 'user') parts.push(source.kind)
  }
  return parts.length > 0 ? parts.join(' · ') : undefined
}

function itemMeta(event: RawEvent, category: ContextCategory): Record<string, unknown> | undefined {
  const meta: Record<string, unknown> = {}
  const source = sanitizeSource(event.data?.source)
  if (source !== undefined) meta.source = source
  if (category === 'tool') meta.callId = event.data?.message?.source?.callId ?? event.data?.source?.callId
  if (category === 'assistant') {
    const blocks = blocksOf(event)
    const toolCalls = blocks.filter(block => block?.type === 'tool-call').map(block => block.name)
    if (toolCalls.length > 0) meta.toolCalls = toolCalls
    if (blocks.some(block => block?.type === 'reasoning')) meta.hasReasoning = true
  }
  return Object.keys(meta).length > 0 ? meta : undefined
}

// ── 助手特色分类 ─────────────────────────────────────────────────────────────

const READ_TOOLS = new Set(['read', 'read_image'])
const WRITE_TOOLS = new Set(['write', 'edit'])
const SEARCH_TOOLS = new Set(['grep', 'glob'])

function toolNameOf(event: RawEvent, callNames: Map<string, string>): string {
  const callId = String(event.data?.message?.source?.callId ?? event.data?.source?.callId ?? '')
  return callNames.get(callId) ?? ''
}

/** 判断一份注入/工具结果属于助手的哪类特色上下文。 */
function featureOf(event: RawEvent, category: ContextCategory, callNames: Map<string, string>): ContextFeature {
  const source = event.data?.source ?? {}
  const tool = toolNameOf(event, callNames)
  if (category === 'tool') {
    if (/^(memory_|remember$|forget$)/.test(tool)) return 'memory'
    if (/^knowledge_/.test(tool)) return 'knowledge'
    if (tool === 'stage_action' || tool === 'vn_command') return 'stage'
    if (/^schedule_/.test(tool)) return 'schedule'
    if (tool === 'skill') return 'skill'
    return 'other'
  }
  if (category !== 'inject' && category !== 'skill') return 'other'
  const plugin = String(source.plugin ?? '').toLowerCase()
  const kind = String(source.kind ?? '')
  const name = String(source.name ?? '').toLowerCase()
  if (category === 'skill' || kind.includes('skill') || source.form === 'instructions') return 'skill'
  if (kind === 'system-event' || kind === 'scheduled-task' || kind.includes('scheduled') || plugin.includes('sched')) return 'schedule'
  if (plugin.includes('memory') || kind.includes('memory') || name.includes('memory')) return 'memory'
  if (plugin.includes('stage') || plugin.includes('vn') || kind.includes('stage') || kind === 'event') return 'stage'
  if (plugin.includes('knowledge')) return 'knowledge'
  if (plugin.includes('compact') || plugin.includes('compaction')) return 'compact'
  return 'other'
}

function featureLabel(feature: ContextFeature, event: RawEvent, category: ContextCategory): string {
  const source = event.data?.source ?? {}
  const detailValue = typeof source.plugin === 'string' && source.plugin.length > 0
    ? source.plugin
    : typeof source.name === 'string' && source.name.length > 0
      ? source.name
      : typeof source.kind === 'string' && source.kind.length > 0
        ? source.kind
        : ''
  const detail = detailValue.length > 0 ? ' · ' + detailValue : ''
  switch (feature) {
    case 'memory': return '记忆召回注入' + detail
    case 'stage': return '场景上下文注入' + detail
    case 'schedule': return '定时任务输入' + detail
    case 'knowledge': return '知识库注入' + detail
    case 'compact': return '压缩摘要注入' + detail
    case 'skill': return '技能注入' + detail
    default: return category === 'skill' ? '技能注入' + detail : '上下文注入' + detail
  }
}

function collectActivity(events: readonly RawEvent[]): {
  usage: {
    userInputs: number
    assistantReplies: number
    reads: number
    writes: number
    searches: number
    images: number
    skillsLoaded: number
    toolCalls: number
    toolCallsByTool: Array<{ name: string; count: number }>
  }
  files: ContextFileActivity[]
} {
  let userInputs = 0
  let assistantReplies = 0
  let reads = 0
  let writes = 0
  let searches = 0
  let images = 0
  let skillsLoaded = 0
  let toolCalls = 0
  const byTool = new Map<string, number>()
  const files = new Map<string, ContextFileActivity>()

  const touchFile = (path: string, seq: number | undefined, time: number | undefined): ContextFileActivity => {
    let row = files.get(path)
    if (row === undefined) {
      row = { path, reads: 0, writes: 0, searches: 0, images: 0, added: 0, removed: 0 }
      files.set(path, row)
    }
    if (seq !== undefined) row.lastSeq = Math.max(row.lastSeq ?? 0, seq)
    if (time !== undefined) row.lastTime = Math.max(row.lastTime ?? 0, time)
    return row
  }

  for (const event of events) {
    const data = event.data ?? {}
    if (event.type === 'user/message') {
      if ((data.source ?? {}).kind === 'user') userInputs += 1
      continue
    }
    if (event.type === 'assistant/message') {
      assistantReplies += 1
      continue
    }
    if (event.type !== 'tool/call') continue
    toolCalls += 1
    const name = typeof data.name === 'string' ? data.name : 'unknown'
    byTool.set(name, (byTool.get(name) ?? 0) + 1)
    if (name === 'skill') skillsLoaded += 1
    const args = parseToolArguments(data.arguments)
    const command = typeof args?.command === 'string' ? args.command : ''
    const isRead = READ_TOOLS.has(name) || (name === 'str_replace_editor' && command === 'view')
    const isWrite = WRITE_TOOLS.has(name) || (name === 'str_replace_editor' && command !== 'view')
    const isSearch = SEARCH_TOOLS.has(name)
    if (isRead) reads += 1
    if (isWrite) writes += 1
    if (isSearch) searches += 1
    if (name === 'read_image') images += 1
    const path = toolFilePath(name, args)
    if (path === undefined) continue
    const row = touchFile(path, event.seq, event.time)
    if (isRead) row.reads += 1
    if (isWrite) row.writes += 1
    if (isSearch) row.searches += 1
    if (name === 'read_image') row.images += 1
    const delta = toolLineDelta(name, args, command)
    row.added += delta.added
    row.removed += delta.removed
  }

  const toolCallsByTool = [...byTool.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((left, right) => right.count - left.count || left.name.localeCompare(right.name))

  const fileList = [...files.values()]
    .sort((left, right) => (right.lastSeq ?? 0) - (left.lastSeq ?? 0))
    .slice(0, 300)

  return {
    usage: { userInputs, assistantReplies, reads, writes, searches, images, skillsLoaded, toolCalls, toolCallsByTool },
    files: fileList,
  }
}

function parseToolArguments(value: unknown): Record<string, any> | null {
  if (value !== null && typeof value === 'object') return value as Record<string, any>
  if (typeof value !== 'string') return null
  try {
    const parsed = JSON.parse(value)
    return parsed !== null && typeof parsed === 'object' ? parsed as Record<string, any> : null
  } catch {
    return null
  }
}

function toolFilePath(name: string, args: Record<string, any> | null): string | undefined {
  if (args === null) return undefined
  if (name === 'grep' || name === 'glob') {
    return typeof args.path === 'string' && args.path.length > 0 ? args.path : undefined
  }
  for (const key of ['file_path', 'filePath', 'path']) {
    if (typeof args[key] === 'string' && args[key].length > 0) return args[key]
  }
  return undefined
}

function toolLineDelta(name: string, args: Record<string, any> | null, command: string): { added: number; removed: number } {
  if (args === null) return { added: 0, removed: 0 }
  const lines = (value: unknown): number => {
    if (typeof value !== 'string' || value.length === 0) return 0
    const count = value.split('\n').length
    return value.endsWith('\n') ? count - 1 : count
  }
  if (name === 'edit') return { added: lines(args.new_string), removed: lines(args.old_string) }
  if (name === 'write') return { added: lines(args.content), removed: 0 }
  if (name === 'str_replace_editor') {
    if (command === 'str_replace') return { added: lines(args.new_str), removed: lines(args.old_str) }
    if (command === 'insert') return { added: lines(args.new_str), removed: 0 }
    if (command === 'create') return { added: lines(args.file_text), removed: 0 }
  }
  return { added: 0, removed: 0 }
}

// ── 事件 → 文本 ──────────────────────────────────────────────────────────────

function renderEventText(event: RawEvent, category: ContextCategory, callNames: Map<string, string>): string {
  const blocks = blocksOf(event)
  if (category === 'tool') {
    const callId = String(event.data?.message?.source?.callId ?? event.data?.source?.callId ?? '')
    const name = callNames.get(callId)
    const heading = name ? `[工具结果 · ${name}]\n` : '[工具结果]\n'
    return heading + blocksToText(blocks) || '[空]'
  }
  return blocksToText(blocks) || fallbackEventText(event)
}

function blocksOf(event: RawEvent): any[] {
  const data = event.data ?? {}
  if (Array.isArray(data.content)) return data.content
  if (Array.isArray(data.message?.content)) return data.message.content
  return []
}

function blocksToText(blocks: readonly any[]): string {
  const lines: string[] = []
  for (const block of blocks) {
    if (!block || typeof block !== 'object') continue
    if (block.type === 'text' && typeof block.text === 'string') lines.push(block.text)
    else if (block.type === 'reasoning' && typeof block.text === 'string') lines.push(`[思考]\n${block.text}`)
    else if (block.type === 'tool-call') {
      lines.push(`[调用 ${block.name ?? 'tool'}]\n${prettyArguments(block.arguments)}`)
    } else if (block.type === 'tool-result') {
      lines.push(blocksToText(Array.isArray(block.content) ? block.content : []))
    } else if (block.type === 'image') {
      const attachment = block.attachment ?? {}
      const name = typeof attachment.name === 'string' ? attachment.name : '图片'
      const size = attachment.width && attachment.height ? ` ${attachment.width}×${attachment.height}` : ''
      lines.push(`[图片 ${name}${size}]`)
    }
  }
  return lines.filter(line => line.trim().length > 0).join('\n\n')
}

function fallbackEventText(event: RawEvent): string {
  const data = event.data ?? {}
  if (typeof data.text === 'string' && data.text.length > 0) return data.text
  try {
    return JSON.stringify(data, null, 2)
  } catch {
    return String(data)
  }
}

function prettyArguments(argumentsValue: unknown): string {
  if (typeof argumentsValue === 'string') {
    try { return JSON.stringify(JSON.parse(argumentsValue), null, 2) } catch { return argumentsValue }
  }
  try { return JSON.stringify(argumentsValue ?? null, null, 2) } catch { return String(argumentsValue) }
}

// ── 归类与投影读取 ───────────────────────────────────────────────────────────

function categorize(event: RawEvent): ContextCategory {
  const type = event.type
  if (type === 'system/message') return 'system'
  if (type === 'developer/message') {
    const source = event.data?.source ?? {}
    return source.kind === 'skill-invocation' || source.kind === 'skill-catalog' || source.form === 'instructions'
      ? 'skill'
      : 'inject'
  }
  if (type === 'user/message') {
    const source = event.data?.source ?? {}
    if (source.kind === 'user') return 'user'
    if (source.kind === 'tool') return 'tool'
    if (source.kind === 'skill-invocation' || source.kind === 'skill-catalog' || source.form === 'instructions') return 'skill'
    return 'inject'
  }
  if (type === 'assistant/message') return 'assistant'
  if (type === 'tool/result') return 'tool'
  return 'inject'
}

function buildCallNames(events: readonly RawEvent[]): Map<string, string> {
  const names = new Map<string, string>()
  for (const event of events) {
    if (event.type !== 'tool/call') continue
    const callId = event.data?.callId
    const name = event.data?.name
    if (typeof callId === 'string' && typeof name === 'string') names.set(callId, name)
  }
  return names
}

function countToolCalls(
  eventBySeq: Map<number, RawEvent>,
  surfaceSeqs: readonly number[],
): number {
  let count = 0
  for (const seq of surfaceSeqs) {
    const event = eventBySeq.get(seq)
    if (event?.type !== 'assistant/message') continue
    count += blocksOf(event).filter(block => block?.type === 'tool-call').length
  }
  return count
}

function readHeader(events: readonly RawEvent[]): RawEvent | undefined {
  for (let index = events.length - 1; index >= 0; index--) {
    if (events[index]?.type === 'request/header') return events[index]
  }
  return undefined
}

function readProjections(ctx: Context, agent: Agent): {
  pressure?: { contextWindow?: number; pressureTokens?: number; projectedTokens?: number }
  breakdown?: { systemTokens: number; toolsTokens: number; messageTokens: number }
  usage?: { uncachedInputTokens?: number; cacheReadTokens?: number; cacheWriteTokens?: number; outputTokens?: number }
  stats?: { turns?: number; steps?: number; llmMs?: number; toolMs?: number; ttftMs?: number; ttftSteps?: number; decodeMs?: number; decodeTokens?: number }
} {
  try {
    const values = ctx.sessionProjections.snapshot(agent.session).values as any
    return {
      pressure: values.contextPressure,
      breakdown: values.contextBreakdown,
      usage: values.tokenUsage,
      stats: values.sessionStats,
    }
  } catch {
    return {}
  }
}

function findNodeTokens(ctx: Context, agent: Agent, seq: number): number | undefined {
  try {
    const measurement = ctx.tokenMeter.measure(agent.session)
    const node = measurement.nodes.find(item => item.seq === seq)
    return node?.tokens
  } catch {
    return undefined
  }
}

// ── 小工具 ───────────────────────────────────────────────────────────────────

/** 只保留来源里可安全展示的身份字段，避免把 assistant 的 replayState 等大对象带进快照。 */
function sanitizeSource(source: unknown): Record<string, unknown> | undefined {
  if (source === null || typeof source !== 'object') return undefined
  const input = source as Record<string, unknown>
  const out: Record<string, unknown> = {}
  for (const key of ['kind', 'plugin', 'form', 'name', 'provider', 'model', 'senderName', 'senderSessionId', 'senderId', 'eventType', 'callId']) {
    if (typeof input[key] === 'string' || typeof input[key] === 'number') out[key] = input[key]
  }
  return Object.keys(out).length > 0 ? out : undefined
}

function previewText(text: string, limit = PREVIEW_LIMIT): string {
  const compact = text.replace(/\s+/g, ' ').trim()
  return compact.length > limit ? compact.slice(0, limit) + '…' : compact
}

function estimateTextTokens(text: string): number {
  if (text.length === 0) return 0
  // 与 dsh 固定密度启发式同量级：CJK 按字、拉丁按 ~4 字符/token，保守取 3。
  let tokens = 0
  for (const char of text) tokens += char.codePointAt(0)! > 0x2e80 ? 1 : 0.25
  return Math.max(1, Math.ceil(tokens))
}

function number(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.round(value)) : 0
}

function numberOrUndefined(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function cacheHitRate(usage: { uncachedInputTokens?: number; cacheReadTokens?: number; cacheWriteTokens?: number } | undefined): number {
  if (usage === undefined) return 0
  const total = (usage.uncachedInputTokens ?? 0) + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0)
  return total > 0 ? (usage.cacheReadTokens ?? 0) / total : 0
}

function modelLabel(header: RawEvent | undefined): string | undefined {
  const config = header?.data?.header?.config
  if (config === undefined) return undefined
  if (typeof config.provider === 'string' && typeof config.model === 'string') return `${config.provider}/${config.model}`
  if (typeof config.model === 'string') return config.model
  return undefined
}
