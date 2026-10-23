/**
 * 配置中心 — 公共配置 + 助手私有配置（继承覆盖）
 *
 * 模型配置对齐 dsh 原生能力：
 *   - `provider` / `model`：agent 的模型选择（provider 为已注册路由名）
 *   - `providers.deepseek`：对应 dsh `llm-deepseek` 插件配置
 *   - `providers.piAi.providers`：对应 dsh `llm-pi-ai` 插件配置
 *   - `apiKey` 由助手端通过 dsh credentials seam 写入隔离凭证文件
 *
 * 热字段（provider/model/providers/skills）运行时立即生效；
 * 冷字段（persona/agentMd/maxTokens）变更后标记「待重启」，需手动重启助手。
 *
 * @module console/config
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

// ── 类型 ────────────────────────────────────────────────────────────────────

/** 模型目录条目（与 dsh catalog model 对齐）。 */
export interface ProviderModel {
  id: string
  name?: string
  description?: string
  contextWindow?: number
  maxTokens?: number
  [key: string]: unknown
}

/** DeepSeek 官方供应商配置（对应 dsh `llm-deepseek` settings section）。 */
export interface DeepseekProviderSettings {
  /** 实际密钥；助手端写入 dsh credentials，不进入 dsh settings 文档 */
  apiKey?: string
  /** 凭证引用（环境变量名），默认 DEEPSEEK_API_KEY */
  apiKeyEnv?: string
  /** Endpoint base；缺省回退 $DEEPSEEK_BASE_URL → https://api.deepseek.com */
  baseURL?: string
  /** 部署思考策略 */
  thinking?: 'enabled' | 'disabled'
  /** 默认推理强度 */
  reasoningEffort?: 'off' | 'high' | 'max'
  /** 默认单请求输出上限 */
  maxTokens?: number
  /** 默认上下文容量 */
  defaultContextWindow?: number
  /** 模型目录（缺省为 V4 Flash / V4 Pro） */
  models?: ProviderModel[]
  /** 流式读取空闲超时 */
  streamIdleTimeoutMs?: number
}

/** pi-ai 供应商 profile（对应 dsh `llm-pi-ai` 的 providers.{route}）。 */
export interface PiAiProviderSettings {
  /** 实际密钥；助手端写入 dsh credentials */
  apiKey?: string
  /** 凭证引用（环境变量名），如 OPENAI_API_KEY */
  apiKeyEnv?: string
  /** 展示名称 */
  displayName?: string
  /** wire protocol（如 openai-completions / anthropic-messages） */
  api?: string
  /** 该路由的 endpoint base */
  baseURL?: string
  /** 模型目录（缺省用 pi-ai 内置 catalog） */
  models?: ProviderModel[]
  /** 模型缺省上下文容量 */
  defaultContextWindow?: number
  /** 模型缺省输出能力 */
  defaultMaxTokens?: number
  /** provider-neutral 推理级别 */
  reasoning?: string
  /** 超时设置 */
  timeoutMs?: number
  streamIdleTimeoutMs?: number
  [key: string]: unknown
}

/** pi-ai 供应商集合。 */
export interface PiAiProvidersSection {
  providers?: Record<string, PiAiProviderSettings>
}

/** 供应商配置集合（对应 dsh settings 文档中的 llm-deepseek / llm-pi-ai）。 */
export interface ProviderSettings {
  deepseek?: DeepseekProviderSettings
  piAi?: PiAiProvidersSection
}

/** 多模态能力供应商 profile（公共可被私有覆盖）。字段各家专属，宽松索引签名。 */
export interface MediaProviderProfile {
  /** 实际密钥；工具调用时直接用 */
  apiKey?: string
  /** 凭证引用（环境变量名），apiKey 缺省时回退 process.env[apiKeyEnv] */
  apiKeyEnv?: string
  /** 该厂家的 endpoint base（缺省各家内置） */
  baseURL?: string
  /** 默认模型 */
  model?: string
  [key: string]: unknown
}

/** 单个多模态能力的配置：当前选中的厂家 + 各家 profile。同时只能选一个厂家。 */
export interface MediaCapabilityConfig {
  /** 当前选中的厂家 key（指向 providers 里的某个 key） */
  provider?: string
  /** 各家 profile，key = 厂家名（如 minimax / siliconflow） */
  providers?: Record<string, MediaProviderProfile>
}

