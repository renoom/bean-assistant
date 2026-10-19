/** Independent interaction channel for clients that provide Stage environments and actions. */

import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { WebSocketServer } from 'ws'
import type { RawData, WebSocket } from 'ws'
import type { JsonValue } from '@deepseek-ai/dsh-session'
import type { AssistantCapabilities, EncodedChatImage } from '../service/capabilities.js'
import type { AssistantEventHub } from '../service/event-hub.js'
import type { StageRegistry } from '../stage/manager.js'
import type { StageBridge, StageCommandSpec, StageRegistration } from '../stage/types.js'
import type { Channel, ChannelConfig, ChannelEndpoint } from './types.js'

interface RegistrationHandle { registration: StageRegistration; bridge: StageBridge }
interface ClientState {
  clientId: string
  hello: Record<string, unknown>
  ws: WebSocket
  registrations: Map<string, RegistrationHandle>
}
interface PendingCommand {
  ws: WebSocket
  resolve(value: Record<string, JsonValue>): void
  reject(error: Error): void
}

export class StageChannel implements Channel {
  readonly id = 'stage'
  private readonly server = createServer((_req, res) => { res.writeHead(404); res.end() })
  private readonly wss = new WebSocketServer({ server: this.server, path: '/ws' })
  private readonly clients = new Map<string, ClientState>()
  private readonly pending = new Map<string, PendingCommand>()
  private readonly eventDispose: () => void
  private seq = 0
  private disposePromise?: Promise<void>

  constructor(
    private readonly config: ChannelConfig,
    private readonly capabilities: AssistantCapabilities,
    events: AssistantEventHub,
    private readonly stages: StageRegistry,
  ) {
    // ws forwards listener errors; the HTTP server's start promise handles bind failures.
    this.wss.on('error', error => {
      if (this.server.listening) console.error('[StageChannel] listener error:', error)
    })
    this.wss.on('connection', ws => this.accept(ws))
    this.eventDispose = events.subscribe(event => {
      for (const client of this.clients.values()) {
        this.send(client.ws, { type: 'llm_event', event: event.raw })
        if (event.readable) this.send(client.ws, { type: 'llm_event', event: event.readable })
      }
    })
  }

  async start(): Promise<ChannelEndpoint> {
    if (this.disposePromise) throw new Error('StageChannel has been disposed')
    await new Promise<void>((resolve, reject) => {
      this.server.once('error', reject)
      this.server.listen(this.config.port, this.config.host, () => {
        this.server.off('error', reject)
        resolve()
      })
    })
    return { id: this.id, protocol: 'ws', host: this.config.host, port: (this.server.address() as AddressInfo).port, path: '/ws' }
  }

  dispose(): Promise<void> {
    return this.disposePromise ??= this.close()
  }

  private async close(): Promise<void> {
    this.eventDispose()
    for (const state of [...this.clients.values()]) this.drop(state)
    for (const socket of this.wss.clients) socket.terminate()
    await new Promise<void>(resolve => this.wss.close(() => resolve()))
    await new Promise<void>((resolve, reject) => this.server.close(error => {
      if (error && (error as NodeJS.ErrnoException).code !== 'ERR_SERVER_NOT_RUNNING') reject(error)
      else resolve()
    }))
  }

  private accept(ws: WebSocket): void {
    let state: ClientState | undefined
    let connecting = false
    let closed = false
    const queued: Record<string, unknown>[] = []
    const timer = setTimeout(() => ws.terminate(), 30_000)
    const drop = (): void => {
      if (closed) return
      closed = true
      clearTimeout(timer)
      queued.length = 0
      if (state) this.drop(state)
    }
    ws.once('close', (code, reason) => {
      console.info(`[StageChannel] disconnected client=${JSON.stringify(state?.clientId ?? 'handshaking')} code=${code} reason=${JSON.stringify(reason.toString())}`)
      drop()
    })
    ws.once('error', error => {
      console.error(`[StageChannel] socket error client=${JSON.stringify(state?.clientId ?? 'handshaking')}: ${error.message}`)
      drop()
    })
    const dispatch = (message: Record<string, unknown>): void => {
      if (!state || closed) return
      void this.onMessage(state, message).catch(error => this.send(ws, {
        type: 'error', requestId: stringValue(message.requestId), error: error instanceof Error ? error.message : String(error),
      }))
    }
    ws.on('message', (raw: RawData) => {
      let message: Record<string, unknown> | null
      try { message = objectValue(JSON.parse(raw.toString())) } catch { return }
      if (!message || closed) return
      if (state) { dispatch(message); return }
      if (connecting) {
        if (queued.length >= 32) ws.terminate()
        else queued.push(message)
        return
      }
      if (message.type !== 'hello') return
      connecting = true
      void this.connect(message, ws).then(client => {
        if (closed) { this.drop(client); return }
        state = client
        clearTimeout(timer)
        for (const frame of queued.splice(0)) dispatch(frame)
      }, error => {
        this.send(ws, { type: 'error', error: error instanceof Error ? error.message : String(error) })
        ws.close()
      })
    })
  }

