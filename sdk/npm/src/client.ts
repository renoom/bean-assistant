/**
 * StageChannel WebSocket client.
 *
 * State machine (from `sdk/spec/protocol.md` §4):
 *
 * ```
 * DISCONNECTED → CONNECTING → HELLO_SENT → ACKED → REGISTERED → ACTIVE
 *                                      └─ error / 30s timeout → closed (handshake failed)
 * ```
 *
 * - `role: "assistant"` registers and activates the configured stage.
 * - `role: "user"` registers but skips activation.
 * - `command` frames for another stage are answered with `ok: false`
 *   automatically.
 * - unknown frame types / fields are ignored; close code `4001` surfaces as
 *   {@link ClientReplacedError} or in the `disconnected` event.
 *
 * @module stage-channel-sdk/client
 */

import type {
  ActivateMode,
  ChatResultFrame,
  ClientFrame,
  ClientRole,
  CommandFrame,
  EventRejectedFrame,
  HelloAckFrame,
  LlmEventFrame,
  Registration,
  ServerErrorFrame,
  ServerFrame,
  StageActivateResultFrame,
  StageDefinition,
  StageEventPayload,
  StageRegisterResultFrame,
  StageSnapshot,
  StageTransitionResultFrame,
  TransitionResult,
  WebSocketFactory,
  WebSocketLike,
} from './types.ts'
import type { HelloFrameInput } from './protocol.ts'
import {
  createChatFrame,
  createCommandResultFrame,
  createEventFrame,
  createHelloFrame,
  createStageActivateFrame,
  createStageRegisterFrame,
  createStageTransitionFrame,
  decodeServerFrame,
  encodeFrame,
  isChatResultFrame,
  isCommandFrame,
  isEventRejectedFrame,
  isHelloAckFrame,
  isLlmEventFrame,
  isRecord,
  isRegisterResult,
  isServerErrorFrame,
  isStageActivateResultFrame,
  isStageRegisterResultFrame,
  isStageTransitionResultFrame,
  isTransitionResult,
  validateHelloAck,
} from './protocol.ts'
import { buildDirectWsUrl, buildGatewayWsUrl } from './discovery.ts'
import {
  ClientReplacedError,
  ConnectionClosedError,
  HandshakeTimeoutError,
  NotConnectedError,
  ProtocolError,
  RequestTimeoutError,
  StageChannelError,
  StageServerError,
  WebSocketUnavailableError,
} from './errors.ts'

/** Lifecycle state of the client. */
export type ClientStatus = 'disconnected' | 'connecting' | 'hello_sent' | 'acked' | 'registered' | 'active' | 'closed'

/** Information resolved by a successful {@link StageChannelClient.connect}. */
export interface ConnectedInfo {
  clientId: string
  channel: string
  bridgeId?: string
  registrations: Registration[]
  stage: StageSnapshot
  transition?: TransitionResult | null
  role: ClientRole
  status: ClientStatus
}

/** Payload of the `disconnected` event. */
export interface DisconnectInfo {
  /** WebSocket close code (4001 means the clientId was replaced). */
  code: number
  reason: string
  wasClean: boolean
}

/** Gateway-mode connection settings. */
export interface GatewayConnectionOptions {
  /** Console base URL, for example `https://console.example.com`. */
  baseUrl: string
  /** `gatewayWsPath` returned by discovery, e.g. `/a/<sessionId>/ws`. */
  gatewayWsPath?: string
  /** When `gatewayWsPath` is omitted, the path is derived as `/a/<sessionId>/ws`. */
  sessionId?: string
  /** Platform API key; appended as `?api_key=` because browsers cannot set WS headers. */
  apiKey?: string
}

/** Direct-mode connection settings (local development / standalone deployments). */
export interface DirectConnectionOptions {
  host: string
  port: number
  /** Defaults to `/ws`. */
  path?: string
  /** Use `wss://` instead of `ws://`. */
  useTls?: boolean
}

/** Result returned by a {@link CommandHandler}. */
export interface CommandOutcome {
  ok: boolean
  result?: unknown
  error?: string
}

/** Executes a server `command` and returns the acknowledgement payload. */
export type CommandHandler = (command: CommandFrame) => CommandOutcome | Promise<CommandOutcome>