/** 独立媒体能力配置（图片生成、语音识别/合成）。视觉输入属于 LLM 本身。 */
export interface MediaConfig {
  imageGen?: MediaCapabilityConfig
  asr?: MediaCapabilityConfig
  tts?: MediaCapabilityConfig
}

/** dsh 原生 DeepSeek 搜索配置，凭证由助手写入 credentials seam。 */
export interface WebSearchConfig {
  apiKey?: string
  apiKeyEnv?: string
  baseURL?: string
  model?: string
  maxTokens?: number
  maxUses?: number
}

/** 蜂群（助手内 subagent）配置。热字段，运行时由 SwarmManager 读取。 */
export interface SwarmConfig {
  /** 递归层级上限（主 agent 为 0）。默认 3，绝对上限 10。 */
  maxDepth?: number
  /** 同时存活的直接子代理数量上限。默认 5，绝对上限 20。 */
  maxMembers?: number
  /** 共享上下文总字节上限。默认 8192。 */
  contextMaxBytes?: number
  /** 共享上下文条目数上限。默认 50。 */
  contextMaxEntries?: number
}

/** 助手可配置字段（公共与私有共用同一 schema）。 */
export interface AssistantConfig {
  /** LLM 供应商路由名（热） */
  provider?: string
  /** 模型名（热） */
  model?: string
  /** 供应商模型配置（热，经 dsh settings/credentials 生效） */
  providers?: ProviderSettings
  /** 系统人设（冷，启动时组装） */
  persona?: string
  /** agent.md 指令内容（冷） */
  agentMd?: string
  /** 最大输出 token（冷，agent 创建时固化） */
  maxTokens?: number
  /** 技能名列表（热下发） */
  skills?: string[]
  /** 启用的交互 channel（冷）。 */
  channels?: string[]
  /** 环境信息描述（冷；公共专用，私有配置不可覆盖） */
  environment?: string
  /** 独立媒体能力配置（热；图片生成、语音识别/合成，公共可被私有覆盖） */
  media?: MediaConfig
  webSearch?: WebSearchConfig
  /** 蜂群配置（热） */
  swarm?: SwarmConfig
}

/** 配置补丁：字段值为 null 表示删除该字段（恢复继承 / 清空覆盖）。 */
export type AssistantConfigPatch = {
  [K in keyof AssistantConfig]?: AssistantConfig[K] | null
}

/** 技能库条目。 */
export interface SkillDef {
  name: string
  description?: string
  content: string
}

/** 配置中心持久化结构。 */
export interface ConfigStore {
  /** 单调递增版本号：每次持久化 +1，助手据此忽略乱序/过期 push。 */
  revision: number
  public: AssistantConfig
  assistants: Record<string, AssistantConfig>
  skillLibrary: Record<string, SkillDef>
}

// ── 冷/热字段元数据 ─────────────────────────────────────────────────────────

export const HOT_FIELDS = ['provider', 'model', 'providers', 'skills', 'media', 'webSearch', 'swarm'] as const
export const COLD_FIELDS = ['persona', 'agentMd', 'maxTokens', 'channels', 'environment'] as const
export const CONFIG_FIELDS = [...HOT_FIELDS, ...COLD_FIELDS] as const

export type ConfigField = typeof CONFIG_FIELDS[number]
export type ConfigEffect = 'hot' | 'cold'

export const CONFIG_FIELD_EFFECT: Record<ConfigField, ConfigEffect> = {
  provider: 'hot',
  model: 'hot',
  providers: 'hot',
  skills: 'hot',
  media: 'hot',
  webSearch: 'hot',
  swarm: 'hot',
  persona: 'cold',
  agentMd: 'cold',
  maxTokens: 'cold',
  channels: 'cold',
  environment: 'cold',
}

const COLD_FIELD_SET = new Set<string>(COLD_FIELDS)
const KNOWN_FIELD_SET = new Set<string>(CONFIG_FIELDS)
const SKILL_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const CREDENTIAL_REF_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/
const REASONING_EFFORTS = new Set(['off', 'high', 'max'])
const THINKING_POLICIES = new Set(['enabled', 'disabled'])

/** 可选的 channel 清单。与 assistant 端 channel 注册表保持一致。 */
export const AVAILABLE_CHANNELS = ['http', 'stage'] as const

/** 判断一个 patch 是否含冷字段。 */
export function patchHasCold(patch: AssistantConfigPatch): boolean {
  return Object.keys(patch).some(key => COLD_FIELD_SET.has(key))
}

/** 校验技能名（与 dsh-skill 的 kebab-case 规则保持一致）。 */
export function isValidSkillName(name: string): boolean {
  return SKILL_NAME_PATTERN.test(name)
}

