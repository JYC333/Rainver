import { describe, expect, it } from 'vitest'
import type { InquiryThread } from '../../../../types/api'
import {
  eligiblePrimaryParents, flattenThreadTree, groupThreadsForNavigator, priorityLabel,
} from '../threadGrouping'

function thread(overrides: Partial<InquiryThread> & { id: string }): InquiryThread {
  return {
    space_id: 'space-1', project_id: 'project-1', kind: 'question', statement: `Statement ${overrides.id}`,
    lifecycle_status: 'active', attention_state: 'backlog', priority: 1,
    primary_parent_id: null, owner_user_id: null,
    next_focus_kind: null, next_focus_note: null, blocked_reason: null,
    version: 1, created_from: 'user', created_by_user_id: 'user-1',
    created_at: '2026-07-23T00:00:00.000Z', updated_at: '2026-07-23T00:00:00.000Z',
    ...overrides,
  }
}

describe('groupThreadsForNavigator', () => {
  it('orders groups so the working set comes before the queue', () => {
    const groups = groupThreadsForNavigator([
      thread({ id: 'a', attention_state: 'backlog' }),
      thread({ id: 'b', attention_state: 'focused' }),
      thread({ id: 'c', attention_state: 'monitoring' }),
      thread({ id: 'd', attention_state: 'blocked' }),
    ])
    expect(groups.map(group => group.id)).toEqual(['focused', 'blocked', 'monitoring', 'backlog'])
  })

  it('collapses the queue and closed work by default but never the working set', () => {
    const groups = groupThreadsForNavigator([
      thread({ id: 'a', attention_state: 'focused' }),
      thread({ id: 'b', attention_state: 'backlog' }),
      thread({ id: 'c', lifecycle_status: 'resolved', attention_state: 'resolved' }),
    ])
    expect(groups.find(group => group.id === 'focused')?.defaultCollapsed).toBe(false)
    expect(groups.find(group => group.id === 'backlog')?.defaultCollapsed).toBe(true)
    expect(groups.find(group => group.id === 'closed')?.defaultCollapsed).toBe(true)
  })

  it('groups a non-active Thread as closed regardless of its attention state', () => {
    const groups = groupThreadsForNavigator([
      thread({ id: 'a', lifecycle_status: 'archived', attention_state: 'focused' }),
    ])
    expect(groups.map(group => group.id)).toEqual(['closed'])
  })

  it('omits empty groups instead of rendering placeholder headings', () => {
    const groups = groupThreadsForNavigator([thread({ id: 'a', attention_state: 'focused' })])
    expect(groups).toHaveLength(1)
  })

  it('sorts higher priority first, then oldest first', () => {
    const groups = groupThreadsForNavigator([
      thread({ id: 'low', priority: 0, created_at: '2026-07-01T00:00:00.000Z' }),
      thread({ id: 'high-new', priority: 2, created_at: '2026-07-20T00:00:00.000Z' }),
      thread({ id: 'high-old', priority: 2, created_at: '2026-07-02T00:00:00.000Z' }),
    ])
    expect(groups[0]!.threads.map(item => item.id)).toEqual(['high-old', 'high-new', 'low'])
  })
})

describe('priorityLabel', () => {
  it('maps the stored integer onto the three levels the UI offers', () => {
    expect(priorityLabel(2)).toBe('High')
    expect(priorityLabel(1)).toBe('Normal')
    expect(priorityLabel(0)).toBe('Low')
  })
})

describe('eligiblePrimaryParents', () => {
  it('excludes the Thread itself and its descendants so the tree stays acyclic', () => {
    const threads = [
      thread({ id: 'root' }),
      thread({ id: 'child', primary_parent_id: 'root' }),
      thread({ id: 'grandchild', primary_parent_id: 'child' }),
      thread({ id: 'unrelated' }),
    ]
    expect(eligiblePrimaryParents(threads, 'root').map(item => item.id)).toEqual(['unrelated'])
    expect(eligiblePrimaryParents(threads, 'child').map(item => item.id)).toEqual(['root', 'unrelated'])
  })
})

describe('flattenThreadTree', () => {
  it('nests children under their parent', () => {
    const rows = flattenThreadTree([
      thread({ id: 'child', primary_parent_id: 'root' }),
      thread({ id: 'root' }),
    ])
    expect(rows.map(row => [row.thread.id, row.depth])).toEqual([['root', 0], ['child', 1]])
  })

  it('treats a parent outside this Project view as a root so no Thread disappears', () => {
    const rows = flattenThreadTree([thread({ id: 'orphan', primary_parent_id: 'missing' })])
    expect(rows.map(row => [row.thread.id, row.depth])).toEqual([['orphan', 0]])
  })
})
