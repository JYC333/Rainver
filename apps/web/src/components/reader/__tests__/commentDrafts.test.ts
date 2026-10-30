import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  COMMENT_DRAFT_MAX_AGE_MS, COMMENT_DRAFT_MAX_DOCUMENTS, __clearCommentDraftsForTests, __commentDraftCountForTests,
  beginCommentSend, commentDraftsVersion, commentSending, finishCommentSend, readCommentDrafts, subscribeCommentDrafts, writeCommentDraft,
} from '../commentDrafts'
import { clearSessionResidue } from '../../../lib/sessionResidue'

const scope = (documentId = 'doc-1') => ({ spaceId: 'space-1', documentType: 'source_item', documentId })

beforeEach(() => {
  vi.useFakeTimers({ now: new Date('2026-10-29T00:00:00Z') })
  __clearCommentDraftsForTests()
})
afterEach(() => { vi.useRealTimers() })

describe('comment draft expiry', () => {
  it('keeps a draft through 24 hours and removes it right after, telling subscribers', () => {
    const listener = vi.fn()
    const stop = subscribeCommentDrafts(listener)
    writeCommentDraft(scope(), 'ann-1', 'Expiring text')
    listener.mockClear()
    vi.advanceTimersByTime(COMMENT_DRAFT_MAX_AGE_MS)
    expect(readCommentDrafts(scope())).toEqual({ 'ann-1': 'Expiring text' })
    vi.advanceTimersByTime(2)
    expect(listener).toHaveBeenCalled()
    expect(readCommentDrafts(scope())).toEqual({})
    expect(__commentDraftCountForTests()).toBe(0)
    stop()
  })

  it('reads an expired draft as gone without modifying the store, and a returning tab sweeps it', () => {
    writeCommentDraft(scope(), 'ann-1', 'Idle text')
    const before = commentDraftsVersion()
    // A sleeping tab: the clock moves on but the timer has not run.
    vi.setSystemTime(Date.now() + COMMENT_DRAFT_MAX_AGE_MS + 1000)
    expect(readCommentDrafts(scope())).toEqual({})
    expect(__commentDraftCountForTests()).toBe(1)
    expect(commentDraftsVersion()).toBe(before)
    window.dispatchEvent(new Event('focus'))
    expect(__commentDraftCountForTests()).toBe(0)
    expect(commentDraftsVersion()).toBeGreaterThan(before)
  })

  it('asks before unload only while a live draft exists', () => {
    const unload = () => { const event = new Event('beforeunload', { cancelable: true }); window.dispatchEvent(event); return event.defaultPrevented }
    expect(unload()).toBe(false)
    writeCommentDraft(scope(), 'ann-1', 'Unsent')
    expect(unload()).toBe(true)
    vi.setSystemTime(Date.now() + COMMENT_DRAFT_MAX_AGE_MS + 1000)
    expect(unload()).toBe(false)
  })

  it(`keeps at most ${COMMENT_DRAFT_MAX_DOCUMENTS} documents, dropping the least recently written and notifying`, () => {
    for (let index = 0; index < COMMENT_DRAFT_MAX_DOCUMENTS; index += 1) {
      writeCommentDraft(scope(`doc-${index}`), 'ann', `Draft ${index}`)
      vi.advanceTimersByTime(1000)
    }
    writeCommentDraft(scope('doc-0'), 'ann', 'Touched again')
    vi.advanceTimersByTime(1000)
    const listener = vi.fn()
    const stop = subscribeCommentDrafts(listener)
    writeCommentDraft(scope('doc-new'), 'ann', 'One too many')
    expect(listener).toHaveBeenCalled()
    expect(readCommentDrafts(scope('doc-1'))).toEqual({})
    expect(readCommentDrafts(scope('doc-0'))).toEqual({ ann: 'Touched again' })
    expect(readCommentDrafts(scope('doc-new'))).toEqual({ ann: 'One too many' })
    expect(__commentDraftCountForTests()).toBe(COMMENT_DRAFT_MAX_DOCUMENTS)
    stop()
  })
})

describe('comment send ownership', () => {
  it('allows one send per annotation at a time and clears only the text that was sent', () => {
    writeCommentDraft(scope(), 'ann-1', 'First version')
    const claim = beginCommentSend(scope(), 'ann-1', 'First version')!
    expect(beginCommentSend(scope(), 'ann-1', 'First version')).toBeNull()
    expect(commentSending(scope(), 'ann-1')).toBe(true)
    writeCommentDraft(scope(), 'ann-1', 'First version, edited while sending')
    expect(finishCommentSend(claim, true)).toBe(true)
    expect(commentSending(scope(), 'ann-1')).toBe(false)
    expect(readCommentDrafts(scope())).toEqual({ 'ann-1': 'First version, edited while sending' })
  })

  it('keeps the draft for a retry when the send fails', () => {
    writeCommentDraft(scope(), 'ann-1', 'Retry me')
    const claim = beginCommentSend(scope(), 'ann-1', 'Retry me')!
    finishCommentSend(claim, false)
    expect(readCommentDrafts(scope())).toEqual({ 'ann-1': 'Retry me' })
    expect(beginCommentSend(scope(), 'ann-1', 'Retry me')).not.toBeNull()
  })

  it('ignores a reply from an earlier session: it cannot clear or block the next person’s draft', () => {
    writeCommentDraft(scope(), 'ann-1', 'Same words')
    const claim = beginCommentSend(scope(), 'ann-1', 'Same words')!
    clearSessionResidue()
    expect(commentSending(scope(), 'ann-1')).toBe(false)
    writeCommentDraft(scope(), 'ann-1', 'Same words')
    expect(finishCommentSend(claim, true)).toBe(false)
    expect(readCommentDrafts(scope())).toEqual({ 'ann-1': 'Same words' })
  })
})