/** 校验凭证引用（与 dsh credentials 的 POSIX 环境变量名规则一致）。 */
export function isValidCredentialRef(value: string): boolean {
  return CREDENTIAL_REF_PATTERN.test(value)
}

// ── 缺省公共配置 ────────────────────────────────────────────────────────────

const DEFAULT_STORE: ConfigStore = {
  revision: 0,
  public: {
    provider: 'deepseek-official',
    model: 'deepseek-v4-flash',
    providers: {
      deepseek: {
        apiKeyEnv: 'DEEPSEEK_API_KEY',
        apiKey: '',
        baseURL: 'https://api.deepseek.com',
        maxTokens: 256000,
        defaultContextWindow: 1000000,
        models: [
          { id: 'deepseek-v4-flash', name: 'DeepSeek-V4-Flash', contextWindow: 1000000, maxTokens: 256000 },
          { id: 'deepseek-v4-pro', name: 'DeepSeek-V4-Pro', contextWindow: 1000000, maxTokens: 256000 },
        ],
      },
      piAi: {
        providers: {},
      },
    },
    persona: [
      '你是一个 AI 助手，由 deepseek-v4-flash 模型驱动。',
      '你可以使用工具帮助用户完成任务：读写文件、执行命令、搜索代码、搜索网络等。',
      '请用中文回复，保持专业、友好、简洁。',
    ].join('\n'),
    maxTokens: 256000,
    skills: [],
    channels: [...AVAILABLE_CHANNELS],
  },
  assistants: {},
  skillLibrary: {},
}


function cloneProviderSettings(value: ProviderSettings | undefined): ProviderSettings | undefined {
  if (!value) return undefined
  const clone: ProviderSettings = {}
  if (value.deepseek) clone.deepseek = { ...value.deepseek }
  if (value.piAi) {
    clone.piAi = {
      providers: value.piAi.providers
        ? Object.fromEntries(Object.entries(value.piAi.providers).map(([name, profile]) => [name, { ...profile }]))
        : {},
    }
  }
  return clone
}

function cloneMediaConfig(media: MediaConfig | undefined): MediaConfig | undefined {
  if (!media) return undefined
  const clone: MediaConfig = {}
  for (const cap of ['imageGen', 'asr', 'tts'] as const) {
    const c = media[cap]
    if (!c) continue
    clone[cap] = {
      ...(c.provider !== undefined ? { provider: c.provider } : {}),
      providers: c.providers
        ? Object.fromEntries(Object.entries(c.providers).map(([name, profile]) => [name, { ...profile }]))
        : undefined,
    }
  }
  return clone
}

function cloneAssistantConfig(config: AssistantConfig): AssistantConfig {
  return {
    ...config,
    ...(config.providers ? { providers: cloneProviderSettings(config.providers) } : {}),
    ...(config.skills ? { skills: [...config.skills] } : {}),
    ...(config.channels ? { channels: [...config.channels] } : {}),
    ...(config.media ? { media: cloneMediaConfig(config.media) } : {}),
    ...(config.webSearch ? { webSearch: { ...config.webSearch } } : {}),
    ...(config.swarm ? { swarm: { ...config.swarm } } : {}),
  }
}

function cloneStore(store: ConfigStore): ConfigStore {
  return {
    revision: store.revision,
    public: cloneAssistantConfig(store.public),
    assistants: Object.fromEntries(
      Object.entries(store.assistants).map(([id, cfg]) => [id, cloneAssistantConfig(cfg)]),
    ),
    skillLibrary: Object.fromEntries(
      Object.entries(store.skillLibrary).map(([name, skill]) => [name, { ...skill }]),
    ),
  }
}

/** 合并供应商配置：私有覆盖公共（deepseek 浅覆盖；pi-ai 按路由覆盖）。 */
export function mergeProviderSettings(
  base: ProviderSettings | undefined,
  override: ProviderSettings | undefined,
): ProviderSettings | undefined {
  if (!base && !override) return undefined
  const out: ProviderSettings = {}

  if (base?.deepseek || override?.deepseek) {
    out.deepseek = { ...(base?.deepseek ?? {}), ...(override?.deepseek ?? {}) }
  }

  const mergedProviders = {
    ...(base?.piAi?.providers ?? {}),
    ...(override?.piAi?.providers ?? {}),
  }
  if (base?.piAi || override?.piAi || Object.keys(mergedProviders).length > 0) {
    out.piAi = { providers: mergedProviders }
  }

  return Object.keys(out).length > 0 ? out : undefined
}

