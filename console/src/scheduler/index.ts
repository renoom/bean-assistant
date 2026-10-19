import { randomUUID } from 'node:crypto'
import { DatabaseSync, type SQLInputValue } from 'node:sqlite'
import type { Registry } from '../registry.ts'
import { nextRunAtForSchedule, validateSchedule } from './schedule.ts'
import type {
  CreateTaskInput,
  RunTrigger,
  ScheduledTask,
  TaskRun,
  TaskSchedule,
  UpdateTaskInput,
} from './types.ts'

export * from './types.ts'
export { nextRunAtForSchedule, validateSchedule } from './schedule.ts'

export interface TaskSchedulerOptions {
  path: string
  registry: Registry
  tickMs?: number
  retryMs?: number
  autoStart?: boolean
  fetchFn?: typeof fetch
}

type SqlRow = Record<string, unknown>

export class TaskScheduler {
  private readonly db: DatabaseSync
  private readonly registry: Registry
  private readonly retryMs: number
  private readonly fetchFn: typeof fetch
  private readonly timer?: NodeJS.Timeout
  private readonly abortControllers = new Set<AbortController>()
  private activeTick: Promise<void> | null = null
  private disposed = false

  constructor(options: TaskSchedulerOptions) {
    this.registry = options.registry
    this.retryMs = options.retryMs ?? 5_000
    this.fetchFn = options.fetchFn ?? fetch
    this.db = new DatabaseSync(options.path)
    this.initialize()
    if (options.autoStart !== false) {
      this.timer = setInterval(() => {
        void this.tick().catch(error => console.warn('[scheduler] tick failed:', errorMessage(error)))
      }, options.tickMs ?? 1_000)
      this.timer.unref?.()
    }
  }

  listTasks(ownerSessionId?: string): ScheduledTask[] {
    const rows = ownerSessionId === undefined
      ? this.db.prepare('SELECT * FROM tasks ORDER BY created_at DESC').all()
      : this.db.prepare('SELECT * FROM tasks WHERE owner_session_id = ? ORDER BY created_at DESC').all(ownerSessionId)
    return rows.map(row => taskFromRow(row as SqlRow))
  }

  getTask(id: string, ownerSessionId?: string): ScheduledTask | null {
    const row = ownerSessionId === undefined
      ? this.db.prepare('SELECT * FROM tasks WHERE id = ?').get(id)
      : this.db.prepare('SELECT * FROM tasks WHERE id = ? AND owner_session_id = ?').get(id, ownerSessionId)
    return row ? taskFromRow(row as SqlRow) : null
  }

  createTask(input: CreateTaskInput, now: Date = new Date()): ScheduledTask {
    const schedule = validateSchedule(input.schedule)
    const ownerSessionId = requiredText(input.ownerSessionId, 'ownerSessionId', 200)
    const creatorName = requiredText(input.creatorName, 'creatorName', 200)
    const title = requiredText(input.title, 'title', 200)
    const prompt = requiredText(input.prompt, 'prompt', 20_000)
    const createdAt = now.toISOString()
    const id = randomUUID()
    const nextRunAt = nextRunAtForSchedule(schedule, now)
    this.db.prepare(`
      INSERT INTO tasks (
        id, owner_session_id, creator_name, title, prompt, schedule_json,
        enabled, next_run_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?)
    `).run(id, ownerSessionId, creatorName, title, prompt, JSON.stringify(schedule), nextRunAt, createdAt, createdAt)
    return this.getRequiredTask(id)
  }

  updateTask(id: string, patch: UpdateTaskInput, ownerSessionId?: string, now: Date = new Date()): ScheduledTask | null {
    const current = this.getTask(id, ownerSessionId)
    if (!current) return null
    const fields: string[] = []
    const values: SQLInputValue[] = []
    if (patch.title !== undefined) { fields.push('title = ?'); values.push(requiredText(patch.title, 'title', 200)) }
    if (patch.prompt !== undefined) { fields.push('prompt = ?'); values.push(requiredText(patch.prompt, 'prompt', 20_000)) }

    let schedule = current.schedule
    let nextRunAtUpdate: string | null | undefined
    if (patch.schedule !== undefined) {
      schedule = validateSchedule(patch.schedule)
      fields.push('schedule_json = ?'); values.push(JSON.stringify(schedule))
      nextRunAtUpdate = current.enabled ? nextRunAtForSchedule(schedule, now) : null
      fields.push('completed_at = NULL')
      this.db.prepare("DELETE FROM runs WHERE task_id = ? AND trigger = 'scheduled' AND status = 'pending'").run(id)
    }

    if (patch.enabled !== undefined && patch.enabled !== current.enabled) {
      fields.push('enabled = ?'); values.push(patch.enabled ? 1 : 0)
      fields.push('completed_at = NULL')
      if (!patch.enabled) {
        nextRunAtUpdate = null
      } else {
        const pending = this.db.prepare(`
          SELECT scheduled_at FROM runs
          WHERE task_id = ? AND trigger = 'scheduled' AND status = 'pending'
          ORDER BY created_at LIMIT 1
        `).get(id) as SqlRow | undefined
        nextRunAtUpdate = pending ? String(pending.scheduled_at) : nextRunAtForSchedule(schedule, now)
      }
    }

    if (nextRunAtUpdate !== undefined) {
      fields.push('next_run_at = ?'); values.push(nextRunAtUpdate)
    }
    if (fields.length === 0) return current
    fields.push('updated_at = ?'); values.push(now.toISOString())
    values.push(id)
    this.db.prepare(`UPDATE tasks SET ${fields.join(', ')} WHERE id = ?`).run(...values)
    return this.getRequiredTask(id)
  }

