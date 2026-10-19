/**
 * 多助手 say/say_to 链路测试（不依赖 dsh agent，纯 ws 协议层）。
 *
 * 起一个最小 ws-channel server（只覆盖 hello / assistant_say 推送 / assistant_intercom / interaction / user_said 接收），
 * 用三个 ws client 模拟 Godot（2 个 assistant + 1 个 user），
 * 验证：
 *   1. hello 协议（含 role + assistantId + name）
 *   2. assistant_say 出站：target=null 广播、target=B 私聊
 *   3. assistant_intercom 入站：Godot 转发到目标 ws
 *   4. interaction 入站：服务端能正确解析
 *   5. user_said 入站：广播 / 定向
 */

import http from 'node:http'
import { WebSocketServer, WebSocket } from 'ws'

const HOST = '127.0.0.1'
const PORT = 4321

// ── Server ──

const httpServer = http.createServer((req, res) => {
  res.statusCode = 404
  res.end('VN ws only')
})
const wss = new WebSocketServer({ noServer: true, path: '/ws' })
httpServer.on('upgrade', (req, socket, head) => {
  const u = new URL(req.url, 'http://localhost')
  if (u.pathname !== '/ws') { socket.destroy(); return }
  wss.handleUpgrade(req, socket, head, (ws) => onConn(ws))
})

const clients = new Map()
let receivedFromClient = [] // 所有从 client 收到的非 hello 消息

function onConn(ws) {
  let clientId = ''
  ws.on('message', (raw) => {
    let msg
    try { msg = JSON.parse(raw.toString()) } catch { return }
    if (msg.type === 'hello') {
      clientId = String(msg.clientId || '').trim()
      if (!clientId) { ws.close(); return }
      clients.set(clientId, {
        ws,
        commands: Array.isArray(msg.commands) ? msg.commands : [],
        role: msg.role === 'user' ? 'user' : 'assistant',
        assistantId: msg.assistantId || (msg.role === 'user' ? undefined : clientId),
        name: msg.name || '',
      })
      ws.send(JSON.stringify({ type: 'hello_ack', clientId }))
      console.log(`[svr] + ${clientId} role=${msg.role || 'assistant'}${msg.assistantId ? ' assistantId=' + msg.assistantId : ''}`)
    } else {
      receivedFromClient.push({ from: clientId, msg })
      console.log(`[svr] ${msg.type} from=${clientId}: ${JSON.stringify(msg).slice(0, 120)}`)
    }
  })
  ws.on('close', () => { if (clientId) clients.delete(clientId); console.log(`[svr] - ${clientId}`) })
}

/** 模拟 ws-channel.ts 的 sendAssistantSayTo：给指定 clientId 的 ws 推 assistant_say */
function sendSay(fromId, text, target) {
  const c = clients.get(fromId)
  if (!c) throw new Error(`no client ${fromId}`)
  c.ws.send(JSON.stringify({ type: 'assistant_say', assistantId: fromId, text, target: target ?? null }))
  console.log(`[svr] → assistant_say to ${fromId}: text="${text}" target=${target ?? 'null'}`)
}

await new Promise(r => httpServer.listen(PORT, HOST, r))
console.log(`[svr] listening on ws://${HOST}:${PORT}/ws\n`)

// ── Client (Godot sim) ──

function openClient(clientId, role, assistantId, name) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://${HOST}:${PORT}/ws`)
    const inbox = []
    const timeout = setTimeout(() => reject(new Error(`${clientId} timeout`)), 3000)
    ws.on('open', () => {
      ws.send(JSON.stringify({
        type: 'hello', clientId, role,
        assistantId: role === 'assistant' ? assistantId : undefined,
        name: role === 'assistant' ? name : undefined,
        commands: role === 'assistant' ? [
          { name: 'create_scene' }, { name: 'add_object' }, { name: 'say' }, { name: 'say_to' },
        ] : [],
      }))
    })
    ws.on('message', (raw) => {
      const m = JSON.parse(raw.toString())
      inbox.push(m)
      if (m.type === 'hello_ack') { clearTimeout(timeout); resolve({ ws, inbox, send: (o) => ws.send(JSON.stringify(o)) }) }
    })
    ws.on('error', (e) => { clearTimeout(timeout); reject(e) })
  })
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms))
const filterInbox = (inbox, type) => inbox.filter(m => m.type === type)

