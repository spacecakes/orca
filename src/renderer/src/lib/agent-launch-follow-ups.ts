/**
 * The follow-ups a desktop click records on its launch (`agent-launch-follow-up`), and the window's
 * side of taking them: the live click takes its own before it runs it, and a window that reloaded
 * mid-launch takes the rest at startup. Whoever takes one runs it; a kind or version this build does
 * not know is discarded, never misread.
 *
 * Only the follow-ups a reload would otherwise turn into a second send are recorded: notes deleted
 * once sent, and review threads resolved with replies. A toast is not worth a record.
 */

import { useAppStore } from '@/store'
import { callRuntimeRpc } from '@/runtime/runtime-rpc-client'
import {
  ensureLocalRuntimeCapabilities,
  readLocalRuntimeCapabilitiesOrUnknown
} from '@/runtime/local-runtime-capabilities'
import { diffCommentSendKey, holdNotesForSend } from '@/lib/notes-send-in-flight'
import type { DiffCommentDeliverySnapshot } from '@/store/slices/diffComments'
import type { PendingPRCommentAiAck } from '@/components/right-sidebar/pr-comments-ai-launch-ack'
import { runReviewCommentsResolutionFollowUp } from '@/components/right-sidebar/review-comments-resolution-follow-up'
import {
  agentLaunchFollowUpFits,
  type AgentLaunchFollowUp,
  type AgentLaunchFollowUpTake
} from '../../../shared/agent-launch-follow-up'
import { AGENT_LAUNCH_FOLLOW_UPS_RUNTIME_CAPABILITY } from '../../../shared/agent-launch-runtime-capability'

const REVIEW_NOTES_DELIVERED = 'review-notes-delivered'
const REVIEW_COMMENTS_RESOLUTION = 'review-comments-resolution'

export function reviewNotesDeliveredFollowUp(
  worktreeId: string,
  notes: readonly DiffCommentDeliverySnapshot[]
): AgentLaunchFollowUp {
  // Only what the removal matches on, so a note carries no more than it must.
  const snapshots = notes.map(
    ({ id, body, filePath, lineNumber, startLine, selectedText, source }) => ({
      id,
      body,
      filePath,
      lineNumber,
      ...(startLine !== undefined ? { startLine } : {}),
      ...(selectedText !== undefined ? { selectedText } : {}),
      ...(source !== undefined ? { source } : {})
    })
  )
  return { kind: REVIEW_NOTES_DELIVERED, version: 1, payload: { worktreeId, notes: snapshots } }
}

export function reviewCommentsResolutionFollowUp(
  resolution: PendingPRCommentAiAck
): AgentLaunchFollowUp {
  return { kind: REVIEW_COMMENTS_RESOLUTION, version: 1, payload: resolution }
}

function isNotesPayload(
  value: unknown
): value is { worktreeId: string; notes: DiffCommentDeliverySnapshot[] } {
  return (
    typeof value === 'object' &&
    value !== null &&
    'worktreeId' in value &&
    typeof value.worktreeId === 'string' &&
    'notes' in value &&
    Array.isArray(value.notes) &&
    value.notes.every(
      (note: unknown) =>
        typeof note === 'object' &&
        note !== null &&
        'id' in note &&
        typeof note.id === 'string' &&
        'body' in note &&
        typeof note.body === 'string'
    )
  )
}

function isResolutionPayload(value: unknown): value is PendingPRCommentAiAck {
  return (
    typeof value === 'object' &&
    value !== null &&
    'reviewContextKey' in value &&
    typeof value.reviewContextKey === 'string' &&
    'provider' in value &&
    typeof value.provider === 'string' &&
    'selectedGroups' in value &&
    Array.isArray(value.selectedGroups)
  )
}

