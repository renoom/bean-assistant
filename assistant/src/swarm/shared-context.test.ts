import assert from 'node:assert/strict'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { SharedContextStore } from './shared-context.js'

test('shared context: write, caps, propose/accept/reject, snapshot', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'swarm-context-test-'))
  const path = join(directory, 'shared-context.json')
  const store = new SharedContextStore({ path, limits: () => ({ maxBytes: 600, maxEntries: 3 }) })
  await store.load()

  const first = store.write({ action: 'add', key: 'api', title: '接口约定', content: '统一 /api/v1' })
  assert.equal(first.ok, true)
  assert.equal(store.version, 1)
  assert.match(store.snapshotText(), /接口约定/)

  store.write({ action: 'add', key: 'style', title: '代码风格', content: '单引号，无分号' })
  assert.equal(store.entries().length, 2)

  // 单条正文有上限
  assert.throws(() => store.write({ action: 'add', key: 'long', title: '长文', content: 'x'.repeat(2000) }), /too long/)

  // 成员提案不直接进正文
  const proposal = store.propose('member-1', { key: 'test', title: '测试约定', content: '接口需要测试' })
  assert.equal(store.entries().length, 2)
  assert.equal(store.proposals().length, 1)

  // 采纳提案写入正文
  store.write({ action: 'accept', proposalId: proposal.id })
  assert.equal(store.entries().length, 3)
  assert.equal(store.proposals().length, 0)

  // 写入后落盘
  await store.save()
  const raw = JSON.parse(await readFile(path, 'utf8'))
  assert.equal(raw.entries.length, 3)
  assert.equal(raw.version, store.version)

  // 条目数 / 总字节上限
  assert.throws(() => store.write({ action: 'add', key: 'four', title: '第四条', content: 'x' }), /已满|超出大小上限/)

  // 删除
  const target = store.entries()[0]
  store.write({ action: 'delete', id: target.id })
  assert.equal(store.entries().length, 2)
})

test('shared context: snapshot and version reset on reload', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'swarm-context-reload-'))
  const path = join(directory, 'shared-context.json')
  const first = new SharedContextStore({ path })
  await first.load()
  first.write({ action: 'add', key: 'k', title: 't', content: 'v' })
  await first.save()

  const second = new SharedContextStore({ path })
  await second.load()
  assert.equal(second.entries().length, 1)
  assert.equal(second.version, 1)
  assert.match(second.snapshotText(), /^\[共享上下文 v1\]/)
})
