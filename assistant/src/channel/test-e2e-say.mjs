/**
 * 端到端：验证统一 event 架构
 *   1. llm_event 转发 —— ws-channel 订阅 dsh event，把 LLM 完整事件流推到 Godot ws
 *   2. say 是「指令」—— LLM 调 stage_action {command:"say"}，服务端转发 command 到 Godot ws
 *   3. 场景事件（统一 event 消息）—— 玩家说话用 {type:'event', event:{kind:'user_said', text}}
 */

import { WebSocket } from 'ws'

const A_PORT = 3102  // 虹猫
const URL = `ws://127.0.0.1:${A_PORT}/ws`

function openClient(clientId, role, assistantId, name) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(URL)
    const inbox = []
    ws.on('open', () => {
      ws.send(JSON.stringify({
        type: 'hello', clientId, role,
        assistantId: role === 'assistant' ? assistantId : undefined,
        name: role === 'assistant' ? name : undefined,
        commands: role === 'assistant' ? [
          { name: 'create_scene' }, { name: 'add_object' },
          { name: 'say' }, { name: 'say_to' },
        ] : [],
      }))
    })
    ws.on('message', (raw) => {
      const m = JSON.parse(raw.toString())
      inbox.push(m)
      if (m.type === 'hello_ack') resolve({ ws, inbox })
    })
    ws.on('error', reject)
    setTimeout(() => reject(new Error(`${clientId} timeout`)), 4000)
  })
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms))

let pass = 0, fail = 0
function check(label, ok) { ok ? (pass++, console.log(`  ✓ ${label}`)) : (fail++, console.log(`  ✗ ${label}`)) }

console.log('═══ 端到端：统一 event + say 指令 ═══\n')

const A = await openClient('A', 'assistant', 'assistant-3102-f43903a0', '虹猫')
const U = await openClient('user', 'user', undefined, undefined)
await sleep(200)

// 1. 玩家发场景事件（统一 event 消息）
console.log('[godot] 玩家发 event: user_said "你好"')
U.ws.send(JSON.stringify({ type: 'event', event: { kind: 'user_said', text: '你好' } }))

// 2. 等 LLM 事件流 + 可能的 say 指令
console.log('\n[godot] 等 30s，观察 llm_event 流 + command（say）...')
let sawLlmEvent = false
let sawChunk = false
let sawSayCommand = false
for (let i = 0; i < 30; i++) {
  await sleep(1000)
  const llm = A.inbox.filter(m => m.type === 'llm_event')
  const says = A.inbox.filter(m => m.type === 'command' && (m.command === 'say' || m.command === 'say_to'))
  if (llm.length > 0) sawLlmEvent = true
  if (llm.some(m => m.event?.type === 'chunk')) sawChunk = true
  if (says.length > 0) {
    sawSayCommand = true
    console.log(`  [t=${i + 1}s] 收到 say 指令: ${JSON.stringify(says[0]).slice(0, 200)}`)
    break
  }
  if (i === 4 || i === 9 || i === 19 || i === 29) {
    process.stdout.write(`  [t=${i + 1}s] llm_event=${llm.length} chunk=${sawChunk} say=${says.length}\n`)
  }
}

console.log('\n═══ 结果 ═══')
check('收到 llm_event 事件流', sawLlmEvent)
check('收到 chunk（文本流）', sawChunk)
check('LLM 调用了 say 指令', sawSayCommand)

const types = {}
for (const m of A.inbox.filter(x => x.type === 'llm_event')) {
  types[m.event?.type] = (types[m.event?.type] || 0) + 1
}
console.log(`\n  llm_event 类型分布: ${JSON.stringify(types)}`)
const cmdNames = A.inbox.filter(m => m.type === 'command').map(m => m.command)
console.log(`  收到的 command: ${JSON.stringify(cmdNames)}`)

console.log(`\n═══ ${pass} 通过 / ${fail} 失败 ═══`)
process.exit(fail === 0 ? 0 : 1)
