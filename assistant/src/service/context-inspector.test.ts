import assert from 'node:assert/strict'
import test from 'node:test'

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'

import {
  collectContextSnapshot,
  readContextNode,
  type ContextSnapshot,
} from './context-inspector.js'

function event(type: string, seq: number, data: Record<string, unknown>) {
  return { type, seq, time: 1_000 + seq, data }
}

function text(value: string) {
  return [{ type: 'text', text: value }]
}

const HEADER = {
  config: { provider: 'deepseek', model: 'deepseek-v4', maxTokens: 8_192 },
  system: '你是一个测试助手。',
  tools: [
    { name: 'bash', description: '运行命令', parameters: { type: 'object', properties: { command: { type: 'string' } } } },
    { name: 'read', description: '读取文件', parameters: { type: 'object', properties: { path: { type: 'string' } } } },
  ],
}

let seq = 0
const events = [
  event('request/header', ++seq, { header: HEADER }),
  event('user/message', ++seq, { turn: 1, source: { kind: 'user' }, content: text('你好') }),
  event('assistant/message', ++seq, {
    turn: 1,
    step: 1,
    message: {
      role: 'assistant',
      content: [
        { type: 'reasoning', text: '先想一想。' },
        { type: 'text', text: '你好，有什么可以帮忙的？' },
        { type: 'tool-call', id: 'call_1', name: 'bash', arguments: '{"command":"ls"}' },
      ],
    },
  }),
  event('tool/call', ++seq, { turn: 1, step: 1, callId: 'call_1', name: 'bash', arguments: '{"command":"ls"}' }),
  event('tool/result', ++seq, {
    turn: 1,
    step: 1,
    message: {
      source: { kind: 'tool', callId: 'call_1' },
      content: [{ type: 'tool-result', content: text('a.txt\nb.txt') }],
    },
  }),
  event('user/message', ++seq, {
    turn: 1,
    source: { kind: 'plugin', plugin: 'memory-recall', form: 'snapshot' },
    content: text('[相关记忆] 用户偏好 pnpm。'),
  }),
  event('assistant/message', ++seq, {
    turn: 1,
    step: 2,
    usage: { inputTokens: 100, cacheReadTokens: 50, outputTokens: 20 },
    message: { role: 'assistant', content: text('收到。') },
  }),
  event('compaction/summary', ++seq, { shadowedSeqs: [2, 3], shadowedTokenCount: 500, message: { role: 'user', content: text('摘要内容') } }),
  event('plan/mode', ++seq, { active: true }),
  event('tool/call', ++seq, { turn: 1, step: 3, callId: 'call_read', name: 'read', arguments: '{"file_path":"/tmp/a.ts"}' }),
  event('tool/call', ++seq, { turn: 1, step: 3, callId: 'call_edit', name: 'edit', arguments: '{"file_path":"/tmp/a.ts","old_string":"a\\nb","new_string":"a\\nb\\nc"}' }),
  event('tool/call', ++seq, { turn: 1, step: 3, callId: 'call_grep', name: 'grep', arguments: '{"pattern":"foo","path":"/tmp"}' }),
  event('tool/call', ++seq, { turn: 1, step: 3, callId: 'call_image', name: 'read_image', arguments: '{"file_path":"/tmp/x.png"}' }),
  event('request/header', ++seq, {
    header: { ...HEADER, config: { provider: 'anthropic', model: 'claude', maxTokens: 4_096 } },
  }),
]

const measurement = {
  totalTokens: 1_000,
  surfaceTokens: 95,
  nodes: [
    { seq: 2, tokens: 5 },
    { seq: 3, tokens: 30 },
    { seq: 5, tokens: 8 },
    { seq: 6, tokens: 12 },
    { seq: 7, tokens: 40 },
  ],
}

const projections = {
  contextPressure: { contextWindow: 128_000 },
  contextBreakdown: { systemTokens: 200, toolsTokens: 300, messageTokens: 95 },
  tokenUsage: { uncachedInputTokens: 100, cacheReadTokens: 50, cacheWriteTokens: 0, outputTokens: 20 },
  sessionStats: { turns: 2, steps: 3, llmMs: 1_200, toolMs: 300, ttftMs: 100, ttftSteps: 1, decodeMs: 800, decodeTokens: 40 },
}

function fakeContext(): Context {
  return {
    tokenMeter: { measure: () => measurement },
    sessionProjections: { snapshot: () => ({ values: projections }) },
  } as unknown as Context
}

function fakeAgent(): Agent {
  return {
    session: { events },
    options: { provider: 'deepseek', model: 'deepseek-v4' },
  } as unknown as Agent
}