  deleteTask(id: string, ownerSessionId?: string): boolean {
    const result = ownerSessionId === undefined
      ? this.db.prepare('DELETE FROM tasks WHERE id = ?').run(id)
      : this.db.prepare('DELETE FROM tasks WHERE id = ? AND owner_session_id = ?').run(id, ownerSessionId)
    return result.changes > 0
  }

  listRuns(taskId: string, ownerSessionId?: string): TaskRun[] | null {
    if (!this.getTask(taskId, ownerSessionId)) return null
    return this.db.prepare('SELECT * FROM runs WHERE task_id = ? ORDER BY created_at DESC').all(taskId)
      .map(row => runFromRow(row as SqlRow))
  }

  async runTaskNow(taskId: string, ownerSessionId?: string, now: Date = new Date()): Promise<TaskRun | null> {
    if (!this.getTask(taskId, ownerSessionId)) return null
    const run = this.insertRun(taskId, 'manual', now.toISOString(), now.toISOString())
    await this.tick(now)
    return this.getRun(run.id)
  }

  async tick(now: Date = new Date()): Promise<void> {
    if (this.disposed) return
    if (this.activeTick) return this.activeTick
    const active = this.performTick(now)
    this.activeTick = active
    try {
      await active
    } finally {
      if (this.activeTick === active) this.activeTick = null
    }
  }

  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    if (this.timer) clearInterval(this.timer)
    for (const controller of this.abortControllers) controller.abort()
    if (this.activeTick) await this.activeTick.catch(() => {})
    this.db.prepare("UPDATE runs SET status = 'pending' WHERE status = 'in_flight'").run()
    this.db.close()
  }

  private initialize(): void {
    this.db.exec('PRAGMA foreign_keys = ON')
    this.db.exec('PRAGMA busy_timeout = 5000')
    this.db.exec('PRAGMA journal_mode = WAL')
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        owner_session_id TEXT NOT NULL,
        creator_name TEXT NOT NULL,
        title TEXT NOT NULL,
        prompt TEXT NOT NULL,
        schedule_json TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        next_run_at TEXT,
        last_outcome TEXT,
        last_error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        completed_at TEXT
      );
      CREATE TABLE IF NOT EXISTS runs (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        trigger TEXT NOT NULL,
        scheduled_at TEXT NOT NULL,
        status TEXT NOT NULL,
        attempt_count INTEGER NOT NULL DEFAULT 0,
        last_attempt_at TEXT,
        next_attempt_at TEXT NOT NULL,
        delivered_at TEXT,
        last_error TEXT,
        created_at TEXT NOT NULL,
        task_snapshot_json TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_tasks_due ON tasks(enabled, next_run_at);
      CREATE INDEX IF NOT EXISTS idx_runs_pending ON runs(status, next_attempt_at);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_runs_scheduled_once
        ON runs(task_id, scheduled_at) WHERE trigger = 'scheduled';
    `)
    // Existing scheduler databases predate per-run task snapshots. Adding a nullable
    // column keeps their run history intact; legacy runs are backfilled on delivery.
    const runColumns = this.db.prepare('PRAGMA table_info(runs)').all() as SqlRow[]
    if (!runColumns.some(column => String(column.name) === 'task_snapshot_json')) {
      this.db.exec('ALTER TABLE runs ADD COLUMN task_snapshot_json TEXT')
    }
    // A process may stop after claiming but before receiving a response. The same run id is retried.
    this.db.prepare("UPDATE runs SET status = 'pending' WHERE status = 'in_flight'").run()
  }

  private async performTick(now: Date): Promise<void> {
    const nowIso = now.toISOString()
    this.createDueRuns(nowIso)
    while (!this.disposed) {
      const run = this.claimNextRun(nowIso)
      if (!run) break
      await this.deliver(run, now)
    }
  }

  private createDueRuns(nowIso: string): void {
    this.transaction(() => {
      const due = this.db.prepare(`
        SELECT id, next_run_at FROM tasks
        WHERE enabled = 1 AND next_run_at IS NOT NULL AND next_run_at <= ?
        ORDER BY next_run_at
      `).all(nowIso) as SqlRow[]
      const active = this.db.prepare(`
        SELECT 1 FROM runs
        WHERE task_id = ? AND trigger = 'scheduled' AND status IN ('pending', 'in_flight') LIMIT 1
      `)
      for (const task of due) {
        const taskId = String(task.id)
        if (active.get(taskId)) continue
        const scheduledAt = String(task.next_run_at)
        this.insertRun(taskId, 'scheduled', scheduledAt, nowIso)
        this.db.prepare(`
          UPDATE tasks SET last_outcome = 'pending', last_error = NULL, updated_at = ? WHERE id = ?
        `).run(nowIso, taskId)
      }
    })
  }

  private claimNextRun(nowIso: string): TaskRun | null {
    return this.transaction(() => {
      const row = this.db.prepare(`
        SELECT r.* FROM runs r
        JOIN tasks t ON t.id = r.task_id
        WHERE r.status = 'pending' AND r.next_attempt_at <= ?
          AND (r.trigger = 'manual' OR t.enabled = 1)
          AND NOT EXISTS (
            SELECT 1 FROM runs other
            WHERE other.task_id = r.task_id AND other.status = 'in_flight'
          )
        ORDER BY r.next_attempt_at, r.created_at LIMIT 1
      `).get(nowIso) as SqlRow | undefined
      if (!row) return null
      const result = this.db.prepare(`
        UPDATE runs SET status = 'in_flight', attempt_count = attempt_count + 1, last_attempt_at = ?
        WHERE id = ? AND status = 'pending'
      `).run(nowIso, String(row.id))
      return result.changes === 1 ? this.getRequiredRun(String(row.id)) : null
    })
  }

  private async deliver(run: TaskRun, now: Date): Promise<void> {
    const currentTask = this.getTask(run.taskId)
    if (!currentTask) return
    const task = run.taskSnapshot ?? this.persistLegacySnapshot(run.id, currentTask)
    const assistant = this.registry.findBySessionId(task.ownerSessionId)
    if (!assistant || assistant.status !== 'online') {
      this.retry(run.id, task.id, 'assistant is offline', now)
      return
    }

    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 5_000)
    this.abortControllers.add(controller)
    try {
      const host = assistant.host === '0.0.0.0' || assistant.host === '::' ? '127.0.0.1' : assistant.host
      const response = await this.fetchFn(`http://${host}:${assistant.port}/api/scheduler/wake`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sessionId: task.ownerSessionId,
          taskId: task.id,
          runId: run.id,
          title: task.title,
          prompt: task.prompt,
          scheduledAt: run.scheduledAt,
          task,
          run: {
            id: run.id,
            trigger: run.trigger,
            scheduledAt: run.scheduledAt,
            triggeredAt: run.createdAt,
          },
        }),
        signal: controller.signal,
      })
      const payload = await response.json().catch(() => ({})) as { accepted?: boolean }
      if (!response.ok || payload.accepted !== true) {
        throw new Error(`wake rejected (HTTP ${response.status})`)
      }
      this.complete(run, task, now)
    } catch (error) {
      this.retry(run.id, task.id, errorMessage(error), now)
    } finally {
      clearTimeout(timeout)
      this.abortControllers.delete(controller)
    }
  }

  private complete(run: TaskRun, originalTask: ScheduledTask, now: Date): void {
    const nowIso = now.toISOString()
    this.transaction(() => {
      const result = this.db.prepare(`
        UPDATE runs SET status = 'delivered', delivered_at = ?, next_attempt_at = ?, last_error = NULL
        WHERE id = ? AND status = 'in_flight'
      `).run(nowIso, nowIso, run.id)
      if (result.changes !== 1) return
      if (run.trigger === 'manual') {
        this.db.prepare(`
          UPDATE tasks SET last_outcome = 'delivered', last_error = NULL, updated_at = ? WHERE id = ?
        `).run(nowIso, run.taskId)
        return
      }

      // A pause, delete or schedule edit made while the request was in flight wins.
      const current = this.getTask(run.taskId)
      if (!current) return
      if (!current.enabled || current.nextRunAt !== run.scheduledAt) {
        this.db.prepare(`
          UPDATE tasks SET last_outcome = 'delivered', last_error = NULL, updated_at = ? WHERE id = ?
        `).run(nowIso, run.taskId)
        return
      }
      if (current.schedule.kind === 'once') {
        this.db.prepare(`
          UPDATE tasks SET enabled = 0, next_run_at = NULL, last_outcome = 'delivered',
            last_error = NULL, updated_at = ?, completed_at = ? WHERE id = ?
        `).run(nowIso, nowIso, run.taskId)
        return
      }
      const next = nextRunAtForSchedule(current.schedule, now, run.scheduledAt)
      this.db.prepare(`
        UPDATE tasks SET next_run_at = ?, last_outcome = 'delivered', last_error = NULL,
          updated_at = ?, completed_at = NULL WHERE id = ?
      `).run(next, nowIso, run.taskId)
    })
  }

  private retry(runId: string, taskId: string, error: string, now: Date): void {
    const nowIso = now.toISOString()
    const nextAttempt = new Date(now.getTime() + this.retryMs).toISOString()
    this.transaction(() => {
      this.db.prepare(`
        UPDATE runs SET status = 'pending', next_attempt_at = ?, last_error = ?
        WHERE id = ? AND status = 'in_flight'
      `).run(nextAttempt, error, runId)
      this.db.prepare(`
        UPDATE tasks SET last_outcome = 'retrying', last_error = ?, updated_at = ? WHERE id = ?
      `).run(error, nowIso, taskId)
    })
  }

  private insertRun(taskId: string, trigger: RunTrigger, scheduledAt: string, createdAt: string): TaskRun {
    const id = randomUUID()
    const task = this.getRequiredTask(taskId)
    this.db.prepare(`
      INSERT INTO runs (
        id, task_id, trigger, scheduled_at, status, next_attempt_at, created_at, task_snapshot_json
      ) VALUES (?, ?, ?, ?, 'pending', ?, ?, ?)
    `).run(id, taskId, trigger, scheduledAt, createdAt, createdAt, JSON.stringify(task))
    return this.getRequiredRun(id)
  }

  private persistLegacySnapshot(runId: string, task: ScheduledTask): ScheduledTask {
    const snapshotJson = JSON.stringify(task)
    this.db.prepare(`
      UPDATE runs SET task_snapshot_json = ?
      WHERE id = ? AND task_snapshot_json IS NULL
    `).run(snapshotJson, runId)
    return this.getRequiredRun(runId).taskSnapshot ?? task
  }

  private getRun(id: string): TaskRun | null {
    const row = this.db.prepare('SELECT * FROM runs WHERE id = ?').get(id)
    return row ? runFromRow(row as SqlRow) : null
  }

  private getRequiredRun(id: string): TaskRun {
    const run = this.getRun(id)
    if (!run) throw new Error(`task run disappeared: ${id}`)
    return run
  }

  private getRequiredTask(id: string): ScheduledTask {
    const task = this.getTask(id)
    if (!task) throw new Error(`scheduled task disappeared: ${id}`)
    return task
  }

  private transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const result = fn()
      this.db.exec('COMMIT')
      return result
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }
}

