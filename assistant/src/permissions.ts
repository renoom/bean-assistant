import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-permission-presets'
import { effectiveSandboxMode } from '@deepseek-ai/dsh-sandbox-policy'
import { effectiveApprovalPolicy } from '@deepseek-ai/dsh-user-approval'

/** Apply the requested full access to restored sessions as well as new ones. */
export function enableFullAccess(ctx: Context, agent: Agent): void {
  ctx.permissionPresets.set(agent.session, 'danger-full-access')
}

export function permissionStatus(ctx: Context, agent: Agent) {
  return {
    preset: ctx.permissionPresets.current(agent.session.events),
    sandboxMode: effectiveSandboxMode(agent.session.events),
    approvalPolicy: effectiveApprovalPolicy(agent.session.events),
  }
}
