/**
 * 助手元数据持久化 — data/assistants.json
 *
 * 控制台注册表的内存态会落盘到此文件。重启控制台后重新加载:
 * 历史条目恢复为 offline (进程已不在), 待助手重新上报后自动变回 online。
 *
 * @module console/store
 */

import { readFile, writeFile, rename, mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import type { AssistantInfo } from './registry.ts'

// ── 路径 ────────────────────────────────────────────────────────────────────

let dataFile = ''

/** 设置持久化文件路径 (由 bin.ts 调用)。 */
export function setDataFile(path: string): void {
  dataFile = resolve(path)
}

// ── 读写 ────────────────────────────────────────────────────────────────────

/** 从磁盘加载持久化的助手元数据; 文件缺失或损坏时返回空数组。 */
export async function loadAssistants(): Promise<AssistantInfo[]> {
  try {
    const raw = await readFile(dataFile, 'utf-8')
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return []
    // 恢复为 offline — 控制台重启后这些进程已不存在
    return parsed.map(a => ({ ...a, status: 'offline' as const }))
  } catch {
    return []
  }
}

/** 将当前助手列表原子写入磁盘。 */
export async function saveAssistants(assistants: AssistantInfo[]): Promise<void> {
  if (!dataFile) return
  await mkdir(resolve(dataFile, '..'), { recursive: true })
  const tmp = dataFile + '.tmp'
  await writeFile(tmp, JSON.stringify(assistants, null, 2), 'utf-8')
  await rename(tmp, dataFile)
}