/** 合并多模态配置：私有覆盖公共（provider 标量覆盖，providers 按厂家 key 覆盖）。 */
export function mergeMediaSettings(
  base: MediaConfig | undefined,
  override: MediaConfig | undefined,
): MediaConfig | undefined {
  if (!base && !override) return undefined
  const out: MediaConfig = {}
  for (const cap of ['imageGen', 'asr', 'tts'] as const) {
    const b = base?.[cap]
    const o = override?.[cap]
    if (!b && !o) continue
    const provider = o?.provider ?? b?.provider
    const mergedProviders = { ...(b?.providers ?? {}), ...(o?.providers ?? {}) }
    const next: MediaCapabilityConfig = {}
    if (provider !== undefined) next.provider = provider
    if (Object.keys(mergedProviders).length > 0) next.providers = mergedProviders
    if (Object.keys(next).length > 0) out[cap] = next
  }
  return Object.keys(out).length > 0 ? out : undefined
}

// ── 路径 ────────────────────────────────────────────────────────────────────

let configFile = ''

/** 设置持久化文件路径（由 bin.ts 调用）。 */
export function setConfigFile(path: string): void {
  configFile = resolve(path)
}

// ── 持久化 ──────────────────────────────────────────────────────────────────

export async function loadConfig(): Promise<ConfigStore> {
  let raw: string
  try {
    raw = await readFile(configFile, 'utf-8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return cloneStore(DEFAULT_STORE)
    throw error
  }

  const parsed = JSON.parse(raw) as Partial<ConfigStore>
  return normalizeStore(parsed)
}

export async function saveConfig(store: ConfigStore): Promise<void> {
  if (!configFile) return
  await mkdir(resolve(configFile, '..'), { recursive: true })
  const tmp = configFile + '.tmp'
  await writeFile(tmp, JSON.stringify(store, null, 2), 'utf-8')
  await rename(tmp, configFile)
}

function migrateLegacyConfig(config: Record<string, unknown>): AssistantConfig {
  const { apiKey, ...rest } = config as Record<string, unknown>
  const next: AssistantConfig = { ...rest } as AssistantConfig
  if (Array.isArray(next.channels)) {
    const legacyNames = new Set(['webui', 'web-ui', 'ai-town', 'vn', 'ws'])
    const usedLegacyName = next.channels.some(channel => typeof channel === 'string' && legacyNames.has(channel))
    next.channels = [...new Set(next.channels.flatMap(channel => {
      if (channel === 'webui' || channel === 'web-ui') return ['http']
      if (channel === 'ai-town' || channel === 'vn' || channel === 'ws') return ['stage']
      return typeof channel === 'string' ? [channel] : []
    }))]
    // 旧版本的网页 HTTP 服务始终启用；只要检测到旧命名便保留该行为。
    if (usedLegacyName && !next.channels.includes('http')) next.channels.push('http')
  }
  if (typeof apiKey === 'string') {
    const providers = (next.providers ?? {}) as ProviderSettings
    next.providers = {
      ...providers,
      deepseek: {
        apiKeyEnv: 'DEEPSEEK_API_KEY',
        ...(providers.deepseek ?? {}),
        apiKey,
      },
      piAi: providers.piAi ?? { providers: {} },
    }
  }
  return next
}

function normalizeStore(parsed: Partial<ConfigStore>): ConfigStore {
  const publicCfg = parsed.public ?? {}
  const assistants = parsed.assistants ?? {}
  const skillLibrary = parsed.skillLibrary ?? {}

  // 旧配置文件没有 channels 字段：公共配置补默认「全开」，私有配置保持缺失（继续继承）。
  const migratedPublic = migrateLegacyConfig(publicCfg as Record<string, unknown>)
  if (migratedPublic.channels === undefined) migratedPublic.channels = [...AVAILABLE_CHANNELS]

  return {
    revision: typeof parsed.revision === 'number' && Number.isInteger(parsed.revision) && parsed.revision >= 0
      ? parsed.revision
      : 0,
    public: migratedPublic,
    assistants: Object.fromEntries(
      Object.entries(assistants).map(([id, cfg]) => [id, migrateLegacyConfig(cfg as Record<string, unknown>)]),
    ),
    skillLibrary: Object.fromEntries(
      Object.entries(skillLibrary).map(([name, skill]) => [name, { ...skill }]),
    ),
  }
}

// ── 配置中心 ────────────────────────────────────────────────────────────────

export class ConfigCenter {
  private store: ConfigStore
  /** 冷字段已变更、待重启的助手 sessionId 集合（内存态，不持久化） */
  private readonly pendingRestart = new Set<string>()

  constructor(store: ConfigStore) {
    this.store = cloneStore(store)
  }

  publicConfig(): AssistantConfig {
    return cloneAssistantConfig(this.store.public)
  }

  assistantConfig(sessionId: string): AssistantConfig {
    return cloneAssistantConfig(this.store.assistants[sessionId] ?? {})
  }

  /** 合并公共 + 私有，返回助手的有效配置。 */
  resolve(sessionId: string): AssistantConfig {
    const pub = this.store.public
    const priv = this.store.assistants[sessionId] ?? {}
    return cloneAssistantConfig({
      ...pub,
      ...priv,
      providers: mergeProviderSettings(pub.providers, priv.providers),
      media: mergeMediaSettings(pub.media, priv.media),
      webSearch: pub.webSearch || priv.webSearch ? { ...pub.webSearch, ...priv.webSearch } : undefined,
      // environment 是公共专用字段，不能被私有覆盖（即使有历史脏数据也强制用公共值）
      environment: pub.environment,
    })
  }

  /** 合并公共 + 私有，返回带版本号的信封（助手启动拉取 / 变更 push 共用）。 */
  resolveEnvelope(sessionId: string): { revision: number; config: AssistantConfig } {
    return { revision: this.store.revision, config: this.resolve(sessionId) }
  }

  /** 当前版本号。 */
  currentRevision(): number {
    return this.store.revision
  }

  listSkills(): SkillDef[] {
    return Object.values(this.store.skillLibrary).map(skill => ({ ...skill }))
  }

  getSkill(name: string): SkillDef | undefined {
    const skill = this.store.skillLibrary[name]
    return skill ? { ...skill } : undefined
  }

  updatePublic(patch: AssistantConfigPatch): { cold: boolean; public: AssistantConfig } {
    this.store.public = applyPatch(this.store.public, patch)
    return { cold: patchHasCold(patch), public: this.publicConfig() }
  }

  updateAssistant(sessionId: string, patch: AssistantConfigPatch): {
    cold: boolean
    private: AssistantConfig
  } {
    // environment 是公共专用字段，私有配置不允许覆盖
    if (Object.prototype.hasOwnProperty.call(patch, 'environment')) {
      throw new Error('environment 是公共字段，不能被私有覆盖')
    }
    const current = this.store.assistants[sessionId] ?? {}
    const next = applyPatch(current, patch)
    if (Object.keys(next).length === 0) {
      delete this.store.assistants[sessionId]
    } else {
      this.store.assistants[sessionId] = next
    }
    return { cold: patchHasCold(patch), private: this.assistantConfig(sessionId) }
  }

  upsertSkill(skill: SkillDef): SkillDef {
    if (!isValidSkillName(skill.name)) {
      throw new Error(`invalid skill name "${skill.name}" (expected kebab-case)`)
    }
    const next = {
      name: skill.name,
      description: skill.description ?? '',
      content: skill.content,
    }
    this.store.skillLibrary[skill.name] = next
    return { ...next }
  }

  markPendingRestart(sessionId: string): void {
    this.pendingRestart.add(sessionId)
  }

  clearPendingRestart(sessionId: string): void {
    this.pendingRestart.delete(sessionId)
  }

  isPendingRestart(sessionId: string): boolean {
    return this.pendingRestart.has(sessionId)
  }

  listPendingRestart(): string[] {
    return [...this.pendingRestart]
  }

  snapshot(): ConfigStore {
    return cloneStore(this.store)
  }

  async save(): Promise<void> {
    // 每次持久化前递增版本号，保证 revision 单调（跨控制台重启也单调）。
    this.store.revision += 1
    await saveConfig(this.snapshot())
  }
}


// ── 校验 ────────────────────────────────────────────────────────────────────

export function validateConfigPatch(input: unknown): AssistantConfigPatch {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new Error('config patch must be an object')
  }

  const patch: AssistantConfigPatch = {}
  for (const [key, value] of Object.entries(input)) {
    if (!KNOWN_FIELD_SET.has(key)) {
      throw new Error(`unknown config field "${key}"`)
    }
    const field = key as ConfigField

    if (value === null) {
      patch[field] = null
      continue
    }

    switch (field) {
      case 'provider':
      case 'model':
        if (typeof value !== 'string' || value.trim().length === 0) {
          throw new Error(`config field "${field}" must be a non-empty string`)
        }
        patch[field] = value
        break
      case 'providers':
        patch.providers = validateProviderSettings(value)
        break
      case 'persona':
      case 'agentMd':
        if (typeof value !== 'string') throw new Error(`config field "${field}" must be a string`)
        patch[field] = value
        break
      case 'maxTokens':
        if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
          throw new Error(`config field "maxTokens" must be a positive integer`)
        }
        patch[field] = value
        break
      case 'skills':
        if (!Array.isArray(value) || value.some(skill => typeof skill !== 'string' || !isValidSkillName(skill))) {
          throw new Error(`config field "skills" must be an array of valid kebab-case skill names`)
        }
        patch[field] = [...value]
        break
      case 'channels':
        if (!Array.isArray(value) || value.some(ch => typeof ch !== 'string' || !(AVAILABLE_CHANNELS as readonly string[]).includes(ch))) {
          throw new Error(`config field "channels" must be an array of available channels (${AVAILABLE_CHANNELS.join(', ')})`)
        }
        patch[field] = [...value]
        break
      case 'environment':
        if (typeof value !== 'string') throw new Error(`config field "environment" must be a string`)
        patch[field] = value
        break
      case 'media':
        patch.media = validateMedia(value)
        break
      case 'webSearch':
        patch.webSearch = validateWebSearch(value)
        break
      case 'swarm':
        patch.swarm = validateSwarmConfig(value)
        break
    }
  }
  return patch
}

