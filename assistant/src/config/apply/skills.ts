/**
 * 配置中心 — 技能热下发应用器
 *
 * 控制台维护技能库（name → markdown 正文），助手配置只引用技能名。
 * 本模块从控制台拉取正文，并通过 dsh-skill 注册到 agent 可见的
 * skill registry；每次轮询对技能列表做 diff：新增注册、移除 dispose、
 * 正文变更则先卸载再重新注册。
 *
 * @module assistant/config/apply/skills
 */

import type { Context } from '@deepseek-ai/cordis'
import { isSkillName } from '@deepseek-ai/dsh-skill'
import { fetchSkill } from '../fetch.js'
import type { SkillDef } from '../types.js'

interface RuntimeSkillRegistration {
  name: string
  description: string
  content: string
  dispose: () => void
}

interface SkillsService {
  register(skill: {
    name: string
    description: string
    content: string
  }): () => void
}

function skillsOf(ctx: Context): SkillsService | undefined {
  return (ctx as unknown as { skills?: SkillsService }).skills
}

export interface SkillApplier {
  apply(skillNames: string[] | undefined): Promise<void>
  disposeAll(): void
}

/** 创建技能下发应用器。consoleUrl 为空时所有操作均为 no-op。 */
export function createSkillApplier(ctx: Context, consoleUrl: string | undefined): SkillApplier {
  const active = new Map<string, RuntimeSkillRegistration>()

  return {
    async apply(skillNames: string[] | undefined): Promise<void> {
      const skills = skillsOf(ctx)
      const desired = [...new Set(skillNames ?? [])]
      if (!consoleUrl || !skills) return

      // 1. 卸载已移除的技能
      const desiredSet = new Set(desired)
      for (const [name, registration] of [...active]) {
        if (!desiredSet.has(name)) {
          registration.dispose()
          active.delete(name)
          console.log(`[assistant-config] 技能已卸载: ${name}`)
        }
      }

      // 2. 拉取正文；控制台/网络不可达时保留上次已注册内容
      const fetched = await Promise.all(desired.map(async (name) => {
        const skill = await fetchSkill(consoleUrl, name)
        return { name, skill }
      }))

      for (const { name, skill } of fetched) {
        if (!skill) {
          if (!active.has(name)) {
            console.warn(`[assistant-config] 技能 ${name} 拉取失败，等待下轮重试`)
          }
          continue
        }

        if (!isSkillName(skill.name)) {
          console.warn(`[assistant-config] 非法技能名，忽略: ${skill.name}`)
          continue
        }

        const previous = active.get(skill.name)
        const changed = !previous
          || previous.description !== normalizeDescription(skill)
          || previous.content !== skill.content

        if (!changed) continue

        previous?.dispose()
        let dispose = () => {}
        try {
          dispose = skills.register({
            name: skill.name,
            description: normalizeDescription(skill),
            content: skill.content,
          })
        } catch (err) {
          console.warn(`[assistant-config] 技能注册失败: ${skill.name}`, err instanceof Error ? err.message : String(err))
          continue
        }

        active.set(skill.name, {
          name: skill.name,
          description: normalizeDescription(skill),
          content: skill.content,
          dispose,
        })
        console.log(`[assistant-config] 技能已下发: ${skill.name}`)
      }
    },

    disposeAll(): void {
      for (const registration of active.values()) registration.dispose()
      active.clear()
    },
  }
}

function normalizeDescription(skill: SkillDef): string {
  return skill.description ?? ''
}