/** Options for {@link StageChannelClient.chat}. */
export interface ChatOptions {
  requestId?: string
  images?: unknown[]
}

/** Common request options for register / activate / transition / chat. */
export interface RequestOptions {
  requestId?: string
  /** Per-request timeout in milliseconds; defaults to `requestTimeoutMs`. */
  timeoutMs?: number
}

/** Options for {@link StageChannelClient.activateStage}. */
export interface ActivateOptions extends RequestOptions {
  mode?: ActivateMode
  expectedStageId?: string
  expectedRevision?: number
}

/** Options for {@link StageChannelClient.transitionToEmpty}. */
export interface TransitionOptions extends ActivateOptions {
  /** Stage id sent with the frame; defaults to the configured stage id. */
  stageId?: string
}

/** Events emitted by the client, optionally wired via constructor callbacks. */
export interface StageChannelEventMap {
  connected: ConnectedInfo
  disconnected: DisconnectInfo
  hello_ack: HelloAckFrame
  command: CommandFrame
  llm_event: LlmEventFrame
  event_rejected: EventRejectedFrame
  server_error: ServerErrorFrame
}

/** Name of a client event. */
export type StageChannelEventName = keyof StageChannelEventMap

/** Handler for a client event. */
export type StageChannelEventHandler<K extends StageChannelEventName> = (payload: StageChannelEventMap[K]) => void

/** Constructor options for {@link StageChannelClient}. */
export interface StageChannelClientOptions {
  /** Stable per-instance id; keep it across reconnects and make it unique per instance. */
  clientId: string
  /** Defaults to `assistant`. `user` skips stage activation. */
  role?: ClientRole
  assistantId?: string
  name?: string
  /** `clientType` reported in `hello`; defaults to `npm`. */
  clientType?: string
  /** Stage declared by this client (id / kind / environment / commands). */
  stage: StageDefinition
  /** Explicit WebSocket URL. Mutually exclusive with `gateway` and `direct`. */
  url?: string
  /** Gateway mode (recommended): connect through the console. */
  gateway?: GatewayConnectionOptions
  /** Direct mode: connect to an assistant's StageChannel port. */
  direct?: DirectConnectionOptions
  /** Injectable WebSocket factory; defaults to the global `WebSocket`. */
  webSocketFactory?: WebSocketFactory
  /** Handshake timeout (hello → register → activate). Defaults to 30000. */
  connectTimeoutMs?: number
  /** Default timeout for register / activate / transition / chat requests. Defaults to 30000. */
  requestTimeoutMs?: number
  /** Automatically send `stage_register` after `hello_ack`. Defaults to true. */
  autoRegister?: boolean
  /** Automatically send `stage_activate` after registration (role=assistant only). Defaults to true. */
  autoActivate?: boolean
  /** Executes incoming commands and auto-acknowledges them. */
  commandHandler?: CommandHandler
  onConnected?: StageChannelEventHandler<'connected'>
  onDisconnected?: StageChannelEventHandler<'disconnected'>
  onHelloAck?: StageChannelEventHandler<'hello_ack'>
  onCommand?: StageChannelEventHandler<'command'>
  onLlmEvent?: StageChannelEventHandler<'llm_event'>
  onEventRejected?: StageChannelEventHandler<'event_rejected'>
  onServerError?: StageChannelEventHandler<'server_error'>
}

interface PendingRequest {
  resolve(value: ServerFrame): void
  reject(error: Error): void
  timer: ReturnType<typeof setTimeout>
}

type HandshakePhase = 'hello' | 'register' | 'activate' | 'ready'

/**
 * WebSocket client for the StageChannel protocol.
 *
 * @example
 * ```ts
 * const client = new StageChannelClient({
 *   clientId: 'web-1',
 *   role: 'assistant',
 *   stage: { id: 'town:meadow', kind: 'town', commands: [{ name: 'say' }] },
 *   gateway: { baseUrl: 'https://console.example.com', gatewayWsPath: '/a/assistant-1/ws', apiKey: key },
 *   commandHandler: async command => ({ ok: true, result: { accepted: true } }),
 * })
 * client.on('llm_event', event => console.log(event.event))
 * await client.connect()
 * ```
 */
