/**
 * 记忆系统 Agent 工具
 *
 * 提供 5 个工具给 Agent 使用:
 *   remember       — 创建新记忆
 *   recall         — 搜索记忆
 *   list_memories  — 列出所有记忆
 *   forget         — 删除记忆
 *   update_memory  — 更新记忆
 *
 * @module assistant/memory/tools
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import {
  createMemory,
  searchMemories,
  listMemories,
  deleteMemory,
  updateMemory,
  getMemory,
} from './store.js'

// ── 注册所有记忆工具 ──────────────────────────────────────────────────────

export function registerMemoryTools(ctx: Context): void {
  // 直接在 agent-scoped context 上注册工具
  const tools = ctx.tools

  // 1. remember — 创建新记忆
  tools.register(defineTool({
      name: 'remember',
      description:
        '创建一条新的记忆。当你学到重要信息、用户告诉了你偏好、' +
        '或者需要记住某些上下文时，使用此工具。',
      parameters: {
        title: {
          type: 'string',
          required: true,
          description: '记忆标题，简洁描述记忆内容',
        },
        content: {
          type: 'string',
          required: true,
          description: '记忆内容，Markdown 格式，包含完整信息',
        },
        tags: {
          type: 'array',
          items: { type: 'string' },
          description: '标签列表，用于分类和后续检索',
        },
      },
      output: {
        schema: { type: 'object', additionalProperties: true },
        render: (_args, value) => [{ type: 'text', text: `✅ 记忆已保存: ${value.title} (${value.id})` }],
      },
      async execute(args) {
        const mem = await createMemory(args.title, args.content, args.tags ?? [])
        return {
          id: mem.id,
          title: mem.title,
          tags: mem.tags,
          created: mem.created,
          file: mem.file,
        }
      },
    }))

    // 2. recall — 搜索记忆
    tools.register(defineTool({
      name: 'recall',
      description:
        '搜索记忆库。在标题、标签和内容中进行全文匹配。' +
        '当你需要回忆之前存储的信息时使用。',
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
          const results = value.results as Array<{ title: string; id: string }>
          if (results.length === 0) return [{ type: 'text', text: '🔍 未找到相关记忆' }]
          const lines = results.map((r: { title: string; id: string }) => `- ${r.title} (\`${r.id}\`)`)
          return [{ type: 'text', text: `🔍 找到 ${results.length} 条记忆:\n${lines.join('\n')}` }]
        },
      },
      async execute(args) {
        const results = await searchMemories(args.query)
        return {
          query: args.query,
          count: results.length,
          results: results.map(m => ({
            id: m.id,
            title: m.title,
            tags: m.tags,
            snippet: m.content.slice(0, 300),
            updated: m.updated,
          })),
        }
      },
    }))

    // 3. list_memories — 列出所有记忆
    tools.register(defineTool({
      name: 'list_memories',
      description:
        '列出所有记忆。可选按标签过滤。用于浏览记忆库全貌。',
      parameters: {
        tags: {
          type: 'array',
          items: { type: 'string' },
          description: '可选，按标签过滤',
        },
      },
      output: {
        schema: { type: 'object', additionalProperties: true },
        render: (_args, value) => {
          const items = value.items as Array<{ title: string; tags: string[] }>
          if (items.length === 0) return [{ type: 'text', text: '📝 记忆库为空' }]
          const lines = items.map((m: { title: string; tags: string[] }) =>
            `- ${m.title} [${m.tags.join(', ')}]`)
          return [{ type: 'text', text: `📝 共 ${items.length} 条记忆:\n${lines.join('\n')}` }]
        },
      },
      async execute(args) {
        const items = await listMemories(args.tags)
        return {
          count: items.length,
          items: items.map(m => ({
            id: m.id,
            title: m.title,
            tags: m.tags,
            updated: m.updated,
          })),
        }
      },
    }))

    // 4. forget — 删除记忆
    tools.register(defineTool({
      name: 'forget',
      description:
        '删除一条记忆。当信息过时或不再需要时使用。',
      parameters: {
        id: {
          type: 'string',
          required: true,
          description: '记忆 ID（从 recall 或 list_memories 获取）',
        },
      },
      output: {
        schema: { type: 'object', additionalProperties: true },
        render: (_args, value) => {
          if (value.deleted) return [{ type: 'text', text: `🗑️ 记忆已删除` }]
          return [{ type: 'text', text: `⚠️ 未找到指定记忆` }]
        },
      },
      async execute(args) {
        const deleted = await deleteMemory(args.id)
        return { id: args.id, deleted }
      },
    }))

    // 5. update_memory — 更新记忆
    tools.register(defineTool({
      name: 'update_memory',
      description:
        '更新一条已有记忆的内容、标题或标签。只需提供要更新的字段。',
      parameters: {
        id: {
          type: 'string',
          required: true,
          description: '记忆 ID',
        },
        title: {
          type: 'string',
          description: '新标题（可选）',
        },
        content: {
          type: 'string',
          description: '新内容（可选）',
        },
        tags: {
          type: 'array',
          items: { type: 'string' },
          description: '新标签列表（可选）',
        },
      },
      output: {
        schema: { type: 'object', additionalProperties: true },
        render: (_args, value) => {
          if (value.updated) return [{ type: 'text', text: `✏️ 记忆已更新: ${value.title}` }]
          return [{ type: 'text', text: `⚠️ 未找到指定记忆` }]
        },
      },
      async execute(args) {
        const existing = await getMemory(args.id)
        if (!existing) return { id: args.id, updated: false, title: '', tags: [] }

        const updated = await updateMemory(args.id, {
          title: args.title ?? undefined,
          content: args.content ?? undefined,
          tags: args.tags ?? undefined,
        })
        if (!updated) return { id: args.id, updated: false, title: '', tags: [] }

        return {
          id: updated.id,
          updated: true,
          title: updated.title,
          tags: updated.tags,
        }
      },
    }))
}