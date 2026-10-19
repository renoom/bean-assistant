import assert from 'node:assert/strict'
import test from 'node:test'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { StageBridge } from './types.js'
import { CurrentStageManager } from './manager.js'

test('Stage starts empty and exposes capabilities only while a Stage is current', async () => {
  let contextText: (() => string) | undefined
  let contextDisposed = false
  let toolRegistered = 0
  let toolDisposed = 0
  const transitions: unknown[] = []
  const fakeAgent = {
    status: 'idle',
    ctx: {
      systemPrompt: {
        context(definition: { text: () => string }) {
          contextText = definition.text
          return () => { contextDisposed = true }
        },
      },
      tools: {
        register() {
          toolRegistered += 1
          return () => { toolDisposed += 1 }
        },
      },
    },
    session: {
      events: [],
      append(type: string, data: unknown) { transitions.push({ type, data }) },
    },
    whenIdle: async () => undefined,
    cancel: () => undefined,
  } as unknown as Agent

  const stages = new CurrentStageManager(fakeAgent)
  assert.deepEqual(stages.snapshot(), {
    id: 'empty', kind: 'empty', revision: 0, status: 'empty', participants: [], capabilities: [],
  })
  assert.match(contextText?.() ?? '', /EmptyStage/)
  assert.equal(toolRegistered, 1)

  const bridge: StageBridge = {
    id: 'ws:alice',
    stageId: 'vn:room-1',
    stageKind: 'vn',
    participant: { id: 'alice', role: 'assistant', name: 'Alice', online: true },
    capabilities: [{ name: 'say', description: '在场景中说话' }],
    execute: async () => ({ ok: true }),
  }
  const disconnect = stages.registerBridge(bridge)
  assert.equal(stages.snapshot().kind, 'empty', 'connecting a Bridge alone must not change Stage')

  const entered = await stages.enterBridge(bridge.id)
  assert.equal(entered.kind, 'changed')
  assert.equal(stages.snapshot().id, 'vn:room-1')
  assert.equal(stages.snapshot().status, 'active')
  assert.equal(toolRegistered, 1)
  assert.match(contextText?.() ?? '', /stageId: vn:room-1/)
  assert.match(contextText?.() ?? '', /say — 在场景中说话/)

  disconnect()
  assert.equal(stages.snapshot().status, 'suspended')
  assert.equal(stages.snapshot().kind, 'vn', 'transport loss must not silently switch Stage')

  const left = await stages.transition({ target: { type: 'empty' } })
  assert.equal(left.kind, 'changed')
  assert.equal(stages.snapshot().kind, 'empty')
  assert.equal(toolDisposed, 0)
  assert.equal(transitions.length, 0, 'plugin-owned Stage events must not poison dsh persistence')

  stages.dispose()
  assert.equal(contextDisposed, true)
  assert.equal(toolDisposed, 1)
})

test('selected environment survives restart without a stale callable bridge', async t => {
  const { mkdtemp, rm } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const root = await mkdtemp(join(tmpdir(), 'stage-restore-test-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  let text = () => ''
  let action: { execute: (args: unknown, ctx: unknown) => Promise<Record<string, unknown>> }
  const agent = {
    status: 'idle', session: { events: [] },
    ctx: {
      systemPrompt: { context(def: {text: () => string}) { text = def.text; return () => {} } },
      tools: { register(def: typeof action) { action = def; return () => {} } },
    },
  } as unknown as Agent
  const first = new CurrentStageManager(agent, { dataDir: root })
  const bridge: StageBridge = {
    id: 'test-bridge', stageId: 'town:one', stageKind: 'town', environment: { text: 'Client environment rules' },
    participant: { id: 'npc', role: 'assistant', online: true }, capabilities: [{ name: 'say' }],
    execute: async () => ({ ok: true }),
  }
  first.registerBridge(bridge)
  await first.enterBridge(bridge.id)
  const activeText = text()
  const revision = first.snapshot().revision
  await first.flush(); first.dispose()
  const restored = new CurrentStageManager(agent, { dataDir: root })
  await restored.restore()
  assert.equal(restored.snapshot().status, 'suspended')
  assert.equal(text(), activeText)
  const offline = await action!.execute({ action: 'execute', command: 'say' }, {})
  assert.equal(offline.ok, false)
  restored.registerBridge({ ...bridge })
  assert.equal(restored.snapshot().revision, revision)
  assert.equal(text(), activeText)
  assert.equal((await action!.execute({ action: 'execute', command: 'say' }, {})).ok, true)
  await restored.transition({ target: { type: 'empty' } })
  restored.dispose()
  const empty = new CurrentStageManager(agent, { dataDir: root })
  await empty.restore()
  assert.equal(empty.snapshot().kind, 'empty')
  empty.dispose()
})
