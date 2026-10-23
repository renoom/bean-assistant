/**
 * 团队通信事件 — 把 Console 投递的团队消息落成 Agent 可见的用户消息
 *
 * 这是助手会话里的一种特殊消息来源（source.kind = 'team-message'）：
 *   - 模型能看到「谁、来自哪个团队、说了什么」；
 *   - UI 可以按来源渲染成「团队通信」卡片；
 *   - 不自动回复：消息只开启一个 turn，回不回由模型决定。
 *
 * @module assistant/team/events
 */

import type { Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage, type UserMessage } from '@deepseek-ai/dsh-llm'
import { enqueueOrFollowup } from '../memory/gate.js'
import type { TeamMessagePayload } from './client.js'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'team-message': {
      kind: 'team-message'
      teamId: string
      teamName: string
      messageId: string
      fromKind: 'assistant' | 'human'
      fromId: string
      fromName: string
      toId: string | null
      toName: string | null
      threadId: string
      replyTo: string | null
      hop: number
      createdAt: string
    }
  }
}

/** 模型看到的正文：发送者/团队放在最前面，避免 source 不进 prompt 时丢失身份。 */
export function teamMessageText(message: TeamMessagePayload, teamName: string): string {
  const kindLabel = message.kind === 'broadcast' ? '团队广播' : '团队消息'
  const from = message.fromKind === 'human' ? '控制台人类' : message.fromName
  const to = message.kind === 'broadcast' ? '全组' : '你'
  const scope = message.kind === 'broadcast' ? '（团队广播）' : ''
  return [
    `[${kindLabel} · ${teamName}] ${from} → ${to}${scope}`,
    '',
    message.text,
    '',
    `（messageId: ${message.id}；回复用 team_send，广播用 team_broadcast；也可以选择不回复。）`,
  ].join('\n')
}

/** 把一条团队消息作为普通用户消息投递到主 agent 的 inbox。 */
export function deliverTeamMessage(agent: Agent, message: TeamMessagePayload, teamName: string): void {
  const userMessage: UserMessage = createUserMessage({
    content: [{ type: 'text', text: teamMessageText(message, teamName) }],
    source: {
      kind: 'team-message',
      teamId: message.teamId,
      teamName,
      messageId: message.id,
      fromKind: message.fromKind,
      fromId: message.fromId,
      fromName: message.fromName,
      toId: message.toId,
      toName: message.toName,
      threadId: message.threadId,
      replyTo: message.replyTo,
      hop: message.hop,
      createdAt: message.createdAt,
    },
  })
  enqueueOrFollowup(userMessage)
}
