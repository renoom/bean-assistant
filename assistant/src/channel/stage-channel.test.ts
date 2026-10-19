import assert from 'node:assert/strict'
import test from 'node:test'
import type { AddressInfo } from 'node:net'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { AttachmentStore } from '@deepseek-ai/dsh-attachment'
import WebSocket from 'ws'
import { StageRegistry } from '../stage/manager.js'
import { AssistantCapabilities } from '../service/capabilities.js'
import { AssistantEventHub } from '../service/event-hub.js'
import { HttpService } from '../service/http-service.js'
import { bindManagementApi } from '../service/http-capability-bindings.js'
import { StageChannel } from './stage-channel.js'
import { HttpChannel } from './http-channel.js'
import { bindAgent } from '../memory/gate.js'

test('independent channels share one Agent, while management queries stay outside interaction listeners', async t => {
  const inputs: unknown[] = []
  const sessionEvents: any[] = []
  const imageBytes = new Uint8Array([1, 2, 3])
  const savedImages: Array<{ data: Uint8Array; mediaType: string; name?: string }> = []
  const attachments = {
    imageLimits: {
      maxImageBytes: 100000,
      maxImagesPerMessage: 4,
      maxMessageImageBytes: 100000,
      maxImagePixels: 100000,
      mediaTypes: ['image/png'],
    },
    validateImage: async () => {},
    saveImage: async (image: { data: Uint8Array; mediaType: string; name?: string }) => {
      savedImages.push(image)
      return {
        attachmentId: `image-${savedImages.length}`,
        mediaType: image.mediaType,
        bytes: image.data.byteLength,
        width: 1,
        height: 1,
        name: image.name,
      }
    },
    readImage: async (ref: any) => ({ ref, data: imageBytes }),
  } as unknown as AttachmentStore
  let contextText = () => ''
  let stageTool: any
  const agent = {
    status: 'idle', options: {},
    ctx: {
      systemPrompt: { context: (def: { text: () => string }) => { contextText = def.text; return () => {} } },
      tools: { register: (tool: unknown) => { stageTool = tool; return () => {} } }, on: () => () => {},
    },
    session: { id: 'test-session', events: sessionEvents },
    whenIdle: async () => {}, cancel: () => {}, followup: (m: unknown) => inputs.push(m),
  } as unknown as Agent
  bindAgent(agent)
  const stages = new StageRegistry(agent)
  const events = new AssistantEventHub(agent)
  const capabilities = new AssistantCapabilities(agent, stages, {
    name: 'test',
    attachments,
    getRuntimeModel: () => ({ provider: 'vision', model: 'test' }),
    dshApi: {
      settingsDescribe: () => ({}),
      providers: () => [],
      models: async () => [],
      resolveModel: async () => ({ inputModalities: ['text', 'image'] }),
    },
  })
  const management = new HttpService({ host: '127.0.0.1', port: 0 })
  const disposeManagement = bindManagementApi(management, capabilities)
  const stageChannel = new StageChannel({ host: '127.0.0.1', port: 0 }, capabilities, events, stages)
  const http = new HttpChannel({ host: '127.0.0.1', port: 0 }, capabilities, events)
  const sockets: WebSocket[] = []
  t.after(async () => {
    for (const socket of sockets) socket.terminate()
    await stageChannel.dispose(); await http.dispose(); disposeManagement(); await management.dispose()
    events.dispose(); stages.dispose()
  })
  await management.listen()
  const managementPort = (management.server.address() as AddressInfo).port
  const httpEndpoint = await http.start()
  const stageEndpoint = await stageChannel.start()
  assert.equal(new Set([managementPort, httpEndpoint.port, stageEndpoint.port]).size, 3)
  const port = httpEndpoint.port
  async function connect(clientType: string, clientId: string, extra = {}) {
    const socket = new WebSocket(`ws://127.0.0.1:${stageEndpoint.port}/ws`)
    sockets.push(socket)
    await new Promise<void>((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject) })
    const hello = await request(socket, { type: 'hello', channel: 'stage', clientType, clientId, ...extra }, 'hello_ack')
    assert.equal(hello.channel, 'stage')
    return socket
  }
  const client = await connect('godot', 'godot', { role: 'assistant', assistantId: 'npc' })
  const emptyContext = contextText()
  const stage = { id: 'town:a', kind: 'town', environment: { text: 'Environment A' }, commands: [{ name: 'say' }] }
  const registration = await request(client, { type: 'stage_register', stage }, 'stage_register_result')
  assert.equal(registration.result.kind, 'registered')
  assert.equal(contextText(), emptyContext)
  await request(client, { type: 'stage_register', stage: { ...stage, id: 'town:b', environment: { text: 'Environment B' } } }, 'stage_register_result')
  assert.equal(stages.registrations().length, 2)
  const activated = await request(client, { type: 'stage_activate', stageId: 'town:a' }, 'stage_activate_result')
  assert.equal(activated.result.kind, 'changed')
  assert.match(contextText(), /Environment A/)
  const context = contextText()
  const revision = stages.snapshot().revision
  const repeated = await request(client, { type: 'stage_register', stage }, 'stage_register_result')
  assert.equal(repeated.result.kind, 'unchanged')
  assert.equal(stages.snapshot().revision, revision)
  assert.equal(contextText(), context)
  assert.equal(stages.snapshot().participants[0]?.id, 'npc')
  const commandFrame = request(client, {}, 'command')
  const toolResult = stageTool.execute({ action: 'execute', command: 'say', args: { text: 'Bridge hello' } }, {})
  const command = await commandFrame
  assert.equal(command.stageId, 'town:a')
  assert.equal(command.command, 'say')
  assert.deepEqual(command.args, { text: 'Bridge hello' })
  client.send(JSON.stringify({ type: 'command_result', commandId: command.commandId, ok: true, result: { spoken: true } }))
  assert.deepEqual((await toolResult).result, { spoken: true })
  const rejected = await request(client, { type: 'event', stageId: 'town:b', event: { kind: 'test' } }, 'event_rejected')
  assert.match(rejected.reason, /not current/)
  const unknown = await request(client, { type: 'stage_activate', stageId: 'other' }, 'stage_activate_result')
  assert.equal(unknown.result.kind, 'rejected')
  const browser = await connect('arbitrary-client', 'browser')
  const stream = await fetch(`http://127.0.0.1:${port}/api/stream`)
  const reader = stream.body!.getReader()
  try {
    assert.match(new TextDecoder().decode((await reader.read()).value), /connected/)
    const wsOutput = request(browser, {}, 'llm_event')
    const frame = { type: 'custom_client_event', data: { text: 'shared output' } }
    events.emit(frame)
    assert.deepEqual((await wsOutput).event, frame)
    assert.match(new TextDecoder().decode((await reader.read()).value), /shared output/)
  } finally { await reader.cancel() }
  // Model request observations contain complete context and can exceed 64 KiB.
  const modelFrame = { type: 'model_request', data: { system: '环境'.repeat(65536), messages: [], tools: [] } }
  const largeOutput = request(browser, {}, 'llm_event')
  events.emit(modelFrame)
  assert.deepEqual((await largeOutput).event, modelFrame)
  for (const connection of [browser, client]) {
    const response = await request(connection, { type: 'chat', text: '你好' }, 'chat_result')
    assert.equal(response.accepted, true)
  }
  const httpChat = await fetch(`http://127.0.0.1:${port}/api/message`, { method: 'POST', body: JSON.stringify({ text: 'HTTP hello' }) })
  assert.equal(httpChat.status, 200)
  assert.equal(inputs.length, 3)
  const image = Buffer.from(imageBytes).toString('base64')
  const wsImage = await request(browser, {
    type: 'chat', text: 'WS image', images: [{ data: image, mimeType: 'image/png', name: 'ws.png' }],
  }, 'chat_result')
  assert.equal(wsImage.accepted, true)
  assert.equal(wsImage.attachments[0].name, 'ws.png')
  const httpImage = await fetch(`http://127.0.0.1:${port}/api/message`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: 'HTTP image', images: [{ data: image, mimeType: 'image/png', name: 'http.png' }] }),
  })
  assert.equal(httpImage.status, 200)
  const httpImageResult = await httpImage.json() as any
  assert.equal(httpImageResult.attachments[0].name, 'http.png')
  assert.equal(inputs.length, 5)
  assert.equal(savedImages.length, 2)
  assert.deepEqual(savedImages.map(item => [...item.data]), [[1, 2, 3], [1, 2, 3]])
  assert.deepEqual((inputs[3] as any).content.map((block: any) => block.type), ['text', 'image'])
  sessionEvents.push({ type: 'user/message', data: inputs[3] })
  const attachment = await fetch(`http://127.0.0.1:${managementPort}/api/attachment/${wsImage.attachments[0].attachmentId}`)
  assert.equal(attachment.status, 200)
  assert.equal(attachment.headers.get('content-type'), 'image/png')
  assert.deepEqual([...new Uint8Array(await attachment.arrayBuffer())], [1, 2, 3])
  assert.equal((await fetch(`http://127.0.0.1:${managementPort}/`)).status, 200)
  assert.equal((await fetch(`http://127.0.0.1:${managementPort}/api/history`)).status, 200)
  assert.equal((await fetch(`http://127.0.0.1:${port}/api/history`)).status, 404)
  assert.equal((await fetch(`http://127.0.0.1:${port}/api/status`)).status, 404)
  assert.equal((await fetch(`http://127.0.0.1:${stageEndpoint.port}/api/status`)).status, 404)
  assert.equal((await fetch(`http://127.0.0.1:${managementPort}/api/message`, { method: 'POST', body: JSON.stringify({ text: 'should not enter Agent' }) })).status, 404)
  assert.equal((await fetch(`http://127.0.0.1:${managementPort}/api/stream`)).status, 404)
  assert.equal(inputs.length, 5)
  const closed = new Promise<void>(resolve => client.once('close', () => resolve()))
  client.close(); await closed
  // Server close notification may follow the client-side notification.
  for (let n = 0; n < 20 && stages.snapshot().status !== 'suspended'; n++) await new Promise(r => setTimeout(r, 5))
  assert.equal(stages.snapshot().status, 'suspended')
  assert.equal(contextText(), context)
  const reconnected = await connect('godot', 'godot', { role: 'assistant', assistantId: 'npc' })
  await request(reconnected, { type: 'stage_register', stage }, 'stage_register_result')
  assert.equal(stages.snapshot().status, 'active')
  assert.equal(stages.snapshot().revision, revision)
  assert.equal(contextText(), context)
  const replacementClosed = new Promise<{ code: number; reason: string }>(resolve => {
    reconnected.once('close', (code, reason) => resolve({ code, reason: reason.toString() }))
  })
  const replacement = await connect('godot', 'godot', { role: 'assistant', assistantId: 'npc' })
  assert.deepEqual(await replacementClosed, { code: 4001, reason: 'clientId replaced by a new connection' })
  await request(replacement, { type: 'stage_register', stage }, 'stage_register_result')
  assert.equal(stages.snapshot().status, 'active')
  assert.equal(stages.snapshot().participants[0]?.id, 'npc')
  await request(replacement, { type: 'stage_register', stage: { ...stage, id: 'town:b', environment: { text: 'Environment B' } } }, 'stage_register_result')
  await request(replacement, { type: 'stage_activate', stageId: 'town:b' }, 'stage_activate_result')
  assert.match(contextText(), /Environment B/)
  assert.doesNotMatch(contextText(), /Environment A/)
  const pendingFrame = request(replacement, {}, 'command')
  const pendingTool = stageTool.execute({ action: 'execute', command: 'say' }, {})
  await pendingFrame
  // Stopping the Stage listener also removes its live registrations; HTTP and management remain up.
  await stageChannel.dispose()
  assert.equal((await pendingTool).ok, false)
  assert.equal(stages.registrations().length, 0)
  assert.equal(stages.snapshot().status, 'suspended')
  assert.equal((await fetch(`http://127.0.0.1:${managementPort}/api/status`)).status, 200)
  assert.equal((await fetch(`http://127.0.0.1:${port}/api/message`, { method: 'POST', body: JSON.stringify({ text: 'HTTP survives Stage shutdown' }) })).status, 200)
})

