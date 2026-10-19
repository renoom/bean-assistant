/**
 * Client state-machine tests.
 *
 * A fake WebSocket is injected through `webSocketFactory`, so these tests are
 * fully deterministic and never touch the network. `fetch` is not used by the
 * client (discovery is tested separately in `discovery.test.ts`).
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import type {
  ConnectedInfo,
  DisconnectInfo,
  EventRejectedFrame,
  StageChannelClientOptions,
  WebSocketFactory,
  WebSocketLike,
} from '../src/index.ts'
import {
  ClientReplacedError,
  ConnectionClosedError,
  HandshakeTimeoutError,
  NotConnectedError,
  ProtocolError,
  RequestTimeoutError,
  StageChannelClient,
  StageServerError,
} from '../src/index.ts'

// ── Fake WebSocket ─────────────────────────────────────────────────────────

class FakeSocket implements WebSocketLike {
  readyState = 0
  onopen: ((event: unknown) => void) | null = null
  onmessage: ((event: { data: unknown }) => void) | null = null
  onerror: ((event: unknown) => void) | null = null
  onclose: ((event: { code: number; reason: string; wasClean?: boolean }) => void) | null = null
  readonly sent: string[] = []
  readonly url: string

  constructor(url: string) {
    this.url = url
  }

  open(): void {
    this.readyState = 1
    this.onopen?.({})
  }

  send(data: string): void {
    if (this.readyState !== 1) throw new Error('FakeSocket is not open')
    this.sent.push(data)
  }

  close(code = 1000, reason = ''): void {
    if (this.readyState === 3) return
    this.readyState = 3
    this.onclose?.({ code, reason, wasClean: true })
  }

  receive(frame: unknown): void {
    this.onmessage?.({ data: typeof frame === 'string' ? frame : JSON.stringify(frame) })
  }

  frames(): Record<string, unknown>[] {
    return this.sent.map(text => JSON.parse(text) as Record<string, unknown>)
  }

  framesOfType(type: string): Record<string, unknown>[] {
    return this.frames().filter(frame => frame.type === type)
  }

  lastFrame(): Record<string, unknown> {
    const all = this.frames()
    const last = all[all.length - 1]
    if (!last) throw new Error('no frame was sent')
    return last
  }
}

interface Harness {
  client: StageChannelClient
  sockets: FakeSocket[]
  factory: WebSocketFactory
}

function createHarness(options: Partial<StageChannelClientOptions> = {}): Harness {
  const sockets: FakeSocket[] = []
  const factory: WebSocketFactory = url => {
    const socket = new FakeSocket(url)
    sockets.push(socket)
    return socket
  }
  const client = new StageChannelClient({
    clientId: 'ts-client-1',
    role: 'assistant',
    stage: { id: 'town:meadow', kind: 'town', environment: { text: '萤火镇' }, commands: [{ name: 'say' }] },
    direct: { host: '127.0.0.1', port: 41232 },
    webSocketFactory: factory,
    connectTimeoutMs: 500,
    requestTimeoutMs: 500,
    ...options,
  })
  return { client, sockets, factory }
}

const EMPTY_STAGE = { id: 'empty', kind: 'empty', revision: 0, status: 'empty', participants: [], capabilities: [] }
const ACTIVE_STAGE = {
  id: 'town:meadow',
  kind: 'town',
  revision: 1,
  status: 'active',
  participants: [{ id: 'assistant-1', role: 'assistant', name: '编码助手', online: true }],
  capabilities: [{ name: 'say' }],
  environment: { text: '萤火镇' },
}

function helloAck(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: 'hello_ack',
    channel: 'stage',
    clientId: 'ts-client-1',
    bridgeId: 'stage:ts-client-1:town:meadow',
    registrations: [],
    stage: EMPTY_STAGE,
    ...overrides,
  }
}

function registeredResult(requestId = 'initial-register'): Record<string, unknown> {
  return {
    type: 'stage_register_result',
    requestId,
    result: {
      kind: 'registered',
      registration: {
        id: 'stage:ts-client-1:town:meadow',
        stageId: 'town:meadow',
        stageKind: 'town',
        environment: { text: '萤火镇' },
        capabilities: [{ name: 'say' }],
      },
    },
    stage: EMPTY_STAGE,
  }
}

function activateResult(requestId = 'initial-activate'): Record<string, unknown> {
  return { type: 'stage_activate_result', requestId, result: { kind: 'changed', stage: ACTIVE_STAGE } }
}

function tick(): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, 0))
}

/** Run the assistant handshake up to ACTIVE. */
async function connectAssistant(options: Partial<StageChannelClientOptions> = {}): Promise<Harness & { socket: FakeSocket; info: ConnectedInfo }> {
  const harness = createHarness(options)
  const connectPromise = harness.client.connect()
  const socket = harness.sockets[0]
  if (!socket) throw new Error('mock socket was not created')
  socket.open()
  socket.receive(helloAck())
  socket.receive(registeredResult())
  socket.receive(activateResult())
  const info = await connectPromise
  return { ...harness, socket, info }
}

