import { describe, expect, it } from 'vitest'
import { KeyboardCode } from '@dnd-kit/core'
import { laneKeyboardCoordinates } from '../board/laneKeyboardCoordinates'

/**
 * The keyboard path is the only one a person who cannot drag has, so the
 * unit it moves in must be the lane — not a pixel nudge that may land between
 * two of them.
 */
function context(lanes: Array<[string, number]>, activeLeft: number) {
  const rect = (left: number) => ({ left, top: 0, width: 200, height: 400, right: left + 200, bottom: 400 })
  const droppableRects = new Map(lanes.map(([id, left]) => [id, rect(left)]))
  return {
    active: { id: 'card-1' },
    collisionRect: { left: activeLeft, top: 10, width: 180, height: 60, right: activeLeft + 180, bottom: 70 },
    droppableRects,
    droppableContainers: { getEnabled: () => lanes.map(([id]) => ({ id })) },
  } as never
}

const lanes: Array<[string, number]> = [['inbox', 0], ['ready', 220], ['in_progress', 440], ['done', 660]]

describe('lane keyboard coordinates', () => {
  it('moves one lane to the right, landing in its centre', () => {
    const next = laneKeyboardCoordinates({ code: KeyboardCode.Right } as never, { context: context(lanes, 230) } as never)
    // From "ready" (220–420) to "in_progress" (440–640): centred, so the
    // collision detector counts the card as in that lane and no other.
    expect(next).toEqual({ x: 440 + 100 - 90, y: 10 })
  })

  it('moves one lane to the left and stops at the edges', () => {
    const left = laneKeyboardCoordinates({ code: KeyboardCode.Left } as never, { context: context(lanes, 450) } as never)
    expect(left?.x).toBe(220 + 100 - 90)
    // Already in the last lane: Right does nothing rather than falling off.
    expect(laneKeyboardCoordinates({ code: KeyboardCode.Right } as never, { context: context(lanes, 670) } as never))
      .toBeUndefined()
    expect(laneKeyboardCoordinates({ code: KeyboardCode.Left } as never, { context: context(lanes, 10) } as never))
      .toBeUndefined()
  })

  it('leaves the other keys to the default behaviour', () => {
    expect(laneKeyboardCoordinates({ code: KeyboardCode.Down } as never, { context: context(lanes, 230) } as never))
      .toBeUndefined()
  })
})
