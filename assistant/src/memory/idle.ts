/** 主会话闲置压缩。 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-compaction'

/** 闲置多久触发压缩（LLM stop 后）。 */
const IDLE_MS = 30 * 60 * 1000
const MAX_RETRIES = 2

export type IdleCompactionOutcome = 'compacted' | 'skipped' | 'failed' | 'cancelled'

export interface IdleCompactionSnapshot {
  idleMs: number
  nextRunAt: number | null
  lastRunAt: number | null
  lastOutcome: IdleCompactionOutcome | null
  lastError: string | null
  running: boolean
}

export interface IdleCompactionController { snapshot(): IdleCompactionSnapshot }
export interface IdleCompactionOptions { idleMs?: number; maxRetries?: number }

/**
 * 安装主 Agent 的闲置压缩。恢复后的 Agent 不会补发 status 事件，故安装时也会
 * 检查当前 idle 状态。成功或 no-op 后不自循环，等待下一次真实的 idle 周期。
 */
export function installIdleCompaction(
  ctx: Context,
  sessionId: string,
  agent: Agent,
  options: IdleCompactionOptions = {},
): IdleCompactionController {
  const idleMs = options.idleMs ?? IDLE_MS
  const maxRetries = options.maxRetries ?? MAX_RETRIES
  let timer: NodeJS.Timeout | undefined
  let abort: AbortController | undefined
  let retries = 0
  let disposed = false
  let pendingIdlePeriod = false
  const state: IdleCompactionSnapshot = {
    idleMs, nextRunAt: null, lastRunAt: null, lastOutcome: null, lastError: null, running: false,
  }

  const cancelTimer = (): void => {
    if (timer !== undefined) clearTimeout(timer)
    timer = undefined
    state.nextRunAt = null
  }

  const schedule = (): void => {
    if (disposed || state.running || agent.status !== 'idle') return
    cancelTimer()
    state.nextRunAt = Date.now() + idleMs
    timer = setTimeout(() => {
      timer = undefined
      state.nextRunAt = null
      void run()
    }, idleMs)
    timer.unref?.()
  }

  const failed = (error: unknown): boolean => {
    state.lastOutcome = 'failed'
    state.lastError = error instanceof Error ? error.message : String(error)
    console.warn('[idle] 闲置压缩失败:', error)
    if (!disposed && agent.status === 'idle' && retries < maxRetries) {
      retries += 1
      return true
    }
    return false
  }

  const run = async (): Promise<void> => {
    if (disposed || state.running || agent.status !== 'idle') return
    state.running = true
    state.lastRunAt = Date.now()
    abort = new AbortController()
    let retry = false
    try {
      const result = await ctx.compaction.compactNow(agent, abort.signal)
      if (disposed || abort.signal.aborted) {
        state.lastOutcome = 'cancelled'
      } else if (result === null) {
        state.lastOutcome = 'skipped'
        state.lastError = null
      } else {
        state.lastOutcome = 'compacted'
        state.lastError = null
        console.log(`[idle] 闲置压缩完成: shadowed ${result.shadowedSeqs.length} nodes`)
      }
    } catch (error) {
      if (disposed || abort.signal.aborted) state.lastOutcome = 'cancelled'
      else retry = failed(error)
    } finally {
      abort = undefined
      state.running = false
      if (retry || pendingIdlePeriod) {
        pendingIdlePeriod = false
        schedule()
      }
    }
  }

  const beginIdlePeriod = (): void => {
    retries = 0
    if (state.running) {
      // 虽然 maintenance 正常不会改变 Agent 状态，仍要保留真实运行周期，
      // 防止 compactNow 完成前的 running → idle 转换丢失下一次计时。
      pendingIdlePeriod = true
      return
    }
    schedule()
  }

  ctx.on('agent/status', ({ agent: subject, status }: { agent: Agent; status: 'idle' | 'running' }) => {
    if (String(subject.id) !== sessionId) return
    cancelTimer()
    if (status === 'idle') beginIdlePeriod()
  })
  if (String(agent.id) === sessionId && agent.status === 'idle') beginIdlePeriod()

  ctx.effect(() => () => {
    disposed = true
    cancelTimer()
    if (abort !== undefined) {
      abort.abort()
      state.running = false
      state.lastOutcome = 'cancelled'
    }
  }, 'memory.idle-compaction')

  return { snapshot: () => ({ ...state }) }
}
