/**
 * 控制台 HTTP 服务器 — 注册中心 + 管理中心 + 配置中心
 *
 * 路由:
 *   GET  /                            → 管理界面 SPA
 *   GET  /api/health                  → 控制台健康检查 (公开)
 *   GET  /api/auth/key                → 当前 API Key 掩码与时间
 *   POST /api/auth/key/generate       → 生成新 API Key 并推送给在线助手
 *   GET  /api/assistants              → 列出所有助手
 *   GET  /api/assistants/:id          → 单个助手详情
 *   POST /api/assistants/spawn        → 创建助手 (spawn 新进程)
 *   POST /api/assistants/:id/restart  → 重新拉起 (同 sessionId, dsh resume 历史)
 *   GET  /api/assistants/:id/config   → 获取助手私有配置
 *   PUT  /api/assistants/:id/config   → 更新助手私有配置
 *   POST /api/register                → 助手启动时上报 (助手 → 控制台)
 *   POST /api/heartbeat/:id           → 助手心跳
 *   DELETE /api/unregister/:id        → 注销 (保留路由; 助手进程不再自动调用,
 *                                          由 stopHandler / 心跳扫描器 / 重启加载统一处理 offline)
 *   GET  /api/config                  → 获取公共配置
 *   PUT  /api/config                  → 更新公共配置
 *   GET  /api/config/resolve          → 合并后完整配置（助手拉取用）
 *   GET  /api/skills                  → 技能库列表
 *   GET  /api/skills/:name            → 获取单个技能正文（助手下发用）
 *   PUT  /api/skills/:name            → 新增/更新技能
 *
 * 除 GET / 与 GET /api/health 外，所有 /api/* 都需要平台 API Key。
 * Console 同时承担对外网关：/a/{sessionId}/* 代理到对应的助手进程。
 *
 * @module console/server
 */

import { createServer as createHttpServer, type Server } from 'node:http'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { Registry, type AssistantInfo, type ChannelEndpoint } from './registry.ts'
import { ApiKeyAuth } from './auth.ts'
import { ConsoleGateway, parseGatewayRoute } from './gateway.ts'
import { spawnAssistant, allocatePort } from './spawner.ts'
import {
  ConfigCenter,
  validateConfigPatch,
  validateSkillInput,
  AVAILABLE_CHANNELS,
  type AssistantConfigPatch,
} from './config.ts'
import { KnowledgeCenter, type ProposeInput } from './knowledge/index.ts'
import { TaskScheduler, type UpdateTaskInput } from './scheduler/index.ts'

// ── 心跳超时 ──────────────────────────────────────────────────────────────
// 心跳 15s 一拍; 三拍没回视为离线, 由后台扫描器转 offline (保留条目, restart 可 resume)。
const HEARTBEAT_TIMEOUT_MS = 45_000
const HEARTBEAT_SWEEP_INTERVAL_MS = 15_000

// ── 路径 ────────────────────────────────────────────────────────────────────

const SRC_DIR = dirname(fileURLToPath(import.meta.url))
const STATIC_DIR = resolve(SRC_DIR, 'static')
const SPA_PATH = resolve(STATIC_DIR, 'index.html')

// ── 类型 ────────────────────────────────────────────────────────────────────

export interface ConsoleConfig {
  host: string
  port: number
  name?: string
  /** 助手监听地址；默认 127.0.0.1，Console 自己可以绑 0.0.0.0 由 Nginx 访问。 */
  assistantHost?: string
  /** 定时任务 SQLite 路径；测试缺省使用内存库。 */
  schedulerPath?: string
  schedulerTickMs?: number
  schedulerRetryMs?: number
}

export interface ConsoleServer {
  server: Server
  scheduler: TaskScheduler
  dispose: () => Promise<void>
}

// ── 主入口 ──────────────────────────────────────────────────────────────────

