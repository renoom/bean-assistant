import assert from 'node:assert/strict'
import { request } from 'node:http'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { ApiKeyAuth } from './auth.ts'
import { ConfigCenter, loadConfig } from './config.ts'
import { KnowledgeCenter } from './knowledge/index.ts'
import { KnowledgeStore } from './knowledge/store.ts'
import { Registry } from './registry.ts'
import { createConsoleServer } from './server.ts'

function readHttp(port: number, path: string, headers: Record<string, string> = {}): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, headers }, res => {
      let body = ''
      res.setEncoding('utf8')
      res.on('data', chunk => { body += chunk })
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }))
    })
    req.on('error', reject)
    req.end()
  })
}

test('config resolve permits direct loopback assistants but protects management API', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'console-server-test-'))
  const { auth } = await ApiKeyAuth.load(join(directory, 'api-key.json'), { initialKey: 'test-key' })
  const consoleServer = await createConsoleServer(
    new Registry(),
    new ConfigCenter(await loadConfig()),
    new KnowledgeCenter(new KnowledgeStore(join(directory, 'knowledge'))),
    auth,
    { host: '127.0.0.1', port: 0 },
    async () => {},
  )
  const address = consoleServer.server.address()
  assert.ok(address && typeof address === 'object')
  const port = address.port

  try {
    const loopback = await readHttp(port, '/api/config/resolve?sessionId=assistant-1')
    assert.equal(loopback.status, 200)
    assert.equal(typeof JSON.parse(loopback.body).config, 'object')

    assert.equal((await readHttp(port, '/api/config')).status, 401)
    assert.equal((await readHttp(port, '/api/config/resolve?sessionId=assistant-1', { 'x-forwarded-for': '203.0.113.10' })).status, 401)

    const authorized = await readHttp(port, '/api/config/resolve?sessionId=assistant-1', { authorization: 'Bearer test-key' })
    assert.equal(authorized.status, 200)
  } finally {
    await consoleServer.dispose()
  }
})
