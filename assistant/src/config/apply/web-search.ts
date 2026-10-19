import type { ProviderSettings, WebSearchConfig } from '../types.js'

export const WEB_SEARCH_NAMESPACE = 'web-search-deepseek'

/** Search has its own endpoint/model; only the DeepSeek credential reference is shared. */
export function webSearchSection(search: WebSearchConfig | undefined, providers: ProviderSettings | undefined): Record<string, unknown> {
  const section: Record<string, unknown> = {
    apiKeyEnv: search?.apiKeyEnv || (search?.apiKey !== undefined
      ? 'DEEPSEEK_SEARCH_API_KEY'
      : providers?.deepseek?.apiKeyEnv || 'DEEPSEEK_API_KEY'),
  }
  for (const key of ['baseURL', 'model', 'maxTokens', 'maxUses'] as const) {
    if (search?.[key] !== undefined) section[key] = search[key]
  }
  return section
}

/** Resolve shared credentials in one place so rotating search cannot erase a chat key. */
export function addWebSearchCredential(entries: Map<string, string>, search: WebSearchConfig | undefined, providers: ProviderSettings | undefined): void {
  if (search?.apiKey === undefined) return
  const ref = webSearchSection(search, providers).apiKeyEnv as string
  if (entries.has(ref) && entries.get(ref) !== search.apiKey) {
    throw new Error(`网络搜索与聊天供应商的凭证引用 ${ref} 冲突，请为搜索配置独立 apiKeyEnv`)
  }
  entries.set(ref, search.apiKey)
}
