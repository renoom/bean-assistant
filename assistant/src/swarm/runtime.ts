/**
 * 蜂群运行时 — 唯一后台入口、共享上下文、完成标记拉取、归档、蜂群 API
 *
 * 模型工具：
 *  全局（主 agent 与成员都能用）：swarm_dispatch / swarm_context_list / swarm_context_propose
 *  仅主 agent：swarm_collect / swarm_result / swarm_context_write / swarm_retire
 *
 * 所有创建都走 `swarm_dispatch`，没有前台选项；成员只能和父 agent 通信。
 *
 * @module assistant/swarm/runtime
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { JsonValue } from '@deepseek-ai/dsh-session'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type { SwarmConfig } from '../config/types.js'
import { json, readJson, type HttpService } from '../service/http-service.js'
import { SwarmManager, type SwarmMember } from './manager.js'

export interface SwarmRuntimeOptions {
  ctx: Context
  agent: Agent
  dataDir: string
  name: string
  getConfig: () => SwarmConfig | undefined
  http: HttpService
}

export interface SwarmRuntime {
  manager: SwarmManager
  dispose: () => void
}

const POLICY_SECTION_ORDER = 118.6

function textResult(value: Record<string, unknown>): { type: 'text'; text: string }[] {
  return [{ type: 'text', text: value.ok ? String(value.text ?? 'ok') : `蜂群操作失败：${String(value.error ?? 'unknown')}` }]
}

const output = {
  schema: { type: 'object' as const, additionalProperties: true as const },
  render: (_args: unknown, value: Record<string, unknown>) => textResult(value),
}

function memberLine(member: SwarmMember): string {
  const parts = [`${member.id}`, `[${member.status}]`, member.mode, `「${member.label}」`]
  if (member.summary) parts.push(`摘要：${member.summary}`)
  if (member.stopReason) parts.push(`stop=${member.stopReason}`)
  return parts.join(' ')
}

export async function installSwarmRuntime(options: SwarmRuntimeOptions): Promise<SwarmRuntime> {
  const { ctx, agent, dataDir, name, getConfig, http } = options
  const manager = new SwarmManager({ ctx, agent, dataDir, name, getConfig })
  await manager.load()
  const disposers: Array<() => void> = []
  let disposed = false

  const mainSession = String(agent.session.id)

  // 主 agent 的蜂群策略提示词
  disposers.push(agent.ctx.systemPrompt.section({
    name: 'assistant:swarm',
    order: POLICY_SECTION_ORDER,
    text: [
      '[蜂群规则]',
      '- 所有蜂群成员只能通过 swarm_dispatch 创建，永远后台；不要等待成员完成，也不要轮询。',
      "- 默认 mode='task'（一次性任务）；需要反复派活/多轮对话时才用 mode='resident'。",
      "- shared_context='full' 会把共享上下文快照放在成员上下文头部；'none' 则隔离该成员。",
      '- 成员完成只产生完成标记；用 swarm_collect 一次性拉取列表，需要细节再用 swarm_result。',
      '- 共享上下文只有你能写；成员只能提案，用 swarm_context_write 采纳或拒绝。',
      '- 禁止 job_output(wait:true) 或忙等；外部消息与完成通知都是异步的。',
    ].join('\n'),
  }))

  // ── 全局工具：派发与上下文读写 ──────────────────────────────────────────

  disposers.push(ctx.tools.register(defineTool({
    name: 'swarm_dispatch',
    description:
      '创建蜂群成员（唯一入口，永远后台）。mode="task" 创建一次性任务蜂，完成后只发很小的完成标记，结果用 job_output/swarm_collect/swarm_result 主动拉取；mode="resident" 创建常驻蜂（可 send_message 续聊），结束时要求只写 [DONE] 标记。'
      + ' shared_context="full" 把共享上下文快照放在任务头部；"none" 隔离该成员。调用立即返回 jobId/memberId，不等待执行。',
    parameters: {
      label: { type: 'string', required: true, description: '成员的短标签（用于列表/通知）' },
      prompt: { type: 'string', required: true, description: '完整任务提示；成员看不到主会话历史' },
      mode: { type: 'string', enum: ['task', 'resident'], description: 'task=一次性（默认）；resident=常驻可续聊' },
      shared_context: { type: 'string', enum: ['full', 'none'], description: 'full=注入完整共享上下文快照（默认）；none=不注入并隐藏上下文工具' },
    },
    output,
    async execute(args, exec) {
      if (!exec.agent) throw new Error('swarm_dispatch requires a calling agent')
      try {
        const dispatched = await manager.dispatch(exec.agent, {
          label: args.label,
          prompt: args.prompt,
          mode: args.mode === 'resident' ? 'resident' : 'task',
          sharedContext: args.shared_context !== 'none',
          signal: exec.signal,
        })
        return {
          ok: true,
          text: args.mode === 'resident'
            ? `已创建常驻蜂 ${dispatched.memberId}（后台运行，不等待）`
            : `已创建任务蜂 ${dispatched.memberId}（job ${dispatched.jobId ?? '-'}，后台运行，完成会收到标记）`,
          memberId: dispatched.memberId,
          jobId: dispatched.jobId ?? null,
          childId: dispatched.childId,
        } as Record<string, JsonValue>
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) } as Record<string, JsonValue>
      }
    },
  })))

  disposers.push(ctx.tools.register(defineTool({
    name: 'swarm_context_list',
    description: '读取当前共享上下文（只读）。写入只允许主 agent；成员可以先用 swarm_context_propose 提交候选。',
    parameters: {},
    output,
    execute: async () => {
      const entries = manager.sharedContext.entries()
      const lines = entries.length === 0
        ? '共享上下文为空'
        : [`共享上下文 v${manager.sharedContext.version}（${manager.sharedContext.byteUsage()} bytes）`, ...entries.map(entry => `- ${entry.title} (${entry.key}): ${entry.content}`)].join('\n')
      return { ok: true, text: lines, entries, version: manager.sharedContext.version } as unknown as Record<string, JsonValue>
    },
  })))

  disposers.push(ctx.tools.register(defineTool({
    name: 'swarm_context_propose',
    description: '向主 agent 提交一条共享上下文候选（不会直接写入正文）。主 agent 会通过 swarm_context_write 采纳或拒绝。',
    parameters: {
      key: { type: 'string', required: true, description: '稳定 key（如 api-convention）' },
      title: { type: 'string', required: true, description: '标题' },
      content: { type: 'string', required: true, description: '正文，最多 1024 字' },
    },
    output,
    execute: async (args, exec) => {
      const author = exec.agent ? String(exec.agent.session.id) : mainSession
      const proposal = manager.sharedContext.propose(author, args)
      return { ok: true, text: `候选已提交：${proposal.id}（等待主 agent 审核）`, proposalId: proposal.id } as unknown as Record<string, JsonValue>
    },
  })))

  // ── 主 agent 工具：拉取 / 上下文写入 / 归档 ─────────────────────────────

  disposers.push(agent.ctx.tools.register(defineTool({
    name: 'swarm_collect',
    description: '拉取你直接子代理中已完成/失败的成员（自上次拉取以来），返回摘要与待审共享上下文候选；不含完整输出。先 collect，再按需 swarm_result。',
    parameters: {
      cursor: { type: 'string', description: '可选：上次返回的 nextCursor；省略则用服务端游标' },
    },
    output,
    execute: async args => {
      const collected = manager.collect(agent, args.cursor)
      const lines = collected.members.length === 0
        ? '没有新的完成成员'
        : [`${collected.members.length} 个成员完成：`, ...collected.members.map(member => `- ${memberLine(member)}`)].join('\n')
      const pending = collected.pendingProposals.length > 0
        ? `\n待审共享上下文候选 ${collected.pendingProposals.length} 条（swarm_context_write action=accept/reject）`
        : ''
      return {
        ok: true,
        text: lines + pending,
        members: collected.members,
        pendingProposals: collected.pendingProposals.map(proposal => ({
          id: proposal.id, key: proposal.key, title: proposal.title, content: proposal.content, author: proposal.author,
        })),
        nextCursor: collected.nextCursor,
        sharedVersion: collected.sharedVersion,
      } as unknown as Record<string, JsonValue>
    },
  })))

  disposers.push(agent.ctx.tools.register(defineTool({
    name: 'swarm_result',
    description: '读取某个直接子代理的最终输出（从它自己的会话读取，默认截断 4KB；detail=true 最多 8KB）。',
    parameters: {
      memberId: { type: 'string', required: true, description: '成员 sessionId（来自 swarm_dispatch / swarm_collect）' },
      detail: { type: 'boolean', description: 'true=返回更长的详情（最多 8KB）' },
    },
    output,
    execute: async args => {
      try {
        const result = await manager.result(agent, args.memberId, Boolean(args.detail))
        return { ok: true, text: result.output || '（该成员没有可读取的输出）', member: result.member } as unknown as Record<string, JsonValue>
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) } as Record<string, JsonValue>
      }
    },
  })))

  disposers.push(agent.ctx.tools.register(defineTool({
    name: 'swarm_context_write',
    description: '（仅主 agent）写共享上下文：action=add/update/delete 直接改正文；action=accept/reject 处理成员候选。写满会失败，需要先删除/合并。',
    parameters: {
      action: { type: 'string', required: true, enum: ['add', 'update', 'delete', 'accept', 'reject'], description: '操作' },
      id: { type: 'string', description: 'update/delete 的条目 id' },
      key: { type: 'string', description: 'add/update 的稳定 key' },
      title: { type: 'string', description: 'add/update 的标题' },
      content: { type: 'string', description: 'add/update 的正文（最多 1024 字）' },
      proposalId: { type: 'string', description: 'accept/reject 的候选 id' },
    },
    output,
    execute: async args => {
      try {
        const result = manager.sharedContext.write({
          action: args.action,
          ...(args.id ? { id: args.id } : {}),
          ...(args.key ? { key: args.key } : {}),
          ...(args.title ? { title: args.title } : {}),
          ...(args.content ? { content: args.content } : {}),
          ...(args.proposalId ? { proposalId: args.proposalId } : {}),
        })
        return { ok: true, text: `${result.message}（v${result.version}）` } as unknown as Record<string, JsonValue>
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) } as Record<string, JsonValue>
      }
    },
  })))

  disposers.push(agent.ctx.tools.register(defineTool({
    name: 'swarm_retire',
    description: '（仅主 agent）确认弃用某个直接子代理：停止当前 turn、标记归档、从活跃列表释放名额。不删除持久会话。',
    parameters: {
      memberId: { type: 'string', required: true, description: '成员 sessionId' },
    },
    output,
    execute: async args => {
      try {
        const member = await manager.retire(agent, args.memberId)
        return { ok: true, text: `已归档成员 ${member.id}（${member.label}）` } as unknown as Record<string, JsonValue>
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) } as Record<string, JsonValue>
      }
    },
  })))

  // ── HTTP API ─────────────────────────────────────────────────────────────

  disposers.push(http.registerHandler(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const path = url.pathname
    // 开发/验收专用入口：仅在 ASSISTANT_SWARM_DEV_API=1 时开放，不参与模型工具。
    if (req.method === 'POST' && process.env.ASSISTANT_SWARM_DEV_API === '1' && path.startsWith('/api/swarm/dev/')) {
      const body = await readJson(req) ?? {}
      try {
        if (path === '/api/swarm/dev/dispatch') {
          const dispatched = await manager.dispatch(agent, {
            label: String(body.label ?? 'dev-member'),
            prompt: String(body.prompt ?? ''),
            mode: body.mode === 'resident' ? 'resident' : 'task',
            sharedContext: body.shared_context !== 'none',
            signal: AbortSignal.timeout(15_000),
          })
          json(res, 201, dispatched)
          return true
        }
        if (path === '/api/swarm/dev/context') {
          json(res, 200, manager.sharedContext.write(body as any))
          return true
        }
        if (path === '/api/swarm/dev/collect') {
          json(res, 200, manager.collect(agent, typeof body.cursor === 'string' ? body.cursor : undefined))
          return true
        }
        if (path === '/api/swarm/dev/result') {
          json(res, 200, await manager.result(agent, String(body.memberId ?? ''), Boolean(body.detail)))
          return true
        }
        if (path === '/api/swarm/dev/retire') {
          json(res, 200, await manager.retire(agent, String(body.memberId ?? '')))
          return true
        }
        json(res, 404, { error: 'not found' })
        return true
      } catch (error) {
        json(res, 400, { error: error instanceof Error ? error.message : String(error) })
        return true
      }
    }
    if (req.method !== 'GET') return false
    if (path === '/api/swarm') {
      json(res, 200, manager.snapshot())
      return true
    }
    if (path === '/api/swarm/context') {
      json(res, 200, {
        version: manager.sharedContext.version,
        entries: manager.sharedContext.entries(),
        proposals: manager.sharedContext.proposals(),
        limits: manager.sharedContext.limitsSnapshot(),
        bytes: manager.sharedContext.byteUsage(),
      })
      return true
    }
    if (path === '/api/swarm/relations') {
      const id = url.searchParams.get('id') ?? ''
      const relations = manager.relations(id)
      if (!relations) { json(res, 404, { error: 'member not found' }); return true }
      json(res, 200, relations)
      return true
    }
    if (path === '/api/swarm/archive') {
      json(res, 200, { members: manager.allMembers().filter(member => member.status === 'archived') })
      return true
    }
    const memberMatch = path.match(/^\/api\/swarm\/member\/([^/]+)$/)
    if (memberMatch) {
      const id = decodeURIComponent(memberMatch[1])
      const member = manager.member(id)
      if (!member) { json(res, 404, { error: 'member not found' }); return true }
      const events = await manager.memberEvents(id)
      json(res, 200, { member, events: events.slice(-300) })
      return true
    }
    const streamMatch = path.match(/^\/api\/swarm\/member\/([^/]+)\/stream$/)
    if (streamMatch) {
      const id = decodeURIComponent(streamMatch[1])
      const member = manager.member(id)
      if (!member) { json(res, 404, { error: 'member not found' }); return true }
      streamMember(req, res, id, manager)
      return true
    }
    return false
  }))

  const timer = setInterval(() => { void manager.save() }, 15_000)
  timer.unref?.()

  return {
    manager,
    dispose() {
      if (disposed) return
      disposed = true
      clearInterval(timer)
      manager.dispose()
      for (const dispose of disposers.reverse()) {
        try { dispose() } catch { /* ignore */ }
      }
      disposers.length = 0
    },
  }
}

function streamMember(
  req: import('node:http').IncomingMessage,
  res: import('node:http').ServerResponse,
  id: string,
  manager: SwarmManager,
): void {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  })
  res.write(': connected\n\n')
  let lastSeq = -1
  let closed = false
  const tick = async (): Promise<void> => {
    if (closed) return
    try {
      const events = await manager.memberEvents(id) as Array<{ seq?: number; type?: string; data?: unknown }>
      for (const event of events) {
        const seq = typeof event.seq === 'number' ? event.seq : -1
        if (seq <= lastSeq) continue
        lastSeq = seq
        res.write(`data: ${JSON.stringify({ type: 'session_event', data: event })}\n\n`)
      }
    } catch {
      // 成员会话暂不可读：保持连接，下一拍重试
    }
  }
  const timer = setInterval(() => { void tick() }, 1000)
  void tick()
  req.on('close', () => {
    closed = true
    clearInterval(timer)
    try { res.end() } catch { /* ignore */ }
  })
}
