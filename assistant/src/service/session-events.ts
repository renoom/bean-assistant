import type { SessionEvent } from '@deepseek-ai/dsh-session'

export interface SSEFrame {
  type: string
  data: unknown
}

export function convertSessionEvent(event: SessionEvent): SSEFrame | null {
  switch (event.type) {
    case 'turn/start':
      return { type: 'turn_start', data: { turn: (event as any).data.turn } }
    case 'turn/end':
      return { type: 'turn_end', data: { turn: (event as any).data.turn, reason: (event as any).data.reason } }
    case 'step/start':
      return { type: 'step_start', data: { turn: (event as any).data.turn, step: (event as any).data.step } }
    case 'step/end':
      return { type: 'step_end', data: { turn: (event as any).data.turn, step: (event as any).data.step } }
    case 'assistant/chunk': {
      const chunk = (event as any).data?.chunk
      if (!chunk) return null
      return { type: 'chunk', data: { kind: chunk.type, text: chunk.text, index: chunk.index } }
    }
    case 'assistant/message':
      return { type: 'assistant_message', data: {
        turn: (event as any).data?.turn,
        step: (event as any).data?.step,
        message: (event as any).data?.message,
        usage: (event as any).data?.usage ?? (event as any).data?.message?.usage,
      } }
    case 'tool/call':
      return { type: 'tool_call', data: { turn: (event as any).data?.turn, step: (event as any).data?.step, callId: (event as any).data?.callId, name: (event as any).data?.name, arguments: (event as any).data?.arguments } }
    case 'tool/result':
      return { type: 'tool_result', data: {
        turn: (event as any).data?.turn,
        step: (event as any).data?.step,
        callId: (event as any).data?.callId ?? (event as any).data?.message?.source?.callId,
        name: (event as any).data?.name,
        ...extractToolResult((event as any).data),
      } }
    case 'user/message': {
      const data = (event as any).data ?? {}
      const source = data.source ?? {}
      const text = contentText(data.content)
      if (source.kind === 'stage-event' || source.kind === 'event') {
        return { type: 'scene_event', data: { text, source, turn: data.turn } }
      }
      // Session uses UserMessage as its transport container.  These two sources
      // are produced by the scheduler, so clients must not present them as a
      // person speaking merely because the underlying event is user/message.
      if (source.kind === 'system-event' || source.kind === 'scheduled-task') {
        return {
          type: 'system_event',
          data: {
            text,
            content: data.content ?? [],
            source,
            turn: data.turn,
            eventType: source.eventType,
          },
        }
      }
      return { type: 'model_input', data: { text, content: data.content ?? [], source, turn: data.turn } }
    }
    default:
      return null
  }
}

function contentText(content: unknown): string {
  if (!Array.isArray(content)) return ''
  return content.flatMap((block: any) => {
    if (block?.type === 'text' || block?.type === 'reasoning') return typeof block.text === 'string' ? [block.text] : []
    if (block?.type === 'tool-result') return [contentText(block.content)]
    if (block?.type === 'image') return ['[图片]']
    return []
  }).filter(Boolean).join('\n')
}

function extractToolResult(data: any): { isError: boolean; content: unknown; text: string } {
  const blocks = Array.isArray(data?.message?.content) ? data.message.content : []
  const result = blocks.find((block: any) => block?.type === 'tool-result')
  const content = result?.content ?? data?.content ?? []
  return {
    isError: Boolean(result?.isError ?? data?.isError ?? data?.error),
    content,
    text: contentText(content),
  }
}
