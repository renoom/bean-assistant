/**
 * npm registry 访问层：并发抓取包元数据 + 本地缓存，避免频繁请求与离线不可用。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { AUTOMATION_DIR, color, readJson } from './util.mjs'

const CACHE_DIR = path.join(AUTOMATION_DIR, '.cache')
const CACHE_FILE = path.join(CACHE_DIR, 'npm-registry.json')
const CACHE_TTL_MS = 6 * 60 * 60 * 1000
const REGISTRY = 'https://registry.npmjs.org'
const USER_AGENT = 'bean-assistant-automation (+https://github.com/renoom/bean-assistant)'

export function readCache() {
  const cache = readJson(CACHE_FILE)
  if (!cache || typeof cache !== 'object') return { fetchedAt: 0, packages: {} }
  return { fetchedAt: cache.fetchedAt ?? 0, packages: cache.packages ?? {} }
}

export function writeCache(cache) {
  mkdirSync(CACHE_DIR, { recursive: true })
  writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2) + '\n', 'utf8')
}

export function cacheAgeMs(cache) {
  return cache.fetchedAt ? Date.now() - cache.fetchedAt : Number.POSITIVE_INFINITY
}

async function fetchOne(name, { attempts = 3 } = {}) {
  const url = `${REGISTRY}/${name.startsWith('@') ? encodeURIComponent(name) : name}`
  let lastError
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const response = await fetch(url, {
        headers: { accept: 'application/json', 'user-agent': USER_AGENT },
        signal: AbortSignal.timeout(20_000),
      })
      if (response.status === 404) return { name, missing: true }
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const doc = await response.json()
      return {
        name,
        tags: doc['dist-tags'] ?? {},
        versions: Object.keys(doc.versions ?? {}),
        modified: doc.time?.modified ?? null,
        created: doc.time?.created ?? null,
      }
    } catch (error) {
      lastError = error
      if (attempt < attempts) await new Promise((resolve) => setTimeout(resolve, 250 * attempt))
    }
  }
  return { name, error: String(lastError?.message ?? lastError) }
}

/**
 * 并发获取包元数据。
 * @param {string[]} names
 * @returns {Promise<{packages: Record<string, object>, fetchedAt: number, cached: number, network: number, errors: number}>}
 */
export async function resolvePackages(names, { offline = false, refresh = false, concurrency = 8, onProgress } = {}) {
  const cache = readCache()
  const fresh = !refresh && cacheAgeMs(cache) < CACHE_TTL_MS
  const unique = [...new Set(names)]
  const packages = {}
  const pending = []

  for (const name of unique) {
    const hit = cache.packages[name]
    if (hit && (offline || fresh)) {
      packages[name] = hit
    } else {
      pending.push(name)
    }
  }

  let networkCount = 0
  let errorCount = 0
  let cursor = 0
  const workers = Array.from({ length: Math.max(1, Math.min(concurrency, pending.length || 1)) }, async () => {
    while (cursor < pending.length) {
      const name = pending[cursor++]
      const result = await fetchOne(name)
      packages[name] = result
      if (result.error) errorCount++
      else networkCount++
      onProgress?.(name, pending.length)
    }
  })
  await Promise.all(workers)

  if (!offline && networkCount > 0) {
    const merged = { ...cache.packages, ...packages }
    writeCache({ fetchedAt: Date.now(), packages: merged })
  }

  return {
    packages,
    fetchedAt: fresh ? cache.fetchedAt : Date.now(),
    cached: unique.length - pending.length,
    network: networkCount,
    errors: errorCount,
  }
}

export function describeCache({ fetchedAt, cached, network, errors }) {
  const parts = []
  if (cached) parts.push(`缓存 ${cached}`)
  if (network) parts.push(`网络 ${network}`)
  if (errors) parts.push(color.red(`失败 ${errors}`))
  if (fetchedAt) parts.push(`更新于 ${new Date(fetchedAt).toLocaleString('zh-CN')}`)
  return parts.join(' · ')
}

export function ensureCacheDir() {
  if (!existsSync(CACHE_DIR)) mkdirSync(CACHE_DIR, { recursive: true })
  return CACHE_DIR
}

export { CACHE_FILE }
