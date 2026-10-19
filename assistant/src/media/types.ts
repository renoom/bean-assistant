/**
 * 多模态工具共享类型与辅助函数。
 *
 * 与 LLM provider 不同，图片生成、语音识别/合成各厂家没有通用协议，
 * 所以这里只定义「能力级的请求/结果」和「adapter 的契约」，各厂家自己实现。
 *
 * @module assistant/media/types
 */

import type { MediaProviderProfile } from '../config/types.js'

/** 一次图片生成的输入（能力级，跟厂家无关）。 */
export interface ImageGenRequest {
  prompt: string
  /** 生成张数，1..4，默认 1 */
  n?: number
  /** 尺寸提示，如 "1024x1024" 或 "16:9"；各家自行映射到自己的字段 */
  size?: string
}

/** 一张已生成的图片（二进制）。adapter 负责把它从厂家的 url/base64 变成 bytes。 */
export interface GeneratedImage {
  data: Buffer
  mimeType: string
}

/** 图片生成 adapter 契约。每个厂家一个实现。 */
export type ImageGenAdapter = (
  req: ImageGenRequest,
  profile: MediaProviderProfile,
  signal?: AbortSignal,
) => Promise<GeneratedImage[]>

/** 从 profile 解析 apiKey：优先 apiKey，缺省回退 process.env[apiKeyEnv]。 */
export function requireApiKey(profile: MediaProviderProfile, vendor: string): string {
  const direct = typeof profile.apiKey === 'string' && profile.apiKey.length > 0 ? profile.apiKey : undefined
  if (direct) return direct
  const env = typeof profile.apiKeyEnv === 'string' && profile.apiKeyEnv.length > 0 ? profile.apiKeyEnv : undefined
  if (env) {
    const fromEnv = process.env[env]
    if (fromEnv && fromEnv.length > 0) return fromEnv
  }
  throw new Error(`${vendor} 缺少 apiKey（请在公共配置里填 apiKey，或指定 apiKeyEnv 环境变量）`)
}

/** 把 n 夹到 1..4，默认 1。 */
export function clampN(n: number | undefined): number {
  if (n === undefined || !Number.isFinite(n)) return 1
  return Math.max(1, Math.min(4, Math.floor(n)))
}

/** 下载一个图片 url 得到二进制；需要鉴权时带 Bearer。 */
export async function downloadImage(url: string, apiKey: string | undefined, signal?: AbortSignal): Promise<Buffer> {
  const headers: Record<string, string> = {}
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`
  const res = await fetch(url, { headers, signal })
  if (!res.ok) {
    throw new Error(`下载图片失败 (HTTP ${res.status})`)
  }
  const buf = Buffer.from(await res.arrayBuffer())
  if (buf.length === 0) throw new Error('下载图片为空')
  return buf
}

/** 按魔数识别图片类型，用于落盘扩展名；未知默认 png。 */
export function detectImageType(data: Buffer): string {
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return 'image/jpeg'
  if (data.length >= 8 && data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4e && data[3] === 0x47) return 'image/png'
  if (data.length >= 12 && data.subarray(0, 4).toString('ascii') === 'RIFF' && data.subarray(8, 12).toString('ascii') === 'WEBP') {
    return 'image/webp'
  }
  return 'image/png'
}

/** mimeType → 文件扩展名。 */
export function extForMimeType(mimeType: string): string {
  switch (mimeType) {
    case 'image/jpeg': return 'jpg'
    case 'image/webp': return 'webp'
    default: return 'png'
  }
}
