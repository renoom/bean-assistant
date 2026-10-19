#!/usr/bin/env node
/**
 * 安全扫描：检测「会被提交/已提交」的文件里是否混入了密钥、私钥、敏感文件或本机隐私路径。
 *
 *   node automation/check-secrets.mjs            # 扫描 git 已跟踪文件（默认）
 *   node automation/check-secrets.mjs --all      # 额外扫描未跟踪但未忽略的文件
 *   node automation/check-secrets.mjs --strict   # 隐私路径等警告也视为失败
 *   node automation/check-secrets.mjs --json
 *
 * 退出码：0 干净（--strict 下无警告），1 发现密钥/敏感文件（或 --strict 下有警告）。
 *
 * 说明：这是仓库自检，不替代 GitHub Secret Scanning / Push Protection；
 * 已确认远端仓库两项均处于 enabled。
 */

import { execFileSync } from 'node:child_process'
import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { parseArgs, renderTable, color, REPO_ROOT } from './lib/util.mjs'

const { options } = parseArgs(process.argv.slice(2), {
  all: 'boolean',
  strict: 'boolean',
  json: 'boolean',
})
const jsonMode = options.json
const log = (...args) => {
  if (!jsonMode) console.log(...args)
}

/** 高危内容模式（命中即失败）。 */
const SECRET_PATTERNS = [
  { id: 'private-key', label: '私钥文件内容', regex: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { id: 'openai-key', label: 'sk- 类 API Key', regex: /\bsk-(?:ant-)?[A-Za-z0-9_-]{20,}/ },
  { id: 'github-token', label: 'GitHub Token', regex: /\b(?:gh[pousr]|github_pat)_[A-Za-z0-9_]{20,}/ },
  { id: 'aws-key', label: 'AWS Access Key', regex: /\bAKIA[0-9A-Z]{16}\b/ },
  { id: 'google-key', label: 'Google API Key', regex: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { id: 'slack-token', label: 'Slack Token', regex: /\bxox[baprs]-[A-Za-z0-9-]{10,}/ },
  { id: 'jwt', label: 'JWT', regex: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/ },
  { id: 'platform-key', label: '平台客户端 Key', regex: /\bask_[A-Za-z0-9]{12,}/ },
  { id: 'bearer', label: 'Bearer 令牌', regex: /\bBearer[ \t]+[A-Za-z0-9._~+/-]{20,}/ },
  {
    id: 'generic-assignment',
    label: '密钥变量赋值',
    regex: /(?:api[_-]?key|apikey|client[_-]?key|secret[_-]?key|access[_-]?token|auth[_-]?token|password|passwd)["']?[ \t]*[:=][ \t]*["']?([A-Za-z0-9_\-./+=]{20,})/gi,
    capture: 1,
  },
]

/** 隐私信息模式（默认警告）。 */
const PRIVACY_PATTERNS = [
  { id: 'mac-home', label: '本机用户目录', regex: /\/Users\/(?!Shared\/)[A-Za-z0-9._-]+\// },
  { id: 'linux-home', label: '本机用户目录', regex: /\/home\/[A-Za-z0-9._-]+\// },
  { id: 'windows-home', label: '本机用户目录', regex: /[A-Za-z]:\\Users\\[^\\\s]+\\/ },
  { id: 'device-udid', label: '设备 UDID', regex: /\b[0-9A-F]{8}-[0-9A-F]{16}\b/ },
]

/** 不应入库的文件名（命中即失败）。 */
const SENSITIVE_FILES = [
  { id: 'dotenv', regex: /(^|\/)\.env(\.[^/]+)?$/i },
  { id: 'private-key-file', regex: /\.(pem|key|p12|pfx|keystore|jks)$/i },
  { id: 'provisioning', regex: /\.(mobileprovision|provisionprofile)$/i },
  { id: 'netrc', regex: /(^|\/)\.netrc$/i },
  { id: 'sqlite', regex: /\.(sqlite|sqlite3|db)$/i },
  { id: 'ipa', regex: /\.ipa$/i },
  { id: 'ssh-key', regex: /(^|\/)id_(rsa|ed25519|ecdsa)(\.pub)?$/i },
]

const PLACEHOLDER = /(xxxx|your[-_]|example|placeholder|dummy|fake|test[-_]?key|changeme|change[-_]me|\.{3}|<|>|\{|\}|\$|process\.env)/i
const ENV_NAME = /^[A-Z][A-Z0-9_]*$/
const SKIP_CONTENT = new Set(['automation/check-secrets.mjs'])
const MAX_CONTENT_BYTES = 2 * 1024 * 1024

function gitTracked() {
  try {
    const tracked = execFileSync('git', ['-C', REPO_ROOT, 'ls-files', '-z'], { encoding: 'utf8' }).split('\0').filter(Boolean)
    if (!options.all) return tracked
    const untracked = execFileSync('git', ['-C', REPO_ROOT, 'ls-files', '-z', '--others', '--exclude-standard'], { encoding: 'utf8' })
      .split('\0')
      .filter(Boolean)
    return [...new Set([...tracked, ...untracked])]
  } catch {
    // 非 git 环境：退化为常见目录遍历
    return walk(REPO_ROOT, '')
  }
}

function walk(root, relative, out = []) {
  const skip = new Set(['node_modules', '.git', 'lib', '.cache', 'dist', '.build', '.godot', 'data', 'test-output'])
  let entries
  try {
    entries = readdirSyncSafe(path.join(root, relative))
  } catch {
    return out
  }
  for (const entry of entries) {
    if (skip.has(entry.name) || entry.name.startsWith('.')) continue
    const rel = path.posix.join(relative, entry.name)
    if (entry.isDirectory()) walk(root, rel, out)
    else out.push(rel)
  }
  return out
}

function readdirSyncSafe(dir) {
  try {
    return readdirSync(dir, { withFileTypes: true })
  } catch {
    return []
  }
}

function isBinary(buffer) {
  const probe = buffer.subarray(0, Math.min(buffer.length, 4096))
  return probe.includes(0)
}

function placeholderLike(value) {
  return PLACEHOLDER.test(value) || ENV_NAME.test(value)
}

/** 判断「变量赋值」捕获值是否真的像凭据（过滤代码表达式 / 变量名）。 */
function plausibleSecret(value) {
  if (placeholderLike(value)) return false
  // 纯标识符/属性链且不含数字，几乎都是代码而不是密钥
  if (/^[A-Za-z_$][\w$]*(\.[A-Za-z_$][\w$]*)*$/.test(value) && !/\d/.test(value)) return false
  const classes = [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/].filter((rule) => rule.test(value)).length
  return classes >= 3 || (classes >= 2 && value.length >= 32)
}

function mask(value) {
  if (value.length <= 8) return value
  return `${value.slice(0, 4)}…${value.slice(-2)}`
}

function scanFile(file) {
  const findings = []
  for (const rule of SENSITIVE_FILES) {
    if (rule.regex.test(file)) {
      findings.push({ severity: 'error', file, line: 0, kind: rule.id, label: '敏感文件不应入库', excerpt: file })
    }
  }
  if (SKIP_CONTENT.has(file)) return findings

  let buffer
  try {
    buffer = readFileSync(path.join(REPO_ROOT, file))
  } catch {
    return findings
  }
  if (buffer.length > MAX_CONTENT_BYTES || isBinary(buffer)) return findings

  const lines = buffer.toString('utf8').split('\n')
  lines.forEach((line, index) => {
    const lineNo = index + 1
    for (const rule of SECRET_PATTERNS) {
      const regex = new RegExp(rule.regex.source, rule.regex.flags.includes('g') ? rule.regex.flags : rule.regex.flags + 'g')
      let match
      while ((match = regex.exec(line)) !== null) {
        const value = rule.capture ? (match[rule.capture] ?? match[0]) : match[0]
        if (placeholderLike(value)) continue
        if (rule.id === 'generic-assignment' && !plausibleSecret(value)) continue
        findings.push({
          severity: 'error',
          file,
          line: lineNo,
          kind: rule.id,
          label: rule.label,
          excerpt: mask(value),
        })
      }
    }
    for (const rule of PRIVACY_PATTERNS) {
      const regex = new RegExp(rule.regex.source, rule.regex.flags.includes('g') ? rule.regex.flags : rule.regex.flags + 'g')
      let match
      while ((match = regex.exec(line)) !== null) {
        findings.push({
          severity: 'warning',
          file,
          line: lineNo,
          kind: rule.id,
          label: rule.label,
          excerpt: mask(match[0]),
        })
      }
    }
  })
  return findings
}

function main() {
  const files = gitTracked()
  log(`${color.bold('Bean Assistant')} 安全扫描 · ${new Date().toLocaleString('zh-CN')}`)
  log(`扫描范围：${files.length} 个文件（${options.all ? '已跟踪 + 未跟踪未忽略' : 'git 已跟踪'}）`)

  const findings = []
  for (const file of files) findings.push(...scanFile(file))

  const secrets = findings.filter((item) => item.severity === 'error')
  const privacy = findings.filter((item) => item.severity === 'warning')

  if (!jsonMode) {
    if (findings.length === 0) {
      log(`${color.green('✔')} 未发现密钥、私钥、敏感文件或本机隐私路径`)
    } else {
      const rows = findings.slice(0, 100).map((item) => [
        item.severity === 'error' ? color.red('高危') : color.yellow('警告'),
        `${item.file}${item.line ? `:${item.line}` : ''}`,
        item.label,
        item.excerpt,
      ])
      log(renderTable(['级别', '位置', '类型', '内容（已打码）'], rows))
      if (findings.length > 100) log(color.gray(`…另有 ${findings.length - 100} 处未展示`))
      log('')
      if (secrets.length) console.log(`${color.red('✘')} ${secrets.length} 处疑似密钥/敏感文件，请在推送前移除或吊销`)
      if (privacy.length) console.log(`${color.yellow('⚠')} ${privacy.length} 处本机隐私路径，建议替换为相对路径或 ~`)
      log(`处理建议：删除/替换后重新运行；若密钥曾经推送，请立即在服务端吊销并清理历史。`)
    }
  }

  if (jsonMode) {
    process.stdout.write(
      JSON.stringify(
        {
          ok: secrets.length === 0 && (!options.strict || privacy.length === 0),
          scannedFiles: files.length,
          secrets: secrets.length,
          privacy: privacy.length,
          findings,
        },
        null,
        2,
      ) + '\n',
    )
  }

  process.exitCode = secrets.length > 0 || (options.strict && privacy.length > 0) ? 1 : 0
}

main()