export class StageChannelClient {
  /** Stable client id sent in `hello`. */
  readonly clientId: string
  /** Role sent in `hello`. */
  readonly role: ClientRole
  /** Stage declared by this client. */
  readonly stage: StageDefinition

  private readonly options: StageChannelClientOptions
  private readonly connectTimeoutMs: number
  private readonly requestTimeoutMs: number
  private readonly pending = new Map<string, PendingRequest>()
  private readonly listeners = new Map<StageChannelEventName, Set<(payload: unknown) => void>>()

  private socket: WebSocketLike | null = null
  private statusValue: ClientStatus = 'disconnected'
  private handshakePhase: HandshakePhase = 'hello'
  private helloAckFrame: HelloAckFrame | null = null
  private stageSnapshot: StageSnapshot | null = null
  private activated = false
  private connectSettlers: { resolve: (info: ConnectedInfo) => void; reject: (error: Error) => void } | null = null
  private handshakeTimer: ReturnType<typeof setTimeout> | null = null
  private requestSeq = 0
  private closeEmitted = false

  constructor(options: StageChannelClientOptions) {
    if (!isRecord(options)) throw new StageChannelError('options are required')
    if (typeof options.clientId !== 'string' || options.clientId.trim().length === 0) {
      throw new StageChannelError('options.clientId is required')
    }
    if (!isRecord(options.stage) || typeof options.stage.id !== 'string' || options.stage.id.length === 0) {
      throw new StageChannelError('options.stage.id is required')
    }
    if (typeof options.stage.kind !== 'string' || options.stage.kind.length === 0) {
      throw new StageChannelError('options.stage.kind is required')
    }
    const sources = [options.url, options.gateway, options.direct].filter(value => value !== undefined)
    if (sources.length === 0) throw new StageChannelError('one of options.url, options.gateway or options.direct is required')
    if (sources.length > 1) throw new StageChannelError('options.url, options.gateway and options.direct are mutually exclusive')
    if (options.gateway) {
      if (typeof options.gateway.baseUrl !== 'string' || options.gateway.baseUrl.trim().length === 0) {
        throw new StageChannelError('options.gateway.baseUrl is required')
      }
      if (!options.gateway.gatewayWsPath && !options.gateway.sessionId) {
        throw new StageChannelError('options.gateway.gatewayWsPath or options.gateway.sessionId is required')
      }
    }
    if (options.direct) {
      if (typeof options.direct.host !== 'string' || options.direct.host.trim().length === 0) {
        throw new StageChannelError('options.direct.host is required')
      }
      if (!Number.isInteger(options.direct.port) || options.direct.port <= 0) {
        throw new StageChannelError('options.direct.port must be a positive integer')
      }
    }

    this.options = options
    this.clientId = options.clientId.trim()
    this.role = options.role === 'user' ? 'user' : 'assistant'
    this.stage = options.stage
    this.connectTimeoutMs = options.connectTimeoutMs ?? 30_000
    this.requestTimeoutMs = options.requestTimeoutMs ?? 30_000
    this.registerOptionHandlers()
  }

  /** Current lifecycle status. */
  get status(): ClientStatus {
    return this.statusValue
  }

  /** True once the handshake finished and the socket is usable. */
  get isConnected(): boolean {
    return this.statusValue === 'active' || this.statusValue === 'registered' || this.statusValue === 'acked'
  }

  /** Latest stage snapshot reported by the server, or `null`. */
  get currentStage(): StageSnapshot | null {
    return this.stageSnapshot
  }

  /** The `hello_ack` frame, once received. */
  get helloAck(): HelloAckFrame | null {
    return this.helloAckFrame
  }

  /** Subscribe to an event; returns an unsubscribe function. */
  on<K extends StageChannelEventName>(type: K, handler: StageChannelEventHandler<K>): () => void {
    let handlers = this.listeners.get(type)
    if (!handlers) {
      handlers = new Set()
      this.listeners.set(type, handlers)
    }
    handlers.add(handler as (payload: unknown) => void)
    return () => this.off(type, handler)
  }

  /** Remove a previously registered event handler. */
  off<K extends StageChannelEventName>(type: K, handler: StageChannelEventHandler<K>): void {
    this.listeners.get(type)?.delete(handler as (payload: unknown) => void)
  }

