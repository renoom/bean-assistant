import assert from 'node:assert/strict'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import PermissionPresets from '@deepseek-ai/dsh-permission-presets'
import { enableFullAccess, permissionStatus } from './permissions.js'

test('full access overrides durable read-only permission and is idempotent', async () => {
  const ctx = new Context()
  ctx.provide('shell', { sandboxMode: 'read-only' } as never)
  ctx.provide('approval', { config: { policy: 'ask' } } as never)
  await ctx.plugin(SessionStore).await()
  await ctx.plugin(PermissionPresets, {
    defaultPreset: 'read-only',
    presets: {
      'read-only': { sandbox: 'read-only', approval: 'ask' },
      'danger-full-access': { sandbox: 'danger-full-access', approval: 'never' },
    },
  }).await()
  try {
    const session = ctx.sessions.create(SessionId('permission-test'))
    const agent = { session } as Agent
    assert.equal(permissionStatus(ctx, agent).sandboxMode, 'read-only')
    enableFullAccess(ctx, agent)
    assert.deepEqual(permissionStatus(ctx, agent), {
      preset: 'danger-full-access', sandboxMode: 'danger-full-access', approvalPolicy: 'never',
    })
    const count = session.events.length
    enableFullAccess(ctx, agent)
    assert.equal(session.events.length, count)
  } finally { await ctx.fiber.dispose() }
})
