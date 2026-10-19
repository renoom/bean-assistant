/**
 * Wire types for the StageChannel protocol (v1).
 *
 * The single source of truth is `sdk/spec/protocol.md` and `sdk/spec/fixtures/`.
 * This module mirrors the contract for TypeScript consumers. Inbound frames may
 * carry unknown fields and unknown `type` values; those are tolerated and can be
 * read as `UnknownServerFrame`.
 *
 * @module stage-channel-sdk/types
 */

/** JSON primitive value accepted by command results and event payloads. */
export type JsonPrimitive = string | number | boolean | null

/** JSON value accepted by command results and event payloads. */
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue }

/** The stage channel name used in `hello` / `hello_ack`. */
export type StageChannelName = 'stage'

/** Role of the client: an assistant bridge or a user's private channel. */
export type ClientRole = 'assistant' | 'user'

/** Role of a stage participant on the server side. */
export type ParticipantRole = 'assistant' | 'user' | 'client'

/** Activation mode: wait for the current turn, or interrupt it. */
export type ActivateMode = 'after-turn' | 'interrupt'

/** Human-readable environment descriptor. */
export interface StageEnvironment {
  text: string
}

/** JSON-Schema-like description of a stage command / capability. */
export interface CommandSpec {
  name: string
  description?: string
  parameters?: Record<string, unknown>
  returns?: string
  example?: Record<string, unknown>
}

/** A stage definition declared by the client. */
export interface StageDefinition {
  id: string
  kind: string
  environment?: StageEnvironment
  commands?: CommandSpec[]
}

/** A participant in the current stage snapshot. */
export interface StageParticipant {
  id: string
  role: ParticipantRole
  name?: string
  online: boolean
}

/** Server-side snapshot of the current stage. */
export interface StageSnapshot {
  id: string
  kind: string
  revision: number
  status: 'empty' | 'active' | 'suspended' | (string & {})
  participants: StageParticipant[]
  capabilities: CommandSpec[]
  environment?: StageEnvironment
}

/** A stage registration acknowledged by the server. */
export interface Registration {
  id: string
  stageId: string
  stageKind: string
  environment: StageEnvironment
  capabilities: CommandSpec[]
}

/** Result of a stage activation / transition. */
export type TransitionResult =
  | { kind: 'changed' | 'unchanged'; stage: StageSnapshot }
  | { kind: 'rejected'; reason: string; stage?: StageSnapshot }

/** Result of a stage registration. */
export type RegisterResult =
  | { kind: 'registered' | 'updated' | 'unchanged'; registration: Registration }
  | { kind: 'rejected'; reason: string }

/** A scene event sent from the client to the server. */
export interface StageEventPayload {
  kind: string
  [key: string]: unknown
}

// ── Client → Server frames ─────────────────────────────────────────────────

/** `hello`: starts the handshake. */
export interface HelloFrame {
  type: 'hello'
  channel: StageChannelName
  clientId: string
  role?: ClientRole
  assistantId?: string
  name?: string
  clientType?: string
  /** Legacy compatibility fields; older servers accepted the stage in `hello`. */
  stageId?: string
  stageKind?: string
  environment?: StageEnvironment
  commands?: CommandSpec[]
  activateStage?: boolean
}

/** `stage_register`: declares a stage and its commands. */
export interface StageRegisterFrame {
  type: 'stage_register'
  requestId?: string
  stage: StageDefinition
}

/** `stage_unregister`: removes a stage registration. */
export interface StageUnregisterFrame {
  type: 'stage_unregister'
  requestId?: string
  stageId: string
}

/** `stage_activate`: makes a registered stage the current stage. */
export interface StageActivateFrame {
  type: 'stage_activate'
  requestId?: string
  stageId: string
  mode?: ActivateMode
  expectedStageId?: string
  expectedRevision?: number
}

/** `stage_transition`: activates a stage or transitions back to the empty stage. */
export interface StageTransitionFrame {
  type: 'stage_transition'
  requestId?: string
  stageId: string
  target?: 'empty'
  mode?: ActivateMode
  expectedStageId?: string
  expectedRevision?: number
}

/** `event`: reports a scene event for the current stage. */
export interface EventFrame {
  type: 'event'
  stageId?: string
  event: StageEventPayload
}

/** `command_result`: acknowledges a command sent by the assistant. */
export interface CommandResultFrame {
  type: 'command_result'
  commandId: string
  ok: boolean
  result: unknown
  error?: string
}

