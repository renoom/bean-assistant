/**
 * 控制台团队中心 — 团队、成员、角色、团队消息历史
 *
 * 持久化:
 *   - teams.json       团队与成员（原子写）
 *   - messages.jsonl   团队消息（追加写，历史只增不删）
 *
 * 规则:
 *   - 一个助手只能属于一个团队
 *   - 一个团队只有一个 leader，leader 必须是成员
 *   - 消息支持 direct（1:1）与 broadcast（团队广播）
 *   - 人类消息只能 direct 发给 leader
 *
 * @module console/teams
 */

import { appendFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'

// ── 类型 ────────────────────────────────────────────────────────────────────

export interface TeamMember {
  assistantId: string
  /** 自由文本角色（leader / 产品 / 开发 / 测试…） */
  role: string
  joinedAt: string
}

export interface Team {
  id: string
  name: string
  goal?: string
  /** 当前 leader；允许为空（尚未指定） */
  leaderId: string | null
  members: TeamMember[]
  createdAt: string
  updatedAt: string
}

export type TeamMessageKind = 'direct' | 'broadcast'
export type TeamMessageFromKind = 'assistant' | 'human'

export interface TeamMessage {
  id: string
  teamId: string
  kind: TeamMessageKind
  fromKind: TeamMessageFromKind
  fromId: string
  fromName: string
  /** direct 的收件人；broadcast 时为 null */
  toId: string | null
  toName: string | null
  text: string
  threadId: string
  replyTo: string | null
  hop: number
  createdAt: string
}

export interface TeamStore {
  revision: number
  teams: Team[]
}

export interface CreateTeamInput {
  name: string
  goal?: string
  leaderId?: string
}

export interface UpdateTeamInput {
  name?: string
  goal?: string | null
  leaderId?: string | null
}

export interface AppendMessageInput {
  kind: TeamMessageKind
  fromKind: TeamMessageFromKind
  fromId: string
  fromName: string
  toId?: string | null
  toName?: string | null
  text: string
  replyTo?: string | null
}

// ── 限制 ────────────────────────────────────────────────────────────────────

const NAME_MAX = 60
const GOAL_MAX = 500
const ROLE_MAX = 50
const MESSAGE_MAX = 20_000
const MAX_MEMBERS = 20
const DEFAULT_MESSAGE_LIMIT = 200

function nowIso(): string {
  return new Date().toISOString()
}

function nonEmptyText(value: unknown, field: string, max: number): string {
  if (typeof value !== 'string') throw new Error(`${field} is required`)
  const text = value.trim()
  if (text.length === 0) throw new Error(`${field} is required`)
  if (text.length > max) throw new Error(`${field} is too long (max ${max})`)
  return text
}

function optionalText(value: unknown, field: string, max: number): string | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string') throw new Error(`${field} must be a string`)
  const text = value.trim()
  if (text.length === 0) return undefined
  if (text.length > max) throw new Error(`${field} is too long (max ${max})`)
  return text
}

function memberOf(team: Team, assistantId: string): TeamMember | undefined {
  return team.members.find(member => member.assistantId === assistantId)
}

// ── TeamCenter ──────────────────────────────────────────────────────────────

export class TeamCenter {
  private store: TeamStore = { revision: 0, teams: [] }
  private messages: TeamMessage[] = []
  private readonly teamsPath: string | undefined
  private readonly messagesPath: string | undefined
  private loaded = false
  /** 串行化 teams.json 写入，避免并发 save 争用同一个 .tmp 文件。 */
  private saveChain: Promise<void> = Promise.resolve()

  constructor(options: { teamsPath?: string; messagesPath?: string } = {}) {
    this.teamsPath = options.teamsPath ? resolve(options.teamsPath) : undefined
    this.messagesPath = options.messagesPath ? resolve(options.messagesPath) : undefined
  }

  /** 读取磁盘状态；文件缺失或损坏时退回空状态。 */
  async load(): Promise<void> {
    if (this.loaded) return
    this.loaded = true
    if (this.teamsPath) {
      try {
        const raw = await readFile(this.teamsPath, 'utf-8')
        const parsed = JSON.parse(raw) as Partial<TeamStore>
        if (parsed && Array.isArray(parsed.teams)) {
          this.store = {
            revision: typeof parsed.revision === 'number' ? parsed.revision : 0,
            teams: parsed.teams.filter((team): team is Team => Boolean(team) && typeof team.id === 'string'),
          }
        }
      } catch {
        // 首次启动 / 文件损坏：从空状态开始
      }
    }
    if (this.messagesPath) {
      try {
        const raw = await readFile(this.messagesPath, 'utf-8')
        this.messages = raw
          .split('\n')
          .map(line => line.trim())
          .filter(Boolean)
          .flatMap(line => {
            try {
              const value = JSON.parse(line) as TeamMessage
              return value && typeof value.id === 'string' ? [value] : []
            } catch {
              return []
            }
          })
      } catch {
        // 没有消息文件是正常状态
      }
    }
  }

