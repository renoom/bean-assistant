/**
 * 团队运行时 — 助手侧的团队通信能力
 *
 * 安装内容（都只在主 agent 的 scoped context 上）：
 *   - team:context 系统提示词段（团队、角色、成员、leader 职责）
 *   - team_roster / team_send / team_broadcast / team_assign_role / team_recruit 工具
 *   - POST /api/team/deliver：Console 投递团队消息的入口
 *
 * 消息只产生一个用户 turn；助手可以选择不回复。没有自动回复、没有 peer-to-peer。
 *
 * @module assistant/team/runtime
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { JsonValue } from '@deepseek-ai/dsh-session'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-system-prompt'
import { json, readJson, type HttpService } from '../service/http-service.js'
import {
  assignTeamRole,
  fetchRoster,
  recruitTeamMember,
  sendTeamMessage,
  type TeamMessagePayload,
  type TeamRoster,
} from './client.js'
import { deliverTeamMessage } from './events.js'

export interface TeamRuntimeOptions {
  agent: Agent
  consoleUrl: string
  sessionId: string
  http: HttpService
  /** 成员刷新间隔（毫秒），默认 30s。 */
  refreshIntervalMs?: number
}

export interface TeamRuntime {
  dispose: () => void
  refresh: () => Promise<void>
}

const TEAM_SECTION_ORDER = 119
const REFRESH_INTERVAL_MS = 30_000

