/**
 * 纯内存 settings 后端 — 助手的「settings 只是实例」实现
 *
 * 配置中心把有效配置（provider 适配器配置）作为唯一事实源保存在控制台；
 * 助手进程只持有这个 seam 实例，配置内容经 HTTP（启动拉取 / 变更 push）
 * 进入，通过 `push()` 热发布进 seam，由 dsh 的 llm-deepseek / llm-pi-ai
 * 监听 settings/updated 自动应用，下一个 LLM 请求即用新值。
 *
 * 与 dsh-settings-file 的区别：不落盘，writable=false（所有修改都在配置
 * 中心完成），助手本地不保留 settings 文件副本。
 *
 * @module assistant/config/settings-provider
 */

import { SettingsProvider, type SettingsNamespace } from '@deepseek-ai/dsh-settings'

export default class MemorySettingsProvider extends SettingsProvider {
  /** 助手端不提供写入口：所有修改都在控制台，经 push() 进入。 */
  get writable(): boolean {
    return false
  }

  protected async load(): Promise<Record<string, unknown>> {
    // 纯内存：初始无文档；内容由 push() 从控制台注入。
    return {}
  }

  protected async persist(_ns: SettingsNamespace, _section: Record<string, unknown>): Promise<void> {
    // no-op：纯内存后端，配置的唯一持久副本在控制台。
  }

  /**
   * 注入控制台下发的有效配置文档（namespace → section 映射），
   * 热发布进 seam：已注册命名空间重新解析，settings/updated 按变更触发。
   */
  push(doc: Record<string, unknown>): void {
    this.publish(doc, 'provider')
  }
}
