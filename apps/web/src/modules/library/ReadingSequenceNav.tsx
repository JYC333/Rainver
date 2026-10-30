import { useEffect, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'
import { CheckCheck, ChevronLeft, ChevronRight, Hand } from 'lucide-react'
import { useReaderArticleSwipe } from './useReaderArticleSwipe'
import { informationDigestsApi } from '../../api/client'
import { SpaceLink as Link, useSpaceNavigate } from '../../core/spaceNav'
import { Button } from '../../components/ui/button'
import { useAppTranslation } from '../../i18n'
import { errMsg } from '../../lib/utils'
import { sessionEpoch } from '../../lib/sessionResidue'
import { readerHrefFor } from './readingLinks'
import { neighbours, readingReturnFor, readingSequenceFor, saveReadingReturn, saveReadingSequence, sequenceEntry, type ReadingSequence, type SequenceEntry } from './readingSequence'

/**
 * Previous / next item of the Reading list this document was opened from, in
 * the list's order, skipping items the person may only see a summary of.
 * Past the loaded rows it asks the server for the list's next page (the same
 * query and opaque cursor); a list that changed meanwhile is reported, not
 * guessed. "Mark read and next" moves only once the server has recorded the
 * read; on a failure the person stays on this document.
 */
/** Pages of the list followed at most when looking for the next openable row. */
const FOLLOW_PAGES = 5

export function ReadingSequenceNav({ spaceId, itemId, changeId, returnTo }: { spaceId: string; itemId: string; changeId: string | null; returnTo: string }) {
  const { t } = useAppTranslation()
  const navigate = useSpaceNavigate()
  const place = useMemo(() => ({ itemId, changeId }), [itemId, changeId])
  const [sequence, setSequence] = useState<ReadingSequence | null>(() => readingSequenceFor(spaceId, returnTo, place))
  const [busy, setBusy] = useState(false)
  const navRef = useRef<HTMLDivElement>(null)
  const [swipe, setSwipe] = useState(() => { try { return localStorage.getItem('rainver:reader-swipe') === 'true' } catch { return false } })
  // Replies are applied only for the row (and session) they were asked for.
  const scopeKey = `${spaceId}|${returnTo}|${itemId}|${changeId ?? ''}`
  const current = useRef(scopeKey)
  current.current = scopeKey
  // The owner of async work: one token per mounted row, dropped on unmount or row
  // change, so a reply for a Reader that is gone (or came back as a new run, A→B→A)
  // writes no storage or state, navigates nowhere and shows nothing.
  const owner = useRef<object | null>(null)
  useEffect(() => {
    const token = {}
    owner.current = token
    return () => { if (owner.current === token) owner.current = null }
  }, [scopeKey])
  useEffect(() => {
    const kept = readingSequenceFor(spaceId, returnTo, place)
    setSequence(kept); setBusy(false)
    // Going back to the list returns to the row read last, not the one first opened from it.
    const position = kept ? neighbours(kept, place).index : -1
    if (kept && position >= 0) saveReadingReturn({ spaceId, returnTo, key: kept.entries[position].key, loaded: Math.max(readingReturnFor(spaceId, returnTo)?.loaded ?? 0, position + 1) })
  }, [spaceId, returnTo, place])
  useReaderArticleSwipe(navRef, swipe && !busy && Boolean(sequence), scopeKey,
    () => { if (previous) navigate(href(previous)) },
    () => { if (next) navigate(href(next)); else if (sequence?.next_cursor) void go(false) })
  if (!sequence) return null
  const { previous, next, index } = neighbours(sequence, place)
  const entry = sequence.entries[index]
  const href = (target: SequenceEntry) => readerHrefFor(target.source_item_id, target.reader_origin, returnTo, target.topic_change_id)

  /**
   * The next openable row. Past the loaded rows it follows the list's own
   * cursor, skipping pages of summary-only rows, for at most FOLLOW_PAGES pages:
   * `more` means rows remain beyond that (not the end of the list).
   */
  async function following(live: () => boolean): Promise<{ target: SequenceEntry | null; more: boolean } | null> {
    let list = sequence!
    let found = next
    for (let page = 0; !found && list.next_cursor && page < FOLLOW_PAGES; page++) {
      const reply = await informationDigestsApi.reading(spaceId, { ...list.query, cursor: list.next_cursor, limit: 30 }, list.projectId ?? undefined)
      // A reply for a row, run or session the person has left is not kept.
      if (!live()) return null
      const known = new Set(list.entries.map(item => item.key))
      list = { ...list, entries: [...list.entries, ...reply.items.map(sequenceEntry).filter(item => !known.has(item.key))], next_cursor: reply.next_cursor }
      saveReadingSequence(list)
      setSequence(list)
      found = neighbours(list, place).next
    }
    return { target: found, more: !found && Boolean(list.next_cursor) }
  }

  async function go(markRead: boolean) {
    if (busy) return
    const scope = current.current
    const epoch = sessionEpoch()
    const run = owner.current
    const live = () => run !== null && owner.current === run && current.current === scope && sessionEpoch() === epoch
    setBusy(true)
    try {
      if (markRead) {
        await informationDigestsApi.readingState(spaceId, itemId, { read_status: 'read' }, sequence?.projectId ?? undefined)
        if (!live()) return
        if (sequence) saveReadingSequence({ ...sequence, entries: sequence.entries.map(item => item === entry ? { ...item, unread: false } : item) })
      }
      const result = await following(live)
      if (!result || !live()) return
      if (result.target) navigate(href(result.target))
      else if (result.more) toast.message(t('reading.sequenceSummaryOnly'))
      else toast.success(t(markRead ? 'reading.markedReadLast' : 'reading.sequenceEnd'))
    } catch (error) {
      if (live()) toast.error(t('reading.sequenceFailed', { error: errMsg(error) }))
    } finally {
      if (live()) setBusy(false)
    }
  }

  const more = !next && Boolean(sequence.next_cursor)
  return <div ref={navRef} className="reading-touch flex shrink-0 items-center gap-0.5" role="group" aria-label={t('reading.sequence')}>
    <Button variant="ghost" size="icon-sm" disabled={!previous} asChild={Boolean(previous)} title={previous ? t('reading.previousItem') : t('reading.sequenceFirst')}>
      {previous ? <Link to={href(previous)} aria-label={t('reading.previousItem')}><ChevronLeft className="size-4" /></Link> : <span aria-label={t('reading.sequenceFirst')}><ChevronLeft className="size-4" /></span>}
    </Button>
    {next ? <Button variant="ghost" size="icon-sm" asChild title={t('reading.nextItem')}><Link to={href(next)} aria-label={t('reading.nextItem')}><ChevronRight className="size-4" /></Link></Button>
      : <Button variant="ghost" size="icon-sm" disabled={!more || busy} aria-label={more ? t('reading.nextItem') : t('reading.sequenceLast')} title={more ? t('reading.nextItem') : t('reading.sequenceLast')} onClick={() => void go(false)}><ChevronRight className="size-4" /></Button>}
    <Button variant="ghost" size="icon-sm" aria-pressed={swipe} aria-label={t('reading.swipeArticles')} title={t('reading.swipeArticlesHint')} onClick={() => {
      setSwipe(value => { const enabled = !value; try { localStorage.setItem('rainver:reader-swipe', String(enabled)) } catch { /* browser may not retain preferences */ } return enabled })
    }}><Hand className="size-4" /></Button>
    {entry?.unread && !entry.topic_change_id && <Button variant="ghost" size="sm" disabled={busy} onClick={() => void go(true)} title={t('reading.markReadNextHint')}>
      <CheckCheck className="size-4" /><span className="sr-only sm:not-sr-only">{t('reading.markReadNext')}</span>
    </Button>}
  </div>
}
