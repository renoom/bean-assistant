/**
 * Discovery tests: assistant filtering, auth headers, gateway/direct URL
 * construction. Uses an injected `fetch`, so no network is involved.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { FetchLike } from '../src/index.ts'
import {
  DiscoveryError,
  ProtocolError,
  StageChannelError,
  buildDirectWsUrl,
  buildGatewayWsUrl,
  fetchAssistants,
  isStageAssistant,
} from '../src/index.ts'

interface FetchCall {
  url: string
  headers: Record<string, string>
}

function createMockFetch(payload: unknown, options: { status?: number; statusText?: string } = {}) {
  const calls: FetchCall[] = []
  const fetchImpl: FetchLike = async (url, init) => {
    calls.push({ url, headers: init?.headers ?? {} })
    const status = options.status ?? 200
    return {
      ok: status >= 200 && status < 300,
      status,
      statusText: options.statusText,
      json: async () => payload,
    }
  }
  return { calls, fetchImpl }
}

const ASSISTANTS = [
  {
    sessionId: 'assistant-1',
    name: '编码助手',
    status: 'online',
    channels: ['http', 'stage'],
    gatewayBase: '/a/assistant-1',
    gatewayWsPath: '/a/assistant-1/ws',
  },
  { sessionId: 'assistant-2', name: '离线助手', status: 'offline', channels: ['http', 'stage'] },
  { sessionId: 'assistant-3', name: '纯 HTTP', status: 'online', channels: ['http'] },
  { name: '没有 sessionId', status: 'online', channels: ['stage'] },
]

test('fetchAssistants filters online stage assistants and sends auth headers', async () => {
  const mock = createMockFetch(ASSISTANTS)
  const result = await fetchAssistants({
    baseUrl: 'http://console.test:8080/',
    apiKey: 'ask_test_key',
    fetch: mock.fetchImpl,
  })

  assert.equal(result.length, 1)
  assert.equal(result[0]?.sessionId, 'assistant-1')
  assert.equal(result[0]?.gatewayWsPath, '/a/assistant-1/ws')

  assert.equal(mock.calls.length, 1)
  assert.equal(mock.calls[0]?.url, 'http://console.test:8080/api/assistants')
  assert.equal(mock.calls[0]?.headers.Authorization, 'Bearer ask_test_key')
  assert.equal(mock.calls[0]?.headers['X-API-Key'], 'ask_test_key')
})

test('fetchAssistants supports X-API-Key-only auth', async () => {
  const mock = createMockFetch(ASSISTANTS)
  const result = await fetchAssistants({
    baseUrl: 'https://console.example.com',
    apiKey: 'ask_key',
    authHeader: 'x-api-key',
    fetch: mock.fetchImpl,
  })
  assert.equal(result.length, 1)
  assert.equal(mock.calls[0]?.headers['X-API-Key'], 'ask_key')
  assert.equal(mock.calls[0]?.headers.Authorization, undefined)
  assert.equal(mock.calls[0]?.url, 'https://console.example.com/api/assistants')
})

test('fetchAssistants surfaces HTTP failures as DiscoveryError', async () => {
  const mock = createMockFetch({ error: 'unauthorized' }, { status: 401, statusText: 'Unauthorized' })
  await assert.rejects(
    fetchAssistants({ baseUrl: 'http://console.test', apiKey: 'bad', fetch: mock.fetchImpl }),
    (error: unknown) => error instanceof DiscoveryError && error.status === 401,
  )
})

test('fetchAssistants rejects invalid payloads and base URLs', async () => {
  const notArray = createMockFetch({ assistants: [] })
  await assert.rejects(
    fetchAssistants({ baseUrl: 'http://console.test', fetch: notArray.fetchImpl }),
    (error: unknown) => error instanceof DiscoveryError,
  )

  await assert.rejects(
    fetchAssistants({ baseUrl: 'not-a-url', fetch: createMockFetch([]).fetchImpl }),
    (error: unknown) => error instanceof DiscoveryError,
  )

  const brokenJson = {
    fetch: async () => ({
      ok: true,
      status: 200,
      json: async () => {
        throw new SyntaxError('bad json')
      },
    }),
  } as { fetch: FetchLike }
  await assert.rejects(
    fetchAssistants({ baseUrl: 'http://console.test', fetch: brokenJson.fetch }),
    (error: unknown) => error instanceof DiscoveryError,
  )
})

test('isStageAssistant enforces the discovery selection rule', () => {
  assert.equal(isStageAssistant(ASSISTANTS[0]), true)
  assert.equal(isStageAssistant(ASSISTANTS[1]), false)
  assert.equal(isStageAssistant(ASSISTANTS[2]), false)
  assert.equal(isStageAssistant(ASSISTANTS[3]), false)
  assert.equal(isStageAssistant(null), false)
  assert.equal(isStageAssistant('online'), false)
})

test('buildGatewayWsUrl builds wss/ws URLs with the api_key query parameter', () => {
  assert.equal(
    buildGatewayWsUrl('http://127.0.0.1:8080', '/a/assistant-1/ws', 'ask_test'),
    'ws://127.0.0.1:8080/a/assistant-1/ws?api_key=ask_test',
  )
  assert.equal(
    buildGatewayWsUrl('https://console.example.com/', '/a/assistant-1/ws', 'ask_test'),
    'wss://console.example.com/a/assistant-1/ws?api_key=ask_test',
  )
  assert.equal(
    buildGatewayWsUrl('https://console.example.com', '/a/x/ws'),
    'wss://console.example.com/a/x/ws',
  )
  assert.equal(
    buildGatewayWsUrl('wss://console.example.com', 'a/x/ws'),
    'wss://console.example.com/a/x/ws',
  )
  assert.equal(
    buildGatewayWsUrl('https://console.example.com', 'wss://other.example/a/y/ws', 'ask_key'),
    'wss://other.example/a/y/ws?api_key=ask_key',
  )
  // The key must be URL-encoded in the query string.
  assert.equal(
    buildGatewayWsUrl('http://127.0.0.1:8080', '/a/x/ws', 'ask_a/b'),
    'ws://127.0.0.1:8080/a/x/ws?api_key=ask_a%2Fb',
  )
  // Custom query parameter name.
  assert.equal(
    buildGatewayWsUrl('http://127.0.0.1:8080', '/a/x/ws', 'k', { apiKeyParam: 'token' }),
    'ws://127.0.0.1:8080/a/x/ws?token=k',
  )
  assert.throws(() => buildGatewayWsUrl('ftp://console.example.com', '/a/x/ws'), StageChannelError)
  assert.throws(() => buildGatewayWsUrl('http://console.example.com', ''), StageChannelError)
})

test('buildDirectWsUrl builds direct StageChannel URLs', () => {
  assert.equal(buildDirectWsUrl('127.0.0.1', 41232), 'ws://127.0.0.1:41232/ws')
  assert.equal(buildDirectWsUrl('assistant.local', 41232, '/stage'), 'ws://assistant.local:41232/stage')
  assert.equal(buildDirectWsUrl('assistant.local', 41232, 'ws', true), 'wss://assistant.local:41232/ws')
  assert.equal(buildDirectWsUrl('assistant.local', 41232, '/ws', true), 'wss://assistant.local:41232/ws')
  assert.equal(buildDirectWsUrl('::1', 41232), 'ws://[::1]:41232/ws')
  assert.equal(buildDirectWsUrl('[::1]', 41232), 'ws://[::1]:41232/ws')
  assert.throws(() => buildDirectWsUrl('', 41232), ProtocolError)
  assert.throws(() => buildDirectWsUrl('host', 0), ProtocolError)
  assert.throws(() => buildDirectWsUrl('host', 70000), ProtocolError)
})
