import { KeyboardCode, type KeyboardCoordinateGetter } from '@dnd-kit/core'

/**
 * Keyboard moves jump a card to the neighbouring lane.
 *
 * dnd-kit's default getter nudges by a fixed number of pixels per key press,
 * which makes a keyboard user press Right eleven times to cross one lane and
 * still land somewhere the collision detector may not count as "in" it. The
 * only unit the Board judges a move in is the lane, so that is the unit an
 * arrow key moves by: the next lane's centre to the right or left, in the
 * order the lanes are laid out on screen.
 */
export const laneKeyboardCoordinates: KeyboardCoordinateGetter = (event, { context }) => {
  const { active, collisionRect, droppableRects, droppableContainers } = context
  if (!active || !collisionRect) return undefined
  if (event.code !== KeyboardCode.Right && event.code !== KeyboardCode.Left) return undefined

  const lanes = droppableContainers
    .getEnabled()
    .map(container => ({ id: container.id, rect: droppableRects.get(container.id) }))
    .filter((lane): lane is { id: typeof lane.id; rect: NonNullable<typeof lane.rect> } => lane.rect != null)
    .sort((a, b) => a.rect.left - b.rect.left)
  if (lanes.length === 0) return undefined

  const centre = collisionRect.left + collisionRect.width / 2
  const currentIndex = lanes.findIndex(lane => centre >= lane.rect.left && centre <= lane.rect.left + lane.rect.width)
  const targetIndex = event.code === KeyboardCode.Right
    ? (currentIndex < 0 ? 0 : Math.min(currentIndex + 1, lanes.length - 1))
    : (currentIndex < 0 ? lanes.length - 1 : Math.max(currentIndex - 1, 0))
  if (targetIndex === currentIndex) return undefined

  const target = lanes[targetIndex]!.rect
  return {
    x: target.left + target.width / 2 - collisionRect.width / 2,
    y: collisionRect.top,
  }
}
