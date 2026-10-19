/**
 * 控制台 API Key 鉴权。
 *
 * 当前方案：整个平台（Console + 所有助手进程）共用一把平台 API Key。
 * - Console 首次启动时自动生成，存放在 ~/.assistant/console/api-key.json（0600）。
 * - Console 启动助手时通过 --api-key 注入给助手进程。
 * - 所有 HTTP 请求接受 Authorization: Bearer <key> / X-API-Key: <key>。
 * - WebSocket 额外接受查询参数 ?api_key=<key>（浏览器/Godot 无法自定义 Header 时使用）。
 *
 * @module console/auth
 */

import { randomBytes, timingSafeEqual } from 'node:crypto'
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import type { IncomingMessage } from 'node:http'

export const API_KEY_PREFIX = 'ask_'

/** 生成一把新的平台 API Key。 */
export function generateApiKey(): string {
  return `${API_KEY_PREFIX}${randomBytes(32).toString('base64url')}`
}

/** 只用于 UI 展示，不泄露完整 Key。 */
export function maskApiKey(key: string): string {
  if (key.length <= 12) return '****'
  return `${key.slice(0, 8)}…${key.slice(-4)}`
}

export interface ApiKeyDocument {
  version: 1
  key: string
  createdAt: string
  updatedAt: string
}

/** 从 HTTP 请求中提取 Key。 */
export function extractApiKey(headers: Record<string, unknown>, rawUrl = '/'): string | undefined {
  const authorization = firstHeader(headers.authorization)
  if (authorization) {
    const match = /^Bearer\s+(.+)$/i.exec(authorization.trim())
    if (match) return match[1].trim()
  }

  const headerKey = firstHeader(headers['x-api-key'])
  if (headerKey) return headerKey.trim()

  try {
    const url = new URL(rawUrl, 'http://localhost')
    for (const name of ['api_key', 'apikey', 'key', 'token']) {
      const value = url.searchParams.get(name)
      if (value) return value.trim()
    }
  } catch {
    // ignore malformed URL
  }

  return undefined
}

function firstHeader(value: unknown): string | undefined {
  if (typeof value === 'string') return value
  if (Array.isArray(value) && typeof value[0] === 'string') return value[0]
  return undefined
}


export function verifyApiKey(expected: string, actual: string | undefined): boolean {
  if (actual === undefined) return false
  const a = Buffer.from(expected)
  const b = Buffer.from(actual)
  if (a.length === b.length) return timingSafeEqual(a, b)
  return false
}

export interface ApiKeyAuthOptions {
  /** 覆盖初始化 Key（用于测试或已知部署）。 */
  initialKey?: string
}

export class ApiKeyAuth {
  private constructor(
    private readonly path: string,
    private document: ApiKeyDocument,
  ) {}

  static async load(path: string, options: ApiKeyAuthOptions = {}): Promise<{ auth: ApiKeyAuth; created: boolean }> {
    const resolved = resolve(path)
    try {
      const raw = await readFile(resolved, 'utf8')
      const parsed = JSON.parse(raw) as Partial<ApiKeyDocument>
      if (typeof parsed.key === 'string' && parsed.key.length > 0) {
        return {
          auth: new ApiKeyAuth(resolved, {
            version: 1,
            key: parsed.key,
            createdAt: typeof parsed.createdAt === 'string' ? parsed.createdAt : new Date().toISOString(),
            updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : new Date().toISOString(),
          }),
          created: false,
        }
      }
      console.warn(`[console:auth] API Key 文件非法，将重新生成: ${resolved}`)
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code !== 'ENOENT') {
        console.warn(`[console:auth] API Key 文件不可读，将重新生成: ${resolved}`)
      }
    }

    const document = ApiKeyDocumentFactory(options.initialKey)
    const auth = new ApiKeyAuth(resolved, document)
    await auth.save()
    return { auth, created: true }
  }

  currentKey(): string {
    return this.document.key
  }

  maskedKey(): string {
    return maskApiKey(this.document.key)
  }

  createdAt(): string {
    return this.document.createdAt
  }

  updatedAt(): string {
    return this.document.updatedAt
  }

  verify(actual: string | undefined): boolean {
    return verifyApiKey(this.document.key, actual)
  }

  authorize(req: Pick<IncomingMessage, 'headers' | 'url'>): boolean {
    return this.verify(extractApiKey(req.headers as Record<string, unknown>, req.url ?? '/'))
  }

  /** 生成并持久化一把新 Key；返回新 Key（只应展示一次）。 */
  async rotate(): Promise<string> {
    this.document = {
      version: 1,
      key: generateApiKey(),
      createdAt: this.document.createdAt,
      updatedAt: new Date().toISOString(),
    }
    await this.save()
    return this.document.key
  }

  async save(): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true })
    const temporary = `${this.path}.${process.pid}.tmp`
    await writeFile(temporary, `${JSON.stringify(this.document, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
    await rename(temporary, this.path)
    await chmod(this.path, 0o600).catch(() => undefined)
  }
}

function ApiKeyDocumentFactory(initialKey?: string): ApiKeyDocument {
  const now = new Date().toISOString()
  const key = initialKey && initialKey.trim() ? initialKey.trim() : generateApiKey()
  return { version: 1, key, createdAt: now, updatedAt: now }
}