  /**
   * Open the WebSocket and run the handshake:
   * `hello` → `hello_ack` → `stage_register` → `stage_activate` (assistant only).
   *
   * Resolves with {@link ConnectedInfo} when the handshake finishes and rejects
   * with {@link HandshakeTimeoutError}, {@link StageServerError},
   * {@link ClientReplacedError} or {@link ConnectionClosedError} on failure.
   */
  connect(): Promise<ConnectedInfo> {
    if (this.statusValue !== 'disconnected' && this.statusValue !== 'closed') {
      return Promise.reject(new StageChannelError(`connect() is not allowed while status is "${this.statusValue}"`))
    }
    this.resetForConnect()

    let url: string
    try {
      url = this.resolveUrl()
    } catch (error) {
      this.statusValue = 'closed'
      return Promise.reject(error)
    }

    const factory = this.options.webSocketFactory ?? defaultWebSocketFactory
    let socket: WebSocketLike
    try {
      socket = factory(url)
    } catch (error) {
      this.statusValue = 'closed'
      return Promise.reject(
        error instanceof StageChannelError
          ? error
          : new WebSocketUnavailableError(`failed to create WebSocket for ${url}: ${errorMessage(error)}`, { cause: error }),
      )
    }

    this.socket = socket
    this.statusValue = 'connecting'
    this.handshakePhase = 'hello'

    return new Promise<ConnectedInfo>((resolve, reject) => {
      this.connectSettlers = { resolve, reject }
      this.handshakeTimer = setTimeout(() => {
        this.failHandshake(
          new HandshakeTimeoutError(`stage handshake timed out after ${this.connectTimeoutMs}ms (phase: ${this.handshakePhase})`, {
            phase: this.handshakePhase,
          }),
        )
      }, this.connectTimeoutMs)

      socket.onopen = () => this.handleOpen()
      socket.onmessage = event => this.handleIncoming(event.data)
      socket.onerror = () => {
        if (this.connectSettlers) {
          this.failHandshake(new ConnectionClosedError(`WebSocket error during ${this.handshakePhase} handshake`, { closeCode: 1006 }))
        }
      }
      socket.onclose = event => this.finalizeClose(event.code ?? 1006, event.reason ?? '', event.wasClean !== false)
    })
  }

  /**
   * Close the connection. Pending requests are rejected with
   * {@link ConnectionClosedError} and a `disconnected` event is emitted once the
   * socket reports its close.
   */
  close(code = 1000, reason = 'client closed'): void {
    if (this.statusValue === 'closed' || this.statusValue === 'disconnected') return
    this.clearHandshakeTimer()
    this.rejectAllPending(new ConnectionClosedError(`stage channel closed by client (code=${code})`, { closeCode: code, closeReason: reason }))
    const socket = this.socket
    this.statusValue = 'closed'
    if (socket && socket.readyState !== 3) {
      try {
        socket.close(code, reason)
      } catch {
        this.finalizeClose(code, reason, true)
      }
    } else {
      this.finalizeClose(code, reason, true)
    }
  }

  /**
   * Send `stage_register` for a stage (defaults to the configured stage) and
   * resolve with the server's `stage_register_result` frame.
   */
  registerStage(stage: StageDefinition = this.stage, options: RequestOptions = {}): Promise<StageRegisterResultFrame> {
    const requestId = options.requestId ?? this.nextRequestId('register')
    const promise = this.createPending(requestId, options.timeoutMs) as Promise<StageRegisterResultFrame>
    this.dispatchRequest(requestId, createStageRegisterFrame({ requestId, stage }))
    return promise
  }

  /**
   * Send `stage_activate` and resolve with the server's
   * `stage_activate_result` frame.
   */
  activateStage(stageId: string = this.stage.id, options: ActivateOptions = {}): Promise<StageActivateResultFrame> {
    const requestId = options.requestId ?? this.nextRequestId('activate')
    const promise = this.createPending(requestId, options.timeoutMs) as Promise<StageActivateResultFrame>
    this.dispatchRequest(
      requestId,
      createStageActivateFrame({
        requestId,
        stageId,
        mode: options.mode,
        expectedStageId: options.expectedStageId,
        expectedRevision: options.expectedRevision,
      }),
    )
    return promise
  }

