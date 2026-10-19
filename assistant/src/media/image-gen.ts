/**
 * 图片生成 adapter —— 每个厂家一个实现，没有通用协议。
 *
 * 已接入：
 *   - minimax     MiniMax image-01（文生图）
 *   - siliconflow 硅基流动（Qwen-Image / FLUX 等，OpenAI 兼容 images 端点）
 *
 * 注册表 `imageGenAdapters` 按厂家名索引，供 draw_image tool 路由。
 *
 * @module assistant/media/image-gen
 */

import type { MediaProviderProfile } from '../config/types.js'
import { clampN, detectImageType, downloadImage, requireApiKey, type GeneratedImage, type ImageGenAdapter, type ImageGenRequest } from './types.js'

// ── MiniMax ─────────────────────────────────────────────────────────────────

const MINIMAX_DEFAULT_BASE = 'https://api.minimaxi.com'
const MINIMAX_DEFAULT_MODEL = 'image-01'

/** 常见像素尺寸 → MiniMax 的 aspect_ratio 预设。 */
const MINIMAX_ASPECT: Record<string, string> = {
  '1024x1024': '1:1',
  '1280x720': '16:9',
  '1920x1080': '16:9',
  '720x1280': '9:16',
  '1080x1920': '9:16',
  '1024x768': '4:3',
  '768x1024': '3:4',
}

const minimaxGenerate: ImageGenAdapter = async (req, profile, signal) => {
  const apiKey = requireApiKey(profile, 'MiniMax')
  const base = (typeof profile.baseURL === 'string' && profile.baseURL.length > 0) ? profile.baseURL : MINIMAX_DEFAULT_BASE
  const n = clampN(req.n)
  const aspectRatio = req.size ? (MINIMAX_ASPECT[req.size] ?? req.size) : '1:1'

  const body: Record<string, unknown> = {
    model: (typeof profile.model === 'string' && profile.model.length > 0) ? profile.model : MINIMAX_DEFAULT_MODEL,
    prompt: req.prompt,
    aspect_ratio: aspectRatio,
    response_format: 'base64',
    n,
  }
  if (profile.prompt_optimizer !== undefined) body.prompt_optimizer = profile.prompt_optimizer

  const res = await fetch(`${base}/v1/image_generation`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify(body),
    signal,
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`MiniMax 图片生成失败 (HTTP ${res.status}): ${text.slice(0, 300)}`)
  }
  const json = (await res.json()) as Record<string, unknown>
  const baseResp = (json.base_resp ?? {}) as Record<string, unknown>
  if (baseResp.status_code !== undefined && baseResp.status_code !== 0) {
    throw new Error(`MiniMax 图片生成失败: ${String(baseResp.status_msg ?? `status_code ${String(baseResp.status_code)}`)}`)
  }
  const data = (json.data ?? {}) as Record<string, unknown>

  // base64 优先（response_format=base64 → data.image_base64）；否则回退 url（data.image_urls）
  if (Array.isArray(data.image_base64) && data.image_base64.length > 0) {
    return data.image_base64.map((b64) => {
      const buf = Buffer.from(String(b64), 'base64')
      return { data: buf, mimeType: detectImageType(buf) }
    })
  }
  if (Array.isArray(data.image_urls) && data.image_urls.length > 0) {
    const out: GeneratedImage[] = []
    for (const url of data.image_urls) {
      const buf = await downloadImage(String(url), undefined, signal)
      out.push({ data: buf, mimeType: detectImageType(buf) })
    }
    return out
  }
  throw new Error('MiniMax 图片生成返回了空结果')
}

// ── 硅基流动 ────────────────────────────────────────────────────────────────

const SILICONFLOW_DEFAULT_BASE = 'https://api.siliconflow.cn'
const SILICONFLOW_DEFAULT_MODEL = 'Qwen/Qwen-Image'

const siliconflowGenerate: ImageGenAdapter = async (req, profile, signal) => {
  const apiKey = requireApiKey(profile, '硅基流动')
  const base = (typeof profile.baseURL === 'string' && profile.baseURL.length > 0) ? profile.baseURL : SILICONFLOW_DEFAULT_BASE
  const n = clampN(req.n)

  const body: Record<string, unknown> = {
    model: (typeof profile.model === 'string' && profile.model.length > 0) ? profile.model : SILICONFLOW_DEFAULT_MODEL,
    prompt: req.prompt,
    image_size: req.size ?? '1024x1024',
    batch_size: n,
  }
  // 各家常见可选参数（Qwen-Image / FLUX 支持）透传
  if (profile.negative_prompt !== undefined) body.negative_prompt = profile.negative_prompt
  if (profile.num_inference_steps !== undefined) body.num_inference_steps = profile.num_inference_steps
  if (profile.guidance_scale !== undefined) body.guidance_scale = profile.guidance_scale

  const res = await fetch(`${base}/v1/images/generations`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify(body),
    signal,
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`硅基流动图片生成失败 (HTTP ${res.status}): ${text.slice(0, 300)}`)
  }
  const json = (await res.json()) as Record<string, unknown>

  // FLUX / Qwen-Image 返回 { images: [{url}] }；部分 SD/Kolors 返回 { data: [{url}] }
  const items = Array.isArray(json.images) ? json.images : Array.isArray(json.data) ? json.data : null
  if (!items || items.length === 0) {
    throw new Error('硅基流动图片生成返回了空结果')
  }
  const urls = items
    .map((it) => (typeof it === 'object' && it !== null ? (it as Record<string, unknown>).url : undefined))
    .filter((u): u is string => typeof u === 'string' && u.length > 0)
  if (urls.length === 0) throw new Error('硅基流动图片生成返回里没有可用的 url')

  const out: GeneratedImage[] = []
  for (const url of urls) {
    // 硅基流动的临时 url 需要带 Bearer 才能下载
    const buf = await downloadImage(url, apiKey, signal)
    out.push({ data: buf, mimeType: detectImageType(buf) })
  }
  return out
}

// ── 注册表 ──────────────────────────────────────────────────────────────────

export const imageGenAdapters: Record<string, ImageGenAdapter> = {
  minimax: minimaxGenerate,
  siliconflow: siliconflowGenerate,
}
