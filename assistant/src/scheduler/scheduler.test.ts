import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:http'
import { Context } from '@deepseek-ai/cordis'
import { Inbox, type Agent } from '@deepseek-ai/dsh-agent'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import { CallId, createUserMessage, type UserMessage } from '@deepseek-ai/dsh-llm'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import { bindAgent, runCompactionFlow } from '../memory/gate.js'
import { ScheduledWakeService, type ScheduledWake } from './wake.js'
import { registerSchedulerTools } from './tools.js'

const wake: ScheduledWake = {
  sessionId: 'scheduler-owner', taskId: 'task-1', runId: 'run-1',
  title: '回顾部署约定', prompt: '检查 pnpm 部署约定', scheduledAt: '2026-10-11T09:00:00+08:00',
  task: {
    id: 'task-1', ownerSessionId: 'scheduler-owner', creatorName: '测试助手',
    title: '回顾部署约定', prompt: '检查 pnpm 部署约定',
    schedule: { kind: 'daily', time: '09:00', timezone: 'Asia/Shanghai' },
    enabled: true, nextRunAt: '2026-10-11T09:00:00+08:00', lastOutcome: null, lastError: null,
    createdAt: '2026-10-10T09:00:00+08:00', updatedAt: '2026-10-10T09:00:00+08:00', completedAt: null,
  },
  run: { id: 'run-1', trigger: 'scheduled', scheduledAt: '2026-10-11T09:00:00+08:00', triggeredAt: '2026-10-11T09:00:03+08:00' },
}

async function flush(): Promise<void> {
  await new Promise<void>(resolve => setImmediate(resolve))
  await new Promise<void>(resolve => setImmediate(resolve))
}

async function receiver() {
  const ctx = new Context()
  await ctx.plugin(SessionStore).await()
  const session = ctx.sessions.create(SessionId(wake.sessionId))
  const delivered: UserMessage[] = []
  const inbox = new Inbox(session, { inserted() {}, discarded() {}, claimed() {} })
  const agent = {
    id: session.id, session, ctx, inbox, status: 'idle',
    followup(message: UserMessage) { inbox.append('next-turn', message); delivered.push(message) },
  } as unknown as Agent
  bindAgent(agent)
  return { ctx, session, inbox, agent, delivered }
}

test('wake identity is checked and concurrent retries enqueue only one input', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'scheduled-wake-'))
  const harness = await receiver()
  const service = await ScheduledWakeService.create(harness.agent, dir)
  try {
    await assert.rejects(service.accept({ ...wake, sessionId: 'someone-else' }), /another assistant/)
    const results = await Promise.all([service.accept(wake), service.accept(wake)])
    assert.deepEqual(results.map(result => result.duplicate), [false, true])
    await flush()
    assert.equal(harness.delivered.length, 1)
    const delivered = harness.delivered[0]!
    assert.equal(delivered.source.kind, 'system-event')
    assert.ok(delivered.source.kind === 'system-event')
    assert.equal(delivered.source.form, 'notice')
    assert.equal(delivered.source.eventType, 'scheduled-task-triggered')
    assert.deepEqual(delivered.source.task, wake.task)
    assert.deepEqual(delivered.source.run, wake.run)
    const text = delivered.content.filter(block => block.type === 'text').map(block => block.text).join('\n')
    assert.match(text, /^\[系统事件：定时任务触发\]/)
    const event = JSON.parse(text.slice(text.indexOf('\n{') + 1))
    assert.equal(event.type, 'scheduled-task-triggered')
    assert.equal(event.task.prompt, wake.prompt)
    assert.deepEqual(event.task, wake.task)
    assert.deepEqual(event.run, wake.run)
    assert.equal(text.split(wake.prompt).length - 1, 1, 'prompt appears once in the model event')
    const receipt = JSON.parse(await readFile(join(dir, 'scheduled-inputs.json'), 'utf8'))
    assert.equal(receipt.receipts[0].runId, wake.runId)
  } finally {
    await service.dispose(); await harness.ctx.fiber.dispose()
    await rm(dir, { recursive: true, force: true })
  }
})

test('unconsumed wake survives restart and consumed wake is not replayed', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'scheduled-restore-'))
  const harness = await receiver()
  let service = await ScheduledWakeService.create(harness.agent, dir)
  try {
    await service.accept(wake)
    await flush()
    await service.dispose()
    service = await ScheduledWakeService.create(harness.agent, dir)
    service.resume()
    await flush()
    assert.equal(harness.inbox.nextTurn.length, 1, 'requeue wakes the driver without duplicating a restored pending input')
    assert.equal(harness.delivered.length, 2)
    const message = harness.inbox.nextTurn[0]!
    harness.inbox.remove(message.id)
    harness.session.append('user/message', message, { surfaceOp: 'append' })
    await flush()
    await service.dispose()
    service = await ScheduledWakeService.create(harness.agent, dir)
    service.resume()
    await flush()
    assert.deepEqual(await service.accept(wake), { accepted: true, duplicate: true })
    assert.equal(harness.delivered.length, 2)
  } finally {
    await service.dispose(); await harness.ctx.fiber.dispose()
    await rm(dir, { recursive: true, force: true })
  }
})

