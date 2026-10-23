/**
 * 团队 — 助手端 Console 客户端
 *
 * 团队由 Console 拥有：成员、角色、leader、消息历史、投递。助手只经 HTTP 访问。
 * 本机 loopback 直连控制台时内部 API 免 Key；远程控制台可通过
 * ASSISTANT_CONSOLE_API_KEY 带上平台 Key。
 *
 * @module assistant/team/client
 */

// ── 类型（与 console/src/teams.ts 对齐） ──────────────────────────────────

export interface TeamMemberInfo {
  assistantId: string
  role: string
  joinedAt: string
  name: string
  status: string
  model?: string
  provider?: string
  isLeader: boolean
}

export interface TeamInfo {
  id: string
  name: string
  goal?: string
  leaderId: string | null
  members: TeamMemberInfo[]
  memberCount: number
  leaderName: string | null
  createdAt: string
  updatedAt: string
}

export interface TeamSelf {
  sessionId: string
  name: string
  role: string
  isLeader: boolean
}

export interface TeamRoster {
  team: TeamInfo
  self: TeamSelf
}

export type TeamMessageKind = 'direct' | 'broadcast'
export type TeamMessageFromKind = 'assistant' | 'human'

export interface TeamMessagePayload {
  id: string
  teamId: string
  kind: TeamMessageKind
  fromKind: TeamMessageFromKind
  fromId: string
  fromName: string
  toId: string | null
  toName: string | null
  text: string
  threadId: string
  replyTo: string | null
  hop: number
  createdAt: string
}

interface ConsoleResponse {
  ok: boolean
  status: number
  data: Record<string, unknown>
}

// ── HTTP ────────────────────────────────────────────────────────────────────

function consoleBase(consoleUrl: string): string {
  return consoleUrl.trim().replace(/\/+$/, '')
}

function authHeaders(): Record<string, string> {
  const key = process.env.ASSISTANT_CONSOLE_API_KEY
  return key ? { Authorization: `Bearer ${key}` } : {}
}

async function request(consoleUrl: string, path: string, init: RequestInit = {}): Promise<ConsoleResponse> {
  const response = await fetch(`${consoleBase(consoleUrl)}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...authHeaders(),
      ...(init.headers ?? {}),
    },
    signal: AbortSignal.timeout(4000),
  })
  let data: Record<string, unknown> = {}
  try { data = await response.json() as Record<string, unknown> } catch { /* 非 JSON 响应 */ }
  return { ok: response.ok, status: response.status, data }
}

function errorOf(result: ConsoleResponse): Error {
  const message = typeof result.data.error === 'string' ? result.data.error : `HTTP ${result.status}`
  return new Error(message)
}

// ── API ─────────────────────────────────────────────────────────────────────

export async function fetchRoster(consoleUrl: string, sessionId: string): Promise<TeamRoster> {
  const result = await request(consoleUrl, `/api/team/roster?sessionId=${encodeURIComponent(sessionId)}`)
  if (!result.ok) throw errorOf(result)
  return result.data as unknown as TeamRoster
}

export interface SendTeamMessageInput {
  sessionId: string
  kind: TeamMessageKind
  to?: string
  text: string
  replyTo?: string
}

export async function sendTeamMessage(consoleUrl: string, input: SendTeamMessageInput): Promise<{ messageId: string; recipients: string[] }> {
  const result = await request(consoleUrl, '/api/team/messages', {
    method: 'POST',
    body: JSON.stringify({
      sessionId: input.sessionId,
      kind: input.kind,
      ...(input.to !== undefined ? { to: input.to } : {}),
      text: input.text,
      ...(input.replyTo !== undefined ? { replyTo: input.replyTo } : {}),
    }),
  })
  if (!result.ok) throw errorOf(result)
  return {
    messageId: String(result.data.messageId ?? ''),
    recipients: Array.isArray(result.data.recipients) ? result.data.recipients.map(String) : [],
  }
}

export async function assignTeamRole(consoleUrl: string, sessionId: string, assistantId: string, role: string): Promise<TeamInfo> {
  const result = await request(consoleUrl, '/api/team/role', {
    method: 'POST',
    body: JSON.stringify({ sessionId, assistantId, role }),
  })
  if (!result.ok) throw errorOf(result)
  return result.data as unknown as TeamInfo
}

export async function recruitTeamMember(
  consoleUrl: string,
  sessionId: string,
  input: { name: string; role?: string; persona?: string },
): Promise<{ sessionId: string; name: string; port: number; role: string; status: string; teamId: string }> {
  const result = await request(consoleUrl, '/api/team/recruit', {
    method: 'POST',
    body: JSON.stringify({ sessionId, ...input }),
  })
  if (!result.ok) throw errorOf(result)
  return result.data as unknown as { sessionId: string; name: string; port: number; role: string; status: string; teamId: string }
}

export async function fetchPendingMessages(consoleUrl: string, sessionId: string): Promise<TeamMessagePayload[]> {
  const result = await request(consoleUrl, `/api/team/pending?sessionId=${encodeURIComponent(sessionId)}`)
  if (!result.ok) throw errorOf(result)
  return Array.isArray(result.data.messages) ? result.data.messages as unknown as TeamMessagePayload[] : []
}