// ── Handshake ──────────────────────────────────────────────────────────────

test('assistant handshake: hello → stage_register → stage_activate → active', async () => {
  const harness = createHarness()
  const statuses: string[] = []
  const events: string[] = []
  harness.client.on('connected', info => events.push(`connected:${info.status}`))
  const connectPromise = harness.client.connect()
  statuses.push(harness.client.status)

  const socket = harness.sockets[0]
  assert.ok(socket)
  // Direct mode URL.
  assert.equal(socket.url, 'ws://127.0.0.1:41232/ws')
  assert.equal(harness.client.status, 'connecting')

  socket.open()
  statuses.push(harness.client.status)
  const hello = socket.lastFrame()
  assert.equal(hello.type, 'hello')
  assert.equal(hello.channel, 'stage')
  assert.equal(hello.clientId, 'ts-client-1')
  assert.equal(hello.role, 'assistant')
  assert.equal(hello.clientType, 'npm')
  assert.equal(hello.assistantId, undefined)

  socket.receive(helloAck())
  statuses.push(harness.client.status)
  const register = socket.lastFrame()
  assert.equal(register.type, 'stage_register')
  assert.equal(register.requestId, 'initial-register')
  assert.deepEqual(register.stage, {
    id: 'town:meadow',
    kind: 'town',
    environment: { text: '萤火镇' },
    commands: [{ name: 'say' }],
  })

  socket.receive(registeredResult())
  statuses.push(harness.client.status)
  const activate = socket.lastFrame()
  assert.equal(activate.type, 'stage_activate')
  assert.equal(activate.requestId, 'initial-activate')
  assert.equal(activate.stageId, 'town:meadow')

  socket.receive(activateResult())
  const info = await connectPromise
  statuses.push(harness.client.status)

  assert.deepEqual(statuses, ['connecting', 'hello_sent', 'acked', 'registered', 'active'])
  assert.equal(info.role, 'assistant')
  assert.equal(info.stage.id, 'town:meadow')
  assert.equal(info.stage.status, 'active')
  assert.equal(info.bridgeId, 'stage:ts-client-1:town:meadow')
  assert.deepEqual(events, ['connected:active'])
  assert.equal(harness.client.isConnected, true)
})

test('role=user registers but skips stage_activate', async () => {
  const harness = createHarness({ role: 'user' })
  const connectPromise = harness.client.connect()
  const socket = harness.sockets[0]
  assert.ok(socket)
  socket.open()
  const hello = socket.lastFrame()
  assert.equal(hello.role, 'user')
  assert.equal(hello.assistantId, undefined)

  socket.receive(helloAck())
  assert.equal(socket.lastFrame().type, 'stage_register')
  socket.receive(registeredResult())
  const info = await connectPromise

  assert.equal(socket.framesOfType('stage_activate').length, 0)
  assert.equal(harness.client.status, 'registered')
  assert.equal(info.status, 'registered')
})

test('hello_ack with the wrong channel fails the handshake', async () => {
  const harness = createHarness()
  const connectPromise = harness.client.connect()
  const socket = harness.sockets[0]
  assert.ok(socket)
  socket.open()
  socket.receive(helloAck({ channel: 'other' }))
  await assert.rejects(connectPromise, (error: unknown) => error instanceof ProtocolError && /hello_ack/.test(error.message))
  assert.equal(harness.client.status, 'closed')
})

