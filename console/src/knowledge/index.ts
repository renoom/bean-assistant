/**
 * 公共知识库 — KnowledgeCenter (存储 + 锁 + 乐观并发编排)
 *
 * 职责:
 *   - 读: list / search / get (无锁, 全部助手共享只读)
 *   - 写: propose (助手申请写入) — 加锁 → 版本校验 → 写 → 释放
 *
 * 写语义 (一次性 propose):
 *   新条目 (无 id): 直接创建, version = 1。
 *   已有条目 (带 id + baseVersion): 加锁, 校验 baseVersion === 当前 version,
 *   一致则写 (version+1); 不一致返回版本冲突; 锁被占用返回 locked。
 *
 * 结果统一用 WriteResult 返回, 由 server.ts 映射为 HTTP 状态码。
 *
 * @module console/knowledge
 */

import { KnowledgeLockManager } from './lock.ts'
import {
  KnowledgeStore,
  type KnowledgeEntry,
  type KnowledgeMeta,
} from './store.ts'

export interface ProposeInput {
  /** 已有条目 id (更新时必填); 省略则创建新条目 */
  id?: string
  title: string
  content: string
  tags?: string[]
  /** 申请写入的助手 sessionId (锁持有者 + 作者) */
  assistantId: string
  /** 乐观并发基准版本 (更新时必填) */
  baseVersion?: number
}

export type WriteResult =
  | { ok: true; entry: KnowledgeEntry }
  | { ok: false; error: 'locked'; holder: string }
  | { ok: false; error: 'version_conflict'; currentVersion: number }
  | { ok: false; error: 'not_found' }

export class KnowledgeCenter {
  readonly store: KnowledgeStore
  readonly lock = new KnowledgeLockManager()

  constructor(store: KnowledgeStore) {
    this.store = store
  }

  // ── 读 (共享只读) ────────────────────────────────────────────────────────

  list(tags?: string[]): Promise<KnowledgeMeta[]> {
    return this.store.list(tags)
  }

  search(query: string): Promise<KnowledgeEntry[]> {
    return this.store.search(query)
  }

  get(id: string): Promise<KnowledgeEntry | null> {
    return this.store.get(id)
  }

  // ── 写 (一次性 propose: 锁 + 版本校验) ──────────────────────────────────

  async propose(input: ProposeInput): Promise<WriteResult> {
    // 新条目: 直接创建 (随机 id, 无并发冲突)
    if (!input.id) {
      const entry = await this.store.create({
        title: input.title,
        content: input.content,
        tags: input.tags,
        author: input.assistantId,
      })
      return { ok: true, entry }
    }

    // 已有条目: 加锁 → 校验 → 写 → 释放
    const id = input.id
    const acquired = this.lock.acquire(id, input.assistantId)
    if (!acquired.ok) {
      return { ok: false, error: 'locked', holder: acquired.holder ?? 'unknown' }
    }

    try {
      const current = await this.store.get(id)
      if (!current) return { ok: false, error: 'not_found' }

      // 乐观并发: baseVersion 必须等于当前版本, 否则说明别人已经改过
      if (input.baseVersion !== undefined && input.baseVersion !== current.version) {
        return { ok: false, error: 'version_conflict', currentVersion: current.version }
      }

      const entry = await this.store.update(id, {
        title: input.title,
        content: input.content,
        tags: input.tags,
        author: input.assistantId,
      })
      if (!entry) return { ok: false, error: 'not_found' }
      return { ok: true, entry }
    } finally {
      this.lock.release(id, input.assistantId)
    }
  }
}
