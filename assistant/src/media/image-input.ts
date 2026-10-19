/** Decode browser image payloads before the DSH attachment service validates them. */

import type { ImageMediaType } from '@deepseek-ai/dsh-attachment'

const MEDIA_TYPES = new Set<ImageMediaType>(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])

export interface DecodedImageInput {
  data: Uint8Array
  mediaType: ImageMediaType
}

export function decodeImageInput(raw: string, declaredMime?: string): DecodedImageInput {
  if (typeof raw !== 'string' || raw.length === 0) throw new Error('image 不能为空')
  const match = /^data:([^;,]+);base64,(.+)$/s.exec(raw)
  const encoded = match?.[2] ?? raw
  const data = Buffer.from(encoded, 'base64')
  if (encoded.length === 0 || data.toString('base64') !== encoded) {
    throw new Error('image 必须是规范的 base64 或 data URL')
  }
  const mime = match?.[1] || declaredMime
  if (!mime || !MEDIA_TYPES.has(mime as ImageMediaType)) {
    throw new Error(`不支持的图片类型：${mime || '未提供'}`)
  }
  return { data: new Uint8Array(data), mediaType: mime as ImageMediaType }
}
