/**
 * 公共知识库 — 文件存储核心 (带索引 + 版本)
 *
 * 布局:
 *   data/knowledge/index.json          # 元数据索引 (id → title/tags/file/version/author/...)
 *   data/knowledge/{slug}-{id}.md      # 正文文件 (单一事实源)
 *
 * 与记忆系统 (assistant/src/memory/store.ts) 同构, 但归属不同:
 *   记忆 = 助手私有, 知识库 = 控制台公共。二者不共享代码, 保持服务间解耦。
 *
 * 一致性模型: 文件是事实源, 索引是缓存。
 *   - CRUD 双写: 改 md 文件 + 同步更新 index.json
 *   - 漂移检测: 读取前轻量 readdir 对比文件集合, 不一致则自动重建
 *
 * version 是乐观并发版本号: 创建时为 1, 每次更新 +1。
 * 版本校验 + 锁编排在 KnowledgeCenter (index.ts), 本类只做存储与版本自增。
 *
 * @module console/knowledge/store
 */

import { readFile, writeFile, readdir, unlink, mkdir, rename } from 'node:fs/promises'
import { resolve, basename, extname } from 'node:path'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'

// ── 数据类型 ────────────────────────────────────────────────────────────────

export interface KnowledgeMeta {
  id: string
  title: string
  tags: string[]
  file: string
  /** 乐观并发版本号, 每次更新 +1 */
  version: number
  /** 最后写入的助手 sessionId */
  author: string
  created: string
  updated: string
}

export interface KnowledgeEntry extends KnowledgeMeta {
  content: string
}

export interface KnowledgeInput {
  title: string
  content: string
  tags?: string[]
  author: string
}

export interface KnowledgePatch {
  title?: string
  content?: string
  tags?: string[]
  author: string
}

interface KnowledgeIndex {
  version: 1
  entries: KnowledgeMeta[]
}

const EMPTY_INDEX: KnowledgeIndex = { version: 1, entries: [] }

// ── frontmatter 解析 ────────────────────────────────────────────────────────

function parse(raw: string): { fm: Record<string, string>; content: string } {
  const m = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/)
  if (!m) return { fm: {}, content: raw }
  const fm: Record<string, string> = {}
  for (const line of m[1].split('\n')) {
    const kv = line.match(/^(\w+):\s*(.*)/)
    if (kv) fm[kv[1]] = kv[2].trim()
  }
  return { fm, content: m[2].trim() }
}

function stringify(fm: Record<string, string | number>, content: string): string {
  const lines = Object.entries(fm).map(([k, v]) => `${k}: ${v}`)
  return `---\n${lines.join('\n')}\n---\n\n${content}\n`
}

function parseTags(raw: string | undefined): string[] {
  return (raw ?? '').replace(/[\[\]]/g, '').split(',').map(s => s.trim()).filter(Boolean)
}

function slug(title: string): string {
  return title.toLowerCase().replace(/[^\w一-鿿]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 50)
}

function parseVersion(raw: string | undefined): number {
  const n = parseInt(raw ?? '1', 10)
  return Number.isFinite(n) && n > 0 ? n : 1
}

// ── 存储类 ──────────────────────────────────────────────────────────────────

export class KnowledgeStore {
  private readonly dir: string

  constructor(dir: string) {
    this.dir = resolve(dir)
  }

  private indexPath(): string {
    return resolve(this.dir, 'index.json')
  }

  private async ensureDir(): Promise<void> {
    if (!existsSync(this.dir)) await mkdir(this.dir, { recursive: true })
  }

  private async loadIndex(): Promise<KnowledgeIndex> {
    await this.ensureDir()
    try {
      const raw = await readFile(this.indexPath(), 'utf-8')
      const parsed = JSON.parse(raw) as KnowledgeIndex
      if (parsed.version !== 1 || !Array.isArray(parsed.entries)) return EMPTY_INDEX
      return parsed
    } catch {
      return EMPTY_INDEX
    }
  }

  private async saveIndex(index: KnowledgeIndex): Promise<void> {
    await this.ensureDir()
    const tmp = this.indexPath() + '.tmp'
    await writeFile(tmp, JSON.stringify(index, null, 2), 'utf-8')
    await rename(tmp, this.indexPath())
  }

  /** 读取单个 md 文件并解析为条目 (用于重建/读取正文)。 */
  private async readEntryFile(file: string): Promise<KnowledgeEntry> {
    const raw = await readFile(resolve(this.dir, file), 'utf-8')
    const { fm, content } = parse(raw)
    return {
      id: fm.id || basename(file, '.md'),
      title: fm.title || basename(file, '.md'),
      content,
      tags: parseTags(fm.tags),
      version: parseVersion(fm.version),
      author: fm.author || '',
      created: fm.created || '',
      updated: fm.updated || '',
      file,
    }
  }

  /** 扫描磁盘重建索引 (用于漂移修复)。 */
  private async collectIndex(): Promise<KnowledgeIndex> {
    await this.ensureDir()
    const entries: KnowledgeMeta[] = []
    for (const file of await readdir(this.dir)) {
      if (extname(file) !== '.md') continue
      try {
        const e = await this.readEntryFile(file)
        const { content: _content, ...meta } = e
        entries.push(meta)
      } catch { /* 跳过损坏文件 */ }
    }
    entries.sort((a, b) => b.updated.localeCompare(a.updated))
    return { version: 1, entries }
  }

