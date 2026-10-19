#!/usr/bin/env node
/**
 * 回归验证入口：一次运行「类型检查 + 单元/集成测试」，覆盖 assistant 与 console。
 *
 * 用途：升级 dsh 内核或调整依赖后，用一条命令确认没有回归。
 *
 *   node automation/verify.mjs                 # 校验全部（默认）
 *   node automation/verify.mjs --only console  # 只测控制台
 *   node automation/verify.mjs --json          # 输出机器可读结果
 *   node automation/verify.mjs --kernel=/path/to/deepseek-harness
 *
 * 退出码：0 = 全部通过；1 = 有失败或环境异常。
 */

import { existsSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import {
  ASSISTANT_DIR,
  AUTOMATION_DIR,
  CONSOLE_DIR,
  color,
  discoverTestFiles,
  formatDuration,
  inspectLink,
  nodeMajor,
  parseArgs,
  parseTestSummary,
  readJson,
  readPin,
  renderTable,
  resolveKernelDir,
  REPO_ROOT,
  run,
} from './lib/util.mjs'

const STARTED_AT = Date.now()
const children = new Set()

function killChildren() {
  for (const child of children) {
    try {
      if (process.platform === 'win32') child.kill('SIGKILL')
      else process.kill(-child.pid, 'SIGKILL')
    } catch {
      /* 进程可能已经退出 */
    }
  }
}

process.on('SIGINT', () => {
  killChildren()
  process.exit(130)
})
process.on('SIGTERM', () => {
  killChildren()
  process.exit(143)
})

const { options } = parseArgs(process.argv.slice(2), {
  only: 'value',
  json: 'boolean',
  kernel: 'value',
  noTypecheck: 'boolean',
  noSecrets: 'boolean',
  timeout: 'value',
})

const jsonMode = options.json
const timeoutMs = options.timeout ? Number(options.timeout) * 1000 : 300_000
const only = options.only ?? 'all'
if (!['all', 'assistant', 'console'].includes(only)) {
  console.error(`--only 只支持 all / assistant / console，收到：${only}`)
  process.exit(2)
}
const targets = {
  assistant: only !== 'console',
  console: only !== 'assistant',
}

const log = (...args) => {
  if (!jsonMode) console.log(...args)
}
const warn = (message) => warnings.push(message)
const warnings = []
const errors = []

/** 记录内核仓库当前 git 提交（若可用）。 */
function kernelHead(kernelDir) {
  try {
    return execFileSync('git', ['-C', kernelDir, 'rev-parse', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
  } catch {
    return null
  }
}

/** 检查 node_modules 里的符号链接健康度。 */
function inspectLinkFarm(projectDir) {
  const scopeDir = path.join(projectDir, 'node_modules', '@deepseek-ai')
  if (!existsSync(scopeDir)) return { ok: false, total: 0, broken: [], reason: '缺少 node_modules/@deepseek-ai' }
  let entries = []
  try {
    entries = readdirSync(scopeDir)
  } catch {
    return { ok: false, total: 0, broken: [], reason: '无法读取 node_modules/@deepseek-ai' }
  }
  const broken = entries.filter((name) => !inspectLink(path.join(scopeDir, name)).resolves)
  return { ok: broken.length === 0, total: entries.length, broken }
}

/** 检查 package.json 的 test 脚本是否覆盖了全部测试文件（防止新增测试漏跑）。 */
function checkTestScriptDrift(projectDir) {
  const manifest = readJson(path.join(projectDir, 'package.json'))
  const script = manifest?.scripts?.test
  if (!script) return { declared: false, missing: [] }
  const tokens = script.split(/\s+/).filter((token) => token.startsWith('src/'))
  if (tokens.length === 0) return { declared: false, missing: [] }
  const declared = new Set()
  const all = discoverTestFiles(projectDir)
  for (const token of tokens) {
    if (!token.includes('*')) {
      declared.add(token)
      continue
    }
    const regex = globToRegExp(token)
    for (const file of all) if (regex.test(file)) declared.add(file)
  }
  return { declared: true, missing: all.filter((file) => !declared.has(file)) }
}

function globToRegExp(pattern) {
  let source = ''
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i]
    if (char === '*') {
      if (pattern[i + 1] === '*') {
        source += '.*'
        i++
        if (pattern[i + 1] === '/') i++
      } else {
        source += '[^/]*'
      }
    } else if (char === '?') {
      source += '[^/]'
    } else {
      source += char.replace(/[.+^${}()|[\]\\]/g, '\\$&')
    }
  }
  return new RegExp(`^${source}$`)
}

/** 解析项目内可执行的 tsc / tsx 入口。 */
function executablePath(projectDir, tool) {
  if (tool === 'typescript') {
    const bin = path.join(projectDir, 'node_modules', 'typescript', 'bin', 'tsc')
    return existsSync(bin) ? bin : null
  }
  if (tool === 'tsx') {
    const cli = path.join(projectDir, 'node_modules', 'tsx', 'dist', 'cli.mjs')
    return existsSync(cli) ? cli : null
  }
  return null
}

async function runStep(step) {
  const duration = () => formatDuration(Date.now() - step.startedAt)
  log(`\n${color.cyan('▶')} ${color.bold(step.label)}`)
  step.startedAt = Date.now()
  const result = await run(step.command, step.args, {
    cwd: step.cwd,
    timeoutMs,
    stream: !jsonMode,
    quiet: jsonMode,
    onSpawn: (child) => {
      children.add(child)
      child.on('close', () => children.delete(child))
    },
  })
  step.durationMs = result.durationMs
  step.exitCode = result.code
  step.timedOut = result.timedOut
  step.ok = result.ok
  step.output = result.output
  if (step.kind === 'test') {
    step.tests = parseTestSummary(result.output)
  }
  const mark = result.ok ? color.green('✔') : color.red('✘')
  const detail = []
  if (step.tests) {
    detail.push(`${step.tests.tests ?? '?'} 项测试`)
    detail.push(`${color.green(`${step.tests.pass ?? 0} 通过`)}`)
    if (step.tests.fail) detail.push(color.red(`${step.tests.fail} 失败`))
    if (step.tests.skipped) detail.push(color.yellow(`${step.tests.skipped} 跳过`))
  }
  if (result.timedOut) detail.push(color.red(`超时 ${formatDuration(timeoutMs)}`))
  if (!result.ok && result.code !== null) detail.push(color.red(`退出码 ${result.code}`))
  log(`${mark} ${step.label} ${color.gray(`(${duration()}${detail.length ? ' · ' + detail.join(' · ') : ''})`)}`)
  return step
}

function section(title) {
  log(`\n${color.magenta('━━━')} ${color.bold(title)} ${color.magenta('━━━')}`)
}

async function main() {
  const kernelDir = resolveKernelDir(options.kernel)
  const pin = readPin()

  section('环境检查')
  const node = process.versions.node
  log(`Node ${node} · ${process.platform}/${process.arch}`)
  if (nodeMajor() < 22) errors.push(`Node 版本过低（当前 ${node}，需要 >= 22）`)

  const assistantManifest = readJson(path.join(ASSISTANT_DIR, 'package.json'))
  const consoleManifest = readJson(path.join(CONSOLE_DIR, 'package.json'))
  if (!assistantManifest) errors.push('缺少 assistant/package.json')
  if (!consoleManifest) errors.push('缺少 console/package.json')

  let kernelReport = { dir: kernelDir, exists: existsSync(kernelDir), pinnedCommit: pin?.commit ?? null, head: null, matchesPin: null }
  if (kernelReport.exists) {
    kernelReport.head = kernelHead(kernelDir)
    if (pin?.commit && kernelReport.head) {
      kernelReport.matchesPin = kernelReport.head === pin.commit
      if (!kernelReport.matchesPin) {
        warn(
          `本地内核 HEAD ${kernelReport.head.slice(0, 7)} 与 kernel-pin.json 锁定 ${pin.commit.slice(0, 8)} 不一致；` +
            '如果刚升级内核，请同步更新 automation/kernel-pin.json。',
        )
      }
    }
    log(`内核 ${color.cyan(kernelDir)}${kernelReport.matchesPin === true ? color.green(' · 与 pin 一致') : ''}`)
  } else {
    warn(`未找到内核仓库 ${kernelDir}（可通过 --kernel 或 DSH_KERNEL_DIR 指定）`)
  }

  if (pin?.version) log(`锁定内核版本 ${color.bold(pin.version)} @ ${color.gray(pin.shortCommit ?? '')}`)

  section('依赖链接检查')
  for (const [name, dir] of [
    ['assistant', ASSISTANT_DIR],
    ['console', CONSOLE_DIR],
  ]) {
    if (name === 'assistant') {
      const farm = inspectLinkFarm(dir)
      if (!farm.ok) {
        const reason = farm.reason ?? `${farm.broken.length} 个链接失效（如 ${farm.broken.slice(0, 3).join('、')}）`
        errors.push(`${name} 依赖链接异常：${reason}。请运行 node automation/setup-links.mjs --kernel <内核目录>`)
        log(`${color.red('✘')} ${name} 依赖链接异常（${reason}）`)
      } else {
        log(`${color.green('✔')} ${name} 依赖链接 ${farm.total} 个，全部可用`)
        if (pin?.packageCount && farm.total !== pin.packageCount) {
          warn(`链接数 ${farm.total} 与 pin 记录的 ${pin.packageCount} 不一致，请在调整依赖后更新 kernel-pin.json`)
        }
      }
    } else {
      const tsx = executablePath(dir, 'tsx')
      if (!tsx) {
        errors.push('console 缺少 node_modules/tsx，请先在 console 目录安装依赖')
        log(`${color.red('✘')} console 缺少 tsx`)
      } else {
        log(`${color.green('✔')} console 测试运行时可用`)
      }
    }
  }

  section('测试入口一致性')
  for (const [name, dir] of [
    ['assistant', ASSISTANT_DIR],
    ['console', CONSOLE_DIR],
  ]) {
    const drift = checkTestScriptDrift(dir)
    if (!drift.declared) {
      warn(`${name}/package.json 没有可解析的 test 脚本，跳过一致性检查`)
      continue
    }
    if (drift.missing.length > 0) {
      warn(`${name} 有 ${drift.missing.length} 个测试未登记到 package.json test 脚本：${drift.missing.join('、')}`)
      log(`${color.yellow('!')} ${name} 有 ${drift.missing.length} 个测试未登记到 npm test（本脚本会自动发现并执行）`)
    } else {
      log(`${color.green('✔')} ${name} 测试文件全部登记在 npm test 中`)
    }
  }

  if (errors.length > 0) {
    section('无法继续')
    if (!jsonMode) for (const message of errors) console.error(`${color.red('✘')} ${message}`)
    return finish({ steps: [], kernel: kernelReport })
  }

  const steps = []
  const plan = []
  if (!options.noSecrets) {
    plan.push({
      id: 'secrets',
      label: '安全扫描 · 密钥 / 敏感文件 / 本机路径',
      kind: 'check',
      cwd: REPO_ROOT,
      command: process.execPath,
      args: [path.join(AUTOMATION_DIR, 'check-secrets.mjs')],
    })
  }
  if (targets.assistant) {
    const tsc = executablePath(ASSISTANT_DIR, 'typescript')
    const tsx = executablePath(ASSISTANT_DIR, 'tsx')
    if (!tsc) errors.push('assistant 缺少 node_modules/typescript，请运行 setup-links')
    if (!tsx) errors.push('assistant 缺少 node_modules/tsx，请运行 setup-links')
    if (tsc) {
      plan.push({
        id: 'assistant-typecheck',
        label: 'assistant · TypeScript 类型检查',
        kind: 'typecheck',
        cwd: ASSISTANT_DIR,
        command: process.execPath,
        args: [tsc, '--noEmit'],
      })
    }
    if (tsx) {
      plan.push({
        id: 'assistant-tests',
        label: `assistant · 测试（${discoverTestFiles(ASSISTANT_DIR).length} 个文件）`,
        kind: 'test',
        cwd: ASSISTANT_DIR,
        command: process.execPath,
        args: ['--import', 'tsx', '--test', 'src/**/*.test.ts'],
      })
    }
  }
  if (targets.console) {
    const tsc = executablePath(CONSOLE_DIR, 'typescript')
    const tsx = executablePath(CONSOLE_DIR, 'tsx')
    if (!tsc) errors.push('console 缺少 node_modules/typescript，请安装依赖')
    if (!tsx) errors.push('console 缺少 node_modules/tsx，请安装依赖')
    if (tsc) {
      plan.push({
        id: 'console-typecheck',
        label: 'console · TypeScript 类型检查',
        kind: 'typecheck',
        cwd: CONSOLE_DIR,
        command: process.execPath,
        args: [tsc, '--noEmit'],
      })
    }
    if (tsx) {
      plan.push({
        id: 'console-tests',
        label: `console · 测试（${discoverTestFiles(CONSOLE_DIR).length} 个文件）`,
        kind: 'test',
        cwd: CONSOLE_DIR,
        command: process.execPath,
        args: ['--import', 'tsx', '--test', 'src/**/*.test.ts'],
      })
    }
  }

  if (options.noTypecheck) {
    for (let i = plan.length - 1; i >= 0; i--) if (plan[i].kind === 'typecheck') plan.splice(i, 1)
  }

  section('执行验证')
  for (const step of plan) steps.push(await runStep(step))

  return finish({
    steps,
    kernel: kernelReport,
    baseline: pin?.baselines ?? null,
    warnings,
    errors,
  })
}

function summarize({ steps, baseline }) {
  const failures = steps.filter((step) => !step.ok)
  const testSteps = steps.filter((step) => step.kind === 'test')
  const totalPass = testSteps.reduce((sum, step) => sum + (step.tests?.pass ?? 0), 0)
  const totalFail = testSteps.reduce((sum, step) => sum + (step.tests?.fail ?? 0), 0)
  const totalTests = testSteps.reduce((sum, step) => sum + (step.tests?.tests ?? 0), 0)
  const baselineWarnings = []
  if (baseline) {
    for (const step of testSteps) {
      const expected = step.id === 'assistant-tests' ? baseline.assistantTests : step.id === 'console-tests' ? baseline.consoleTests : undefined
      const actual = step.tests?.pass ?? 0
      if (expected !== undefined && actual < expected) {
        baselineWarnings.push(`${step.label} 通过数 ${actual} 低于基线 ${expected}，请确认是否删改了测试`)
      }
    }
  }
  return { failures, testSteps, totalPass, totalFail, totalTests, baselineWarnings }
}

function finish({ steps, kernel, baseline, warnings: collectedWarnings = warnings, errors: collectedErrors = errors }) {
  const { failures, totalPass, totalFail, totalTests, testSteps, baselineWarnings } = summarize({ steps, baseline })
  const allWarnings = [...collectedWarnings, ...baselineWarnings]
  const ok = collectedErrors.length === 0 && failures.length === 0
  const durationMs = Date.now() - STARTED_AT

  if (!jsonMode) {
    section('结果')
    if (steps.length > 0) {
      const rows = steps.map((step) => [
        step.ok ? color.green('通过') : color.red('失败'),
        step.label,
        formatDuration(step.durationMs),
        step.tests ? `${step.tests.pass ?? 0}/${step.tests.tests ?? '?'}` : '-',
      ])
      console.log(renderTable(['状态', '步骤', '耗时', '用例'], rows))
      console.log(
        `\n测试合计：${color.green(`${totalPass} 通过`)} / ${totalFail ? color.red(`${totalFail} 失败`) : '0 失败'} / ${totalTests} 项` +
          ` · 总耗时 ${formatDuration(durationMs)}`,
      )
    }
    for (const message of allWarnings) console.log(`${color.yellow('⚠')} ${message}`)
    for (const message of collectedErrors) console.error(`${color.red('✘')} ${message}`)
    console.log(ok ? `\n${color.green('✔ 验证通过')}` : `\n${color.red('✘ 验证失败')}`)
  } else {
    const payload = {
      ok,
      generatedAt: new Date().toISOString(),
      durationMs,
      targets,
      kernel,
      warnings: allWarnings,
      errors: collectedErrors,
      tests: { total: totalTests, pass: totalPass, fail: totalFail },
      steps: steps.map((step) => ({
        id: step.id,
        label: step.label,
        kind: step.kind,
        ok: step.ok,
        durationMs: step.durationMs,
        exitCode: step.exitCode,
        timedOut: step.timedOut,
        tests: step.tests ?? null,
      })),
    }
    process.stdout.write(JSON.stringify(payload, null, 2) + '\n')
  }

  process.exitCode = ok ? 0 : 1
}

main().catch((error) => {
  console.error(color.red(`自动化验证崩溃：${error?.stack ?? error}`))
  process.exitCode = 2
})
