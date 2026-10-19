/**
 * 会话原文记录器 — 一份 append-only 的可读对话文本 (带 events seq)
 *
 * 职责: 在会话进行中, 把 surface 消息增量渲染成可读文本并落盘,
 * 作为「记忆条目的 sourceRange 指向的原文」。
 *
 * 布局: data/memories/{sessionId}/transcript.jsonl
 *   每行: { seq, role, text }   seq = events 的稳定索引 (append-only 单调)
 *
 * 关键语义: 本文件 append-only, compaction 压缩 surface 时不删这里的行。
 *   记忆条目通过 sourceStartSeq/sourceEndSeq 索引本文件的一段区间,
 *   所以无论 surface 之后如何压缩, 原文始终可追溯。
 *
 * @module assistant/memory/transcript
 */

import { appendFile, readFile, mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { existsSync } from 'node:fs'
import type { Context } from '@deepseek-ai/cordis'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'

// ── 类型 ────────────────────────────────────────────────────────────────────

export interface TranscriptLine {
  /** events 的稳定索引 (append-only 单调) */
  seq: number
  role: 'user' | 'assistant' | 'tool' | 'system-event'
  text: string
}

// ── 目录 ────────────────────────────────────────────────────────────────────

let transcriptDir = ''

export function setTranscriptDir(dir: string): void {
  transcriptDir = resolve(dir)
}

function transcriptPath(): string {
  return resolve(transcriptDir, 'transcript.jsonl')
}

async function ensureDir(): Promise<void> {
  if (!existsSync(transcriptDir)) await mkdir(transcriptDir, { recursive: true })
}

// ── 渲染 (ContentBlock → 可读文本) ─────────────────────────────────────────

function renderBlock(block: ContentBlock): string {
  switch (block.type) {
    case 'text': return block.text
    case 'reasoning': return `[思考] ${block.text}`
    case 'tool-call': return `[调用工具 ${block.name}] ${block.arguments}`
    case 'tool-result': return `[工具结果] ${block.content.map(renderBlock).join('\n')}`
    case 'image': return '[图片]'
    default: return ''
  }
}

function renderContent(blocks: readonly ContentBlock[]): string {
  return blocks.map(renderBlock).filter(s => s.length > 0).join('\n').trim()
}

// ── 写入 / 读取 ─────────────────────────────────────────────────────────────

/** 串行化写入队列, 保证 jsonl 行顺序与事件顺序一致。 */
let writeChain: Promise<void> = Promise.resolve()

export async function appendTranscript(line: TranscriptLine): Promise<void> {
  await ensureDir()
  await appendFile(transcriptPath(), JSON.stringify(line) + '\n', 'utf-8')
}

function enqueueTranscript(line: TranscriptLine): void {
  writeChain = writeChain
    .then(() => appendTranscript(line))
    .catch(err => console.warn('[transcript] 记录失败:', err))
}

/** 读取 [startSeq, endSeq] 区间内的原文行 (供记忆溯源/归档)。 */
export async function readTranscriptRange(startSeq: number, endSeq: number): Promise<TranscriptLine[]> {
  // Session events arrive synchronously; disk appends are queued. A summary must
  // wait for the last message write before extracting memories from its range.
  await writeChain
  await ensureDir()
  let raw = ''
  try { raw = await readFile(transcriptPath(), 'utf-8') } catch { return [] }
  const lines: TranscriptLine[] = []
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue
    try {
      const parsed = JSON.parse(line) as TranscriptLine
      if (parsed.seq >= startSeq && parsed.seq <= endSeq) lines.push(parsed)
    } catch { /* 跳过坏行 */ }
  }
  return lines
}

// ── 记录器 (监听 session/event) ─────────────────────────────────────────────

/**
 * 安装会话原文记录器。监听指定 session 的 surface 消息事件,
 * 把每条消息渲染成可读文本, 追加到 transcript.jsonl。
 *
 * 只记录三类 surface 消息: user/message、assistant/message、tool/result。
 * assistant/chunk 是流式片段, 由 assistant/message 的组装结果覆盖, 不单独记录。
 *
 * @param ctx - 插件 context。
 * @param sessionId - 只记录这个 session (本助手的专属 session) 的事件。
 */
function transcriptLine(event: SessionEvent): TranscriptLine | null {
  switch (event.type) {
    case 'user/message': {
      const source = event.data.source
      const scheduled = source.kind === 'scheduled-task'
        || (source.kind === 'system-event' && source.eventType === 'scheduled-task-triggered')
      return { seq: event.seq, role: scheduled ? 'system-event' : 'user', text: renderContent(event.data.content) }
    }
    case 'assistant/message':
      return { seq: event.seq, role: 'assistant', text: renderContent(event.data.message.content) }
    case 'tool/result':
      return { seq: event.seq, role: 'tool', text: renderContent(event.data.message.content) }
    default:
      return null
  }
}

export function installTranscriptRecorder(ctx: Context, sessionId: string, restored?: Session): void {
  if (restored) {
    // Reconcile durable history after resume; already recorded seqs stay intact.
    const history = [...restored.events]
    writeChain = writeChain.then(async () => {
      await ensureDir()
      const raw = await readFile(transcriptPath(), 'utf-8').catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return ''
        throw error
      })
      const recorded = new Set<number>()
      for (const line of raw.split('\n')) {
        try { recorded.add(JSON.parse(line).seq) } catch { /* preserve existing malformed lines */ }
      }
      for (const event of history) {
        const line = transcriptLine(event)
        if (!line?.text || recorded.has(line.seq)) continue
        await appendTranscript(line)
        recorded.add(line.seq)
      }
    }).catch(error => console.warn('[transcript] 历史原文补录失败:', error))
  }
  ctx.on('session/event', (session: Session, event: SessionEvent) => {
    if (String(session.id) !== sessionId) return
    const line = transcriptLine(event)
    if (line && line.text) enqueueTranscript(line)
  })
  ctx.effect(() => () => writeChain, 'memory.transcript-flush')
}
