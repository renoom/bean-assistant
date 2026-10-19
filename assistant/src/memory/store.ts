/**
 * 数字人记忆系统 — 文件存储核心 (带索引)
 *
 * 布局:
 *   data/memories/index.json   # 元数据索引 (id → title/tags/file/created/updated)
 *   data/memories/{slug}-{id}.md  # 正文文件 (单一事实源)
 *
 * 一致性模型: 文件是事实源, 索引是缓存。
 *   - CRUD 双写: 改 md 文件 + 同步更新 index.json
 *   - 漂移检测: 每次读取前轻量 readdir, 磁盘文件集合 != 索引集合 → 自动重建
 *   - rebuildIndex() 可手动重建
 *
 * @module assistant/memory/store
 */

import { readFile, writeFile, readdir, unlink, mkdir, rename } from 'node:fs/promises'
import { resolve, basename, extname } from 'node:path'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'

// ── 目录 ────────────────────────────────────────────────────────────────────

let memoriesDir = ''

export function setMemoriesDir(dir: string): void {
  memoriesDir = resolve(dir)
}

function indexPath(): string {
  return resolve(memoriesDir, 'index.json')
}

async function ensureDir(): Promise<void> {
  if (!existsSync(memoriesDir)) {
    await mkdir(memoriesDir, { recursive: true })
  }
}

// ── 数据类型 ────────────────────────────────────────────────────────────────

/** 记忆溯源信息: 指向"这份记忆从哪段会话原文提炼而来"。 */
export interface MemorySource {
  /** 主会话原文起始 seq (events 的稳定索引) */
  sourceStartSeq?: number
  /** 主会话原文结束 seq (含) */
  sourceEndSeq?: number
  /** 若来源是某个 subagent 的结论, 记录其 sessionId 以便追溯过程 */
  subagentRef?: string
}

export interface MemoryMeta {
  id: string
  title: string
  tags: string[]
  file: string
  created: string
  updated: string
  /** 溯源: 主会话原文区间 (events seq, 可选) */
  sourceStartSeq?: number
  sourceEndSeq?: number
  /** 溯源: subagent 会话 id (可选) */
  subagentRef?: string
}

export interface Memory extends MemoryMeta {
  content: string
}

interface MemoryIndex {
  version: 1
  memories: MemoryMeta[]
}

const EMPTY_INDEX: MemoryIndex = { version: 1, memories: [] }

// ── 索引读写 ────────────────────────────────────────────────────────────────

async function loadIndex(): Promise<MemoryIndex> {
  await ensureDir()
  try {
    const raw = await readFile(indexPath(), 'utf-8')
    const parsed = JSON.parse(raw) as MemoryIndex
    if (parsed.version !== 1 || !Array.isArray(parsed.memories)) return EMPTY_INDEX
    return parsed
  } catch {
    return EMPTY_INDEX
  }
}

async function saveIndex(index: MemoryIndex): Promise<void> {
  await ensureDir()
  const tmp = indexPath() + '.tmp'
  await writeFile(tmp, JSON.stringify(index, null, 2), 'utf-8')
  await rename(tmp, indexPath())
}

// ── Frontmatter 解析 (与无索引版保持一致) ──────────────────────────────────

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

