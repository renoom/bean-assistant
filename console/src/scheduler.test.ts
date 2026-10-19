import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { DatabaseSync } from 'node:sqlite'
import type { AddressInfo } from 'node:net'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { Registry } from './registry.ts'
import { TaskScheduler, nextRunAtForSchedule, validateSchedule } from './scheduler/index.ts'
import { ApiKeyAuth } from './auth.ts'
import { ConfigCenter, loadConfig } from './config.ts'
import { KnowledgeCenter } from './knowledge/index.ts'
import { KnowledgeStore } from './knowledge/store.ts'
import { createConsoleServer } from './server.ts'

function register(registry: Registry, sessionId: string, port = 1, name = sessionId): void {
  registry.register({
    name, host: '127.0.0.1', port, model: 'test', provider: 'test', sessionId, channels: ['http'],
  })
}

async function schedulerPath(): Promise<string> {
  return join(await mkdtemp(join(tmpdir(), 'scheduler-test-')), 'scheduler.sqlite')
}

test('validates once, interval and daily schedules and calculates future occurrences', () => {
  assert.deepEqual(validateSchedule({ kind: 'interval', everySeconds: 60 }), { kind: 'interval', everySeconds: 60 })
  assert.throws(() => validateSchedule({ kind: 'interval', everySeconds: 59 }), /greater than or equal to 60/)
  assert.throws(() => validateSchedule({ kind: 'once', at: '2026-01-01T00:00:00' }), /explicit offset/)
  assert.throws(() => validateSchedule({ kind: 'daily', time: '25:00', timezone: 'Asia/Shanghai' }), /HH:mm/)
  assert.throws(() => validateSchedule({ kind: 'daily', time: '09:00', timezone: 'Nowhere/Invalid' }), /IANA/)

  assert.equal(
    nextRunAtForSchedule(
      { kind: 'interval', everySeconds: 60, startAt: '2026-01-01T00:00:00.000Z' },
      new Date('2026-01-01T00:04:30.000Z'),
    ),
    '2026-01-01T00:05:00.000Z',
  )
  assert.equal(
    nextRunAtForSchedule(
      { kind: 'daily', time: '09:00', timezone: 'Asia/Shanghai' },
      new Date('2026-01-01T00:30:00.000Z'),
    ),
    '2026-01-01T01:00:00.000Z',
  )
  assert.equal(
    nextRunAtForSchedule({ kind: 'daily', time: '02:30', timezone: 'America/New_York' },
      new Date('2026-03-08T05:00:00Z')),
    '2026-03-09T06:30:00.000Z', 'skip nonexistent wall-clock time during DST',
  )
})

test('changing a once task to interval at the same due instant keeps the new schedule', async () => {
  const registry = new Registry()
  register(registry, 'owner')
  let arrived!: () => void
  let release!: () => void
  const arrival = new Promise<void>(resolve => { arrived = resolve })
  const response = new Promise<Response>(resolve => {
    release = () => resolve(new Response('{"accepted":true}', { headers: { 'Content-Type': 'application/json' } }))
  })
  const scheduler = new TaskScheduler({ path: ':memory:', registry, autoStart: false,
    fetchFn: async () => { arrived(); return response },
  })
  try {
    const task = scheduler.createTask({ ownerSessionId: 'owner', creatorName: 'owner', title: 'changed', prompt: 'work',
      schedule: { kind: 'once', at: '2026-01-01T00:01:00Z' },
    }, new Date('2026-01-01T00:00:00Z'))
    const tick = scheduler.tick(new Date('2026-01-01T00:01:00Z'))
    await arrival
    scheduler.updateTask(task.id, { schedule: { kind: 'interval', everySeconds: 60, startAt: '2026-01-01T00:01:00Z' } },
      undefined, new Date('2026-01-01T00:00:59Z'))
    release()
    await tick
    assert.equal(scheduler.getTask(task.id)!.enabled, true)
    assert.equal(scheduler.getTask(task.id)!.nextRunAt, '2026-01-01T00:02:00.000Z')
  } finally {
    release()
    await scheduler.dispose()
  }
})