/** How to run a recorded follow-up, and keep what it acts on unsendable until it runs. */
function readFollowUp(followUp: AgentLaunchFollowUp): {
  run: () => Promise<void>
  holdUntil?: (settled: Promise<unknown>) => void
} | null {
  if (followUp.kind === REVIEW_NOTES_DELIVERED && followUp.version === 1) {
    const payload = followUp.payload
    if (!isNotesPayload(payload)) {
      return null
    }
    return {
      run: async () => {
        await useAppStore.getState().clearDeliveredDiffComments(payload.worktreeId, payload.notes)
      },
      holdUntil: (settled) => holdNotesForSend(payload.notes.map(diffCommentSendKey), settled)
    }
  }
  if (followUp.kind === REVIEW_COMMENTS_RESOLUTION && followUp.version === 1) {
    const payload = followUp.payload
    return isResolutionPayload(payload)
      ? { run: () => runReviewCommentsResolutionFollowUp(payload) }
      : null
  }
  return null
}

/** Whether this window's host records follow-ups; an older one runs them live, as before. */
export function hostRecordsLaunchFollowUps(): boolean {
  return (
    readLocalRuntimeCapabilitiesOrUnknown()?.includes(AGENT_LAUNCH_FOLLOW_UPS_RUNTIME_CAPABILITY) ??
    false
  )
}

/** The follow-up a launch request may carry: recorded only where the host keeps it and it fits. */
export function recordableLaunchFollowUp(
  followUp: AgentLaunchFollowUp | undefined
): AgentLaunchFollowUp | undefined {
  return followUp && hostRecordsLaunchFollowUps() && agentLaunchFollowUpFits(followUp)
    ? followUp
    : undefined
}

/** Null when the host could not answer: the caller treats that as nothing recorded. */
export async function takeLaunchFollowUps(
  operationId?: string
): Promise<AgentLaunchFollowUpTake | null> {
  try {
    return await callRuntimeRpc<AgentLaunchFollowUpTake>(
      { kind: 'local' },
      'agent.takeLaunchFollowUps',
      operationId ? { operationId } : {}
    )
  } catch (error) {
    console.warn('[agent-launch] could not take launch follow-ups', error)
    return null
  }
}

async function runTaken(take: AgentLaunchFollowUpTake['taken']): Promise<void> {
  for (const entry of take) {
    const followUp = entry.promptHandedOver ? readFollowUp(entry.followUp) : null
    await followUp?.run().catch((error: unknown) => {
      console.warn(`[agent-launch] the ${entry.followUp.kind} follow-up failed`, error)
    })
  }
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Startup: runs the follow-ups launches finished while this window was gone, and holds the ones
 * still waiting on their prompt, asking again for each until a bound. One still pending then stays
 * on its row, for the next startup or its row's expiry.
 */
export async function runRecordedLaunchFollowUps(
  options: { pollMs?: number; maxWaitMs?: number; wait?: (ms: number) => Promise<void> } = {}
): Promise<void> {
  const capabilities = await ensureLocalRuntimeCapabilities()
  if (!capabilities?.includes(AGENT_LAUNCH_FOLLOW_UPS_RUNTIME_CAPABILITY)) {
    return
  }
  const first = await takeLaunchFollowUps()
  if (!first) {
    return
  }
  await runTaken(first.taken)
  const waiting = new Map<string, () => void>()
  for (const { operationId, followUp } of first.pending) {
    let release: () => void = () => {}
    readFollowUp(followUp)?.holdUntil?.(new Promise<void>((resolve) => (release = resolve)))
    waiting.set(operationId, release)
  }
  const wait = options.wait ?? sleep
  const pollMs = options.pollMs ?? 2_000
  const deadline = Date.now() + (options.maxWaitMs ?? 120_000)
  while (waiting.size > 0 && Date.now() < deadline) {
    await wait(pollMs)
    for (const [operationId, release] of waiting) {
      const take = await takeLaunchFollowUps(operationId)
      if (take && take.pending.length === 0) {
        await runTaken(take.taken)
        release()
        waiting.delete(operationId)
      }
    }
  }
  // Past the bound: nothing more held, and the row keeps the follow-up for the next startup.
  for (const release of waiting.values()) {
    release()
  }
}
