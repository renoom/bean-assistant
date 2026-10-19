/**
 * 公共知识库 — 助手端 HTTP 客户端
 *
 * 公共知识库由控制台拥有 (唯一写者 + 锁)。助手只经 HTTP 访问:
 *   - 读: search / get / list (只读, 无锁)
 *   - 写: propose (申请写入, 控制台加锁 + 版本校验)
 *
 * 助手未连接控制台 (无 consoleUrl) 时, 公共知识库不可用, 工具返回友好提示。
 *
 * @module assistant/knowledge/client
 */

// ── 类型 (与控制台 knowledge/store.ts 保持一致) ────────────────────────────

export interface KnowledgeMeta {
  id: string
  title: string
  tags: string[]
  version: number
  author: string
  created: string
  updated: string
}

export interface KnowledgeEntry extends KnowledgeMeta {
  content: string
}

export interface ProposeInput {
  /** 已有条目 id (更新时必填); 省略则创建新条目 */
  id?: string
  title: string
  content: string
  tags?: string[]
  /** 更新时的基准版本号, 防止覆盖他人修改 */
  baseVersion?: number
}

export interface ProposeOutcome {
  ok: boolean
  entry?: KnowledgeEntry
  error?: 'offline' | 'locked' | 'version_conflict' | 'not_found' | 'http'
  holder?: string
  currentVersion?: number
}

// ── 辅助 ────────────────────────────────────────────────────────────────────

/** 助手是否连接了控制台 (决定公共知识库是否可用)。作为类型守卫, 通过后 consoleUrl 收窄为 string。 */
export function knowledgeAvailable(consoleUrl?: string): consoleUrl is string {
  return typeof consoleUrl === 'string' && consoleUrl.trim().length > 0
}

function base(consoleUrl: string): string {
  return consoleUrl.trim().replace(/\/+$/, '')
}

async function readJson(res: Response): Promise<any> {
  try { return await res.json() } catch { return {} }
}

// ── 读 ──────────────────────────────────────────────────────────────────────

export async function searchKnowledge(
  consoleUrl: string,
  query: string,
): Promise<{ count: number; results: Array<KnowledgeEntry & { snippet?: string }> }> {
  const res = await fetch(`${base(consoleUrl)}/api/knowledge/search?q=${encodeURIComponent(query)}`)
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return readJson(res)
}

export async function listKnowledge(
  consoleUrl: string,
  tags?: string[],
): Promise<{ count: number; items: KnowledgeMeta[] }> {
  const qs = tags?.length ? `?tags=${encodeURIComponent(tags.join(','))}` : ''
  const res = await fetch(`${base(consoleUrl)}/api/knowledge${qs}`)
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return readJson(res)
}

export async function getKnowledge(consoleUrl: string, id: string): Promise<KnowledgeEntry> {
  const res = await fetch(`${base(consoleUrl)}/api/knowledge/${encodeURIComponent(id)}`)
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return readJson(res)
}

// ── 写 (一次性 propose) ─────────────────────────────────────────────────────

export async function proposeKnowledge(
  consoleUrl: string,
  sessionId: string,
  input: ProposeInput,
): Promise<ProposeOutcome> {
  const res = await fetch(`${base(consoleUrl)}/api/knowledge/write`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...input, assistantId: sessionId }),
  })
  const data = await readJson(res)
  if (res.ok) return { ok: true, entry: data.entry }

  const error = (data.error as ProposeOutcome['error']) ?? 'http'
  return {
    ok: false,
    error,
    ...(data.holder !== undefined ? { holder: String(data.holder) } : {}),
    ...(data.currentVersion !== undefined ? { currentVersion: Number(data.currentVersion) } : {}),
  }
}
