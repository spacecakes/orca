/**
 * `agent.takeLaunchFollowUps`: the calling client takes the follow-ups its own launches recorded
 * (`agent-launch-follow-up-record`). Scoped by the connection's caller identity, so a phone or the
 * CLI can never see, or take, the desktop's.
 */

import { AgentTakeLaunchFollowUps } from '../../../../shared/rpc-contract/agent-launch-params'
import type { AgentLaunchFollowUpTake } from '../../../../shared/agent-launch-follow-up'
import { takeLaunchFollowUpsInto } from '../../agent-launch-follow-up-record'
import { defineMethod } from '../core'
import { activeAgentLaunchesFor } from './agent-launch-active-operations'
import { agentLaunchOperationCallerKey } from './agent-launch-replay'

export const AGENT_LAUNCH_FOLLOW_UP_METHODS = [
  defineMethod({
    name: 'agent.takeLaunchFollowUps',
    params: AgentTakeLaunchFollowUps,
    handler: async (params, context): Promise<AgentLaunchFollowUpTake> => {
      const callerKey = agentLaunchOperationCallerKey(context)
      const store = await context.runtime.openAgentSessionRecordStore()
      const active = activeAgentLaunchesFor(context.runtime)
      return store.transactOperations((draft) =>
        takeLaunchFollowUpsInto(draft, {
          callerKey,
          ...(params.operationId ? { operationId: params.operationId } : {}),
          now: Date.now(),
          isLaunchRunning: (operationKey) => active.has(operationKey)
        })
      )
    }
  })
]