let pass = 0, fail = 0
function check(label, ok) { ok ? (pass++, console.log(`  ✓ ${label}`)) : (fail++, console.log(`  ✗ ${label}`)) }

console.log('═══ Case 1: A 调 say("大家好") — 服务端向 A ws 推 assistant_say ═══')
const A = await openClient('A', 'assistant', 'A', '虹猫')
const B = await openClient('B', 'assistant', 'B', '蓝兔')
const U = await openClient('user', 'user', undefined, undefined)
await sleep(100)

sendSay('A', '大家好', null)
await sleep(100)
const aSay = filterInbox(A.inbox, 'assistant_say')
check('A 收到 1 条 assistant_say', aSay.length === 1)
check('A 收到 target=null', aSay[0]?.target === null)
check('A 收到 text=大家好', aSay[0]?.text === '大家好')

console.log('\n═══ Case 2: A 调 say_to(B, "私聊") — 服务端向 A ws 推 assistant_say target=B ═══')
sendSay('A', '私聊', 'B')
await sleep(100)
const aSay2 = filterInbox(A.inbox, 'assistant_say').filter(m => m.text === '私聊')
check('A 收到 1 条私聊', aSay2.length === 1)
check('A 的私聊 target=B', aSay2[0]?.target === 'B')
check('B 没收到（只推到 caller 的 ws）', filterInbox(B.inbox, 'assistant_say').length === 0)

console.log('\n═══ Case 3: Godot 转发 intercom → B 收到，服务端 echo ═══')
B.send({ type: 'assistant_intercom', from: 'A', text: 'B 你好' })
await sleep(100)
const intercomHits = receivedFromClient.filter(r => r.msg.type === 'assistant_intercom')
check('服务端收到 assistant_intercom', intercomHits.length === 1)
check('intercom from=A', intercomHits[0]?.msg.from === 'A')

console.log('\n═══ Case 4: 用户 ws 发 user_said 广播 ═══')
U.send({ type: 'user_said', text: '两位好', target: '' })
await sleep(100)
const userSaid = receivedFromClient.filter(r => r.msg.type === 'user_said')
check('服务端收到 1 条 user_said', userSaid.length === 1)
check('user_said text=两位好', userSaid[0]?.msg.text === '两位好')

console.log('\n═══ Case 5: 用户 ws 发 user_said 定向 A ═══')
U.send({ type: 'user_said', text: '只对 A 说', target: 'A' })
await sleep(100)
const userSaid2 = receivedFromClient.filter(r => r.msg.type === 'user_said' && r.msg.text === '只对 A 说')
check('服务端收到定向 user_said', userSaid2.length === 1)
check('user_said target=A', userSaid2[0]?.msg.target === 'A')

console.log('\n═══ Case 6: 用户 ws 发 interaction ═══')
U.send({
  type: 'interaction',
  event: {
    kind: 'object_clicked', actor: 'user', operator: '玩家', sceneId: 'beach',
    objectId: 'sword', x: 0.5, y: 0.5, description: '点击了剑',
  },
})
await sleep(100)
const interact = receivedFromClient.filter(r => r.msg.type === 'interaction')
check('服务端收到 interaction', interact.length === 1)
check('interaction actor=user', interact[0]?.msg.event?.actor === 'user')

console.log(`\n═══ ${pass} 通过 / ${fail} 失败 ═══\n`)
process.exit(fail === 0 ? 0 : 1)
