import assert from 'node:assert/strict'
import { createServer, get, request } from 'node:http'
import { connect } from 'node:net'
import test from 'node:test'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ApiKeyAuth } from './auth.ts'
import { ConsoleGateway } from './gateway.ts'
import { Registry } from './registry.ts'

function listen(server: ReturnType<typeof createServer>): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve((server.address() as { port: number }).port))
  })
}

function close(server: ReturnType<typeof createServer>): Promise<void> {
  return new Promise(resolve => server.close(() => resolve()))
}

function readHttp(port: number, path: string, key: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, headers: { Authorization: `Bearer ${key}` } }, res => {
      let body = ''
      res.setEncoding('utf8')
      res.on('data', chunk => { body += chunk })
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }))
    })
    req.on('error', reject)
    req.end()
  })
}

function readUpgrade(port: number, path: string, key: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, '127.0.0.1')
    let received = ''
    socket.setEncoding('utf8')
    socket.on('connect', () => socket.write(
      `GET ${path}?api_key=${key} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n`,
    ))
    socket.on('data', chunk => { received += chunk })
    socket.on('end', () => resolve(received))
    socket.on('error', reject)
  })
}

test('gateway separates management, HTTP Channel, and StageChannel endpoints', async () => {
  const management = createServer((_req, res) => { res.end('management') })
  const httpChannel = createServer((_req, res) => { res.end('http-channel') })
  const stageChannel = createServer()
  stageChannel.on('upgrade', (_req, socket) => {
    socket.write('HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n')
    socket.end()
  })
  const [managementPort, httpPort, stagePort] = await Promise.all([listen(management), listen(httpChannel), listen(stageChannel)])
  const registry = new Registry()
  const directory = await mkdtemp(join(tmpdir(), 'console-gateway-test-'))
  const { auth } = await ApiKeyAuth.load(join(directory, 'api-key.json'), { initialKey: 'test-key' })
  let gateway: ConsoleGateway
  const gatewayServer = createServer((req, res) => {
    void gateway.handleHttp(req, res, new URL(req.url ?? '/', 'http://127.0.0.1'))
  })
  gateway = new ConsoleGateway({ server: gatewayServer, registry, auth })
  const gatewayPort = await listen(gatewayServer)

  registry.register({
    name: 'separated', host: '127.0.0.1', port: managementPort, model: 'test', provider: 'test', sessionId: 'separated', channels: ['http', 'stage'],
    channelEndpoints: [
      { id: 'http', protocol: 'http', host: '127.0.0.1', port: httpPort, path: '/api/message' },
      { id: 'stage', protocol: 'ws', host: '127.0.0.1', port: stagePort, path: '/ws' },
    ],
  })
  registry.register({ name: 'disabled', host: '127.0.0.1', port: managementPort, model: 'test', provider: 'test', sessionId: 'disabled', channels: [], channelEndpoints: [] })
  registry.register({ name: 'legacy', host: '127.0.0.1', port: managementPort, model: 'test', provider: 'test', sessionId: 'legacy', channels: ['http'] })

  try {
    assert.deepEqual(await readHttp(gatewayPort, '/a/separated/api/message', 'test-key'), { status: 200, body: 'http-channel' })
    assert.deepEqual(await readHttp(gatewayPort, '/a/separated/api/status', 'test-key'), { status: 200, body: 'management' })
    assert.match(await readUpgrade(gatewayPort, '/a/separated/ws', 'test-key'), /^HTTP\/1\.1 101 /)
    assert.equal((await readHttp(gatewayPort, '/a/disabled/api/message', 'test-key')).status, 503)
    assert.match(await readUpgrade(gatewayPort, '/a/disabled/ws', 'test-key'), /^HTTP\/1\.1 404 /)
    assert.deepEqual(await readHttp(gatewayPort, '/a/legacy/api/message', 'test-key'), { status: 200, body: 'management' })
  } finally {
    gateway.dispose()
    await Promise.all([close(gatewayServer), close(management), close(httpChannel), close(stageChannel)])
  }
})
