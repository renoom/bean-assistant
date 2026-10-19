# stage-channel-sdk

TypeScript / Node client SDK for the **StageChannel** protocol (v1).

The protocol lets a client (game, glasses app, web page…) declare a *stage* and
its *commands*, activate it, report scene events, receive assistant commands and
the assistant's LLM event stream over one WebSocket connection.

- Zero runtime dependencies; uses the global `WebSocket` and `fetch` (Node ≥ 22 and modern browsers).
- Console **gateway mode** (`wss://console/a/{sessionId}/ws?api_key=…`) and
  **direct mode** (`ws://host:port/ws`) are both supported.
- Full handshake state machine with a 30 s timeout, tolerant decoding (unknown
  frame types/fields are ignored), automatic `ok:false` for commands addressed to
  another stage, and close code **4001** (`clientId` replaced) surfaced as a
  typed error.
- `webSocketFactory` and `fetch` can be injected for tests.

Protocol source of truth: [`sdk/spec/protocol.md`](../spec/protocol.md) and
[`sdk/spec/fixtures/`](../spec/fixtures/).

## Installation

```bash
npm install stage-channel-sdk
```

Requirements:

- **Node.js ≥ 22** (global `WebSocket` and `fetch`), or
- a modern browser (global `WebSocket` and `fetch`), or
- inject `webSocketFactory` / `fetch` on older runtimes.

## Quick start (browser / Node)

```ts
import {
  fetchAssistants,
  buildGatewayWsUrl,
  StageChannelClient,
} from 'stage-channel-sdk'

// 1. Discover an online assistant that exposes the stage channel.
const [assistant] = await fetchAssistants({
  baseUrl: 'https://console.example.com',
  apiKey: process.env.STAGE_API_KEY!,      // ask_...
})

// 2. Connect through the console gateway.
const client = new StageChannelClient({
  clientId: 'web-1',                       // stable per instance; unique across instances
  role: 'assistant',
  name: '萤火镇',
  stage: {
    id: 'town:meadow',
    kind: 'town',
    environment: { text: '萤火镇' },
    commands: [
      {
        name: 'say',
        description: '在场景中说话',
        parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
      },
    ],
  },
  gateway: {
    baseUrl: 'https://console.example.com',
    gatewayWsPath: assistant.gatewayWsPath!, // "/a/<sessionId>/ws"
    apiKey: process.env.STAGE_API_KEY,
  },
  // Execute assistant commands and acknowledge them automatically.
  commandHandler: async command => {
    if (command.command === 'say') {
      renderSpeech((command.args as { text?: string })?.text ?? '')
      return { ok: true, result: { accepted: true } }
    }
    return { ok: false, error: `unknown command: ${command.command}` }
  },
})

client.on('connected', info => console.log('active stage:', info.stage.id))
client.on('llm_event', event => console.debug('model event', event.event))
client.on('disconnected', info => console.warn('closed', info.code, info.reason))

await client.connect()

// Report a scene event (delivered to the assistant and the current stage).
client.sendEvent({ kind: 'user_said', text: '你好', participantId: 'user-1' })

// Optional: chat through the stage channel.
const chat = await client.chat('今天天气怎么样？')
console.log(chat.accepted, chat.turn)

// Later…
client.close()
```

In a browser, `fetchAssistants` and the WebSocket work without polyfills.
Browsers cannot set custom headers on WebSocket upgrades, which is why gateway
mode carries the key in the `api_key` query parameter.

## Direct mode (local development / no console)

When the assistant is reachable directly, connect to its StageChannel port.
Direct mode does **not** check an API key — keep it on a trusted network.

```ts
const client = new StageChannelClient({
  clientId: 'local-dev-1',
  role: 'assistant',
  stage: { id: 'town:meadow', kind: 'town', commands: [{ name: 'say' }] },
  direct: { host: '127.0.0.1', port: 41232, path: '/ws', useTls: false },
})
await client.connect()
```

Or pass an explicit URL:

```ts
const client = new StageChannelClient({
  clientId: 'local-dev-1',
  stage: { id: 's', kind: 'k' },
  url: 'ws://127.0.0.1:41232/ws',
})
```

## Authentication

| Path | Where the key goes |
| --- | --- |
| Discovery (`GET /api/assistants`) | `Authorization: Bearer <key>` and/or `X-API-Key: <key>` (`authHeader` option, default `both`) |
| Gateway WebSocket | `?api_key=<key>` query parameter (`gateway.apiKey`) |
| Direct WebSocket | no auth in the protocol |

The name and shape of the API key comes from the console (`~/.assistant/console/api-key.json`).

## API reference

### Discovery

```ts
fetchAssistants(options: {
  baseUrl: string
  apiKey?: string
  fetch?: FetchLike            // injectable, defaults to global fetch
  authHeader?: 'bearer' | 'x-api-key' | 'both' | 'none'
  headers?: Record<string, string>
  timeoutMs?: number           // default 10000
  signal?: AbortSignal
}): Promise<AssistantDescriptor[]>
```

