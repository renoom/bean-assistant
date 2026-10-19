/**
 * 助手 → 控制台 注册/注销/心跳
 *
 * 助手进程启动后向控制台上报注册, 优雅退出时注销, 运行期间定期心跳。
 * 控制台据此维护助手元数据 (在线状态、端口、模型等)。
 *
 * @module assistant/registration
 */

// ── 类型 ────────────────────────────────────────────────────────────────────
import type { ChannelEndpoint } from './channel/types.js'

export interface RegisterPayload {
  name: string
  host: string
  port: number
  model: string
  provider: string
  sessionId: string
  /** 实际运行中的交互 Channel。 */
  channels: string[]
  channelEndpoints: ChannelEndpoint[]
}

export interface Registration {
  id: string
  dispose: () => void
}

// ── 上报逻辑 ────────────────────────────────────────────────────────────────

/**
 * 向控制台注册当前助手。返回控制台分配的 ID 与清理函数。
 * 注册失败不阻断助手运行 (助手可独立于控制台工作)。
 */
export async function registerWithConsole(
  consoleUrl: string,
  payload: RegisterPayload,
  heartbeatMs = 15000,
): Promise<Registration | null> {
  const base = consoleUrl.replace(/\/+$/, '')

  try {
    const res = await fetch(`${base}/api/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
    if (!res.ok) {
      console.warn(`[registration] 注册失败 (HTTP ${res.status})`)
      return null
    }
    const data = await res.json() as { id?: string }
    if (!data.id) return null

    console.log(`[registration] 已注册到控制台, id=${data.id}`)

    // 定期心跳
    const timer = setInterval(() => {
      fetch(`${base}/api/heartbeat/${data.id}`, { method: 'POST' }).catch(() => {
        // 心跳失败静默, 下次重试; 控制台会按心跳超时标记 offline
      })
    }, heartbeatMs)
    timer.unref?.()

    const dispose = () => {
      clearInterval(timer)
      // 进程退出时不再主动 DELETE /api/unregister。
      // 旧实现 fire-and-forget 注销与控制台 stopHandler 的 status=offline 之间
      // 存在 race（SIGTERM 触发 dispose → DELETE 与 stopHandler.onMutate 之间的
      // unawaited 写盘竞态，谁后写谁赢），会让点停止按钮的条目被彻底删除。
      // 现在的离线判定统一交给控制台：
      //   1) stopHandler / restartHandler 显式置 offline；
      //   2) 心跳超时扫描器置 offline（替代旧的自动 unregister）；
      //   3) 控制台重启后 loadAssistants 一律置 offline。
    }

    return { id: data.id, dispose }
  } catch (err) {
    console.warn('[registration] 无法连接控制台:', (err as Error).message)
    return null
  }
}
