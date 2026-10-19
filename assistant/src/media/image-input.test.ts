import assert from 'node:assert/strict'
import test from 'node:test'
import { decodeImageInput } from './image-input.js'

const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
)

test('decodeImageInput accepts canonical image data URLs', () => {
  const result = decodeImageInput(`data:image/png;base64,${PNG_1X1.toString('base64')}`)
  assert.equal(result.mediaType, 'image/png')
  assert.deepEqual(Buffer.from(result.data), PNG_1X1)
})

test('decodeImageInput rejects non-canonical base64', () => {
  assert.throws(() => decodeImageInput('not-base64', 'image/png'), /规范的 base64/)
})

test('decodeImageInput rejects unsupported media types', () => {
  assert.throws(
    () => decodeImageInput(`data:image/svg+xml;base64,${PNG_1X1.toString('base64')}`),
    /不支持的图片类型/,
  )
})