test('enforces wake receiver text and id limits', async () => {
  const scheduler = new TaskScheduler({ path: ':memory:', registry: new Registry(), autoStart: false })
  try {
    const base = {
      ownerSessionId: 'owner', creatorName: 'owner',
      schedule: { kind: 'once' as const, at: '2099-01-01T00:00:00Z' },
    }
    assert.throws(() => scheduler.createTask({ ...base, title: 'x'.repeat(201), prompt: 'ok' }), /at most 200/)
    assert.throws(() => scheduler.createTask({ ...base, title: 'ok', prompt: 'x'.repeat(20_001) }), /at most 20000/)
    assert.throws(() => scheduler.createTask({ ...base, ownerSessionId: 'x'.repeat(201), title: 'ok', prompt: 'ok' }), /at most 200/)
  } finally {
    await scheduler.dispose()
  }
})

test('persists tasks and pending run ids, retries offline owners, and keeps ownership fixed', async () => {
  const path = await schedulerPath()
  const registry = new Registry()
  register(registry, 'owner-a', 1, 'Owner A')
  register(registry, 'owner-b', 2, 'Owner B')
  registry.findBySessionId('owner-a')!.status = 'offline'
  const first = new TaskScheduler({ path, registry, autoStart: false, retryMs: 1_000 })
  const task = first.createTask({
    ownerSessionId: 'owner-a', creatorName: 'Owner A', title: 'persist', prompt: 'wake',
    schedule: { kind: 'once', at: '2026-01-01T00:00:00Z' },
  }, new Date('2025-12-31T23:59:00Z'))
  await first.tick(new Date('2026-01-01T00:00:00Z'))
  const pending = first.listRuns(task.id)![0]
  assert.equal(pending.status, 'pending')
  assert.equal(first.getTask(task.id)!.lastOutcome, 'retrying')
  assert.equal(first.getTask(task.id, 'owner-b'), null)
  first.updateTask(task.id, { title: 'renamed', ownerSessionId: 'owner-b' } as never)
  assert.equal(first.getTask(task.id)!.ownerSessionId, 'owner-a')
  await first.dispose()

  registry.findBySessionId('owner-a')!.status = 'online'
  const second = new TaskScheduler({
    path, registry, autoStart: false, retryMs: 1_000,
    fetchFn: async () => new Response('{"accepted":true}', {
      status: 200, headers: { 'Content-Type': 'application/json' },
    }),
  })
  assert.equal(second.getTask(task.id)!.title, 'renamed')
  assert.equal(second.listRuns(task.id)![0].id, pending.id)
  await second.tick(new Date('2026-01-01T00:00:00.500Z'))
  assert.equal(second.listRuns(task.id)![0].id, pending.id)
  assert.equal(second.listRuns(task.id)![0].status, 'pending')
  await second.tick(new Date('2026-01-01T00:00:01.000Z'))
  assert.equal(second.listRuns(task.id)![0].id, pending.id)
  assert.equal(second.listRuns(task.id)![0].status, 'delivered')
  await second.dispose()
})

