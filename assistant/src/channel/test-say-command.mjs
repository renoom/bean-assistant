/**
 * 验证 say 指令链路（B 方案：指令集注入系统提示词）。
 * 用真实 Godot 的完整指令集（SUPPORTED_COMMANDS），明确命令 LLM 调用 say。
 */

import { WebSocket } from 'ws'

const URL = 'ws://127.0.0.1:3102/ws'

// 与 assistant-godot/scenes/main.gd 的 SUPPORTED_COMMANDS 一致的完整指令集
const COMMANDS = [
  {
    name: 'create_scene',
    description: '创建或覆盖一个场景（不切过去）。背景为空则中性底色。',
    parameters: { type: 'object', properties: { sceneId: { type: 'string', required: true }, name: { type: 'string' }, background: { type: 'string' } } },
    returns: '{ok:true, result:{sceneId}}',
    example: { sceneId: 'beach', name: '海滩', background: '/data/scenes/beach.png' },
  },
  {
    name: 'switch_scene',
    description: '切换到指定场景（必须先 create_scene 创建）。',
    parameters: { type: 'object', properties: { sceneId: { type: 'string', required: true } } },
    returns: '{ok:true, result:{sceneId}}',
    example: { sceneId: 'beach' },
  },
  {
    name: 'add_object',
    description: '在场景里新增/替换一个可交互物件。image 是贴图路径（可填 draw_image 生成的图）。',
    parameters: { type: 'object', properties: { objectId: { type: 'string', required: true }, image: { type: 'string' }, x: { type: 'number' }, y: { type: 'number' }, size: { type: 'number' }, actions: { type: 'object' }, sceneId: { type: 'string' } } },
    returns: '{ok:true, result:{objectId}}',
    example: { objectId: 'sword', image: '/data/items/sword.png', x: 0.7, y: 0.6, size: 240 },
  },
  {
    name: 'say',
    description: '在场景里公开说话给所有人听。玩家只能在画面里看到你调用 say/say_to 渲染出的气泡，直接生成的文字不进画面，所以要说出口就用本指令。',
    parameters: { type: 'object', properties: { text: { type: 'string', required: true, description: '要说的话，会显示在气泡里' } } },
    returns: '{ok:true, result:{}}',
    example: { text: '大家好，我是虹猫' },
  },
  {
    name: 'say_to',
    description: '定向对场景里的某个助手或玩家说话。target 省略或 user = 对玩家说；target=assistantId = 私聊那个助手。',
    parameters: { type: 'object', properties: { target: { type: 'string', description: '目标 id。省略/user = 对玩家说；否则是某助手的 assistantId' }, text: { type: 'string', required: true, description: '要说的话' } } },
    returns: '{ok:true, result:{}}',
    example: { target: 'blue_rabbit', text: '我们私聊一下' },
  },
]

function openClient(clientId, role, assistantId, name) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(URL)
    const inbox = []
    ws.on('open', () => {
      ws.send(JSON.stringify({
        type: 'hello', clientId, role,
        assistantId: role === 'assistant' ? assistantId : undefined,
        name: role === 'assistant' ? name : undefined,
        commands: role === 'assistant' ? COMMANDS : [],
      }))
    })
    ws.on('message', (raw) => {
      const m = JSON.parse(raw.toString())
      inbox.push(m)
      if (m.type === 'hello_ack') resolve({ ws, inbox })
    })
    ws.on('error', reject)
    setTimeout(() => reject(new Error(`${clientId} timeout`)), 5000)
  })
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms))

let pass = 0, fail = 0
function check(label, ok) { ok ? (pass++, console.log(`  ✓ ${label}`)) : (fail++, console.log(`  ✗ ${label}`)) }

console.log('═══ 验证 say 指令链路（B 方案）═══\n')

const A = await openClient('A', 'assistant', 'assistant-3102-f43903a0', '虹猫')
const U = await openClient('user', 'user', undefined, undefined)
await sleep(200)

const cmd = '请调用 say 指令，把「你好，我是虹猫」这句话说出去。'
console.log(`[godot] 玩家发 event，明确命令调 say:\n  "${cmd}"`)
U.ws.send(JSON.stringify({ type: 'event', event: { kind: 'user_said', text: cmd } }))

console.log('\n[godot] 等 40s 看是否收到 say 指令...')
let sayCmd = null
for (let i = 0; i < 40; i++) {
  await sleep(1000)
  const says = A.inbox.filter(m => m.type === 'command' && (m.command === 'say' || m.command === 'say_to'))
  if (says.length > 0) { sayCmd = says[0]; break }
  if (i % 5 === 4) process.stdout.write(`  [t=${i + 1}s] say 指令数=${says.length}\n`)
}

console.log('\n═══ 结果 ═══')
if (sayCmd) {
  console.log(`  收到 say 指令: ${JSON.stringify(sayCmd)}`)
  const args = sayCmd.args || {}
  check('LLM 调用了 say 指令', true)
  check('args 里有 text', typeof args.text === 'string' && args.text.length > 0)
  console.log(`  say 的 text 内容: "${args.text}"`)
} else {
  check('LLM 调用了 say 指令', false)
}

const toolCalls = A.inbox.filter(m => m.type === 'llm_event' && m.event?.type === 'tool_call')
console.log(`\n  LLM 的 tool_call 事件: ${toolCalls.length} 条`)
for (const t of toolCalls) console.log(`    tool: ${t.event.data?.name}, args: ${JSON.stringify(t.event.data?.arguments || {}).slice(0, 200)}`)

console.log(`\n═══ ${pass} 通过 / ${fail} 失败 ═══`)
process.exit(fail === 0 ? 0 : 1)
