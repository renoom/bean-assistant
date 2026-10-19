#!/usr/bin/env node
/**
 * 依赖链接重建：把 assistant/node_modules 里指向 dsh 内核源码的 workspace 链接重新生成。
 *
 * 背景：本工程用 `"workspace:*"` 引用内核包，实际解析依赖 `node_modules/@deepseek-ai/*`
 * 指向本地 deepseek-harness 源码目录。换机器、CI 或升级内核（切换到新目录/tag）后，
 * 用本脚本一键重建链接，再配合 verify.mjs 做回归。
 *
 *   node automation/setup-links.mjs --check                         # 检查现有链接是否健康
 *   node automation/setup-links.mjs --apply                         # 重建（默认内核目录）
 *   node automation/setup-links.mjs --kernel ../deepseek-harness-next --apply  # 指向候选内核
 *   node automation/setup-links.mjs --apply --dry-run               # 只打印计划
 */

import { existsSync, lstatSync, mkdirSync, readdirSync, readlinkSync, realpathSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { execFileSync } from 'node:child_process'
import {
  ASSISTANT_DIR,
  color,
  formatDuration,
  parseArgs,
  readJson,
  renderTable,
  resolveKernelDir,
} from './lib/util.mjs'
import { compare, max as maxVersion, parse } from './lib/semver.mjs'

const STARTED_AT = Date.now()
const { options } = parseArgs(process.argv.slice(2), {
  kernel: 'value',
  apply: 'boolean',
  check: 'boolean',
  dryRun: 'boolean',
  json: 'boolean',
})

const jsonMode = options.json
const mode = options.check ? 'check' : options.apply ? 'apply' : options.dryRun ? 'dry-run' : 'check'
const log = (...args) => {
  if (!jsonMode) console.log(...args)
}
const section = (title) => log(`\n${color.magenta('━━━')} ${color.bold(title)} ${color.magenta('━━━')}`)

const MANIFEST_FILE = path.join(ASSISTANT_DIR, 'node_modules', '.automation-links.json')
const MODULES = path.join(ASSISTANT_DIR, 'node_modules')

function readdirSafe(dir) {
  try {
    return readdirSync(dir, { withFileTypes: true })
  } catch {
    return []
  }
}

function kernelHead(kernelDir) {
  try {
    return execFileSync('git', ['-C', kernelDir, 'rev-parse', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
  } catch {
    return null
  }
}

/** 扫描内核源码里全部 @deepseek-ai 包目录。 */
function scanKernelPackages(kernelDir) {
  const map = new Map()
  const duplicates = []
  const add = (dir) => {
    const manifest = readJson(path.join(dir, 'package.json'))
    if (!manifest?.name) return
    if (map.has(manifest.name)) {
      duplicates.push(manifest.name)
      return
    }
    map.set(manifest.name, { dir, version: manifest.version })
  }
  for (const category of readdirSafe(path.join(kernelDir, 'packages'))) {
    if (!category.isDirectory()) continue
    for (const entry of readdirSafe(path.join(kernelDir, 'packages', category.name))) {
      if (entry.isDirectory()) add(path.join(kernelDir, 'packages', category.name, entry.name))
    }
  }
  for (const entry of readdirSafe(path.join(kernelDir, 'vendor'))) {
    if (entry.isDirectory()) add(path.join(kernelDir, 'vendor', entry.name))
  }
  for (const entry of readdirSafe(path.join(kernelDir, 'apps'))) {
    if (entry.isDirectory()) add(path.join(kernelDir, 'apps', entry.name))
  }
  const nativeRoot = path.join(kernelDir, 'native', 'landlock-run')
  add(nativeRoot)
  for (const entry of readdirSafe(path.join(nativeRoot, 'packages'))) {
    if (entry.isDirectory()) add(path.join(nativeRoot, 'packages', entry.name))
  }
  return { map, duplicates }
}

/** 从模块入口向上找到所属 package 目录。 */
function packageRootOf(entry, expectedName) {
  let dir = path.dirname(entry)
  for (let i = 0; i < 8; i++) {
    const manifest = readJson(path.join(dir, 'package.json'))
    if (manifest?.name === expectedName) return dir
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return null
}

/** 解析第三方依赖在 pnpm 仓库中的目录（direct → createRequire → .pnpm 扫描）。 */
function resolveThirdParty(kernelDir, name) {
  const direct = path.join(kernelDir, 'node_modules', ...name.split('/'))
  if (existsSync(path.join(direct, 'package.json'))) return { dir: realpathSync(direct), source: 'direct' }

  try {
    const require = createRequire(path.join(kernelDir, 'package.json'))
    const entry = require.resolve(name)
    const dir = packageRootOf(entry, name)
    if (dir) return { dir: realpathSync(dir), source: 'resolve' }
  } catch {
    /* 类型包或未提升依赖走 .pnpm 回退 */
  }

  const store = path.join(kernelDir, 'node_modules', '.pnpm')
  const encoded = name.replace('/', '+')
  const candidates = readdirSafe(store)
    .filter((entry) => entry.isDirectory() && entry.name.startsWith(`${encoded}@`))
    .map((entry) => {
      const version = entry.name.slice(`${encoded}@`.length).split('_')[0]
      return { dir: path.join(store, entry.name, 'node_modules', ...name.split('/')), version }
    })
    .filter((candidate) => parse(candidate.version) && existsSync(path.join(candidate.dir, 'package.json')))
  if (candidates.length === 0) return null
  const best = candidates.sort((a, b) => compare(a.version, b.version))[candidates.length - 1]
  return { dir: best.dir, source: '.pnpm', version: best.version }
}

function linkTarget(linkPath) {
  try {
    return readlinkSync(linkPath)
  } catch {
    return null
  }
}

function resolvedTarget(linkPath) {
  try {
    return realpathSync(linkPath)
  } catch {
    return null
  }
}

function relativeLink(fromDir, target) {
  return path.relative(fromDir, target) || '.'
}

function main() {
  const kernelDir = resolveKernelDir(options.kernel)
  const manifest = readJson(path.join(ASSISTANT_DIR, 'package.json'))
  if (!manifest) throw new Error('缺少 assistant/package.json')
  if (!existsSync(kernelDir)) {
    console.error(color.red(`内核目录不存在：${kernelDir}`))
    process.exitCode = 2
    return
  }

  const head = kernelHead(kernelDir)
  log(`${color.bold('Bean Assistant')} 内核依赖链接${mode === 'check' ? '检查' : mode === 'apply' ? '重建' : '计划（dry-run）'}`)
  log(`内核目录 ${color.cyan(kernelDir)}${head ? color.gray(` · HEAD ${head.slice(0, 8)}`) : ''}`)
  log(`模式 ${color.bold(mode)}`)

  const { map, duplicates } = scanKernelPackages(kernelDir)
  if (duplicates.length) log(`${color.yellow('⚠')} 内核中存在重名包：${[...new Set(duplicates)].join('、')}`)

  const dependencies = manifest.dependencies ?? {}
  const devDependencies = manifest.devDependencies ?? {}
  const kernelNames = Object.keys(dependencies).filter((name) => name.startsWith('@deepseek-ai/'))
  const thirdPartyNames = [...new Set([...Object.keys(dependencies), ...Object.keys(devDependencies)])].filter(
    (name) => !name.startsWith('@deepseek-ai/'),
  )

  /** @type {{name: string, link: string, target: string|null, source: string, version?: string, required: boolean, error?: string}[]} */
  const plan = []
  const errors = []
  const warnings = []

  for (const name of kernelNames) {
    const short = name.slice('@deepseek-ai/'.length)
    const link = path.join(MODULES, '@deepseek-ai', short)
    const found = map.get(name)
    if (!found) {
      errors.push(`内核源码中找不到 ${name}（可能已删除或改名，请同步更新 assistant/package.json）`)
      plan.push({ name, link, target: null, source: 'kernel', required: true, error: '内核中不存在' })
      continue
    }
    plan.push({ name, link, target: found.dir, source: 'kernel', version: found.version, required: true })
  }

  for (const name of thirdPartyNames) {
    const parts = name.split('/')
    const link = path.join(MODULES, ...parts)
    const found = resolveThirdParty(kernelDir, name)
    if (!found) {
      warnings.push(`内核 node_modules 中找不到 ${name}，跳过（本工程未实际安装该依赖）`)
      plan.push({ name, link, target: null, source: 'third-party', required: false, error: '未安装' })
      continue
    }
    const version = readJson(path.join(found.dir, 'package.json'))?.version
    plan.push({ name, link, target: found.dir, source: 'third-party', version, required: false })
  }

  // .bin 工具链接
  const binPlan = []
  const kernelBin = path.join(kernelDir, 'node_modules', '.bin')
  for (const tool of ['tsx', 'tsc', 'tsserver']) {
    const target = path.join(kernelBin, tool)
    if (!existsSync(target)) continue
    binPlan.push({ name: tool, link: path.join(MODULES, '.bin', tool), target })
  }

  section('链接计划')
  const kernelLinks = plan.filter((item) => item.source === 'kernel' && item.target)
  const thirdLinks = plan.filter((item) => item.source === 'third-party' && item.target)
  const missing = plan.filter((item) => !item.target)
  log(`内核包 ${color.bold(String(kernelLinks.length))} 个 · 第三方 ${color.bold(String(thirdLinks.length))} 个 · 工具 ${binPlan.length} 个`)
  if (missing.length) {
    log(`${color.yellow('!')} 无法解析 ${missing.length} 个：`)
    for (const item of missing) log(`   - ${item.name}${item.error ? `（${item.error}）` : ''}`)
  }
  if (mode !== 'check') {
    const rows = plan
      .filter((item) => item.target)
      .slice(0, options.json ? 0 : 200)
      .map((item) => [item.source === 'kernel' ? '内核' : '第三方', item.name, item.version ?? '-', path.relative(ASSISTANT_DIR, item.target)])
    if (rows.length) log(renderTable(['类型', '包', '版本', '目标'], rows))
  }

  // 检查模式：逐项校验现有链接
  if (mode === 'check') {
    section('链接健康度')
    const issues = []
    for (const item of plan) {
      if (!item.target) continue
      const current = resolvedTarget(item.link)
      const expected = realpathSync(item.target)
      if (!current) {
        issues.push({ ...item, issue: existsSync(item.link) ? '不是有效的链接' : '缺失' })
      } else if (current !== expected) {
        issues.push({ ...item, issue: `指向 ${path.relative(ASSISTANT_DIR, current)}` })
      }
    }
    for (const item of binPlan) {
      if (!existsSync(item.link)) issues.push({ ...item, source: 'bin', issue: '缺失' })
    }
    const stored = readJson(MANIFEST_FILE)
    if (stored?.kernelDir && path.resolve(stored.kernelDir) !== path.resolve(kernelDir)) {
      warnings.push(`链接是相对内核 ${stored.kernelDir} 建立的，本次检查的是 ${kernelDir}`)
    }
    if (issues.length === 0) {
      log(`${color.green('✔')} 全部 ${plan.filter((item) => item.target).length + binPlan.length} 个链接健康`)
    } else {
      const rows = issues.map((item) => [item.source === 'bin' ? '工具' : item.source === 'kernel' ? '内核' : '第三方', item.name, item.issue])
      log(renderTable(['类型', '包', '问题'], rows))
      log(`\n${color.yellow('!')} 共 ${issues.length} 个链接需要重建，运行：${color.cyan('node automation/setup-links.mjs --apply')}`)
    }
    for (const message of warnings) log(`${color.yellow('⚠')} ${message}`)
    for (const message of errors) log(`${color.red('✘')} ${message}`)

    const ok = issues.length === 0 && errors.length === 0
    if (jsonMode) {
      process.stdout.write(
        JSON.stringify(
          {
            ok,
            mode,
            kernelDir,
            kernelHead: head,
            links: plan.filter((item) => item.target).length + binPlan.length,
            issues: issues.map(({ name, source, issue }) => ({ name, source, issue })),
            warnings,
            errors,
            durationMs: Date.now() - STARTED_AT,
          },
          null,
          2,
        ) + '\n',
      )
    }
    process.exitCode = ok ? 0 : 1
    return
  }

  if (mode === 'dry-run') {
    log(`\n${color.gray('dry-run：未写入任何文件。去掉 --dry-run 并加 --apply 执行。')}`)
    process.exitCode = 0
    return
  }

  // 执行重建
  section('写入链接')
  const scopeDir = path.join(MODULES, '@deepseek-ai')
  mkdirSync(scopeDir, { recursive: true })
  mkdirSync(path.join(MODULES, '.bin'), { recursive: true })

  let created = 0
  let replaced = 0
  let removed = 0

  const ensureLink = (link, target) => {
    const relative = relativeLink(path.dirname(link), target)
    let current = null
    try {
      current = readlinkSync(link)
    } catch {
      if (existsSync(link)) {
        // 非符号链接（真实目录）不覆盖，避免误删
        throw new Error(`${link} 是真实目录，拒绝覆盖`)
      }
    }
    if (current === relative) return 'same'
    if (current !== null) replaced++
    else created++
    if (current !== null) removeLinkEntry(link)
    symlinkSync(relative, link, 'dir')
    return current === null ? 'created' : 'replaced'
  }

  for (const item of plan) {
    if (!item.target) continue
    try {
      ensureLink(item.link, item.target)
    } catch (error) {
      errors.push(String(error.message ?? error))
    }
  }
  for (const item of binPlan) {
    if (existsSync(item.link)) continue
    try {
      symlinkSync(relativeLink(path.dirname(item.link), item.target), item.link)
      created++
    } catch (error) {
      warnings.push(`工具链接 ${item.name} 跳过：${error.message ?? error}`)
    }
  }

  // 清理不再需要的旧链接
  const expected = new Set(plan.filter((item) => item.target).map((item) => path.basename(item.link)))
  for (const entry of readdirSafe(scopeDir)) {
    if (!entry.isSymbolicLink()) continue
    if (!expected.has(entry.name)) {
      removeLinkEntry(path.join(scopeDir, entry.name))
      removed++
    }
  }

  // 记录清单，供 verify 与后续升级对比
  const versions = Object.fromEntries(plan.filter((item) => item.version).map((item) => [item.name, item.version]))
  writeFileSync(
    MANIFEST_FILE,
    JSON.stringify(
      {
        kernelDir,
        kernelHead: head,
        createdAt: new Date().toISOString(),
        mode,
        links: plan.filter((item) => item.target).length + binPlan.length,
        versions,
      },
      null,
      2,
    ) + '\n',
    'utf8',
  )

  log(`${color.green('✔')} 新建 ${created} · 更新 ${replaced} · 清理 ${removed} · 清单 ${path.relative(ASSISTANT_DIR, MANIFEST_FILE)}`)
  if (errors.length) for (const message of errors) log(`${color.red('✘')} ${message}`)
  for (const message of warnings) log(`${color.yellow('⚠')} ${message}`)
  log(`\n下一步：${color.cyan('node automation/verify.mjs')} 运行回归。总耗时 ${formatDuration(Date.now() - STARTED_AT)}`)
  process.exitCode = errors.length ? 1 : 0
}

/** 删除 node_modules 条目：只允许删除符号链接，真实目录一律拒绝。 */
function removeLinkEntry(link) {
  const stat = lstatSync(link)
  if (stat.isSymbolicLink()) {
    unlinkSync(link)
    return
  }
  throw new Error(`${link} 是真实目录，拒绝覆盖（请手动确认后再处理）`)
}


main()
