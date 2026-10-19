/**
 * 自动化脚本共享工具：路径解析、终端输出、进程执行、表格渲染。
 *
 * 设计原则：
 *  - 零第三方依赖，只使用 Node 内置模块；
 *  - 所有脚本都能在仓库任意位置通过 `node automation/xxx.mjs` 运行；
 *  - 输出默认面向人，`--json` 时面向机器。
 */

import { spawn } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, lstatSync, readlinkSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/** 仓库根目录（automation/ 的上一级）。 */
export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
export const ASSISTANT_DIR = path.join(REPO_ROOT, 'assistant')
export const CONSOLE_DIR = path.join(REPO_ROOT, 'console')
export const AUTOMATION_DIR = path.join(REPO_ROOT, 'automation')
export const PIN_FILE = path.join(AUTOMATION_DIR, 'kernel-pin.json')

const supportsColor = process.stdout.isTTY && !process.env.NO_COLOR && process.env.TERM !== 'dumb'

const CODES = {
  reset: '\u001b[0m',
  bold: '\u001b[1m',
  dim: '\u001b[2m',
  red: '\u001b[31m',
  green: '\u001b[32m',
  yellow: '\u001b[33m',
  blue: '\u001b[34m',
  magenta: '\u001b[35m',
  cyan: '\u001b[36m',
  gray: '\u001b[90m',
}

export function paint(code, text) {
  return supportsColor ? `${CODES[code]}${text}${CODES.reset}` : String(text)
}

export const color = {
  bold: (t) => paint('bold', t),
  dim: (t) => paint('dim', t),
  red: (t) => paint('red', t),
  green: (t) => paint('green', t),
  yellow: (t) => paint('yellow', t),
  blue: (t) => paint('blue', t),
  magenta: (t) => paint('magenta', t),
  cyan: (t) => paint('cyan', t),
  gray: (t) => paint('gray', t),
}

/** 读取 JSON 文件；不存在时返回 null。 */
export function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

/** 读取内核版本锁定文件。 */
export function readPin() {
  return readJson(PIN_FILE)
}

/**
 * 解析内核仓库目录。
 * 优先级：--kernel 参数 > DSH_KERNEL_DIR > 默认同级目录（../../deepseek-harness）。
 */
export function resolveKernelDir(explicit) {
  const candidates = [
    explicit,
    process.env.DSH_KERNEL_DIR,
    path.resolve(REPO_ROOT, '..', '..', 'deepseek-harness'),
  ].filter(Boolean)
  for (const candidate of candidates) {
    if (existsSync(path.join(candidate, 'packages'))) return path.resolve(candidate)
  }
  return path.resolve(candidates[0] ?? path.resolve(REPO_ROOT, '..', '..', 'deepseek-harness'))
}

/**
 * 最小化参数解析：支持 --flag、--key=value、--key value。
 * @param {string[]} argv
 * @param {Record<string, 'boolean'|'value'>} schema
 */
export function parseArgs(argv, schema) {
  const options = {}
  for (const [key, kind] of Object.entries(schema)) {
    options[key] = kind === 'boolean' ? false : undefined
  }
  const positional = []
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--') {
      positional.push(...argv.slice(i + 1))
      break
    }
    if (!arg.startsWith('--')) {
      positional.push(arg)
      continue
    }
    const eq = arg.indexOf('=')
    const name = (eq === -1 ? arg.slice(2) : arg.slice(2, eq)).replace(/-([a-z])/g, (_, c) => c.toUpperCase())
    if (!(name in schema)) {
      throw new Error(`未知参数：${arg}（可用：${Object.keys(schema).map((k) => `--${k}`).join('、')}）`)
    }
    if (schema[name] === 'boolean') {
      options[name] = eq === -1 ? true : !['0', 'false', 'no'].includes(arg.slice(eq + 1))
    } else {
      options[name] = eq === -1 ? argv[++i] : arg.slice(eq + 1)
      if (options[name] === undefined) throw new Error(`参数 ${arg} 需要一个值`)
    }
  }
  return { options, positional }
}

/**
 * 执行子进程并流式输出，返回退出码、耗时与完整输出。
 * 超时会杀掉整个进程组（POSIX）避免测试挂死。
 */
