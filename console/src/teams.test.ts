import assert from 'node:assert/strict'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { TeamCenter } from './teams.ts'

test('team lifecycle: one team per assistant, roles, leader transfer', async () => {
  const center = new TeamCenter()
  const team = center.create({ name: '开发组', goal: '交付萤火镇' })
  assert.equal(team.name, '开发组')
  assert.equal(team.leaderId, null)

  center.addMember(team.id, 'a1', '产品')
  center.addMember(team.id, 'a2', '开发')
  assert.equal(center.teamOf('a1')?.id, team.id)

  // 一个助手只能属于一个团队
  const other = center.create({ name: '另一个组' })
  assert.throws(() => center.addMember(other.id, 'a1'), /already belongs to team/)

  // 指定 leader 会把角色改成 leader
  center.setLeader(team.id, 'a2')
  assert.equal(center.get(team.id)?.leaderId, 'a2')
  assert.equal(center.get(team.id)?.members.find(member => member.assistantId === 'a2')?.role, 'leader')
  // leader 不能直接移除
  assert.throws(() => center.removeMember(team.id, 'a2'), /cannot remove the leader/)
  // leader 角色不能改
  assert.throws(() => center.setRole(team.id, 'a2', '测试'), /leader role is fixed/)

  center.setRole(team.id, 'a1', '测试')
  assert.equal(center.get(team.id)?.members.find(member => member.assistantId === 'a1')?.role, '测试')
  center.removeMember(team.id, 'a1')
  assert.equal(center.get(team.id)?.members.length, 1)
})

test('team messages: direct, broadcast, human only to leader, since pagination', async () => {
  const center = new TeamCenter()
  const team = center.create({ name: '群聊组', leaderId: 'leader-1' })
  center.addMember(team.id, 'member-1', '开发')

  const direct = center.appendMessage(team.id, {
    kind: 'direct', fromKind: 'assistant', fromId: 'leader-1', fromName: 'leader',
    toId: 'member-1', toName: 'member-1', text: '先做 A',
  })
  assert.equal(direct.toId, 'member-1')
  assert.equal(direct.hop, 0)

  const reply = center.appendMessage(team.id, {
    kind: 'direct', fromKind: 'assistant', fromId: 'member-1', fromName: 'member-1',
    toId: 'leader-1', toName: 'leader', text: 'A 完成', replyTo: direct.id,
  })
  assert.equal(reply.threadId, direct.threadId)
  assert.equal(reply.hop, 1)

  const broadcast = center.appendMessage(team.id, {
    kind: 'broadcast', fromKind: 'assistant', fromId: 'leader-1', fromName: 'leader',
    text: '今晚验收',
  })
  assert.equal(broadcast.toId, null)
  assert.equal(broadcast.toName, '全组')

  const human = center.appendHumanMessage(team.id, '需求更新')
  assert.equal(human.fromKind, 'human')
  assert.equal(human.toId, 'leader-1')
  assert.throws(() => center.appendMessage(team.id, {
    kind: 'direct', fromKind: 'human', fromId: 'console:user', fromName: '控制台',
    toId: 'member-1', toName: 'member-1', text: '偷偷绕过 leader',
  }), /human messages must be direct to the team leader/)

  const all = center.listMessages(team.id)
  assert.equal(all.length, 4)
  const after = center.listMessages(team.id, { since: direct.id })
  assert.deepEqual(after.map(message => message.id), [reply.id, broadcast.id, human.id])
})

test('team persistence: teams.json and messages.jsonl round-trip', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'console-teams-test-'))
  const teamsPath = join(directory, 'teams.json')
  const messagesPath = join(directory, 'teams', 'messages.jsonl')

  const first = new TeamCenter({ teamsPath, messagesPath })
  const team = first.create({ name: '持久组', leaderId: 'leader-1' })
  first.addMember(team.id, 'member-1', '测试')
  first.appendMessage(team.id, {
    kind: 'direct', fromKind: 'assistant', fromId: 'leader-1', fromName: 'leader',
    toId: 'member-1', toName: 'member-1', text: '持久消息',
  })
  await first.save()

  const second = new TeamCenter({ teamsPath, messagesPath })
  await second.load()
  assert.equal(second.list().length, 1)
  assert.equal(second.get(team.id)?.name, '持久组')
  assert.equal(second.get(team.id)?.members.length, 2)
  assert.equal(second.listMessages(team.id)[0]?.text, '持久消息')

  const raw = await readFile(teamsPath, 'utf-8')
  assert.match(raw, /持久组/)
})
