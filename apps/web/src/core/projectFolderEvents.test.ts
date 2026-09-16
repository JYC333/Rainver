import { act } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  notifyProjectFolderContentChanged,
  subscribeProjectFolderContentChanged,
} from './projectFolderEvents'

afterEach(() => {
  vi.restoreAllMocks()
})

describe('Project Folder content events', () => {
  it('notifies subscribers with deduplicated Folder ids', () => {
    const received: string[][] = []
    const stop = subscribeProjectFolderContentChanged(detail => received.push(detail.projectFolderIds))

    act(() => notifyProjectFolderContentChanged(['folder-1', 'folder-1', '', 'folder-2']))

    expect(received).toEqual([['folder-1', 'folder-2']])
    stop()
  })

  it('does not emit an event for an empty Folder set', () => {
    const listener = vi.fn()
    window.addEventListener('rainver:project-folder-content-changed', listener)

    act(() => notifyProjectFolderContentChanged([]))

    expect(listener).not.toHaveBeenCalled()
    window.removeEventListener('rainver:project-folder-content-changed', listener)
  })
})