export function run(command, args, { cwd = REPO_ROOT, timeoutMs = 300_000, env, quiet = false, stream = true, onSpawn } = {}) {
  return new Promise((resolve) => {
    const startedAt = Date.now()
    const child = spawn(command, args, {
      cwd,
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
    })
    onSpawn?.(child)
    const chunks = []
    const onData = (chunk) => {
      chunks.push(chunk)
      if (stream && !quiet) process.stdout.write(chunk)
    }
    child.stdout.on('data', onData)
    child.stderr.on('data', onData)
    let timedOut = false
    let killTimer
    const timer = setTimeout(() => {
      timedOut = true
      try {
        if (process.platform === 'win32') child.kill('SIGKILL')
        else process.kill(-child.pid, 'SIGKILL')
      } catch {
        child.kill('SIGKILL')
      }
    }, timeoutMs)
    killTimer = timer
    child.on('error', (error) => {
      clearTimeout(timer)
      resolve({
        ok: false,
        code: null,
        signal: null,
        timedOut,
        durationMs: Date.now() - startedAt,
        output: String(error?.message ?? error),
      })
    })
    child.on('close', (code, signal) => {
      clearTimeout(killTimer)
      resolve({
        ok: code === 0 && !timedOut,
        code,
        signal,
        timedOut,
        durationMs: Date.now() - startedAt,
        output: Buffer.concat(chunks).toString('utf8'),
      })
    })
  })
}

/** 读取 Node 测试运行器（TAP）输出中的统计信息。 */
export function parseTestSummary(output) {
  const pick = (label) => {
    const match = output.match(new RegExp(`ℹ\\s+${label}\\s+(\\d+)`))
    return match ? Number(match[1]) : undefined
  }
  const summary = {
    tests: pick('tests'),
    pass: pick('pass'),
    fail: pick('fail'),
    cancelled: pick('cancelled'),
    skipped: pick('skipped'),
  }
  return Object.values(summary).some((value) => value !== undefined) ? summary : null
}

/** 收集目录下所有 *.test.ts 相对路径（不进入 node_modules）。 */
export function discoverTestFiles(dir) {
  const results = []
  const walk = (current) => {
    let entries
    try {
      entries = readdirSync(current, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (entry.name === 'node_modules' || entry.name === 'lib' || entry.name.startsWith('.')) continue
      const full = path.join(current, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (entry.name.endsWith('.test.ts')) results.push(path.relative(dir, full).split(path.sep).join('/'))
    }
  }
  walk(dir)
  return results.sort()
}

/** 判断符号链接的健康状态。 */
export function inspectLink(linkPath) {
  try {
    const stat = lstatSync(linkPath)
    if (!stat.isSymbolicLink()) return { exists: true, symlink: false, target: null, resolves: existsSync(linkPath) }
    return { exists: true, symlink: true, target: readlinkSync(linkPath), resolves: existsSync(linkPath) }
  } catch {
    return { exists: false, symlink: false, target: null, resolves: false }
  }
}

/** 简易表头分隔线宽度（按字符数估算，中文按 2 列宽）。 */
export function displayWidth(text) {
  let width = 0
  for (const char of String(text)) {
    width += /[\u1100-\u115F\u2E80-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE6F\uFF00-\uFF60\uFFE0-\uFFE6]/.test(char) ? 2 : 1
  }
  return width
}

/** 渲染 ASCII 表格。 */
export function renderTable(headers, rows, { align = [] } = {}) {
  const widths = headers.map((header, index) =>
    Math.max(displayWidth(header), ...rows.map((row) => displayWidth(row[index] ?? ''))),
  )
  const pad = (text, width, index) => {
    const gap = width - displayWidth(text ?? '')
    if (align[index] === 'right') return ' '.repeat(gap) + (text ?? '')
    return (text ?? '') + ' '.repeat(gap)
  }
  const line = (left, mid, right) => left + widths.map((w) => '─'.repeat(w + 2)).join(mid) + right
  const renderRow = (row) => '│ ' + row.map((cell, i) => pad(cell ?? '', widths[i], i)).join(' │ ') + ' │'
  return [
    line('┌', '┬', '┐'),
    renderRow(headers),
    line('├', '┼', '┤'),
    ...rows.map(renderRow),
    line('└', '┴', '┘'),
  ].join('\n')
}

/** 把毫秒格式化为人类可读时长。 */
export function formatDuration(ms) {
  if (ms < 1000) return `${ms}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(2)}s`
  return `${Math.floor(ms / 60_000)}m${Math.round((ms % 60_000) / 1000)}s`
}

/** 统一读取本地已安装包版本。 */
export function readInstalledVersion(dir, name) {
  const manifest = path.join(dir, 'node_modules', ...name.split('/'), 'package.json')
  const json = readJson(manifest)
  return json?.version ?? null
}

/** 当前环境的 Node 主版本。 */
export function nodeMajor() {
  return Number(process.versions.node.split('.')[0])
}
