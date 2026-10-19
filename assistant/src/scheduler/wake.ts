import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { boundContextSummary, createUserMessage, type UserMessage } from '@deepseek-ai/dsh-llm'
import { enqueueOrFollowup } from '../memory/gate.js'
import type { TaskSchedule } from './client.js'

export interface ScheduledTaskSnapshot {
  id: string
  ownerSessionId: string
  creatorName: string
  title: string
  prompt: string
  schedule: TaskSchedule
  enabled: boolean
  nextRunAt: string | null
  lastOutcome: 'pending' | 'delivered' | 'retrying' | null
  lastError: string | null
  createdAt: string
  updatedAt: string
  completedAt: string | null
}

export interface ScheduledRunInfo {
  id: string
  trigger: 'scheduled' | 'manual'
  scheduledAt: string
  triggeredAt: string
}

export interface ScheduledWake {
  sessionId: string
  taskId: string
  runId: string
  title: string
  prompt: string
  scheduledAt: string
  /** Missing only for receipts produced before task snapshots were added. */
  task?: ScheduledTaskSnapshot
  run?: ScheduledRunInfo
}

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'scheduled-task': {
      kind: 'scheduled-task'
      sessionId: string
      taskId: string
      runId: string
      title: string
      scheduledAt: string
    }
    'system-event': {
      kind: 'system-event'
      producer: 'console.scheduler'
      eventType: 'scheduled-task-triggered'
      form: 'notice'
      summary: string
      sessionId: string
      taskId: string
      runId: string
      title: string
      scheduledAt: string
      task?: ScheduledTaskSnapshot
      run?: ScheduledRunInfo
    }
  }
}

function runIdOf(message: UserMessage): string | undefined {
  const source = message.source
  return source.kind === 'scheduled-task'
    || (source.kind === 'system-event' && source.eventType === 'scheduled-task-triggered')
    ? source.runId : undefined
}

function validateWake(input: unknown, sessionId: string): ScheduledWake {
  if (!input || typeof input !== 'object') throw new Error('invalid scheduled wake')
  const value = input as Record<string, unknown>
  const limits = { sessionId: 200, taskId: 200, runId: 200, title: 200, prompt: 20_000, scheduledAt: 100 }
  for (const [key, limit] of Object.entries(limits)) {
    if (typeof value[key] !== 'string' || !(value[key] as string).trim() || (value[key] as string).length > limit) {
      throw new Error(`invalid scheduled wake ${key}`)
    }
  }
  if (value.sessionId !== sessionId) throw new Error('scheduled wake belongs to another assistant')
  if (!Number.isFinite(Date.parse(value.scheduledAt as string))) throw new Error('invalid scheduledAt')
  const wake = Object.fromEntries(Object.keys(limits).map(key => [key, value[key]])) as unknown as ScheduledWake
  if ((value.task === undefined) !== (value.run === undefined)) throw new Error('task snapshot and run info must be supplied together')
  if (value.task !== undefined) {
    const task = value.task as ScheduledTaskSnapshot
    const run = value.run as ScheduledRunInfo
    if (!task || typeof task !== 'object' || !run || typeof run !== 'object') throw new Error('invalid task snapshot or run info')
    if (task.id !== wake.taskId || task.ownerSessionId !== sessionId || task.title !== wake.title || task.prompt !== wake.prompt
      || run.id !== wake.runId || run.scheduledAt !== wake.scheduledAt) throw new Error('task snapshot or run identity mismatch')
    if (typeof task.creatorName !== 'string' || !task.creatorName.trim() || task.creatorName.length > 200
      || !validTime(task.createdAt) || !validTime(task.updatedAt) || !validTime(run.triggeredAt)
      || !['scheduled', 'manual'].includes(run.trigger)) throw new Error('invalid task creation or trigger metadata')
    const schedule = task.schedule
    if (!schedule || !['once', 'interval', 'daily'].includes(schedule.kind)
      || (schedule.kind === 'once' && !validTime(schedule.at))
      || (schedule.kind === 'interval' && (!Number.isSafeInteger(schedule.everySeconds) || schedule.everySeconds < 60
        || (schedule.startAt !== undefined && !validTime(schedule.startAt))))
      || (schedule.kind === 'daily' && (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(schedule.time)
        || typeof schedule.timezone !== 'string' || schedule.timezone.length > 100))) throw new Error('invalid task schedule snapshot')
    // Snapshot the original JSON values before an asynchronous ACK/persistence.
    wake.task = structuredClone(task)
    wake.run = structuredClone(run)
  }
  return wake
}

function validTime(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 100 && Number.isFinite(Date.parse(value))
}

/** Durable pending inputs protect an accepted wake across assistant restarts. */
export class ScheduledWakeService {
  private readonly pending = new Map<string, ScheduledWake>()
  private readonly seen = new Set<string>()
  private readonly queued = new Set<string>()
  private readonly deliveries = new Map<string, Promise<void>>()
  private chain: Promise<void> = Promise.resolve()
  private disposed = false
  private readonly path: string
  private readonly unsubscribe: () => void

