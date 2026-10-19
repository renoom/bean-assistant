#!/usr/bin/env node
/**
 * Build the package: compile `src/` with tsc, then normalize declaration imports.
 *
 * Why the extra step? The sources import each other with explicit `.ts`
 * extensions so that Node's type stripping (`node --experimental-strip-types`)
 * can run `src/` and `test/` directly, without a build step. tsc's
 * `rewriteRelativeImportExtensions` rewrites those specifiers to `.js` in the
 * emitted JavaScript, but it leaves them as `.ts` in the emitted `.d.ts` files.
 * Published packages only ship `dist/`, so the declarations must reference
 * `./foo.js` (which TypeScript resolves to `foo.d.ts`).
 *
 * tsc discovery order:
 *   1. `$TSC` environment variable (absolute path);
 *   2. `node_modules/typescript/bin/tsc` (after `npm install`);
 *   3. `<repo>/assistant/node_modules/typescript/bin/tsc` (monorepo fallback).
 */

import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

const candidates = [
  process.env.TSC,
  join(packageRoot, 'node_modules/typescript/bin/tsc'),
  resolve(packageRoot, '../../assistant/node_modules/typescript/bin/tsc'),
].filter(candidate => typeof candidate === 'string' && candidate.length > 0)

const tsc = candidates.find(candidate => existsSync(candidate))
if (!tsc) {
  console.error('[stage-channel-sdk] tsc not found.')
  console.error('  Install dependencies first: cd sdk/npm && npm install')
  console.error('  Or point $TSC at a TypeScript compiler: TSC=/path/to/tsc npm run build')
  process.exit(1)
}

console.log(`[stage-channel-sdk] building with ${tsc}`)
const build = spawnSync(process.execPath, [tsc, '-p', join(packageRoot, 'tsconfig.json')], {
  cwd: packageRoot,
  stdio: 'inherit',
})
if (build.error) {
  console.error(`[stage-channel-sdk] failed to run tsc: ${build.error.message}`)
  process.exit(1)
}
if ((build.status ?? 1) !== 0) process.exit(build.status ?? 1)

const distDir = join(packageRoot, 'dist')
const declarationFiles = walk(distDir).filter(file => file.endsWith('.d.ts'))
const relativeImport = /(from\s*['"])(\.{1,2}\/[^'"]+)\.ts(['"])/g
let rewritten = 0

for (const file of declarationFiles) {
  const source = readFileSync(file, 'utf8')
  const fixed = source.replace(relativeImport, (_match, prefix, specifier, suffix) => {
    rewritten += 1
    return `${prefix}${specifier}.js${suffix}`
  })
  if (fixed !== source) writeFileSync(file, fixed)
}

console.log(`[stage-channel-sdk] normalized ${rewritten} declaration import(s) in ${declarationFiles.length} .d.ts file(s)`)

/** Recursively list files below `dir` (returns [] when it does not exist). */
function walk(dir) {
  if (!existsSync(dir)) return []
  const entries = readdirSync(dir, { withFileTypes: true })
  const files = []
  for (const entry of entries) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) files.push(...walk(full))
    else if (entry.isFile()) files.push(full)
  }
  return files
}
