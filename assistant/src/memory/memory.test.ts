/**
 * 记忆系统核心逻辑单元测试
 *
 * 覆盖三个可脱离 dsh 运行时独立测试的模块:
 *   - store.ts: 溯源字段 (sourceStartSeq/sourceEndSeq/subagentRef) 的读写往返
 *   - transcript.ts: 原文 append + 按 seq 范围读取
 *   - gate.ts: 压缩门控 (压缩期间排队, 完成后 flush)
 *
 * 运行: npx tsx --test src/memory/memory.test.ts
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  setMemoriesDir,
  createMemory,
  getMemory,
  updateMemory,
  searchMemories,
} from './store.js'
import { setTranscriptDir, appendTranscript, readTranscriptRange } from './transcript.js'
import { bindAgent, enqueueOrFollowup, runCompactionFlow, isCompacting } from './gate.js'

/** 每 test 一个独立临时目录, 避免 module 单例串扰。 */
async function tempDir(prefix: string): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix))
}

// ── store: 溯源字段 ─────────────────────────────────────────────────────────

test('createMemory 写入并读回溯源字段', async () => {
  const dir = await tempDir('mem-store-')
  setMemoriesDir(dir)

  const mem = await createMemory('用户偏好', '用 pnpm 管理依赖', ['偏好'], {
    sourceStartSeq: 10,
    sourceEndSeq: 20,
    subagentRef: 'subagent-xyz',
  })

  assert.equal(mem.sourceStartSeq, 10)
  assert.equal(mem.sourceEndSeq, 20)
  assert.equal(mem.subagentRef, 'subagent-xyz')

  // 从磁盘读回, 溯源字段应保留 (frontmatter 往返)
  const read = await getMemory(mem.id)
  assert.ok(read)
  assert.equal(read.sourceStartSeq, 10)
  assert.equal(read.sourceEndSeq, 20)
  assert.equal(read.subagentRef, 'subagent-xyz')

  await rm(dir, { recursive: true, force: true })
})

test('createMemory 不带溯源字段时字段为 undefined', async () => {
  const dir = await tempDir('mem-store-')
  setMemoriesDir(dir)

  const mem = await createMemory('普通记忆', '内容', [])
  assert.equal(mem.sourceStartSeq, undefined)
  assert.equal(mem.sourceEndSeq, undefined)
  assert.equal(mem.subagentRef, undefined)

  await rm(dir, { recursive: true, force: true })
})

test('updateMemory 保持溯源字段不被清掉', async () => {
  const dir = await tempDir('mem-store-')
  setMemoriesDir(dir)

  const mem = await createMemory('旧标题', '旧内容', [], {
    sourceStartSeq: 5,
    sourceEndSeq: 9,
  })
  const updated = await updateMemory(mem.id, { title: '新标题', content: '新内容' })

  assert.ok(updated)
  assert.equal(updated.title, '新标题')
  // 未显式更新溯源, 应保留原值
  assert.equal(updated.sourceStartSeq, 5)
  assert.equal(updated.sourceEndSeq, 9)

  const read = await getMemory(mem.id)
  assert.ok(read)
  assert.equal(read.sourceStartSeq, 5)
  assert.equal(read.sourceEndSeq, 9)

  await rm(dir, { recursive: true, force: true })
})

test('searchMemories 能搜到带溯源字段的记忆', async () => {
  const dir = await tempDir('mem-store-')
  setMemoriesDir(dir)

  await createMemory('部署规范', '所有服务用 pnpm 部署', ['ops'], {
    sourceStartSeq: 1,
    sourceEndSeq: 3,
  })
  const results = await searchMemories('pnpm')
  assert.equal(results.length, 1)
  assert.equal(results[0].sourceStartSeq, 1)

  await rm(dir, { recursive: true, force: true })
})

// ── transcript: 原文记录 ────────────────────────────────────────────────────

test('transcript append 后按 seq 范围读取', async () => {
  const dir = await tempDir('mem-transcript-')
  setTranscriptDir(dir)

  await appendTranscript({ seq: 1, role: 'user', text: '你好' })
  await appendTranscript({ seq: 2, role: 'assistant', text: '你好呀' })
  await appendTranscript({ seq: 3, role: 'tool', text: '工具结果' })

  // 读取区间 [1, 2]
  const range = await readTranscriptRange(1, 2)
  assert.equal(range.length, 2)
  assert.equal(range[0].text, '你好')
  assert.equal(range[1].text, '你好呀')

  // 读取区间 [3, 3]
  const single = await readTranscriptRange(3, 3)
  assert.equal(single.length, 1)
  assert.equal(single[0].role, 'tool')

  // 越界区间
  const none = await readTranscriptRange(100, 200)
  assert.equal(none.length, 0)

  await rm(dir, { recursive: true, force: true })
})

// ── gate: 压缩门控 ──────────────────────────────────────────────────────────

/** 可控的 deferred, 用于挂起/释放压缩流程。 */
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>(r => { resolve = r })
  return { promise, resolve }
}

/** 等一个宏任务, 让 runCompactionFlow 的微任务回调先执行。 */
async function nextTick(): Promise<void> {
  await new Promise<void>(r => setImmediate(r))
}

test('压缩期间消息排队, 完成后按序 flush', async () => {
  const delivered: string[] = []
  // mock agent: 只关心 followup 收到的文本
  bindAgent({
    followup: (m: { content: Array<{ text: string }> }) =>
      delivered.push(m.content[0]?.text ?? ''),
  } as never)

  const gate = deferred()
  const flow = runCompactionFlow(async () => {
    await gate.promise
  })
  // 等 flow 开始执行 (release 语义已由 deferred 承载, 这里只需让 flow 进入 await)
  await nextTick()

  // 压缩进行中, 发两条消息 → 应排队, 不投递
  assert.equal(isCompacting(), true)
  enqueueOrFollowup({ content: [{ text: 'msg1' }] } as never)
  enqueueOrFollowup({ content: [{ text: 'msg2' }] } as never)
  assert.equal(delivered.length, 0)

  // 释放压缩流程
  gate.resolve()
  await flow

  // 完成后 flush, 按 FIFO 顺序投递
  assert.equal(isCompacting(), false)
  assert.deepEqual(delivered, ['msg1', 'msg2'])
})

test('非压缩期间消息直接投递', async () => {
  const delivered: string[] = []
  bindAgent({
    followup: (m: { content: Array<{ text: string }> }) =>
      delivered.push(m.content[0]?.text ?? ''),
  } as never)

  enqueueOrFollowup({ content: [{ text: 'direct' }] } as never)
  assert.deepEqual(delivered, ['direct'])
})
