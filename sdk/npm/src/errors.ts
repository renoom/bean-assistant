/**
 * Error types thrown by the StageChannel SDK.
 *
 * All errors extend {@link StageChannelError}; each one carries a stable
 * `code` string so callers can branch without matching messages.
 *
 * @module stage-channel-sdk/errors
 */

/** Options shared by every SDK error. */
export interface StageChannelErrorOptions {
  /** Stable machine-readable code; defaults to the subclass code. */
  code?: string
  /** Underlying cause (for example a socket or fetch error). */
  cause?: unknown
}

/** Base class for every error thrown by this SDK. */
export class StageChannelError extends Error {
  readonly code: string

  constructor(message: string, options: StageChannelErrorOptions = {}) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined)
    this.name = 'StageChannelError'
    this.code = options.code ?? 'ERR_STAGE_CHANNEL'
  }
}

/** The platform has no global `WebSocket` (Node < 22 / unsupported runtime). */
export class WebSocketUnavailableError extends StageChannelError {
  constructor(message = 'global WebSocket is not available; pass options.webSocketFactory or run Node >= 22', options: StageChannelErrorOptions = {}) {
    super(message, { ...options, code: options.code ?? 'ERR_WEBSOCKET_UNAVAILABLE' })
    this.name = 'WebSocketUnavailableError'
  }
}

/** The handshake did not finish within `connectTimeoutMs` (default 30s). */
export class HandshakeTimeoutError extends StageChannelError {
  /** Handshake phase the client was stuck in: hello / register / activate. */
  readonly phase?: string

  constructor(message: string, options: StageChannelErrorOptions & { phase?: string } = {}) {
    super(message, { ...options, code: options.code ?? 'ERR_HANDSHAKE_TIMEOUT' })
    this.name = 'HandshakeTimeoutError'
    this.phase = options.phase
  }
}

/** The WebSocket closed before the request completed. */
export class ConnectionClosedError extends StageChannelError {
  /** WebSocket close code, when the peer supplied one. */
  readonly closeCode?: number
  /** WebSocket close reason, when the peer supplied one. */
  readonly closeReason?: string

  constructor(message: string, options: StageChannelErrorOptions & { closeCode?: number; closeReason?: string } = {}) {
    super(message, { ...options, code: options.code ?? 'ERR_CONNECTION_CLOSED' })
    this.name = 'ConnectionClosedError'
    this.closeCode = options.closeCode
    this.closeReason = options.closeReason
  }
}

/**
 * The server closed the connection because another connection reused the same
 * `clientId`. Always close code **4001** (reason `clientId replaced by a new
 * connection`).
 */
export class ClientReplacedError extends ConnectionClosedError {
  constructor(message = 'clientId replaced by a new connection', options: StageChannelErrorOptions & { closeCode?: number; closeReason?: string } = {}) {
    super(message, {
      ...options,
      code: options.code ?? 'ERR_CLIENT_REPLACED',
      closeCode: options.closeCode ?? 4001,
    })
    this.name = 'ClientReplacedError'
  }
}

/** A request (register / activate / chat / …) timed out waiting for its result. */
export class RequestTimeoutError extends StageChannelError {
  /** Request id that never received a result. */
  readonly requestId?: string

  constructor(message: string, options: StageChannelErrorOptions & { requestId?: string } = {}) {
    super(message, { ...options, code: options.code ?? 'ERR_REQUEST_TIMEOUT' })
    this.name = 'RequestTimeoutError'
    this.requestId = options.requestId
  }
}

/** The server answered with an `error` frame. */
export class StageServerError extends StageChannelError {
  /** Server error message (same as `message`). */
  readonly serverError: string
  /** Request id the server attributed the error to, when present. */
  readonly requestId?: string

  constructor(serverError: string, options: StageChannelErrorOptions & { requestId?: string } = {}) {
    super(serverError, { ...options, code: options.code ?? 'ERR_STAGE_SERVER' })
    this.name = 'StageServerError'
    this.serverError = serverError
    this.requestId = options.requestId
  }
}

/** The console discovery request failed (network, HTTP status, invalid body). */
export class DiscoveryError extends StageChannelError {
  /** HTTP status code, when the failure came from a response. */
  readonly status?: number
  /** URL that was requested. */
  readonly url?: string

  constructor(message: string, options: StageChannelErrorOptions & { status?: number; url?: string } = {}) {
    super(message, { ...options, code: options.code ?? 'ERR_DISCOVERY' })
    this.name = 'DiscoveryError'
    this.status = options.status
    this.url = options.url
  }
}

/** A protocol invariant was violated (bad frame, invalid arguments, …). */
export class ProtocolError extends StageChannelError {
  constructor(message: string, options: StageChannelErrorOptions = {}) {
    super(message, { ...options, code: options.code ?? 'ERR_PROTOCOL' })
    this.name = 'ProtocolError'
  }
}

/** The operation needs an open WebSocket but the client is not connected. */
export class NotConnectedError extends StageChannelError {
  constructor(message = 'stage channel is not connected; call connect() first', options: StageChannelErrorOptions = {}) {
    super(message, { ...options, code: options.code ?? 'ERR_NOT_CONNECTED' })
    this.name = 'NotConnectedError'
  }
}
