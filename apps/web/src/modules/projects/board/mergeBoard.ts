import type { ProjectBoard, ProjectBoardCard, ProjectBoardColumn } from '../../../types/api'

/**
 * Folds a freshly read Board into the one already drawn, keeping the object
 * identity of everything that did not change.
 *
 * The Board re-reads every few seconds. Replacing the state wholesale gave
 * React a new object for every card on every read, so the whole grid
 * reconciled and re-rendered when one card had moved — and usually when
 * nothing had. Identity is what lets `memo` tell those apart, so this is the
 * piece that makes a memoised lane worth anything.
 *
 * Returns the previous Board unchanged when the read is identical, so a quiet
 * poll sets no state at all and renders nothing.
 */
export function mergeBoard(previous: ProjectBoard | null, next: ProjectBoard): ProjectBoard {
  if (!previous) return next
  const cards = mergeById(previous.cards, next.cards)
  const columns = mergeColumns(previous.columns, next.columns)
  const rest =
    same(previous.project, next.project) &&
    same(previous.filters, next.filters) &&
    previous.viewer_user_id === next.viewer_user_id &&
    previous.viewer_can_write === next.viewer_can_write
  if (rest && cards === previous.cards && columns === previous.columns) return previous
  return {
    ...next,
    project: same(previous.project, next.project) ? previous.project : next.project,
    filters: same(previous.filters, next.filters) ? previous.filters : next.filters,
    cards,
    columns,
  }
}

/**
 * The card list, with every unchanged card kept as the object already rendered.
 * Order comes from the read; only identity is borrowed.
 */
function mergeById(previous: readonly ProjectBoardCard[], next: readonly ProjectBoardCard[]): ProjectBoardCard[] {
  const byId = new Map(previous.map(card => [card.id, card]))
  let changed = previous.length !== next.length
  const merged = next.map((card, index) => {
    const before = byId.get(card.id)
    if (before && same(before, card)) {
      // Same card, and in the same place: nothing about this entry is new.
      if (previous[index] !== before) changed = true
      return before
    }
    changed = true
    return card
  })
  return changed ? merged : (previous as ProjectBoardCard[])
}

function mergeColumns(previous: readonly ProjectBoardColumn[], next: readonly ProjectBoardColumn[]): ProjectBoardColumn[] {
  const byKey = new Map(previous.map(column => [column.status_key, column]))
  let changed = previous.length !== next.length
  const merged = next.map((column, index) => {
    const before = byKey.get(column.status_key)
    if (before && same(before, column)) {
      if (previous[index] !== before) changed = true
      return before
    }
    changed = true
    return column
  })
  return changed ? merged : (previous as ProjectBoardColumn[])
}

/**
 * Value equality over the DTO. These are plain JSON the server built in a
 * stable key order, so a string compare is both correct and the cheapest
 * thing that is.
 */
function same(left: unknown, right: unknown): boolean {
  return left === right || JSON.stringify(left) === JSON.stringify(right)
}

/**
 * Moves one card between lanes locally, so a drag lands where it was dropped
 * instead of waiting out a round trip.
 *
 * The move used to re-read the Board through the loading path, which replaced
 * the whole page with a skeleton and painted it again — the card appeared to
 * jump back before arriving. Only the dragged card and the two lane counts it
 * changes are touched here; the read that follows reconciles through
 * `mergeBoard`, so anything the server decided differently still arrives.
 */
export function applyCardMove(board: ProjectBoard, cardId: string, toStatus: string): ProjectBoard {
  const moving = board.cards.find(card => card.id === cardId)
  if (!moving || moving.column_key === toStatus) return board
  const from = moving.column_key
  return {
    ...board,
    cards: board.cards.map(card =>
      card.id === cardId ? { ...card, status: toStatus, column_key: toStatus } : card),
    columns: board.columns.map(column => {
      if (column.status_key === from) return { ...column, count: Math.max(0, column.count - 1) }
      if (column.status_key === toStatus) return { ...column, count: column.count + 1 }
      return column
    }),
  }
}
