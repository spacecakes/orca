import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import {
  acknowledgePRCommentsAfterAiLaunch,
  canPostPRReviewThreadReply,
  hasPRCommentGroupNeedingReply,
  resolvePRReviewReplyThreadId,
  type PendingPRCommentAiAck
} from './pr-comments-ai-launch-ack'
import { buildSnapshottedThreadResolver } from './pr-comment-snapshotted-thread-resolver'
import { resolveGitLabMRDiscussionForChecks } from './checks-panel/gitlab-review-client'

/**
 * The Checks panel's "resolve the selected comments" follow-up, for a window that reloaded while
 * its launch ran (`agent-launch-follow-ups`). The same host writes as the panel's own, with nothing
 * that needs the panel on screen: no optimistic rows, no refresh. Its result toast is the panel's.
 */
export async function runReviewCommentsResolutionFollowUp(
  resolution: PendingPRCommentAiAck
): Promise<void> {
  const store = useAppStore.getState()
  const githubTarget = resolution.githubTarget
  const canReplyOnHost = resolution.provider === 'github' && githubTarget != null
  let lastHostError: string | undefined
  const resolveThread = buildSnapshottedThreadResolver({
    provider: resolution.provider,
    githubResolveTarget: resolution.githubResolveTarget,
    gitlabTarget: resolution.gitlabTarget,
    resolveReviewThread: store.resolveReviewThread,
    resolveGitLabDiscussion: (args) =>
      resolveGitLabMRDiscussionForChecks({ ...args, settings: useAppStore.getState().settings }),
    isPanelStillOnLaunchReview: () => false,
    onResolvedOptimistically: () => {},
    onResolveFailed: ({ error }) => {
      lastHostError = error || lastHostError
    }
  })
  const counts = await acknowledgePRCommentsAfterAiLaunch({
    groups: resolution.selectedGroups,
    deps: {
      resolveThread,
      canReply: canReplyOnHost,
      replyInThread: async (comment, body) => {
        if (!githubTarget || !canPostPRReviewThreadReply(comment)) {
          return false
        }
        const result = await store
          .addPRReviewCommentReply(githubTarget.repoPath, githubTarget.prNumber, comment.id, body, {
            repoId: githubTarget.repoId,
            prRepo: githubTarget.prRepo,
            threadId:
              resolvePRReviewReplyThreadId({ parent: comment, existingComments: [] }) ??
              comment.threadId,
            path: comment.path,
            line: comment.line
          })
          .catch((error: unknown) => ({ ok: false as const, error: String(error) }))
        if (!result.ok) {
          lastHostError = result.error
        }
        return result.ok
      },
      replyAsConversation: async (body) => {
        if (!githubTarget) {
          return false
        }
        const result = await store
          .addPRConversationComment(githubTarget.repoPath, githubTarget.prNumber, body, {
            repoId: githubTarget.repoId,
            prRepo: githubTarget.prRepo
          })
          .catch((error: unknown) => ({ ok: false as const, error: String(error) }))
        if (!result.ok) {
          lastHostError = result.error
        }
        return result.ok
      }
    }
  })
  const repliedNoneDespiteHostSupport =
    canReplyOnHost &&
    counts.replied === 0 &&
    hasPRCommentGroupNeedingReply(resolution.selectedGroups)
  const values = {
    value0: counts.resolved,
    value1: counts.replied,
    value2: counts.skipped,
    value3: counts.failed
  }
  if (counts.failed > 0 || repliedNoneDespiteHostSupport || lastHostError) {
    toast.error(
      translate(
        'auto.components.right.sidebar.ChecksPanel.f273f2271c',
        'Started the agent. Marked {{value0}} resolved, replied to {{value1}}, skipped {{value2}}, failed {{value3}}.{{value4}}',
        { ...values, value4: lastHostError ? ` ${lastHostError}` : '' }
      )
    )
    return
  }
  toast.success(
    translate(
      'auto.components.right.sidebar.ChecksPanel.aa95b81a3a',
      'Started the agent. Marked {{value0}} resolved, replied to {{value1}}, skipped {{value2}}, failed {{value3}}.',
      values
    )
  )
}
