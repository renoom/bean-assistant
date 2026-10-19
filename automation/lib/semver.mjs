/**
 * 轻量 SemVer 工具：只覆盖自动化脚本需要的比较与范围判断，不引入依赖。
 */

const PATTERN = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/

/** 解析版本号；非法版本返回 null。 */
export function parse(version) {
  const match = String(version ?? '').match(PATTERN)
  if (!match) return null
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] ? match[4].split('.') : [],
  }
}

/**
 * 比较两个版本：a < b 返回 -1，相等返回 0，a > b 返回 1。
 * 遵循 SemVer 规则：正式版大于同号预发布版；预发布标识逐段比较。
 */
export function compare(a, b) {
  const left = typeof a === 'string' ? parse(a) : a
  const right = typeof b === 'string' ? parse(b) : b
  if (!left || !right) return 0
  for (const key of ['major', 'minor', 'patch']) {
    if (left[key] !== right[key]) return left[key] < right[key] ? -1 : 1
  }
  const leftPre = left.prerelease
  const rightPre = right.prerelease
  if (leftPre.length === 0 && rightPre.length === 0) return 0
  if (leftPre.length === 0) return 1
  if (rightPre.length === 0) return -1
  const length = Math.max(leftPre.length, rightPre.length)
  for (let i = 0; i < length; i++) {
    const l = leftPre[i]
    const r = rightPre[i]
    if (l === undefined) return -1
    if (r === undefined) return 1
    const lNumeric = /^\d+$/.test(l)
    const rNumeric = /^\d+$/.test(r)
    if (lNumeric && rNumeric) {
      if (Number(l) !== Number(r)) return Number(l) < Number(r) ? -1 : 1
    } else if (lNumeric) {
      return -1
    } else if (rNumeric) {
      return 1
    } else if (l !== r) {
      return l < r ? -1 : 1
    }
  }
  return 0
}

/** 从版本列表中取最大版本；无法解析的项会被忽略。 */
export function max(versions) {
  let winner = null
  for (const version of versions) {
    if (!parse(version)) continue
    if (!winner || compare(version, winner) > 0) winner = version
  }
  return winner
}

/** 判断版本是否落在 `^` / `~` / 精确版本范围内（只支持常见写法）。 */
export function satisfies(version, range) {
  const target = parse(version)
  if (!target) return false
  const trimmed = String(range ?? '').trim()
  if (!trimmed || trimmed === '*' || trimmed === 'latest') return true
  if (trimmed.startsWith('^')) {
    const base = parse(trimmed.slice(1))
    if (!base) return false
    const core = `${base.major}.${base.minor}.${base.patch}`
    return compare(version, core) >= 0 && target.major === base.major
  }
  if (trimmed.startsWith('~')) {
    const base = parse(trimmed.slice(1))
    if (!base) return false
    const core = `${base.major}.${base.minor}.${base.patch}`
    return compare(version, core) >= 0 && target.major === base.major && target.minor === base.minor
  }
  const base = parse(trimmed)
  return base ? compare(version, trimmed) === 0 : true
}
