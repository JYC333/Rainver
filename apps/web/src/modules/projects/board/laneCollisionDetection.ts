import { rectIntersection, type CollisionDetection } from '@dnd-kit/core'

export const laneCollisionDetection: CollisionDetection = args => {
  const droppableRects = new Map(args.droppableRects)
  // Keep the drop node inside the card scroller for auto-scroll, but accept the whole visible lane.
  for (const container of args.droppableContainers) {
    const lane = container.node.current?.closest<HTMLElement>('[data-board-lane]')
    if (lane) droppableRects.set(container.id, lane.getBoundingClientRect())
  }
  const collisions = rectIntersection({ ...args, droppableRects })
  if (!args.pointerCoordinates) return collisions
  const { x, y } = args.pointerCoordinates
  return collisions.filter(collision => {
    const node = args.droppableContainers.find(item => item.id === collision.id)?.node.current
    if (!node) return false
    const lane = node.closest<HTMLElement>('[data-board-lane]') ?? node
    const board = node.closest<HTMLElement>('[data-board-viewport]')
    return [lane, board].every(area => {
      if (!area) return false
      const rect = area.getBoundingClientRect()
      return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom
    })
  })
}
