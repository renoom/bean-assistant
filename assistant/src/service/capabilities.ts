/** Reusable assistant capabilities shared by HTTP, WebSocket and channels. */

import { readFile } from 'node:fs/promises'
import { basename, extname, resolve } from 'node:path'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { AttachmentStore, ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { decodeImageInput } from '../media/image-input.js'
import type { StageRegistry } from '../stage/manager.js'
import type { ChannelEndpoint } from '../channel/types.js'

export interface DshApi {
  settingsDescribe(): unknown
  providers(): unknown
  models(provider: string): Promise<unknown>
  resolveModel(provider: string, model: string): Promise<{ inputModalities?: readonly string[] }>
}

export interface EncodedChatImage {
  data: string
  mimeType?: string
  name?: string
}

export interface ChatInput {
  text?: string
  images?: EncodedChatImage[]
  clientId?: string
}

export interface AssistantCapabilitiesConfig {
  name: string
  attachments: AttachmentStore
  imagesDir?: string
  getRuntimeModel?: () => { provider?: string; model?: string } | undefined
  getObservability?: () => unknown
  dshApi?: DshApi
  onConfigPush?: (raw: unknown) => Promise<void>
  getChannelEndpoints?: () => readonly ChannelEndpoint[]
  getMemoryStatus?: () => unknown
  getPermissions?: () => unknown
  onScheduledWake?: (input: unknown) => Promise<{ accepted: true; duplicate: boolean }>
}

export class AssistantCapabilities {
  constructor(
    readonly agent: Agent,
    readonly stages: StageRegistry,
    readonly config: AssistantCapabilitiesConfig,
  ) {}

  async chat(input: ChatInput): Promise<{ accepted: true; turn: number; attachments: ImageAttachmentRef[] }> {
    const text = typeof input.text === 'string' ? input.text.trim() : ''
    const rawImages = Array.isArray(input.images) ? input.images : []
    if (!text && rawImages.length === 0) throw new Error('text or images is required')
    const limits = this.config.attachments.imageLimits
    if (rawImages.length > limits.maxImagesPerMessage) {
      throw new Error(`too many images; maximum is ${limits.maxImagesPerMessage}`)
    }
    if (rawImages.length > 0) {
      const runtime = this.config.getRuntimeModel?.()
      if (!runtime?.provider || !runtime.model || !this.config.dshApi) {
        throw new Error('无法确认当前 DSH 模型的图片输入能力')
      }
      const modelInfo = await this.config.dshApi.resolveModel(runtime.provider, runtime.model)
      if (modelInfo.inputModalities && !modelInfo.inputModalities.includes('image')) {
        throw new Error(`当前模型 ${runtime.provider}/${runtime.model} 不支持图片输入；请先切换模型`)
      }
    }
    const decoded = rawImages.map((item, index) => {
      if (!item || typeof item !== 'object') throw new Error(`images[${index}] is invalid`)
      return { ...decodeImageInput(String(item.data ?? ''), item.mimeType), name: item.name }
    })
    if (decoded.reduce((sum, item) => sum + item.data.byteLength, 0) > limits.maxMessageImageBytes) {
      throw new Error('图片总大小超过当前 DSH 附件限制')
    }
    for (const image of decoded) await this.config.attachments.validateImage(image)
    const attachments: ImageAttachmentRef[] = []
    for (const image of decoded) attachments.push(await this.config.attachments.saveImage(image))
    const content: ContentBlock[] = []
    if (text) content.push({ type: 'text', text })
    content.push(...attachments.map(attachment => ({ type: 'image' as const, attachment })))
    const turn = this.stages.deliverUserContent(content)
    return { accepted: true, turn, attachments }
  }

  status(): Record<string, unknown> {
    const runtime = this.config.getRuntimeModel?.()
    return {
      name: this.config.name,
      status: this.agent.status,
      sessionId: String(this.agent.session.id),
      model: runtime?.model ?? this.agent.options.model ?? 'unknown',
      provider: runtime?.provider ?? this.agent.options.provider ?? 'unknown',
      maxTokens: this.agent.options.maxTokens,
      uptime: process.uptime(),
      eventCount: this.agent.session.events.length,
      stage: this.stages.snapshot(),
      channelEndpoints: this.config.getChannelEndpoints?.() ?? [],
      memory: this.config.getMemoryStatus?.(),
      permissions: this.config.getPermissions?.(),
    }
  }

  history(before = this.agent.session.events.length, limit = 100): Record<string, unknown> {
    const total = this.agent.session.events.length
    const end = Math.max(0, Math.min(Number.isFinite(before) ? Math.floor(before) : total, total))
    const start = Math.max(0, end - Math.min(Math.max(Number.isFinite(limit) ? Math.floor(limit) : 100, 1), 5000))
    return {
      events: this.agent.session.events.slice(start, end).map(serializeEvent),
      hasMore: start > 0,
      nextBefore: start,
      total,
      rangeStart: start,
      rangeEnd: end,
    }
  }

  observability(): unknown { return this.config.getObservability?.() ?? {} }

  async scheduledWake(input: unknown): Promise<{ accepted: true; duplicate: boolean }> {
    if (!this.config.onScheduledWake) throw new Error('scheduled wake receiver unavailable')
    return this.config.onScheduledWake(input)
  }

  async pushConfig(raw: unknown): Promise<void> {
    if (!this.config.onConfigPush) throw new Error('config push not available')
    await this.config.onConfigPush(raw)
  }

  async readGeneratedImage(name: string): Promise<{ data: Uint8Array; mediaType: string }> {
    if (!this.config.imagesDir) throw new Error('image serving not configured')
    const base = basename(name)
    if (!base || base !== name) throw new Error('invalid image name')
    const ext = extname(base).toLowerCase()
    const mediaType = ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg' : ext === '.webp' ? 'image/webp' : 'image/png'
    return { data: await readFile(resolve(this.config.imagesDir, base)), mediaType }
  }

  async readAttachment(id: string): Promise<{ data: Uint8Array; mediaType: string }> {
    const ref = findAttachment(this.agent.session.events, id)
    if (!ref) throw new Error('attachment not found in this session')
    const stored = await this.config.attachments.readImage(ref)
    return { data: stored.data, mediaType: stored.ref.mediaType }
  }
}

function serializeEvent(event: SessionEvent): Record<string, unknown> {
  return { type: event.type, seq: (event as any).seq, time: (event as any).time, data: (event as any).data }
}

function findAttachment(events: readonly SessionEvent[], attachmentId: string): ImageAttachmentRef | undefined {
  const visit = (value: unknown): ImageAttachmentRef | undefined => {
    if (Array.isArray(value)) {
      for (const item of value) {
        const found = visit(item)
        if (found) return found
      }
      return undefined
    }
    if (typeof value !== 'object' || value === null) return undefined
    const object = value as Record<string, unknown>
    if (object.type === 'image' && typeof object.attachment === 'object' && object.attachment !== null) {
      const ref = object.attachment as unknown as ImageAttachmentRef
      if (String(ref.attachmentId) === attachmentId) return ref
    }
    for (const child of Object.values(object)) {
      const found = visit(child)
      if (found) return found
    }
    return undefined
  }
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const found = visit(events[index])
    if (found) return found
  }
  return undefined
}
