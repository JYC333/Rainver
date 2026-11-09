import type { RoomMessage, Run } from '../../types/api'

/** Settled for display; `waiting_for_review` is listed but still awaits a person. */
export function isTerminalRunStatus(status: string): boolean {
  return ['succeeded', 'failed', 'degraded', 'cancelled', 'orphaned', 'waiting_for_review'].includes(status)
}

/**
 * Every Run this message is tied to.
 *
 * `run_id` is the column: the Run that produced an Agent reply, or the Run a
 * person's message started. `metadata_json.run_ids` is the separate Room case
 * where one dispatched message fanned out to several recipients;
 * `delegated_run_ids` lists the child Runs an Agent delegated while answering
 * it.
 */
export function messageRunIds(message: {
  metadata_json?: RoomMessage['metadata_json']
  run_id?: string | null
}): string[] {
  const fanout = message.metadata_json?.run_ids
  const retries = message.metadata_json?.retry_run_ids
  const superseded = new Set(Array.isArray(message.metadata_json?.retry_superseded_run_ids)
    ? message.metadata_json.retry_superseded_run_ids.filter((id): id is string => typeof id === 'string')
    : [])
  const delegated = message.metadata_json?.delegated_run_ids
  const ids = [
    ...(Array.isArray(fanout) ? fanout.filter(id => typeof id === 'string' && !superseded.has(id)) : []),
    ...(Array.isArray(retries) ? retries.filter(id => typeof id === 'string' && !superseded.has(id)) : []),
    ...(Array.isArray(delegated) ? delegated : []),
    ...(message.run_id ? [message.run_id] : []),
  ]
  return [...new Set(ids.filter((id): id is string => typeof id === 'string' && Boolean(id)))]
}

export function delegatedRunIds(message: { metadata_json?: RoomMessage['metadata_json'] }): string[] {
  const delegated = message.metadata_json?.delegated_run_ids
  return Array.isArray(delegated) ? delegated.filter((id): id is string => typeof id === 'string') : []
}

/** Union-find over Run ids; tolerates malformed cyclic metadata. */
function runGroups() {
  const groups = new Map<string, string>()
  function group(id: string): string {
    if (!groups.has(id)) groups.set(id, id)
    let root = id
    while (groups.get(root) !== root) root = groups.get(root)!
    while (id !== root) {
      const next = groups.get(id)!
      groups.set(id, root)
      id = next
    }
    return root
  }
  return { group, union: (a: string, b: string) => { const left = group(a), right = group(b); if (left !== right) groups.set(left, right) } }
}

type RunLinks = Pick<Run, 'parent_run_id'> & { delegation_id?: string | null }

/**
 * Explicitly delegated children among the loaded messages and Runs: those a
 * loaded message announces, and those the server marks with a delegation
 * record. The second holds when the announcing message is on an earlier page
 * than the child's reply. parent_run_id alone can mean serial scheduling.
 */
export function delegatedChildren(messages: readonly RoomMessage[], runs: Record<string, RunLinks | undefined>): Set<string> {
  const ids = new Set(messages.flatMap(delegatedRunIds))
  for (const [id, run] of Object.entries(runs)) if (run?.delegation_id && run.parent_run_id) ids.add(id)
  return ids
}

function unionDelegations(children: ReadonlySet<string>, runs: Record<string, RunLinks | undefined>, union: (a: string, b: string) => void) {
  for (const child of children) {
    const parent = runs[child]?.parent_run_id
    if (parent) union(child, parent)
  }
}

/**
 * Project live turns onto the persisted timeline. Only explicitly delegated
 * edges form a group: parent_run_id alone can mean serial workspace scheduling.
 * Every unfinished member follows the latest visible message in its group;
 * replies own their completed turn and never get moved or duplicated.
 */
export function roomLiveRunAnchors(messages: readonly RoomMessage[], runs: Record<string, RunLinks | undefined>): Map<string, string[]> {
  const { group, union } = runGroups()
  // Build the relation before projecting messages, so partial polling order
  // does not affect grouping.
  unionDelegations(delegatedChildren(messages, runs), runs, union)
  const replied = new Set(messages.flatMap(message => message.role === 'assistant' && message.run_id ? [message.run_id] : []))
  const pending = new Set<string>()
  const latest = new Map<string, string>()
  for (const message of messages) {
    for (const runId of messageRunIds(message)) {
      latest.set(group(runId), message.id)
      if (!replied.has(runId)) pending.add(runId)
    }
  }
  const byMessage = new Map<string, string[]>()
  for (const runId of pending) {
    const messageId = latest.get(group(runId))!
    const ids = byMessage.get(messageId) ?? []
    ids.push(runId)
    byMessage.set(messageId, ids)
  }
  return byMessage
}

export type RoomTurnGroup = {
  /** The message the group's single workspace summary is shown under. */
  anchorMessageId: string
  /** Every Run of one request and its explicit delegations, in first-seen order. */
  runIds: string[]
}

/**
 * Group the loaded timeline by request: the Runs one message started (fan-out
 * and live retries) together with their explicitly delegated children. The
 * anchor is the main Agent's final reply — the latest reply of a Run that is
 * not a delegated child — or, while there is none (a failed turn), the latest
 * message the group touches. Delegated children never become anchors.
 */
export function roomTurnGroups(messages: readonly RoomMessage[], runs: Record<string, RunLinks | undefined>): RoomTurnGroup[] {
  const { group, union } = runGroups()
  const delegated = delegatedChildren(messages, runs)
  unionDelegations(delegated, runs, union)
  for (const message of messages) {
    const ids = messageRunIds(message)
    for (const id of ids.slice(1)) union(ids[0]!, id)
  }
  const members = new Map<string, string[]>()
  const reply = new Map<string, string>()
  const latest = new Map<string, string>()
  for (const message of messages) {
    for (const runId of messageRunIds(message)) {
      const root = group(runId)
      const list = members.get(root) ?? []
      if (!list.includes(runId)) list.push(runId)
      members.set(root, list)
      latest.set(root, message.id)
    }
    if (message.role === 'assistant' && message.run_id && !delegated.has(message.run_id)) reply.set(group(message.run_id), message.id)
  }
  const order = new Map(messages.map((message, index) => [message.id, index]))
  return [...members.entries()]
    .map(([root, runIds]) => ({ anchorMessageId: reply.get(root) ?? latest.get(root)!, runIds }))
    .sort((a, b) => order.get(a.anchorMessageId)! - order.get(b.anchorMessageId)!)
}