function taskFromRow(row: SqlRow): ScheduledTask {
  return {
    id: String(row.id),
    ownerSessionId: String(row.owner_session_id),
    creatorName: String(row.creator_name),
    title: String(row.title),
    prompt: String(row.prompt),
    schedule: JSON.parse(String(row.schedule_json)) as TaskSchedule,
    enabled: Number(row.enabled) === 1,
    nextRunAt: nullableString(row.next_run_at),
    lastOutcome: nullableString(row.last_outcome) as ScheduledTask['lastOutcome'],
    lastError: nullableString(row.last_error),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    completedAt: nullableString(row.completed_at),
  }
}

function runFromRow(row: SqlRow): TaskRun {
  return {
    id: String(row.id),
    taskId: String(row.task_id),
    trigger: String(row.trigger) as TaskRun['trigger'],
    scheduledAt: String(row.scheduled_at),
    status: String(row.status) as TaskRun['status'],
    attemptCount: Number(row.attempt_count),
    lastAttemptAt: nullableString(row.last_attempt_at),
    nextAttemptAt: String(row.next_attempt_at),
    deliveredAt: nullableString(row.delivered_at),
    lastError: nullableString(row.last_error),
    createdAt: String(row.created_at),
    taskSnapshot: taskSnapshotFromRow(row.task_snapshot_json),
  }
}

function taskSnapshotFromRow(value: unknown): ScheduledTask | null {
  if (typeof value !== 'string' || !value) return null
  try {
    return JSON.parse(value) as ScheduledTask
  } catch {
    return null
  }
}

function nullableString(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value)
}

function requiredText(value: unknown, field: string, maxLength: number): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${field} is required`)
  const normalized = value.trim()
  if (normalized.length > maxLength) throw new Error(`${field} must be at most ${maxLength} characters`)
  return normalized
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