function stringify(fm: Record<string, string | number | undefined>, content: string): string {
  const lines = Object.entries(fm)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${k}: ${v}`)
  return `---\n${lines.join('\n')}\n---\n\n${content}\n`
}

function parseTags(raw: string | undefined): string[] {
  return (raw ?? '').replace(/[\[\]]/g, '').split(',').map(s => s.trim()).filter(Boolean)
}

function parseOptionalNumber(raw: string | undefined): number | undefined {
  if (raw === undefined || raw === '') return undefined
  const n = parseInt(raw, 10)
  return Number.isFinite(n) ? n : undefined
}

function slug(title: string): string {
  return title.toLowerCase().replace(/[^\w一-鿿]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 50)
}

/** 读取单个 md 文件并解析为 Memory (用于重建/读取正文) */
async function readMemoryFile(file: string): Promise<Memory> {
  const raw = await readFile(resolve(memoriesDir, file), 'utf-8')
  const { fm, content } = parse(raw)
  return {
    id: fm.id || basename(file, '.md'),
    title: fm.title || basename(file, '.md'),
    content,
    tags: parseTags(fm.tags),
    created: fm.created || '',
    updated: fm.updated || '',
    file,
    sourceStartSeq: parseOptionalNumber(fm.sourceStartSeq),
    sourceEndSeq: parseOptionalNumber(fm.sourceEndSeq),
    subagentRef: fm.subagentRef || undefined,
  }
}

// ── 漂移检测与重建 ──────────────────────────────────────────────────────────

/** 扫描磁盘, 返回所有 md 文件 (不含 index.json) 和当前索引记忆 */
async function collectIndex(): Promise<MemoryIndex> {
  await ensureDir()
  const memories: MemoryMeta[] = []
  for (const file of await readdir(memoriesDir)) {
    if (extname(file) !== '.md') continue
    try {
      const m = await readMemoryFile(file)
      memories.push({
        id: m.id, title: m.title, tags: m.tags,
        file: m.file, created: m.created, updated: m.updated,
        sourceStartSeq: m.sourceStartSeq, sourceEndSeq: m.sourceEndSeq, subagentRef: m.subagentRef,
      })
    } catch { /* 跳过损坏文件 */ }
  }
  memories.sort((a, b) => b.updated.localeCompare(a.updated))
  return { version: 1, memories }
}

/**
 * 校验索引是否与磁盘一致; 不一致则重建。
 * 一致性 = 磁盘 md 文件集合与索引 file 集合相同。
 */
async function ensureFresh(): Promise<MemoryIndex> {
  let index = await loadIndex()

  // 轻量 readdir 对比文件集合 (不读文件内容)
  const diskFiles = (await readdir(memoriesDir)).filter(f => extname(f) === '.md').sort()
  const indexFiles = index.memories.map(m => m.file).sort()

  const consistent = diskFiles.length === indexFiles.length
    && diskFiles.every((f, i) => f === indexFiles[i])

  if (!consistent) {
    console.log(`[memory] 索引与磁盘不一致, 重建索引 (${diskFiles.length} files)`)
    index = await collectIndex()
    await saveIndex(index)
  }
  return index
}

/** 手动重建索引 (导出供修复) */
export async function rebuildIndex(): Promise<void> {
  const index = await collectIndex()
  await saveIndex(index)
}

// ── CRUD 操作 ───────────────────────────────────────────────────────────────

/** 创建新记忆: 写文件 + 更新索引 */
export async function createMemory(
  title: string, content: string, tags: string[] = [], source?: MemorySource,
): Promise<Memory> {
  await ensureDir()
  const id = randomUUID()
  const now = new Date().toISOString()
  const file = `${slug(title) || 'memory'}-${id.slice(0, 8)}.md`

  // 1. 先取干净索引 (在写文件前, 避免重建时读到刚写的文件)
  const index = await ensureFresh()

  // 2. 写正文文件
  const fm: Record<string, string | number | undefined> = {
    title, id, tags: `[${tags.join(', ')}]`, created: now, updated: now,
    sourceStartSeq: source?.sourceStartSeq,
    sourceEndSeq: source?.sourceEndSeq,
    subagentRef: source?.subagentRef,
  }
  await writeFile(resolve(memoriesDir, file), stringify(fm, content), 'utf-8')

  // 3. 更新索引
  index.memories.unshift({
    id, title, tags, file, created: now, updated: now,
    sourceStartSeq: source?.sourceStartSeq, sourceEndSeq: source?.sourceEndSeq, subagentRef: source?.subagentRef,
  })
  await saveIndex(index)

  return {
    id, title, content, tags, created: now, updated: now, file,
    sourceStartSeq: source?.sourceStartSeq, sourceEndSeq: source?.sourceEndSeq, subagentRef: source?.subagentRef,
  }
}

/** 读取单条记忆: 索引定位 + 读正文 */
export async function getMemory(id: string): Promise<Memory | null> {
  const index = await ensureFresh()
  const meta = index.memories.find(m => m.id === id || m.file.includes(id.slice(0, 8)))
  if (!meta) return null

  try {
    const m = await readMemoryFile(meta.file)
    return m
  } catch {
    // 文件缺失 → 从索引移除
    index.memories = index.memories.filter(x => x.id !== meta.id)
    await saveIndex(index)
    return null
  }
}

/** 列出所有记忆: 读索引 (O(1)), 可选标签过滤 */
export async function listMemories(tags?: string[]): Promise<MemoryMeta[]> {
  const index = await ensureFresh()
  if (!tags?.length) return index.memories.map(m => ({ ...m }))

  return index.memories
    .filter(m => tags.some(t => m.tags.includes(t)))
    .map(m => ({ ...m }))
}

/**
 * 搜索记忆。
 * 标题/标签命中直接由索引决定 (快); 需要全文匹配时读取候选文件正文。
 * 返回带 snippet 的完整条目。
 */
export async function searchMemories(query: string): Promise<Memory[]> {
  const index = await ensureFresh()
  const q = query.toLowerCase()

  const results: Memory[] = []
  for (const meta of index.memories) {
    const titleHit = meta.title.toLowerCase().includes(q)
    const tagHit = meta.tags.some(t => t.toLowerCase().includes(q))

    if (titleHit || tagHit) {
      try {
        const m = await readMemoryFile(meta.file)
        if (titleHit || tagHit || m.content.toLowerCase().includes(q)) {
          results.push(m)
        }
      } catch { /* 文件缺失跳过 */ }
    } else {
      // 标题/标签未命中, 检查正文
      try {
        const m = await readMemoryFile(meta.file)
        if (m.content.toLowerCase().includes(q)) results.push(m)
      } catch { /* 跳过 */ }
    }
  }

  return results
}

/** 更新记忆: 改文件 + 更新索引 (标题变则重命名文件) */
export async function updateMemory(
  id: string, updates: { title?: string; content?: string; tags?: string[]; source?: MemorySource },
): Promise<Memory | null> {
  const index = await ensureFresh()
  const meta = index.memories.find(m => m.id === id || m.file.includes(id.slice(0, 8)))
  if (!meta) return null

  const old = await getMemory(id)
  if (!old) return null

  const title = updates.title ?? meta.title
  const content = updates.content ?? old.content
  const tags = updates.tags ?? meta.tags
  const source: MemorySource | undefined = updates.source ?? (
    meta.sourceStartSeq !== undefined || meta.sourceEndSeq !== undefined || meta.subagentRef !== undefined
      ? { sourceStartSeq: meta.sourceStartSeq, sourceEndSeq: meta.sourceEndSeq, subagentRef: meta.subagentRef }
      : undefined
  )
  const now = new Date().toISOString()
  const file = `${slug(title) || 'memory'}-${meta.id.slice(0, 8)}.md`

  // 1. 写文件 (新文件名)
  const fm: Record<string, string | number | undefined> = {
    title, id: meta.id, tags: `[${tags.join(', ')}]`, created: meta.created, updated: now,
    sourceStartSeq: source?.sourceStartSeq, sourceEndSeq: source?.sourceEndSeq, subagentRef: source?.subagentRef,
  }
  await writeFile(resolve(memoriesDir, file), stringify(fm, content), 'utf-8')

  // 2. 标题变则删旧文件
  if (file !== meta.file) {
    try { await unlink(resolve(memoriesDir, meta.file)) } catch { /* ok */ }
  }

  // 3. 更新索引
  const updated: MemoryMeta = {
    id: meta.id, title, tags, file, created: meta.created, updated: now,
    sourceStartSeq: source?.sourceStartSeq, sourceEndSeq: source?.sourceEndSeq, subagentRef: source?.subagentRef,
  }
  index.memories = index.memories.map(m => m.id === meta.id ? updated : m)
  index.memories.sort((a, b) => b.updated.localeCompare(a.updated))
  await saveIndex(index)

  return { ...updated, content }
}

/** 删除记忆: 删文件 + 移除索引项 */
export async function deleteMemory(id: string): Promise<boolean> {
  const index = await ensureFresh()
  const meta = index.memories.find(m => m.id === id || m.file.includes(id.slice(0, 8)))
  if (!meta) return false

  try { await unlink(resolve(memoriesDir, meta.file)) } catch { /* ok */ }
  index.memories = index.memories.filter(m => m.id !== meta.id)
  await saveIndex(index)
  return true
}