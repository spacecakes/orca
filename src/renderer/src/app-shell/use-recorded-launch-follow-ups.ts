import { useEffect } from 'react'
import { useAppStore } from '../store'
import { runRecordedLaunchFollowUps } from '../lib/agent-launch-follow-ups'

/** Once the window has its worktrees and their notes, it runs what launches recorded for it while
 *  it was gone (`agent-launch-follow-ups`). */
export function useRecordedLaunchFollowUps(): void {
  const ready = useAppStore(
    (state) => state.workspaceSessionReady && state.terminalStartupRestorationReady
  )
  useEffect(() => {
    if (ready) {
      void runRecordedLaunchFollowUps()
    }
  }, [ready])
}
