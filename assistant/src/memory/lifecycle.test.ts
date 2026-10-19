import assert from 'node:assert/strict'
import { readdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { type Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { BasicCompactionEngine } from '@deepseek-ai/dsh-compaction-basic'
import LlmRuntime, {
  createAssistantMessage,
  createUserMessage,
  type GenerateOptions,
  LlmAdapter,
  type LlmResolvedModelInfo,
  type StreamChunk,
} from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import ToolRuntime from '@deepseek-ai/dsh-tools'

import { installCompactionHook } from './compaction.js'
import { bindAgent, flushCompactionFlows, isCompacting } from './gate.js'
import { ScheduledWakeService, type ScheduledWake } from '../scheduler/wake.js'
import { getMemory, listMemories, setMemoriesDir } from './store.js'
import {
  appendTranscript,
  installTranscriptRecorder,
  readTranscriptRange,
  setTranscriptDir,
} from './transcript.js'

const COLD_PROVIDER = 'memory-cold'
const HOT_PROVIDER = 'memory-hot'
const SIGNAL = new AbortController().signal
const LONG_HISTORY = '项目历史上下文 '.repeat(120)

function messageText(options: GenerateOptions): string {
  return options.messages.flatMap(message => message.content)
    .filter(block => block.type === 'text')
    .map(block => block.text)
    .join('\n')
}

/** No-network adapter used by both the agent turn and memory extraction. */
class MemoryAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []
  failExtraction = false

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({
      provider,
      id: model,
      name: model,
      context: { contextWindow: 100_000 },
    })
  }

  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    const extraction = messageText(options).includes('你是记忆提取器')
    if (extraction && this.failExtraction) throw new Error('mock extraction unavailable')
    const text = extraction
      ? JSON.stringify([{
          title: '包管理偏好',
          content: '用户要求项目统一使用 pnpm。',
          tags: ['偏好', 'pnpm'],
        }])
      : '收到，我会在这个项目里使用 pnpm。'
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

/** Native compaction transaction with a deterministic summary and no summary-model call. */
class DeterministicCompactionEngine extends BasicCompactionEngine {
  protected override summarize(
    _input: unknown,
    _agent: Agent,
    _signal?: AbortSignal,
  ): Promise<{
      summary: Array<{ type: 'text'; text: string }>
      provider: string
      model: string
    }> {
    return Promise.resolve({
      summary: [{ type: 'text', text: '用户要求本项目统一使用 pnpm，助手已确认。' }],
      provider: 'summary-mock',
      model: 'summary-mock',
    })
  }
}

interface Harness {
  ctx: Context
  agent: Agent
  compact: DeterministicCompactionEngine
  adapter: MemoryAdapter
  root: string
  memoryDir: string
  transcriptDir: string
  selectModel(provider: string, model: string): void
}

async function createHarness(name: string): Promise<Harness> {
  await flushCompactionFlows()
  const root = await mkdtemp(join(tmpdir(), `assistant-memory-${name}-`))
  const memoryDir = join(root, 'memories')
  const transcriptDir = join(root, 'transcript')
  const persistenceRoot = join(root, 'sessions')
  setMemoriesDir(memoryDir)
  setTranscriptDir(transcriptDir)

  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(JsonlSessionPersistence, { root: persistenceRoot })
  await ctx.plugin(TokenMeter)

  const adapter = new MemoryAdapter()
  ctx.llm.registerAdapter([COLD_PROVIDER, HOT_PROVIDER], adapter)
  let selection = { provider: COLD_PROVIDER, model: 'cold-model' }
  ctx.provide('assistantConfig', { currentModel: () => selection })

  const agent = ctx.agentLoop.create(SessionId(`memory-${name}`), selection)
  installTranscriptRecorder(ctx, String(agent.session.id), agent.session)
  installCompactionHook(ctx, String(agent.session.id), agent)
  const compact = new DeterministicCompactionEngine(ctx, { auto: false })

  return {
    ctx,
    agent,
    compact,
    adapter,
    root,
    memoryDir,
    transcriptDir,
    selectModel(provider, model) { selection = { provider, model } },
  }
}

async function destroyHarness(harness: Harness): Promise<void> {
  await flushCompactionFlows()
  await harness.ctx.fiber.dispose()
  await rm(harness.root, { recursive: true, force: true })
}

function send(agent: Agent, text: string): void {
  agent.followup(createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  }))
}

test('native model request and memory transcript retain scheduler system-event provenance', async () => {
  const harness = await createHarness('scheduled-system-event')
  bindAgent(harness.agent)
  const service = await ScheduledWakeService.create(harness.agent, harness.root)
  const scheduledAt = '2026-10-11T09:00:00+08:00'
  const wake: ScheduledWake = {
    sessionId: String(harness.agent.session.id), taskId: 'task-system', runId: 'run-system',
    title: '检查部署', prompt: '检查 pnpm 部署约定', scheduledAt,
    task: {
      id: 'task-system', ownerSessionId: String(harness.agent.session.id), creatorName: '测试助手',
      title: '检查部署', prompt: '检查 pnpm 部署约定', schedule: { kind: 'daily', time: '09:00', timezone: 'Asia/Shanghai' },
      enabled: true, nextRunAt: scheduledAt, lastOutcome: null, lastError: null,
      createdAt: '2026-10-10T09:00:00+08:00', updatedAt: '2026-10-10T09:00:00+08:00', completedAt: null,
    },
    run: { id: 'run-system', trigger: 'scheduled', scheduledAt, triggeredAt: '2026-10-11T09:00:02+08:00' },
  }
  try {
    await service.accept(wake)
    await harness.agent.whenIdle()
    await harness.ctx.sessions.flush(harness.agent.session)
    const input = harness.adapter.requests.flatMap(request => request.messages)
      .find(message => message.source.kind === 'system-event')
    assert.ok(input)
    const text = input.content.filter(block => block.type === 'text').map(block => block.text).join('\n')
    assert.match(text, /^\[系统事件：定时任务触发\]/)
    const notification = JSON.parse(text.slice(text.indexOf('\n{') + 1))
    assert.deepEqual(notification.task, wake.task)
    assert.deepEqual(notification.run, wake.run)
    const lines = await readTranscriptRange(0, harness.agent.session.events.length)
    assert.ok(lines.some(line => line.role === 'system-event' && line.text.includes(wake.prompt)))
    assert.ok(!lines.some(line => line.role === 'user' && line.text.includes(wake.prompt)))
  } finally {
    await service.dispose()
    await destroyHarness(harness)
  }
})