function validateWebSearch(input: unknown): WebSearchConfig {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new Error('config field "webSearch" must be an object')
  }
  const out: WebSearchConfig = {}
  for (const [key, value] of Object.entries(input)) {
    switch (key) {
      case 'apiKey':
        if (typeof value !== 'string') throw new Error('webSearch.apiKey must be a string')
        out.apiKey = value
        break
      case 'apiKeyEnv':
        if (typeof value !== 'string' || !isValidCredentialRef(value)) throw new Error('webSearch.apiKeyEnv must be a valid credential reference')
        out.apiKeyEnv = value
        break
      case 'baseURL': {
        if (typeof value !== 'string') throw new Error('webSearch.baseURL must be an HTTP(S) URL')
        let url: URL
        try { url = new URL(value) } catch { throw new Error('webSearch.baseURL must be an HTTP(S) URL') }
        if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
          throw new Error('webSearch.baseURL must be an HTTP(S) base URL without credentials, query or fragment')
        }
        out.baseURL = value
        break
      }
      case 'model':
        if (typeof value !== 'string' || !value.trim()) throw new Error('webSearch.model must be a non-empty string')
        out.model = value.trim()
        break
      case 'maxTokens':
      case 'maxUses':
        if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) throw new Error(`webSearch.${key} must be a positive integer`)
        out[key] = value
        break
      default:
        throw new Error(`unknown webSearch field "${key}"`)
    }
  }
  return out
}

