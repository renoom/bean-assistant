import assert from 'node:assert/strict'
import test from 'node:test'
import { createUserMessage, type MessageSource } from '@deepseek-ai/dsh-llm'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type {} from '../scheduler/wake.js'
import { convertSessionEvent } from './session-events.js'

function convert(source: MessageSource) {
  const message = createUserMessage({ content: [{ type: 'text', text: 'event payload' }], source })
  return convertSessionEvent({ type: 'user/message', data: message } as SessionEvent)
}

const identity = { sessionId: 'owner', taskId: 'task', runId: 'run', title: '检查任务', scheduledAt: '2026-10-11T09:00:00+08:00' }

test('scheduler notice is a system event with its source and model-visible content intact', () => {
  const source: MessageSource = { kind: 'system-event', producer: 'console.scheduler',
    eventType: 'scheduled-task-triggered', form: 'notice', summary: '定时任务触发：检查任务', ...identity }
  const frame = convert(source)
  assert.equal(frame?.type, 'system_event')
  const data = frame!.data as { source: MessageSource; text: string; eventType: string }
  assert.deepEqual(data.source, source)
  assert.equal(data.eventType, 'scheduled-task-triggered')
  assert.equal(data.text, 'event payload')
})

test('old scheduled-task history is classified as a system event', () => {
  assert.equal(convert({ kind: 'scheduled-task', ...identity })?.type, 'system_event')
})

test('human input and Godot scene events keep distinct semantics', () => {
  assert.equal(convert({ kind: 'user' })?.type, 'model_input')
  assert.equal(convert({ kind: 'stage-event', stageId: 'town', bridgeId: 'bridge', participantId: 'godot' })?.type, 'scene_event')
  assert.equal(convert({ kind: 'plugin', plugin: 'other-plugin' })?.type, 'model_input')
})
