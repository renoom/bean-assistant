/** Independently started assistant interaction endpoints. Management APIs are separate. */
export type ChannelId = string
export type ClientId = string
export type SendResult = { kind: 'accepted'; turn: number } | { kind: 'rejected'; reason: string }
export interface Channel {
  readonly id: ChannelId
  start(): Promise<ChannelEndpoint>
  dispose(): Promise<void>
}

export interface ChannelEndpoint {
  id: ChannelId
  protocol: 'http' | 'ws'
  host: string
  port: number
  path: string
}

export interface ChannelConfig {
  host: string
  /** Zero asks the OS to allocate an unused listener port. */
  port: number
}