/** 校验蜂群配置（热字段）。 */
function validateSwarmConfig(input: unknown): SwarmConfig {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new Error('config field "swarm" must be an object')
  }
  const out: SwarmConfig = {}
  for (const [key, value] of Object.entries(input)) {
    switch (key) {
      case 'maxDepth':
        if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value > 10) {
          throw new Error('swarm.maxDepth must be an integer between 1 and 10')
        }
        out.maxDepth = value
        break
      case 'maxMembers':
        if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value > 20) {
          throw new Error('swarm.maxMembers must be an integer between 1 and 20')
        }
        out.maxMembers = value
        break
      case 'contextMaxBytes':
        if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 512 || value > 65536) {
          throw new Error('swarm.contextMaxBytes must be an integer between 512 and 65536')
        }
        out.contextMaxBytes = value
        break
      case 'contextMaxEntries':
        if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value > 200) {
          throw new Error('swarm.contextMaxEntries must be an integer between 1 and 200')
        }
        out.contextMaxEntries = value
        break
      default:
        throw new Error(`unknown swarm field "${key}"`)
    }
  }
  return out
}

/** 校验并规范化 suppliers 配置。 */
export function validateProviderSettings(input: unknown): ProviderSettings {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new Error('config field "providers" must be an object')
  }

  const raw = input as Record<string, unknown>
  const out: ProviderSettings = {}

  if (raw.deepseek !== undefined && raw.deepseek !== null) {
    out.deepseek = validateDeepseekSettings(raw.deepseek)
  }
  if (raw.piAi !== undefined && raw.piAi !== null) {
    out.piAi = validatePiAiSection(raw.piAi)
  }

  return out
}

