/**
 * Real headless Godot smoke test for Console discovery and connection settings.
 * It uses a copied project with a verified unique user data directory.
 */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { access, cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const sourceProject = resolve(fileURLToPath(new URL('../', import.meta.url)))
const defaultGodot = join(process.env.HOME ?? '', 'Library/Application Support/Steam/steamapps/common/Godot Engine/Godot.app/Contents/MacOS/Godot')
const godot = process.env.GODOT_BIN ?? defaultGodot
let temporaryRoot
let server
let child
let requests = 0
let directDataDir

const runGodot = async (godotArgs, env = process.env) => {
  child = spawn(godot, godotArgs, { env, stdio: ['ignore', 'pipe', 'pipe'] })
  let output = ''
  child.stdout.on('data', chunk => { output += chunk; process.stdout.write(chunk) })
  child.stderr.on('data', chunk => { output += chunk; process.stderr.write(chunk) })
  const exitCode = await new Promise((resolveExit, rejectExit) => {
    const timeout = setTimeout(() => {
      child.kill()
      rejectExit(new Error('Godot Console discovery smoke timed out after 20 seconds'))
    }, 20_000)
    child.once('error', error => { clearTimeout(timeout); rejectExit(error) })
    child.once('exit', code => { clearTimeout(timeout); resolveExit(code) })
  })
  child = undefined
  return { exitCode, output }
}

const onlineStageAssistant = {
  sessionId: 'stage-assistant', name: 'Stage assistant', status: 'online', port: 43123,
  channelEndpoints: [{ id: 'stage', protocol: 'ws', host: '127.0.0.1', port: 43123, path: '/ws' }],
}
const httpOnlyAssistant = {
  sessionId: 'http-only-assistant', name: 'HTTP only', status: 'online', port: 43124,
  channelEndpoints: [{ id: 'http', protocol: 'http', host: '127.0.0.1', port: 43124 }],
}

try {
  await access(godot)
  temporaryRoot = await mkdtemp(join(tmpdir(), 'assistant-godot-discovery-'))
  const project = join(temporaryRoot, 'project')
  const isolatedData = join(temporaryRoot, 'user-data')
  await cp(sourceProject, project, { recursive: true })
  await mkdir(isolatedData)
  const projectSettings = join(project, 'project.godot')
  const projectText = await readFile(projectSettings, 'utf8')
  // Probe the requested absolute custom directory first. Godot 4.7 may treat it as a name.
  await writeFile(projectSettings, projectText.replace(
    'config/name="assistant-vn"',
    `config/name="assistant-godot-console-discovery-smoke"\nconfig/use_custom_user_dir=true\nconfig/custom_user_dir="${isolatedData}"\nconfig/custom_user_dir_name="${isolatedData}"`,
  ))
  const preflight = await runGodot([
    '--headless', '--path', project, 'res://tests/probe_console_discovery.tscn', '--', '--report-user-data-dir=true',
  ])
  assert.equal(preflight.exitCode, 0, `Godot user-data preflight failed:\n${preflight.output}`)
  const foundDataDir = preflight.output.match(/CONSOLE_DISCOVERY_USER_DATA_DIR=(.+)/)?.[1]?.trim()
  assert.ok(foundDataDir, 'Godot did not report its user data directory')
  let expectedDataDir = foundDataDir
  if (foundDataDir !== isolatedData) {
    directDataDir = foundDataDir
    const uniqueName = `assistant-godot-console-discovery-${temporaryRoot.split('/').at(-1)}`
    await writeFile(projectSettings, projectText.replace(
      'config/name="assistant-vn"',
      `config/name="${uniqueName}"\nconfig/use_custom_user_dir=true\nconfig/custom_user_dir_name="${uniqueName}"`,
    ))
    const fallbackPreflight = await runGodot([
      '--headless', '--path', project, 'res://tests/probe_console_discovery.tscn', '--', '--report-user-data-dir=true',
    ])
    assert.equal(fallbackPreflight.exitCode, 0, `Godot fallback user-data preflight failed:\n${fallbackPreflight.output}`)
    expectedDataDir = fallbackPreflight.output.match(/CONSOLE_DISCOVERY_USER_DATA_DIR=(.+)/)?.[1]?.trim()
    assert.ok(expectedDataDir?.includes(uniqueName), 'fallback user data directory is not uniquely named')
  }

  server = createServer((request, response) => {
    if (request.method !== 'GET' || request.url !== '/api/assistants') {
      response.writeHead(404).end()
      return
    }
    requests += 1
    const authorized = request.headers.authorization === 'Bearer test-key'
    if (requests === 1) {
      assert.equal(authorized, false, 'the first discovery request must not send a key')
      response.writeHead(401, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'missing API key' }))
      return
    }
    assert.equal(authorized, true, `request ${requests} must use the trimmed saved key`)
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify(requests === 2 ? [onlineStageAssistant, httpOnlyAssistant] : []))
  })
  await new Promise((resolveListen, rejectListen) => {
    server.once('error', rejectListen)
    server.listen(0, '127.0.0.1', resolveListen)
  })
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  const mockUrl = `http://127.0.0.1:${address.port}`
  const rendered = process.env.GODOT_RENDERED === '1'
  const godotArgs = [
    ...(rendered ? [] : ['--headless']), '--path', project, 'res://tests/probe_console_discovery.tscn', '--',
    `--mock-url=${mockUrl}`, `--expected-user-data-dir=${isolatedData}`,
    ...(rendered ? ['--screenshot=/tmp/godot-connection-settings.png'] : []),
  ]
  godotArgs[godotArgs.indexOf(`--expected-user-data-dir=${isolatedData}`)] = `--expected-user-data-dir=${expectedDataDir}`
  const { exitCode, output } = await runGodot(godotArgs)
  assert.equal(exitCode, 0, `Godot probe failed:\n${output}`)
  assert.match(output, /CONSOLE_DISCOVERY_PROBE_PASS/)
  assert.match(output, /CONSOLE_DISCOVERY_CONFIG_OK=true/)
  assert.equal(requests, 3, 'probe must make unauthenticated, refreshed, then empty-list requests')
  console.log('Godot Console discovery smoke: passed')
} finally {
  if (child?.exitCode === null) child.kill()
  await new Promise(resolveClose => server?.close(() => resolveClose()) ?? resolveClose())
  // Only this run's uniquely named fallback directory is eligible for cleanup.
  if (temporaryRoot) {
    const uniquePrefix = 'assistant-godot-console-discovery-assistant-godot-discovery-'
    const fallbackName = `assistant-godot-console-discovery-${temporaryRoot.split('/').at(-1)}`
    if (fallbackName.startsWith(uniquePrefix)) {
      await rm(join(process.env.HOME ?? '', 'Library', 'Application Support', fallbackName), { recursive: true, force: true })
    }
    if (directDataDir?.includes(temporaryRoot)) {
      await rm(directDataDir, { recursive: true, force: true })
    }
  }
  if (temporaryRoot) await rm(temporaryRoot, { recursive: true, force: true })
}
