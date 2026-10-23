/**
 * 蜂群共享上下文（黑板）
 *
 * - 成员只能读快照、提交候选（proposal）；
 * - 只有主 agent 能写正文（add/update/delete/accept/reject）；
 * - 硬上限：总字节 / 条目数 / 单条字节；写满直接失败，主 agent 自己决定删/合并。
 *
 * 文件：{dataDir}/swarm/shared-context.json
 *
 * @module assistant/swarm/shared-context
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'

export interface SharedContextLimits {
  maxBytes: number
  maxEntries: number
}

export interface SharedContextEntry {
  id: string
  key: string
  title: string
  content: string
  author: string
  createdAt: string
  updatedAt: string
}

export interface SharedContextProposal {
  id: string
  key: string
  title: string
  content: string
  author: string
  createdAt: string
}

interface SharedContextFile {
  version: number
  entries: SharedContextEntry[]
  proposals: SharedContextProposal[]
  updatedAt: string
}

const DEFAULT_LIMITS: SharedContextLimits = { maxBytes: 8192, maxEntries: 50 }
const MAX_ENTRY_CHARS = 1024
const MAX_PENDING = 50

function nowIso(): string {
  return new Date().toISOString()
}

function nonEmpty(value: unknown, field: string, max: number): string {
  if (typeof value !== 'string') throw new Error(`${field} is required`)
  const text = value.trim()
  if (!text) throw new Error(`${field} is required`)
  if (text.length > max) throw new Error(`${field} is too long (max ${max})`)
  return text
}

function entryBytes(entry: { key: string; title: string; content: string }): number {
  return Buffer.byteLength(JSON.stringify({ key: entry.key, title: entry.title, content: entry.content }), 'utf8')
}

export class SharedContextStore {
  private file: SharedContextFile = { version: 0, entries: [], proposals: [], updatedAt: nowIso() }
  private loaded = false
  private readonly path: string | undefined
  private saveChain: Promise<void> = Promise.resolve()

  constructor(options: { path?: string; limits?: () => SharedContextLimits }) {
    this.path = options.path ? resolve(options.path) : undefined
    this.limits = options.limits ?? (() => DEFAULT_LIMITS)
  }

  private readonly limits: () => SharedContextLimits

  async load(): Promise<void> {
    if (this.loaded) return
    this.loaded = true
    if (!this.path) return
    try {
      const raw = await readFile(this.path, 'utf8')
      const parsed = JSON.parse(raw) as Partial<SharedContextFile>
      if (parsed && Array.isArray(parsed.entries)) {
        this.file = {
          version: typeof parsed.version === 'number' ? parsed.version : 0,
          entries: parsed.entries.filter((entry): entry is SharedContextEntry => Boolean(entry) && typeof entry.id === 'string'),
          proposals: Array.isArray(parsed.proposals)
            ? parsed.proposals.filter((proposal): proposal is SharedContextProposal => Boolean(proposal) && typeof proposal.id === 'string')
            : [],
          updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : nowIso(),
        }
      }
    } catch {
      // 首次使用 / 文件损坏：从空开始
    }
  }

  async save(): Promise<void> {
    if (!this.path) return
    this.saveChain = this.saveChain.then(async () => {
      await mkdir(dirname(this.path!), { recursive: true })
      const tmp = `${this.path!}.tmp`
      await writeFile(tmp, JSON.stringify(this.file, null, 2), 'utf8')
      await rename(tmp, this.path!)
    }).catch((error) => {
      console.warn('[swarm] shared-context save failed:', error instanceof Error ? error.message : String(error))
    })
    return this.saveChain
  }

  get version(): number { return this.file.version }

  entries(): SharedContextEntry[] {
    return this.file.entries.map(entry => ({ ...entry }))
  }

  proposals(): SharedContextProposal[] {
    return this.file.proposals.map(proposal => ({ ...proposal }))
  }

  byteUsage(): number {
    return this.file.entries.reduce((sum, entry) => sum + entryBytes(entry), 0)
  }

  limitsSnapshot(): SharedContextLimits {
    return this.limits()
  }

  /** 派发给成员时放在上下文头部的完整快照。 */
  snapshotText(): string {
    if (this.file.entries.length === 0) return ''
    const lines = [`[共享上下文 v${this.file.version}]`]
    for (const entry of this.file.entries) {
      lines.push(`## ${entry.title} (${entry.key})`)
      lines.push(entry.content)
    }
    return lines.join('\n')
  }

  propose(author: string, input: { key?: unknown; title?: unknown; content?: unknown }): SharedContextProposal {
    const key = nonEmpty(input.key, 'key', 64)
    const title = nonEmpty(input.title, 'title', 80)
    const content = nonEmpty(input.content, 'content', MAX_ENTRY_CHARS)
    if (this.file.proposals.length >= MAX_PENDING) throw new Error(`pending proposals are full (max ${MAX_PENDING})`)
    const proposal: SharedContextProposal = {
      id: `prop-${randomUUID().slice(0, 8)}`,
      key,
      title,
      content,
      author,
      createdAt: nowIso(),
    }
    this.file.proposals.push(proposal)
    void this.save()
    return proposal
  }

  /** 主 agent 直接写正文。 */
  write(input: {
    action: 'add' | 'update' | 'delete' | 'accept' | 'reject'
    id?: unknown
    key?: unknown
    title?: unknown
    content?: unknown
    proposalId?: unknown
  }): { ok: true; version: number; message: string } {
    const action = input.action
    if (action === 'accept' || action === 'reject') {
      const id = nonEmpty(input.proposalId, 'proposalId', 80)
      const index = this.file.proposals.findIndex(proposal => proposal.id === id)
      if (index < 0) throw new Error('proposal not found')
      const proposal = this.file.proposals[index]
      if (action === 'reject') {
        this.file.proposals.splice(index, 1)
        this.file.version += 1
        this.file.updatedAt = nowIso()
        void this.save()
        return { ok: true, version: this.file.version, message: `已拒绝候选 ${id}` }
      }
      this.file.proposals.splice(index, 1)
      return this.write({ action: 'add', key: proposal.key, title: proposal.title, content: proposal.content })
    }
    if (action === 'delete') {
      const id = nonEmpty(input.id, 'id', 80)
      const before = this.file.entries.length
      this.file.entries = this.file.entries.filter(entry => entry.id !== id)
      if (this.file.entries.length === before) throw new Error('entry not found')
      this.file.version += 1
      this.file.updatedAt = nowIso()
      void this.save()
      return { ok: true, version: this.file.version, message: `已删除条目 ${id}` }
    }

    const limits = this.limits()
    const key = nonEmpty(input.key, 'key', 64)
    const title = nonEmpty(input.title, 'title', 80)
    const content = nonEmpty(input.content, 'content', MAX_ENTRY_CHARS)
    const existing = action === 'update'
      ? this.file.entries.find(entry => entry.id === String(input.id ?? ''))
      : this.file.entries.find(entry => entry.key === key)
    if (action === 'update' && !existing) throw new Error('entry not found; use action=add or provide an existing id')

    const nextEntry: SharedContextEntry = existing
      ? { ...existing, key, title, content, updatedAt: nowIso() }
      : {
          id: `ctx-${randomUUID().slice(0, 8)}`,
          key, title, content,
          author: 'main',
          createdAt: nowIso(),
          updatedAt: nowIso(),
        }
    const entries = existing
      ? this.file.entries.map(entry => entry.id === existing.id ? nextEntry : entry)
      : [...this.file.entries, nextEntry]
    const totalBytes = entries.reduce((sum, entry) => sum + entryBytes(entry), 0)
    if (entries.length > limits.maxEntries) {
      throw new Error(`共享上下文已满：${entries.length}/${limits.maxEntries} 条；请先删除/合并条目（当前 ${this.byteUsage()} bytes）`)
    }
    if (totalBytes > limits.maxBytes) {
      throw new Error(`共享上下文超出大小上限：${totalBytes}/${limits.maxBytes} bytes；请先删除/合并条目`)
    }
    this.file.entries = entries
    this.file.version += 1
    this.file.updatedAt = nowIso()
    void this.save()
    return { ok: true, version: this.file.version, message: existing ? '条目已更新' : '条目已写入' }
  }
}
