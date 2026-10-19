/**
 * 压缩门控 — 压缩全套流程期间 block 新消息, 新消息进队列等待
 *
 * 背景: dsh 的 compactNow 用 runMaintenance 保证「压缩 surface」期间新消息
 * 留在 inbox (排队), 但它只覆盖 surface 压缩这个动作。我们后续的
 * 「summary 存记忆 + LLM 提取」在 compaction/summary 事件里异步执行,
 * 不在 runMaintenance 保护内, 会与新消息的 turn 竞争。
 *
 * 本模块提供应用层门控, 把「压缩全套流程」纳入互斥:
 *   - runCompactionFlow(flow): 同步标记 compacting, 串行执行 flow, 完成后 flush 队列
 *   - enqueueOrFollowup(msg): 压缩中则排队, 否则直接 followup
 *
 * @module assistant/memory/gate
 */

import type { Agent } from '@deepseek-ai/dsh-agent'
import type { UserMessage } from '@deepseek-ai/dsh-llm'

let agent: Agent | undefined
let compacting = false
let queue: UserMessage[] = []
/** 排队或执行中的压缩流程数, 归零才解除门控 (处理并发触发)。 */
let pendingFlows = 0
/** 串行化压缩流程, 保证同一时间只跑一个 flow。 */
let flowChain: Promise<void> = Promise.resolve()

/** 绑定当前主 agent (plugin.ts 在 startServer 时调用)。 */
export function bindAgent(a: Agent): void {
  agent = a
}

/** 是否正处于压缩流程中。 */
export function isCompacting(): boolean {
  return compacting
}

/** Wait until already queued memory writes/extraction have finished. */
export async function flushCompactionFlows(): Promise<void> {
  await flowChain
}

/**
 * 消息入口: 压缩中则进队列等待, 否则直接 followup。
 * 替代所有 agent.followup 的用户消息投递点。
 */
export function enqueueOrFollowup(message: UserMessage): void {
  if (!agent) return
  if (compacting) {
    queue.push(message)
  } else {
    agent.followup(message)
  }
}

/**
 * 执行一段压缩流程, 期间 block 新消息。
 * 同步标记 compacting (无微任务窗口), 串行化执行, 全部完成后 flush 队列。
 */
export function runCompactionFlow(flow: () => Promise<void>): Promise<void> {
  pendingFlows += 1
  compacting = true

  const run = flowChain.then(async () => {
    try {
      await flow()
    } finally {
      pendingFlows -= 1
      if (pendingFlows === 0) {
        compacting = false
        if (agent) {
          const pending = queue
          queue = []
          for (const msg of pending) agent.followup(msg)
        }
      }
    }
  })
  // 保证 flowChain 永不 rejected, 后续流程不被中断; 原始错误由返回的 run 暴露给调用者
  flowChain = run.catch(() => {})
  return run
}