test('native compactNow persists summary and extracted preference with transcript provenance', async () => {
  const harness = await createHarness('success')
  try {
    const compactionEvents: string[] = []
    harness.ctx.on('session/event', (session, event) => {
      if (session === harness.agent.session && event.type.startsWith('compaction/')) {
        compactionEvents.push(event.type)
      }
    })

    send(harness.agent, `${LONG_HISTORY}请记住：这个项目统一使用 pnpm，不要使用 npm。`)
    await harness.agent.whenIdle()

    // The extraction route must be read at compaction time, after config hot-switching.
    harness.selectModel(HOT_PROVIDER, 'hot-model-v2')
    const result = await harness.compact.compactNow(harness.agent, SIGNAL)
    assert.ok(result)
    await flushCompactionFlows()

    assert.deepEqual(compactionEvents, [
      'compaction/start',
      'compaction/summary',
      'compaction/end',
    ])
    const metas = await listMemories()
    assert.equal(metas.length, 2)
    const memories = await Promise.all(metas.map(meta => getMemory(meta.id)))
    const summary = memories.find(memory => memory?.tags.includes('会话摘要'))
    const preference = memories.find(memory => memory?.title === '包管理偏好')
    assert.ok(summary)
    assert.match(summary.content, /统一使用 pnpm/)
    assert.equal(summary.sourceStartSeq, Math.min(...result.shadowedSeqs))
    assert.equal(summary.sourceEndSeq, Math.max(...result.shadowedSeqs))
    assert.ok(preference)
    assert.equal(preference.sourceStartSeq, summary.sourceStartSeq)
    assert.equal(preference.sourceEndSeq, summary.sourceEndSeq)

    const source = await readTranscriptRange(summary.sourceStartSeq!, summary.sourceEndSeq!)
    assert.ok(source.some(line => line.role === 'user' && line.text.includes('不要使用 npm')))

    const extraction = harness.adapter.requests.find(request =>
      messageText(request).includes('你是记忆提取器'))
    assert.ok(extraction)
    assert.equal(extraction.provider, HOT_PROVIDER)
    assert.equal(extraction.model, 'hot-model-v2')
    assert.match(messageText(extraction), /不要使用 npm/)
    assert.equal((await readdir(harness.memoryDir)).filter(file => file.endsWith('.md')).length, 2)
  } finally {
    await destroyHarness(harness)
  }
})

test('extraction failure preserves summary and releases the compaction gate', async () => {
  const harness = await createHarness('failure')
  try {
    send(harness.agent, `${LONG_HISTORY}偏好使用 pnpm。`)
    await harness.agent.whenIdle()
    harness.adapter.failExtraction = true

    const result = await harness.compact.compactNow(harness.agent, SIGNAL)
    assert.ok(result)
    await flushCompactionFlows()

    assert.equal(isCompacting(), false)
    const metas = await listMemories()
    assert.equal(metas.length, 1)
    const summary = await getMemory(metas[0]!.id)
    assert.ok(summary)
    assert.ok(summary.tags.includes('会话摘要'))
    assert.match(summary.content, /统一使用 pnpm/)

    // Admission still works after the failed optional extraction.
    send(harness.agent, '压缩后继续')
    await harness.agent.whenIdle()
    assert.equal(harness.agent.status, 'idle')
  } finally {
    await destroyHarness(harness)
  }
})

test('restored transcript backfill deduplicates history and immediate reads await queued writes', async () => {
  await flushCompactionFlows()
  const root = await mkdtemp(join(tmpdir(), 'assistant-memory-transcript-'))
  const transcriptDir = join(root, 'transcript')
  setTranscriptDir(transcriptDir)
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  try {
    const session = ctx.sessions.create(SessionId('restored-transcript'))
    const first = session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'already durable' }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    const second = session.append('assistant/message', {
      turn: 1,
      step: 1,
      message: createAssistantMessage({
        content: [{ type: 'text', text: 'missing historical answer' }],
        source: { provider: COLD_PROVIDER, model: 'cold-model' },
      }),
    }, { surfaceOp: 'append' })

    await appendTranscript({ seq: first.seq, role: 'user', text: 'already durable' })
    installTranscriptRecorder(ctx, String(session.id), session)
    const live = session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'live immediately after restore' }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })

    // No timing yield: this read exercises the recorder's write-chain barrier.
    const lines = await readTranscriptRange(first.seq, live.seq)
    assert.deepEqual(lines.map(line => [line.seq, line.text]), [
      [first.seq, 'already durable'],
      [second.seq, 'missing historical answer'],
      [live.seq, 'live immediately after restore'],
    ])
    assert.equal(lines.filter(line => line.seq === first.seq).length, 1)
  } finally {
    await ctx.fiber.dispose()
    await rm(root, { recursive: true, force: true })
  }
})
