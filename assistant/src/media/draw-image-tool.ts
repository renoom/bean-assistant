/**
 * draw_image 工具 —— 图片生成（能力级 tool）。
 *
 * 助手只调 draw_image，不关心底层是哪家多模态模型。execute 里：
 *   1. 读当前 resolved 配置里的 media.imageGen（provider + providers）
 *   2. 按 provider 名路由到对应 adapter（minimax / siliconflow）
 *   3. 拿到图片 bytes 后落盘到 {dataDir}/images/，返回路径 + 可访问 url
 *
 * @module assistant/media/draw-image-tool
 */

import { resolve } from 'node:path'
import { mkdir, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { JsonValue } from '@deepseek-ai/dsh-session'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { MediaCapabilityConfig } from '../config/types.js'
import { imageGenAdapters } from './image-gen.js'
import { clampN, extForMimeType } from './types.js'

export interface DrawImageToolConfig {
  /** 图片落盘目录（绝对路径），如 {dataDir}/images */
  imagesDir: string
  /** 懒读取当前 resolved 的 media.imageGen 配置（运行时热读，避免启动时序耦合） */
  getImageGen: () => MediaCapabilityConfig | undefined
}

/** 注册 draw_image 工具到 Agent 的 scoped context。 */
export function registerDrawImageTool(ctx: Context, config: DrawImageToolConfig): void {
  ctx.tools.register(defineTool({
    name: 'draw_image',
    description:
      '生成图片（文生图）。当你需要画一张图、海报、插画、概念图时使用。' +
      '给出自然语言的画面描述 prompt，工具会调用当前配置的图片生成厂家（minimax / siliconflow 等）出图并保存。' +
      '返回的是图片在服务器上的路径和可访问 url。',
    parameters: {
      prompt: {
        type: 'string',
        required: true,
        description: '画面描述（自然语言，越具体越好：主体、动作、场景、风格、光线、构图等）',
      },
      n: {
        type: 'number',
        description: '生成张数（1~4），默认 1',
      },
      size: {
        type: 'string',
        description: '尺寸提示，如 "1024x1024"、"1280x720"；各厂家会映射到自己的尺寸/宽高比字段',
      },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => {
        if (!value.ok) return [{ type: 'text', text: `⚠️ 图片生成失败：${String(value.error ?? '未知错误')}` }]
        const images = value.images as Array<{ n: number; path: string; url: string }>
        if (!images || images.length === 0) return [{ type: 'text', text: '⚠️ 图片生成返回空结果' }]
        const lines = images.map((img) => `- 第 ${img.n + 1} 张：${img.path}`)
        return [{ type: 'text', text: `✅ 已生成 ${images.length} 张图片:\n${lines.join('\n')}` }]
      },
    },
    async execute(args, exec): Promise<Record<string, JsonValue>> {
      try {
        const capability = config.getImageGen()
        const providerName = capability?.provider
        if (!providerName) {
          return { ok: false, error: '未配置图片生成厂家（请在公共配置 media.imageGen.provider 里选一个厂家）', images: [] }
        }
        const profile = capability?.providers?.[providerName]
        if (!profile) {
          return { ok: false, error: `图片生成厂家 "${providerName}" 缺少配置（media.imageGen.providers 里没有该 key）`, images: [] }
        }
        const adapter = imageGenAdapters[providerName]
        if (!adapter) {
          const known = Object.keys(imageGenAdapters).join(', ')
          return { ok: false, error: `暂不支持图片生成厂家 "${providerName}"（已接入: ${known}）`, images: [] }
        }

        const images = await adapter(
          {
            prompt: args.prompt,
            n: typeof args.n === 'number' ? clampN(args.n) : undefined,
            size: typeof args.size === 'string' ? args.size : undefined,
          },
          profile,
          exec.signal,
        )

        await mkdir(config.imagesDir, { recursive: true })
        const stamp = Date.now()
        const written: Array<{ n: number; path: string; url: string }> = []
        for (let i = 0; i < images.length; i++) {
          const img = images[i]
          const ext = extForMimeType(img.mimeType)
          const hash = createHash('sha1').update(img.data).digest('hex').slice(0, 12)
          const name = `${stamp}-${i}-${hash}.${ext}`
          await writeFile(resolve(config.imagesDir, name), img.data)
          written.push({ n: i, path: resolve(config.imagesDir, name), url: `/api/image/${name}` })
        }

        return { ok: true, error: '', images: written }
      } catch (err) {
        return { ok: false, error: (err as Error).message, images: [] }
      }
    },
  }))
}
