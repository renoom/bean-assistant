/** HTTP conversation channel with its own listener and SSE output. */
import type { ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { AssistantCapabilities, EncodedChatImage } from '../service/capabilities.js'
import type { AssistantEventHub } from '../service/event-hub.js'
import { HttpService, json, readJson } from '../service/http-service.js'
import type { Channel, ChannelConfig, ChannelEndpoint } from './types.js'
export { convertSessionEvent } from '../service/session-events.js'
export type { SSEFrame } from '../service/session-events.js'

export class HttpChannel implements Channel {
  readonly id = 'http'
  private readonly http: HttpService
  private readonly streams = new Set<ServerResponse>()
  private readonly eventDispose: () => void

  constructor(
    private readonly config: ChannelConfig,
    capabilities: AssistantCapabilities,
    events: AssistantEventHub,
  ) {
    this.http = new HttpService(config)
    this.http.registerRoute('POST', '/api/message', async (req, res) => {
      const limits = capabilities.config.attachments.imageLimits
      const body = await readJson(req, Math.ceil(limits.maxMessageImageBytes * 4 / 3) + 1024 * 1024)
      if (!body) { json(res, 400, { error: 'invalid JSON body' }); return }
      json(res, 200, await capabilities.chat({
        text: typeof body.text === 'string' ? body.text : '',
        images: Array.isArray(body.images) ? body.images as EncodedChatImage[] : [],
        clientId: typeof body.clientId === 'string' ? body.clientId : undefined,
      }))
    })
    this.http.registerRoute('GET', '/api/stream', (_req, res) => {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      })
      this.streams.add(res)
      res.write(`data: ${JSON.stringify({ type: 'connected', data: { channel: this.id } })}\n\n`)
      res.on('close', () => this.streams.delete(res))
    })
    this.eventDispose = events.subscribe(event => {
      for (const frame of [event.raw, event.readable]) {
        if (!frame) continue
        const payload = `data: ${JSON.stringify(frame)}\n\n`
        for (const stream of this.streams) stream.write(payload)
      }
    })
  }

  async start(): Promise<ChannelEndpoint> {
    await this.http.listen()
    return { id: this.id, protocol: 'http', host: this.config.host, port: (this.http.server.address() as AddressInfo).port, path: '/api/message' }
  }

  async dispose(): Promise<void> {
    this.eventDispose()
    for (const stream of this.streams) stream.end()
    this.streams.clear()
    await this.http.dispose()
  }
}