test('register rejection fails the handshake with StageServerError', async () => {
  const harness = createHarness()
  const connectPromise = harness.client.connect()
  const socket = harness.sockets[0]
  assert.ok(socket)
  socket.open()
  socket.receive(helloAck())
  socket.receive({ type: 'stage_register_result', requestId: 'initial-register', result: { kind: 'rejected', reason: 'stage id is taken' }, stage: EMPTY_STAGE })
  await assert.rejects(connectPromise, (error: unknown) => error instanceof StageServerError && /stage id is taken/.test(error.message))
})

test('handshake times out after connectTimeoutMs and closes the socket', async () => {
  const harness = createHarness({ connectTimeoutMs: 20 })
  const connectPromise = harness.client.connect()
  const socket = harness.sockets[0]
  assert.ok(socket)
  // Never send hello_ack.
  await assert.rejects(connectPromise, (error: unknown) => error instanceof HandshakeTimeoutError && error.phase === 'hello')
  assert.equal(harness.client.status, 'closed')
  assert.equal(socket.readyState, 3)
})

test('close code 4001 during the handshake surfaces ClientReplacedError', async () => {
  const harness = createHarness()
  const connectPromise = harness.client.connect()
  const socket = harness.sockets[0]
  assert.ok(socket)
  socket.open()
  socket.close(4001, 'clientId replaced by a new connection')
  await assert.rejects(
    connectPromise,
    (error: unknown) => error instanceof ClientReplacedError && error.closeCode === 4001,
  )
  assert.equal(harness.client.status, 'closed')
})

test('close code 4001 after connecting surfaces on the disconnected event', async () => {
  const { client, socket } = await connectAssistant()
  const disconnects: DisconnectInfo[] = []
  client.on('disconnected', info => disconnects.push(info))
  socket.close(4001, 'clientId replaced by a new connection')
  assert.equal(client.status, 'closed')
  assert.equal(disconnects.length, 1)
  assert.equal(disconnects[0]?.code, 4001)
  assert.equal(disconnects[0]?.reason, 'clientId replaced by a new connection')
})

// ── Commands ───────────────────────────────────────────────────────────────

test('command for another stage is answered with ok=false automatically', async () => {
  const { client, socket } = await connectAssistant()
  const commands: unknown[] = []
  client.on('command', command => commands.push(command))

  socket.receive({ type: 'command', commandId: 'cmd-1', bridgeId: 'b1', stageId: 'other:stage', command: 'say', args: {} })
  const result = socket.lastFrame()
  assert.equal(result.type, 'command_result')
  assert.equal(result.commandId, 'cmd-1')
  assert.equal(result.ok, false)
  assert.match(String(result.error), /other:stage/)
  assert.equal(commands.length, 0)
})

test('commandHandler acknowledges matching commands automatically', async () => {
  const { socket } = await connectAssistant({
    commandHandler: async command => ({ ok: true, result: { accepted: true, command: command.command } }),
  })
  socket.receive({ type: 'command', commandId: 'cmd-2', bridgeId: 'b1', stageId: 'town:meadow', command: 'say', args: { text: '你好' } })
  await tick()
  const result = socket.lastFrame()
  assert.equal(result.type, 'command_result')
  assert.equal(result.commandId, 'cmd-2')
  assert.equal(result.ok, true)
  assert.deepEqual(result.result, { accepted: true, command: 'say' })
  assert.equal(result.error, undefined)
})

test('command without a handler is emitted and can be acknowledged manually', async () => {
  const { client, socket } = await connectAssistant()
  const received: Array<Record<string, unknown>> = []
  client.on('command', command => received.push(command as unknown as Record<string, unknown>))

  socket.receive({ type: 'command', commandId: 'cmd-3', bridgeId: 'b1', stageId: 'town:meadow', command: 'say', args: { text: '你好' } })
  assert.equal(received.length, 1)
  assert.equal(received[0]?.command, 'say')
  assert.deepEqual(received[0]?.args, { text: '你好' })

  client.sendCommandResult('cmd-3', true, { accepted: true })
  const result = socket.lastFrame()
  assert.equal(result.type, 'command_result')
  assert.equal(result.ok, true)
  assert.deepEqual(result.result, { accepted: true })
})

