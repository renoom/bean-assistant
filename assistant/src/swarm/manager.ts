/**
 * 蜂群管理器 — 唯一的后台创建入口与成员生命周期
 *
 * 规则（与 docs/swarm/architecture.md 对齐）：
 *   - 所有成员都经 `swarm_dispatch` 创建，永远后台；
 *   - task 成员 = one-shot 后台任务（完成通知很小，结果主动拉取）；
 *   - resident 成员 = continuable 常驻蜂（消息只报 [DONE] 标记，结果主动拉取）；
 *   - 成员只能和父 agent 通信（树形），工具过滤禁止团队工具与主 agent 专用蜂群工具；
 *   - 共享上下文写入只允许主 agent；成员只能读 + 提案；
 *   - 归档只做逻辑归档，不删除持久会话。
 *
 * @module assistant/swarm/manager
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { settleRun, type SubagentRun } from '@deepseek-ai/dsh-subagent'
import type { SwarmConfig } from '../config/types.js'
import { SharedContextStore, type SharedContextEntry, type SharedContextLimits, type SharedContextProposal } from './shared-context.js'

export type SwarmMode = 'task' | 'resident'
export type SwarmMemberStatus = 'running' | 'done' | 'failed' | 'interrupted' | 'archived'

export interface SwarmMember {
  id: string
  label: string
  mode: SwarmMode
  status: SwarmMemberStatus
  parentId: string
  depth: number
  sharedContext: boolean
  task: string
  createdAt: string
  finishedAt?: string
  stopReason?: string
  summary?: string
  jobId?: string
  collectedAt?: string
  archivedAt?: string
}

export interface SwarmLimits {
  maxDepth: number
  maxMembers: number
  contextMaxBytes: number
  contextMaxEntries: number
}

interface SwarmStateFile {
  version: 1
  members: SwarmMember[]
  lastCollectedAt: string | null
}

export interface SwarmDispatchInput {
  label: string
  prompt: string
  mode: SwarmMode
  sharedContext: boolean
  signal: AbortSignal
}

export interface SwarmDispatchResult {
  memberId: string
  jobId?: string
  childId: string
  label: string
}

export interface SwarmManagerOptions {
  ctx: Context
  agent: Agent
  dataDir: string
  name: string
  getConfig: () => SwarmConfig | undefined
}

const DEFAULT_LIMITS: SwarmLimits = { maxDepth: 3, maxMembers: 5, contextMaxBytes: 8192, contextMaxEntries: 50 }

function nowIso(): string {
  return new Date().toISOString()
}

function textOf(output: readonly ContentBlock[] | undefined): string {
  if (!output) return ''
  return output
    .filter((block): block is Extract<ContentBlock, { type: 'text' }> => block.type === 'text')
    .map(block => block.text)
    .join('')
    .trim()
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text
}

export class SwarmManager {
  readonly sharedContext: SharedContextStore
  private readonly ctx: Context
  private readonly agent: Agent
  private readonly getConfig: () => SwarmConfig | undefined
  private readonly name: string
  private readonly dataDir: string
  private readonly statePath: string
  private readonly sharedPath: string
  private state: SwarmStateFile = { version: 1, members: [], lastCollectedAt: null }
  private readonly disposers: Array<() => void> = []
  private saveChain: Promise<void> = Promise.resolve()
  private admissionChain: Promise<unknown> = Promise.resolve()
  private disposed = false

  constructor(options: SwarmManagerOptions) {
    this.ctx = options.ctx
    this.agent = options.agent
    this.getConfig = options.getConfig
    this.name = options.name
    this.dataDir = options.dataDir
    this.statePath = resolve(options.dataDir, 'swarm', 'state.json')
    this.sharedPath = resolve(options.dataDir, 'swarm', 'shared-context.json')
    this.sharedContext = new SharedContextStore({
      path: this.sharedPath,
      limits: () => this.contextLimits(),
    })
    this.disposers.push(this.agent.ctx.on('subagent/end', (info: any) => {
      const member = this.state.members.find(item => item.id === String(info?.id ?? info?.runId ?? ''))
      if (!member || member.status !== 'running') return
      this.finish(member, String(info?.stopReason ?? 'error'), textOf(info?.lastAssistantMessage))
    }))
  }

  async load(): Promise<void> {
    await this.sharedContext.load()
    try {
      const raw = await readFile(this.statePath, 'utf8')
      const parsed = JSON.parse(raw) as Partial<SwarmStateFile>
      if (parsed && Array.isArray(parsed.members)) {
        this.state = {
          version: 1,
          members: parsed.members.filter((member): member is SwarmMember => Boolean(member) && typeof member.id === 'string')
            .map(member => member.status === 'running' ? { ...member, status: 'interrupted' } : member),
          lastCollectedAt: typeof parsed.lastCollectedAt === 'string' ? parsed.lastCollectedAt : null,
        }
      }
    } catch {
      // 首次运行
    }
  }

  async save(): Promise<void> {
    if (this.disposed) return
    this.saveChain = this.saveChain.then(async () => {
      await mkdir(dirname(this.statePath), { recursive: true })
      const tmp = `${this.statePath}.tmp`
      await writeFile(tmp, JSON.stringify(this.state, null, 2), 'utf8')
      await rename(tmp, this.statePath)
    }).catch((error) => {
      console.warn('[swarm] state save failed:', error instanceof Error ? error.message : String(error))
    })
    return this.saveChain
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    for (const dispose of this.disposers.reverse()) {
      try { dispose() } catch { /* ignore */ }
    }
    this.disposers.length = 0
    void this.save()
  }

  limits(): SwarmLimits {
    const cfg = this.getConfig() ?? {}
    const clamp = (value: unknown, fallback: number, min: number, max: number): number => {
      const number = typeof value === 'number' && Number.isFinite(value) ? Math.floor(value) : fallback
      return Math.min(Math.max(number, min), max)
    }
    return {
      maxDepth: clamp(cfg.maxDepth, DEFAULT_LIMITS.maxDepth, 1, 10),
      maxMembers: clamp(cfg.maxMembers, DEFAULT_LIMITS.maxMembers, 1, 20),
      contextMaxBytes: clamp(cfg.contextMaxBytes, DEFAULT_LIMITS.contextMaxBytes, 512, 65536),
      contextMaxEntries: clamp(cfg.contextMaxEntries, DEFAULT_LIMITS.contextMaxEntries, 1, 200),
    }
  }

  private contextLimits(): SharedContextLimits {
    const limits = this.limits()
    return { maxBytes: limits.contextMaxBytes, maxEntries: limits.contextMaxEntries }
  }

  // ── 成员 ──────────────────────────────────────────────────────────────────

  members(options: { includeArchived?: boolean } = {}): SwarmMember[] {
    return this.state.members
      .filter(member => options.includeArchived || member.status !== 'archived')
      .slice()
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
  }

  allMembers(): SwarmMember[] {
    return this.members({ includeArchived: true })
  }

  member(id: string): SwarmMember | undefined {
    return this.state.members.find(member => member.id === id)
  }

  parentLabel(parentId: string): string {
    if (parentId === this.agent.session.id) return this.name
    return this.member(parentId)?.label ?? this.name
  }

  relations(id: string): { member: SwarmMember; parent: SwarmMember | null; children: SwarmMember[] } | null {
    const member = this.member(id)
    if (!member) return null
    return {
      member,
      parent: this.member(member.parentId) ?? null,
      children: this.state.members.filter(item => item.parentId === id && item.status !== 'archived'),
    }
  }

  private depthOf(parent: Agent): number {
    const parentMember = this.member(parent.session.id)
    return parentMember ? parentMember.depth : 0
  }

  private runningCount(parentId: string): number {
    return this.state.members.filter(member => member.parentId === parentId && member.status === 'running').length
  }

  private async withAdmission<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.admissionChain.then(operation, operation)
    this.admissionChain = run.then(() => undefined, () => undefined)
    return run
  }

  // ── 派发 ──────────────────────────────────────────────────────────────────

  async dispatch(parent: Agent, input: SwarmDispatchInput): Promise<SwarmDispatchResult> {
    if (this.disposed) throw new Error('swarm manager disposed')
    return this.withAdmission(async () => {
      const limits = this.limits()
      const depth = this.depthOf(parent) + 1
      if (depth > limits.maxDepth) {
        throw new Error(`蜂群递归层级已达上限 ${limits.maxDepth}，不能再创建下级`)
      }
      if (this.runningCount(parent.session.id) >= limits.maxMembers) {
        throw new Error(`蜂群并发已达上限 ${limits.maxMembers}，请先回收成员或调高配置`)
      }

      const sharedText = input.sharedContext ? this.sharedContext.snapshotText() : ''
      const marker = input.mode === 'resident'
        ? '\n\n[完成要求] 结束任务时最后一条消息只写：[DONE] <≤120字摘要>。详细结果留在你的会话里，不要复述。'
        : ''
      const prompt = [sharedText, sharedText ? '' : undefined, input.prompt, marker].filter(part => part !== undefined).join('\n')

      // 只过滤全局工具层；主 agent 专用工具与团队工具注册在 agent-scoped
      // context 上，不会进入子代理的全局工具层。shared_context='none' 时把
      // 全局上下文读写工具也藏起来。
      const toolFilter = input.sharedContext
        ? undefined
        : { deny: ['swarm_context_list', 'swarm_context_propose'] }
      const baseRequest = {
        label: input.label,
        prompt: [{ type: 'text' as const, text: prompt }] as ContentBlock[],
        parent,
        ...(toolFilter ? { toolFilter } : {}),
        maxDepth: limits.maxDepth,
      }

      if (input.mode === 'resident') {
        const started = await this.ctx.subagents.startContinuable({
          provider: 'spawn',
          label: input.label,
          request: baseRequest,
          signal: input.signal,
        })
        const member: SwarmMember = {
          id: String(started.childId),
          label: input.label,
          mode: 'resident',
          status: 'running',
          parentId: String(parent.session.id),
          depth,
          sharedContext: input.sharedContext,
          task: clip(input.prompt, 400),
          createdAt: nowIso(),
        }
        this.state.members.push(member)
        await this.save()
        return { memberId: member.id, childId: member.id, label: member.label }
      }

      const jobs = this.ctx.get('jobs') as { start(spec: unknown): string } | undefined
      if (!jobs) throw new Error('background jobs unavailable: load @deepseek-ai/dsh-jobs and @deepseek-ai/dsh-tool-jobs')
      const controller = new AbortController()
      let startPromise: Promise<SubagentRun> | undefined
      const jobId = jobs.start({
        kind: 'subagent',
        label: `蜂群·${input.label}`,
        owner: parent,
        outputLimitBytes: 8192,
        run: () => {
          startPromise = this.ctx.subagents.start('spawn', {
            ...baseRequest,
            signal: controller.signal,
          })
          const done = (async () => {
            try { return await settleRun(await startPromise!) }
            catch (error) {
              return controller.signal.aborted
                ? { status: 'killed' as const }
                : { status: 'failed' as const, detail: String(error) }
            }
          })()
          return {
            cancel: (reason?: string) => { controller.abort(reason ?? 'background swarm task killed') },
            done,
          }
        },
      })
      if (!startPromise) throw new Error('swarm task did not start')
      const run = await startPromise
      const member: SwarmMember = {
        id: String(run.id),
        label: input.label,
        mode: 'task',
        status: 'running',
        parentId: String(parent.session.id),
        depth,
        sharedContext: input.sharedContext,
        task: clip(input.prompt, 400),
        createdAt: nowIso(),
        jobId,
      }
      this.state.members.push(member)
      await this.save()
      void run.result.then(
        result => this.finish(member, result.stopReason, textOf(result.output)),
        error => this.finish(member, 'error', `任务异常：${error instanceof Error ? error.message : String(error)}`),
      )
      return { memberId: member.id, childId: member.id, jobId, label: member.label }
    })
  }

  private finish(member: SwarmMember, stopReason: string, output: string): void {
    if (member.status === 'archived' || member.finishedAt !== undefined) return
    member.status = stopReason === 'completed' ? 'done' : 'failed'
    member.finishedAt = nowIso()
    member.stopReason = stopReason
    member.summary = clip(output.replace(/\s+/g, ' ').trim(), 300)
    void this.save()
  }

  // ── 拉取 ──────────────────────────────────────────────────────────────────

  collect(parent: Agent, cursor?: string): {
    members: SwarmMember[]
    pendingProposals: SharedContextProposal[]
    nextCursor: string
    sharedVersion: number
  } {
    const since = cursor ?? this.state.lastCollectedAt ?? ''
    const members = this.state.members
      .filter(member => member.parentId === parent.session.id)
      .filter(member => member.status !== 'archived' && member.finishedAt !== undefined && member.finishedAt > since)
      .slice()
      .sort((a, b) => String(a.finishedAt).localeCompare(String(b.finishedAt)))
    const collectedAt = nowIso()
    let nextCursor = since
    for (const member of members) {
      member.collectedAt = collectedAt
      if ((member.finishedAt ?? '') > nextCursor) nextCursor = member.finishedAt ?? nextCursor
    }
    this.state.lastCollectedAt = nextCursor || collectedAt
    void this.save()
    return {
      members,
      pendingProposals: this.sharedContext.proposals(),
      nextCursor,
      sharedVersion: this.sharedContext.version,
    }
  }

  async result(parent: Agent, memberId: string, detail: boolean): Promise<{ member: SwarmMember; output: string }> {
    const member = this.member(memberId)
    if (!member) throw new Error('member not found')
    if (member.parentId !== String(parent.session.id)) throw new Error('member is not your direct child')
    const events = await this.readSessionEvents(memberId)
    const text = lastAssistantText(events)
    const limit = detail ? 8000 : 4000
    return { member, output: text ? clip(text, limit) : clip(member.summary ?? '', limit) }
  }

  async retire(parent: Agent, memberId: string): Promise<SwarmMember> {
    const member = this.member(memberId)
    if (!member) throw new Error('member not found')
    if (member.parentId !== String(parent.session.id)) throw new Error('member is not your direct child')
    if (member.status === 'running') {
      try {
        await this.ctx.subagents.interrupt(SessionId(memberId) as any, {
          kind: 'user',
          parentSessionId: SessionId(member.parentId),
        } as any)
      } catch {
        // interrupt 是尽力而为；归档仍然继续
      }
    }
    member.status = 'archived'
    member.archivedAt = nowIso()
    await this.save()
    await this.exportArchive(member)
    return member
  }

  /** 逻辑归档之外的会话导出：{dataDir}/swarm/archive/<id>.jsonl（best-effort）。 */
  private async exportArchive(member: SwarmMember): Promise<void> {
    const persistence = this.ctx.get('sessionPersistence') as
      | {
          supportsRawArtifacts?: boolean
          readRaw?(id: unknown): Promise<{ content?: string } | undefined>
          inspect(id: unknown): Promise<{ events: readonly unknown[] }>
        }
      | undefined
    if (!persistence) return
    try {
      const directory = resolve(this.dataDir, 'swarm', 'archive')
      await mkdir(directory, { recursive: true })
      let content: string | undefined
      if (persistence.supportsRawArtifacts && persistence.readRaw) {
        const raw = await persistence.readRaw(SessionId(member.id))
        if (raw?.content) content = raw.content
      }
      if (!content) {
        const inspected = await persistence.inspect(SessionId(member.id))
        content = inspected.events.map(event => JSON.stringify(event)).join('\n') + '\n'
      }
      if (content) await writeFile(resolve(directory, `${member.id}.jsonl`), content, 'utf8')
      await writeFile(resolve(directory, `${member.id}.meta.json`), JSON.stringify(member, null, 2), 'utf8')
    } catch (error) {
      console.warn('[swarm] archive export failed:', error instanceof Error ? error.message : String(error))
    }
  }

  // ── 读取 ──────────────────────────────────────────────────────────────────

  async memberEvents(id: string): Promise<unknown[]> {
    return this.readSessionEvents(id)
  }

  private async readSessionEvents(id: string): Promise<any[]> {
    try {
      const live = this.ctx.agents.get(SessionId(id) as any) as Agent | undefined
      if (live) return (live.session as any).events ?? []
    } catch { /* 子会话不在本进程活跃 */ }
    const persistence = this.ctx.get('sessionPersistence') as
      | { inspect(id: unknown): Promise<{ events: readonly unknown[] }> }
      | undefined
    if (!persistence) return []
    try {
      const inspected = await persistence.inspect(SessionId(id) as any)
      return inspected.events as unknown[]
    } catch {
      return []
    }
  }

  // ── 快照 / 归档 ───────────────────────────────────────────────────────────

  snapshot(): Record<string, unknown> {
    const limits = this.limits()
    const members = this.allMembers()
    const active = members.filter(member => member.status !== 'archived')
    const archived = members.filter(member => member.status === 'archived')
    const sharedEntries = this.sharedContext.entries()
    const proposals = this.sharedContext.proposals()
    return {
      main: {
        sessionId: String(this.agent.session.id),
        name: this.name,
        status: this.agent.status,
      },
      limits,
      members: active,
      archived,
      counts: {
        total: active.length,
        running: active.filter(member => member.status === 'running').length,
        done: active.filter(member => member.status === 'done').length,
        failed: active.filter(member => member.status === 'failed').length,
        archived: archived.length,
      },
      sharedContext: {
        version: this.sharedContext.version,
        entries: sharedEntries,
        pendingProposals: proposals,
        bytes: this.sharedContext.byteUsage(),
        limits: this.sharedContext.limitsSnapshot(),
      },
    }
  }
}

function lastAssistantText(events: readonly any[]): string {
  for (let index = events.length - 1; index >= 0; index--) {
    const event = events[index]
    if (event?.type !== 'assistant/message') continue
    const content = event.data?.message?.content
    const text = Array.isArray(content) ? textOf(content) : ''
    if (text) return text
  }
  return ''
}
