#!/usr/bin/env node
/**
 * 依赖版本巡检：对比本工程已安装的内核/第三方依赖与 npm registry 上的最新版本。
 *
 * 用途：升级 dsh 内核前先确认「有哪些新版本、新版本落在哪条发布线」。
 *
 *   node automation/check-updates.mjs                 # 摘要（推荐）
 *   node automation/check-updates.mjs --all           # 打印全部 94 个内核包
 *   node automation/check-updates.mjs --json          # 机器可读输出
 *   node automation/check-updates.mjs --refresh       # 忽略缓存，强制访问 registry
 *   node automation/check-updates.mjs --fail-on-update # 有可用更新时退出码为 1（可接 CI）
 *
 * 说明：dsh 的 npm `latest` 标签存在历史遗留（部分包停在 0.0.1-rc.1），
 * 因此本脚本同时展示 latest / next / alpha，并以「实际最大版本」作为候选升级线。
 */

import path from 'node:path'
import {
  ASSISTANT_DIR,
  color,
  formatDuration,
  parseArgs,
  readInstalledVersion,
  readJson,
  readPin,
  renderTable,
  resolveKernelDir,
} from './lib/util.mjs'
import { compare, max as maxVersion, satisfies } from './lib/semver.mjs'
import { describeCache, resolvePackages } from './lib/registry.mjs'

const STARTED_AT = Date.now()
const { options } = parseArgs(process.argv.slice(2), {
  json: 'boolean',
  kernel: 'value',
  offline: 'boolean',
  refresh: 'boolean',
  all: 'boolean',
  failOnUpdate: 'boolean',
  concurrency: 'value',
})

const jsonMode = options.json
const log = (...args) => {
  if (!jsonMode) console.log(...args)
}
const section = (title) => log(`\n${color.magenta('━━━')} ${color.bold(title)} ${color.magenta('━━━')}`)

const VENDOR = /^@deepseek-ai\/(cordis|cosmokit|schemastery)(-|$)/
const isVendor = (name) => VENDOR.test(name) || name.startsWith('@deepseek-ai/cordis-plugin')
const isKernel = (name) => name.startsWith('@deepseek-ai/dsh-')

function classify(name) {
  if (isVendor(name)) return 'vendor'
  if (isKernel(name)) return 'core'
  return 'third'
}

/** 提取最值得参考的版本标签。 */
function pickTag(doc, version) {
  const tags = doc?.tags ?? {}
  return Object.entries(tags).find(([, value]) => value === version)?.[0] ?? null
}

function statusOf(item) {
  if (item.error) return '请求失败'
  if (!item.local) return color.yellow('未安装')
  if (item.isUpdate) return color.green('可升级')
  return color.gray('已最新')
}

function describeError(pkg) {
  if (pkg?.missing) return 'registry 无此包'
  if (pkg?.error) return `请求失败：${pkg.error}`
  return null
}

