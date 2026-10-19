/**
 * 配置中心 — model/provider 热切换应用器
 *
 * 依赖 dsh-agent 的 installModelSelection：把可变的 selection 安装到
 * agent scoped context，修改 selection.current 后下一步请求即用新模型。
 *
 * @module assistant/config/apply/model
 */

import type { Agent } from '@deepseek-ai/dsh-agent'
import {
  installModelSelection,
  type ModelSelection,
  type ModelSelectionRef,
} from '@deepseek-ai/dsh-agent'
import type { AssistantConfig } from '../types.js'

export interface ModelApplier {
  /** 供诊断/测试读取的当前选择。 */
  readonly selection: ModelSelectionRef
  apply(config: AssistantConfig): void
  dispose(): void
}

/**
 * 安装模型选择器。初始值优先取 agent 创建时的 options；
 * 配置中心返回 provider/model 后会覆盖为控制台值。
 */
export function createModelApplier(agent: Agent): ModelApplier {
  const initial: ModelSelection | undefined =
    agent.options.provider && agent.options.model
      ? { provider: String(agent.options.provider), model: String(agent.options.model) }
      : undefined

  const selection: ModelSelectionRef = {
    current: initial,
    assembled: undefined,
  }

  const dispose = installModelSelection(agent.ctx, selection)

  return {
    selection,
    apply(config: AssistantConfig): void {
      // 只接受完整、非空的新选择；半截配置忽略（配置中心始终下发完整 provider+model）。
      if (!config.provider || !config.model) return
      selection.current = {
        provider: config.provider,
        model: config.model,
      }
    },
    dispose,
  }
}
