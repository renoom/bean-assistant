#!/usr/bin/env node
/**
 * AI 助手控制台 — 启动入口
 *
 * 控制台是注册中心 + 管理中心 + 配置中心。启动后:
 *   1. 加载已持久化的助手元数据 (data/assistants.json)
 *   2. 启动 HTTP 服务器 (管理界面 + 注册/管理 API)
 *   3. 助手进程启动后 POST /api/register 上报注册
 *   4. 通过管理界面可 spawn 新的助手进程
 *
 * 用法:
 *   node lib/bin.js --port 3000
 *   tsx src/bin.ts --port 3000
 *
 * @module console/bin
 */

import { resolve, dirname } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { Registry } from './registry.ts'
import { setDataFile, loadAssistants, saveAssistants } from './store.ts'
import { ConfigCenter, loadConfig, setConfigFile } from './config.ts'
import { KnowledgeCenter } from './knowledge/index.ts'
import { KnowledgeStore } from './knowledge/store.ts'
import { ApiKeyAuth, maskApiKey } from './auth.ts'
import { createConsoleServer } from './server.ts'

// ── 路径 ────────────────────────────────────────────────────────────────────

// 控制台专属目录：所有控制台文件都写在 ~/.assistant/console/ 下，
// 与助手目录（~/.assistant/assistants/{sessionId}/）完全隔离，互不触碰。
const CONSOLE_DATA_DIR = resolve(homedir(), '.assistant', 'console')
const DATA_FILE = resolve(CONSOLE_DATA_DIR, 'assistants.json')
const CONFIG_FILE = resolve(CONSOLE_DATA_DIR, 'config.json')
const KNOWLEDGE_DIR = resolve(CONSOLE_DATA_DIR, 'knowledge')
const API_KEY_FILE = resolve(CONSOLE_DATA_DIR, 'api-key.json')
const SCHEDULER_FILE = resolve(CONSOLE_DATA_DIR, 'scheduler.sqlite')

// ── CLI 参数 ────────────────────────────────────────────────────────────────

interface ConsoleArgs {
  port: number
  host: string
  assistantHost: string
  name: string
}

function parseArgs(argv: string[]): ConsoleArgs {
  const args: ConsoleArgs = {
    port: 3000,
    host: '0.0.0.0',
    assistantHost: '127.0.0.1',
    name: 'AI 助手控制台',
  }
  for (let i = 0; i < argv.length; i++) {
    const val = argv[i + 1]
    switch (argv[i]) {
      case '--port': args.port = parseInt(val, 10); i++; break
      case '--host': args.host = val; i++; break
      case '--assistant-host': args.assistantHost = val; i++; break
      case '--name': args.name = val; i++; break
      case '--help':
        console.log('用法: console [选项]')
        console.log('  --port <port>  HTTP 端口 (默认: 3000)')
        console.log('  --host <host>  Console / 网关监听地址 (默认: 0.0.0.0)')
        console.log('  --assistant-host <host>  助手监听地址 (默认: 127.0.0.1，只允许网关/本机访问)')
        console.log('  --name <name>  控制台名称')
        process.exit(0)
    }
  }
  return args
}

// ── 主入口 ──────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const cliArgs = parseArgs(process.argv.slice(2))

  // 1. 设置数据文件并加载历史助手 (标记为 offline)
  setDataFile(DATA_FILE)
  setConfigFile(CONFIG_FILE)
  const registry = new Registry()
  const configCenter = new ConfigCenter(await loadConfig())
  // 首次启动时落盘一份缺省公共配置，保证 data/config.json 存在
  await configCenter.save()
  const knowledgeCenter = new KnowledgeCenter(new KnowledgeStore(KNOWLEDGE_DIR))

  // 鉴权：平台 API Key。首次启动自动生成并打印一次；之后只打印掩码。
  const { auth: apiKeyAuth, created: apiKeyCreated } = await ApiKeyAuth.load(API_KEY_FILE)
  if (apiKeyCreated) {
    console.log('')
    console.log('┌──────────────────────────────────────────────────────────────┐')
    console.log('│  已生成平台 API Key，请立即保存：                            │')
    console.log(`│  ${apiKeyAuth.currentKey()}`)
    console.log('└──────────────────────────────────────────────────────────────┘')
    console.log('')
  } else {
    console.log(`[console] 平台 API Key: ${maskApiKey(apiKeyAuth.currentKey())}`)
  }

  const persisted = await loadAssistants()
  for (const a of persisted) {
    registry.register({
      name: a.name,
      host: a.host,
      port: a.port,
      model: a.model,
      provider: a.provider,
      sessionId: a.sessionId,
      channels: a.channels,
      channelEndpoints: a.channelEndpoints,
    }, { id: a.id, pid: a.pid, spawnedByConsole: a.spawnedByConsole })
    // 历史条目恢复为 offline
    const info = registry.findBySessionId(a.sessionId)
    if (info) info.status = 'offline'
  }

  // 2. 启动 HTTP 服务器
  const onMutate = () => saveAssistants(registry.list())
  const { server, dispose } = await createConsoleServer(
    registry,
    configCenter,
    knowledgeCenter,
    apiKeyAuth,
    { ...cliArgs, schedulerPath: SCHEDULER_FILE },
    onMutate,
  )

  console.log(`[console] ${cliArgs.name} 已启动: http://${cliArgs.host}:${cliArgs.port}`)
  console.log(`[console] 数据文件: ${DATA_FILE}`)
  console.log(`[console] 配置文件: ${CONFIG_FILE}`)
  console.log(`[console] 调度数据库: ${SCHEDULER_FILE}`)
  console.log(`[console] 打开浏览器访问 ↑ 进入管理界面`)

  // 3. 优雅关闭
  let exiting = false
  const shutdown = async () => {
    if (exiting) return
    exiting = true
    console.log('\n[console] 正在关闭...')
    await dispose()
    await saveAssistants(registry.list())
    await configCenter.save()
    process.exit(0)
  }
  process.on('SIGTERM', shutdown)
  process.on('SIGINT', shutdown)
}

main().catch((error) => {
  console.error('[console] 启动失败:', error instanceof Error ? error.message : String(error))
  process.exit(1)
})