/** `chat` (optional): sends a chat message through the stage channel. */
export interface ChatFrame {
  type: 'chat'
  requestId?: string
  text: string
  images?: unknown[]
}

/** Any frame the client can send. */
export type ClientFrame =
  | HelloFrame
  | StageRegisterFrame
  | StageUnregisterFrame
  | StageActivateFrame
  | StageTransitionFrame
  | EventFrame
  | CommandResultFrame
  | ChatFrame

// ── Server → Client frames ─────────────────────────────────────────────────

/** `hello_ack`: handshake acknowledgement. */
export interface HelloAckFrame {
  type: 'hello_ack'
  channel: string
  clientId: string
  bridgeId?: string
  registrations: Registration[]
  stage: StageSnapshot
  transition?: TransitionResult | null
}

/** `stage_register_result` */
export interface StageRegisterResultFrame {
  type: 'stage_register_result'
  requestId?: string
  result: RegisterResult
  stage?: StageSnapshot
}

/** `stage_unregister_result` */
export interface StageUnregisterResultFrame {
  type: 'stage_unregister_result'
  requestId?: string
  removed: boolean
  stage?: StageSnapshot
}

/** `stage_activate_result` */
export interface StageActivateResultFrame {
  type: 'stage_activate_result'
  requestId?: string
  result: TransitionResult
}

/** `stage_transition_result` */
export interface StageTransitionResultFrame {
  type: 'stage_transition_result'
  requestId?: string
  result: TransitionResult
}

/** `command`: the assistant asks the client to execute a stage command. */
export interface CommandFrame {
  type: 'command'
  commandId: string
  bridgeId?: string
  stageId?: string
  command: string
  args?: Record<string, unknown>
}

/** `llm_event`: a model / session event forwarded to clients. */
export interface LlmEventFrame {
  type: 'llm_event'
  event: unknown
}

/** `event_rejected`: the reported event was not accepted for the current stage. */
export interface EventRejectedFrame {
  type: 'event_rejected'
  reason?: string
}

/** `error`: protocol-level error. */
export interface ServerErrorFrame {
  type: 'error'
  requestId?: string
  error: string
}

/** `chat_result` (optional): result of a `chat` frame. */
export interface ChatResultFrame {
  type: 'chat_result'
  requestId?: string
  accepted: boolean
  turn?: unknown
  error?: string
}

/** Every known server frame. */
export type KnownServerFrame =
  | HelloAckFrame
  | StageRegisterResultFrame
  | StageUnregisterResultFrame
  | StageActivateResultFrame
  | StageTransitionResultFrame
  | CommandFrame
  | LlmEventFrame
  | EventRejectedFrame
  | ServerErrorFrame
  | ChatResultFrame

/**
 * Forward-compatible envelope for a frame this SDK does not know yet.
 * Unknown `type` values must be ignored, never treated as an error.
 */
export interface UnknownServerFrame {
  type: string
  [key: string]: unknown
}

/** Any server frame, known or unknown. */
export type ServerFrame = KnownServerFrame | UnknownServerFrame

// ── Injectable platform primitives ─────────────────────────────────────────

/** Minimal structural view of the standard `WebSocket` used by the client. */
export interface WebSocketLike {
  readonly readyState: number
  onopen: ((event: unknown) => void) | null
  onmessage: ((event: { data: unknown }) => void) | null
  onerror: ((event: unknown) => void) | null
  onclose: ((event: { code: number; reason: string; wasClean?: boolean }) => void) | null
  send(data: string): void
  close(code?: number, reason?: string): void
}

/** Factory for `WebSocket` instances; inject a fake in tests. */
export type WebSocketFactory = (url: string) => WebSocketLike

/** Minimal structural view of the standard `fetch` response. */
export interface FetchResponseLike {
  readonly ok: boolean
  readonly status: number
  readonly statusText?: string
  json(): Promise<unknown>
  text?(): Promise<string>
}

/** Minimal structural view of the standard `fetch` request init. */
export interface FetchRequestInitLike {
  method?: string
  headers?: Record<string, string>
  signal?: AbortSignal
  body?: string
}

/** Injectable `fetch` implementation (defaults to the global one). */
export type FetchLike = (input: string, init?: FetchRequestInitLike) => Promise<FetchResponseLike>

/** A channel endpoint reported by console discovery (direct-connect fallback). */
export interface ChannelEndpoint {
  id: string
  protocol: 'http' | 'ws'
  host: string
  port: number
  path: string
}
