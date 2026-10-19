/**
 * Protocol-level tests: frame decoding, tolerant parsing, handshake validation
 * and unknown type / unknown field forward compatibility.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { HelloAckFrame } from '../src/index.ts'
import {
  createHelloFrame,
  createStageRegisterFrame,
  decodeServerFrame,
  encodeFrame,
  isCommandFrame,
  isHelloAckFrame,
  isKnownServerFrame,
  isRegisterResult,
  isStageSnapshot,
  isTransitionResult,
  isUnknownServerFrame,
  parseJsonObject,
  validateHelloAck,
} from '../src/index.ts'

const HELLO_ACK: HelloAckFrame = {
  type: 'hello_ack',
  channel: 'stage',
  clientId: 'client-1',
  registrations: [],
  stage: { id: 'empty', kind: 'empty', revision: 0, status: 'empty', participants: [], capabilities: [] },
}

test('decodeServerFrame parses valid JSON objects', () => {
  const frame = decodeServerFrame(JSON.stringify(HELLO_ACK))
  assert.ok(frame)
  assert.ok(isHelloAckFrame(frame))
  assert.equal(frame.clientId, 'client-1')
  assert.ok(isKnownServerFrame(frame))

  const fromObject = decodeServerFrame({ ...HELLO_ACK, extra: true })
  assert.ok(fromObject)
  assert.ok(isHelloAckFrame(fromObject))
  assert.equal((fromObject as unknown as Record<string, unknown>).extra, true)
})

test('decodeServerFrame tolerates malformed payloads', () => {
  assert.equal(decodeServerFrame('not json'), null)
  assert.equal(decodeServerFrame('[]'), null)
  assert.equal(decodeServerFrame('42'), null)
  assert.equal(decodeServerFrame('null'), null)
  assert.equal(decodeServerFrame('{"noType":true}'), null)
  assert.equal(decodeServerFrame('{"type":42}'), null)
  assert.equal(decodeServerFrame('{"type":""}'), null)
  assert.equal(parseJsonObject('{"ok":true}')?.ok, true)
  assert.equal(parseJsonObject('{"broken"'), null)
})

test('unknown frame types are tolerated, not errors', () => {
  const frame = decodeServerFrame('{"type":"future_frame","payload":{"nested":true}}')
  assert.ok(frame)
  assert.equal(frame.type, 'future_frame')
  assert.equal(isUnknownServerFrame(frame), true)
  assert.equal(isKnownServerFrame(frame), false)
  assert.deepEqual(frame, { type: 'future_frame', payload: { nested: true } })
})

test('known frames ignore unknown fields', () => {
  const raw = JSON.parse(JSON.stringify(HELLO_ACK)) as Record<string, unknown>
  raw.unknownField = { anything: [1, 2, 3] }
  raw.bridgeId = 'stage:client-1:town'
  const frame = decodeServerFrame(raw)
  assert.ok(frame)
  assert.ok(isHelloAckFrame(frame))
  assert.deepEqual(validateHelloAck(frame), { ok: true })
  assert.equal(frame.bridgeId, 'stage:client-1:town')
})

test('validateHelloAck rejects contract violations', () => {
  assert.deepEqual(validateHelloAck(HELLO_ACK), { ok: true })

  const wrongChannel = { ...HELLO_ACK, channel: 'other' } as unknown as HelloAckFrame
  assert.equal(validateHelloAck(wrongChannel).ok, false)

  const missingClientId = { ...HELLO_ACK, clientId: '' } as HelloAckFrame
  assert.equal(validateHelloAck(missingClientId).ok, false)

  const invalidStage = { ...HELLO_ACK, stage: { id: 'x' } } as unknown as HelloAckFrame
  assert.equal(validateHelloAck(invalidStage).ok, false)

  const invalidRegistrations = { ...HELLO_ACK, registrations: null } as unknown as HelloAckFrame
  assert.equal(validateHelloAck(invalidRegistrations).ok, false)
})

test('guards are tolerant about payload shape', () => {
  const command = decodeServerFrame('{"type":"command"}')
  assert.ok(command)
  assert.equal(isCommandFrame(command), false, 'command without commandId/command is not usable')

  const usable = decodeServerFrame('{"type":"command","commandId":"c1","command":"say"}')
  assert.ok(usable)
  assert.equal(isCommandFrame(usable), true)

  assert.equal(isStageSnapshot({ id: 'x', kind: 'k', revision: 0, status: 'empty', participants: [], capabilities: [] }), true)
  assert.equal(isStageSnapshot({ id: 'x' }), false)
  assert.equal(isTransitionResult({ kind: 'rejected', reason: 'nope' }), true)
  assert.equal(isTransitionResult({ kind: 'changed' }), false)
  assert.equal(isRegisterResult({ kind: 'registered', registration: { id: 'x' } }), true)
  assert.equal(isRegisterResult({ kind: 'registered' }), false)
})

test('encodeFrame emits compact JSON without undefined fields', () => {
  const encoded = encodeFrame(createHelloFrame({ clientId: 'client-1' }))
  assert.deepEqual(JSON.parse(encoded), { type: 'hello', channel: 'stage', clientId: 'client-1' })
  assert.ok(!encoded.includes('undefined'))

  const register = createStageRegisterFrame({ stage: { id: 's1', kind: 'town' } })
  assert.deepEqual(JSON.parse(encodeFrame(register)), { type: 'stage_register', stage: { id: 's1', kind: 'town' } })
})
