/**
 * Console discovery and WebSocket URL helpers.
 *
 * Two connection paths are supported by the protocol:
 *
 * - **Gateway mode (recommended)**: `wss://<console>/a/<sessionId>/ws?api_key=<key>`
 *   The console validates the platform API key and proxies to the assistant's
 *   internal StageChannel. Clients must not use the internal host/port.
 * - **Direct mode**: `ws://<assistantHost>:<stagePort>/ws` for local development
 *   / standalone deployments without a console. The StageChannel itself does
 *   not check keys.
 *
 * @module stage-channel-sdk/discovery
 */

import type { ChannelEndpoint, FetchLike, FetchResponseLike } from './types.ts'
import { DiscoveryError, ProtocolError, StageChannelError } from './errors.ts'

/**
 * A descriptor returned by the console `GET /api/assistants` endpoint.
 * Only the fields this SDK relies on are typed; the server may return more.
 */
export interface AssistantDescriptor {
  sessionId: string
  name?: string
  status: string
  channels: string[]
  gatewayBase?: string
  gatewayWsPath?: string
  channelEndpoints?: ChannelEndpoint[]
  [key: string]: unknown
}

/** Authentication header selection for discovery requests. */
export type DiscoveryAuthHeader = 'bearer' | 'x-api-key' | 'both' | 'none'

/** Options for {@link fetchAssistants}. */
export interface FetchAssistantsOptions {
  /** Console base URL, for example `http://127.0.0.1:8080` or `https://console.example.com`. */
  baseUrl: string
  /** Platform API key (`ask_...`). */
  apiKey?: string
  /** Injectable `fetch`; defaults to the global `fetch` (Node >= 22 / browsers). */
  fetch?: FetchLike
  /**
   * Which auth header(s) to send. Defaults to `both` when `apiKey` is set:
   * the console accepts `Authorization: Bearer <key>` and `X-API-Key: <key>`.
   */
  authHeader?: DiscoveryAuthHeader
  /** Extra request headers. */
  headers?: Record<string, string>
  /** Request timeout in milliseconds. Defaults to 10000; `0` disables it. */
  timeoutMs?: number
  /** Optional external abort signal (combined with `timeoutMs`). */
  signal?: AbortSignal
}

/** Options for {@link buildGatewayWsUrl}. */
export interface GatewayUrlOptions {
  /** Query parameter name used to carry the API key. Defaults to `api_key`. */
  apiKeyParam?: string
}

/**
 * True when a discovered assistant can accept a StageChannel connection:
 * `status === "online"` and `channels` contains `"stage"`.
 */
export function isStageAssistant(value: unknown): value is AssistantDescriptor {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const raw = value as Record<string, unknown>
  if (typeof raw.sessionId !== 'string' || raw.sessionId.length === 0) return false
  if (raw.status !== 'online') return false
  if (!Array.isArray(raw.channels) || raw.channels.includes('stage') === false) return false
  return true
}

/**
 * Discover online assistants that expose the StageChannel.
 *
 * Sends `GET <baseUrl>/api/assistants` with the platform API key and returns
 * only descriptors matching {@link isStageAssistant}. Use
 * `descriptor.gatewayWsPath` with {@link buildGatewayWsUrl} to connect.
 */
export async function fetchAssistants(options: FetchAssistantsOptions): Promise<AssistantDescriptor[]> {
  const { baseUrl, apiKey } = options
  if (typeof baseUrl !== 'string' || baseUrl.trim().length === 0) {
    throw new DiscoveryError('baseUrl is required')
  }
  const base = baseUrl.trim().replace(/\/+$/, '')
  if (!/^(https?|wss?):\/\//i.test(base)) {
    throw new DiscoveryError(`baseUrl must be an absolute http(s) URL, got ${JSON.stringify(baseUrl)}`)
  }
  const url = `${base}/api/assistants`

  const authHeader: DiscoveryAuthHeader = options.authHeader ?? (apiKey ? 'both' : 'none')
  const headers: Record<string, string> = { Accept: 'application/json' }
  if (apiKey && authHeader !== 'none') {
    if (authHeader === 'bearer' || authHeader === 'both') headers.Authorization = `Bearer ${apiKey}`
    if (authHeader === 'x-api-key' || authHeader === 'both') headers['X-API-Key'] = apiKey
  }
  if (options.headers) Object.assign(headers, options.headers)

  const fetchImpl = options.fetch ?? defaultFetch
  const controller = new AbortController()
  const timeoutMs = options.timeoutMs ?? 10_000
  const timer = timeoutMs > 0 ? setTimeout(() => controller.abort(), timeoutMs) : null
  let detachExternal: (() => void) | null = null
  if (options.signal) {
    const external = options.signal
    if (external.aborted) controller.abort()
    else {
      const onAbort = (): void => controller.abort()
      external.addEventListener('abort', onAbort, { once: true })
      detachExternal = () => external.removeEventListener('abort', onAbort)
    }
  }

  let response: FetchResponseLike
  try {
    response = await fetchImpl(url, { method: 'GET', headers, signal: controller.signal })
  } catch (error) {
    if (controller.signal.aborted) {
      throw new DiscoveryError(`discovery request to ${url} was aborted or timed out`, {
        url,
        cause: error,
        code: 'ERR_DISCOVERY_ABORTED',
      })
    }
    throw new DiscoveryError(`discovery request to ${url} failed: ${errorMessage(error)}`, { url, cause: error })
  } finally {
    if (timer !== null) clearTimeout(timer)
    detachExternal?.()
  }

  if (!response.ok) {
    throw new DiscoveryError(`discovery request to ${url} failed with HTTP ${response.status}${response.statusText ? ` ${response.statusText}` : ''}`, {
      status: response.status,
      url,
    })
  }

  let payload: unknown
  try {
    payload = await response.json()
  } catch (error) {
    throw new DiscoveryError(`discovery response from ${url} is not valid JSON`, { url, cause: error })
  }
  if (!Array.isArray(payload)) {
    throw new DiscoveryError(`discovery response from ${url} is not an array`, { url })
  }
  return payload.filter(isStageAssistant)
}

