import type { RoomMessage, Run } from '../../types/api'

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

/**
 * Project live turns onto the persisted timeline. Only explicitly delegated
 * edges form a group: parent_run_id alone can mean serial workspace scheduling.
 * Every unfinished member follows the latest visible message in its group;
 * replies own their completed turn and never get moved or duplicated.
 */
export function roomLiveRunAnchors(messages: readonly RoomMessage[], runs: Record<string, Pick<Run, 'parent_run_id'>>): Map<string, string[]> {
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
  // Build the relation before projecting messages, so partial polling order
  // does not affect grouping. Union also tolerates malformed cyclic metadata.
  for (const child of new Set(messages.flatMap(delegatedRunIds))) {
    const parent = runs[child]?.parent_run_id
    if (parent) groups.set(group(child), group(parent))
  }
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
