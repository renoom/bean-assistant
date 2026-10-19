/**
 * Console 内置网关。
 *
 * 对外路由：
 *   /a/{sessionId}/api/message|stream → HTTP Channel
 *   /a/{sessionId}/ws                 → Stage Channel
 *
 * 客户端只连接 Console；Console 用注册表把 sessionId 解析到内部助手端口，
 * 并统一做 API Key 鉴权与助手 Key 注入。
 *
 * @module console/gateway
 */

import { request as httpRequest } from 'node:http'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import type { Duplex } from 'node:stream'
import type { ApiKeyAuth } from './auth.ts'
import type { AssistantInfo, ChannelEndpoint, Registry } from './registry.ts'

const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
])

export interface GatewayRoute {
  sessionId: string
  upstreamPath: string
}

export interface ConsoleGatewayOptions {
  server: Server
  registry: Registry
  auth: ApiKeyAuth
}

const AUTH_QUERY_NAMES = ['api_key', 'apikey', 'key', 'token']

export function parseGatewayRoute(pathname: string): GatewayRoute | null {
  if (pathname.startsWith('/a/') === false) return null
  const tail = pathname.slice(3)
  if (tail.length === 0) return null
  const slash = tail.indexOf('/')
  const rawSessionId = slash === -1 ? tail : tail.slice(0, slash)
  const rest = slash === -1 ? '/' : tail.slice(slash)
  let sessionId = ''
  try {
    sessionId = decodeURIComponent(rawSessionId)
  } catch {
    return null
  }
  if (sessionId.length === 0) return null
  return { sessionId, upstreamPath: rest.length > 0 ? rest : '/' }
}

export function stripAuthQuery(url: URL): string {
  const params = new URLSearchParams(url.searchParams)
  for (const name of AUTH_QUERY_NAMES) params.delete(name)
  const query = params.toString()
  return query.length > 0 ? `?${query}` : ''
}

function copyRequestHeaders(req: IncomingMessage): Record<string, string | string[] | undefined> {
  const headers: Record<string, string | string[] | undefined> = {}
  for (const [name, value] of Object.entries(req.headers)) {
    const lower = name.toLowerCase()
    if (HOP_BY_HOP.has(lower)) continue
    if (lower === 'host' || lower === 'authorization' || lower === 'x-api-key') continue
    headers[lower] = value
  }
  return headers
}

function json(res: ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(data))
}

function rawResponse(socket: Duplex, statusCode: number, statusText: string, body = ''): void {
  socket.write(`HTTP/1.1 ${statusCode} ${statusText}\r\nConnection: close\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`)
  socket.destroy()
}

function upstreamHost(host: string | undefined): string {
  const resolved = typeof host === 'string' && host.length > 0 ? host : '127.0.0.1'
  return resolved === '0.0.0.0' ? '127.0.0.1' : resolved
}

function channelEndpoint(info: AssistantInfo, id: string, protocol: ChannelEndpoint['protocol']): ChannelEndpoint | null | undefined {
  if (info.channelEndpoints === undefined) return undefined
  return info.channelEndpoints.find(endpoint => endpoint.id === id && endpoint.protocol === protocol) ?? null
}

function isHttpChannelPath(path: string): boolean {
  return path === '/api/message' || path === '/api/stream'
}

export class ConsoleGateway {
  private readonly upgradeHandler: (req: IncomingMessage, socket: Duplex, head: Buffer) => void

  constructor(private readonly options: ConsoleGatewayOptions) {
    this.upgradeHandler = (req, socket, head) => this.handleUpgrade(req, socket, head)
    options.server.on('upgrade', this.upgradeHandler)
  }

  dispose(): void {
    this.options.server.off('upgrade', this.upgradeHandler)
  }

  async handleHttp(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    const route = parseGatewayRoute(url.pathname)
    if (route === null) {
      json(res, 404, { error: 'gateway route not found' })
      return
    }

    const info = this.findAssistant(route.sessionId)
    if (info === null) {
      json(res, 503, { error: `assistant ${route.sessionId} is not online` })
      return
    }

    const endpoint = isHttpChannelPath(route.upstreamPath) ? channelEndpoint(info, 'http', 'http') : undefined
    if (endpoint === null) {
      json(res, 503, { error: 'HTTP channel is disabled' })
      return
    }
    const host = upstreamHost(endpoint?.host ?? info.host)
    const port = endpoint?.port ?? info.port
    const targetPath = route.upstreamPath + stripAuthQuery(url)
    const headers = copyRequestHeaders(req)
    headers.host = `${host}:${port}`
    const remote = req.socket.remoteAddress
    if (remote) headers['x-forwarded-for'] = remote
    const encrypted = (req.socket as { encrypted?: boolean }).encrypted === true
    headers['x-forwarded-proto'] = encrypted ? 'https' : 'http'
    headers['x-forwarded-host'] = req.headers.host ?? ''

    const upstream = httpRequest({
      host,
      port,
      method: req.method ?? 'GET',
      path: targetPath,
      headers,
    }, upstreamRes => {
      res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers)
      upstreamRes.pipe(res)
    })