  /**
   * Send `stage_transition` with `target: "empty"` (back to the default
   * environment) and resolve with the server's `stage_transition_result`.
   */
  transitionToEmpty(options: TransitionOptions = {}): Promise<StageTransitionResultFrame> {
    const requestId = options.requestId ?? this.nextRequestId('transition')
    const promise = this.createPending(requestId, options.timeoutMs) as Promise<StageTransitionResultFrame>
    this.dispatchRequest(
      requestId,
      createStageTransitionFrame({
        requestId,
        stageId: options.stageId ?? this.stage.id,
        target: 'empty',
        mode: options.mode,
        expectedStageId: options.expectedStageId,
        expectedRevision: options.expectedRevision,
      }),
    )
    return promise
  }

  /**
   * Send an `event` frame for the current stage. Accepts either a payload
   * object with a non-empty `kind`, or a plain event name string (which becomes
   * the `kind`).
   */
  sendEvent(event: StageEventPayload | string, options: { stageId?: string } = {}): void {
    const payload: StageEventPayload = typeof event === 'string' ? { kind: event } : event
    if (!isRecord(payload) || typeof payload.kind !== 'string' || payload.kind.trim().length === 0) {
      throw new ProtocolError('event.kind must be a non-empty string')
    }
    this.sendFrame(createEventFrame({ stageId: options.stageId ?? this.stage.id, event: payload }))
  }

  /** Acknowledge a server `command`. */
  sendCommandResult(commandId: string, ok: boolean, result: unknown = null, error?: string): void {
    if (typeof commandId !== 'string' || commandId.length === 0) {
      throw new ProtocolError('commandId is required')
    }
    this.sendFrame(createCommandResultFrame({ commandId, ok, result, error }))
  }

  /**
   * Send a `chat` frame and resolve with the matching `chat_result` frame.
   * The optional `requestId` is generated when omitted.
   */
  chat(text: string, options: ChatOptions = {}): Promise<ChatResultFrame> {
    if (typeof text !== 'string') throw new ProtocolError('chat text must be a string')
    const requestId = options.requestId ?? this.nextRequestId('chat')
    const promise = this.createPending(requestId, undefined) as Promise<ChatResultFrame>
    this.dispatchRequest(requestId, createChatFrame({ requestId, text, images: options.images }))
    return promise
  }

  // ── Handshake internals ──────────────────────────────────────────────────

  private handleOpen(): void {
    if (this.socket === null || this.connectSettlers === null || this.statusValue !== 'connecting') return
    this.statusValue = 'hello_sent'
    this.handshakePhase = 'hello'
    const input: HelloFrameInput = {
      clientId: this.clientId,
      role: this.role,
      clientType: this.options.clientType ?? 'npm',
    }
    if (this.role === 'assistant' && this.options.assistantId) input.assistantId = this.options.assistantId
    if (this.options.name) input.name = this.options.name
    try {
      this.sendFrame(createHelloFrame(input))
    } catch (error) {
      this.failHandshake(asError(error))
    }
  }

  private handleIncoming(data: unknown): void {
    if (this.statusValue === 'closed') return
    const text = toText(data)
    if (text === null) return
    const frame = decodeServerFrame(text)
    if (frame === null) return

    if (isHelloAckFrame(frame)) {
      this.handleHelloAck(frame)
      return
    }
    if (isStageRegisterResultFrame(frame)) {
      this.handleRegisterResult(frame)
      return
    }
    if (isStageActivateResultFrame(frame) || isStageTransitionResultFrame(frame)) {
      this.handleTransitionResult(frame)
      return
    }
    if (isCommandFrame(frame)) {
      this.handleCommand(frame)
      return
    }
    if (isLlmEventFrame(frame)) {
      this.emit('llm_event', frame)
      return
    }
    if (isEventRejectedFrame(frame)) {
      this.emit('event_rejected', frame)
      return
    }
    if (isServerErrorFrame(frame)) {
      this.handleServerError(frame)
      return
    }
    if (isChatResultFrame(frame)) {
      this.settlePending(frame)
      return
    }
    // Unknown `type` (and known-but-unhandled frames such as
    // `stage_unregister_result`) are ignored for forward compatibility.
  }