function validateMedia(input: unknown): MediaConfig {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new Error('config field "media" must be an object')
  }
  const raw = input as Record<string, unknown>
  const out: MediaConfig = {}
  for (const cap of ['imageGen', 'asr', 'tts'] as const) {
    if (raw[cap] !== undefined && raw[cap] !== null) {
      out[cap] = validateMediaCapability(cap, raw[cap])
    }
  }
  return out
}

function validateMediaCapability(name: string, input: unknown): MediaCapabilityConfig {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new Error(`config field "media.${name}" must be an object`)
  }
  const raw = input as Record<string, unknown>
  const out: MediaCapabilityConfig = {}
  if (raw.provider !== undefined) {
    if (typeof raw.provider !== 'string' || raw.provider.trim().length === 0) {
      throw new Error(`config field "media.${name}.provider" must be a non-empty string`)
    }
    out.provider = raw.provider
  }
  if (raw.providers !== undefined && raw.providers !== null) {
    if (typeof raw.providers !== 'object' || Array.isArray(raw.providers)) {
      throw new Error(`config field "media.${name}.providers" must be an object`)
    }
    const providers: Record<string, MediaProviderProfile> = {}
    for (const [vendor, profile] of Object.entries(raw.providers)) {
      if (vendor.length === 0) throw new Error(`config field "media.${name}.providers" key must be non-empty`)
      providers[vendor] = validateMediaProviderProfile(vendor, profile)
    }
    out.providers = providers
  }
  return out
}

function validateMediaProviderProfile(vendor: string, input: unknown): MediaProviderProfile {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new Error(`config field "media.providers.${vendor}" must be an object`)
  }
  const raw = input as Record<string, unknown>
  const out: MediaProviderProfile = {}
  for (const [key, value] of Object.entries(raw)) {
    switch (key) {
      case 'apiKey':
      case 'baseURL':
      case 'model':
        if (typeof value !== 'string') throw new Error(`config field "media.providers.${vendor}.${key}" must be a string`)
        out[key] = value
        break
      case 'apiKeyEnv':
        if (typeof value !== 'string') throw new Error(`config field "media.providers.${vendor}.apiKeyEnv" must be a string`)
        if (value.length > 0 && !isValidCredentialRef(value)) {
          throw new Error(`config field "media.providers.${vendor}.apiKeyEnv" must be a valid credential reference`)
        }
        out.apiKeyEnv = value
        break
      default:
        // 各家专属参数（aspect_ratio / num_inference_steps / guidance_scale…）原样透传
        out[key] = value
    }
  }
  return out
}

function validateDeepseekSettings(input: unknown): DeepseekProviderSettings {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new Error('providers.deepseek must be an object')
  }
  const raw = input as Record<string, unknown>
  const out: DeepseekProviderSettings = {}

  for (const [key, value] of Object.entries(raw)) {
    switch (key) {
      case 'apiKey':
      case 'apiKeyEnv':
      case 'baseURL':
        if (typeof value !== 'string') throw new Error(`providers.deepseek.${key} must be a string`)
        if (key === 'apiKeyEnv' && value.length > 0 && !isValidCredentialRef(value)) {
          throw new Error(`providers.deepseek.apiKeyEnv must be a valid credential reference`)
        }
        out[key] = value
        break
      case 'thinking':
        if (typeof value !== 'string' || !THINKING_POLICIES.has(value)) {
          throw new Error('providers.deepseek.thinking must be enabled or disabled')
        }
        out.thinking = value as 'enabled' | 'disabled'
        break
      case 'reasoningEffort':
        if (typeof value !== 'string' || !REASONING_EFFORTS.has(value)) {
          throw new Error('providers.deepseek.reasoningEffort must be off, high or max')
        }
        out.reasoningEffort = value as 'off' | 'high' | 'max'
        break
      case 'maxTokens':
      case 'defaultContextWindow':
      case 'streamIdleTimeoutMs':
        if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
          throw new Error(`providers.deepseek.${key} must be a positive number`)
        }
        out[key] = value
        break
      case 'models':
        out.models = validateProviderModels(value)
        break
      default:
        throw new Error(`unknown providers.deepseek field "${key}"`)
    }
  }
  return out
}