export async function createConsoleServer(
  registry: Registry,
  configCenter: ConfigCenter,
  knowledgeCenter: KnowledgeCenter,
  auth: ApiKeyAuth,
  config: ConsoleConfig,
  onMutate: () => Promise<void>,
): Promise<ConsoleServer> {
  const localConsoleHost = config.host === '0.0.0.0' || config.host === '::' ? '127.0.0.1' : config.host
  const consoleUrl = `http://${localConsoleHost}:${config.port}`
  const scheduler = new TaskScheduler({
    path: config.schedulerPath ?? ':memory:',
    registry,
    tickMs: config.schedulerTickMs,
    retryMs: config.schedulerRetryMs,
  })
  // 由控制台 spawn 的子进程, 按端口索引 (端口唯一)
  const children = new Map<number, ChildProcess>()

  let gateway: ConsoleGateway
  const server = createHttpServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', `http://${config.host}:${config.port}`)
    const path = url.pathname
    const method = req.method ?? 'GET'

    res.setHeader('Access-Control-Allow-Origin', '*')
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS')
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-API-Key')

    if (method === 'OPTIONS') {
      res.writeHead(204); res.end(); return
    }

    // 鉴权：SPA、健康检查公开；/api/* 以及 /a/* 网关入口都使用同一把平台 Key。
    // /a/{sessionId}/ 根路径是助手聊天页静态壳，放行 HTML 本身，页面内的 API/WS 再校验 Key。
    const apiAuthRequired = path.startsWith('/api/') && path !== '/api/health'
    const gatewayRoute = path.startsWith('/a/') ? parseGatewayRoute(path) : null
    const publicAssistantIndex = method === 'GET'
      && gatewayRoute !== null
      && gatewayRoute.upstreamPath === '/'
    const gatewayAuthRequired = path.startsWith('/a/') && publicAssistantIndex === false
    if (apiAuthRequired || gatewayAuthRequired) {
      const authorized = gatewayAuthRequired
        ? auth.authorize(req)
        : authorizeConsoleApi(method, path, req)
      if (authorized === false) {
        json(res, 401, { error: 'unauthorized' })
        return
      }
    }

    try {
      await route(method, path, url, req, res)
    } catch (err) {
      console.error('[console] 请求处理错误:', err)
      if (!res.headersSent) json(res, 500, { error: 'internal error' })
    }
  })

  gateway = new ConsoleGateway({ server, registry, auth })

  /** 直接来自本机的请求；经过反向代理的请求会带 X-Forwarded-*，不视为本地。 */
  function isDirectLoopback(req: IncomingMessage): boolean {
    const forwarded = req.headers['x-forwarded-for'] ?? req.headers['x-real-ip']
    if (forwarded !== undefined) return false
    const address = req.socket.remoteAddress ?? ''
    return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1'
  }

  /** 助手访问 Console 的内部接口；本机直连可免 Key，远程仍需平台 Key。 */
  function isInternalApi(method: string, path: string): boolean {
    if (path === '/api/register') return true
    if (path.startsWith('/api/heartbeat/')) return true
    if (path === '/api/config/resolve') return true
    if (path.startsWith('/api/knowledge')) return true
    if (path.startsWith('/api/scheduled-tasks')) return true
    if (path === '/api/skills') return method === 'GET'
    if (path.startsWith('/api/skills/')) return method === 'GET'
    return false
  }

  function authorizeConsoleApi(method: string, path: string, req: IncomingMessage): boolean {
    if (isInternalApi(method, path) && isDirectLoopback(req)) return true
    return auth.authorize(req)
  }

  // ── 路由分发 ──────────────────────────────────────────────────────────────

  async function route(
    method: string,
    path: string,
    url: URL,
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    // 根路径 → SPA
    if (method === 'GET' && path === '/') return serveSpa(res)

    // 助手网关：/a/{sessionId}/... → 对应助手进程
    if (path.startsWith('/a/')) {
      await gateway.handleHttp(req, res, url)
      return
    }

    // 健康检查（liveness）：除 HTTP 存活外，带上 pid/uptime，
    // 供外部守护进程校验 200 确实来自本进程，避免端口被其他服务占用时误判健康。
    if (method === 'GET' && path === '/api/health') {
      return json(res, 200, {
        ok: true,
        name: config.name ?? '控制台',
        assistantCount: registry.list().length,
        pid: process.pid,
        uptimeSeconds: Math.round(process.uptime()),
      })
    }

    // ── 鉴权 Key ────────────────────────────────────────────────────────────
    if (method === 'GET' && path === '/api/auth/key') {
      return json(res, 200, {
        configured: true,
        maskedKey: auth.maskedKey(),
        createdAt: auth.createdAt(),
        updatedAt: auth.updatedAt(),
      })
    }
    if (method === 'POST' && path === '/api/auth/key/generate') {
      return rotateApiKey(res)
    }

    // ── 配置中心 ──────────────────────────────────────────────────────────
    if (method === 'GET' && path === '/api/config') {
      return json(res, 200, configCenter.publicConfig())
    }
    if (method === 'PUT' && path === '/api/config') {
      return putPublicConfig(req, res)
    }
    if (method === 'GET' && path === '/api/config/resolve') {
      return resolveConfigHandler(url, res)
    }

    // ── 技能库 ────────────────────────────────────────────────────────────
    if (method === 'GET' && path === '/api/skills') {
      return json(res, 200, configCenter.listSkills())
    }
    const skillMatch = path.match(/^\/api\/skills\/([^/]+)$/)
    if (skillMatch) {
      const skillName = decodeURIComponent(skillMatch[1])
      if (method === 'GET') return getSkillHandler(skillName, res)
      if (method === 'PUT') return putSkillHandler(skillName, req, res)
    }

    // ── 公共知识库 ────────────────────────────────────────────────────────
    if (method === 'GET' && path === '/api/knowledge') {
      return listKnowledgeHandler(url, res)
    }
    if (method === 'GET' && path === '/api/knowledge/search') {
      return searchKnowledgeHandler(url, res)
    }
    if (method === 'POST' && path === '/api/knowledge/write') {
      return proposeKnowledgeHandler(req, res)
    }
    const knowledgeMatch = path.match(/^\/api\/knowledge\/([^/]+)$/)
    if (knowledgeMatch && method === 'GET') {
      return getKnowledgeHandler(decodeURIComponent(knowledgeMatch[1]), res)
    }

    // ── 全局持久任务调度 ──────────────────────────────────────────────────
    if (path === '/api/scheduled-tasks') {
      if (method === 'GET') return listScheduledTasksHandler(url, res)
      if (method === 'POST') return createScheduledTaskHandler(req, res)
    }
    const taskRunsMatch = path.match(/^\/api\/scheduled-tasks\/([^/]+)\/runs$/)
    if (taskRunsMatch && method === 'GET') {
      return listTaskRunsHandler(decodeURIComponent(taskRunsMatch[1]), url, res)
    }
    const taskRunMatch = path.match(/^\/api\/scheduled-tasks\/([^/]+)\/run$/)
    if (taskRunMatch && method === 'POST') {
      return runScheduledTaskHandler(decodeURIComponent(taskRunMatch[1]), url, res)
    }
    const scheduledTaskMatch = path.match(/^\/api\/scheduled-tasks\/([^/]+)$/)
    if (scheduledTaskMatch) {
      const id = decodeURIComponent(scheduledTaskMatch[1])
      if (method === 'GET') return getScheduledTaskHandler(id, url, res)
      if (method === 'PATCH') return patchScheduledTaskHandler(id, url, req, res)
      if (method === 'DELETE') return deleteScheduledTaskHandler(id, url, res)
    }

    // ── 助手注册中心 ──────────────────────────────────────────────────────
    if (method === 'GET' && path === '/api/assistants') {
      return json(res, 200, assistantList())
    }

    // 创建助手 (spawn)
    if (method === 'POST' && path === '/api/assistants/spawn') {
      return spawnHandler(req, res)
    }

    // 助手上报注册
    if (method === 'POST' && path === '/api/register') {
      return registerHandler(req, res)
    }

    // /api/assistants/:id/config 与 /api/assistants/:id/restart
    const assistantConfigMatch = path.match(/^\/api\/assistants\/([^/]+)\/config$/)
    if (assistantConfigMatch) {
      const id = decodeURIComponent(assistantConfigMatch[1])
      if (method === 'GET') return getAssistantConfigHandler(id, res)
      if (method === 'PUT') return putAssistantConfigHandler(id, req, res)
    }

    const restartMatch = path.match(/^\/api\/assistants\/([^/]+)\/restart$/)
    if (restartMatch && method === 'POST') {
      return restartHandler(decodeURIComponent(restartMatch[1]), res)
    }

    // 停止助手 (软停止: kill 进程, 保留注册与数据, 可重新拉起)
    const stopMatch = path.match(/^\/api\/assistants\/([^/]+)\/stop$/)
    if (stopMatch && method === 'POST') {
      return stopHandler(decodeURIComponent(stopMatch[1]), res)
    }

    // /api/assistants/:id (单个助手)
    const assistantsMatch = path.match(/^\/api\/assistants\/([^/]+)$/)
    if (assistantsMatch) {
      const id = decodeURIComponent(assistantsMatch[1])
      if (method === 'GET') return getOne(id, res)
    }

    const unregisterMatch = path.match(/^\/api\/unregister\/([^/]+)$/)
    if (unregisterMatch && method === 'DELETE') {
      return unregisterHandler(decodeURIComponent(unregisterMatch[1]), res)
    }

    const heartbeatMatch = path.match(/^\/api\/heartbeat\/([^/]+)$/)
    if (heartbeatMatch && method === 'POST') {
      return heartbeatHandler(decodeURIComponent(heartbeatMatch[1]), res)
    }

    return json(res, 404, { error: 'not found' })
  }

  // ── 配置中心处理器 ────────────────────────────────────────────────────────

  /**
   * 把某个（或全部）在线助手的有效配置信封推送到其 HTTP push 端点。
   * 助手是独立个体，交互一律 HTTP；这里只发通知，失败静默降级（助手重启时会重拉）。
   */
  async function pushConfigToAssistants(sessionId?: string): Promise<void> {
    const targets = registry.list().filter(info =>
      info.status === 'online' && (sessionId === undefined || info.sessionId === sessionId),
    )
    await Promise.all(targets.map(async (info) => {
      const envelope = configCenter.resolveEnvelope(info.sessionId)
      try {
        const res = await fetch(`http://${info.host}:${info.port}/api/config/push`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(envelope),
          signal: AbortSignal.timeout(2000),
        })
        if (!res.ok) {
          console.warn(`[console] 推送配置到助手 ${info.sessionId} 失败 (HTTP ${res.status})`)
        }
      } catch (err) {
        console.warn(`[console] 推送配置到助手 ${info.sessionId} 失败:`, err instanceof Error ? err.message : String(err))
      }
    }))
  }


  /** 重新生成平台 API Key。助手不走入站鉴权，因此无需推送即可继续工作。 */
  async function rotateApiKey(res: ServerResponse): Promise<void> {
    const newKey = await auth.rotate()
    return json(res, 200, {
      ok: true,
      apiKey: newKey,
      maskedKey: auth.maskedKey(),
      updatedAt: auth.updatedAt(),
    })
  }

  async function putPublicConfig(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const raw = await readJson(req)
    if (!raw) return json(res, 400, { error: 'invalid JSON body' })

    let patch: AssistantConfigPatch
    try {
      patch = validateConfigPatch(raw)
    } catch (err) {
      return json(res, 400, { error: errorMessage(err) })
    }
    if (Object.keys(patch).length === 0) {
      return json(res, 400, { error: 'config patch is empty' })
    }

    const result = configCenter.updatePublic(patch)
    // 公共冷字段变更会影响所有已有助手
    if (result.cold) {
      for (const info of registry.list()) configCenter.markPendingRestart(info.sessionId)
    }
    await configCenter.save()

    // 热字段即时下发到所有在线助手（冷字段走重启流程）
    void pushConfigToAssistants()

    return json(res, 200, {
      ok: true,
      cold: result.cold,
      public: result.public,
      pendingRestart: configCenter.listPendingRestart(),
    })
  }

  function resolveConfigHandler(url: URL, res: ServerResponse): void {
    const sessionId = url.searchParams.get('sessionId')
    if (!sessionId) return json(res, 400, { error: 'sessionId query parameter is required' })
    return json(res, 200, configCenter.resolveEnvelope(sessionId))
  }

  async function getAssistantConfigHandler(id: string, res: ServerResponse): Promise<void> {
    const sessionId = assistantSessionId(id)
    if (!sessionId) return json(res, 404, { error: 'assistant not found' })
    return json(res, 200, configCenter.assistantConfig(sessionId))
  }

  async function putAssistantConfigHandler(id: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
    const sessionId = assistantSessionId(id)
    if (!sessionId) return json(res, 404, { error: 'assistant not found' })

    const raw = await readJson(req)
    if (!raw) return json(res, 400, { error: 'invalid JSON body' })

    let patch: AssistantConfigPatch
    try {
      patch = validateConfigPatch(raw)
    } catch (err) {
      return json(res, 400, { error: errorMessage(err) })
    }
    if (Object.keys(patch).length === 0) {
      return json(res, 400, { error: 'config patch is empty' })
    }

    const result = configCenter.updateAssistant(sessionId, patch)
    if (result.cold) configCenter.markPendingRestart(sessionId)
    await configCenter.save()

    // 热字段即时下发给该助手（冷字段走重启流程）
    void pushConfigToAssistants(sessionId)

    return json(res, 200, {
      ok: true,
      cold: result.cold,
      private: result.private,
      resolved: configCenter.resolve(sessionId),
      pendingRestart: configCenter.isPendingRestart(sessionId),
    })
  }

  // ── 技能库处理器 ──────────────────────────────────────────────────────────

  function getSkillHandler(name: string, res: ServerResponse): void {
    const skill = configCenter.getSkill(name)
    if (!skill) return json(res, 404, { error: 'skill not found' })
    return json(res, 200, skill)
  }

  async function putSkillHandler(name: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
    const raw = await readJson(req)
    if (!raw) return json(res, 400, { error: 'invalid JSON body' })

    let skill
    try {
      skill = validateSkillInput(raw, name)
    } catch (err) {
      return json(res, 400, { error: errorMessage(err) })
    }

    const saved = configCenter.upsertSkill(skill)
    await configCenter.save()
    // 技能正文变更即时下发（助手按 skills 列表重拉正文并 diff）
    void pushConfigToAssistants()
    return json(res, 200, saved)
  }

  // ── 公共知识库处理器 ──────────────────────────────────────────────────────

  async function listKnowledgeHandler(url: URL, res: ServerResponse): Promise<void> {
    const tags = url.searchParams.getAll('tags')
      .flatMap(t => t.split(','))
      .map(s => s.trim())
      .filter(Boolean)
    const items = await knowledgeCenter.list(tags.length ? tags : undefined)
    return json(res, 200, { count: items.length, items })
  }

  async function searchKnowledgeHandler(url: URL, res: ServerResponse): Promise<void> {
    const q = url.searchParams.get('q')?.trim()
    if (!q) return json(res, 400, { error: 'q query parameter is required' })
    const results = await knowledgeCenter.search(q)
    return json(res, 200, {
      query: q,
      count: results.length,
      results: results.map(e => ({
        id: e.id,
        title: e.title,
        tags: e.tags,
        version: e.version,
        snippet: e.content.slice(0, 300),
        updated: e.updated,
      })),
    })
  }

  async function getKnowledgeHandler(id: string, res: ServerResponse): Promise<void> {
    const entry = await knowledgeCenter.get(id)
    if (!entry) return json(res, 404, { error: 'knowledge not found' })
    return json(res, 200, entry)
  }

  async function proposeKnowledgeHandler(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const raw = await readJson(req)
    if (!raw
      || typeof raw.title !== 'string'
      || typeof raw.content !== 'string'
      || typeof raw.assistantId !== 'string') {
      return json(res, 400, { error: 'title, content and assistantId are required' })
    }

    const input: ProposeInput = {
      title: raw.title,
      content: raw.content,
      assistantId: raw.assistantId,
    }
    if (typeof raw.id === 'string' && raw.id) input.id = raw.id
    if (Array.isArray(raw.tags)) {
      input.tags = raw.tags.filter(t => typeof t === 'string')
    }
    if (typeof raw.baseVersion === 'number' && Number.isInteger(raw.baseVersion)) {
      input.baseVersion = raw.baseVersion
    }

    const result = await knowledgeCenter.propose(input)
    if (result.ok) return json(res, 200, { ok: true, entry: result.entry })

    switch (result.error) {
      case 'locked':
        return json(res, 423, { ok: false, error: 'locked', holder: result.holder })
      case 'version_conflict':
        return json(res, 409, { ok: false, error: 'version_conflict', currentVersion: result.currentVersion })
      case 'not_found':
        return json(res, 404, { ok: false, error: 'not_found' })
    }
  }

  // ── 持久任务调度处理器 ──────────────────────────────────────────────────

  function ownerScope(url: URL, res: ServerResponse): string | null | undefined {
    const ownerSessionId = url.searchParams.get('creatorSessionId')
    if (ownerSessionId === null) return undefined
    if (!ownerSessionId || !registry.findBySessionId(ownerSessionId)) {
      json(res, 404, { error: 'assistant not found' })
      return null
    }
    return ownerSessionId
  }

  function listScheduledTasksHandler(url: URL, res: ServerResponse): void {
    const ownerSessionId = ownerScope(url, res)
    if (ownerSessionId === null) return
    const items = scheduler.listTasks(ownerSessionId)
    return json(res, 200, { count: items.length, items })
  }

  async function createScheduledTaskHandler(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await readJson(req)
    if (!body || typeof body.creatorSessionId !== 'string') {
      return json(res, 400, { error: 'creatorSessionId, title, prompt and schedule are required' })
    }
    const assistant = registry.findBySessionId(body.creatorSessionId)
    if (!assistant) return json(res, 404, { error: 'assistant not found' })
    try {
      const task = scheduler.createTask({
        ownerSessionId: assistant.sessionId,
        creatorName: assistant.name,
        title: body.title,
        prompt: body.prompt,
        schedule: body.schedule,
      })
      return json(res, 201, task)
    } catch (error) {
      return json(res, 400, { error: errorMessage(error) })
    }
  }

  function getScheduledTaskHandler(id: string, url: URL, res: ServerResponse): void {
    const ownerSessionId = ownerScope(url, res)
    if (ownerSessionId === null) return
    const task = scheduler.getTask(id, ownerSessionId)
    return task ? json(res, 200, task) : json(res, 404, { error: 'scheduled task not found' })
  }

  async function patchScheduledTaskHandler(id: string, url: URL, req: IncomingMessage, res: ServerResponse): Promise<void> {
    const ownerSessionId = ownerScope(url, res)
    if (ownerSessionId === null) return
    const body = await readJson(req)
    if (!body) return json(res, 400, { error: 'invalid JSON body' })
    const patch: UpdateTaskInput = {}
    if (body.title !== undefined) patch.title = body.title
    if (body.prompt !== undefined) patch.prompt = body.prompt
    if (body.schedule !== undefined) patch.schedule = body.schedule
    if (body.enabled !== undefined) {
      if (typeof body.enabled !== 'boolean') return json(res, 400, { error: 'enabled must be boolean' })
      patch.enabled = body.enabled
    }
    if (Object.keys(patch).length === 0) return json(res, 400, { error: 'task patch is empty' })
    try {
      const task = scheduler.updateTask(id, patch, ownerSessionId)
      return task ? json(res, 200, task) : json(res, 404, { error: 'scheduled task not found' })
    } catch (error) {
      return json(res, 400, { error: errorMessage(error) })
    }
  }

  function deleteScheduledTaskHandler(id: string, url: URL, res: ServerResponse): void {
    const ownerSessionId = ownerScope(url, res)
    if (ownerSessionId === null) return
    return scheduler.deleteTask(id, ownerSessionId)
      ? json(res, 200, { deleted: true })
      : json(res, 404, { error: 'scheduled task not found' })
  }

  function listTaskRunsHandler(id: string, url: URL, res: ServerResponse): void {
    const ownerSessionId = ownerScope(url, res)
    if (ownerSessionId === null) return
    const items = scheduler.listRuns(id, ownerSessionId)
    return items === null
      ? json(res, 404, { error: 'scheduled task not found' })
      : json(res, 200, { count: items.length, items })
  }

  async function runScheduledTaskHandler(id: string, url: URL, res: ServerResponse): Promise<void> {
    const ownerSessionId = ownerScope(url, res)
    if (ownerSessionId === null) return
    const run = await scheduler.runTaskNow(id, ownerSessionId)
    return run
      ? json(res, 202, run)
      : json(res, 404, { error: 'scheduled task not found' })
  }

  // ── 注册中心处理器 ────────────────────────────────────────────────────────

  async function registerHandler(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const payload = await readJson(req)
    if (!payload || typeof payload.name !== 'string' || typeof payload.port !== 'number') {
      return json(res, 400, { error: 'name and port are required' })
    }
    const child = children.get(payload.port)
    const info = registry.register({
      name: payload.name,
      host: payload.host ?? '127.0.0.1',
      port: payload.port,
      model: payload.model ?? 'unknown',
      provider: payload.provider ?? 'unknown',
      sessionId: typeof payload.sessionId === 'string' && payload.sessionId
        ? payload.sessionId
        : `assistant-${randomUUID().slice(0, 8)}`,
      channels: Array.isArray(payload.channels)
        ? payload.channels.filter((c: unknown) => typeof c === 'string')
        : undefined,
      channelEndpoints: parseChannelEndpoints(payload.channelEndpoints),
    }, child ? { pid: child.pid, spawnedByConsole: true } : {})
    await onMutate()
    console.log(`[console] 助手已注册: ${info.name} (${info.host}:${info.port}) session=${info.sessionId}`)
    return json(res, 201, { id: info.id, registered: true, registeredAt: info.registeredAt })
  }

  async function unregisterHandler(id: string, res: ServerResponse): Promise<void> {
    const info = registry.get(id)
    if (!info) return json(res, 404, { error: 'assistant not found' })
    const ok = registry.unregister(id)
    if (!ok) return json(res, 404, { error: 'assistant not found' })
    await onMutate()
    console.log(`[console] 助手已注销: ${id}`)
    return json(res, 200, { unregistered: true })
  }

  async function heartbeatHandler(id: string, res: ServerResponse): Promise<void> {
    const info = registry.heartbeat(id)
    if (!info) return json(res, 404, { error: 'assistant not found' })
    return json(res, 200, { ok: true, lastHeartbeat: info.lastHeartbeat })
  }

  function getOne(id: string, res: ServerResponse): void {
    const info = findAssistant(id)
    if (!info) return json(res, 404, { error: 'assistant not found' })
    return json(res, 200, withPendingRestart(info))
  }

  async function spawnHandler(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await readJson(req)
    if (!body || typeof body.name !== 'string' || !body.name.trim()) {
      return json(res, 400, { error: 'name is required' })
    }

    const name = body.name.trim()
    const port = typeof body.port === 'number' && body.port > 0
      ? body.port
      : allocatePort(registry.usedPorts())
    const sessionId = `assistant-${randomUUID().slice(0, 8)}`
    const publicCfg = configCenter.publicConfig()

    const model = typeof body.model === 'string' && body.model
      ? body.model
      : publicCfg.model ?? 'deepseek-v4-flash'
    const provider = typeof body.provider === 'string' && body.provider
      ? body.provider
      : publicCfg.provider ?? 'deepseek-official'
    const persona = typeof body.persona === 'string'
      ? body.persona
      : publicCfg.persona
    const maxTokens = typeof body.maxTokens === 'number' && body.maxTokens > 0
      ? body.maxTokens
      : publicCfg.maxTokens
    const channels = Array.isArray(body.channels)
      ? body.channels.filter((c: unknown) => typeof c === 'string')
      : (publicCfg.channels ?? [...AVAILABLE_CHANNELS])

    try {
      const { pid, child } = spawnAssistant({
        name,
        port,
        host: config.assistantHost ?? '127.0.0.1',
        model,
        provider,
        consoleUrl,
        persona,
        sessionId,
        maxTokens,
        channels,
      })
      trackChild(port, child)

      // 显式传入的创建参数落成该助手的私有覆盖项，后续在配置中心可继续编辑。
      const privatePatch: AssistantConfigPatch = {}
      if (typeof body.model === 'string') privatePatch.model = body.model
      if (typeof body.provider === 'string') privatePatch.provider = body.provider
      if (typeof body.persona === 'string') privatePatch.persona = body.persona
      if (typeof body.maxTokens === 'number') privatePatch.maxTokens = body.maxTokens
      if (Object.keys(privatePatch).length > 0) {
        configCenter.updateAssistant(sessionId, privatePatch)
        await configCenter.save()
      }

      console.log(`[console] 已 spawn 助手: ${name} (port ${port}, pid ${pid}, session=${sessionId})`)
      // 注册表条目将在助手上报 /api/register 时建立
      return json(res, 201, { name, port, pid, sessionId, status: 'starting' })
    } catch (err) {
      console.error('[console] spawn 失败:', err)
      return json(res, 500, { error: 'spawn failed' })
    }
  }

  async function restartHandler(id: string, res: ServerResponse): Promise<void> {
    const info = findAssistant(id)
    if (!info) return json(res, 404, { error: 'assistant not found' })

    // 「重新拉起」: 停掉在跑的进程 (若有), 以同一 sessionId 重新 spawn → dsh resume 历史会话。
    // 不要求 spawnedByConsole/child 存在: 停止过的助手 (offline) 也能拉起。
    const child = children.get(info.port)
    if (child) {
      await stopChild(child)
      children.delete(info.port)
    }

    // 若旧的 registry 条目还活着 (在线但进程是外部启动的), 先注销避免注册竞态
    if (info.status === 'online') {
      registry.unregister(info.id)
      await onMutate()
    }

    const resolved = configCenter.resolve(info.sessionId)
    const { pid, child: newChild } = spawnAssistant({
      name: info.name,
      port: info.port,
      host: config.assistantHost ?? info.host ?? '127.0.0.1',
      model: String(resolved.model ?? info.model ?? 'deepseek-v4-flash'),
      provider: String(resolved.provider ?? info.provider ?? 'deepseek-official'),
      consoleUrl,
      persona: resolved.persona,
      sessionId: info.sessionId,
      maxTokens: resolved.maxTokens,
      channels: resolved.channels ?? [...AVAILABLE_CHANNELS],
    })
    trackChild(info.port, newChild)
    configCenter.clearPendingRestart(info.sessionId)

    console.log(`[console] 助手已拉起: ${info.name} (port ${info.port}, pid ${pid}, session=${info.sessionId})`)
    return json(res, 200, {
      ok: true,
      started: true,
      port: info.port,
      pid,
      sessionId: info.sessionId,
      pendingRestart: false,
    })
  }

  async function stopHandler(id: string, res: ServerResponse): Promise<void> {
    const info = findAssistant(id)
    if (!info) return json(res, 404, { error: 'assistant not found' })

    // 软停止: kill 进程 + 标记 offline, 保留 registry + json + 磁盘数据 (可重新拉起 resume)
    const child = children.get(info.port)
    if (child) {
      await stopChild(child)
      children.delete(info.port)
    }

    info.status = 'offline'
    await onMutate()
    console.log(`[console] 助手已停止: ${info.name} (session=${info.sessionId})`)
    return json(res, 200, { stopped: true, sessionId: info.sessionId })
  }

  // ── 辅助函数 ──────────────────────────────────────────────────────────────

  function assistantSessionId(id: string): string | null {
    const registered = findAssistant(id)
    if (registered) return registered.sessionId
    // 兼容直接使用 sessionId 访问（配置中心的 key 就是 sessionId），
    // 仅当该 sessionId 下确实已经存在私有配置时生效。
    return Object.keys(configCenter.assistantConfig(id)).length > 0 ? id : null
  }

  function findAssistant(id: string): AssistantInfo | null {
    return registry.get(id) ?? registry.findBySessionId(id)
  }

  function withPendingRestart(info: AssistantInfo): AssistantInfo & { pendingRestart: boolean } {
    const resolved = configCenter.resolve(info.sessionId)
    return {
      ...info,
      model: resolved.model ?? info.model,
      provider: resolved.provider ?? info.provider,
      pendingRestart: configCenter.isPendingRestart(info.sessionId),
    }
  }

  function assistantList(): Array<AssistantInfo & { pendingRestart: boolean; gatewayBase: string; gatewayWsPath: string }> {
    return registry.list().map(info => ({
      ...withPendingRestart(info),
      gatewayBase: `/a/${encodeURIComponent(info.sessionId)}`,
      gatewayWsPath: `/a/${encodeURIComponent(info.sessionId)}/ws`,
    }))
  }

  function parseChannelEndpoints(value: unknown): ChannelEndpoint[] | undefined {
    if (!Array.isArray(value)) return undefined
    return value.flatMap(item => {
      if (!item || typeof item !== 'object') return []
      const endpoint = item as Record<string, unknown>
      if (typeof endpoint.id !== 'string' || (endpoint.protocol !== 'http' && endpoint.protocol !== 'ws') ||
        typeof endpoint.host !== 'string' || typeof endpoint.port !== 'number' || typeof endpoint.path !== 'string') return []
      return [{ id: endpoint.id, protocol: endpoint.protocol, host: endpoint.host, port: endpoint.port, path: endpoint.path }]
    })
  }

  function trackChild(port: number, child: ChildProcess): void {
    children.set(port, child)
    child.once('exit', () => {
      if (children.get(port) === child) children.delete(port)
    })
  }

  async function stopChild(child: ChildProcess): Promise<void> {
    if (child.exitCode !== null || child.signalCode !== null) return
    child.kill('SIGTERM')
    await Promise.race([once(child, 'exit'), delay(3000)])
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL')
      await once(child, 'exit')
    }
  }

  async function serveSpa(res: ServerResponse): Promise<void> {
    try {
      const html = await readFile(SPA_PATH, 'utf-8')
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end(html)
    } catch {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end('<!DOCTYPE html><html><head><meta charset="UTF-8"><title>控制台</title></head><body><h1>控制台已就绪</h1></body></html>')
    }
  }

  // ── 启动 ──────────────────────────────────────────────────────────────────

  await new Promise<void>((resolveListen, rejectListen) => {
    server.listen(config.port, config.host, () => resolveListen())
    server.on('error', rejectListen)
  })

  // 心跳超时扫描: 进程崩溃 / 强杀等"没走 stopHandler"的场景, 由扫描器把超阈值的
  // online 条目转 offline (保留, 不删, 便于 restart resume)。这是新的离线兜底,
  // 替代旧的"助手退出自动 DELETE /api/unregister"路径 (那条路径与 stopHandler race)。
  const heartbeatSweep = setInterval(() => {
    const cutoff = Date.now() - HEARTBEAT_TIMEOUT_MS
    let dirty = false
    for (const info of registry.list()) {
      if (info.status !== 'online') continue
      if (Date.parse(info.lastHeartbeat) > cutoff) continue
      info.status = 'offline'
      dirty = true
      console.log(`[console] 心跳超时, 标记离线: ${info.name} (${info.id})`)
    }
    if (dirty) {
      onMutate().catch((err) =>
        console.warn('[console] heartbeat-sweep 持久化失败:', err instanceof Error ? err.message : String(err)),
      )
    }
  }, HEARTBEAT_SWEEP_INTERVAL_MS)
  heartbeatSweep.unref?.()

  return {
    server,
    scheduler,
    dispose: async () => {
      clearInterval(heartbeatSweep)
      gateway.dispose()
      await scheduler.dispose()
      // 停止所有由控制台 spawn 的助手
      for (const child of children.values()) {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM')
      }
      await new Promise<void>(r => server.close(() => r()))
    },
  }
}

// ── 工具函数 ────────────────────────────────────────────────────────────────

function json(res: ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(data))
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function readJson(req: IncomingMessage): Promise<Record<string, any> | null> {
  return new Promise((resolveRead) => {
    let body = ''
    req.on('data', (chunk: Buffer) => { body += chunk.toString() })
    req.on('end', () => {
      if (!body.trim()) return resolveRead(null)
      try { resolveRead(JSON.parse(body)) } catch { resolveRead(null) }
    })
  })
}