  private handleHelloAck(frame: HelloAckFrame): void {
    if (this.helloAckFrame !== null) return
    const validation = validateHelloAck(frame)
    if (!validation.ok) {
      this.failHandshake(new ProtocolError(`invalid hello_ack: ${validation.reason}`))
      return
    }
    this.helloAckFrame = frame
    this.stageSnapshot = frame.stage
    this.statusValue = 'acked'
    this.emit('hello_ack', frame)

    if (this.options.autoRegister === false) {
      this.finishHandshake()
      return
    }
    this.handshakePhase = 'register'
    try {
      this.sendFrame(createStageRegisterFrame({ requestId: 'initial-register', stage: this.stage }))
    } catch (error) {
      this.failHandshake(asError(error))
    }
  }

  private handleRegisterResult(frame: StageRegisterResultFrame): void {
    const autoRegister = this.connectSettlers !== null && this.handshakePhase === 'register' && frame.requestId === 'initial-register'
    if (autoRegister) {
      const result = frame.result
      if (!isRegisterResult(result) || result.kind === 'rejected') {
        const reason = isRegisterResult(result) && result.kind === 'rejected' ? result.reason : 'invalid stage_register_result'
        this.failHandshake(new StageServerError(`stage registration failed: ${reason}`, { requestId: frame.requestId }))
        return
      }
      if (frame.stage) this.stageSnapshot = frame.stage
      this.statusValue = 'registered'
      if (this.role === 'assistant' && this.options.autoActivate !== false) {
        this.handshakePhase = 'activate'
        try {
          this.sendFrame(createStageActivateFrame({ requestId: 'initial-activate', stageId: this.stage.id }))
        } catch (error) {
          this.failHandshake(asError(error))
        }
      } else {
        this.finishHandshake()
      }
      return
    }
    if (frame.stage) this.stageSnapshot = frame.stage
    this.settlePending(frame)
  }

  private handleTransitionResult(frame: StageActivateResultFrame | StageTransitionResultFrame): void {
    const autoActivate = this.connectSettlers !== null && this.handshakePhase === 'activate' && frame.requestId === 'initial-activate'
    const result = frame.result
    if (autoActivate) {
      if (!isTransitionResult(result) || result.kind === 'rejected') {
        const reason = isTransitionResult(result) && result.kind === 'rejected' ? result.reason : 'invalid stage_activate_result'
        this.failHandshake(new StageServerError(`stage activation failed: ${reason}`, { requestId: frame.requestId }))
        return
      }
      this.stageSnapshot = result.stage
      this.activated = true
      this.finishHandshake()
      return
    }
    if (isTransitionResult(result) && result.kind !== 'rejected') {
      this.stageSnapshot = result.stage
      this.activated = true
      if (this.statusValue === 'registered' || this.statusValue === 'acked') this.statusValue = 'active'
    }
    this.settlePending(frame)
  }

  private handleServerError(frame: ServerErrorFrame): void {
    const requestId = typeof frame.requestId === 'string' ? frame.requestId : undefined
    const error = new StageServerError(frame.error || 'server error', { requestId })
    if (requestId) this.rejectPending(requestId, error)
    if (this.connectSettlers) {
      this.failHandshake(error)
      return
    }
    this.emit('server_error', frame)
  }

  private handleCommand(frame: CommandFrame): void {
    const targetStageId = typeof frame.stageId === 'string' && frame.stageId.length > 0 ? frame.stageId : this.stage.id
    if (targetStageId !== this.stage.id) {
      this.sendCommandResultIfOpen(frame.commandId, false, null, `stage ${targetStageId} is not loaded by this client`)
      return
    }
    this.emit('command', frame)
    const handler = this.options.commandHandler
    if (!handler) return
    Promise.resolve()
      .then(() => handler(frame))
      .then(outcome => {
        this.sendCommandResultIfOpen(frame.commandId, outcome?.ok !== false, outcome?.result ?? null, outcome?.error)
      })
      .catch(error => {
        this.sendCommandResultIfOpen(frame.commandId, false, null, errorMessage(error))
      })
  }

  private finishHandshake(): void {
    const settlers = this.connectSettlers
    if (!settlers) return
    this.connectSettlers = null
    this.clearHandshakeTimer()
    this.handshakePhase = 'ready'
    if (this.activated) this.statusValue = 'active'
    else if (this.options.autoRegister === false) this.statusValue = 'acked'
    else this.statusValue = 'registered'
    const info = this.buildConnectedInfo()
    this.emit('connected', info)
    settlers.resolve(info)
  }

