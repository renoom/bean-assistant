/**
 * 会话观测 — 汇总 dsh 已算好的会话指标, 供 UI 面板展示
 *
 * 全部指标来自 dsh 原生能力, 本模块只做「读 + 派生」, 不重复统计:
 *   - sessionStats     (dsh-session-stats):  轮次/步数/LLM 时间/工具时间/首 token/吞吐
 *   - tokenUsage       (dsh-token-meter):    输入/输出/缓存读/缓存写 token
 *   - contextBreakdown (dsh-token-meter):    系统提示词/工具/对话消息 token 分项
 *   - contextPressure  (dsh-token-meter):    上下文窗口大小
 *   - tokenMeter.measure():                  当前 surface 总 token
 *
 * @module assistant/observability
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
// Type-only: 激活 ctx.sessionProjections 及 projection key 声明合并
import type {} from '@deepseek-ai/dsh-session-projection'
// Type-only: 激活 ctx.tokenMeter 及 tokenUsage/contextPressure/contextBreakdown 声明
import type {} from '@deepseek-ai/dsh-token-meter'
// Type-only: 激活 sessionStats projection key 声明
import type {} from '@deepseek-ai/dsh-session-stats'

export interface ObservabilitySnapshot {
  // 轮次/步数
  turns: number
  steps: number
  // 时间 (ms)
  llmMs: number
  toolMs: number
  ttftMs: number
  ttftSteps: number
  decodeMs: number
  // token 使用
  uncachedInputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  outputTokens: number
  // 上下文
  totalTokens: number
  surfaceTokens: number
  contextWindow?: number
  systemTokens: number
  toolsTokens: number
  messageTokens: number
  // 派生指标
  cacheHitRate: number      // 0~1
  tokensPerSecond: number   // decode 吞吐
  avgTtftMs: number         // 平均首 token 延迟
}

/** 从 dsh 的 projection + token-meter 汇总一次会话观测快照。 */
export function collectObservability(ctx: Context, agent: Agent): ObservabilitySnapshot {
  const session = agent.session
  const values = ctx.sessionProjections.snapshot(session).values
  const stats = values.sessionStats
  const usage = values.tokenUsage
  const breakdown = values.contextBreakdown
  const pressure = values.contextPressure
  const measurement = ctx.tokenMeter.measure(session)

  const llmMs = stats?.llmMs ?? 0
  const toolMs = stats?.toolMs ?? 0
  const ttftMs = stats?.ttftMs ?? 0
  const ttftSteps = stats?.ttftSteps ?? 0
  const decodeMs = stats?.decodeMs ?? 0
  const decodeTokens = stats?.decodeTokens ?? 0

  const uncachedInput = usage?.uncachedInputTokens ?? 0
  const cacheRead = usage?.cacheReadTokens ?? 0
  const cacheWrite = usage?.cacheWriteTokens ?? 0
  const output = usage?.outputTokens ?? 0

  const totalInput = uncachedInput + cacheRead + cacheWrite
  const cacheHitRate = totalInput > 0 ? cacheRead / totalInput : 0
  const tokensPerSecond = decodeMs > 0 ? decodeTokens / (decodeMs / 1000) : 0
  const avgTtftMs = ttftSteps > 0 ? ttftMs / ttftSteps : 0

  return {
    turns: stats?.turns ?? 0,
    steps: stats?.steps ?? 0,
    llmMs,
    toolMs,
    ttftMs,
    ttftSteps,
    decodeMs,
    uncachedInputTokens: uncachedInput,
    cacheReadTokens: cacheRead,
    cacheWriteTokens: cacheWrite,
    outputTokens: output,
    totalTokens: measurement.totalTokens,
    surfaceTokens: measurement.surfaceTokens,
    contextWindow: pressure?.contextWindow,
    systemTokens: breakdown?.systemTokens ?? 0,
    toolsTokens: breakdown?.toolsTokens ?? 0,
    messageTokens: breakdown?.messageTokens ?? 0,
    cacheHitRate,
    tokensPerSecond,
    avgTtftMs,
  }
}
