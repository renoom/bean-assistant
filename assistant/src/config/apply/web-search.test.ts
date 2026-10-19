import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { CallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import WebRuntime from '@deepseek-ai/dsh-web'
import * as SearchProvider from '@deepseek-ai/dsh-web-search-deepseek'
import * as FetchProvider from '@deepseek-ai/dsh-web-fetch-http'
import * as ToolWeb from '@deepseek-ai/dsh-tool-web'
import MemorySettingsProvider from '../settings-provider.js'
import { normalizeEnvelope } from '../fetch.js'
import { createProviderApplier } from './providers.js'
import { addWebSearchCredential, webSearchSection } from './web-search.js'

test('search config survives transport and separates endpoint and credential ownership', () => {
  const search = { apiKey: '', apiKeyEnv: 'SEARCH_KEY', baseURL: 'https://search.example/v1', model: 'search-only', maxTokens: 2048, maxUses: 2 }
  assert.deepEqual(normalizeEnvelope({ revision: 1, config: { webSearch: search } })?.config.webSearch, search)
  const providers = { deepseek: { apiKeyEnv: 'CHAT_KEY', apiKey: 'chat-test-key', baseURL: 'https://chat.example/v1' } }
  assert.deepEqual(webSearchSection(undefined, providers), { apiKeyEnv: 'CHAT_KEY' })
  assert.deepEqual(webSearchSection({ apiKey: 'search-test-key' }, providers), { apiKeyEnv: 'DEEPSEEK_SEARCH_API_KEY' })
  const keys = new Map([['CHAT_KEY', 'chat-test-key']])
  addWebSearchCredential(keys, { apiKey: 'search-test-key' }, providers)
  assert.equal(keys.get('CHAT_KEY'), 'chat-test-key')
  assert.equal(keys.get('DEEPSEEK_SEARCH_API_KEY'), 'search-test-key')
  assert.throws(() => addWebSearchCredential(keys, { apiKeyEnv: 'CHAT_KEY', apiKey: '' }, providers), /凭证引用 CHAT_KEY 冲突/)
})

test('native tool calls search and fetch, apply hot settings, and report provider failures', async t => {
  const requests: Array<{ path: string; body: any; key: string | undefined }> = []
  let fail = false
  const server = createServer(async (req, res) => {
    if (req.url === '/page') {
      res.writeHead(200, { 'content-type': 'text/html' })
      res.end('<h1>Search source</h1><p>Readable webpage content.</p>')
      return
    }
    let raw = ''
    for await (const chunk of req) raw += chunk
    requests.push({ path: req.url!, body: JSON.parse(raw), key: req.headers['x-api-key'] as string | undefined })
    res.writeHead(fail ? 503 : 200, { 'content-type': 'application/json' })
    res.end(JSON.stringify(fail ? { error: { message: 'Search unavailable' } } : {
      content: [
        { type: 'text', text: 'Provider answer is not a search source', citations: [{ url: 'https://example.com/source', cited_text: 'Source excerpt' }] },
        { type: 'web_search_tool_result', content: [{ type: 'web_search_result', url: 'https://example.com/source', title: 'Source title', page_age: '2026-10-08' }] },
      ],
    }))
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address() as { port: number }
  const base = `http://127.0.0.1:${address.port}`
  const ctx = new Context()
  t.after(async () => { await ctx.fiber.dispose(); await new Promise<void>(resolve => server.close(() => resolve())) })
  const keys = new Map<string, string>()
  ctx.provide('credentials', {
    resolve: async (ref: string) => keys.has(ref) ? { value: keys.get(ref), source: 'test' } : undefined,
    set: async (ref: string, value: string) => { keys.set(ref, value) },
    unset: async (ref: string) => { keys.delete(ref) },
  } as any)
  for (const [plugin, config] of [
    [SystemPrompt, {}], [ToolRuntime, {}], [WebRuntime, { searchProvider: 'deepseek-official' }],
    [MemorySettingsProvider, {}], [SearchProvider, {}], [FetchProvider, {}],
    [ToolWeb, { search: true, fetch: true, searchTimeoutMs: 60000 }],
  ] as const) {
    await ctx.plugin(plugin as any, config).await()
  }
  const apply = createProviderApplier(ctx)
  const published: Record<string, unknown>[] = []
  const settings = ctx.settings as MemorySettingsProvider
  const originalPush = settings.push.bind(settings)
  t.mock.method(settings, 'push', (doc: Record<string, unknown>) => { published.push(doc); originalPush(doc) })
  const chat = { deepseek: { apiKeyEnv: 'CHAT_KEY', apiKey: 'chat-test-key', baseURL: 'https://chat.example' } }
  await apply.apply(chat, { baseURL: `${base}/first`, model: 'first-search', maxTokens: 1024, maxUses: 2 })
  assert.deepEqual(Object.keys(published[0]).sort(), ['llm-deepseek', 'llm-pi-ai', 'web-search-deepseek'])
  assert.equal((published[0]['llm-deepseek'] as any).baseURL, 'https://chat.example')
  assert.doesNotMatch(JSON.stringify(published[0]), /chat-test-key/)
  const call = (name: string, args: unknown) => ctx.tools.execute({ name, arguments: args, callId: CallId('search-test'), signal: new AbortController().signal })
  const first = await call('web_search', { query: 'latest information' })
  assert.equal(first.isError, false)
  const text = first.content.filter(block => block.type === 'text').map(block => block.text).join('\n')
  assert.match(text, /Source title.*https:\/\/example.com\/source/)
  assert.match(text, /Source excerpt/)
  assert.doesNotMatch(text, /Provider answer is not/)
  assert.equal(requests[0].path, '/first/messages')
  assert.equal(requests[0].key, 'chat-test-key')
  assert.equal(requests[0].body.model, 'first-search')
  assert.equal(requests[0].body.max_tokens, 1024)
  assert.equal(requests[0].body.tools[0].max_uses, 2)
  await apply.apply(chat, { apiKey: 'independent-test-key', baseURL: `${base}/second`, model: 'second-search' })
  assert.equal((await call('web_search', { query: 'updated config' })).isError, false)
  assert.equal(requests[1].path, '/second/messages')
  assert.equal(requests[1].body.model, 'second-search')
  assert.equal(requests[1].key, 'independent-test-key')
  assert.equal(keys.get('CHAT_KEY'), 'chat-test-key')
  const described = ctx.settings.describe().find(row => String(row.ns) === 'web-search-deepseek')
  assert.ok(described)
  assert.doesNotMatch(JSON.stringify(described), /independent-test-key/)
  const fetched = await call('web_fetch', { url: `${base}/page` })
  assert.equal(fetched.isError, false)
  assert.match(JSON.stringify(fetched.content), /Readable webpage content/)
  fail = true
  assert.equal((await call('web_search', { query: 'service failure' })).isError, true)
  await apply.apply(chat)
  assert.equal(keys.has('DEEPSEEK_SEARCH_API_KEY'), false)
  assert.equal(keys.get('CHAT_KEY'), 'chat-test-key')
  await apply.apply(undefined, { baseURL: `${base}/no-key` })
  const beforeMissing = requests.length
  const missing = await call('web_search', { query: 'no credential' })
  assert.equal(missing.isError, true)
  assert.equal(missing.error?.info?.code, 'WEB_PROVIDER_CREDENTIAL_MISSING')
  assert.equal(requests.length, beforeMissing)
})
