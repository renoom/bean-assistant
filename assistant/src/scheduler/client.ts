/** Console owns schedules; callers are always scoped to this assistant's identity. */
export type TaskSchedule =
  | { kind: 'once'; at: string }
  | { kind: 'interval'; everySeconds: number; startAt?: string }
  | { kind: 'daily'; time: string; timezone: string }

export interface SchedulerClientConfig {
  consoleUrl?: string
  sessionId: string
  apiKey?: string
}

export class SchedulerClient {
  constructor(private readonly config: SchedulerClientConfig) {}

  async request(method: string, path = '', body?: unknown): Promise<unknown> {
    if (!this.config.consoleUrl) throw new Error('未连接 Console，定时任务不可用')
    const base = this.config.consoleUrl.replace(/\/$/, '')
    const url = new URL(`${base}/api/scheduled-tasks${path}`)
    url.searchParams.set('creatorSessionId', this.config.sessionId)
    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    if (this.config.apiKey) headers.Authorization = `Bearer ${this.config.apiKey}`
    const response = await fetch(url, {
      method, headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(10_000),
    })
    const result = await response.json() as { error?: string }
    if (!response.ok) throw new Error(result.error || `任务接口 HTTP ${response.status}`)
    return result
  }

  create(title: string, prompt: string, schedule: TaskSchedule): Promise<unknown> {
    return this.request('POST', '', { creatorSessionId: this.config.sessionId, title, prompt, schedule })
  }
}
