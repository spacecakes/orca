import type { TuiAgent } from './tui-agent'

/**
 * `owed`: no byte of the prompt has been written, so a host that restarts may still deliver it.
 * `writing`: the write may have begun, so nothing may write it again.
 */
export type AgentLaunchOwedPrompt =
  | { state: 'owed'; text: string; agent: TuiAgent }
  | { state: 'writing'; since: number }
