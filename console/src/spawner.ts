/**
 * 助手进程 spawner — child_process.spawn 启动独立助手进程
 *
 * 控制台"创建助手" = spawn 一个新的助手进程。助手通过 tsx 直接运行
 * 其 src/bin.ts (无需预先 build), 启动后自动向本控制台注册。
 *
 * 每个助手都是独立 OS 进程: 独立端口、独立 Agent、独立 Session。
 *
 * @module console/spawner
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'

// ── 路径解析 ───────────────────────────────────────────────────────────────

const CONSOLE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const PROJECT_ROOT = resolve(CONSOLE_DIR, '..')
const ASSISTANT_DIR = resolve(PROJECT_ROOT, 'assistant')
const ASSISTANT_BIN = resolve(ASSISTANT_DIR, 'src', 'bin.ts')
// tsx 的 JS 入口 (node_modules/.bin/tsx 是 shell shim, 需直接调用 cli.mjs)
const TSX_CLI = resolve(ASSISTANT_DIR, 'node_modules', 'tsx', 'dist', 'cli.mjs')

// ── 类型 ────────────────────────────────────────────────────────────────────

export interface SpawnOptions {
  name: string
  port: number
  host: string
  model: string
  provider: string
  consoleUrl: string
  persona?: string
  /** 稳定会话 ID；控制台 spawn/restart 时显式传入（默认随机生成，不按端口命名）。 */
  sessionId?: string
  /** 最大输出 token（冷字段，启动时固化）。 */
  maxTokens?: number
  /** 启用的交互 channel。 */
  channels?: string[]
}

export interface SpawnResult {
  pid: number
  port: number
  child: ChildProcess
}

// ── spawn ───────────────────────────────────────────────────────────────────

export function spawnAssistant(opts: SpawnOptions): SpawnResult {
  const args = [
    TSX_CLI,
    ASSISTANT_BIN,
    '--name', opts.name,
    '--host', opts.host,
    '--port', String(opts.port),
    '--model', opts.model,
    '--provider', opts.provider,
    '--console-url', opts.consoleUrl,
    '--session-id', opts.sessionId ?? `assistant-${randomUUID().slice(0, 8)}`,
  ]

  if (opts.persona) {
    args.push('--persona', opts.persona)
  }

  if (opts.maxTokens !== undefined) {
    args.push('--max-tokens', String(opts.maxTokens))
  }

  // 始终显式传 --channels（含空数组），避免助手端把「未传」误判成「默认全开」。
  if (opts.channels !== undefined) {
    args.push('--channels', opts.channels.join(','))
  }

  // 系统信息：助手源代码目录（工作空间之外的环境事实，创建时带给助手）
  args.push('--source-dir', ASSISTANT_DIR)

  const child = spawn(process.execPath, args, {
    cwd: ASSISTANT_DIR,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env },
  })

  // 把助手的 stdout/stderr 转发到控制台终端, 加 [assistant:name] 前缀便于区分
  const prefix = `[assistant:${opts.name}]`
  child.stdout?.on('data', (buf: Buffer) => {
    for (const line of buf.toString().split('\n')) {
      if (line.trim()) console.log(`${prefix} ${line}`)
    }
  })
  child.stderr?.on('data', (buf: Buffer) => {
    for (const line of buf.toString().split('\n')) {
      if (line.trim()) console.error(`${prefix} ${line}`)
    }
  })

  child.on('exit', (code) => {
    console.log(`[spawner] 助手进程退出: ${opts.name} (pid ${child.pid}, code ${code ?? 'signal'})`)
  })

  if (child.pid === undefined) {
    throw new Error(`spawn 助手失败: ${opts.name}`)
  }

  return { pid: child.pid, port: opts.port, child }
}

/** 分配一个未被占用的端口 (从 basePort 起递增)。 */
export function allocatePort(usedPorts: Set<number>, basePort = 3101): number {
  let port = basePort
  while (usedPorts.has(port)) port++
  return port
}
