/**
 * 公共知识库 — 每份知识一把锁 (TTL 自动过期)
 *
 * 语义: 同一时间、同一份知识, 只能由一个助手更新。
 *   - acquire: 该知识空闲则加锁并返回成功; 已被占用则返回持有者。
 *   - release: 仅持有者可释放。
 *   - TTL: 锁带过期时间, 助手写一半崩溃也不会死锁 (过期后自动视为空闲)。
 *
 * 锁是进程内存态 (控制台单进程), 不持久化。写操作全部经控制台,
 * 因此无需分布式锁。
 *
 * @module console/knowledge/lock
 */

interface LockRecord {
  owner: string
  expiresAt: number
}

export interface AcquireResult {
  ok: boolean
  /** 锁被他人持有时, 返回持有者 sessionId */
  holder?: string
}

export class KnowledgeLockManager {
  private readonly locks = new Map<string, LockRecord>()

  /**
   * 尝试获取某份知识的写锁。
   * @param entryId 知识条目 ID (新条目可用其拟用的稳定 key)
   * @param owner 申请锁的助手 sessionId
   * @param ttlMs 锁的存活时间, 默认 5s (足够一次文件写)
   */
  acquire(entryId: string, owner: string, ttlMs = 5000): AcquireResult {
    const now = Date.now()
    const existing = this.locks.get(entryId)
    // 存在且未过期 → 被占用; 已过期则视为空闲
    if (existing && existing.expiresAt > now) {
      return { ok: false, holder: existing.owner }
    }
    this.locks.set(entryId, { owner, expiresAt: now + ttlMs })
    return { ok: true }
  }

  /** 释放锁。仅持有者可释放, 防止误释放他人锁。 */
  release(entryId: string, owner: string): void {
    const existing = this.locks.get(entryId)
    if (existing && existing.owner === owner) {
      this.locks.delete(entryId)
    }
  }

  /** 查询某份知识当前是否被锁定。 */
  isLocked(entryId: string): boolean {
    const existing = this.locks.get(entryId)
    return existing !== undefined && existing.expiresAt > Date.now()
  }
}