Calls `GET {baseUrl}/api/assistants` and returns descriptors where
`status === 'online'` and `channels` contains `'stage'` (see `isStageAssistant`).
Each descriptor includes `sessionId`, `gatewayBase`, `gatewayWsPath`,
`channelEndpoints`, etc.

```ts
buildGatewayWsUrl(baseUrl, gatewayWsPath, apiKey?, { apiKeyParam? }): string
// ('https://console', '/a/x/ws', 'ask_1') → 'wss://console/a/x/ws?api_key=ask_1'

buildDirectWsUrl(host, port, path = '/ws', useTls = false): string
// ('127.0.0.1', 41232) → 'ws://127.0.0.1:41232/ws'
```

### `StageChannelClient`

Options:

| Option | Type | Default | Notes |
| --- | --- | --- | --- |
| `clientId` | `string` | required | Stable per instance; reusing it closes the older socket with 4001 |
| `role` | `'assistant' \| 'user'` | `'assistant'` | `user` skips `stage_activate` |
| `stage` | `StageDefinition` | required | `{ id, kind, environment?, commands? }` |
| `assistantId`, `name`, `clientType` | `string` | — | Sent in `hello` (`clientType` defaults to `npm`) |
| `gateway` | `{ baseUrl, gatewayWsPath?, sessionId?, apiKey? }` | — | Gateway mode; path derived from `sessionId` when omitted |
| `direct` | `{ host, port, path?, useTls? }` | — | Direct mode |
| `url` | `string` | — | Explicit WebSocket URL (mutually exclusive with `gateway`/`direct`) |
| `webSocketFactory` | `(url) => WebSocketLike` | global `WebSocket` | Inject a fake in tests |
| `connectTimeoutMs` | `number` | `30000` | Whole-handshake timeout |
| `requestTimeoutMs` | `number` | `30000` | Per-request timeout (register/activate/transition/chat) |
| `autoRegister` | `boolean` | `true` | Send `stage_register` right after `hello_ack` |
| `autoActivate` | `boolean` | `true` | Send `stage_activate` after registration (assistant only) |
| `commandHandler` | `(command) => CommandOutcome \| Promise<CommandOutcome>` | — | Auto-acknowledges matching commands |
| `onConnected`, `onDisconnected`, `onHelloAck`, `onCommand`, `onLlmEvent`, `onEventRejected`, `onServerError` | callbacks | — | Alternative to `client.on(...)` |

Methods:

| Method | Returns | Description |
| --- | --- | --- |
| `connect()` | `Promise<ConnectedInfo>` | Opens the socket and runs `hello → hello_ack → stage_register → stage_activate` |
| `close(code?, reason?)` | `void` | Closes the socket; pending requests reject with `ConnectionClosedError` |
| `registerStage(stage?, options?)` | `Promise<StageRegisterResultFrame>` | Sends `stage_register` and waits for its result |
| `activateStage(stageId?, options?)` | `Promise<StageActivateResultFrame>` | Sends `stage_activate` (`mode`, `expectedStageId`, `expectedRevision`) |
| `transitionToEmpty(options?)` | `Promise<StageTransitionResultFrame>` | Sends `stage_transition` with `target: 'empty'` |
| `sendEvent(event, { stageId? })` | `void` | Sends an `event` frame for the current stage |
| `sendCommandResult(commandId, ok, result?, error?)` | `void` | Acknowledges a command manually |
| `chat(text, { requestId?, images? })` | `Promise<ChatResultFrame>` | Sends `chat` and waits for `chat_result` |
| `on(type, handler)` | `() => void` | Subscribe; returned function unsubscribes |
| `off(type, handler)` | `void` | Unsubscribe |

Read-only properties: `status` (`disconnected | connecting | hello_sent | acked |
registered | active | closed`), `isConnected`, `currentStage`, `helloAck`, plus
`clientId`, `role`, `stage`.

Events:

```ts
client.on('connected', info => { /* ConnectedInfo */ })
client.on('disconnected', info => { /* { code, reason, wasClean } */ })
client.on('hello_ack', frame => { /* raw hello_ack */ })
client.on('command', command => { /* { commandId, bridgeId, stageId, command, args? } */ })
client.on('llm_event', frame => { /* frame.event */ })
client.on('event_rejected', frame => { /* { reason } */ })
client.on('server_error', frame => { /* { requestId?, error } */ })
```

`commandHandler` receives `{ commandId, bridgeId?, stageId?, command, args? }`
and returns `{ ok, result?, error? }`. If it throws (or rejects), the SDK answers
`ok: false` with the error message. A command whose `stageId` differs from the
configured stage is answered with `ok: false` automatically and is not emitted.

### Frame helpers

Types and helpers for advanced use / tests:

```ts
import {
  encodeFrame, decodeServerFrame, createHelloFrame, createStageRegisterFrame,
  createStageActivateFrame, createStageTransitionFrame, createEventFrame,
  createCommandResultFrame, createChatFrame, validateHelloAck,
} from 'stage-channel-sdk'
```

- `decodeServerFrame(text)` → `ServerFrame | null`. Malformed JSON and objects
  without a `type` return `null`; unknown `type` values return an
  `UnknownServerFrame` that callers should ignore. Unknown fields are preserved.
