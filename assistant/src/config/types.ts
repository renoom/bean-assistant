/**
 * 配置中心 — 助手端 schema 与 hot/cold 元数据
 *
 * 模型配置对齐 dsh 原生能力：
 *   - provider/model 是 agent 的模型选择
 *   - providers.deepseek 对应 dsh `llm-deepseek` settings section
 *   - providers.piAi.providers 对应 dsh `llm-pi-ai` settings section
 *   - apiKey 由 assistant-config 经 dsh credentials seam 写入隔离凭证文件
 *
 * @module assistant/config/types
 */

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
  /** 实际密钥；运行时写入 dsh credentials，不进入 dsh settings 文档 */
  apiKey?: string
  /** 凭证引用（环境变量名），默认 DEEPSEEK_API_KEY */
  apiKeyEnv?: string
  /** Endpoint base */
  baseURL?: string
  thinking?: 'enabled' | 'disabled'
  reasoningEffort?: 'off' | 'high' | 'max'
  maxTokens?: number
  defaultContextWindow?: number
  models?: ProviderModel[]
  streamIdleTimeoutMs?: number
}

/** pi-ai 供应商 profile（对应 dsh `llm-pi-ai` 的 providers.{route}）。 */
export interface PiAiProviderSettings {
  apiKey?: string
  apiKeyEnv?: string
  displayName?: string
  api?: string
  baseURL?: string
  models?: ProviderModel[]
  defaultContextWindow?: number
  defaultMaxTokens?: number
  reasoning?: string
  timeoutMs?: number
  streamIdleTimeoutMs?: number
  [key: string]: unknown
}

/** pi-ai 供应商集合。 */
export interface PiAiProvidersSection {
  providers?: Record<string, PiAiProviderSettings>
}

/** 供应商配置集合。 */
export interface ProviderSettings {
  deepseek?: DeepseekProviderSettings
  piAi?: PiAiProvidersSection
}

/** 多模态能力供应商 profile（公共可被私有覆盖）。字段各家专属，宽松索引签名。 */
export interface MediaProviderProfile {
  /** 实际密钥；工具调用时直接用（不走 dsh credentials seam） */
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

/** 独立媒体能力配置（图片生成、语音识别/合成）。视觉输入由当前 LLM 模型能力决定。 */
export interface MediaConfig {
  imageGen?: MediaCapabilityConfig
  asr?: MediaCapabilityConfig
  tts?: MediaCapabilityConfig
}

/** dsh 原生 DeepSeek 联网搜索配置；独立于助手的对话模型。 */
export interface WebSearchConfig {
  apiKey?: string
  apiKeyEnv?: string
  /** Anthropic 兼容基址；提供方追加 /messages。 */
  baseURL?: string
  model?: string
  maxTokens?: number
  maxUses?: number
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
  /** 启用的交互 Channel（冷）。主配置名为 http、stage；旧 ws/vn/ai-town/webui 别名仍兼容。 */
  channels?: string[]
  /** 环境信息描述（冷；公共专用，私有配置不可覆盖） */
  environment?: string
  /** 独立媒体能力配置（热；图片生成、语音识别/合成，公共可被私有覆盖） */
  media?: MediaConfig
  webSearch?: WebSearchConfig
}

/** 控制台技能库条目。 */
export interface SkillDef {
  name: string
  description?: string
  content: string
}

export const HOT_FIELDS = ['provider', 'model', 'providers', 'skills', 'media', 'webSearch'] as const
export const COLD_FIELDS = ['persona', 'agentMd', 'maxTokens'] as const
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
  persona: 'cold',
  agentMd: 'cold',
  maxTokens: 'cold',
}
