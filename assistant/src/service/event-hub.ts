import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionEvent, SessionId } from '@deepseek-ai/dsh-session'
import { convertSessionEvent, type SSEFrame } from './session-events.js'

export interface AssistantEvent {
  raw: Record<string, unknown>
  readable: SSEFrame | null
}

export class AssistantEventHub {
  private readonly listeners = new Set<(event: AssistantEvent) => void>()
  private readonly disposeEvent: () => void

  constructor(agent: Agent) {
    this.disposeEvent = agent.ctx.on('session/event', (session: { id: SessionId }, event: SessionEvent) => {
      if (session.id !== agent.session.id) return
      const value: AssistantEvent = {
        raw: {
          type: 'session_event',
          data: { type: event.type, seq: (event as any).seq, time: (event as any).time, data: (event as any).data },
        },
        readable: convertSessionEvent(event),
      }
      for (const listener of this.listeners) listener(value)
    })
  }

  subscribe(listener: (event: AssistantEvent) => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  emit(frame: SSEFrame): void {
    const event = { raw: frame as unknown as Record<string, unknown>, readable: null }
    for (const listener of this.listeners) listener(event)
  }

  dispose(): void {
    this.disposeEvent()
    this.listeners.clear()
  }
}
