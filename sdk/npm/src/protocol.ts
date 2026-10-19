/**
 * Frame encoding, decoding, validation and construction for the StageChannel
 * protocol.
 *
 * Design rules from `sdk/spec/protocol.md`:
 * - every frame is a JSON object with a `type`;
 * - unknown `type` values are ignored (forward compatibility);
 * - unknown fields are ignored;
 * - malformed JSON / non-object payloads are dropped silently.
 *
 * @module stage-channel-sdk/protocol
 */

import type {
  ChatFrame,
  ChatResultFrame,
  CommandFrame,
  CommandResultFrame,
  ClientFrame,
  EventFrame,
  EventRejectedFrame,
  HelloAckFrame,
  HelloFrame,
  LlmEventFrame,
  RegisterResult,
  ServerErrorFrame,
  ServerFrame,
  StageActivateFrame,
  StageActivateResultFrame,
  StageDefinition,
  StageEventPayload,
  StageRegisterFrame,
  StageRegisterResultFrame,
  StageSnapshot,
  StageTransitionFrame,
  StageTransitionResultFrame,
  StageUnregisterResultFrame,
  TransitionResult,
} from './types.ts'

/** Input accepted by {@link createHelloFrame}. */
export type HelloFrameInput = Omit<HelloFrame, 'type' | 'channel'>

/** Input accepted by {@link createStageRegisterFrame}. */
export interface StageRegisterFrameInput {
  requestId?: string
  stage: StageDefinition
}

/** Shared input for activate / transition frames. */
export interface StageActivateFrameInput {
  requestId?: string
  stageId: string
  mode?: 'after-turn' | 'interrupt'
  expectedStageId?: string
  expectedRevision?: number
}

/** Input accepted by {@link createStageTransitionFrame}. */
export interface StageTransitionFrameInput extends StageActivateFrameInput {
  target?: 'empty'
}

/** Input accepted by {@link createEventFrame}. */
export interface EventFrameInput {
  stageId?: string
  event: StageEventPayload
}

/** Input accepted by {@link createCommandResultFrame}. */
export interface CommandResultFrameInput {
  commandId: string
  ok: boolean
  result?: unknown
  error?: string
}

/** Input accepted by {@link createChatFrame}. */
export interface ChatFrameInput {
  requestId?: string
  text: string
  images?: unknown[]
}

/** Serialize a client frame to a single WebSocket text frame. */
export function encodeFrame(frame: ClientFrame): string {
  return JSON.stringify(frame)
}

/** Parse a text frame into a plain object, or `null` when it is not a JSON object. */
export function parseJsonObject(text: string): Record<string, unknown> | null {
  if (typeof text !== 'string' || text.length === 0) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return null
  }
  return isRecord(parsed) ? parsed : null
}

/**
 * Decode an inbound server frame.
 *
 * Returns `null` when the payload is not a JSON object or has no non-empty
 * string `type`. Unknown `type` values are returned as `UnknownServerFrame` so
 * callers can ignore them safely.
 */
export function decodeServerFrame(input: string | Record<string, unknown>): ServerFrame | null {
  const raw = typeof input === 'string' ? parseJsonObject(input) : input
  if (raw === null || !isRecord(raw)) return null
  if (typeof raw.type !== 'string' || raw.type.length === 0) return null
  return raw as unknown as ServerFrame
}

// ── Type guards (tolerant: only the fields we rely on are checked) ─────────

/** True when the value is a plain (non-array) object. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** True for a structurally valid {@link StageSnapshot}. */
export function isStageSnapshot(value: unknown): value is StageSnapshot {
  if (!isRecord(value)) return false
  return (
    typeof value.id === 'string' &&
    value.id.length > 0 &&
    typeof value.kind === 'string' &&
    typeof value.revision === 'number' &&
    typeof value.status === 'string' &&
    Array.isArray(value.participants) &&
    Array.isArray(value.capabilities)
  )
}

/** True for a structurally valid {@link TransitionResult}. */
export function isTransitionResult(value: unknown): value is TransitionResult {
  if (!isRecord(value)) return false
  if (value.kind === 'changed' || value.kind === 'unchanged') return isStageSnapshot(value.stage)
  if (value.kind === 'rejected') return typeof value.reason === 'string'
  return false
}

/** True for a structurally valid {@link RegisterResult}. */
export function isRegisterResult(value: unknown): value is RegisterResult {
  if (!isRecord(value)) return false
  if (value.kind === 'rejected') return typeof value.reason === 'string'
  if (value.kind === 'registered' || value.kind === 'updated' || value.kind === 'unchanged') {
    return isRecord(value.registration)
  }
  return false
}

/** True when the frame is a known `hello_ack`. */
export function isHelloAckFrame(frame: ServerFrame): frame is HelloAckFrame {
  return frame.type === 'hello_ack'
}

/** True when the frame is a known `stage_register_result`. */
export function isStageRegisterResultFrame(frame: ServerFrame): frame is StageRegisterResultFrame {
  return frame.type === 'stage_register_result'
}

/** True when the frame is a known `stage_unregister_result`. */
export function isStageUnregisterResultFrame(frame: ServerFrame): frame is StageUnregisterResultFrame {
  return frame.type === 'stage_unregister_result'
}

/** True when the frame is a known `stage_activate_result`. */
export function isStageActivateResultFrame(frame: ServerFrame): frame is StageActivateResultFrame {
  return frame.type === 'stage_activate_result'
}

/** True when the frame is a known `stage_transition_result`. */
export function isStageTransitionResultFrame(frame: ServerFrame): frame is StageTransitionResultFrame {
  return frame.type === 'stage_transition_result'
}