  private async connect(hello: Record<string, unknown>, ws: WebSocket): Promise<ClientState> {
    const clientId = stringValue(hello.clientId)
    if (!clientId) throw new Error('clientId is required')
    const existing = this.clients.get(clientId)
    if (existing) { this.drop(existing); existing.ws.close(4001, 'clientId replaced by a new connection') }
    const state: ClientState = { clientId, hello, ws, registrations: new Map() }
    this.clients.set(clientId, state)
    try {
      // Older peers may provide their environment in hello; no client type is inferred.
      const stageId = stringValue(hello.stageId)
      let transition: unknown = null
      let bridgeId: string | undefined
      if (stageId) {
        const registered = this.register(state, {
          id: stageId, kind: hello.stageKind, environment: hello.environment, commands: hello.commands,
        })
        bridgeId = registered?.bridge.id
        if (hello.activateStage === true && registered?.result.kind !== 'rejected') {
          transition = await this.stages.activate(stageId, registered?.registration.id)
        }
      }
      this.send(ws, {
        type: 'hello_ack', channel: this.id, clientId, bridgeId,
        registrations: [...state.registrations.values()].map(item => item.registration),
        stage: this.stages.snapshot(), transition,
      })
      return state
    } catch (error) { this.drop(state); throw error }
  }

  private async onMessage(state: ClientState, message: Record<string, unknown>): Promise<void> {
    if (this.clients.get(state.clientId) !== state) return
    const requestId = stringValue(message.requestId)
    if (message.type === 'chat' || message.type === 'message') {
      try {
        const result = await this.capabilities.chat({
          text: typeof message.text === 'string' ? message.text : '',
          images: Array.isArray(message.images) ? message.images as EncodedChatImage[] : [],
          clientId: state.clientId,
        })
        this.send(state.ws, { type: 'chat_result', requestId, ...result })
      } catch (error) {
        this.send(state.ws, { type: 'chat_result', requestId, accepted: false, error: error instanceof Error ? error.message : String(error) })
      }
      return
    }
    if (message.type === 'command_result') {
      this.completeCommand(message, state.ws)
      return
    }
    if (message.type === 'stage_register') {
      const registered = this.register(state, objectValue(message.stage) ?? message)
      this.send(state.ws, {
        type: 'stage_register_result', requestId,
        result: registered?.result ?? { kind: 'rejected', reason: 'invalid stage registration' },
        stage: this.stages.snapshot(),
      })
      return
    }
    if (message.type === 'stage_unregister') {
      const stageId = stringValue(message.stageId)
      const handle = state.registrations.get(stageId)
      state.registrations.delete(stageId)
      const removed = handle ? this.stages.unregisterStage(handle.registration.id, handle.bridge) : false
      this.send(state.ws, { type: 'stage_unregister_result', requestId, removed, stage: this.stages.snapshot() })
      return
    }
    if (message.type === 'stage_activate' || message.type === 'stage_transition') {
      const options = {
        mode: message.mode === 'interrupt' ? 'interrupt' as const : 'after-turn' as const,
        expectedStageId: typeof message.expectedStageId === 'string' ? message.expectedStageId : undefined,
        expectedRevision: typeof message.expectedRevision === 'number' ? message.expectedRevision : undefined,
      }
      const stageId = stringValue(message.stageId)
      const handle = state.registrations.get(stageId)
      const result = message.target === 'empty'
        ? await this.stages.transition({ target: { type: 'empty' }, ...options })
        : handle
          ? await this.stages.activate(stageId, handle.registration.id, options)
          : { kind: 'rejected', reason: 'stage is not registered by this client', stage: this.stages.snapshot() }
      this.send(state.ws, { type: `${message.type}_result`, requestId, result })
      return
    }
    if (message.type === 'event') {
      const stageId = stringValue(message.stageId)
      const current = this.stages.snapshot()
      if (stageId && stageId !== current.id) {
        this.send(state.ws, { type: 'event_rejected', reason: 'event stage is not current' }); return
      }
      const handle = state.registrations.get(stageId || current.id)
      const event = objectValue(message.event)
      if (!handle || !event || !this.stages.deliverEvent(handle.bridge.id, event)) {
        this.send(state.ws, { type: 'event_rejected', reason: 'bridge is not in the current stage' })
      }
      return
    }
    this.send(state.ws, { type: 'error', requestId, error: `unsupported interaction: ${String(message.type)}` })
  }