test('delivers due runs once, coalesces missed intervals, and records manual history independently', async () => {
  const received: Array<Record<string, unknown>> = []
  const receiver = createServer((req, res) => {
    let body = ''
    req.on('data', chunk => { body += chunk })
    req.on('end', () => {
      received.push(JSON.parse(body))
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end('{"accepted":true}')
    })
  })
  await new Promise<void>(resolve => receiver.listen(0, '127.0.0.1', resolve))
  const port = (receiver.address() as AddressInfo).port
  const registry = new Registry()
  register(registry, 'owner', port)
  const scheduler = new TaskScheduler({ path: ':memory:', registry, autoStart: false })
  try {
    const once = scheduler.createTask({
      ownerSessionId: 'owner', creatorName: 'owner', title: 'once', prompt: 'once prompt',
      schedule: { kind: 'once', at: '2026-01-01T00:00:00Z' },
    }, new Date('2025-12-31T23:59:00Z'))
    await Promise.all([
      scheduler.tick(new Date('2026-01-01T00:00:00Z')),
      scheduler.tick(new Date('2026-01-01T00:00:00Z')),
    ])
    assert.equal(received.length, 1)
    assert.equal(scheduler.getTask(once.id)!.enabled, false)
    assert.equal(scheduler.listRuns(once.id)![0].status, 'delivered')

    const interval = scheduler.createTask({
      ownerSessionId: 'owner', creatorName: 'owner', title: 'interval', prompt: 'interval prompt',
      schedule: { kind: 'interval', everySeconds: 60, startAt: '2026-01-01T00:01:00Z' },
    }, new Date('2026-01-01T00:00:00Z'))
    await scheduler.tick(new Date('2026-01-01T00:10:30Z'))
    assert.equal(scheduler.getTask(interval.id)!.nextRunAt, '2026-01-01T00:11:00.000Z')
    const scheduledNext = scheduler.getTask(interval.id)!.nextRunAt
    const manual = await scheduler.runTaskNow(interval.id, undefined, new Date('2026-01-01T00:10:40Z'))
    assert.equal(manual!.trigger, 'manual')
    assert.equal(manual!.status, 'delivered')
    assert.equal(scheduler.getTask(interval.id)!.lastOutcome, 'delivered')
    assert.equal(scheduler.getTask(interval.id)!.nextRunAt, scheduledNext)
    assert.equal(scheduler.listRuns(interval.id)!.length, 2)
  } finally {
    await scheduler.dispose()
    await new Promise<void>(resolve => receiver.close(() => resolve()))
  }
})

test('pause and delete win over an in-flight delivery', async () => {
  const releases: Array<() => void> = []
  const arrivals: Array<Promise<void>> = []
  const receiver = createServer((_req, res) => {
    let arrived!: () => void
    arrivals.push(new Promise<void>(resolve => { arrived = resolve }))
    arrived()
    releases.push(() => {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end('{"accepted":true}')
    })
  })
  await new Promise<void>(resolve => receiver.listen(0, '127.0.0.1', resolve))
  const registry = new Registry()
  register(registry, 'owner', (receiver.address() as AddressInfo).port)
  const scheduler = new TaskScheduler({ path: ':memory:', registry, autoStart: false })
  const make = (title: string) => scheduler.createTask({
    ownerSessionId: 'owner', creatorName: 'owner', title, prompt: title,
    schedule: { kind: 'interval', everySeconds: 60, startAt: '2026-01-01T00:00:00Z' },
  }, new Date('2025-12-31T23:59:00Z'))
  try {
    const paused = make('paused')
    const pauseTick = scheduler.tick(new Date('2026-01-01T00:00:00Z'))
    while (releases.length < 1) await new Promise(resolve => setImmediate(resolve))
    scheduler.updateTask(paused.id, { enabled: false }, undefined, new Date('2026-01-01T00:00:00Z'))
    releases.shift()!()
    await pauseTick
    assert.equal(scheduler.getTask(paused.id)!.enabled, false)
    assert.equal(scheduler.getTask(paused.id)!.nextRunAt, null)

    const deleted = make('deleted')
    const deleteTick = scheduler.tick(new Date('2026-01-01T00:00:00Z'))
    while (releases.length < 1) await new Promise(resolve => setImmediate(resolve))
    assert.equal(scheduler.deleteTask(deleted.id), true)
    releases.shift()!()
    await deleteTick
    assert.equal(scheduler.getTask(deleted.id), null)
  } finally {
    await scheduler.dispose()
    await new Promise<void>(resolve => receiver.close(() => resolve()))
  }
})