export function installTeamRuntime(options: TeamRuntimeOptions): TeamRuntime {
  const { agent, consoleUrl, sessionId, http } = options
  const ctx: Context = agent.ctx
  const disposers: Array<() => void> = []
  let roster: TeamRoster | null = null
  let disposed = false
  const seenMessages = new Set<string>()
  let seenOrder: string[] = []

  async function refresh(): Promise<void> {
    if (disposed) return
    try {
      roster = await fetchRoster(consoleUrl, sessionId)
    } catch {
      // 控制台暂时不可达：保留上一次缓存，工具调用会返回实时错误。
    }
  }

  function teamName(): string {
    return roster?.team.name ?? '团队'
  }

  function rosterText(): string {
    if (!roster) return ''
    const { team, self } = roster
    const lines = [
      `[团队] 你属于团队「${team.name}」，身份：${self.isLeader ? 'leader' : '成员'}，角色：${self.role}。`,
    ]
    if (team.goal) lines.push(`团队目标：${team.goal}`)
    lines.push(`leader：${team.leaderName ?? '未指定'}`)
    lines.push('成员：')
    for (const member of team.members) {
      lines.push(`- ${member.name}（${member.role}${member.isLeader ? ' / leader' : ''}，${member.status === 'online' ? '在线' : '离线'}）`)
    }
    lines.push('')
    if (self.isLeader) {
      lines.push('leader 规则：你不做具体执行工作。你负责对接外部需求、思考拆解、分发任务、给成员安排角色、招募新助手。')
      lines.push('工具：team_roster 查看成员；team_send 1:1 分发；team_broadcast 团队广播；team_assign_role 改角色；team_recruit 招募新助手（用公共配置，可指定 persona）。')
    } else {
      lines.push('团队消息只会投递给你；你可以选择不回复。回复用 team_send，广播用 team_broadcast；不要自动把消息转发给其他成员。')
    }
    lines.push('人类只能通过 Console 给 leader 发言；只有 leader 可以 team_send(to="human") 回复人类。')
    return lines.join('\n')
  }

  // 系统提示词段：每次组装时读取当前缓存，刷新后自动生效。
  disposers.push(ctx.systemPrompt.section({
    name: 'assistant:team',
    order: TEAM_SECTION_ORDER,
    text: () => rosterText(),
  }))

  // 团队消息投递入口（Console → 助手管理 API）
  disposers.push(http.registerRoute('POST', '/api/team/deliver', async (req, res) => {
    const body = await readJson(req, 256 * 1024)
    if (!body) { json(res, 400, { error: 'invalid JSON body' }); return }
    const message = body.message as TeamMessagePayload | undefined
    if (!message || typeof message.id !== 'string' || typeof message.text !== 'string' || typeof message.teamId !== 'string') {
      json(res, 400, { error: 'invalid team message' }); return
    }
    if (seenMessages.has(message.id)) { json(res, 200, { ok: true, duplicate: true }); return }
    if (message.toId && message.toId !== sessionId) {
      json(res, 400, { error: 'message is not addressed to this assistant' }); return
    }
    if (!roster) await refresh()
    seenMessages.add(message.id)
    seenOrder.push(message.id)
    if (seenOrder.length > 1000) {
      const oldest = seenOrder.shift()
      if (oldest) seenMessages.delete(oldest)
    }
    deliverTeamMessage(agent, message, teamName())
    json(res, 200, { ok: true })
  }))

  const output = {
    schema: { type: 'object' as const, additionalProperties: true as const },
    render: (_args: unknown, value: Record<string, unknown>) => [{
      type: 'text' as const,
      text: value.ok ? String(value.text ?? 'ok') : `团队操作失败：${String(value.error ?? 'unknown error')}`,
    }],
  }

  const result = async (operation: () => Promise<Record<string, JsonValue>>): Promise<Record<string, JsonValue>> => {
    try {
      return { ok: true, ...(await operation()) }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  }

  ctx.tools.register(defineTool({
    name: 'team_roster',
    description: '查看你所在团队的 leader、全部成员、角色与在线状态。团队消息只会投递给个人；需要给某人发消息用 team_send。',
    parameters: {},
    output,
    execute: () => result(async () => {
      await refresh()
      if (!roster) throw new Error('当前未加入团队，或控制台不可达')
      return { ok: true, text: rosterText(), team: roster.team, self: roster.self } as unknown as Record<string, JsonValue>
    }),
  }))

  ctx.tools.register(defineTool({
    name: 'team_send',
    description: '给团队内某个成员发一条 1:1 消息。立即返回受理结果，不等待对方回复；对方可以选择不回复。leader 可以用 to="human" 回复控制台人类。',
    parameters: {
      to: { type: 'string', required: true, description: '成员 sessionId 或名字；leader 回复人类用 "human"' },
      message: { type: 'string', required: true, description: '消息正文' },
      replyTo: { type: 'string', description: '可选：要回复的消息 messageId' },
    },
    output,
    execute: args => result(async () => {
      const sent = await sendTeamMessage(consoleUrl, {
        sessionId,
        kind: 'direct',
        to: args.to,
        text: args.message,
        ...(args.replyTo ? { replyTo: args.replyTo } : {}),
      })
      return { ok: true, text: `消息已受理：${sent.messageId}`, messageId: sent.messageId, recipients: sent.recipients }
    }),
  }))

  ctx.tools.register(defineTool({
    name: 'team_broadcast',
    description: '向团队内除自己外的所有成员广播一条消息（单条历史，多份私有投递）。立即返回；成员可以选择不回复，回复默认回到你。广播有更严格的频率限制。',
    parameters: {
      message: { type: 'string', required: true, description: '广播正文' },
    },
    output,
    execute: args => result(async () => {
      const sent = await sendTeamMessage(consoleUrl, {
        sessionId,
        kind: 'broadcast',
        text: args.message,
      })
      return { ok: true, text: `团队广播已受理：${sent.messageId}（${sent.recipients.length} 个收件人）`, messageId: sent.messageId, recipients: sent.recipients }
    }),
  }))

  ctx.tools.register(defineTool({
    name: 'team_assign_role',
    description: '（仅 leader）给团队内某个成员设置角色，例如 产品 / 开发 / 测试 / 验收。',
    parameters: {
      assistantId: { type: 'string', required: true, description: '成员的 sessionId 或名字' },
      role: { type: 'string', required: true, description: '新角色' },
    },
    output,
    execute: args => result(async () => {
      const team = await assignTeamRole(consoleUrl, sessionId, args.assistantId, args.role)
      roster = { team, self: roster?.self ?? { sessionId, name: '我', role: 'leader', isLeader: true } }
      return { ok: true, text: `已把角色设置为「${args.role}」` }
    }),
  }))

  ctx.tools.register(defineTool({
    name: 'team_recruit',
    description: '（仅 leader）招募一个新助手加入团队。新助手使用公共模型配置，leader 可以指定 persona 与角色；spawn 是异步的，返回 starting 后会自行注册。',
    parameters: {
      name: { type: 'string', required: true, description: '新助手名称' },
      role: { type: 'string', description: '新助手在团队中的角色，默认「成员」' },
      persona: { type: 'string', description: '可选：新助手的 system persona' },
    },
    output,
    execute: args => result(async () => {
      const created = await recruitTeamMember(consoleUrl, sessionId, {
        name: args.name,
        ...(args.role ? { role: args.role } : {}),
        ...(args.persona ? { persona: args.persona } : {}),
      })
      return { ok: true, text: `已招募 ${created.name}（${created.sessionId}），角色：${created.role}，状态：${created.status}`, ...created }
    }),
  }))

  // 启动时拉一次 roster；之后周期刷新，成员变化会反映到系统提示词。
  void refresh()
  const timer = setInterval(() => { void refresh() }, options.refreshIntervalMs ?? REFRESH_INTERVAL_MS)
  timer.unref?.()

  return {
    dispose() {
      disposed = true
      clearInterval(timer)
      for (const dispose of disposers.reverse()) {
        try { dispose() } catch { /* 忽略卸载异常 */ }
      }
      disposers.length = 0
    },
    refresh,
  }
}
