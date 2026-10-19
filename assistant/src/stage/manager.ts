/**
 * StageRegistry owns registered environments and the one CurrentStage.
 * Registrations describe semantic environments; bridges only provide a live
 * execution path. Registering or reconnecting never activates an environment.
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage, type ContentBlock } from '@deepseek-ai/dsh-llm'
import type { JsonValue } from '@deepseek-ai/dsh-session'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-system-prompt'
import { enqueueOrFollowup } from '../memory/gate.js'
import type {
  StageBridge,
  StageCommandSpec,
  StageEnvironmentSpec,
  StageRegistration,
  StageRegistrationResult,
  StageSnapshot,
  StageTransitionRequest,
  StageTransitionResult,
} from './types.js'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'stage-event': {
      kind: 'stage-event'
      stageId: string
      bridgeId: string
      participantId: string
    }
  }
}

interface RegisteredStage {
  registration: StageRegistration
  bridge?: StageBridge
}

interface ActiveStage {
  id: string
  kind: string
  revision: number
  primaryRegistrationId: string
  environment: StageEnvironmentSpec
  capabilities: StageCommandSpec[]
  bridges: Map<string, StageBridge>
}

interface PersistedCurrentStage {
  version: 1
  current: null | {
    id: string
    kind: string
    revision: number
    primaryRegistrationId: string
    environment: StageEnvironmentSpec
    capabilities: StageCommandSpec[]
  }
}

export interface StageRegistryOptions {
  dataDir?: string
}

const EMPTY_STAGE_ID = 'empty'

export class StageRegistry {
  private active: ActiveStage | null = null
  private readonly registered = new Map<string, RegisteredStage>()
  private readonly statePath?: string
  private readonly contextDispose: () => void
  private readonly toolDispose: () => void
  private transitionTail: Promise<void> = Promise.resolve()
  private persistenceTail: Promise<void> = Promise.resolve()

  constructor(private readonly agent: Agent, options: StageRegistryOptions = {}) {
    this.statePath = options.dataDir ? resolve(options.dataDir, 'stage', 'current-stage.json') : undefined
    this.contextDispose = agent.ctx.systemPrompt.context({
      name: 'assistant:stage',
      order: 90,
      text: () => this.renderContext(),
    })
    // A fixed schema avoids invalidating the native tool header on activation.
    this.toolDispose = agent.ctx.tools.register(defineTool({
      name: 'stage_action',
      description: '在当前环境中执行动作。action=list 查看能力；action=execute 执行命令。',
      parameters: {
        action: {
          type: 'string',
          required: true,
          enum: ['list', 'execute'],
          description: 'list = 查看当前环境能力；execute = 执行环境命令',
        },
        command: { type: 'string', description: 'action=execute 时必填的命令名' },
        args: { type: 'object', additionalProperties: true, description: '命令参数' },
      },
      output: {
        schema: { type: 'object', additionalProperties: true },
        render: (_args, value) => [{
          type: 'text',
          text: value.ok ? JSON.stringify(value) : `环境动作失败：${String(value.error ?? '未知错误')}`,
        }],
      },
      execute: async (args, exec): Promise<Record<string, JsonValue>> => {
        if (args.action === 'list') {
          const stage = this.snapshot()
          return {
            ok: true,
            stageId: stage.id,
            stageKind: stage.kind,
            capabilities: stage.capabilities as unknown as JsonValue,
          }
        }
        try {
          return await this.execute(String(args.command ?? ''), args.args, exec.signal)
        } catch (error) {
          return { ok: false, error: error instanceof Error ? error.message : String(error) }
        }
      },
    }))
  }

  /** Restore only the selected semantic snapshot. It starts suspended. */
  async restore(): Promise<void> {
    if (!this.statePath) return
    try {
      const parsed = JSON.parse(await readFile(this.statePath, 'utf8')) as PersistedCurrentStage
      if (parsed.version !== 1 || !parsed.current) return
      const current = parsed.current
      this.active = {
        id: current.id,
        kind: current.kind,
        revision: Math.max(1, current.revision),
        primaryRegistrationId: current.primaryRegistrationId,
        environment: normalizeEnvironment(current.environment),
        capabilities: cloneCapabilities(current.capabilities),
        bridges: new Map(),
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        console.warn('[stage] 无法恢复 CurrentStage:', error instanceof Error ? error.message : String(error))
      }
    }
  }

  async flush(): Promise<void> { await this.persistenceTail }

  dispose(): void {
    this.contextDispose()
    this.toolDispose()
    this.registered.clear()
    this.active = null
  }

  snapshot(): StageSnapshot {
    if (!this.active) {
      return { id: EMPTY_STAGE_ID, kind: 'empty', revision: 0, status: 'empty', participants: [], capabilities: [] }
    }
    const participants = [...this.active.bridges.values()]
      .map(bridge => ({ ...bridge.participant, online: true }))
      .sort((a, b) => a.id.localeCompare(b.id))
    return {
      id: this.active.id,
      kind: this.active.kind,
      revision: this.active.revision,
      status: this.active.bridges.size > 0 ? 'active' : 'suspended',
      participants,
      capabilities: cloneCapabilities(this.active.capabilities),
      environment: structuredClone(this.active.environment),
    }
  }

  registrations(): StageRegistration[] {
    return [...this.registered.values()]
      .map(entry => cloneRegistration(entry.registration))
      .sort((a, b) => a.id.localeCompare(b.id))
  }

  bridges(): Array<{ id: string; stageId: string; kind: string; participantId: string }> {
    return [...this.registered.values()]
      .filter((entry): entry is RegisteredStage & { bridge: StageBridge } => entry.bridge !== undefined)
      .map(({ bridge }) => ({ id: bridge.id, stageId: bridge.stageId, kind: bridge.stageKind, participantId: bridge.participant.id }))
      .sort((a, b) => a.id.localeCompare(b.id))
  }

  /** Register or update an environment and optionally attach its live bridge. */
  registerStage(registration: StageRegistration, bridge?: StageBridge): StageRegistrationResult {
    const normalized = normalizeRegistration(registration)
    if (!normalized.id || !normalized.stageId || normalized.stageKind === 'empty') {
      return { kind: 'rejected', reason: 'registration id, stage id and non-empty kind are required' }
    }
    if (bridge && (bridge.stageId !== normalized.stageId || bridge.stageKind !== normalized.stageKind)) {
      return { kind: 'rejected', reason: 'bridge does not match registration' }
    }
    const previous = this.registered.get(normalized.id)
    const semanticChanged = !previous || !sameRegistration(previous.registration, normalized)
    if (previous && (previous.registration.stageId !== normalized.stageId || previous.registration.stageKind !== normalized.stageKind)) {
      return { kind: 'rejected', reason: 'registration identity cannot change environment identity' }
    }
    if ([...this.registered.values()].some(entry => entry.registration.stageId === normalized.stageId && entry.registration.stageKind !== normalized.stageKind)
        || (this.active?.id === normalized.stageId && this.active.kind !== normalized.stageKind)) {
      return { kind: 'rejected', reason: 'stage id already has another kind' }
    }
    if (previous?.bridge && previous.bridge !== bridge) this.active?.bridges.delete(previous.bridge.id)
    this.registered.set(normalized.id, { registration: normalized, bridge })
    if (this.active?.id === normalized.stageId && this.active.kind === normalized.stageKind) {
      if (bridge) this.active.bridges.set(bridge.id, bridge)
      if (this.active.primaryRegistrationId === normalized.id &&
          (JSON.stringify(this.active.environment) !== JSON.stringify(normalized.environment) ||
           JSON.stringify(this.active.capabilities) !== JSON.stringify(this.capabilitiesForActive(normalized.capabilities)))) {
        this.active.environment = structuredClone(normalized.environment)
        this.active.capabilities = this.capabilitiesForActive(normalized.capabilities)
        this.active.revision += 1
        this.persist()
      } else if (bridge) {
        const primary = this.registered.get(this.active.primaryRegistrationId)?.registration.capabilities
        const merged = primary ? this.capabilitiesForActive(primary) : mergeCapabilities([this.active.capabilities, normalized.capabilities])
        if (JSON.stringify(merged) !== JSON.stringify(this.active.capabilities)) {
          this.active.capabilities = merged
          this.active.revision += 1
          this.persist()
        }
      }
    }
    return {
      kind: !previous ? 'registered' : semanticChanged ? 'updated' : 'unchanged',
      registration: cloneRegistration(normalized),
    }
  }

  /** Remove a live registration. CurrentStage keeps its semantic snapshot. */
  unregisterStage(registrationId: string, bridge?: StageBridge): boolean {
    const current = this.registered.get(registrationId)
    if (!current || (bridge && current.bridge !== bridge)) return false
    this.registered.delete(registrationId)
    if (current.bridge) this.active?.bridges.delete(current.bridge.id)
    return true
  }

  /** Backward-compatible bridge API used by old hello clients. */
  registerBridge(bridge: StageBridge): () => void {
    const registration: StageRegistration = {
      id: bridge.id,
      stageId: bridge.stageId,
      stageKind: bridge.stageKind,
      environment: bridge.environment ?? { text: `External ${bridge.stageKind} environment.` },
      capabilities: bridge.capabilities,
    }
    const result = this.registerStage(registration, bridge)
    if (result.kind === 'rejected') throw new Error(result.reason)
    return () => { this.unregisterStage(registration.id, bridge) }
  }

  async transition(request: StageTransitionRequest): Promise<StageTransitionResult> {
    let result: StageTransitionResult | undefined
    const run = this.transitionTail.then(async () => { result = await this.performTransition(request) })
    this.transitionTail = run.catch(() => undefined)
    await run
    await this.flush()
    return result as StageTransitionResult
  }

  private async performTransition(request: StageTransitionRequest): Promise<StageTransitionResult> {
    const before = this.snapshot()
    if (request.expectedStageId !== undefined && request.expectedStageId !== before.id) {
      return { kind: 'rejected', reason: `current stage is ${before.id}`, stage: before }
    }
    if (request.expectedRevision !== undefined && request.expectedRevision !== before.revision) {
      return { kind: 'rejected', reason: `current stage revision is ${before.revision}`, stage: before }
    }
    if (request.mode === 'interrupt' && this.agent.status === 'running') this.agent.cancel({ kind: 'user' })
    if (this.agent.status === 'running') await this.agent.whenIdle()

    if (request.target.type === 'empty') {
      if (!this.active) return { kind: 'unchanged', stage: before }
      const from = this.active.id
      this.active = null
      this.persist()
      this.recordTransition(from, EMPTY_STAGE_ID, 'empty', 0)
      return { kind: 'changed', stage: this.snapshot() }
    }

    const target = request.target
    const entry = target.type === 'bridge'
      ? [...this.registered.values()].find(candidate => candidate.bridge?.id === target.bridgeId)
      : this.findRegistration(target.stageId, target.registrationId)
    if (!entry?.bridge) {
      return { kind: 'rejected', reason: `stage ${request.target.stageId} has no connected registration`, stage: before }
    }
    const registration = entry.registration
    if (request.target.type === 'bridge' &&
      (registration.stageId !== request.target.stageId || registration.stageKind !== request.target.kind)) {
      return { kind: 'rejected', reason: 'stage bridge does not match transition target', stage: before }
    }
    if (this.active?.id === registration.stageId && this.active.kind === registration.stageKind) {
      this.active.bridges.set(entry.bridge.id, entry.bridge)
      return { kind: 'unchanged', stage: this.snapshot() }
    }

    const from = this.active?.id ?? EMPTY_STAGE_ID
    const revision = (this.active?.revision ?? 0) + 1
    this.active = {
      id: registration.stageId,
      kind: registration.stageKind,
      revision,
      primaryRegistrationId: registration.id,
      environment: structuredClone(registration.environment),
      capabilities: cloneCapabilities(registration.capabilities),
      bridges: new Map(),
    }
    for (const candidate of this.registered.values()) {
      if (candidate.bridge && candidate.registration.stageId === this.active.id &&
          candidate.registration.stageKind === this.active.kind) {
        this.active.bridges.set(candidate.bridge.id, candidate.bridge)
        this.active.capabilities = mergeCapabilities([this.active.capabilities, candidate.registration.capabilities])
      }
    }
    this.persist()
    this.recordTransition(from, this.active.id, this.active.kind, this.active.revision)
    return { kind: 'changed', stage: this.snapshot() }
  }

  activate(stageId: string, registrationId?: string, options: Omit<StageTransitionRequest, 'target'> = {}): Promise<StageTransitionResult> {
    return this.transition({ ...options, target: { type: 'registered', stageId, registrationId } })
  }

  enterBridge(bridgeId: string): Promise<StageTransitionResult> {
    const entry = [...this.registered.values()].find(candidate => candidate.bridge?.id === bridgeId)
    if (!entry?.bridge) {
      return Promise.resolve({ kind: 'rejected', reason: `stage bridge ${bridgeId} is not connected`, stage: this.snapshot() })
    }
    return this.transition({
      target: { type: 'bridge', kind: entry.registration.stageKind, stageId: entry.registration.stageId, bridgeId },
      mode: 'after-turn',
    })
  }

  deliverUser(text: string): number {
    return this.deliverUserContent([{ type: 'text', text: text.trim() }])
  }

  deliverUserContent(content: ContentBlock[]): number {
    const turn = this.nextTurn()
    enqueueOrFollowup(createUserMessage({ content, source: { kind: 'user' } }))
    return turn
  }

  deliverEvent(bridgeId: string, event: Record<string, unknown>): boolean {
    const bridge = this.active?.bridges.get(bridgeId)
    if (!bridge) return false
    enqueueOrFollowup(createUserMessage({
      content: [{ type: 'text', text: JSON.stringify(event) }],
      source: {
        kind: 'stage-event',
        stageId: this.active?.id ?? EMPTY_STAGE_ID,
        bridgeId,
        participantId: bridge.participant.id,
      },
    }))
    return true
  }

  private findRegistration(stageId: string, registrationId?: string): RegisteredStage | undefined {
    if (registrationId) {
      const entry = this.registered.get(registrationId)
      return entry?.registration.stageId === stageId ? entry : undefined
    }
    return [...this.registered.values()]
      .filter(entry => entry.registration.stageId === stageId && entry.bridge)
      .sort((a, b) => a.registration.id.localeCompare(b.registration.id))[0]
  }

  private capabilitiesForActive(primary: readonly StageCommandSpec[]): StageCommandSpec[] {
    if (!this.active) return cloneCapabilities(primary)
    const groups: Array<readonly StageCommandSpec[]> = [primary]
    for (const entry of this.registered.values()) {
      if (entry.bridge && entry.registration.id !== this.active.primaryRegistrationId &&
          entry.registration.stageId === this.active.id && entry.registration.stageKind === this.active.kind) {
        groups.push(entry.registration.capabilities)
      }
    }
    return mergeCapabilities(groups)
  }

  private async execute(command: string, args: unknown, signal?: AbortSignal): Promise<Record<string, JsonValue>> {
    if (!this.active) throw new Error('当前是 EmptyStage，没有环境能力')
    if (!command) throw new Error('command is required')
    const bridge = [...this.active.bridges.values()].find(candidate =>
      candidate.capabilities.some(capability => capability.name === command))
    if (!bridge) throw new Error(`当前 Stage 没有可执行 ${command} 的在线连接`)
    const result = await bridge.execute(command, args, signal)
    return { ok: result.ok !== false, command, ...result }
  }

  private renderContext(): string {
    const stage = this.snapshot()
    if (stage.kind === 'empty') {
      return '[当前环境]\nEmptyStage：当前没有激活外部环境。stage_action.list 返回空能力列表。'
    }
    const capabilities = stage.capabilities.length > 0
      ? stage.capabilities.map(c => c.description ? `${c.name} — ${c.description}` : c.name).join('\n- ')
      : '无'
    return [
      '[当前环境]',
      `stageId: ${stage.id}`,
      `类型: ${stage.kind}`,
      stage.environment?.text ?? '',
      `可用动作:\n- ${capabilities}`,
    ].filter(Boolean).join('\n')
  }

  private persist(): void {
    if (!this.statePath) return
    const current = this.active ? {
      id: this.active.id,
      kind: this.active.kind,
      revision: this.active.revision,
      primaryRegistrationId: this.active.primaryRegistrationId,
      environment: this.active.environment,
      capabilities: this.active.capabilities,
    } : null
    const document: PersistedCurrentStage = structuredClone({ version: 1, current })
    const path = this.statePath
    this.persistenceTail = this.persistenceTail.then(async () => {
      await mkdir(dirname(path), { recursive: true })
      const temporary = `${path}.tmp`
      await writeFile(temporary, `${JSON.stringify(document, null, 2)}\n`, 'utf8')
      await rename(temporary, path)
    }).catch(error => console.warn('[stage] 无法持久化 CurrentStage:', error instanceof Error ? error.message : String(error)))
  }

  private recordTransition(from: string, to: string, kind: string, revision: number): void {
    console.log(`[stage] ${from} -> ${to} (kind=${kind}, revision=${revision})`)
  }

  private nextTurn(): number {
    return this.agent.session.events.filter(event => event.type === 'turn/start').length + 1
  }
}