test('a throwing commandHandler answers ok=false with the error message', async () => {
  const { socket } = await connectAssistant({
    commandHandler: () => {
      throw new Error('scene not loaded')
    },
  })
  socket.receive({ type: 'command', commandId: 'cmd-4', stageId: 'town:meadow', command: 'say', args: {} })
  await tick()
  const result = socket.lastFrame()
  assert.equal(result.type, 'command_result')
  assert.equal(result.ok, false)
  assert.equal(result.error, 'scene not loaded')
})

// ── Events, unknown frames, explicit requests ──────────────────────────────

test('sendEvent targets the current stage and event_rejected is emitted', async () => {
  const { client, socket } = await connectAssistant()
  const rejected: EventRejectedFrame[] = []
  client.on('event_rejected', frame => rejected.push(frame))

  client.sendEvent({ kind: 'user_said', text: '你好', participantId: 'user-1' })
  const frame = socket.lastFrame()
  assert.equal(frame.type, 'event')
  assert.equal(frame.stageId, 'town:meadow')
  assert.deepEqual(frame.event, { kind: 'user_said', text: '你好', participantId: 'user-1' })

  socket.receive({ type: 'event_rejected', reason: 'event stage is not current' })
  assert.equal(rejected.length, 1)
  assert.equal(rejected[0]?.reason, 'event stage is not current')
})

test('unknown frame types and unknown fields are tolerated', async () => {
  const { client, socket } = await connectAssistant()
  const commands: unknown[] = []
  client.on('command', command => commands.push(command))

  socket.receive({ type: 'future_frame', nested: { anything: true } })
  socket.receive('this is not json')
  socket.receive({ type: 'llm_event', event: { type: 'chunk' }, unknownField: 1 })
  assert.equal(client.status, 'active')

  // Unknown fields on a known frame must not break command handling.
  socket.receive({ type: 'command', commandId: 'cmd-5', stageId: 'town:meadow', command: 'say', args: {}, futureField: 'ignored' })
  assert.equal(commands.length, 1)

  // The connection keeps working after tolerated frames.
  client.sendEvent({ kind: 'user_said' })
  assert.equal(socket.lastFrame().type, 'event')
})

test('explicit registerStage / activateStage / transitionToEmpty resolve with server results', async () => {
  const { client, socket } = await connectAssistant()

  const registerPromise = client.registerStage()
  const registerFrame = socket.lastFrame()
  assert.equal(registerFrame.type, 'stage_register')
  assert.ok(typeof registerFrame.requestId === 'string')
  socket.receive({
    type: 'stage_register_result',
    requestId: registerFrame.requestId,
    result: {
      kind: 'updated',
      registration: {
        id: 'stage:ts-client-1:town:meadow',
        stageId: 'town:meadow',
        stageKind: 'town',
        environment: { text: '萤火镇' },
        capabilities: [{ name: 'say' }],
      },
    },
    stage: EMPTY_STAGE,
  })
  const registerResult = await registerPromise
  assert.equal(registerResult.result.kind, 'updated')

  const activatePromise = client.activateStage(undefined, { mode: 'interrupt', expectedRevision: 1 })
  const activateFrame = socket.lastFrame()
  assert.equal(activateFrame.type, 'stage_activate')
  assert.equal(activateFrame.stageId, 'town:meadow')
  assert.equal(activateFrame.mode, 'interrupt')
  assert.equal(activateFrame.expectedRevision, 1)
  socket.receive({ type: 'stage_activate_result', requestId: activateFrame.requestId, result: { kind: 'unchanged', stage: ACTIVE_STAGE } })
  const activateAnswer = await activatePromise
  assert.equal(activateAnswer.result.kind, 'unchanged')
  assert.equal(client.status, 'active')

  const transitionPromise = client.transitionToEmpty()
  const transitionFrame = socket.lastFrame()
  assert.equal(transitionFrame.type, 'stage_transition')
  assert.equal(transitionFrame.target, 'empty')
  assert.equal(transitionFrame.stageId, 'town:meadow')
  socket.receive({ type: 'stage_transition_result', requestId: transitionFrame.requestId, result: { kind: 'changed', stage: EMPTY_STAGE } })
  const transitionAnswer = await transitionPromise
  assert.equal(transitionAnswer.result.kind, 'changed')
  assert.equal(client.currentStage?.id, 'empty')
})

