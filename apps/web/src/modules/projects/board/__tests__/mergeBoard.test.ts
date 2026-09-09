import { describe, expect, it } from 'vitest'
import { applyCardMove, mergeBoard } from '../mergeBoard'
import type { ProjectBoard, ProjectBoardCard } from '../../../../types/api'

/**
 * The Board re-reads every few seconds. Replacing the state wholesale handed
 * React a new object for every card each time, so one card moving re-rendered
 * the entire grid — and so did a read where nothing had moved at all.
 */
const card = (id: string, column: string, updated = '2026-09-08T00:00:00.000Z'): ProjectBoardCard => ({
  id,
  title: `Task ${id}`,
  status: column,
  priority: 'normal',
  risk_level: 'low',
  due_at: null,
  updated_at: updated,
  column_key: column,
  loop_stage: null,
  loop_stage_label: null,
  responsible: { kind: 'user', id: 'u1', label: 'Someone' },
  active_run_count: 0,
  latest_run_status: null,
  evaluation_recommendation: null,
  blocked_reason: null,
  completion: { ok: true, missing: [] },
} as unknown as ProjectBoardCard)

const board = (cards: ProjectBoardCard[]): ProjectBoard => ({
  project: { id: 'p1', name: 'Project' },
  columns: [
    { status_key: 'inbox', label: 'Inbox', wip_limit: null, count: cards.filter(c => c.column_key === 'inbox').length },
    { status_key: 'done', label: 'Done', wip_limit: null, count: cards.filter(c => c.column_key === 'done').length },
  ],
  cards,
  viewer_user_id: 'u1',
  viewer_can_write: true,
  filters: { all: cards.length, mine: 0, agents: 0, blocked: 0 },
} as unknown as ProjectBoard)

describe('folding a Board read into the one already drawn', () => {
  it('returns the very same object when nothing changed, so no state is set', () => {
    const drawn = board([card('a', 'inbox'), card('b', 'inbox')])
    expect(mergeBoard(drawn, board([card('a', 'inbox'), card('b', 'inbox')]))).toBe(drawn)
  })

  it('keeps every untouched card as the object already rendered', () => {
    const drawn = board([card('a', 'inbox'), card('b', 'inbox')])
    const next = mergeBoard(drawn, board([card('a', 'inbox'), card('b', 'done', '2026-09-08T01:00:00.000Z')]))

    expect(next).not.toBe(drawn)
    expect(next.cards[0]).toBe(drawn.cards[0])
    expect(next.cards[1]).not.toBe(drawn.cards[1])
    expect(next.cards[1]?.column_key).toBe('done')
  })

  it('compares columns one at a time, and settles once the move is drawn', () => {
    const drawn = board([card('a', 'inbox'), card('b', 'inbox')])
    const moved = board([card('a', 'inbox'), card('b', 'done', '2026-09-08T01:00:00.000Z')])
    const next = mergeBoard(drawn, moved)
    expect(next.columns[0]).not.toBe(drawn.columns[0])

    const quiet = mergeBoard(next, board([card('a', 'inbox'), card('b', 'done', '2026-09-08T01:00:00.000Z')]))
    expect(quiet).toBe(next)
  })

  it('notices a card that was added and one that was removed', () => {
    const drawn = board([card('a', 'inbox')])
    const added = mergeBoard(drawn, board([card('a', 'inbox'), card('c', 'inbox')]))
    expect(added.cards).toHaveLength(2)
    expect(added.cards[0]).toBe(drawn.cards[0])

    const removed = mergeBoard(added, board([card('c', 'inbox')]))
    expect(removed.cards).toHaveLength(1)
    expect(removed.cards[0]).toBe(added.cards[1])
  })

  it('takes the read whole on the first paint', () => {
    const first = board([card('a', 'inbox')])
    expect(mergeBoard(null, first)).toBe(first)
  })

  it('re-renders when only the viewer permissions changed', () => {
    const drawn = board([card('a', 'inbox')])
    const next = { ...board([card('a', 'inbox')]), viewer_can_write: false }
    expect(mergeBoard(drawn, next)).not.toBe(drawn)
  })
})

describe('drawing a drag where it was dropped', () => {
  it('moves only the dragged card and the two lane counts', () => {
    const drawn = board([card('a', 'inbox'), card('b', 'inbox')])
    const moved = applyCardMove(drawn, 'b', 'done')

    expect(moved.cards[0]).toBe(drawn.cards[0])
    expect(moved.cards[1]?.column_key).toBe('done')
    expect(moved.cards[1]?.status).toBe('done')
    expect(moved.columns.find(c => c.status_key === 'inbox')?.count).toBe(1)
    expect(moved.columns.find(c => c.status_key === 'done')?.count).toBe(1)
  })

  it('is its own inverse, so a refused move puts the card back', () => {
    const drawn = board([card('a', 'inbox'), card('b', 'inbox')])
    const moved = applyCardMove(drawn, 'b', 'done')
    const back = applyCardMove(moved, 'b', 'inbox')
    expect(back.cards[1]?.column_key).toBe('inbox')
    expect(back.columns.find(c => c.status_key === 'inbox')?.count).toBe(2)
    expect(back.columns.find(c => c.status_key === 'done')?.count).toBe(0)
  })

  it('changes nothing for a drop back onto the lane the card is in', () => {
    const drawn = board([card('a', 'inbox')])
    expect(applyCardMove(drawn, 'a', 'inbox')).toBe(drawn)
  })

  it('changes nothing for a card the Board does not have', () => {
    const drawn = board([card('a', 'inbox')])
    expect(applyCardMove(drawn, 'missing', 'done')).toBe(drawn)
  })
})