/**
 * Build a gateway WebSocket URL:
 * `wss://<console>/a/<sessionId>/ws?api_key=<key>`.
 *
 * `baseUrl` may be `http(s)://` or `ws(s)://`; `gatewayWsPath` is normally the
 * `gatewayWsPath` returned by discovery (an absolute `ws(s)://` URL is also
 * accepted).
 */
export function buildGatewayWsUrl(
  baseUrl: string,
  gatewayWsPath: string,
  apiKey?: string,
  options: GatewayUrlOptions = {},
): string {
  if (typeof baseUrl !== 'string' || baseUrl.trim().length === 0) {
    throw new StageChannelError('baseUrl is required')
  }
  if (typeof gatewayWsPath !== 'string' || gatewayWsPath.trim().length === 0) {
    throw new StageChannelError('gatewayWsPath is required')
  }
  const param = options.apiKeyParam ?? 'api_key'

  let base: URL
  try {
    base = new URL(baseUrl.trim())
  } catch (error) {
    throw new StageChannelError(`invalid baseUrl: ${JSON.stringify(baseUrl)}`, { cause: error })
  }
  if (base.protocol === 'http:') base.protocol = 'ws:'
  else if (base.protocol === 'https:') base.protocol = 'wss:'
  else if (base.protocol !== 'ws:' && base.protocol !== 'wss:') {
    throw new StageChannelError(`baseUrl must use http(s) or ws(s), got ${base.protocol}`)
  }

  let url: URL
  if (/^wss?:\/\//i.test(gatewayWsPath.trim())) {
    url = new URL(gatewayWsPath.trim())
  } else {
    const path = gatewayWsPath.trim().startsWith('/') ? gatewayWsPath.trim() : `/${gatewayWsPath.trim()}`
    const basePath = base.pathname.replace(/\/+$/, '')
    url = new URL(`${base.protocol}//${base.host}${basePath}${path}`)
    for (const [key, value] of base.searchParams) {
      if (!url.searchParams.has(key)) url.searchParams.set(key, value)
    }
  }
  if (apiKey) url.searchParams.set(param, apiKey)
  return url.toString()
}

/**
 * Build a direct StageChannel WebSocket URL: `ws://<host>:<port>/ws`.
 *
 * @param host Assistant host (IPv6 is bracketed automatically).
 * @param port StageChannel port.
 * @param path WebSocket path, defaults to `/ws`.
 * @param useTls Use `wss://` instead of `ws://`.
 */
export function buildDirectWsUrl(host: string, port: number, path = '/ws', useTls = false): string {
  if (typeof host !== 'string' || host.trim().length === 0) {
    throw new ProtocolError('host is required')
  }
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new ProtocolError(`invalid port: ${String(port)}`)
  }
  const scheme = useTls ? 'wss' : 'ws'
  let hostPart = host.trim()
  if (!(hostPart.startsWith('[') && hostPart.endsWith(']')) && hostPart.includes(':')) {
    hostPart = `[${hostPart}]`
  }
  const normalizedPath = path.startsWith('/') ? path : `/${path}`
  return `${scheme}://${hostPart}:${port}${normalizedPath}`
}

const defaultFetch: FetchLike = (input, init) => {
  const runtime = globalThis as { fetch?: unknown }
  if (typeof runtime.fetch !== 'function') {
    return Promise.reject(new DiscoveryError('global fetch is not available; pass options.fetch'))
  }
  return (runtime.fetch as FetchLike)(input, init)
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
