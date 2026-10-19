import assert from 'node:assert/strict'
import test from 'node:test'
import { buildAnimationManifest, buildSpritePrompt, parsePngSize, pngSupportsTransparency } from './codex-sprite-tool.js'

test('parsePngSize reads IHDR dimensions', () => {
	const png = Buffer.alloc(26)
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(png)
  png.writeUInt32BE(1024, 16)
	png.writeUInt32BE(1024, 20)
	png[25] = 6
	assert.deepEqual(parsePngSize(png), { width: 1024, height: 1024 })
	assert.equal(pngSupportsTransparency(png), true)
})

test('manifest maps the four direction rows deterministically', () => {
  const manifest = buildAnimationManifest('/tmp/spritesheet.png', 1024, 1024, { character: '橙色猫剑客' })
  assert.equal(manifest.frameWidth, 256)
  assert.equal(manifest.frameHeight, 256)
  const animations = manifest.animations as Record<string, { row: number; frames: number[] }>
  assert.equal(animations.walk_down.row, 0)
  assert.equal(animations.walk_left.row, 1)
  assert.equal(animations.walk_right.row, 2)
  assert.equal(animations.walk_up.row, 3)
  assert.deepEqual(animations.walk_down.frames, [0, 1, 2, 3])
})

test('prompt fixes output path and sprite layout', () => {
  const prompt = buildSpritePrompt({ character: '测试角色' }, '/safe/job/spritesheet.png')
  assert.match(prompt, /\/safe\/job\/spritesheet\.png/)
  assert.match(prompt, /4 列 × 4 行/)
  assert.match(prompt, /朝下、朝左、朝右、朝上/)
  assert.match(prompt, /透明背景 PNG/)
})