  private failHandshake(error: Error): void {
    const settlers = this.connectSettlers
    if (!settlers) return
    this.connectSettlers = null
    this.clearHandshakeTimer()
    this.closeEmitted = true
    this.statusValue = 'closed'
    this.rejectAllPending(error)
    const socket = this.socket
    this.socket = null
    if (socket && (socket.readyState === 0 || socket.readyState === 1 || socket.readyState === 2)) {
      try {
        socket.close(4000, truncate(error.message, 120))
      } catch {
        // ignore close errors while failing the handshake
      }
    }
    settlers.reject(error)
    this.emit('disconnected', { code: 0, reason: error.message, wasClean: false })
    this.helloAckFrame = null
    this.stageSnapshot = null
    this.activated = false
  }

  private buildConnectedInfo(): ConnectedInfo {
    const ack = this.helloAckFrame
    const info: ConnectedInfo = {
      clientId: ack?.clientId ?? this.clientId,
      channel: ack?.channel ?? 'stage',
      registrations: ack?.registrations ?? [],
      stage: this.stageSnapshot ?? ack?.stage ?? emptyStageSnapshot(),
      role: this.role,
      status: this.statusValue,
    }
    if (ack?.bridgeId !== undefined) info.bridgeId = ack.bridgeId
    if (ack?.transition !== undefined) info.transition = ack.transition
    return info
  }

  // ── Socket / request plumbing ────────────────────────────────────────────

  private resolveUrl(): string {
    if (this.options.url) return this.options.url
    const gateway = this.options.gateway
    if (gateway) {
      const path = gateway.gatewayWsPath ?? (gateway.sessionId ? `/a/${encodeURIComponent(gateway.sessionId)}/ws` : undefined)
      if (!path) throw new StageChannelError('gateway.gatewayWsPath or gateway.sessionId is required')
      return buildGatewayWsUrl(gateway.baseUrl, path, gateway.apiKey)
    }
    const direct = this.options.direct
    if (direct) return buildDirectWsUrl(direct.host, direct.port, direct.path, direct.useTls)
    throw new StageChannelError('one of options.url, options.gateway or options.direct is required')
  }

  private sendFrame(frame: ClientFrame): void {
    const socket = this.socket
    if (socket === null || socket.readyState !== 1 || this.statusValue === 'closed') {
      throw new NotConnectedError(`cannot send ${frame.type}: stage channel is not open`)
    }
    socket.send(encodeFrame(frame))
  }

  private sendCommandResultIfOpen(commandId: string, ok: boolean, result: unknown, error?: string): void {
    if (this.socket === null || this.socket.readyState !== 1) return
    try {
      this.sendCommandResult(commandId, ok, result, error)
    } catch {
      // The connection went away between the command and its acknowledgement.
    }
  }