  /** 校验索引与磁盘一致, 不一致则重建。 */
  private async ensureFresh(): Promise<KnowledgeIndex> {
    await this.ensureDir()
    let index = await this.loadIndex()
    const diskFiles = (await readdir(this.dir)).filter(f => extname(f) === '.md').sort()
    const indexFiles = index.entries.map(e => e.file).sort()
    const consistent = diskFiles.length === indexFiles.length
      && diskFiles.every((f, i) => f === indexFiles[i])
    if (!consistent) {
      index = await this.collectIndex()
      await this.saveIndex(index)
    }
    return index
  }

  /** 手动重建索引 (导出供修复)。 */
  async rebuildIndex(): Promise<void> {
    const index = await this.collectIndex()
    await this.saveIndex(index)
  }

  // ── CRUD ────────────────────────────────────────────────────────────────

  /** 创建新知识条目, version = 1。 */
  async create(input: KnowledgeInput): Promise<KnowledgeEntry> {
    await this.ensureDir()
    const id = randomUUID()
    const now = new Date().toISOString()
    const file = `${slug(input.title) || 'knowledge'}-${id.slice(0, 8)}.md`
    const index = await this.ensureFresh()

    const fm: Record<string, string | number> = {
      title: input.title, id, tags: `[${(input.tags ?? []).join(', ')}]`,
      version: 1, author: input.author, created: now, updated: now,
    }
    await writeFile(resolve(this.dir, file), stringify(fm, input.content), 'utf-8')

    index.entries.unshift({
      id, title: input.title, tags: input.tags ?? [], file,
      version: 1, author: input.author, created: now, updated: now,
    })
    await this.saveIndex(index)

    return {
      id, title: input.title, content: input.content, tags: input.tags ?? [],
      file, version: 1, author: input.author, created: now, updated: now,
    }
  }

  /** 读取单条知识: 索引定位 + 读正文。 */
  async get(id: string): Promise<KnowledgeEntry | null> {
    const index = await this.ensureFresh()
    const meta = index.entries.find(e => e.id === id || e.file.includes(id.slice(0, 8)))
    if (!meta) return null
    try {
      return await this.readEntryFile(meta.file)
    } catch {
      index.entries = index.entries.filter(e => e.id !== meta.id)
      await this.saveIndex(index)
      return null
    }
  }

  /** 列出所有知识 (索引, O(1)), 可选标签过滤。 */
  async list(tags?: string[]): Promise<KnowledgeMeta[]> {
    const index = await this.ensureFresh()
    if (!tags?.length) return index.entries.map(e => ({ ...e }))
    return index.entries.filter(e => tags.some(t => e.tags.includes(t))).map(e => ({ ...e }))
  }

  /** 全文搜索: 标题/标签命中走索引, 正文匹配读文件。 */
  async search(query: string): Promise<KnowledgeEntry[]> {
    const index = await this.ensureFresh()
    const q = query.toLowerCase()
    const results: KnowledgeEntry[] = []
    for (const meta of index.entries) {
      const titleHit = meta.title.toLowerCase().includes(q)
      const tagHit = meta.tags.some(t => t.toLowerCase().includes(q))
      try {
        const e = await this.readEntryFile(meta.file)
        if (titleHit || tagHit || e.content.toLowerCase().includes(q)) results.push(e)
      } catch { /* 跳过 */ }
    }
    return results
  }

  /**
   * 更新一条已有知识: 读当前 → 版本 +1 → 重写文件 → 更新索引。
   * 版本校验由 KnowledgeCenter 在锁内完成, 本方法只负责自增。
   */
  async update(id: string, patch: KnowledgePatch): Promise<KnowledgeEntry | null> {
    const index = await this.ensureFresh()
    const meta = index.entries.find(e => e.id === id || e.file.includes(id.slice(0, 8)))
    if (!meta) return null

    const current = await this.get(id)
    if (!current) return null

    const title = patch.title ?? current.title
    const content = patch.content ?? current.content
    const tags = patch.tags ?? current.tags
    const version = current.version + 1
    const now = new Date().toISOString()
    const file = `${slug(title) || 'knowledge'}-${meta.id.slice(0, 8)}.md`

    const fm: Record<string, string | number> = {
      title, id: meta.id, tags: `[${tags.join(', ')}]`,
      version, author: patch.author, created: current.created, updated: now,
    }
    await writeFile(resolve(this.dir, file), stringify(fm, content), 'utf-8')

    if (file !== meta.file) {
      try { await unlink(resolve(this.dir, meta.file)) } catch { /* ok */ }
    }

    const updated: KnowledgeMeta = {
      id: meta.id, title, tags, file, version,
      author: patch.author, created: current.created, updated: now,
    }
    index.entries = index.entries.map(e => e.id === meta.id ? updated : e)
    index.entries.sort((a, b) => b.updated.localeCompare(a.updated))
    await this.saveIndex(index)

    return { ...updated, content }
  }

  /** 删除知识: 删文件 + 移除索引项。 */
  async delete(id: string): Promise<boolean> {
    const index = await this.ensureFresh()
    const meta = index.entries.find(e => e.id === id || e.file.includes(id.slice(0, 8)))
    if (!meta) return false
    try { await unlink(resolve(this.dir, meta.file)) } catch { /* ok */ }
    index.entries = index.entries.filter(e => e.id !== meta.id)
    await this.saveIndex(index)
    return true
  }
}
