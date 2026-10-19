/**
 * 压缩记忆化 — 会话压缩时把 summary 落成记忆, 并异步 LLM 提取高质量记忆
 *
 * 时机: 监听 compaction/summary 事件 (dsh 压缩完成后发出)。
 * 门控: 全套流程 (summary 存记忆 + LLM 提取) 包在 runCompactionFlow 里,
 *   期间新消息进队列等待 (见 gate.ts)。
 *
 * 三步流程 (用户确认):
 *   ① 立即: summary 直接存记忆 (保底, 即使 LLM 挂了也不丢)
 *   ② 原文: 已在 transcript.jsonl (append-only), 由 sourceRange 索引, 无需额外动作
 *   ③ 异步: LLM 从原文提取「用户偏好/决策/事实」, 新增为更精细的记忆条目
 *
 * @module assistant/memory/compaction
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ContentBlock, GenerateOptions } from '@deepseek-ai/dsh-llm'
import { BlockAssembler, createUserMessage } from '@deepseek-ai/dsh-llm'
// Type-only: 激活 dsh-compaction 的 'compaction/summary' SessionEventMap 声明合并
import type {} from '@deepseek-ai/dsh-compaction'
import { createMemory } from './store.js'
import { readTranscriptRange } from './transcript.js'
import { runCompactionFlow, flushCompactionFlows } from './gate.js'

/** 渲染 summary 的 content blocks 为纯文本。 */
function renderSummary(blocks: readonly ContentBlock[]): string {
  return blocks
    .filter(b => b.type === 'text' || b.type === 'reasoning')
    .map(b => b.text)
    .join('\n')
    .trim()
}

// ── LLM 提取 ────────────────────────────────────────────────────────────────

interface ExtractedMemory {
  title: string
  content: string
  tags: string[]
}

const EXTRACTION_INSTRUCTION = [
  '你是记忆提取器。从下面的对话原文中, 提取值得长期记住的信息, 供未来的对话使用。',
  '',
  '只提取以下类型, 忽略过程性内容 (如"好的"、"正在执行"、"让我看一下"):',
  '- 用户的偏好、习惯、要求',
  '- 重要的决策及其原因',
  '- 项目关键事实 (技术选型、文件路径、约定、命名)',
  '',
  '输出 JSON 数组, 每个元素形如 {"title": "...", "content": "...", "tags": ["..."]}。',
  '没有值得记住的内容就输出空数组 []。只输出 JSON, 不要任何其他文字。',
].join('\n')

/** 从 LLM 输出里稳健地解析 JSON 数组。 */
function parseMemories(text: string): ExtractedMemory[] {
  const cleaned = text.replace(/```json\s*/gi, '').replace(/```/g, '').trim()
  const match = cleaned.match(/\[[\s\S]*\]/)
  if (!match) return []
  try {
    const arr = JSON.parse(match[0]) as unknown
    if (!Array.isArray(arr)) return []
    return arr
      .filter((m): m is Record<string, unknown> => typeof m === 'object' && m !== null)
      .filter(m => typeof m.title === 'string' && typeof m.content === 'string')
      .map(m => ({
        title: m.title as string,
        content: m.content as string,
        tags: Array.isArray(m.tags) ? m.tags.filter(t => typeof t === 'string') : [],
      }))
  } catch {
    return []
  }
}

/** 用 ctx.llm 从原文提取高质量记忆。失败返回空数组 (不阻断压缩流程)。 */
async function extractMemories(
  ctx: Context,
  agent: Agent,
  rawText: string,
  signal: AbortSignal,
): Promise<ExtractedMemory[]> {
  const selection = (ctx.get('assistantConfig') as { currentModel(): { provider?: string; model?: string } | undefined } | undefined)?.currentModel()
    ?? agent.session.requestHeader?.()?.config
    ?? agent.options
  const { provider, model } = selection
  if (!provider || !model) return []

  const messages = [
    createUserMessage({
      content: [
        { type: 'text', text: `${EXTRACTION_INSTRUCTION}\n\n对话原文:\n${rawText}` },
      ],
      source: { kind: 'plugin', plugin: 'assistant-memory' },
    }),
  ]
  const options: GenerateOptions = {
    provider,
    model,
    messages,
    maxTokens: 2048,
    sessionId: agent.session.id,
    signal,
  }

  try {
    const assembler = new BlockAssembler()
    for await (const chunk of ctx.llm.stream(options)) assembler.push(chunk)
    const blocks = assembler.blocks()
    const text = blocks
      .filter(b => b.type === 'text')
      .map(b => b.text)
      .join('\n')
    return parseMemories(text)
  } catch (err) {
    console.warn('[compaction] LLM 提取失败:', err instanceof Error ? err.message : String(err))
    return []
  }
}

// ── 压缩 hook ───────────────────────────────────────────────────────────────

export function installCompactionHook(ctx: Context, sessionId: string, agent: Agent): void {
  const shutdown = new AbortController()
  ctx.effect(() => async () => {
    shutdown.abort()
    await flushCompactionFlows()
  }, 'memory.compaction-flush')
  ctx.on('session/event', (session, event) => {
    if (String(session.id) !== sessionId) return
    if (event.type !== 'compaction/summary') return

    const { summary, shadowedSeqs } = event.data
    if (shadowedSeqs.length === 0) return

    const startSeq = Math.min(...shadowedSeqs)
    const endSeq = Math.max(...shadowedSeqs)
    const summaryText = renderSummary(summary)

    // 全套流程纳入门控, 期间 block 新消息
    void runCompactionFlow(async () => {
      // ① summary 存记忆 (保底), sourceRange 指向 transcript 区间
      await createMemory(
        `会话摘要 (seq ${startSeq}-${endSeq})`,
        summaryText || '（压缩摘要为空）',
        ['会话摘要', '压缩'],
        { sourceStartSeq: startSeq, sourceEndSeq: endSeq },
      )
      console.log(`[compaction] 已落 summary 记忆 (seq ${startSeq}-${endSeq})`)

      // ② 原文已在 transcript.jsonl (append-only), sourceRange 索引, 无需额外归档

      // ③ LLM 提取高质量记忆 (从原文挖事实/偏好)
      const rawLines = await readTranscriptRange(startSeq, endSeq)
      const rawText = rawLines.map(l => `${l.role}: ${l.text}`).join('\n')
      if (rawText) {
        const extracted = await extractMemories(ctx, agent, rawText, AbortSignal.any([shutdown.signal, AbortSignal.timeout(60_000)]))
        for (const m of extracted) {
          await createMemory(m.title, m.content, m.tags, {
            sourceStartSeq: startSeq,
            sourceEndSeq: endSeq,
          })
        }
        if (extracted.length > 0) {
          console.log(`[compaction] LLM 提取 ${extracted.length} 条高质量记忆`)
        }
      }
    }).catch(err => console.warn('[compaction] 记忆化失败:', err))
  })
}
