/**
 * 配置中心 — 控制台配置拉取与继承合并（纯函数 + fetch）
 *
 * 被 launcher (bin.ts) 和 assistant-config 插件复用。
 *
 * @module assistant/config/fetch
 */

import type {
  AssistantConfig,
  DeepseekProviderSettings,
  MediaCapabilityConfig,
  MediaConfig,
  MediaProviderProfile,
  PiAiProviderSettings,
  ProviderModel,
  ProviderSettings,
  SkillDef,
  WebSearchConfig,
} from './types.js'

/**
 * 控制台返回的「有效配置 + 版本」信封。
 * revision 单调递增，助手据此忽略乱序/过期 push（只接受 revision 更新的）。
 */
export interface ResolvedConfigEnvelope {
  revision: number
  config: AssistantConfig
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function normalizeModel(value: unknown): ProviderModel | null {
  if (!isRecord(value) || typeof value.id !== 'string' || value.id.length === 0) return null
  const model: ProviderModel = { id: value.id }
  for (const [key, val] of Object.entries(value)) {
    if (key === 'id') continue
    if (key === 'contextWindow' || key === 'maxTokens') {
      if (typeof val !== 'number' || !Number.isInteger(val) || val <= 0) continue
    }
    model[key] = val
  }
  return model
}

function normalizeDeepseek(value: unknown): DeepseekProviderSettings | undefined {
  if (!isRecord(value)) return undefined
  const out: DeepseekProviderSettings = {}
  if (typeof value.apiKey === 'string') out.apiKey = value.apiKey
  if (typeof value.apiKeyEnv === 'string') out.apiKeyEnv = value.apiKeyEnv
  if (typeof value.baseURL === 'string') out.baseURL = value.baseURL
  if (value.thinking === 'enabled' || value.thinking === 'disabled') out.thinking = value.thinking
  if (value.reasoningEffort === 'off' || value.reasoningEffort === 'high' || value.reasoningEffort === 'max') {
    out.reasoningEffort = value.reasoningEffort
  }
  for (const key of ['maxTokens', 'defaultContextWindow', 'streamIdleTimeoutMs'] as const) {
    if (typeof value[key] === 'number' && Number.isFinite(value[key]) && (value[key] as number) > 0) {
      out[key] = value[key] as number
    }
  }
  if (Array.isArray(value.models)) {
    const models = value.models.map(normalizeModel).filter((model): model is ProviderModel => model !== null)
    if (models.length > 0) out.models = models
  }
  return out
}

function normalizePiAiProvider(value: unknown): PiAiProviderSettings | undefined {
  if (!isRecord(value)) return undefined
  const out: PiAiProviderSettings = {}
  for (const key of ['apiKey', 'apiKeyEnv', 'displayName', 'api', 'baseURL', 'reasoning'] as const) {
    if (typeof value[key] === 'string') out[key] = value[key]
  }
  for (const key of ['defaultContextWindow', 'defaultMaxTokens', 'timeoutMs', 'streamIdleTimeoutMs'] as const) {
    if (typeof value[key] === 'number' && Number.isFinite(value[key]) && (value[key] as number) > 0) {
      out[key] = value[key] as number
    }
  }
  if (Array.isArray(value.models)) {
    const models = value.models.map(normalizeModel).filter((model): model is ProviderModel => model !== null)
    if (models.length > 0) out.models = models
  }
  for (const [key, val] of Object.entries(value)) {
    if (!(key in out)) out[key] = val
  }
  return out
}

function normalizeProviders(value: unknown): ProviderSettings | undefined {
  if (!isRecord(value)) return undefined
  const out: ProviderSettings = {}
  const deepseek = normalizeDeepseek(value.deepseek)
  if (deepseek) out.deepseek = deepseek

  if (isRecord(value.piAi) && isRecord(value.piAi.providers)) {
    const providers: Record<string, PiAiProviderSettings> = {}
    for (const [route, profile] of Object.entries(value.piAi.providers)) {
      const normalized = normalizePiAiProvider(profile)
      if (normalized) providers[route] = normalized
    }
    out.piAi = { providers }
  } else if (isRecord(value.piAi)) {
    out.piAi = { providers: {} }
  }

  return Object.keys(out).length > 0 ? out : undefined
}

function normalizeMediaProviderProfile(value: unknown): MediaProviderProfile | undefined {
  if (!isRecord(value)) return undefined
  const out: MediaProviderProfile = {}
  for (const key of ['apiKey', 'apiKeyEnv', 'baseURL', 'model'] as const) {
    if (typeof value[key] === 'string') out[key] = value[key]
  }
  // 各家专属参数（如 aspect_ratio / image_size / num_inference_steps…）原样透传
  for (const [key, val] of Object.entries(value)) {
    if (!(key in out)) out[key] = val
  }
  return out
}

function normalizeMediaCapability(value: unknown): MediaCapabilityConfig | undefined {
  if (!isRecord(value)) return undefined
  const out: MediaCapabilityConfig = {}
  if (typeof value.provider === 'string' && value.provider.length > 0) out.provider = value.provider
  if (isRecord(value.providers)) {
    const providers: Record<string, MediaProviderProfile> = {}
    for (const [name, profile] of Object.entries(value.providers)) {
      if (name.length === 0) continue
      const normalized = normalizeMediaProviderProfile(profile)
      if (normalized) providers[name] = normalized
    }
    out.providers = providers
  }
  return Object.keys(out).length > 0 ? out : undefined
}

function normalizeMedia(value: unknown): MediaConfig | undefined {
  if (!isRecord(value)) return undefined
  const out: MediaConfig = {}
  for (const cap of ['imageGen', 'asr', 'tts'] as const) {
    const normalized = normalizeMediaCapability(value[cap])
    if (normalized) out[cap] = normalized
  }
  return Object.keys(out).length > 0 ? out : undefined
}

/** 规范化控制台返回的配置对象，只保留已知字段。 */
function normalizeConfig(value: unknown): AssistantConfig {
  if (!isRecord(value)) return {}
  const config: AssistantConfig = {}

  if (typeof value.provider === 'string' && value.provider.length > 0) config.provider = value.provider
  if (typeof value.model === 'string' && value.model.length > 0) config.model = value.model

  const providers = normalizeProviders(value.providers)
  if (providers) config.providers = providers

  if (typeof value.persona === 'string') config.persona = value.persona
  if (typeof value.agentMd === 'string') config.agentMd = value.agentMd
  if (typeof value.maxTokens === 'number' && Number.isInteger(value.maxTokens) && value.maxTokens > 0) {
    config.maxTokens = value.maxTokens
  }
  if (Array.isArray(value.skills)) {
    config.skills = value.skills.filter((skill): skill is string => typeof skill === 'string' && skill.length > 0)
  }

  const media = normalizeMedia(value.media)
  if (media) config.media = media

  if (isRecord(value.webSearch)) {
    const search: WebSearchConfig = {}
    for (const key of ['apiKey', 'apiKeyEnv', 'baseURL', 'model'] as const) {
      if (typeof value.webSearch[key] === 'string') search[key] = value.webSearch[key]
    }
    for (const key of ['maxTokens', 'maxUses'] as const) {
      const number = value.webSearch[key]
      if (typeof number === 'number' && Number.isSafeInteger(number) && number > 0) search[key] = number
    }
    config.webSearch = search
  }

  if (isRecord(value.swarm)) {
    const swarm: NonNullable<AssistantConfig['swarm']> = {}
    if (typeof value.swarm.maxDepth === 'number' && Number.isSafeInteger(value.swarm.maxDepth)) swarm.maxDepth = value.swarm.maxDepth
    if (typeof value.swarm.maxMembers === 'number' && Number.isSafeInteger(value.swarm.maxMembers)) swarm.maxMembers = value.swarm.maxMembers
    if (typeof value.swarm.contextMaxBytes === 'number' && Number.isSafeInteger(value.swarm.contextMaxBytes)) swarm.contextMaxBytes = value.swarm.contextMaxBytes
    if (typeof value.swarm.contextMaxEntries === 'number' && Number.isSafeInteger(value.swarm.contextMaxEntries)) swarm.contextMaxEntries = value.swarm.contextMaxEntries
    if (Object.keys(swarm).length > 0) config.swarm = swarm
  }

  return config
}

async function fetchJson(url: string, timeoutMs: number, throwOnError = false): Promise<unknown | null> {
  try {
    const res = await fetch(url, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`)
    return await res.json()
  } catch (error) {
    if (throwOnError) throw error
    return null
  }
}

/**
 * 规范化「有效配置 + 版本」信封。启动拉取与 HTTP push 共用。
 * 非法输入返回 null；运行时调用方可保留已生效配置。
 */
export function normalizeEnvelope(data: unknown): ResolvedConfigEnvelope | null {
  if (!isRecord(data) || !isRecord(data.config)) return null
  const revision = typeof data.revision === 'number' && Number.isInteger(data.revision) && data.revision >= 0
    ? data.revision
    : 0
  return { revision, config: normalizeConfig(data.config) }
}

/**
 * 从控制台拉取某个助手的合并后有效配置（含 revision）。
 * 运行时拉取失败返回 null，保留已生效配置；启动可指定 throwOnError 暴露原因。
 */
export async function fetchResolvedConfig(
  consoleUrl: string,
  sessionId: string,
  timeoutMs = 2000,
  options: { throwOnError?: boolean } = {},
): Promise<ResolvedConfigEnvelope | null> {
  const base = consoleUrl.replace(/\/+$/, '')
  const url = `${base}/api/config/resolve?sessionId=${encodeURIComponent(sessionId)}`
  const data = await fetchJson(url, timeoutMs, options.throwOnError)
  const envelope = data === null ? null : normalizeEnvelope(data)
  if (!envelope && options.throwOnError) throw new Error('响应不是有效的配置对象（缺少 config 对象）')
  return envelope
}

/** 从控制台技能库拉取一个技能的完整正文。 */
export async function fetchSkill(
  consoleUrl: string,
  name: string,
  timeoutMs = 2000,
): Promise<SkillDef | null> {
  const base = consoleUrl.replace(/\/+$/, '')
  const url = `${base}/api/skills/${encodeURIComponent(name)}`
  const data = await fetchJson(url, timeoutMs)
  if (!isRecord(data)) return null
  if (typeof data.name !== 'string' || typeof data.content !== 'string' || data.content.length === 0) {
    return null
  }
  return {
    name: data.name,
    description: typeof data.description === 'string' ? data.description : '',
    content: data.content,
  }
}