  private register(state: ClientState, raw: Record<string, unknown>): {
    result: ReturnType<StageRegistry['registerStage']>; registration: StageRegistration; bridge: StageBridge
  } | undefined {
    const stageId = stringValue(raw.id) || stringValue(raw.stageId)
    const stageKind = stringValue(raw.kind) || stringValue(raw.stageKind) || 'external'
    if (!stageId || stageKind === 'empty') return undefined
    const environment = objectValue(raw.environment)
    const commands = Array.isArray(raw.commands) ? raw.commands.map(parseSpec).filter((item): item is StageCommandSpec => item !== null) : []
    const registration: StageRegistration = {
      id: `stage:${encodeURIComponent(state.clientId)}:${encodeURIComponent(stageId)}`,
      stageId, stageKind,
      environment: { text: stringValue(environment?.text) }, capabilities: commands,
    }
    const identity = state.hello
    const bridge: StageBridge = {
      id: registration.id, stageId, stageKind, environment: registration.environment,
      participant: {
        id: stringValue(identity.assistantId) || state.clientId,
        role: identity.role === 'user' ? 'user' : identity.role === 'assistant' ? 'assistant' : 'client',
        name: stringValue(identity.name) || undefined, online: true,
      },
      capabilities: commands,
      execute: (command, args, signal) => this.sendCommand(state, registration.id, stageId, command, args, signal),
    }
    const result = this.stages.registerStage(registration, bridge)
    if (result.kind !== 'rejected') state.registrations.set(stageId, { registration, bridge })
    return { result, registration, bridge }
  }

  private drop(state: ClientState): void {
    if (this.clients.get(state.clientId) !== state) return
    this.clients.delete(state.clientId)
    for (const handle of state.registrations.values()) this.stages.unregisterStage(handle.registration.id, handle.bridge)
    state.registrations.clear()
    for (const pending of [...this.pending.values()]) {
      if (pending.ws === state.ws) pending.reject(new Error(`客户端 ${state.clientId} 已断开`))
    }
  }

  private sendCommand(state: ClientState, bridgeId: string, stageId: string, command: string, args: unknown, signal?: AbortSignal): Promise<Record<string, JsonValue>> {
    return new Promise((resolve, reject) => {
      if (this.clients.get(state.clientId) !== state || state.ws.readyState !== 1) {
        reject(new Error(`客户端 ${state.clientId} 未连接`)); return
      }
      const commandId = `stage-${Date.now()}-${++this.seq}`
      let settled = false
      const finish = (value?: Record<string, JsonValue>, error?: Error): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        signal?.removeEventListener('abort', onAbort)
        this.pending.delete(commandId)
        if (error) reject(error); else resolve(value ?? {})
      }
      const onAbort = (): void => finish(undefined, new Error('已取消'))
      const timer = setTimeout(() => finish(undefined, new Error(`环境动作 ${command} 超时`)), 30_000)
      this.pending.set(commandId, { ws: state.ws, resolve: value => finish(value), reject: error => finish(undefined, error) })
      if (signal?.aborted) { onAbort(); return }
      signal?.addEventListener('abort', onAbort, { once: true })
      this.send(state.ws, { type: 'command', commandId, bridgeId, stageId, command, args: args ?? {} })
    })
  }

  private completeCommand(message: Record<string, unknown>, ws: WebSocket): void {
    const pending = this.pending.get(stringValue(message.commandId))
    if (!pending || pending.ws !== ws) return
    pending.resolve({ ok: message.ok !== false, result: (message.result ?? null) as JsonValue, error: typeof message.error === 'string' ? message.error : '' })
  }

  private send(ws: WebSocket, message: Record<string, unknown>): void {
    if (ws.readyState === 1) ws.send(JSON.stringify(message))
  }
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null
}
function stringValue(value: unknown): string { return typeof value === 'string' ? value.trim() : '' }
function parseSpec(value: unknown): StageCommandSpec | null {
  const raw = objectValue(value)
  if (!raw || !stringValue(raw.name)) return null
  const spec: StageCommandSpec = { name: stringValue(raw.name) }
  if (typeof raw.description === 'string') spec.description = raw.description
  if (objectValue(raw.parameters)) spec.parameters = raw.parameters as StageCommandSpec['parameters']
  if (typeof raw.returns === 'string') spec.returns = raw.returns
  if (objectValue(raw.example)) spec.example = raw.example as Record<string, unknown>
  return spec
}