    upstream.on('error', error => {
      if (res.headersSent) {
        res.destroy()
        return
      }
      json(res, 502, { error: 'assistant unavailable', detail: error.message })
    })

    req.pipe(upstream)
  }

  private findAssistant(sessionId: string): AssistantInfo | null {
    const info = this.options.registry.findBySessionId(sessionId)
    if (info === null) return null
    if (info.status !== 'online') return null
    if (Number.isFinite(info.port) === false || info.port <= 0) return null
    return info
  }

  private handleUpgrade(req: IncomingMessage, socket: Duplex, _head: Buffer): void {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const route = parseGatewayRoute(url.pathname)
    if (route === null) return

    if (this.options.auth.authorize(req) === false) {
      rawResponse(socket, 401, 'Unauthorized', 'unauthorized')
      return
    }

    const info = this.findAssistant(route.sessionId)
    if (info === null) {
      rawResponse(socket, 503, 'Service Unavailable', `assistant ${route.sessionId} is not online`)
      return
    }
    if (route.upstreamPath !== '/ws') {
      rawResponse(socket, 404, 'Not Found', 'websocket route not found')
      return
    }

    const endpoint = channelEndpoint(info, 'stage', 'ws')
    if (endpoint === null) {
      rawResponse(socket, 404, 'Not Found', 'Stage channel is disabled')
      return
    }
    const host = upstreamHost(endpoint?.host ?? info.host)
    const port = endpoint?.port ?? info.port
    const headers = copyRequestHeaders(req)
    headers.host = `${host}:${port}`
    headers.connection = 'Upgrade'
    headers.upgrade = 'websocket'
    const remote = req.socket.remoteAddress
    if (remote) headers['x-forwarded-for'] = remote
    const encrypted = (req.socket as { encrypted?: boolean }).encrypted === true
    headers['x-forwarded-proto'] = encrypted ? 'https' : 'http'
    headers['x-forwarded-host'] = req.headers.host ?? ''

    const upstream = httpRequest({
      host,
      port,
      method: 'GET',
      path: endpoint?.path ?? route.upstreamPath,
      headers,
    })

    upstream.on('upgrade', (upstreamRes, upstreamSocket, upstreamHead) => {
      const lines = [`HTTP/1.1 ${upstreamRes.statusCode ?? 101} ${upstreamRes.statusMessage ?? 'Switching Protocols'}`]
      for (let i = 0; i < upstreamRes.rawHeaders.length; i += 2) {
        lines.push(`${upstreamRes.rawHeaders[i]}: ${upstreamRes.rawHeaders[i + 1]}`)
      }
      socket.write(lines.join('\r\n') + '\r\n\r\n')
      if (upstreamHead.length > 0) socket.write(upstreamHead)

      upstreamSocket.on('error', () => socket.destroy())
      socket.on('error', () => upstreamSocket.destroy())
      upstreamSocket.pipe(socket)
      socket.pipe(upstreamSocket)
    })

    upstream.on('response', upstreamRes => {
      const lines = [`HTTP/1.1 ${upstreamRes.statusCode ?? 502} ${upstreamRes.statusMessage ?? 'Bad Gateway'}`, 'Connection: close']
      for (let i = 0; i < upstreamRes.rawHeaders.length; i += 2) {
        const name = upstreamRes.rawHeaders[i].toLowerCase()
        if (name === 'connection' || name === 'keep-alive' || name === 'transfer-encoding') continue
        lines.push(`${upstreamRes.rawHeaders[i]}: ${upstreamRes.rawHeaders[i + 1]}`)
      }
      socket.write(lines.join('\r\n') + '\r\n\r\n')
      upstreamRes.pipe(socket)
    })

    upstream.on('error', () => rawResponse(socket, 502, 'Bad Gateway', 'assistant unavailable'))
    upstream.end()
  }
}
