/** Generic HTTP transport shared by assistant client communicators. */

import { createServer as createHttpServer } from 'node:http'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'

export interface HttpServiceConfig {
  host: string
  port: number
}

export type HttpRouteHandler = (req: IncomingMessage, res: ServerResponse) => Promise<void> | void
export type HttpHandler = (req: IncomingMessage, res: ServerResponse) => Promise<boolean> | boolean

export class HttpService {
  readonly server: Server
  private readonly routes = new Map<string, HttpRouteHandler>()
  private readonly handlers = new Set<HttpHandler>()

  constructor(private readonly config: HttpServiceConfig) {
    this.server = createHttpServer((req, res) => { void this.route(req, res) })
  }

  registerRoute(method: string, path: string, handler: HttpRouteHandler): () => void {
    const key = `${method} ${path}`
    if (this.routes.has(key)) throw new Error(`HTTP route already registered: ${key}`)
    this.routes.set(key, handler)
    return () => { if (this.routes.get(key) === handler) this.routes.delete(key) }
  }

  /** Register a fallback handler, for example a path-prefix route. */
  registerHandler(handler: HttpHandler): () => void {
    this.handlers.add(handler)
    return () => { this.handlers.delete(handler) }
  }

  async listen(): Promise<void> {
    await new Promise<void>((resolveListen, reject) => {
      const onError = (error: Error): void => { this.server.off('listening', onListening); reject(error) }
      const onListening = (): void => { this.server.off('error', onError); resolveListen() }
      this.server.once('error', onError)
      this.server.once('listening', onListening)
      this.server.listen(this.config.port, this.config.host)
    })
  }

  async dispose(): Promise<void> {
    await new Promise<void>((resolveClose, rejectClose) => {
      this.server.close(error => error ? rejectClose(error) : resolveClose())
    }).catch(error => {
      if ((error as NodeJS.ErrnoException).code !== 'ERR_SERVER_NOT_RUNNING') throw error
    })
  }

  private async route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', `http://${this.config.host}:${this.config.port}`)
    const method = req.method ?? 'GET'
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-API-Key')
    if (method === 'OPTIONS') { res.writeHead(204); res.end(); return }

    try {
      const route = this.routes.get(`${method} ${url.pathname}`)
      if (route) { await route(req, res); return }
      for (const handler of this.handlers) {
        if (await handler(req, res)) return
      }
      json(res, 404, { error: 'not found' })
    } catch (error) {
      if (!res.headersSent) json(res, 400, { error: error instanceof Error ? error.message : String(error) })
    }
  }
}

export function json(res: ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(data))
}

export function bytes(res: ServerResponse, value: { data: Uint8Array; mediaType: string }): void {
  res.writeHead(200, { 'Content-Type': value.mediaType, 'Content-Length': String(value.data.byteLength) })
  res.end(Buffer.from(value.data))
}

export function readJson(req: IncomingMessage, maxBytes = 1024 * 1024): Promise<Record<string, unknown> | null> {
  return new Promise(resolveRead => {
    let body = ''
    req.setEncoding('utf8')
    let tooLarge = false
    req.on('data', (chunk: string) => {
      if (tooLarge) return
      body += chunk
      if (Buffer.byteLength(body) > maxBytes) { tooLarge = true; body = '' }
    })
    req.on('error', () => resolveRead(null))
    req.on('aborted', () => resolveRead(null))
    req.on('end', () => {
      if (tooLarge || !body.trim()) return resolveRead(null)
      try {
        const value: unknown = JSON.parse(body)
        resolveRead(value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null)
      } catch { resolveRead(null) }
    })
  })
}
