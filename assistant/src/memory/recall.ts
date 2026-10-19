/**
 * 实时召回插件 — 每轮用户消息自动召回相关记忆并注入
 *
 * 机制 (参考 agent-instructions 的 pre-step 注入模式):
 *   1. 只在 turn 的第一个 step (step===1) 召回一次, 工具循环的后续 step 不重复。
 *   2. 用当前用户消息文本作为 query, searchMemories 全文匹配。
 *   3. 命中 top-k 渲染成「相关记忆」提示, 作为一条 user/message 注入到末尾。
 *   4. 判重: 相同内容的召回提示已在 claimed 或 surface 历史里 → 不重复注入。
 *
 * 缓存友好: 召回提示注入在请求末尾 (紧跟用户消息), 历史前缀缓存命中,
 * 只有召回提示这一小段是新增计算。
 *
 * 与主动 recall 工具的关系: 本插件负责「自动想起来」, recall 工具负责「深挖」。
 *
 * @module assistant/memory/recall
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage, type UserMessage } from '@deepseek-ai/dsh-llm'
import { isDeepStrictEqual } from 'node:util'
import { searchMemories, type Memory } from './store.js'

// ── source kind 声明 (merge-extensible, 插件加自己的 kind) ────────────────

interface MemoryRecallSource {
  kind: 'memory-recall'
}

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'memory-recall': MemoryRecallSource
  }
}

const RECALL_KIND = 'memory-recall'
const TOP_K = 3
const MAX_QUERIES = 8
const STOP_WORDS = new Set([
  '的', '了', '吗', '呢', '啊', '和', '与', '及', '或', '请', '帮', '我', '你', '他', '她', '它',
  '这个', '那个', '一下', '怎么', '如何', '什么', '为什么', '可以', '能够', '需要', '继续', '关于',
  'the', 'and', 'for', 'with', 'that', 'this', 'please', 'help', 'what', 'how', 'can', 'you', 'are',
])

// ── 辅助 ────────────────────────────────────────────────────────────────────

function isRecallMessage(message: UserMessage): boolean {
  return message.source.kind === RECALL_KIND
}

function sameContent(left: UserMessage, right: UserMessage): boolean {
  return isDeepStrictEqual(left.content, right.content)
}

/** 从最新一条可召回的输入中提取文字。 */
function currentUserText(messages: readonly UserMessage[]): string {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]
    const kind: string = message.source.kind
    if (message.source.kind === 'system-event' && message.source.eventType === 'scheduled-task-triggered') {
      if (message.source.task?.prompt) return message.source.task.prompt
      const text = message.content.filter(block => block.type === 'text').map(block => block.text).join('\n')
      const jsonStart = text.indexOf('\n{')
      return jsonStart >= 0 ? eventQuery(text.slice(jsonStart + 1)) : eventQuery(text)
    }
    if (kind !== 'user' && kind !== 'stage-event' && kind !== 'event' && kind !== 'scheduled-task') continue
    const text = message.content
      .filter(block => block.type === 'text')
      .map(block => block.text)
      .join(' ')
      .trim()
    if (!text) continue
    return kind === 'stage-event' || kind === 'event' ? eventQuery(text) : text
  }
  return ''
}

/** Stage 目前将事件包装为 JSON 文本；优先取用户可读字段，而不是 id 等元数据。 */
function eventQuery(text: string): string {
  try {
    const event = JSON.parse(text) as unknown
    const values: string[] = []
    const visit = (value: unknown, key = ''): void => {
      if (values.length >= 8 || value === null || value === undefined) return
      if (typeof value === 'string') {
        const trimmed = value.trim()
        if (trimmed && /(?:text|content|message|prompt|query|description|reason|say|speech)/i.test(key)) values.push(trimmed)
        return
      }
      if (Array.isArray(value)) {
        for (const item of value) visit(item, key)
      } else if (typeof value === 'object') {
        for (const [childKey, child] of Object.entries(value)) visit(child, childKey)
      }
    }
    visit(event)
    if (values.length) return values.join(' ')
  } catch { /* 普通事件文本仍可作为 query */ }
  return text
}

function isUsefulTerm(term: string): boolean {
  const value = term.trim().toLowerCase()
  if (!value || STOP_WORDS.has(value)) return false
  if (/^[\p{Script=Han}]+$/u.test(value)) return value.length >= 2
  return /^[\p{L}\p{N}][\p{L}\p{N}_.-]*$/u.test(value) && value.length >= 3
}

