import type { InquiryThread } from '../../../types/api'

export type ThreadGroupId = 'focused' | 'blocked' | 'monitoring' | 'backlog' | 'closed'

export interface ThreadGroup {
  id: ThreadGroupId
  label: string
  threads: InquiryThread[]
  /** Rarely-acted-on groups start collapsed so the working set stays visible. */
  defaultCollapsed: boolean
}

const GROUP_ORDER: Array<{ id: ThreadGroupId; label: string; defaultCollapsed: boolean }> = [
  { id: 'focused', label: 'Focused', defaultCollapsed: false },
  { id: 'blocked', label: 'Blocked', defaultCollapsed: false },
  { id: 'monitoring', label: 'Monitoring', defaultCollapsed: false },
  { id: 'backlog', label: 'Backlog', defaultCollapsed: true },
  { id: 'closed', label: 'Resolved / closed', defaultCollapsed: true },
]

function groupIdFor(thread: InquiryThread): ThreadGroupId {
  if (thread.lifecycle_status !== 'active') return 'closed'
  switch (thread.attention_state) {
    case 'focused': return 'focused'
    case 'blocked': return 'blocked'
    case 'monitoring': return 'monitoring'
    case 'backlog': return 'backlog'
    default: return 'closed'
  }
}

/**
 * Higher priority first, then oldest first — a Backlog that has grown past a
 * screenful needs an ordering the user controls, and `priority` is the only
 * field the domain has for it.
 */
export function compareThreadsForNavigator(a: InquiryThread, b: InquiryThread): number {
  if (a.priority !== b.priority) return b.priority - a.priority
  return a.created_at.localeCompare(b.created_at)
}

export function groupThreadsForNavigator(threads: InquiryThread[]): ThreadGroup[] {
  const byGroup = new Map<ThreadGroupId, InquiryThread[]>()
  for (const thread of threads) {
    const id = groupIdFor(thread)
    byGroup.set(id, [...(byGroup.get(id) ?? []), thread])
  }
  return GROUP_ORDER
    .map(group => ({
      ...group,
      threads: (byGroup.get(group.id) ?? []).sort(compareThreadsForNavigator),
    }))
    .filter(group => group.threads.length > 0)
}

export const PRIORITY_OPTIONS = [
  { value: '2', label: 'High' },
  { value: '1', label: 'Normal' },
  { value: '0', label: 'Low' },
]

export function priorityLabel(priority: number): string {
  if (priority >= 2) return 'High'
  if (priority <= 0) return 'Low'
  return 'Normal'
}

/** Threads a parent can be reparented onto: never itself, never its own descendants. */
export function eligiblePrimaryParents(threads: InquiryThread[], threadId: string): InquiryThread[] {
  const descendants = new Set<string>([threadId])
  let grew = true
  while (grew) {
    grew = false
    for (const thread of threads) {
      if (thread.primary_parent_id && descendants.has(thread.primary_parent_id) && !descendants.has(thread.id)) {
        descendants.add(thread.id)
        grew = true
      }
    }
  }
  return threads.filter(thread => !descendants.has(thread.id))
}

export interface ThreadTreeRow { thread: InquiryThread; depth: number }

export function flattenThreadTree(threads: InquiryThread[]): ThreadTreeRow[] {
  const children = new Map<string | null, InquiryThread[]>()
  for (const thread of threads) {
    const key = thread.primary_parent_id && threads.some(candidate => candidate.id === thread.primary_parent_id)
      ? thread.primary_parent_id
      : null
    children.set(key, [...(children.get(key) ?? []), thread])
  }
  const rows: ThreadTreeRow[] = []
  const visit = (parent: string | null, depth: number) => {
    for (const thread of (children.get(parent) ?? []).sort(compareThreadsForNavigator)) {
      rows.push({ thread, depth })
      visit(thread.id, depth + 1)
    }
  }
  visit(null, 0)
  return rows
}
