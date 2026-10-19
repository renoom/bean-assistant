/**
 * 配置中心 — 供应商模型配置应用器
 *
 * 直接使用 dsh 原生配置插件能力：
 *   - 把控制台的 providers 翻译成 settings 命名空间文档，
 *     一次性 push 进纯内存 settings seam → `settings/updated` 事件
 *     → llm-deepseek / llm-pi-ai 自动热应用（applies: live）。
 *   - 各供应商 apiKey 经 dsh credentials 写入（settings 只存 apiKeyEnv 引用）。
 *
 * 每个供应商拥有独立的 baseURL / apiKeyEnv / api / models / 超时等配置，
 * 不再使用单个扁平 apiKey。
 *
 * @module assistant/config/apply/providers
 */

import type { Context } from '@deepseek-ai/cordis'
import type {
  DeepseekProviderSettings,
  PiAiProviderSettings,
  ProviderSettings,
  WebSearchConfig,
} from '../types.js'
import { addWebSearchCredential, webSearchSection, WEB_SEARCH_NAMESPACE } from './web-search.js'

const DEEPSEEK_NS = 'llm-deepseek'
const PIAI_NS = 'llm-pi-ai'
const DEFAULT_DEEPSEEK_API_KEY_ENV = 'DEEPSEEK_API_KEY'

interface SettingsService {
  /** 纯内存 settings seam 的注入入口（对应 MemorySettingsProvider.push）。 */
  push(doc: Record<string, unknown>): void
}

interface CredentialsService {
  set(ref: string, value: string): Promise<void>
  unset(ref: string): Promise<void>
}

function settingsOf(ctx: Context): SettingsService | undefined {
  return (ctx as unknown as { settings?: SettingsService }).settings
}

function credentialsOf(ctx: Context): CredentialsService | undefined {
  return (ctx as unknown as { credentials?: CredentialsService }).credentials
}

export interface ProviderApplier {
  apply(providers: ProviderSettings | undefined, webSearch?: WebSearchConfig): Promise<void>
}

/**
 * 创建供应商配置应用器。providers 为 undefined 时表示控制台未配置该字段，
 * 保留 dsh 插件自身的 composition fallback（空 section 重新继承 base）。
 */
export function createProviderApplier(ctx: Context): ProviderApplier {
  const settings = settingsOf(ctx)
  const credentials = credentialsOf(ctx)
  const appliedKeys = new Set<string>()

  return {
    async apply(providers: ProviderSettings | undefined, webSearch?: WebSearchConfig): Promise<void> {
      const desired = collectCredentials(providers)
      addWebSearchCredential(desired, webSearch, providers)
      // 1. settings：整文档热发布。publish 内部按命名空间 deep-equal 门控，
      //    未变化的 section 不触发 settings/updated，无重复应用开销。
      settings?.push({
        [DEEPSEEK_NS]: toDeepseekSection(providers?.deepseek),
        [PIAI_NS]: toPiAiSection(providers?.piAi),
        [WEB_SEARCH_NAMESPACE]: webSearchSection(webSearch, providers),
      })

      if (!credentials) return

      // 2. credentials：写入当前密钥，卸载已不再配置的引用。
      const desiredKeys = new Set(desired.keys())

      for (const key of [...appliedKeys]) {
        if (desiredKeys.has(key)) continue
        try {
          await credentials.unset(key)
          appliedKeys.delete(key)
          console.log(`[assistant-config] 凭证已清空: ${key}`)
        } catch (err) {
          console.warn(`[assistant-config] 凭证 ${key} 清空失败:`, err instanceof Error ? err.message : String(err))
        }
      }

      for (const [ref, value] of desired) {
        try {
          if (value.length === 0) {
            await credentials.unset(ref)
            console.log(`[assistant-config] 凭证已清空: ${ref}`)
          } else {
            await credentials.set(ref, value)
            console.log(`[assistant-config] 凭证已热切换: ${ref}`)
          }
          appliedKeys.add(ref)
        } catch (err) {
          console.warn(`[assistant-config] 凭证 ${ref} 热切换失败:`, err instanceof Error ? err.message : String(err))
        }
      }
    },
  }
}

function toDeepseekSection(config: DeepseekProviderSettings | undefined): Record<string, unknown> {
  if (!config) return {}
  const section: Record<string, unknown> = {}
  for (const key of [
    'apiKeyEnv',
    'baseURL',
    'thinking',
    'reasoningEffort',
    'maxTokens',
    'defaultContextWindow',
    'models',
    'streamIdleTimeoutMs',
  ] as const) {
    if (config[key] !== undefined) section[key] = config[key]
  }
  return section
}

function toPiAiSection(config: { providers?: Record<string, PiAiProviderSettings> } | undefined): { providers: Record<string, unknown> } {
  if (!config?.providers) return { providers: {} }
  const providers: Record<string, unknown> = {}
  for (const [route, profile] of Object.entries(config.providers)) {
    const section: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(profile)) {
      if (key === 'apiKey') continue
      section[key] = value
    }
    providers[route] = section
  }
  return { providers }
}

function collectCredentials(providers: ProviderSettings | undefined): Map<string, string> {
  const out = new Map<string, string>()

  const deepseek = providers?.deepseek
  if (deepseek?.apiKey !== undefined) {
    out.set(deepseek.apiKeyEnv || DEFAULT_DEEPSEEK_API_KEY_ENV, deepseek.apiKey)
  }

  for (const profile of Object.values(providers?.piAi?.providers ?? {})) {
    if (profile.apiKey === undefined) continue
    if (!profile.apiKeyEnv) {
      console.warn('[assistant-config] pi-ai 供应商缺少 apiKeyEnv，无法写入 apiKey')
      continue
    }
    out.set(profile.apiKeyEnv, profile.apiKey)
  }

  return out
}
