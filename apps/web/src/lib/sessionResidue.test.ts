import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  __resetLogoutChannelForTests,
  API_CACHE_NAME,
  API_KEY_STORAGE,
  announceLogout,
  clearAuthenticatedBrowserState,
  clearSessionResidue,
  scopedUserStorageKey,
  watchCrossTabLogout,
} from './sessionResidue'

describe('clearAuthenticatedBrowserState', () => {
  beforeEach(() => {
    localStorage.clear()
    sessionStorage.clear()
  })

  it('drops content leftovers and the API cache, and keeps chrome prefs', async () => {
    localStorage.setItem(API_KEY_STORAGE, 'rvk_old')
    localStorage.setItem('rainver:research-setup-session:u1:p1:new', JSON.stringify({ draft: { research_question: 'secret' } }))
    localStorage.setItem('project:p1:research-workflow', 'wf-1')
    localStorage.setItem('project-notebook-chat-session:p1', 'sess-1')
    localStorage.setItem('rainver:notebook-chat-session:u1:p1', 'sess-2')
    localStorage.setItem('project.sidecar.room.room-1.conversation', 'conv-1')
    localStorage.setItem('context_ops.explain_presets.space-1', '[]')
    localStorage.setItem('rainver:theme', 'dark')
    localStorage.setItem('project.sidecar.width', '384')
    sessionStorage.setItem('rainver:notes-tabs:personal-1:all', JSON.stringify(['n1']))
    sessionStorage.setItem('rainver.reference.room.room-1', '[]')

    const deleted: string[] = []
    vi.stubGlobal('caches', {
      delete: vi.fn(async (name: string) => {
        deleted.push(name)
        return true
      }),
    })

    await clearAuthenticatedBrowserState()

    expect(localStorage.getItem(API_KEY_STORAGE)).toBeNull()
    expect(localStorage.getItem('rainver:research-setup-session:u1:p1:new')).toBeNull()
    expect(localStorage.getItem('project:p1:research-workflow')).toBeNull()
    expect(localStorage.getItem('project-notebook-chat-session:p1')).toBeNull()
    expect(localStorage.getItem('rainver:notebook-chat-session:u1:p1')).toBeNull()
    expect(localStorage.getItem('project.sidecar.room.room-1.conversation')).toBeNull()
    expect(localStorage.getItem('context_ops.explain_presets.space-1')).toBeNull()
    expect(sessionStorage.getItem('rainver:notes-tabs:personal-1:all')).toBeNull()
    expect(sessionStorage.getItem('rainver.reference.room.room-1')).toBeNull()
    expect(localStorage.getItem('rainver:theme')).toBe('dark')
    expect(localStorage.getItem('project.sidecar.width')).toBe('384')
    expect(deleted).toEqual([API_CACHE_NAME])
  })

  it('clears a key nobody has thought of yet', () => {
    // The point of a keep-list. A delete-list retained every new content key
    // until somebody remembered to add its prefix, and nobody found out until
    // the next person on that machine saw it.
    localStorage.setItem('rainver:some-feature-nobody-has-written-yet:p1', 'a note body')
    sessionStorage.setItem('brand.new.pane.state', 'thread-7')
    clearSessionResidue()
    expect(localStorage.getItem('rainver:some-feature-nobody-has-written-yet:p1')).toBeNull()
    expect(sessionStorage.getItem('brand.new.pane.state')).toBeNull()
  })

  it('scopes durable keys by user', () => {
    expect(scopedUserStorageKey('research-workflow', 'user-1', 'project-1'))
      .toBe('rainver:research-workflow:user-1:project-1')
  })
})

describe('cross-tab logout', () => {
  afterEach(() => {
    __resetLogoutChannelForTests()
  })

  it('does not hear its own announcement', async () => {
    // A `BroadcastChannel` never delivers to itself, but it does deliver to
    // every other channel object — including another one in the same tab. So
    // announcing through a second object made the tab that signed out run the
    // remote handler on itself.
    let told = 0
    const stop = watchCrossTabLogout(() => { told += 1 })
    announceLogout()
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(told).toBe(0)
    stop()
  })

  it('tells the other tabs, and runs the handler when another tab tells this one', async () => {
    // Signing out in one tab used to leave every other tab holding a rendered
    // page full of the previous person's content until something made it call
    // the API.
    let told = 0
    const stop = watchCrossTabLogout(() => { told += 1 })
    const other = new BroadcastChannel('rainver:auth')
    other.postMessage('logged-out')
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(told).toBe(1)

    // And an unrelated message on the same channel is not a logout.
    other.postMessage('something-else')
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(told).toBe(1)
    other.close()
    stop()
  })

  it('does nothing when the browser has no BroadcastChannel', () => {
    const original = globalThis.BroadcastChannel
    // @ts-expect-error deleting a global for the unsupported-browser path
    delete globalThis.BroadcastChannel
    try {
      expect(() => announceLogout()).not.toThrow()
      expect(() => watchCrossTabLogout(() => {})()).not.toThrow()
    } finally {
      globalThis.BroadcastChannel = original
    }
  })
})
