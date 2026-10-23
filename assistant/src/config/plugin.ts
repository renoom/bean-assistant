/**
 * assistant-config 插件 — 配置中心助手端运行时
 *
 * 职责：
 *   1. agent 就绪后安装模型选择器（热切换 provider/model）
 *   2. 启动时从控制台拉取有效配置并应用热字段
 *   3. 暴露 ingest() 给 HTTP push 端点：控制台配置变更时即时下发
 *
 * 交互一律走 HTTP（启动拉取 + 变更 push），不再轮询、不再 diff。
 * 冷字段（persona/agentMd/maxTokens）由 launcher 在启动时注入，此处不处理。
 * 不碰 agent 创建、不碰 HTTP 服务。
 *
 * @module assistant/config/plugin
 */

import type { Context } from '@deepseek-ai/cordis'
import type { AssistantService } from '../plugin.js'
import { fetchResolvedConfig, normalizeEnvelope, type ResolvedConfigEnvelope } from './fetch.js'
import type { MediaConfig, SwarmConfig } from './types.js'
import { createProviderApplier } from './apply/providers.js'
import { createModelApplier } from './apply/model.js'
import { createSkillApplier } from './apply/skills.js'

export const name = 'assistant-config'
export const inject = ['assistant', 'credentials', 'skills', 'settings']

export interface Config {
  /** 单次拉取超时（毫秒），默认 2000。 */
  fetchTimeoutMs?: number
}

export function apply(ctx: Context, config: Config = {}): void {
  const assistant: AssistantService = ctx.assistant
  const consoleUrl = assistant.consoleUrl
  if (!consoleUrl) {
    console.log('[assistant-config] 未配置 console-url，配置中心功能关闭（独立运行，使用显式启动参数）')
    return
  }
  const fetchTimeoutMs = config.fetchTimeoutMs ?? 2000

  console.log(`[assistant-config] 配置中心已启用: ${consoleUrl} (session=${assistant.sessionId})`)

  // agent 可能因 resume 读磁盘而异步就绪；等就绪后再装模型选择器并启动拉取。
  void assistant.whenAgentReady().then((agent) => {
    // 三个应用器各自内聚：模型选择 / 供应商配置 / 技能下发
    const modelApplier = createModelApplier(agent)
    const providerApplier = createProviderApplier(ctx)
    const skillApplier = createSkillApplier(ctx, consoleUrl)

    let lastRevision = -1
    let latestMedia: MediaConfig | undefined
    let latestSwarm: SwarmConfig | undefined

    async function ingest(envelope: ResolvedConfigEnvelope): Promise<void> {
      // revision 单调递增：忽略乱序/过期的下发。
      if (envelope.revision <= lastRevision) return
      lastRevision = envelope.revision

      const next = envelope.config
      modelApplier.apply(next)
      await providerApplier.apply(next.providers, next.webSearch)
      await skillApplier.apply(next.skills)
      latestMedia = next.media
      latestSwarm = next.swarm
    }

    // 暴露给 assistant HTTP 服务：/api/status 读热切换后的 model/provider，
    // POST /api/config/push 把控制台下发的配置喂进 seam。
    interface AssistantConfigService {
      currentModel(): { provider?: string; model?: string } | undefined
      media(): MediaConfig | undefined
      swarm(): SwarmConfig | undefined
      ingest(raw: unknown): Promise<void>
    }
    ctx.provide('assistantConfig', {
      currentModel() {
        const current = modelApplier.selection.current
        return current ? { provider: String(current.provider), model: String(current.model) } : undefined
      },
      media() {
        return latestMedia
      },
      swarm() {
        return latestSwarm
      },
      async ingest(raw: unknown): Promise<void> {
        const envelope = normalizeEnvelope(raw)
        if (envelope) await ingest(envelope)
      },
    } satisfies AssistantConfigService)

    // 启动拉取：把控制台有效配置应用到已创建的 agent（冷字段已在 launcher 注入）。
    void (async () => {
      const envelope = await fetchResolvedConfig(consoleUrl, assistant.sessionId, fetchTimeoutMs)
      if (envelope) await ingest(envelope)
    })()

    ctx.effect(() => () => {
      modelApplier.dispose()
      skillApplier.disposeAll()
    }, 'assistant-config.shutdown')
  })
}
