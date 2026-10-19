/**
 * Stage domain types.
 *
 * A Stage is the assistant's one current semantic environment. StageChannel
 * carries the client protocol; bridges adapt a stage's actions to a transport.
 */

import type { JsonValue } from '@deepseek-ai/dsh-session'

export type StageId = string
export type StageKind = 'empty' | 'vn' | (string & {})

export interface StageParamSpec {
  type?: 'string' | 'number' | 'integer' | 'boolean' | 'object' | 'array' | 'null'
  required?: boolean
  description?: string
  enum?: unknown[]
  format?: string
  default?: unknown
  items?: StageParamSpec
  properties?: Record<string, StageParamSpec>
}

/** One command understood by a StageBridge. */
export interface StageCommandSpec {
  name: string
  description?: string
  parameters?: StageParamSpec
  returns?: string
  example?: Record<string, unknown>
}

export interface StageParticipant {
  id: string
  role: 'assistant' | 'user' | 'client'
  name?: string
  online: boolean
}

/** Stable, transport-independent description injected while a Stage is active. */
export interface StageEnvironmentSpec {
  text: string
}

/** A client may register several environments without activating any of them. */
export interface StageRegistration {
  /** Stable registration identity within one Stage client connection. */
  id: string
  stageId: StageId
  stageKind: StageKind
  environment: StageEnvironmentSpec
  capabilities: readonly StageCommandSpec[]
}

export type StageRegistrationResult =
  | { kind: 'registered' | 'updated' | 'unchanged'; registration: StageRegistration }
  | { kind: 'rejected'; reason: string }

/** Transport-neutral proxy to a Stage client (currently Godot over StageChannel). */
export interface StageBridge {
  readonly id: string
  readonly stageId: StageId
  readonly stageKind: StageKind
  readonly participant: StageParticipant
  /** Environment text is semantic state and must not contain connection metadata. */
  readonly environment?: StageEnvironmentSpec
  readonly capabilities: readonly StageCommandSpec[]
  execute(
    command: string,
    args: unknown,
    signal?: AbortSignal,
  ): Promise<Record<string, JsonValue>>
}

export interface StageSnapshot {
  id: StageId
  kind: StageKind
  revision: number
  status: 'empty' | 'active' | 'suspended'
  participants: readonly StageParticipant[]
  capabilities: readonly StageCommandSpec[]
  environment?: StageEnvironmentSpec
}

export interface StageTransitionRequest {
  /** Optimistic concurrency guard. */
  expectedStageId?: StageId
  expectedRevision?: number
  /** Empty returns the assistant to its default conversational environment. */
  target:
    | { type: 'empty' }
    | { type: 'bridge'; kind: StageKind; stageId: StageId; bridgeId: string }
    | { type: 'registered'; stageId: StageId; registrationId?: string }
  mode?: 'after-turn' | 'interrupt'
}

export type StageTransitionResult =
  | { kind: 'changed'; stage: StageSnapshot }
  | { kind: 'unchanged'; stage: StageSnapshot }
  | { kind: 'rejected'; reason: string; stage: StageSnapshot }
