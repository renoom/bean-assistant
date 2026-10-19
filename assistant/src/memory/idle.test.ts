import assert from 'node:assert/strict'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { installIdleCompaction } from './idle.js'
import { inject } from '../plugin.js'

type FakeAgent = { id: string; status: 'idle' | 'running' }

function flush(): Promise<void> {
  return new Promise(resolve => setImmediate(resolve))
}

async function harness(t: test.TestContext, compactNow: (signal: AbortSignal) => Promise<any>, status: FakeAgent['status'] = 'idle') {
  const ctx = new Context()
  const agent: FakeAgent = { id: 'main', status }
  const provider = {
    name: 'idle-test-compaction-provider',
    apply(providerCtx: Context) {
      providerCtx.provide('compaction', { compactNow: (_agent: unknown, signal: AbortSignal) => compactNow(signal) } as any)
    },
  }
  let controller: ReturnType<typeof installIdleCompaction> | undefined
  const installer = {
    name: 'idle-test-installer',
    inject: ['compaction'],
    apply(installerCtx: Context) {
      controller = installIdleCompaction(installerCtx, 'main', agent as any, { idleMs: 10 })
    },
  }
  await ctx.plugin(provider).await()
  await ctx.plugin(installer).await()
  t.after(async () => { await ctx.fiber.dispose() })
  assert.ok(controller)
  return { ctx, agent, controller }
}

function status(ctx: Context, agent: FakeAgent, value: FakeAgent['status']): void {
  agent.status = value
  ;(ctx as any).emit('agent/status', { agent, status: value })
}

test('assistant plugin declares its idle compaction dependencies', () => {
  assert.ok(inject.includes('compaction'))
  assert.ok(inject.includes('llm'))
})

test('arms an initially idle agent, resets after running, and ignores other agents', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  let calls = 0
  const { ctx, agent, controller } = await harness(t, async () => { calls += 1; return { shadowedSeqs: [] } })
  assert.ok(controller.snapshot().nextRunAt !== null)
  ;(ctx as any).emit('agent/status', { agent: { id: 'other', status: 'idle' }, status: 'idle' })
  t.mock.timers.tick(9)
  assert.equal(calls, 0)
  status(ctx, agent, 'running')
  t.mock.timers.tick(20)
  assert.equal(calls, 0)
  status(ctx, agent, 'idle')
  t.mock.timers.tick(10)
  await flush()
  assert.equal(calls, 1)
  assert.equal(controller.snapshot().lastOutcome, 'compacted')
})

test('a skipped compaction does not repeatedly compact the same idle history', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  let calls = 0
  const { ctx, agent, controller } = await harness(t, async () => { calls += 1; return null })
  t.mock.timers.tick(10)
  await flush()
  t.mock.timers.tick(100)
  await flush()
  assert.equal(calls, 1)
  assert.equal(controller.snapshot().lastOutcome, 'skipped')
  assert.equal(controller.snapshot().nextRunAt, null)
})

test('preserves a new idle period that starts while maintenance is still settling', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  let calls = 0
  let release: (() => void) | undefined
  const pending = new Promise<{ shadowedSeqs: number[] }>(resolve => { release = () => resolve({ shadowedSeqs: [] }) })
  const { ctx, agent, controller } = await harness(t, async () => {
    calls += 1
    return calls === 1 ? pending : null
  })
  t.mock.timers.tick(10)
  await flush()
  assert.equal(controller.snapshot().running, true)
  status(ctx, agent, 'running')
  status(ctx, agent, 'idle')
  assert.equal(controller.snapshot().nextRunAt, null)
  release?.()
  await flush()
  assert.equal(controller.snapshot().running, false)
  assert.ok(controller.snapshot().nextRunAt !== null)
  t.mock.timers.tick(10)
  await flush()
  assert.equal(calls, 2)
})

test('retries failures only up to the configured limit and resets for a new idle period', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  let calls = 0
  const { ctx, agent, controller } = await harness(t, async () => { calls += 1; throw new Error('temporary failure') })
  for (let index = 0; index < 3; index += 1) {
    t.mock.timers.tick(10)
    await flush()
  }
  t.mock.timers.tick(100)
  await flush()
  assert.equal(calls, 3)
  assert.equal(controller.snapshot().lastOutcome, 'failed')
  status(ctx, agent, 'running')
  status(ctx, agent, 'idle')
  t.mock.timers.tick(10)
  await flush()
  assert.equal(calls, 4)
})

test('disposal cancels a timer and aborts an active maintenance request', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  let signal: AbortSignal | undefined
  const { ctx, agent, controller } = await harness(t, async current => {
    signal = current
    return await new Promise(() => {})
  })
  t.mock.timers.tick(10)
  await flush()
  assert.equal(controller.snapshot().running, true)
  await ctx.fiber.dispose()
  assert.equal(signal?.aborted, true)
  assert.equal(controller.snapshot().nextRunAt, null)
  assert.equal(controller.snapshot().lastOutcome, 'cancelled')
  assert.equal(controller.snapshot().running, false)
})