test('management works without any interaction channels, and fixed port collisions preserve the existing listener', async t => {
  const agent = {
    status: 'idle', options: {}, session: { id: 'disabled-test', events: [] },
    ctx: { systemPrompt: { context: () => () => {} }, tools: { register: () => () => {} }, on: () => () => {} },
  } as unknown as Agent
  const stages = new StageRegistry(agent)
  const events = new AssistantEventHub(agent)
  const capabilities = new AssistantCapabilities(agent, stages, {
    name: 'no channels', attachments: {} as AttachmentStore, getChannelEndpoints: () => [],
  })
  const management = new HttpService({ host: '127.0.0.1', port: 0 })
  const unbind = bindManagementApi(management, capabilities)
  const conflicts: Array<StageChannel | HttpChannel> = []
  t.after(async () => {
    for (const channel of conflicts) await channel.dispose()
    unbind(); await management.dispose(); events.dispose(); stages.dispose()
  })
  await management.listen()
  const port = (management.server.address() as AddressInfo).port
  const status = await (await fetch(`http://127.0.0.1:${port}/api/status`)).json() as any
  assert.deepEqual(status.channelEndpoints, [])
  assert.equal((await fetch(`http://127.0.0.1:${port}/api/message`, { method: 'POST', body: '{}' })).status, 404)
  assert.equal((await fetch(`http://127.0.0.1:${port}/api/stream`)).status, 404)
  assert.equal((await fetch(`http://127.0.0.1:${port}/api/stage/transition`, { method: 'POST', body: '{}' })).status, 404)
  for (const channel of [
    new HttpChannel({ host: '127.0.0.1', port }, capabilities, events),
    new StageChannel({ host: '127.0.0.1', port }, capabilities, events, stages),
  ]) {
    conflicts.push(channel)
    await assert.rejects(channel.start(), { code: 'EADDRINUSE' })
    assert.equal((await fetch(`http://127.0.0.1:${port}/api/status`)).status, 200)
  }
})

// Protocol responses are intentionally JSON; assertions below validate their discriminants.
function request(socket: WebSocket, frame: Record<string, unknown>, expected: string): Promise<any> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { socket.off('message', onMessage); reject(new Error(`timeout: ${expected}`)) }, 3000)
    const onMessage = (raw: WebSocket.RawData) => {
      const value = JSON.parse(raw.toString())
      if (value.type !== expected && value.type !== 'error') return
      clearTimeout(timer); socket.off('message', onMessage)
      if (value.type === 'error') reject(new Error(value.error))
      else resolve(value)
    }
    socket.on('message', onMessage)
    if (Object.keys(frame).length) socket.send(JSON.stringify(frame))
  })
}
