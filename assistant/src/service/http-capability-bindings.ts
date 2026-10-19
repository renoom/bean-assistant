/** Management API and browser UI bindings for assistant capabilities. */

import { readFile } from 'node:fs/promises'
import type { IncomingMessage } from 'node:http'
import { fileURLToPath } from 'node:url'
import type { AssistantCapabilities } from './capabilities.js'
import { bytes, type HttpService, json, readJson } from './http-service.js'

/** Attach management queries and the browser UI to an HTTP transport. */
export function bindManagementApi(http: HttpService, capabilities: AssistantCapabilities): () => void {
  const disposers = [
    http.registerRoute('GET', '/', async (_req, res) => {
      const html = await readFile(fileURLToPath(new URL('../../web-ui/index.html', import.meta.url)), 'utf8')
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end(html)
    }),
    http.registerRoute('GET', '/api/health', async (_req, res) => { json(res, 200, { ok: true, name: capabilities.config.name }) }),
    http.registerRoute('GET', '/api/auth/status', async (_req, res) => { json(res, 200, { enabled: false }) }),
    http.registerRoute('GET', '/api/status', async (_req, res) => { json(res, 200, capabilities.status()) }),
    http.registerRoute('POST', '/api/scheduler/wake', async (req, res) => {
      const body = await readJson(req)
      if (body === null) { json(res, 400, { error: 'invalid JSON body' }); return }
      json(res, 200, await capabilities.scheduledWake(body))
    }),
    http.registerRoute('GET', '/api/stage', async (_req, res) => { json(res, 200, capabilities.stages.snapshot()) }),
    http.registerRoute('GET', '/api/stage/bridges', async (_req, res) => { json(res, 200, { bridges: capabilities.stages.bridges() }) }),
    http.registerRoute('GET', '/api/stage/registrations', async (_req, res) => { json(res, 200, { registrations: capabilities.stages.registrations() }) }),
    http.registerRoute('POST', '/api/config/push', async (req, res) => {
      const body = await readJson(req)
      if (body === null) { json(res, 400, { error: 'invalid JSON body' }); return }
      await capabilities.pushConfig(body)
      json(res, 200, { ok: true })
    }),
    http.registerHandler(async (req, res) => {
      if (req.method !== 'GET') return false
      const url = requestUrl(req)
      if (url.pathname === '/api/history') {
        const before = parseInt(url.searchParams.get('before') ?? '', 10)
        const limit = parseInt(url.searchParams.get('limit') ?? '100', 10)
        json(res, 200, capabilities.history(Number.isFinite(before) ? before : undefined, limit))
        return true
      }
      if (url.pathname === '/api/observability') { json(res, 200, capabilities.observability()); return true }
      if (url.pathname === '/api/dsh/settings' && capabilities.config.dshApi) { json(res, 200, capabilities.config.dshApi.settingsDescribe()); return true }
      if (url.pathname === '/api/dsh/providers' && capabilities.config.dshApi) { json(res, 200, capabilities.config.dshApi.providers()); return true }
      if (url.pathname === '/api/dsh/models' && capabilities.config.dshApi) {
        json(res, 200, await capabilities.config.dshApi.models(url.searchParams.get('provider') ?? ''))
        return true
      }
      if (url.pathname.startsWith('/api/image/')) {
        bytes(res, await capabilities.readGeneratedImage(url.pathname.slice('/api/image/'.length)))
        return true
      }
      if (url.pathname.startsWith('/api/attachment/')) {
        bytes(res, await capabilities.readAttachment(decodeURIComponent(url.pathname.slice('/api/attachment/'.length))))
        return true
      }
      return false
    }),
  ]
  return () => {
    for (const dispose of disposers) dispose()
  }
}

function requestUrl(req: IncomingMessage): URL {
  return new URL(req.url ?? '/', 'http://localhost')
}