/** True when the frame is a known `command` with a usable command id / name. */
export function isCommandFrame(frame: ServerFrame): frame is CommandFrame {
  if (frame.type !== 'command') return false
  const raw = frame as unknown as Record<string, unknown>
  return typeof raw.commandId === 'string' && raw.commandId.length > 0 && typeof raw.command === 'string'
}

/** True when the frame is a known `llm_event`. */
export function isLlmEventFrame(frame: ServerFrame): frame is LlmEventFrame {
  return frame.type === 'llm_event'
}

/** True when the frame is a known `event_rejected`. */
export function isEventRejectedFrame(frame: ServerFrame): frame is EventRejectedFrame {
  return frame.type === 'event_rejected'
}

/** True when the frame is a known `error`. */
export function isServerErrorFrame(frame: ServerFrame): frame is ServerErrorFrame {
  return frame.type === 'error'
}

/** True when the frame is a known `chat_result`. */
export function isChatResultFrame(frame: ServerFrame): frame is ChatResultFrame {
  return frame.type === 'chat_result'
}

const KNOWN_SERVER_TYPES: ReadonlySet<string> = new Set([
  'hello_ack',
  'stage_register_result',
  'stage_unregister_result',
  'stage_activate_result',
  'stage_transition_result',
  'command',
  'llm_event',
  'event_rejected',
  'error',
  'chat_result',
])

/** True when the frame type is part of protocol v1. */
export function isKnownServerFrame(frame: ServerFrame): boolean {
  return KNOWN_SERVER_TYPES.has(frame.type)
}

/** True when the frame has a `type` this SDK does not know yet. */
export function isUnknownServerFrame(frame: ServerFrame): boolean {
  return !isKnownServerFrame(frame)
}

// ── Handshake validation ───────────────────────────────────────────────────

/** Result of {@link validateHelloAck}. */
export type HelloAckValidation = { ok: true } | { ok: false; reason: string }

/**
 * Validate the fields of `hello_ack` that the state machine depends on.
 * Unknown extra fields are always accepted.
 */
export function validateHelloAck(frame: HelloAckFrame): HelloAckValidation {
  const raw = frame as unknown as Record<string, unknown>
  if (raw.channel !== 'stage') {
    return { ok: false, reason: `hello_ack.channel must be "stage", got ${JSON.stringify(raw.channel)}` }
  }
  if (typeof raw.clientId !== 'string' || raw.clientId.length === 0) {
    return { ok: false, reason: 'hello_ack.clientId must be a non-empty string' }
  }
  if (!isStageSnapshot(raw.stage)) {
    return { ok: false, reason: 'hello_ack.stage is not a valid StageSnapshot' }
  }
  if (!Array.isArray(raw.registrations)) {
    return { ok: false, reason: 'hello_ack.registrations must be an array' }
  }
  return { ok: true }
}

// ── Frame constructors (undefined optional fields are omitted) ─────────────

/** Build a `hello` frame. */
export function createHelloFrame(input: HelloFrameInput): HelloFrame {
  return compact({
    type: 'hello',
    channel: 'stage',
    clientId: input.clientId,
    role: input.role,
    assistantId: input.assistantId,
    name: input.name,
    clientType: input.clientType,
    stageId: input.stageId,
    stageKind: input.stageKind,
    environment: input.environment,
    commands: input.commands,
    activateStage: input.activateStage,
  }) as unknown as HelloFrame
}

/** Build a `stage_register` frame. */
export function createStageRegisterFrame(input: StageRegisterFrameInput): StageRegisterFrame {
  return compact({ type: 'stage_register', requestId: input.requestId, stage: input.stage }) as unknown as StageRegisterFrame
}

/** Build a `stage_activate` frame. */
export function createStageActivateFrame(input: StageActivateFrameInput): StageActivateFrame {
  return compact({
    type: 'stage_activate',
    requestId: input.requestId,
    stageId: input.stageId,
    mode: input.mode,
    expectedStageId: input.expectedStageId,
    expectedRevision: input.expectedRevision,
  }) as unknown as StageActivateFrame
}

/** Build a `stage_transition` frame. */
export function createStageTransitionFrame(input: StageTransitionFrameInput): StageTransitionFrame {
  return compact({
    type: 'stage_transition',
    requestId: input.requestId,
    stageId: input.stageId,
    target: input.target,
    mode: input.mode,
    expectedStageId: input.expectedStageId,
    expectedRevision: input.expectedRevision,
  }) as unknown as StageTransitionFrame
}

/** Build an `event` frame. */
export function createEventFrame(input: EventFrameInput): EventFrame {
  return compact({ type: 'event', stageId: input.stageId, event: input.event }) as unknown as EventFrame
}

/** Build a `command_result` frame. */
export function createCommandResultFrame(input: CommandResultFrameInput): CommandResultFrame {
  return compact({
    type: 'command_result',
    commandId: input.commandId,
    ok: input.ok,
    result: input.result ?? null,
    error: input.error,
  }) as unknown as CommandResultFrame
}

/** Build a `chat` frame. */
export function createChatFrame(input: ChatFrameInput): ChatFrame {
  return compact({ type: 'chat', requestId: input.requestId, text: input.text, images: input.images }) as unknown as ChatFrame
}

/** Drop keys whose value is `undefined`. */
function compact<T extends Record<string, unknown>>(value: T): T {
  for (const key of Object.keys(value)) {
    if (value[key] === undefined) delete value[key]
  }
  return value
}
