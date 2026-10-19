/**
 * 助手注册表 (内存) — 控制台的核心状态
 *
 * 维护所有已注册助手的元数据。注册表是内存态, 持久化由 store.ts 负责。
 * 每个助手 = 一个独立进程, 启动时 POST /api/register 上报到此注册表。
 *
 * @module console/registry
 */

import { randomUUID } from 'node:crypto'

// ── 数据类型 ────────────────────────────────────────────────────────────────

export type AssistantStatus = 'online' | 'offline' | 'starting'

export interface ChannelEndpoint {
  id: string
  protocol: 'http' | 'ws'
  host: string
  port: number
  path: string
}

export interface AssistantInfo {
  /** 注册表分配的稳定 ID */
  id: string
  /** 助手显示名称 */
  name: string
  /** HTTP 服务监听地址 */
  host: string
  /** HTTP 服务监听端口 */
  port: number
  /** 模型名称 */
  model: string
  /** LLM 提供商 */
  provider: string
  /** 会话 ID (稳定, 跨重启保持一致) */
  sessionId: string
  /** 实际运行中的 channel 列表（由助手启动后上报）。 */
  channels: string[]
  /** 独立 channel 监听端点；缺省时兼容旧版共用 port。 */
  channelEndpoints?: ChannelEndpoint[]
  /** 当前状态 */
  status: AssistantStatus
  /** 首次注册时间 (ISO) */
  registeredAt: string
  /** 最近心跳时间 (ISO) */
  lastHeartbeat: string
  /** 若由控制台 spawn, 记录子进程 PID */
  pid?: number
  /** 是否由控制台 spawn (而非手动启动后上报) */
  spawnedByConsole: boolean
}

/** 上报注册时的载荷 (助手 → 控制台) */
export interface RegisterPayload {
  name: string
  host: string
  port: number
  model: string
  provider: string
  sessionId: string
  channels?: string[]
  channelEndpoints?: ChannelEndpoint[]
}

// ── 注册表 ──────────────────────────────────────────────────────────────────

export class Registry {
  private readonly assistants = new Map<string, AssistantInfo>()

  /**
   * 注册一个助手。按 sessionId 幂等: 同 sessionId 重复注册时更新既有条目,
   * 而不是新建 (助手重启后 sessionId 不变, 避免列表里出现重复)。
   */
  register(payload: RegisterPayload, opts: { id?: string; pid?: number; spawnedByConsole?: boolean } = {}): AssistantInfo {
    const existing = this.findBySessionId(payload.sessionId)
    const now = new Date().toISOString()

    if (existing) {
      Object.assign(existing, {
        name: payload.name,
        host: payload.host,
        port: payload.port,
        model: payload.model,
        provider: payload.provider,
        channels: payload.channels ?? existing.channels,
        channelEndpoints: payload.channelEndpoints ?? existing.channelEndpoints,
        status: 'online' as const,
        lastHeartbeat: now,
        pid: opts.pid ?? existing.pid,
        spawnedByConsole: opts.spawnedByConsole ?? existing.spawnedByConsole,
      })
      return existing
    }

    const info: AssistantInfo = {
      id: opts.id ?? randomUUID(),
      name: payload.name,
      host: payload.host,
      port: payload.port,
      model: payload.model,
      provider: payload.provider,
      sessionId: payload.sessionId,
      channels: payload.channels ?? ['http'],
      ...(payload.channelEndpoints !== undefined ? { channelEndpoints: payload.channelEndpoints } : {}),
      status: 'online',
      registeredAt: now,
      lastHeartbeat: now,
      pid: opts.pid,
      spawnedByConsole: opts.spawnedByConsole ?? false,
    }
    this.assistants.set(info.id, info)
    return info
  }

  /** 记录一条心跳, 并标记为在线。 */
  heartbeat(id: string): AssistantInfo | null {
    const info = this.assistants.get(id)
    if (!info) return null
    info.lastHeartbeat = new Date().toISOString()
    info.status = 'online'
    return info
  }

  /** 注销并移除助手。 */
  unregister(id: string): boolean {
    return this.assistants.delete(id)
  }

  /** 返回单个助手。 */
  get(id: string): AssistantInfo | null {
    return this.assistants.get(id) ?? null
  }

  /** 列出所有助手 (按注册时间排序)。 */
  list(): AssistantInfo[] {
    return [...this.assistants.values()].sort((a, b) =>
      a.registeredAt.localeCompare(b.registeredAt),
    )
  }

  /** 按 sessionId 查找 (用于幂等注册)。 */
  findBySessionId(sessionId: string): AssistantInfo | null {
    for (const info of this.assistants.values()) {
      if (info.sessionId === sessionId) return info
    }
    return null
  }

  /** 已使用的端口集合 (用于 spawn 时分配空闲端口)。 */
  usedPorts(): Set<number> {
    return new Set([...this.assistants.values()].map(a => a.port))
  }
}