/** 用完整输入优先检索，再用少量实词补足 store 的 exact-includes 语义。 */
function recallQueries(query: string): string[] {
  const normalized = query.replace(/\s+/g, ' ').trim()
  if (!normalized) return []
  const terms: string[] = []
  if (typeof Intl.Segmenter === 'function') {
    const segmenter = new Intl.Segmenter('zh', { granularity: 'word' })
    for (const part of segmenter.segment(normalized)) {
      if (part.isWordLike && isUsefulTerm(part.segment)) terms.push(part.segment)
    }
  } else {
    for (const part of normalized.match(/[\p{Script=Han}]{2,}|[\p{L}\p{N}_.-]{3,}/gu) ?? []) {
      if (isUsefulTerm(part)) terms.push(part)
    }
  }
  const phrases = terms.flatMap((term, index) => index + 1 < terms.length
    ? [`${term}${terms[index + 1]}`, term]
    : [term])
  return [...new Set([normalized, ...phrases])].slice(0, MAX_QUERIES)
}

async function findRelevantMemories(query: string): Promise<Memory[]> {
  const queries = recallQueries(query)
  const scores = new Map<string, { memory: Memory; score: number; order: number }>()
  for (let index = 0; index < queries.length; index++) {
    const needle = queries[index]
    // 串行调用：store 在首次查询时可能重建索引，不能并发触发它。
    const matches = await searchMemories(needle)
    const weight = index === 0 ? 10 : Math.min(6, Math.max(1, needle.length))
    for (const memory of matches) {
      const existing = scores.get(memory.id)
      if (existing) existing.score += weight
      else scores.set(memory.id, { memory, score: weight, order: scores.size })
    }
  }
  return [...scores.values()]
    .sort((left, right) => right.score - left.score || left.order - right.order)
    .slice(0, TOP_K)
    .map(entry => entry.memory)
}

function renderRecall(memories: Memory[]): string {
  if (memories.length === 0) return ''
  const lines = memories.map(m => `- ${m.title}: ${m.content.slice(0, 200)}`)
  return `【相关记忆】\n${lines.join('\n')}`
}

/** 召回提示是否已存在于该 agent 的 surface 历史里。 */
function alreadyInSurface(agent: Agent, desired: UserMessage): boolean {
  return agent.session.surface.nodes.some(seq => {
    const event = agent.session.events[seq]
    if (event?.type !== 'user/message') return false
    const msg = event.data as UserMessage
    return isRecallMessage(msg) && sameContent(msg, desired)
  })
}

/** 清理 inbox next-step 里残留的召回消息 (避免跨轮累积)。 */
function clearPendingRecall(agent: Agent): void {
  for (const pending of [...agent.inbox.nextStep]) {
    if (isRecallMessage(pending)) agent.inbox.remove(pending.id)
  }
}

// ── 召回插件 ────────────────────────────────────────────────────────────────

export function installRecallPlugin(ctx: Context, sessionId: string): void {
  ctx.on('agent/pre-step', async ({ agent, messages, step }, next) => {
    const decision = await next()

    // 只对主 agent 召回 (subagent 有自己的上下文与记忆工具)
    if (String(agent.id) !== sessionId) return decision

    // 只在 turn 第一个 step 召回 (用户消息刚到, 还没进入工具循环)
    if (step !== 1) return decision

    const query = currentUserText(messages)
    if (!query) {
      clearPendingRecall(agent)
      return decision
    }

    const recallText = renderRecall(await findRelevantMemories(query))
    if (!recallText) {
      clearPendingRecall(agent)
      return decision
    }

    const desired = createUserMessage({
      content: [{ type: 'text', text: recallText }],
      source: { kind: RECALL_KIND },
    })

    // 判重: 已在本轮 claimed 或 surface 历史里 → 不重复注入
    const alreadyInMessages = messages.some(m => sameContent(m, desired))
    if (alreadyInMessages || alreadyInSurface(agent, desired)) {
      clearPendingRecall(agent)
      return decision
    }

    if (decision.kind === 'reject') {
      // 本步拒绝进入, 放 inbox next-step 等下一步; 替换旧的召回避免累积
      clearPendingRecall(agent)
      agent.inbox.prepend('next-step', desired)
      return decision
    }

    // 进入本步: 清理 pending 旧召回, 把 desired 注入 claimed batch 之后 (末尾)
    clearPendingRecall(agent)

    let lastClaimedIndex = -1
    for (let i = 0; i < decision.messages.length; i++) {
      if (messages.includes(decision.messages[i])) lastClaimedIndex = i
    }
    const idx = lastClaimedIndex + 1
    const entered = [
      ...decision.messages.slice(0, idx),
      desired,
      ...decision.messages.slice(idx),
    ]
    return { kind: 'enter', messages: entered }
  })
}