  /** 原子写 teams.json（仅在团队结构变化时调用）。写入串行化，失败只告警。 */
  async save(): Promise<void> {
    this.saveChain = this.saveChain
      .then(() => this.saveNow())
      .catch((err) => {
        console.warn('[teams] save failed:', err instanceof Error ? err.message : String(err))
      })
    return this.saveChain
  }

  private async saveNow(): Promise<void> {
    if (!this.teamsPath) return
    await mkdir(dirname(this.teamsPath), { recursive: true })
    const tmp = `${this.teamsPath}.tmp`
    await writeFile(tmp, JSON.stringify(this.store, null, 2), 'utf-8')
    await rename(tmp, this.teamsPath)
  }

  get revision(): number {
    return this.store.revision
  }

  list(): Team[] {
    return thatSorted(this.store.teams)
  }

  get(id: string): Team | null {
    return this.store.teams.find(team => team.id === id) ?? null
  }

  /** 一个助手只能属于一个团队。 */
  teamOf(assistantId: string): Team | null {
    return this.store.teams.find(team => team.members.some(member => member.assistantId === assistantId)) ?? null
  }

  membersOf(teamId: string): TeamMember[] {
    return this.get(teamId)?.members.slice() ?? []
  }

  // ── 团队生命周期 ──────────────────────────────────────────────────────────

  create(input: CreateTeamInput): Team {
    const name = nonEmptyText(input.name, 'name', NAME_MAX)
    const createdAt = nowIso()
    const team: Team = {
      id: `team-${randomUUID().slice(0, 8)}`,
      name,
      ...(optionalText(input.goal, 'goal', GOAL_MAX) !== undefined ? { goal: optionalText(input.goal, 'goal', GOAL_MAX) } : {}),
      leaderId: null,
      members: [],
      createdAt,
      updatedAt: createdAt,
    }
    if (input.leaderId) {
      const member = this.addMemberTo(team, input.leaderId, 'leader')
      team.leaderId = member.assistantId
    }
    this.store.teams.push(team)
    this.touch()
    return team
  }

  update(id: string, patch: UpdateTeamInput): Team {
    const team = this.requireTeam(id)
    if (patch.name !== undefined) team.name = nonEmptyText(patch.name, 'name', NAME_MAX)
    if (patch.goal !== undefined) {
      const goal = optionalText(patch.goal, 'goal', GOAL_MAX)
      if (goal === undefined) delete team.goal
      else team.goal = goal
    }
    if (patch.leaderId !== undefined) {
      this.setLeaderOn(team, patch.leaderId)
    }
    this.touch(team)
    return team
  }

  delete(id: string): void {
    const team = this.requireTeam(id)
    if (team.members.length > 0) throw new Error('team still has members; remove them first')
    this.store.teams = this.store.teams.filter(item => item.id !== id)
    this.touch()
  }

  // ── 成员 / 角色 ──────────────────────────────────────────────────────────

  addMember(teamId: string, assistantId: string, role?: string): TeamMember {
    const team = this.requireTeam(teamId)
    const member = this.addMemberTo(team, assistantId, role)
    this.touch(team)
    return member
  }

  removeMember(teamId: string, assistantId: string): void {
    const team = this.requireTeam(teamId)
    if (team.leaderId === assistantId) throw new Error('cannot remove the leader; assign a new leader first')
    const before = team.members.length
    team.members = team.members.filter(member => member.assistantId !== assistantId)
    if (team.members.length === before) throw new Error('assistant is not a member of this team')
    this.touch(team)
  }

  setLeader(teamId: string, assistantId: string | null): void {
    const team = this.requireTeam(teamId)
    this.setLeaderOn(team, assistantId)
    this.touch(team)
  }

  setRole(teamId: string, assistantId: string, role: string): TeamMember {
    const team = this.requireTeam(teamId)
    const member = memberOf(team, assistantId)
    if (!member) throw new Error('assistant is not a member of this team')
    if (team.leaderId === assistantId) throw new Error('leader role is fixed; transfer leadership instead')
    member.role = nonEmptyText(role, 'role', ROLE_MAX)
    this.touch(team)
    return member
  }

  // ── 消息 ─────────────────────────────────────────────────────────────────

  /** 人类只能直接给 leader 发言。 */
  appendHumanMessage(teamId: string, text: string): TeamMessage {
    const team = this.requireTeam(teamId)
    if (!team.leaderId) throw new Error('team has no leader')
    const leader = memberOf(team, team.leaderId)
    if (!leader) throw new Error('team leader is not a member')
    return this.appendMessage(teamId, {
      kind: 'direct',
      fromKind: 'human',
      fromId: 'console:user',
      fromName: '控制台',
      toId: leader.assistantId,
      toName: 'leader',
      text,
    })
  }

