import type { Context } from '@deepseek-ai/cordis'
import type { JsonValue } from '@deepseek-ai/dsh-session'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { SchedulerClient, type SchedulerClientConfig, type TaskSchedule } from './client.js'

const scheduleParameter = {
  type: 'object' as const,
  additionalProperties: false as const,
  description: '一次任务 {kind:"once",at:"含时区的 ISO 时间"}；周期任务 {kind:"interval",everySeconds:60或更大,startAt?:"ISO时间"}；每日任务 {kind:"daily",time:"HH:mm",timezone:"Asia/Shanghai"}。',
  properties: {
    kind: { type: 'string' as const, enum: ['once', 'interval', 'daily'] },
    at: { type: 'string' as const },
    everySeconds: { type: 'number' as const },
    startAt: { type: 'string' as const },
    time: { type: 'string' as const },
    timezone: { type: 'string' as const },
  },
}

/** Creator identity is supplied by deployment, never by model-generated arguments. */
export function registerSchedulerTools(ctx: Context, config: SchedulerClientConfig): void {
  const client = new SchedulerClient(config)
  const result = async (operation: () => Promise<unknown>): Promise<Record<string, JsonValue>> => {
    try { return { ok: true, data: await operation() as JsonValue } }
    catch (error) { return { ok: false, error: error instanceof Error ? error.message : String(error) } }
  }
  const output = {
    schema: { type: 'object' as const, additionalProperties: true as const },
    render: (_args: unknown, value: Record<string, unknown>) => [{
      type: 'text' as const,
      text: value.ok ? JSON.stringify(value.data, null, 2) : `任务操作失败：${value.error}`,
    }],
  }
  ctx.tools.register(defineTool({
    name: 'create_scheduled_task',
    description: '在 Console 创建定时任务。到期只会向你当前的同一会话发送 prompt，之后由你执行。支持一次、按间隔和每日任务，重启后仍保留。创建人自动绑定为你，不可更改；默认时区 Asia/Shanghai。',
    parameters: {
      title: { type: 'string', required: true, description: '任务名称' },
      prompt: { type: 'string', required: true, description: '到期交给自己执行的完整指令，含必要上下文' },
      schedule: { ...scheduleParameter, required: true },
    },
    output,
    execute: args => result(() => client.create(args.title, args.prompt, args.schedule as TaskSchedule)),
  }))
  ctx.tools.register(defineTool({
    name: 'list_scheduled_tasks',
    description: '查询你创建的定时任务、启用状态、下次唤醒时间与投递结果。已唤醒只代表输入已被接收，不代表任务已执行完成。',
    parameters: {}, output,
    execute: () => result(() => client.request('GET')),
  }))
  ctx.tools.register(defineTool({
    name: 'update_scheduled_task',
    description: '修改自己创建的定时任务，或用 enabled:false 暂停、enabled:true 恢复；创建人和唤醒对象保持不变。',
    parameters: {
      id: { type: 'string', required: true, description: '任务 ID' },
      title: { type: 'string' }, prompt: { type: 'string' },
      schedule: scheduleParameter, enabled: { type: 'boolean' },
    },
    output,
    execute: args => result(() => {
      const { id, ...patch } = args
      return client.request('PATCH', `/${encodeURIComponent(id)}`, patch)
    }),
  }))
  ctx.tools.register(defineTool({
    name: 'delete_scheduled_task',
    description: '删除自己创建的定时任务，停止后续唤醒。已交给助手的输入不能通过删除任务撤回。',
    parameters: { id: { type: 'string', required: true, description: '任务 ID' } }, output,
    execute: args => result(() => client.request('DELETE', `/${encodeURIComponent(args.id)}`)),
  }))
  ctx.tools.register(defineTool({
    name: 'scheduled_task_runs',
    description: '查询自己创建的任务的投递记录，包括等待、重试原因及已唤醒记录。',
    parameters: { id: { type: 'string', required: true, description: '任务 ID' } }, output,
    execute: args => result(() => client.request('GET', `/${encodeURIComponent(args.id)}/runs`)),
  }))
}
