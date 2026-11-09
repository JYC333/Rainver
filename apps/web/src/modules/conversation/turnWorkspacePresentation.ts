import { useCallback, useMemo, useState } from 'react'
import type { Run } from '../../types/api'
import { isTerminalRunStatus, type RoomTurnGroup } from './roomTimeline'

export type TurnSummaryPlan = { runs: Run[]; exclude: Set<string> }

/** A group can carry a summary once every Run in it has settled and none waits for a person. */
function settled(runs: readonly (Run | undefined)[]): runs is Run[] {
  return runs.every(run => run && isTerminalRunStatus(run.status) && run.status !== 'waiting_for_review')
}

/**
 * Which request group shows each batch. A batch several groups touch (one
 * conversation batch spans turns until it is finished) belongs to the latest
 * *settled* group: an unfinished or approval-waiting later group cannot carry
 * a summary, so the earlier one keeps it rather than leaving it to nobody.
 */
export function planTurnSummaries(groups: readonly RoomTurnGroup[], runs: Record<string, Run | undefined>): Map<string, TurnSummaryPlan> {
  const ready = groups.flatMap(group => {
    const groupRuns = group.runIds.map(id => runs[id])
    return settled(groupRuns) ? [{ group, runs: groupRuns }] : []
  })
  const owner = new Map<string, string>()
  for (const { group, runs: groupRuns } of ready)
    for (const run of groupRuns) for (const change of run.workspace_changes ?? []) owner.set(change.change_set_id, group.anchorMessageId)
  return new Map(ready.map(({ group, runs: groupRuns }) => [group.anchorMessageId, {
    runs: groupRuns,
    exclude: new Set([...owner].filter(([, anchor]) => anchor !== group.anchorMessageId).map(([id]) => id)),
  }]))
}

/**
 * Batches that a mounted summary is actually displaying, as each reports it.
 * Pending conversation work leaves out only these: a summary still checking,
 * failing to read a Run, or not rendered at all claims nothing, so a blocked
 * batch is never hidden from both places.
 */
export function usePresentedChanges() {
  const [byAnchor, setByAnchor] = useState<Record<string, string>>({})
  const report = useCallback((anchor: string, ids: readonly string[]) => {
    const key = [...ids].sort().join(',')
    setByAnchor(held => {
      if ((held[anchor] ?? '') === key) return held
      const next = { ...held }
      if (key) next[anchor] = key
      else delete next[anchor]
      return next
    })
  }, [])
  const presented = useMemo(() => new Set(Object.values(byAnchor).flatMap(key => key.split(','))), [byAnchor])
  return { presented, report }
}