  private constructor(private readonly agent: Agent, private readonly dataDir: string) {
    this.path = resolve(dataDir, 'scheduled-inputs.json')
    for (const event of agent.session.events) {
      if (event.type === 'user/message') {
        const id = runIdOf(event.data)
        if (id) this.seen.add(id)
      }
    }
    this.unsubscribe = agent.ctx.on('session/event', (session, event) => {
      if (session !== agent.session || event.type !== 'user/message') return
      const id = runIdOf(event.data)
      if (!id) return
      this.seen.add(id)
      // Persist the consumed input before discarding its recovery receipt.
      void agent.ctx.sessions.flush(session).then(async () => {
        if (this.pending.delete(id)) await this.persist()
      }).catch(error => console.warn('[scheduler] 唤醒记录提交失败:', error))
    })
  }

  static async create(agent: Agent, dataDir: string): Promise<ScheduledWakeService> {
    const service = new ScheduledWakeService(agent, dataDir)
    try {
      const raw = await readFile(service.path, 'utf8')
      const data = JSON.parse(raw) as { version: number; receipts: unknown[] }
      if (data.version !== 1 || !Array.isArray(data.receipts)) throw new Error('invalid scheduled input receipt file')
      let removedConsumedReceipt = false
      for (const entry of data.receipts) {
        const wake = validateWake(entry, String(agent.session.id))
        if (service.seen.has(wake.runId)) {
          removedConsumedReceipt = true
        } else {
          service.pending.set(wake.runId, wake)
        }
      }
      // A crash can happen after the native user/message checkpoint and before
      // its receipt cleanup. It is already consumed, so compact the stale
      // receipt now without touching any unconsumed recovery inputs.
      if (removedConsumedReceipt) await service.persist()
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        service.unsubscribe()
        throw error
      }
    }
    return service
  }

  /** Called after tools, environment, and memory hooks are fully installed. */
  resume(): void {
    for (const wake of this.pending.values()) this.startDelivery(wake)
  }

  async accept(input: unknown): Promise<{ accepted: true; duplicate: boolean }> {
    if (this.disposed) throw new Error('scheduler receiver is shutting down')
    const wake = validateWake(input, String(this.agent.session.id))
    const duplicate = this.seen.has(wake.runId) || this.pending.has(wake.runId)
    if (this.seen.has(wake.runId)) {
      await this.agent.ctx.sessions.flush(this.agent.session)
      return { accepted: true, duplicate: true }
    }
    if (!this.pending.has(wake.runId)) this.pending.set(wake.runId, wake)
    // Await the shared write barrier even for concurrent retries; an ACK is
    // never sent for a receipt whose earlier write has not finished.
    await this.persist()
    if (this.disposed) throw new Error('scheduler receiver is shutting down')
    this.startDelivery(this.pending.get(wake.runId) ?? wake)
    return { accepted: true, duplicate }
  }

  private startDelivery(wake: ScheduledWake): void {
    if (this.disposed || this.seen.has(wake.runId) || this.queued.has(wake.runId) || this.deliveries.has(wake.runId)) return
    const operation = (async () => {
      if (this.disposed || this.seen.has(wake.runId) || this.queued.has(wake.runId)) return
      // A restored native inbox may already contain this input. Requeue the
      // same input through the compaction gate to wake the idle driver without
      // duplicates. The receipt remains durable while a compaction holds it.
      for (const message of [...this.agent.inbox.nextTurn, ...this.agent.inbox.nextStep]) {
        if (runIdOf(message) === wake.runId) this.agent.inbox.remove(message.id)
      }
      const { prompt, ...source } = wake
      const notification = {
        type: 'scheduled-task-triggered',
        producer: 'console.scheduler',
        task: wake.task ?? { id: wake.taskId, ownerSessionId: wake.sessionId, title: wake.title, prompt, metadataAvailable: false },
        run: wake.run ?? { id: wake.runId, scheduledAt: wake.scheduledAt, trigger: 'unknown', triggeredAt: null },
      }
      enqueueOrFollowup(createUserMessage({
        content: [{ type: 'text', text: '[系统事件：定时任务触发]\n'
          + '这是 Console 调度器产生的运行时通知，不是用户刚刚发送的新消息。'
          + '请根据本次事件中的 task.prompt 处理任务；task 是触发时保存的任务信息，run 是本次运行信息。\n'
          + JSON.stringify(notification, null, 2) }],
        source: { kind: 'system-event', producer: 'console.scheduler', eventType: 'scheduled-task-triggered',
          form: 'notice', summary: boundContextSummary(`定时任务触发：${wake.title}`), ...source },
      }))
      this.queued.add(wake.runId)
      await this.agent.ctx.sessions.flush(this.agent.session)
    })()
    this.deliveries.set(wake.runId, operation)
    void operation.catch(error => console.warn('[scheduler] 任务输入仍待恢复:', error))
      .finally(() => this.deliveries.delete(wake.runId))
  }

  private persist(): Promise<void> {
    const data = JSON.stringify({ version: 1, receipts: [...this.pending.values()] })
    const operation = this.chain.catch(() => {}).then(async () => {
      await mkdir(this.dataDir, { recursive: true })
      const temp = `${this.path}.tmp`
      await writeFile(temp, data, 'utf8')
      await rename(temp, this.path)
    })
    this.chain = operation
    return operation
  }

  async dispose(): Promise<void> {
    this.disposed = true
    this.unsubscribe()
    await Promise.allSettled([...this.deliveries.values()])
    await this.chain
  }
}