test('scheduled task API validates creators and filters assistant-owned access', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'scheduler-api-test-'))
  const wakes: Array<Record<string, unknown>> = []
  const receiver = createServer((req, res) => {
    let body = ''
    req.on('data', chunk => { body += chunk })
    req.on('end', () => {
      wakes.push(JSON.parse(body))
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end('{"accepted":true}')
    })
  })
  await new Promise<void>(resolve => receiver.listen(0, '127.0.0.1', resolve))
  const registry = new Registry()
  register(registry, 'owner-a', (receiver.address() as AddressInfo).port, 'Owner A')
  register(registry, 'owner-b', 2, 'Owner B')
  const { auth } = await ApiKeyAuth.load(join(directory, 'api-key.json'), { initialKey: 'test-key' })
  const consoleServer = await createConsoleServer(
    registry,
    new ConfigCenter(await loadConfig()),
    new KnowledgeCenter(new KnowledgeStore(join(directory, 'knowledge'))),
    auth,
    { host: '127.0.0.1', port: 0, schedulerTickMs: 60_000 },
    async () => {},
  )
  const port = (consoleServer.server.address() as AddressInfo).port
  const call = (path: string, init?: RequestInit) => fetch(`http://127.0.0.1:${port}${path}`, init)
  try {
    const missing = await call('/api/scheduled-tasks', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ creatorSessionId: 'missing', title: 'x', prompt: 'x', schedule: { kind: 'once', at: '2099-01-01T00:00:00Z' } }),
    })
    assert.equal(missing.status, 404)
    const createdResponse = await call('/api/scheduled-tasks', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ creatorSessionId: 'owner-a', title: 'x', prompt: 'x', schedule: { kind: 'once', at: '2099-01-01T00:00:00Z' } }),
    })
    assert.equal(createdResponse.status, 201)
    const created = await createdResponse.json() as { id: string; ownerSessionId: string; creatorName: string }
    assert.equal(created.ownerSessionId, 'owner-a')
    assert.equal(created.creatorName, 'Owner A')
    assert.equal((await call('/api/scheduled-tasks?creatorSessionId=owner-b').then(r => r.json()) as { count: number }).count, 0)
    assert.equal((await call(`/api/scheduled-tasks/${created.id}?creatorSessionId=owner-b`)).status, 404)
    assert.equal((await call('/api/scheduled-tasks').then(r => r.json()) as { count: number }).count, 1)
    const runResponse = await call(`/api/scheduled-tasks/${created.id}/run?creatorSessionId=owner-a`, { method: 'POST' })
    assert.equal(runResponse.status, 202)
    const run = await runResponse.json() as { id: string; status: string }
    assert.equal(run.status, 'delivered')
    assert.equal(wakes.length, 1)
    assert.deepEqual(wakes[0], {
      sessionId: 'owner-a', taskId: created.id, runId: run.id,
      title: 'x', prompt: 'x', scheduledAt: wakes[0].scheduledAt,
      task: {
        id: created.id,
        ownerSessionId: 'owner-a',
        creatorName: 'Owner A',
        title: 'x',
        prompt: 'x',
        schedule: { kind: 'once', at: '2099-01-01T00:00:00.000Z' },
        enabled: true,
        nextRunAt: '2099-01-01T00:00:00.000Z',
        lastOutcome: null,
        lastError: null,
        createdAt: wakes[0].task && (wakes[0].task as { createdAt: string }).createdAt,
        updatedAt: wakes[0].task && (wakes[0].task as { updatedAt: string }).updatedAt,
        completedAt: null,
      },
      run: {
        id: run.id,
        trigger: 'manual',
        scheduledAt: wakes[0].scheduledAt,
        triggeredAt: wakes[0].run && (wakes[0].run as { triggeredAt: string }).triggeredAt,
      },
    })
  } finally {
    await consoleServer.dispose()
    await new Promise<void>(resolve => receiver.close(() => resolve()))
  }
})

