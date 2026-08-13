import { describe, it, expect, vi } from 'vitest'
import { publishNoteChanged, subscribeNoteChanged } from '../core/noteEvents'

describe('noteEvents', () => {
  it('delivers a write announcement to every live subscriber', () => {
    const a = vi.fn()
    const b = vi.fn()
    const stopA = subscribeNoteChanged(a)
    const stopB = subscribeNoteChanged(b)

    publishNoteChanged({ noteId: 'note-1', projectId: 'project-1', reason: 'capture' })

    const detail = { noteId: 'note-1', projectId: 'project-1', reason: 'capture' }
    expect(a).toHaveBeenCalledWith(detail)
    expect(b).toHaveBeenCalledWith(detail)
    stopA()
    stopB()
  })

  it('stops delivering once unsubscribed, so an unmounted surface costs nothing', () => {
    const handler = vi.fn()
    subscribeNoteChanged(handler)()

    publishNoteChanged({ noteId: 'note-1', projectId: null, reason: 'capture' })

    expect(handler).not.toHaveBeenCalled()
  })
})