test('context snapshot groups the current surface and projects request history', () => {
  const ctx = fakeContext()
  const agent = fakeAgent()
  const snapshot = collectContextSnapshot(ctx, agent)

  assert.equal(snapshot.eventCount, events.length)
  assert.equal(snapshot.model.provider, 'anthropic')
  assert.equal(snapshot.model.model, 'claude')
  assert.equal(snapshot.model.contextWindow, 128_000)
  assert.equal(snapshot.occupancy.usedTokens, 1_000)
  assert.equal(snapshot.occupancy.remainingTokens, 127_000)

  const group = (key: string) => snapshot.groups.find(item => item.key === key)!
  assert.equal(group('system').items.length, 1)
  assert.equal(group('system').tokens, 200)
  assert.equal(group('system').items[0]!.id, 'system')
  assert.equal(group('tools').items.length, 2)
  assert.equal(group('tools').tokens, 300)
  assert.equal(group('tools').items.reduce((sum, item) => sum + item.tokens, 0), 300)

  assert.equal(group('user').items.length, 1)
  assert.equal(group('user').items[0]!.tokens, 5)
  assert.equal(group('assistant').items.length, 2)
  assert.equal(group('assistant').tokens, 70)
  assert.equal(group('inject').items.length, 1)
  assert.equal(group('tool').items.length, 1)
  assert.match(group('tool').items[0]!.title, /bash/)

  assert.equal(snapshot.current.total, 1_000)
  assert.equal(snapshot.current.system, 200)
  assert.equal(snapshot.current.tools, 300)
  assert.equal(snapshot.current.user, 5)

  assert.equal(snapshot.stats.turns, 2)
  assert.equal(snapshot.stats.steps, 3)
  assert.equal(snapshot.stats.humanInputs, 1)
  assert.equal(snapshot.stats.assistantMessages, 2)
  assert.equal(snapshot.stats.toolCalls, 1)
  assert.equal(snapshot.stats.toolResults, 1)
  assert.equal(snapshot.stats.compactions, 1)
  assert.equal(snapshot.stats.modelSwitches, 1)

  // 全量会话活动统计（含未进入当前 surface 的工具调用）
  assert.equal(snapshot.usage.userInputs, 1)
  assert.equal(snapshot.usage.assistantReplies, 2)
  assert.equal(snapshot.usage.toolCalls, 5)
  assert.equal(snapshot.usage.reads, 2)
  assert.equal(snapshot.usage.writes, 1)
  assert.equal(snapshot.usage.searches, 1)
  assert.equal(snapshot.usage.images, 1)
  assert.equal(snapshot.usage.toolCallsByTool[0]!.count >= 1, true)

  // 助手特色分类
  assert.equal(group('inject').items[0]!.feature, 'memory')
  assert.equal(snapshot.features.memory, 1)
  assert.equal(snapshot.eventCounts.inject, 1)
  const injectEvent = snapshot.events.find(item => item.kind === 'inject')!
  assert.equal(injectEvent.feature, 'memory')
  assert.equal(injectEvent.itemId, 'evt:6')

  // 耗时统计
  assert.equal(snapshot.timing.activeMs, 1_500)
  assert.equal(snapshot.timing.tokensPerSecond, 50)
  assert.equal(snapshot.timing.avgTtftMs, 100)

  // 文件活动：读取 + 编辑同一文件，另外一次读图
  const fileA = snapshot.files.find(file => file.path === '/tmp/a.ts')!
  assert.equal(fileA.reads, 1)
  assert.equal(fileA.writes, 1)
  assert.equal(fileA.added, 3)
  assert.equal(fileA.removed, 2)
  const fileImage = snapshot.files.find(file => file.path === '/tmp/x.png')!
  assert.equal(fileImage.images, 1)

  // 一次真实 usage 的请求：prompt = input + cacheRead + cacheWrite
  assert.equal(snapshot.requests.length, 1)
  assert.equal(snapshot.requests[0]!.prompt, 150)
  assert.equal(snapshot.requests[0]!.output, 20)
  assert.equal(snapshot.requests[0]!.userText, '你好')
  assert.equal(snapshot.requests[0]!.assistantText, '收到。')

  const kinds = snapshot.events.map(item => item.kind)
  assert.ok(kinds.includes('compaction'))
  assert.ok(kinds.includes('model'))
  assert.ok(kinds.includes('mode'))
})

test('context snapshot is cached until the session log grows', () => {
  const ctx = fakeContext()
  const agent = fakeAgent()
  const first = collectContextSnapshot(ctx, agent)
  const second = collectContextSnapshot(ctx, agent)
  assert.strictEqual(first, second)
})

test('context node detail returns full content for system, tool schema and events', () => {
  const ctx = fakeContext()
  const agent = fakeAgent()

  const system = readContextNode(ctx, agent, 'system') as any
  assert.equal(system.kind, 'system')
  assert.equal(system.text, HEADER.system)
  assert.equal(system.tokens, 200)

  const tool = readContextNode(ctx, agent, 'tool-schema:bash') as any
  assert.equal(tool.kind, 'tool-schema')
  assert.match(tool.text, /"name": "bash"/)
  assert.match(tool.text, /"command"/)

  const toolResult = readContextNode(ctx, agent, 'evt:5') as any
  assert.equal(toolResult.kind, 'tool')
  assert.match(toolResult.text, /工具结果 · bash/)
  assert.match(toolResult.text, /a\.txt/)
  assert.equal(toolResult.tokens, 8)

  const assistant = readContextNode(ctx, agent, 'evt:3') as any
  assert.equal(assistant.kind, 'assistant')
  assert.match(assistant.text, /思考/)
  assert.match(assistant.text, /调用 bash/)

  assert.equal(readContextNode(ctx, agent, 'evt:999'), null)
  assert.equal(readContextNode(ctx, agent, 'unknown'), null)
})

test('empty session yields a usable empty snapshot', () => {
  const ctx = {
    tokenMeter: { measure: () => ({ totalTokens: 0, surfaceTokens: 0, nodes: [] }) },
    sessionProjections: { snapshot: () => ({ values: {} }) },
  } as unknown as Context
  const agent = { session: { events: [] }, options: {} } as unknown as Agent
  const snapshot: ContextSnapshot = collectContextSnapshot(ctx, agent)
  assert.equal(snapshot.eventCount, 0)
  assert.equal(snapshot.model.provider, 'unknown')
  assert.equal(snapshot.groups.length, 7)
  assert.equal(snapshot.groups.every(group => group.items.length === 0), true)
  assert.equal(snapshot.current.total, 0)
  assert.equal(snapshot.requests.length, 0)
})