  private createPending(requestId: string, timeoutMs: number | undefined): Promise<ServerFrame> {
    const effectiveTimeout = timeoutMs ?? this.requestTimeoutMs
    return new Promise<ServerFrame>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId)
        reject(new RequestTimeoutError(`request ${requestId} timed out after ${effectiveTimeout}ms`, { requestId }))
      }, effectiveTimeout)
      this.pending.set(requestId, { resolve, reject, timer })
    })
  }

  private dispatchRequest(requestId: string, frame: ClientFrame): void {
    try {
      this.sendFrame(frame)
    } catch (error) {
      this.rejectPending(requestId, asError(error))
    }
  }

  private settlePending(frame: ServerFrame): boolean {
    const raw = frame as unknown as Record<string, unknown>
    const requestId = raw.requestId
    if (typeof requestId !== 'string' || requestId.length === 0) return false
    const pending = this.pending.get(requestId)
    if (!pending) return false
    this.pending.delete(requestId)
    clearTimeout(pending.timer)
    pending.resolve(frame)
    return true
  }

  private rejectPending(requestId: string, error: Error): void {
    const pending = this.pending.get(requestId)
    if (!pending) return
    this.pending.delete(requestId)
    clearTimeout(pending.timer)
    pending.reject(error)
  }

  private rejectAllPending(error: Error): void {
    for (const [requestId, pending] of [...this.pending]) {
      this.pending.delete(requestId)
      clearTimeout(pending.timer)
      pending.reject(error)
    }
  }

  private finalizeClose(code: number, reason: string, wasClean: boolean): void {
    if (this.closeEmitted) return
    this.closeEmitted = true
    this.clearHandshakeTimer()
    const wasHandshaking = this.connectSettlers !== null
    const hadConnection = this.helloAckFrame !== null
    this.statusValue = 'closed'
    const closure = new ConnectionClosedError(`stage channel connection closed (code=${code}${reason ? `, reason=${reason}` : ''})`, {
      closeCode: code,
      closeReason: reason,
    })
    this.rejectAllPending(closure)
    const settlers = this.connectSettlers
    this.connectSettlers = null
    this.socket = null
    if (settlers) {
      settlers.reject(
        code === 4001
          ? new ClientReplacedError(reason || 'clientId replaced by a new connection', { closeCode: code, closeReason: reason })
          : closure,
      )
    }
    if (wasHandshaking || hadConnection) this.emit('disconnected', { code, reason, wasClean })
    this.helloAckFrame = null
    this.stageSnapshot = null
    this.activated = false
    this.handshakePhase = 'hello'
  }

  private resetForConnect(): void {
    this.clearHandshakeTimer()
    this.rejectAllPending(new ConnectionClosedError('stage channel client is reconnecting'))
    const socket = this.socket
    this.socket = null
    if (socket && socket.readyState !== 3) {
      try {
        socket.close(1000, 'client reconnecting')
      } catch {
        // ignore
      }
    }
    this.connectSettlers = null
    this.helloAckFrame = null
    this.stageSnapshot = null
    this.activated = false
    this.handshakePhase = 'hello'
    this.statusValue = 'disconnected'
    this.closeEmitted = false
  }

  private clearHandshakeTimer(): void {
    if (this.handshakeTimer !== null) {
      clearTimeout(this.handshakeTimer)
      this.handshakeTimer = null
    }
  }

  private nextRequestId(prefix: string): string {
    this.requestSeq += 1
    return `${prefix}-${this.requestSeq}`
  }

  // ── Event emitter ────────────────────────────────────────────────────────

  private registerOptionHandlers(): void {
    const {
      onConnected,
      onDisconnected,
      onHelloAck,
      onCommand,
      onLlmEvent,
      onEventRejected,
      onServerError,
    } = this.options
    if (onConnected) this.on('connected', onConnected)
    if (onDisconnected) this.on('disconnected', onDisconnected)
    if (onHelloAck) this.on('hello_ack', onHelloAck)
    if (onCommand) this.on('command', onCommand)
    if (onLlmEvent) this.on('llm_event', onLlmEvent)
    if (onEventRejected) this.on('event_rejected', onEventRejected)
    if (onServerError) this.on('server_error', onServerError)
  }

  private emit<K extends StageChannelEventName>(type: K, payload: StageChannelEventMap[K]): void {
    const handlers = this.listeners.get(type)
    if (!handlers) return
    for (const handler of [...handlers]) {
      try {
        ;(handler as (value: StageChannelEventMap[K]) => void)(payload)
      } catch {
        // A listener error must never break the state machine.
      }
    }
  }
}

/** Default WebSocket factory using the runtime global (`WebSocket` in Node >= 22 / browsers). */
export function defaultWebSocketFactory(url: string): WebSocketLike {
  const runtime = globalThis as { WebSocket?: new (url: string) => WebSocketLike }
  if (typeof runtime.WebSocket !== 'function') throw new WebSocketUnavailableError()
  return new runtime.WebSocket(url)
}

function emptyStageSnapshot(): StageSnapshot {
  return { id: 'empty', kind: 'empty', revision: 0, status: 'empty', participants: [], capabilities: [] }
}

function toText(data: unknown): string | null {
  if (typeof data === 'string') return data
  if (data instanceof ArrayBuffer) return new TextDecoder().decode(data)
  if (ArrayBuffer.isView(data)) return new TextDecoder().decode(data as ArrayBufferView)
  return null
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new StageChannelError(String(error))
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function truncate(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : `${value.slice(0, maxLength - 1)}…`
}