test('delivers the original task snapshot after retry, edits, and a pause', async () => {
  const registry = new Registry()
  register(registry, 'owner', 1, 'Original Creator')
  const deliveries: Array<Record<string, unknown>> = []
  let attempts = 0
  const scheduler = new TaskScheduler({
    path: ':memory:', registry, autoStart: false, retryMs: 1_000,
    fetchFn: async (_url, init) => {
      deliveries.push(JSON.parse(String(init?.body)))
      attempts += 1
      return attempts === 1
        ? new Response('{"accepted":false}', { status: 503, headers: { 'Content-Type': 'application/json' } })
        : new Response('{"accepted":true}', { headers: { 'Content-Type': 'application/json' } })
    },
  })
  try {
    const task = scheduler.createTask({
      ownerSessionId: 'owner', creatorName: 'Original Creator', title: 'original', prompt: 'original prompt',
      schedule: { kind: 'once', at: '2026-01-01T00:00:00Z' },
    }, new Date('2025-12-31T23:59:00Z'))
    await scheduler.tick(new Date('2026-01-01T00:00:00Z'))
    const retry = scheduler.listRuns(task.id)![0]
    assert.equal(retry.taskSnapshot!.creatorName, 'Original Creator')
    assert.equal(retry.taskSnapshot!.title, 'original')

    scheduler.updateTask(task.id, { title: 'edited', prompt: 'edited prompt', enabled: false }, undefined,
      new Date('2026-01-01T00:00:00.100Z'))
    scheduler.updateTask(task.id, { enabled: true }, undefined, new Date('2026-01-01T00:00:00.200Z'))
    await scheduler.tick(new Date('2026-01-01T00:00:01Z'))

    assert.equal(deliveries.length, 2)
    const delivered = deliveries[1]
    assert.equal(delivered.title, 'original')
    assert.equal(delivered.prompt, 'original prompt')
    assert.deepEqual(delivered.task, retry.taskSnapshot)
    assert.deepEqual(delivered.run, {
      id: retry.id, trigger: 'scheduled', scheduledAt: retry.scheduledAt, triggeredAt: retry.createdAt,
    })
    assert.equal(scheduler.getTask(task.id)!.title, 'edited')
  } finally {
    await scheduler.dispose()
  }
})

test('migrates legacy run tables without losing runs and backfills their delivery snapshot', async () => {
  const path = await schedulerPath()
  const database = new DatabaseSync(path)
  database.exec(`
    CREATE TABLE tasks (
      id TEXT PRIMARY KEY, owner_session_id TEXT NOT NULL, creator_name TEXT NOT NULL, title TEXT NOT NULL,
      prompt TEXT NOT NULL, schedule_json TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1, next_run_at TEXT,
      last_outcome TEXT, last_error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, completed_at TEXT
    );
    CREATE TABLE runs (
      id TEXT PRIMARY KEY, task_id TEXT NOT NULL, trigger TEXT NOT NULL, scheduled_at TEXT NOT NULL,
      status TEXT NOT NULL, attempt_count INTEGER NOT NULL DEFAULT 0, last_attempt_at TEXT,
      next_attempt_at TEXT NOT NULL, delivered_at TEXT, last_error TEXT, created_at TEXT NOT NULL
    );
  `)
  database.prepare(`INSERT INTO tasks VALUES (?, ?, ?, ?, ?, ?, 1, ?, NULL, NULL, ?, ?, NULL)`).run(
    'legacy-task', 'owner', 'Legacy Creator', 'legacy title', 'legacy prompt',
    JSON.stringify({ kind: 'once', at: '2026-01-01T00:00:00Z' }), '2026-01-01T00:00:00.000Z',
    '2025-12-31T23:00:00.000Z', '2025-12-31T23:00:00.000Z',
  )
  database.prepare(`INSERT INTO runs VALUES (?, ?, 'scheduled', ?, 'pending', 0, NULL, ?, NULL, NULL, ?)`).run(
    'legacy-run', 'legacy-task', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z',
  )
  database.close()

  const registry = new Registry()
  register(registry, 'owner')
  const deliveries: Array<Record<string, unknown>> = []
  const scheduler = new TaskScheduler({ path, registry, autoStart: false, fetchFn: async (_url, init) => {
    deliveries.push(JSON.parse(String(init?.body)))
    return new Response('{"accepted":true}', { headers: { 'Content-Type': 'application/json' } })
  } })
  try {
    assert.equal(scheduler.listRuns('legacy-task')!.length, 1)
    assert.equal(scheduler.listRuns('legacy-task')![0].taskSnapshot, null)
    await scheduler.tick(new Date('2026-01-01T00:00:00Z'))
    const run = scheduler.listRuns('legacy-task')![0]
    assert.equal(run.status, 'delivered')
    assert.equal(run.taskSnapshot!.creatorName, 'Legacy Creator')
    assert.equal(deliveries[0].task && (deliveries[0].task as { title: string }).title, 'legacy title')
  } finally {
    await scheduler.dispose()
  }
})