test('chat resolves with the matching chat_result', async () => {
  const { client, socket } = await connectAssistant()
  const chatPromise = client.chat('你好')
  const chatFrame = socket.lastFrame()
  assert.equal(chatFrame.type, 'chat')
  assert.equal(chatFrame.text, '你好')
  assert.ok(typeof chatFrame.requestId === 'string')

  socket.receive({ type: 'chat_result', requestId: chatFrame.requestId, accepted: true, turn: 2 })
  const result = await chatPromise
  assert.equal(result.accepted, true)
  assert.equal(result.turn, 2)
})

test('chat request times out with RequestTimeoutError', async () => {
  const { client } = await connectAssistant({ requestTimeoutMs: 20 })
  await assert.rejects(client.chat('你好'), (error: unknown) => error instanceof RequestTimeoutError)
})

// ── URL construction via the client ────────────────────────────────────────

test('gateway mode connects through the console with the api_key query', async () => {
  const harness = createHarness({
    direct: undefined,
    gateway: { baseUrl: 'https://console.example.com', gatewayWsPath: '/a/assistant-1/ws', apiKey: 'ask_test' },
  })
  const connectPromise = harness.client.connect()
  connectPromise.catch(() => undefined)
  const socket = harness.sockets[0]
  assert.ok(socket)
  assert.equal(socket.url, 'wss://console.example.com/a/assistant-1/ws?api_key=ask_test')
  harness.client.close()
  await connectPromise.catch(() => undefined)
})

test('gateway mode derives the ws path from sessionId', async () => {
  const harness = createHarness({
    direct: undefined,
    gateway: { baseUrl: 'http://127.0.0.1:8080', sessionId: 'assistant-3101-c4908fa8', apiKey: 'ask_test' },
  })
  const connectPromise = harness.client.connect()
  connectPromise.catch(() => undefined)
  const socket = harness.sockets[0]
  assert.ok(socket)
  assert.equal(socket.url, 'ws://127.0.0.1:8080/a/assistant-3101-c4908fa8/ws?api_key=ask_test')
  harness.client.close()
  await connectPromise.catch(() => undefined)
})

// ── Lifecycle edge cases ───────────────────────────────────────────────────

test('close() rejects pending requests and emits disconnected', async () => {
  const { client, socket } = await connectAssistant()
  const disconnects: DisconnectInfo[] = []
  client.on('disconnected', info => disconnects.push(info))

  const pending = client.chat('你好').catch(error => error)
  assert.equal(socket.framesOfType('chat').length, 1)
  client.close()
  const error = await pending
  assert.ok(error instanceof ConnectionClosedError)
  assert.equal(client.status, 'closed')
  assert.equal(disconnects.length, 1)
  assert.equal(disconnects[0]?.code, 1000)
})

test('sending before connect throws NotConnectedError', () => {
  const harness = createHarness()
  assert.throws(() => harness.client.sendEvent({ kind: 'user_said' }), NotConnectedError)
  assert.throws(() => harness.client.sendCommandResult('cmd-1', true), NotConnectedError)
})

test('on() returns an unsubscribe function', async () => {
  const { client, socket } = await connectAssistant()
  let count = 0
  const off = client.on('llm_event', () => {
    count += 1
  })
  socket.receive({ type: 'llm_event', event: { type: 'chunk' } })
  off()
  socket.receive({ type: 'llm_event', event: { type: 'chunk' } })
  assert.equal(count, 1)
})

test('constructor validates required options', () => {
  assert.throws(() => new StageChannelClient({} as StageChannelClientOptions), /clientId/)
  assert.throws(
    () => new StageChannelClient({ clientId: 'x', stage: { id: 's', kind: 'k' } }),
    /one of options\.url/,
  )
  assert.throws(
    () =>
      new StageChannelClient({
        clientId: 'x',
        stage: { id: 's', kind: 'k' },
        direct: { host: '127.0.0.1', port: 1 },
        url: 'ws://127.0.0.1:1/ws',
      }),
    /mutually exclusive/,
  )
})