- `isKnownServerFrame`, `isHelloAckFrame`, `isCommandFrame`, … are type guards.
- `validateHelloAck(frame)` checks `channel === 'stage'`, `clientId`, `stage` and
  `registrations` and returns `{ ok: true }` or `{ ok: false, reason }`.

### Errors

All errors extend `StageChannelError` and carry a stable `code`:

| Error | When |
| --- | --- |
| `WebSocketUnavailableError` | No global `WebSocket` and no `webSocketFactory` |
| `HandshakeTimeoutError` | Handshake exceeded `connectTimeoutMs` (default 30 s); `.phase` says where |
| `ClientReplacedError` | Close code 4001: another connection reused `clientId` |
| `ConnectionClosedError` | Socket closed; `.closeCode` / `.closeReason` |
| `RequestTimeoutError` | A register/activate/chat request exceeded `requestTimeoutMs` |
| `StageServerError` | Server sent an `error` frame or rejected registration/activation |
| `DiscoveryError` | Discovery network / HTTP / JSON failure; `.status`, `.url` |
| `ProtocolError` | Invalid arguments, invalid `hello_ack` |
| `NotConnectedError` | Sending before `connect()` / after close |

## Protocol notes

- Handshake: `hello` (`channel: 'stage'`) → `hello_ack` (must report
  `channel: 'stage'`) → `stage_register` → `stage_activate` (`role: 'user'`
  skips activation).
- Handshake and command execution timeouts are 30 s. The SDK enforces the
  handshake and request timeouts; the server enforces command execution.
- `event` must target the current stage or the server answers `event_rejected`.
- Disconnects leave the server stage `suspended`; registration is **not**
  restored automatically — reconnect with the same `clientId`, then register and
  activate again.
- The SDK does not auto-reconnect; call `connect()` again (the `clientId` stays
  stable across reconnects by design).

## Testing

```bash
cd sdk/npm
node --experimental-strip-types --test test/*.test.ts
```

The suite covers:

- fixture consistency against `../../spec/fixtures` (every frame decodes / is
  constructed equivalently, field order independent);
- discovery filtering, Bearer / X-API-Key headers and gateway/direct URL builders;
- the client state machine with an injected fake WebSocket: handshake, role=user,
  30 s timeout, command stage mismatch, command handler (sync / async / throwing),
  unknown frame types and fields, 4001, pending-request rejection on close,
  explicit register / activate / transition / chat requests.

No network access is required.

## Build

The package ships compiled ESM + type declarations in `dist/`.

```bash
cd sdk/npm
npm install          # installs the TypeScript devDependency once
npm run build        # → dist/ (js + d.ts)
```

`npm run build` runs `scripts/build.mjs`, which:

1. compiles `src/` with `tsc -p tsconfig.json`;
2. normalizes declaration import specifiers from `./x.ts` to `./x.js` in
   `dist/*.d.ts` (sources use explicit `.ts` extensions so Node's type stripping
   can run `src/` and `test/` without building; tsc only rewrites the emitted JS,
   not the declarations).

tsc lookup order: `$TSC` → `node_modules/typescript/bin/tsc` → inside this
repository `../../assistant/node_modules/typescript/bin/tsc`. So in this repo the
build also works without `npm install`:

```bash
npm run build        # uses assistant/node_modules/typescript/bin/tsc
```

The published tarball contains only `dist/`, `README.md`, `LICENSE` and
`package.json` (no `src/`, `test/`, `scripts/`).

## Release steps

> The name `stage-channel-sdk` was checked to be available on npm when this SDK
> was added. Do **not** run `npm publish` from tests/CI; publish is a manual,
> reviewed step.

1. Make sure the protocol contract (`sdk/spec/protocol.md` + fixtures) and the
   server behaviour (`assistant/src/channel/stage-channel.ts`) are in sync.
2. `cd sdk/npm && npm install && npm run build && npm test`
3. Bump the version: `npm version patch|minor|major`
4. Inspect the tarball: `npm pack --dry-run` — it must contain only
   `dist/`, `README.md`, `LICENSE`, `package.json` (no `src/`, `test/`).
5. Publish: `npm login` then `npm publish --access public`
   (add `--otp <code>` if 2FA is enabled).
6. Tag the release in git and note the version in the project changelog.

## Known limitations

- **No auto-reconnect.** The caller decides when to retry; keep `clientId`
  stable so the server can replace the stale connection (old one closes 4001).
- **Browser WS headers.** Gateway auth must use the `?api_key=` query parameter
  because browsers cannot set `Authorization` on WebSocket upgrades. Use a
  `wss://` console for public deployments.
- **Direct mode is unauthenticated** by protocol; restrict it to trusted
  networks or put it behind your own proxy.
- **Single stage per client.** `registerStage()` can update the declared stage,
  but command routing compares against the configured `stage.id`.
- **`chat`/`chat_result` are optional protocol extensions**; if the server does
  not implement them the request rejects with `RequestTimeoutError`.
- The SDK targets Node ≥ 22 / evergreen browsers; older runtimes must inject
  `webSocketFactory` and `fetch`.

## License

MIT — see [LICENSE](./LICENSE).