/** Compatibility name for callers written before StageRegistry was explicit. */
export class CurrentStageManager extends StageRegistry {}

function normalizeRegistration(value: StageRegistration): StageRegistration {
  return {
    id: value.id.trim(),
    stageId: value.stageId.trim(),
    stageKind: value.stageKind,
    environment: normalizeEnvironment(value.environment),
    capabilities: cloneCapabilities(value.capabilities).sort((a, b) => a.name.localeCompare(b.name)),
  }
}

function normalizeEnvironment(value: StageEnvironmentSpec): StageEnvironmentSpec {
  return { text: typeof value?.text === 'string' ? value.text.trim() : '' }
}

function cloneRegistration(value: StageRegistration): StageRegistration {
  return structuredClone(value)
}

function sameRegistration(a: StageRegistration, b: StageRegistration): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

function cloneCapabilities(capabilities: readonly StageCommandSpec[]): StageCommandSpec[] {
  return capabilities.map(spec => structuredClone(spec))
}

function mergeCapabilities(groups: Iterable<readonly StageCommandSpec[]>): StageCommandSpec[] {
  const byName = new Map<string, StageCommandSpec>()
  for (const capabilities of groups) {
    for (const capability of capabilities) {
      if (!byName.has(capability.name)) byName.set(capability.name, structuredClone(capability))
    }
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name))
}
