import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import test from 'node:test'
import { fetchResolvedConfig } from './fetch.js'

function listen(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve((server.address() as { port: number }).port))
  })
}

function close(server: Server): Promise<void> {
  return new Promise(resolve => server.close(() => resolve()))
}

test('fetchResolvedConfig tolerates runtime failures and reports strict failures', async () => {
  const server = createServer((_req, res) => {
    res.writeHead(401, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: 'unauthorized' }))
  })
  const port = await listen(server)

  try {
    assert.equal(await fetchResolvedConfig(`http://127.0.0.1:${port}`, 'assistant-1'), null)
    await assert.rejects(
      fetchResolvedConfig(`http://127.0.0.1:${port}`, 'assistant-1', 2000, { throwOnError: true }),
      /HTTP 401 Unauthorized/,
    )
  } finally {
    await close(server)
  }
})

test('fetchResolvedConfig accepts valid envelopes and rejects invalid envelopes in strict mode', async () => {
  const server = createServer((req, res) => {
    const body = req.url?.includes('invalid')
      ? { revision: 3, config: null }
      : { revision: 7, config: { provider: 'test', model: 'test-model' } }
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(body))
  })
  const port = await listen(server)

  try {
    assert.deepEqual(await fetchResolvedConfig(`http://127.0.0.1:${port}`, 'assistant-1'), {
      revision: 7,
      config: { provider: 'test', model: 'test-model' },
    })
    await assert.rejects(
      fetchResolvedConfig(`http://127.0.0.1:${port}`, 'invalid', 2000, { throwOnError: true }),
      /缺少 config 对象/,
    )
  } finally {
    await close(server)
  }
})