async function main() {
  const kernelDir = resolveKernelDir(options.kernel)
  const pin = readPin()
  const manifest = readJson(path.join(ASSISTANT_DIR, 'package.json'))
  if (!manifest) throw new Error('缺少 assistant/package.json')

  const kernelNames = Object.keys(manifest.dependencies ?? {}).filter((name) => name.startsWith('@deepseek-ai/'))
  const thirdPartyNames = [
    ...Object.keys(manifest.dependencies ?? {}),
    ...Object.keys(manifest.devDependencies ?? {}),
  ].filter((name) => !name.startsWith('@deepseek-ai/'))

  log(`${color.bold('Bean Assistant')} 依赖版本巡检 · ${new Date().toLocaleString('zh-CN')}`)
  log(`内核目录 ${color.cyan(kernelDir)}${pin ? ` · 锁定 ${color.bold(pin.version)} @ ${color.gray(pin.shortCommit)}` : ''}`)
  log(`待检查：内核包 ${kernelNames.length} 个 · 第三方 ${thirdPartyNames.length} 个`)

  section('访问 npm registry')
  const started = Date.now()
  let progressShown = false
  const { packages, fetchedAt, cached, network, errors } = await resolvePackages(
    [...kernelNames, ...thirdPartyNames],
    {
      offline: options.offline,
      refresh: options.refresh,
      concurrency: options.concurrency ? Number(options.concurrency) : 8,
      onProgress: (name, total) => {
        if (jsonMode || progressShown) return
        progressShown = true
        process.stdout.write(color.gray(`  拉取 ${total} 个包元数据…\n`))
      },
    },
  )
  log(`${color.green('✔')} ${describeCache({ fetchedAt, cached, network, errors })} · ${formatDuration(Date.now() - started)}`)
  if (options.offline && cached === 0) throw new Error('离线模式但没有可用缓存，请先联网运行一次')

  const analyze = (name) => {
    const doc = packages[name]
    const local = readInstalledVersion(ASSISTANT_DIR, name)
    const error = describeError(doc)
    const versions = doc?.versions ?? []
    const tags = doc?.tags ?? {}
    const group = classify(name)
    const newest = error ? null : group === 'core' ? maxVersion(versions) : (tags.latest ?? maxVersion(versions))
    const isUpdate = local && newest ? compare(newest, local) > 0 : null
    return {
      name,
      group,
      local,
      newest,
      tags: { latest: tags.latest ?? null, next: tags.next ?? null, alpha: tags.alpha ?? null },
      tagOfNewest: pickTag(doc, newest),
      localPublished: local ? versions.includes(local) : null,
      isUpdate,
      error,
    }
  }

  const kernel = kernelNames.map(analyze)
  const third = thirdPartyNames.map(analyze)

  const core = kernel.filter((item) => item.group === 'core')
  const vendor = kernel.filter((item) => item.group === 'vendor')

  // 以「出现次数最多的最新版本」作为候选升级线
  const distribution = new Map()
  for (const item of core) {
    if (!item.newest) continue
    distribution.set(item.newest, (distribution.get(item.newest) ?? 0) + 1)
  }
  const headline = [...distribution.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null
  const headlineTag = core.find((item) => item.newest === headline)?.tagOfNewest ?? null
  const headlineDoc = packages['@deepseek-ai/dsh-agent']
  const latestLine = headlineDoc?.tags?.latest ?? null

  const coreUpdates = core.filter((item) => item.isUpdate)
  const coreCurrent = core.filter((item) => item.isUpdate === false)
  const coreErrored = core.filter((item) => item.error)
  const coreOfflineLine = core.filter((item) => item.newest && headline && item.newest !== headline)
  const vendorUpdates = vendor.filter((item) => item.isUpdate)
  const thirdUpdates = third.filter((item) => item.isUpdate)

  section('版本结论')
  if (headline) {
    const labels = [
      headlineTag ? `npm ${color.cyan(headlineTag)} 线` : null,
      latestLine ? `npm latest = ${latestLine}` : null,
    ].filter(Boolean)
    const onHeadline = core.filter((item) => item.newest === headline).length
    log(
      `候选升级线：${color.bold(headline)}（${onHeadline} 个内核包）` +
        `${labels.length ? ` · ${labels.join(' · ')}` : ''} · 共 ${coreUpdates.length} 个可升级`,
    )
  }
  if (coreErrored.length) log(`${color.yellow('⚠')} ${coreErrored.length} 个内核包元数据获取失败`)
  const summary = {
    kernel: {
      total: kernel.length,
      core: core.length,
      vendor: vendor.length,
      updates: coreUpdates.length + vendorUpdates.length,
      current: coreCurrent.length,
      errored: coreErrored.length,
      headline,
      headlineTag,
      latest: latestLine,
    },
    thirdParty: { total: third.length, updates: thirdUpdates.length },
  }

  const localSnapshot = core.filter((item) => item.localPublished === false)
  if (localSnapshot.length > 0) {
    log(
      `${color.yellow('!')} 本地 dsh 包版本 ${localSnapshot[0].local} 是未发布快照（${localSnapshot.length}/${core.length} 个包），` +
        `npm 上该代码线的首发版本是 ${pin?.publishedAs ?? '0.1.0-rc.6'}；版本判断以 kernel-pin.json 为准。`,
    )
  }

  section(`内核包 · dsh（${core.length} 个）`)
  log(
    `${color.green(`${coreUpdates.length} 可升级`)} · ${color.gray(`${coreCurrent.length} 已最新`)}` +
      (coreErrored.length ? ` · ${color.red(`${coreErrored.length} 获取失败`)}` : ''),
  )
  if (distribution.size > 1) {
    const rows = [...distribution.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([version, count]) => [version, String(count)])
    log(`\n最新版本分布：\n${renderTable(['版本', '包数'], rows)}`)
  }
  if (coreOfflineLine.length > 0) {
    log(`\n${color.yellow('偏离候选线')}（这些包的最新版本与主线不同，可能是退役包或独立版本线）：`)
    const rows = coreOfflineLine.map((item) => [
      item.name,
      item.local ?? '未安装',
      item.newest ?? '?',
      item.tagOfNewest ?? '-',
      item.localPublished === false ? '本地快照未发布' : '',
    ])
    log(renderTable(['包', '本地', '最新', '标签', '备注'], rows))
  }
  if (options.all) {
    log(`\n全部内核包：`)
    const rows = core.map((item) => [
      item.name,
      item.local ?? '未安装',
      item.newest ?? (item.error ? '请求失败' : '-'),
      statusOf(item),
    ])
    log(renderTable(['包', '本地', '最新', '状态'], rows))
  }

  if (vendor.length > 0) {
    section(`框架包 · vendor（${vendor.length} 个）`)
    const rows = vendor.map((item) => [
      item.name,
      item.local ?? '未安装',
      item.newest ?? (item.error ? '请求失败' : '-'),
      item.tagOfNewest ?? '-',
      statusOf(item),
    ])
    log(renderTable(['包', '本地', '最新', '标签', '状态'], rows))
  }

  section(`第三方依赖（${third.length} 个）`)
  const declared = (name) => manifest.dependencies?.[name] ?? manifest.devDependencies?.[name] ?? null
  const thirdRows = third.map((item) => {
    const range = declared(item.name)
    const verified = item.local && range ? (satisfies(item.local, range) ? '' : '声明范围不满足') : ''
    return [
      item.name,
      range ?? '-',
      item.local ?? color.yellow('未安装'),
      item.newest ?? (item.error ? '请求失败' : '-'),
      statusOf(item),
      verified,
    ]
  })
  log(
    renderTable(['包', '声明范围', '已安装', '最新', '状态', '备注'], thirdRows, {
      align: ['left', 'left', 'left', 'left', 'left', 'left'],
    }),
  )
  const mismatches = third.filter((item) => {
    const range = declared(item.name)
    return item.local && range && !satisfies(item.local, range)
  })
  for (const item of mismatches) {
    log(
      `${color.yellow('⚠')} ${item.name} 的实际安装版本 ${item.local} 不满足 package.json 声明的 ${declared(item.name)}` +
        `（通常是 pnpm workspace 提升导致）`,
    )
  }

  section('建议')
  if (coreUpdates.length > 0) {
    log(`1. 升级内核到 ${color.bold(headline)}：切到 deepseek-harness 对应 tag/提交，然后运行`)
    log(`   ${color.cyan('node automation/setup-links.mjs --kernel <新内核目录> --apply')}`)
    log(`2. 回归验证：${color.cyan('node automation/verify.mjs')}`)
    log(`3. 通过后同步 automation/kernel-pin.json 的 commit/version/baselines`)
  } else {
    log(`${color.green('✔')} 当前已是最新内核线（${headline ?? '未知'}）`)
  }
  log(`${color.gray('提示：加 --all 查看全部内核包明细；--fail-on-update 可用于流水线门禁。')}`)

  if (!jsonMode) log(`\n总耗时 ${formatDuration(Date.now() - STARTED_AT)}`)

  if (jsonMode) {
    process.stdout.write(
      JSON.stringify(
        {
          generatedAt: new Date().toISOString(),
          kernelDir,
          pin: pin ? { version: pin.version, commit: pin.commit } : null,
          summary,
          core: core.map(({ name, local, newest, tags, tagOfNewest, isUpdate, localPublished, error }) => ({
            name,
            local,
            newest,
            tags,
            tagOfNewest,
            isUpdate,
            localPublished,
            error,
          })),
          vendor: vendor.map(({ name, local, newest, tagOfNewest, isUpdate }) => ({ name, local, newest, tagOfNewest, isUpdate })),
          thirdParty: third.map(({ name, local, newest, isUpdate }) => ({ name, local, newest, isUpdate, declared: declared(name) })),
        },
        null,
        2,
      ) + '\n',
    )
  }

  const updates = coreUpdates.length + vendorUpdates.length + thirdUpdates.length
  if (options.failOnUpdate && updates > 0) {
    if (!jsonMode) console.error(color.red(`✘ 存在 ${updates} 个可升级依赖`))
    process.exitCode = 1
  }
}

main().catch((error) => {
  console.error(color.red(`版本巡检失败：${error?.message ?? error}`))
  process.exitCode = 2
})
