import assert from 'node:assert/strict'
import test from 'node:test'
import { teamMessageText } from './events.js'
import type { TeamMessagePayload } from './client.js'

function payload(overrides: Partial<TeamMessagePayload> = {}): TeamMessagePayload {
  return {
    id: 'msg-1',
    teamId: 'team-1',
    kind: 'direct',
    fromKind: 'assistant',
    fromId: 'a1',
    fromName: '产品小助',
    toId: 'a2',
    toName: 'leader',
    text: '先出需求文档',
    threadId: 'msg-1',
    replyTo: null,
    hop: 0,
    createdAt: '2026-10-21T02:00:00.000Z',
    ...overrides,
  }
}

test('team message text carries team, sender and reply guidance', () => {
  const text = teamMessageText(payload(), '萤火镇开发组')
  assert.match(text, /团队消息 · 萤火镇开发组/)
  assert.match(text, /产品小助 → 你/)
  assert.match(text, /先出需求文档/)
  assert.match(text, /team_send/)
  assert.match(text, /可以选择不回复/)
})

test('broadcast message is labeled and targets the whole team', () => {
  const text = teamMessageText(payload({ kind: 'broadcast', toId: null, toName: '全组' }), '开发组')
  assert.match(text, /团队广播/)
  assert.match(text, /→ 全组/)
  assert.match(text, /团队广播/)
})

test('human sender is rendered as console human', () => {
  const text = teamMessageText(payload({ fromKind: 'human', fromId: 'console:user', fromName: '控制台' }), '开发组')
  assert.match(text, /控制台人类/)
})