function validatePiAiSection(input: unknown): PiAiProvidersSection {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new Error('providers.piAi must be an object')
  }
  const raw = input as Record<string, unknown>
  if (raw.providers === undefined || raw.providers === null) {
    return { providers: {} }
  }
  if (typeof raw.providers !== 'object' || Array.isArray(raw.providers)) {
    throw new Error('providers.piAi.providers must be an object')
  }

  const providers: Record<string, PiAiProviderSettings> = {}
  for (const [route, profile] of Object.entries(raw.providers)) {
    if (route.length === 0) throw new Error('providers.piAi.providers route key must be non-empty')
    providers[route] = validatePiAiProvider(route, profile)
  }
  return { providers }
}

function validatePiAiProvider(route: string, input: unknown): PiAiProviderSettings {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new Error(`providers.piAi.providers.${route} must be an object`)
  }
  const raw = input as Record<string, unknown>
  const out: PiAiProviderSettings = {}

  for (const [key, value] of Object.entries(raw)) {
    switch (key) {
      case 'apiKey':
      case 'apiKeyEnv':
      case 'displayName':
      case 'api':
      case 'baseURL':
      case 'reasoning':
        if (typeof value !== 'string') throw new Error(`providers.piAi.providers.${route}.${key} must be a string`)
        if (key === 'apiKeyEnv' && value.length > 0 && !isValidCredentialRef(value)) {
          throw new Error(`providers.piAi.providers.${route}.apiKeyEnv must be a valid credential reference`)
        }
        out[key] = value
        break
      case 'defaultContextWindow':
      case 'defaultMaxTokens':
      case 'timeoutMs':
      case 'streamIdleTimeoutMs':
        if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
          throw new Error(`providers.piAi.providers.${route}.${key} must be a positive number`)
        }
        out[key] = value
        break
      case 'models':
        out.models = validateProviderModels(value)
        break
      default:
        out[key] = value
    }
  }
  if (out.apiKey !== undefined && (!out.apiKeyEnv || out.apiKeyEnv.length === 0)) {
    throw new Error(`providers.piAi.providers.${route} with apiKey must also set apiKeyEnv`)
  }
  return out
}

function validateProviderModels(input: unknown): ProviderModel[] {
  if (!Array.isArray(input)) {
    throw new Error('provider models must be an array')
  }
  return input.map((value, index) => {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      throw new Error(`provider model at index ${index} must be an object`)
    }
    const raw = value as Record<string, unknown>
    if (typeof raw.id !== 'string' || raw.id.length === 0) {
      throw new Error(`provider model at index ${index} must have a non-empty id`)
    }
    const model: ProviderModel = { id: raw.id }
    for (const [key, value] of Object.entries(raw)) {
      if (key === 'id') continue
      if (key === 'contextWindow' || key === 'maxTokens') {
        if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
          throw new Error(`provider model "${raw.id}" ${key} must be a positive integer`)
        }
      }
      if (key === 'input') {
        if (!Array.isArray(value) || value.length === 0 || value.some(item => item !== 'text' && item !== 'image')) {
          throw new Error(`provider model "${raw.id}" input must contain text and/or image`)
        }
      }
      model[key] = value
    }
    return model
  })
}

/** 校验技能库输入。 */
export function validateSkillInput(input: unknown, expectedName?: string): SkillDef {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new Error('skill must be an object')
  }
  const body = input as Record<string, unknown>
  const name = typeof body.name === 'string' ? body.name : expectedName
  if (typeof name !== 'string' || !isValidSkillName(name)) {
    throw new Error(`invalid skill name "${String(name)}" (expected kebab-case)`)
  }
  if (expectedName !== undefined && name !== expectedName) {
    throw new Error(`skill name "${name}" does not match path "${expectedName}"`)
  }
  if (typeof body.content !== 'string' || body.content.trim().length === 0) {
    throw new Error('skill content is required')
  }
  return {
    name,
    description: typeof body.description === 'string' ? body.description : '',
    content: body.content,
  }
}

function applyPatch(current: AssistantConfig, patch: AssistantConfigPatch): AssistantConfig {
  const next = cloneAssistantConfig(current)
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) {
      delete next[key as keyof AssistantConfig]
    } else if (key === 'providers') {
      next.providers = cloneProviderSettings(value as ProviderSettings)
    } else if (key === 'media') {
      next.media = cloneMediaConfig(value as MediaConfig)
    } else if (key === 'webSearch') {
      next.webSearch = { ...(value as WebSearchConfig) }
    } else {
      ;(next as Record<string, unknown>)[key] = value
    }
  }
  return next
}
