/** Real Godot client against isolated StageChannel service; no model request. */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { access } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { StageRegistry } from '../../../assistant/lib/stage/manager.js'
import { AssistantCapabilities } from '../../../assistant/lib/service/capabilities.js'
import { AssistantEventHub } from '../../../assistant/lib/service/event-hub.js'
import { StageChannel } from '../../../assistant/lib/channel/stage-channel.js'
let tool
const agent = {
  status: 'idle', options: {}, session: { id: 'godot-probe', events: [] },
  ctx: { systemPrompt: { context: () => () => {} }, tools: { register: def => { tool = def; return () => {} } }, on: () => () => {} },
}
const stages = new StageRegistry(agent)
const capabilities = new AssistantCapabilities(agent, stages, { name: 'probe', attachments: { imageLimits: {} } })
const events = new AssistantEventHub(agent)
const channel = new StageChannel({ host: '127.0.0.1', port: 0 }, capabilities, events, stages)
let child
let timer
try {
  const endpoint = await channel.start()
  const port = endpoint.port
  const godot = process.env.GODOT_BIN ?? `${process.env.HOME}/Library/Application Support/Steam/steamapps/common/Godot Engine/Godot.app/Contents/MacOS/Godot`
  await access(godot)
  const project = fileURLToPath(new URL('../', import.meta.url))
  child = spawn(godot, ['--headless', '--path', project, 'res://tests/probe_stage_protocol.tscn', '--', `--port=${port}`], { stdio: ['ignore', 'pipe', 'pipe'] })
  child.stdout.on('data', data => process.stdout.write(data))
  child.stderr.on('data', data => process.stderr.write(data))
  const exited = new Promise((resolve, reject) => { child.once('exit', code => resolve(code)); child.once('error', reject) })
  const result = await new Promise((resolve, reject) => {
    const deadline = Date.now() + 10000
    timer = setInterval(() => {
      if (stages.snapshot().status === 'active') {
        clearInterval(timer)
        assert.equal(stages.snapshot().environment.text, 'Godot integration test environment')
        tool.execute({ action: 'execute', command: 'probe', args: {} }, {}).then(resolve, reject)
      } else if (Date.now() > deadline) { clearInterval(timer); reject(new Error('Godot registration timed out')) }
    }, 25)
  })
  assert.equal(result.ok, true)
  assert.deepEqual(result.result, { godot: true })
  assert.equal(await exited, 0)
  console.log('Godot real protocol smoke: passed')
} finally {
  clearInterval(timer)
  if (child && child.exitCode === null) child.kill()
  await channel.dispose()
  events.dispose(); stages.dispose()
}
