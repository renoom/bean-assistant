/**
 * 公共知识库 Agent 工具
 *
 * 提供 4 个工具给 Agent 使用:
 *   search_knowledge — 搜索公共知识库
 *   get_knowledge    — 读取单条公共知识
 *   list_knowledge   — 列出公共知识库
 *   propose_knowledge— 申请写入公共知识 (经控制台加锁 + 版本校验)
 *
 * 与私有记忆工具 (memory/tools.ts) 的边界:
 *   - 私有记忆: 助手自己的, 直接读写本地 data/memories/{sessionId}/
 *   - 公共知识: 全体共享, 经控制台 HTTP 访问; 写走申请 + 锁
 *
 * @module assistant/knowledge/tools
 */

import type { Context } from '@deepseek-ai/cordis'
import type { JsonValue } from '@deepseek-ai/dsh-session'
import { defineTool } from '@deepseek-ai/dsh-tools'
import {
  knowledgeAvailable,
  searchKnowledge,
  getKnowledge,
  listKnowledge,
  proposeKnowledge,
} from './client.js'

export interface KnowledgeToolConfig {
  consoleUrl?: string
  sessionId: string
}

/** 注册公共知识库工具到 Agent 的 scoped context。 */
export function registerKnowledgeTools(ctx: Context, config: KnowledgeToolConfig): void {
  const tools = ctx.tools
  const consoleUrl = config.consoleUrl

  // 1. search_knowledge — 搜索
  tools.register(defineTool({
    name: 'search_knowledge',
    description:
      '搜索公共知识库。公共知识由全体助手共享, 只读。' +
      '当你需要查阅团队/平台级的公共知识时使用。',
    parameters: {
      query: {
        type: 'string',
        required: true,
        description: '搜索关键词或短语',
      },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => {
        if (!value.ok) return [{ type: 'text', text: `⚠️ ${value.message}` }]
        const count = value.count as number
        if (count === 0) return [{ type: 'text', text: '🔍 公共知识库未找到相关条目' }]
        const results = value.results as Array<{ title: string; id: string; snippet: string }>
        const lines = results.map(r => `- ${r.title} (\`${r.id}\`)\n    ${r.snippet}`)
        return [{ type: 'text', text: `🔍 公共知识库找到 ${count} 条:\n${lines.join('\n')}` }]
      },
    },
    async execute(args): Promise<Record<string, JsonValue>> {
      if (!knowledgeAvailable(consoleUrl)) {
        return { ok: false, message: '未连接控制台, 公共知识库不可用', count: 0, results: [] }
      }
      try {
        const data = await searchKnowledge(consoleUrl, args.query)
        return {
          ok: true,
          message: '',
          count: data.count,
          results: data.results.map(r => ({
            id: r.id, title: r.title, tags: r.tags, version: r.version, snippet: r.snippet ?? '',
          })),
        }
      } catch (err) {
        return { ok: false, message: `公共知识库查询失败: ${(err as Error).message}`, count: 0, results: [] }
      }
    },
  }))

  // 2. get_knowledge — 读单条
  tools.register(defineTool({
    name: 'get_knowledge',
    description: '读取公共知识库中的单条知识全文。',
    parameters: {
      id: {
        type: 'string',
        required: true,
        description: '知识条目 ID (从 search_knowledge 或 list_knowledge 获取)',
      },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => {
        if (!value.ok) return [{ type: 'text', text: `⚠️ ${value.message}` }]
        return [{ type: 'text', text: `📖 ${value.title} (v${value.version})\n\n${value.content}` }]
      },
    },
    async execute(args): Promise<Record<string, JsonValue>> {
      if (!knowledgeAvailable(consoleUrl)) {
        return { ok: false, message: '未连接控制台, 公共知识库不可用' }
      }
      try {
        const entry = await getKnowledge(consoleUrl, args.id)
        return {
          ok: true,
          message: '',
          id: entry.id,
          title: entry.title,
          version: entry.version,
          tags: entry.tags,
          author: entry.author,
          content: entry.content,
        }
      } catch {
        return { ok: false, message: '未找到该知识条目' }
      }
    },
  }))

  // 3. list_knowledge — 列出
  tools.register(defineTool({
    name: 'list_knowledge',
    description: '列出公共知识库所有条目, 可选按标签过滤。',
    parameters: {
      tags: {
        type: 'array',
        items: { type: 'string' },
        description: '可选, 按标签过滤',
      },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => {
        if (!value.ok) return [{ type: 'text', text: `⚠️ ${value.message}` }]
        const count = value.count as number
        if (count === 0) return [{ type: 'text', text: '📚 公共知识库为空' }]
        const items = value.items as Array<{ title: string; tags: string[]; version: number }>
        const lines = items.map(i => `- ${i.title} [${i.tags.join(', ')}] (v${i.version})`)
        return [{ type: 'text', text: `📚 公共知识库共 ${count} 条:\n${lines.join('\n')}` }]
      },
    },
    async execute(args): Promise<Record<string, JsonValue>> {
      if (!knowledgeAvailable(consoleUrl)) {
        return { ok: false, message: '未连接控制台, 公共知识库不可用', count: 0, items: [] }
      }
      try {
        const data = await listKnowledge(consoleUrl, args.tags)
        return {
          ok: true,
          message: '',
          count: data.count,
          items: data.items.map(i => ({ id: i.id, title: i.title, tags: i.tags, version: i.version })),
        }
      } catch (err) {
        return { ok: false, message: `公共知识库查询失败: ${(err as Error).message}`, count: 0, items: [] }
      }
    },
  }))

  // 4. propose_knowledge — 申请写入
  tools.register(defineTool({
    name: 'propose_knowledge',
    description:
      '向控制台申请写入一条公共知识。控制台会加锁并做版本校验, ' +
      '同一时间同一份知识只能由一个助手更新。' +
      '更新已有知识时需带上 id 和 baseVersion (从 get_knowledge 获取)。',
    parameters: {
      id: {
        type: 'string',
        description: '已有知识条目 ID (更新时必填, 新建时省略)',
      },
      title: {
        type: 'string',
        required: true,
        description: '知识标题',
      },
      content: {
        type: 'string',
        required: true,
        description: '知识正文 (Markdown)',
      },
      tags: {
        type: 'array',
        items: { type: 'string' },
        description: '标签列表',
      },
      baseVersion: {
        type: 'number',
        description: '更新时的基准版本号 (从 get_knowledge 获取), 防止覆盖他人修改',
      },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => {
        if (value.ok) return [{ type: 'text', text: `✅ 已写入公共知识库: ${value.title} (v${value.version})` }]
        switch (value.error) {
          case 'offline': return [{ type: 'text', text: '⚠️ 未连接控制台, 公共知识库不可用' }]
          case 'locked': return [{ type: 'text', text: `🔒 该知识正被 ${value.holder} 更新, 请稍后重试` }]
          case 'version_conflict': return [{ type: 'text', text: `⚠️ 版本冲突 (当前 v${value.currentVersion}), 请重新读取后再提交` }]
          case 'not_found': return [{ type: 'text', text: '⚠️ 未找到该知识条目' }]
          default: return [{ type: 'text', text: `⚠️ 写入失败: ${value.error}` }]
        }
      },
    },
    async execute(args): Promise<Record<string, JsonValue>> {
      if (!knowledgeAvailable(consoleUrl)) {
        return { ok: false, error: 'offline', title: '', version: 0, holder: '', currentVersion: 0 }
      }
      const outcome = await proposeKnowledge(consoleUrl, config.sessionId, {
        id: typeof args.id === 'string' ? args.id : undefined,
        title: args.title,
        content: args.content,
        tags: args.tags,
        baseVersion: typeof args.baseVersion === 'number' ? args.baseVersion : undefined,
      })
      if (outcome.ok) {
        return { ok: true, error: '', title: outcome.entry!.title, version: outcome.entry!.version, holder: '', currentVersion: 0 }
      }
      return {
        ok: false,
        error: outcome.error ?? 'http',
        title: '',
        version: 0,
        holder: outcome.holder ?? '',
        currentVersion: outcome.currentVersion ?? 0,
      }
    },
  }))
}
