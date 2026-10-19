export type TaskSchedule =
  | { kind: 'once'; at: string }
  | { kind: 'interval'; everySeconds: number; startAt?: string }
  | { kind: 'daily'; time: string; timezone: string }

export type TaskOutcome = 'pending' | 'delivered' | 'retrying'
export type RunTrigger = 'scheduled' | 'manual'
export type RunStatus = 'pending' | 'in_flight' | 'delivered'

export interface ScheduledTask {
  id: string
  ownerSessionId: string
  creatorName: string
  title: string
  prompt: string
  schedule: TaskSchedule
  enabled: boolean
  nextRunAt: string | null
  lastOutcome: TaskOutcome | null
  lastError: string | null
  createdAt: string
  updatedAt: string
  completedAt: string | null
}

export interface TaskRun {
  id: string
  taskId: string
  trigger: RunTrigger
  scheduledAt: string
  status: RunStatus
  attemptCount: number
  lastAttemptAt: string | null
  nextAttemptAt: string
  deliveredAt: string | null
  lastError: string | null
  createdAt: string
  /** The task as it was when this run was created, retained for retries. */
  taskSnapshot: ScheduledTask | null
}

export interface CreateTaskInput {
  ownerSessionId: string
  creatorName: string
  title: string
  prompt: string
  schedule: TaskSchedule
}

export interface UpdateTaskInput {
  title?: string
  prompt?: string
  schedule?: TaskSchedule
  enabled?: boolean
}