test('consumed receipt left by a crash is cleaned without replaying or dropping pending input', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'scheduled-cleanup-'))
  const harness = await receiver()
  let service = await ScheduledWakeService.create(harness.agent, dir)
  const pending = { ...wake, runId: 'run-pending', run: { ...wake.run!, id: 'run-pending' } }
  try {
    await service.accept(wake)
    await service.accept(pending)
    await flush()
    const consumed = harness.inbox.nextTurn.find(message => message.source.kind === 'system-event' && message.source.runId === wake.runId)!
    harness.inbox.remove(consumed.id)
    harness.session.append('user/message', consumed, { surfaceOp: 'append' })
    await flush()
    await service.dispose()
    await writeFile(join(dir, 'scheduled-inputs.json'), JSON.stringify({ version: 1, receipts: [wake, pending] }))

    service = await ScheduledWakeService.create(harness.agent, dir)
    const receipt = JSON.parse(await readFile(join(dir, 'scheduled-inputs.json'), 'utf8'))
    assert.deepEqual(receipt.receipts.map((item: ScheduledWake) => item.runId), [pending.runId])
    service.resume()
    await flush()
    assert.equal(harness.delivered.filter(message => message.source.kind === 'system-event' && message.source.runId === wake.runId).length, 1)
    assert.equal(harness.delivered.filter(message => message.source.kind === 'system-event' && message.source.runId === pending.runId).length, 2)
  } finally {
    await service.dispose(); await harness.ctx.fiber.dispose()
    await rm(dir, { recursive: true, force: true })
  }
})

test('wake stays behind an active compaction flow', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'scheduled-compaction-'))
  const harness = await receiver()
  const service = await ScheduledWakeService.create(harness.agent, dir)
  let release!: () => void
  const barrier = new Promise<void>(resolve => { release = resolve })
  const compacting = runCompactionFlow(async () => { await barrier })
  try {
    await service.accept(wake)
    await flush()
    assert.equal(harness.delivered.length, 0)
    assert.equal(JSON.parse(await readFile(join(dir, 'scheduled-inputs.json'), 'utf8')).receipts[0].runId, wake.runId)
    release()
    await compacting
    await flush()
    assert.equal(harness.delivered.length, 1)
  } finally {
    release()
    await compacting.catch(() => undefined)
    await service.dispose(); await harness.ctx.fiber.dispose()
    await rm(dir, { recursive: true, force: true })
  }
})

test('legacy receipt becomes a system event and old consumed scheduled source still deduplicates', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'scheduled-legacy-'))
  const harness = await receiver()
  const { task, run, ...legacy } = wake
  await writeFile(join(dir, 'scheduled-inputs.json'), JSON.stringify({ version: 1, receipts: [legacy] }))
  let service = await ScheduledWakeService.create(harness.agent, dir)
  try {
    service.resume()
    await flush()
    assert.equal(harness.delivered[0]?.source.kind, 'system-event')
    await service.dispose()
    harness.inbox.remove(harness.delivered[0]!.id)
    const { prompt, ...source } = legacy
    harness.session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: prompt }], source: { kind: 'scheduled-task', ...source },
    }), { surfaceOp: 'append' })
    service = await ScheduledWakeService.create(harness.agent, dir)
    service.resume()
    await flush()
    assert.deepEqual(await service.accept(wake), { accepted: true, duplicate: true })
    assert.equal(harness.delivered.length, 1)
  } finally {
    await service.dispose(); await harness.ctx.fiber.dispose()
    await rm(dir, { recursive: true, force: true })
  }
})

test('mismatched snapshot identity is rejected before a receipt is acknowledged', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'scheduled-invalid-'))
  const harness = await receiver()
  const service = await ScheduledWakeService.create(harness.agent, dir)
  try {
    await assert.rejects(service.accept({ ...wake, task: { ...wake.task, ownerSessionId: 'other' } }), /identity mismatch/)
    await assert.rejects(service.accept({ ...wake, run: { ...wake.run, id: 'other-run' } }), /identity mismatch/)
    await assert.rejects(service.accept({ ...wake, task: { ...wake.task, prompt: 'different' } }), /identity mismatch/)
    assert.equal(harness.delivered.length, 0)
  } finally {
    await service.dispose(); await harness.ctx.fiber.dispose()
    await rm(dir, { recursive: true, force: true })
  }
})

test('model tools bind creator identity and scope every operation to their own tasks', async () => {
  const requests: Array<{ url: URL; method: string; body: any }> = []
  const server = createServer(async (req, res) => {
    let raw = ''
    for await (const chunk of req) raw += chunk
    requests.push({ url: new URL(req.url!, 'http://local'), method: req.method!, body: raw ? JSON.parse(raw) : undefined })
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(req.method === 'GET' ? { count: 0, items: [] } : { id: 'task-1' }))
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address() as { port: number }
  const ctx = new Context()
  await ctx.plugin(SystemPrompt).await()
  await ctx.plugin(ToolRuntime).await()
  registerSchedulerTools(ctx, { consoleUrl: `http://127.0.0.1:${address.port}`, sessionId: wake.sessionId })
  try {
    const execute = (name: string, args: unknown) => ctx.tools.execute({
      name, arguments: args, callId: CallId(`test-${name}`), signal: new AbortController().signal,
    })
    const created = await execute('create_scheduled_task', {
      title: wake.title, prompt: wake.prompt, schedule: { kind: 'daily', time: '09:00', timezone: 'Asia/Shanghai' },
    })
    assert.equal(created.isError, false)
    assert.equal(requests[0]!.body.creatorSessionId, wake.sessionId)
    await execute('list_scheduled_tasks', {})
    await execute('update_scheduled_task', { id: 'task-1', enabled: false })
    await execute('scheduled_task_runs', { id: 'task-1' })
    await execute('delete_scheduled_task', { id: 'task-1' })
    assert.equal(requests.length, 5)
    for (const request of requests) assert.equal(request.url.searchParams.get('creatorSessionId'), wake.sessionId)
    assert.deepEqual(requests[2]!.body, { enabled: false })
  } finally {
    await ctx.fiber.dispose()
    await new Promise<void>(resolve => server.close(() => resolve()))
  }
})
