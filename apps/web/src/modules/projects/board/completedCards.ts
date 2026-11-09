import type { ProjectBoardCard } from '../../../types/api'

export const COMPLETED_CARDS_PAGE_SIZE = 20
const RECENT_COMPLETION_MS = 7 * 24 * 60 * 60 * 1000

function completionTime(card: ProjectBoardCard): number {
  return Date.parse(card.completed_at ?? '')
}

export function completedCardsView(cards: ProjectBoardCard[], extraCount: number, now = Date.now()) {
  const completed = cards.filter(card => card.status === 'done').sort((left, right) => {
    const leftTime = completionTime(left)
    const rightTime = completionTime(right)
    return (Number.isFinite(rightTime) ? rightTime : Date.parse(right.updated_at)) -
      (Number.isFinite(leftTime) ? leftTime : Date.parse(left.updated_at))
  })
  const initial = completed.filter(card => {
    const time = completionTime(card)
    // Missing completion dates have no known age; updates are only an ordering hint.
    return !Number.isFinite(time) || time >= now - RECENT_COMPLETION_MS
  }).slice(0, COMPLETED_CARDS_PAGE_SIZE)
  const visibleIds = new Set(initial.map(card => card.id))
  const remaining = completed.filter(card => !visibleIds.has(card.id))
  for (const card of remaining.slice(0, extraCount)) visibleIds.add(card.id)
  return {
    cards: [
      ...cards.filter(card => card.status !== 'done'),
      ...completed.filter(card => visibleIds.has(card.id)),
    ],
    completedCount: completed.length,
    visibleCompletedCount: visibleIds.size,
    hiddenCount: completed.length - visibleIds.size,
    canCollapse: extraCount > 0 && visibleIds.size > initial.length,
  }
}
