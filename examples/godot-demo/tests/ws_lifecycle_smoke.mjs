import assert from 'node:assert/strict'
import { mkdtemp, cp, rm, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawn } from 'node:child_process'
import { WebSocketServer } from '../../../assistant/node_modules/ws/wrapper.mjs'

const projectSource = resolve(import.meta.dirname, '..')
const godot = process.env.GODOT_BIN
  ?? (process.platform === 'darwin'
    ? join(process.env.HOME ?? '', 'Library/Application Support/Steam/steamapps/common/Godot Engine/Godot.app/Contents/MacOS/Godot')
    : 'godot')
const scratch = await mkdtemp(join(tmpdir(), 'assistant-godot-ws-'))
const project = join(scratch, 'project')

try {
  // A copied project gets its own generated Godot metadata. Its unique project name
  // also isolates user:// without changing HOME or XDG variables.
  await cp(projectSource, project, { recursive: true, filter: source => !source.includes('/.godot/') })
  const projectFile = join(project, 'project.godot')
  const { readFile, writeFile } = await import('node:fs/promises')
  const original = await readFile(projectFile, 'utf8')
  await writeFile(projectFile, original.replace('config/name="assistant-vn"', `config/name="assistant-vn-ws-${process.pid}"`))
  await mkdir(join(project, '.godot'), { recursive: true })
  await cp(join(projectSource, '.godot', 'global_script_class_cache.cfg'), join(project, '.godot', 'global_script_class_cache.cfg'))

  await runIdentityProbe(project)
  await runLegacyLimitReproduction(project)
  await runPayloadProbe(project)
  await runPreOpenFailureProbe(project)
  await runProjectUnitTests(project)
  console.log('[ws-smoke] PASS')
} finally {
  await rm(scratch, { recursive: true, force: true })
}

async function runPayloadProbe(projectPath) {
  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 })
  await new Promise((resolve, reject) => { wss.once('listening', resolve); wss.once('error', reject) })
  const port = wss.address().port
  let hello
  const finished = new Promise((resolve, reject) => {
    wss.once('connection', socket => {
      socket.on('error', reject)
      socket.on('message', bytes => {
        const frame = JSON.parse(bytes.toString())
        if (frame.type === 'hello') {
          hello = frame
          socket.send(JSON.stringify({ type: 'hello_ack' }))
        } else if (frame.type === 'stage_register') {
          socket.send(JSON.stringify({ type: 'stage_register_result', requestId: frame.requestId, result: { kind: 'registered' } }))
        } else if (frame.type === 'stage_activate') {
          socket.send(JSON.stringify({ type: 'stage_activate_result', requestId: frame.requestId, result: { kind: 'changed' } }))
          socket.send(JSON.stringify({ type: 'llm_event', event: { type: 'large', data: { text: '大'.repeat(128 * 1024 / 3) + 'xx' } } }))
          for (let i = 0; i < 256; i++) {
            socket.send(JSON.stringify({ type: 'llm_event', event: { type: 'burst', data: { index: i, text: '事件'.repeat(1024) } } }))
          }
          setTimeout(() => socket.close(4101, 'probe shutdown'), 250)
        }
      })
      socket.once('close', resolve)
    })
  })
  try {
    const result = await runGodot(projectPath, [`--port=${port}`, '--close-code=4101'])
    assert.equal(result.code, 0)
    assert.equal(hello.clientId, 'godot-probe-instance')
    assert.equal(hello.assistantId, 'probe-participant')
    assert.match(result.output, /complete large_bytes=131072 burst=256/)
    assert.match(result.output, /code=4101.*probe shutdown/)
    await Promise.race([
      finished,
      new Promise((_, reject) => setTimeout(() => reject(new Error('server socket did not close')), 3_000)),
    ])
  } finally {
    for (const socket of wss.clients) socket.terminate()
    await new Promise(resolve => wss.close(resolve))
  }
}

async function runLegacyLimitReproduction(projectPath) {
  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 })
  await new Promise((resolve, reject) => { wss.once('listening', resolve); wss.once('error', reject) })
  const port = wss.address().port
  const clientClosed = new Promise((resolve, reject) => {
    wss.once('connection', socket => {
      socket.once('error', reject)
      socket.on('message', bytes => {
        const frame = JSON.parse(bytes.toString())
        if (frame.type === 'hello') socket.send(JSON.stringify({ type: 'hello_ack' }))
        else if (frame.type === 'stage_register') {
          socket.send(JSON.stringify({ type: 'stage_register_result', requestId: frame.requestId, result: { kind: 'registered' } }))
        } else if (frame.type === 'stage_activate') {
          socket.send(JSON.stringify({ type: 'stage_activate_result', requestId: frame.requestId, result: { kind: 'changed' } }))
          setTimeout(() => socket.send(JSON.stringify({
            type: 'llm_event', event: { type: 'large', data: { text: '大'.repeat(128 * 1024 / 3) + 'xx' } },
          })), 100)
        }
      })
      socket.once('close', (code, reason) => resolve({ code, reason: reason.toString() }))
    })
  })
  try {
    const result = await runGodot(projectPath, [
      `--port=${port}`, '--legacy-buffer=true', '--expect-oversize=true',
    ])
    assert.equal(result.code, 0)
    assert.match(result.output, /legacy oversized frame reproduced/)
    const closed = await clientClosed
    assert.equal(closed.code, 1009)
    console.log(`[ws-smoke] legacy limit close code=${closed.code} reason=${closed.reason}`)
  } finally {
    for (const socket of wss.clients) socket.terminate()
    await new Promise(resolve => wss.close(resolve))
  }
}

async function runPreOpenFailureProbe(projectPath) {
  const reservation = new WebSocketServer({ host: '127.0.0.1', port: 0 })
  await new Promise((resolve, reject) => { reservation.once('listening', resolve); reservation.once('error', reject) })
  const port = reservation.address().port
  await new Promise(resolve => reservation.close(resolve))
  const result = await runGodot(projectPath, [`--port=${port}`])
  assert.equal(result.code, 0)
  assert.match(result.output, /disconnected WS 已关闭.*code=/)
}

async function runIdentityProbe(projectPath) {
  const result = await runGodotScene(projectPath, 'res://tests/probe_manager_identity.tscn', [])
  assert.equal(result.code, 0)
  assert.match(result.output, /\[identity-probe\] PASS/)
}

async function runProjectUnitTests(projectPath) {
  const result = await runGodotScene(projectPath, 'res://tests/run_tests.tscn', [])
  assert.equal(result.code, 0)
  assert.match(result.output, /0 失败/)
}

function runGodot(projectPath, args) {
  return runGodotScene(projectPath, 'res://tests/probe_ws_lifecycle.tscn', args)
}

function runGodotScene(projectPath, scene, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(godot, [
      '--headless', '--path', projectPath, '--log-file', join(projectPath, 'probe.log'),
      scene, '--', ...args,
    ], { stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''
    child.stdout.on('data', chunk => { output += chunk; process.stdout.write(chunk) })
    child.stderr.on('data', chunk => { output += chunk; process.stderr.write(chunk) })
    child.once('error', reject)
    const timeout = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new Error('Godot probe exceeded 20 seconds\n' + output))
    }, 20_000)
    child.once('close', code => { clearTimeout(timeout); resolve({ code, output }) })
  })
}
