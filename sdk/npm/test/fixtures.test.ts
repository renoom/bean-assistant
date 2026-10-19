/**
 * Fixture consistency tests.
 *
 * The fixtures under `sdk/spec/fixtures/` are the single source of truth for
 * the wire contract (see `sdk/spec/protocol.md` §6). These tests:
 *
 * 1. parse every `server_to_client` fixture and assert `type` + key fields;
 * 2. build every `client_to_server` fixture through the protocol constructors
 *    and assert the JSON is equivalent (field order does not matter).
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { StageDefinition, StageEventPayload } from '../src/index.ts'
import {
  createCommandResultFrame,
  createEventFrame,
  createHelloFrame,
  createStageActivateFrame,
  createStageRegisterFrame,
  createStageTransitionFrame,
  decodeServerFrame,
  isCommandFrame,
  isHelloAckFrame,
  isLlmEventFrame,
  isServerErrorFrame,
  isStageActivateResultFrame,
  isStageRegisterResultFrame,
  validateHelloAck,
} from '../src/index.ts'

const fixturesDir = fileURLToPath(new URL('../../spec/fixtures/', import.meta.url))

interface ManifestEntry {
  file: string
  direction: 'client_to_server' | 'server_to_client'
  type: string
}

interface FixtureManifest {
  version: number
  fixtures: ManifestEntry[]
}

function readFixture(name: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(fixturesDir, name), 'utf8')) as Record<string, unknown>
}

const manifest = JSON.parse(readFileSync(join(fixturesDir, 'manifest.json'), 'utf8')) as FixtureManifest

test('manifest lists both directions and every fixture type', () => {
  assert.equal(manifest.version, 1)
  assert.ok(manifest.fixtures.length >= 12)
  const types = new Set(manifest.fixtures.map(entry => entry.type))
  for (const expected of [
    'hello',
    'hello_ack',
    'stage_register',
    'stage_register_result',
    'stage_activate',
    'stage_activate_result',
    'command',
    'command_result',
    'event',
    'llm_event',
    'stage_transition',
    'error',
  ]) {
    assert.ok(types.has(expected), `manifest is missing fixture type ${expected}`)
  }
  const directions = new Set(manifest.fixtures.map(entry => entry.direction))
  assert.deepEqual([...directions].sort(), ['client_to_server', 'server_to_client'])
})

test('every fixture is a JSON object with the type declared in the manifest', () => {
  for (const entry of manifest.fixtures) {
    const fixture = readFixture(entry.file)
    assert.equal(typeof fixture, 'object', `${entry.file} must be a JSON object`)
    assert.equal(fixture.type, entry.type, `${entry.file} type mismatch`)
  }
})

test('server fixtures decode and keep their key fields', () => {
  const helloAck = decodeServerFrame(JSON.stringify(readFixture('hello-ack.server.json')))
  assert.ok(helloAck, 'hello_ack must decode')
  assert.ok(isHelloAckFrame(helloAck))
  assert.deepEqual(validateHelloAck(helloAck), { ok: true })
  assert.equal(helloAck.channel, 'stage')
  assert.equal(helloAck.clientId, 'godot-1')
  assert.equal(helloAck.stage.id, 'empty')
  assert.equal(helloAck.stage.status, 'empty')
  assert.deepEqual(helloAck.registrations, [])

  const registerResult = decodeServerFrame(JSON.stringify(readFixture('stage-register-result.server.json')))
  assert.ok(registerResult, 'stage_register_result must decode')
  assert.ok(isStageRegisterResultFrame(registerResult))
  assert.equal(registerResult.requestId, 'r1')
  assert.equal(registerResult.result.kind, 'registered')
  assert.equal(registerResult.result.kind === 'registered' ? registerResult.result.registration.stageId : '', 'town:meadow')

  const activateResult = decodeServerFrame(JSON.stringify(readFixture('stage-activate-result.server.json')))
  assert.ok(activateResult, 'stage_activate_result must decode')
  assert.ok(isStageActivateResultFrame(activateResult))
  assert.equal(activateResult.result.kind, 'changed')
  assert.equal(activateResult.result.kind === 'changed' ? activateResult.result.stage.id : '', 'town:meadow')
  assert.equal(activateResult.result.kind === 'changed' ? activateResult.result.stage.revision : -1, 1)

  const command = decodeServerFrame(JSON.stringify(readFixture('command.server.json')))
  assert.ok(command, 'command must decode')
  assert.ok(isCommandFrame(command))
  assert.equal(command.commandId, 'stage-1750000000000-1')
  assert.equal(command.stageId, 'town:meadow')
  assert.equal(command.command, 'say')
  assert.deepEqual(command.args, { text: '你好' })

  const llmEvent = decodeServerFrame(JSON.stringify(readFixture('llm-event.server.json')))
  assert.ok(llmEvent, 'llm_event must decode')
  assert.ok(isLlmEventFrame(llmEvent))
  assert.equal((llmEvent.event as Record<string, unknown>).type, 'assistant_message')

  const error = decodeServerFrame(JSON.stringify(readFixture('error.server.json')))
  assert.ok(error, 'error must decode')
  assert.ok(isServerErrorFrame(error))
  assert.equal(error.requestId, 'r2')
  assert.equal(error.error, 'stage is not registered by this client')
})

test('client fixtures round-trip through the frame constructors', () => {
  const hello = readFixture('hello.client.json')
  assert.deepEqual(
    createHelloFrame({
      clientId: 'godot-1',
      role: 'assistant',
      assistantId: 'assistant-1',
      name: '编码助手',
    }),
    hello,
  )

  const register = readFixture('stage-register.client.json')
  assert.deepEqual(
    createStageRegisterFrame({
      requestId: register.requestId as string,
      stage: register.stage as StageDefinition,
    }),
    register,
  )

  const activate = readFixture('stage-activate.client.json')
  assert.deepEqual(
    createStageActivateFrame({
      requestId: activate.requestId as string,
      stageId: activate.stageId as string,
      mode: activate.mode as 'after-turn' | 'interrupt',
      expectedStageId: activate.expectedStageId as string,
      expectedRevision: activate.expectedRevision as number,
    }),
    activate,
  )

  const transition = readFixture('stage-transition.client.json')
  assert.deepEqual(
    createStageTransitionFrame({
      requestId: transition.requestId as string,
      stageId: transition.stageId as string,
      target: 'empty',
      mode: transition.mode as 'after-turn' | 'interrupt',
    }),
    transition,
  )

  const event = readFixture('event.client.json')
  assert.deepEqual(
    createEventFrame({
      stageId: event.stageId as string,
      event: event.event as StageEventPayload,
    }),
    event,
  )

  const commandResult = readFixture('command-result.client.json')
  assert.deepEqual(
    createCommandResultFrame({
      commandId: commandResult.commandId as string,
      ok: commandResult.ok as boolean,
      result: commandResult.result,
    }),
    commandResult,
  )
})