  appendMessage(teamId: string, input: AppendMessageInput): TeamMessage {
    const team = this.requireTeam(teamId)
    const text = nonEmptyText(input.text, 'text', MESSAGE_MAX)
    if (input.fromKind === 'human') {
      if (input.kind !== 'direct' || input.toId !== team.leaderId) {
        throw new Error('human messages must be direct to the team leader')
      }
    }
    if (input.kind === 'direct') {
      if (!input.toId) throw new Error('direct message requires toId')
      if (input.toId === 'human') {
        if (input.fromKind !== 'assistant' || input.fromId !== team.leaderId) {
          throw new Error('only the team leader may message the human')
        }
      } else if (!memberOf(team, String(input.toId))) {
        throw new Error('recipient is not a member of this team')
      }
    }
    if (input.kind === 'broadcast' && team.members.length < 2) {
      throw new Error('broadcast needs at least one other member')
    }

    const createdAt = nowIso()
    const id = `msg-${randomUUID().slice(0, 12)}`
    const replyTo = input.replyTo ?? null
    let threadId = id
    let hop = 0
    if (replyTo) {
      const parent = this.messages.find(message => message.id === replyTo)
      if (parent) {
        threadId = parent.threadId
        hop = parent.hop + 1
      }
    }
    const message: TeamMessage = {
      id,
      teamId,
      kind: input.kind,
      fromKind: input.fromKind,
      fromId: input.fromId,
      fromName: input.fromName,
      toId: input.kind === 'broadcast' ? null : (input.toId ?? null),
      toName: input.kind === 'broadcast'
        ? '全组'
        : input.toId === 'human' ? '控制台' : (input.toName ?? input.toId ?? null),
      text,
      threadId,
      replyTo,
      hop,
      createdAt,
    }
    this.messages.push(message)
    void this.appendMessageFile(message)
    return message
  }

  listMessages(teamId: string, options: { since?: string; limit?: number } = {}): TeamMessage[] {
    const limit = Number.isInteger(options.limit) && options.limit !== undefined
      ? Math.min(Math.max(options.limit, 1), 500)
      : DEFAULT_MESSAGE_LIMIT
    const teamMessages = this.messages.filter(message => message.teamId === teamId)
    if (options.since) {
      const index = teamMessages.findIndex(message => message.id === options.since)
      if (index >= 0) return teamMessages.slice(index + 1, index + 1 + limit)
      return teamMessages.slice(-limit)
    }
    return teamMessages.slice(-limit)
  }

  /** 供 UI 的首屏摘要：成员数、leader 等。 */
  summary(teamId: string): { memberCount: number } {
    return { memberCount: this.get(teamId)?.members.length ?? 0 }
  }

  // ── 内部 ─────────────────────────────────────────────────────────────────

  private requireTeam(id: string): Team {
    const team = this.get(id)
    if (!team) throw new Error('team not found')
    return team
  }

  private addMemberTo(team: Team, assistantId: string, role?: string): TeamMember {
    const id = nonEmptyText(assistantId, 'assistantId', 200)
    if (team.members.some(member => member.assistantId === id)) {
      throw new Error('assistant is already a member of this team')
    }
    const existing = this.teamOf(id)
    if (existing && existing.id !== team.id) {
      throw new Error(`assistant already belongs to team "${existing.name}"`)
    }
    if (team.members.length >= MAX_MEMBERS) throw new Error(`team is full (max ${MAX_MEMBERS} members)`)
    const member: TeamMember = {
      assistantId: id,
      role: role !== undefined ? nonEmptyText(role, 'role', ROLE_MAX) : '成员',
      joinedAt: nowIso(),
    }
    team.members.push(member)
    return member
  }

  private setLeaderOn(team: Team, assistantId: string | null): void {
    if (assistantId === null) {
      team.leaderId = null
      return
    }
    const member = memberOf(team, nonEmptyText(assistantId, 'leaderId', 200))
    if (!member) throw new Error('leader must be a member of this team')
    for (const item of team.members) {
      if (item.role === 'leader' && item.assistantId !== member.assistantId) item.role = '成员'
    }
    member.role = 'leader'
    team.leaderId = member.assistantId
  }

  private touch(team?: Team): void {
    this.store.revision += 1
    if (team) team.updatedAt = nowIso()
    void this.save()
  }

  private async appendMessageFile(message: TeamMessage): Promise<void> {
    if (!this.messagesPath) return
    try {
      await mkdir(dirname(this.messagesPath), { recursive: true })
      await appendFile(this.messagesPath, `${JSON.stringify(message)}\n`, 'utf-8')
    } catch {
      // 历史落盘失败不阻断在线消息
    }
  }
}

/** 稳定排序：按创建时间升序，时间相同按 id。 */
function thatSorted(teams: Team[]): Team[] {
  return teams.slice().sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
}
