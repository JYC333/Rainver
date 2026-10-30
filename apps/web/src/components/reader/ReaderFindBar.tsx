import { useEffect, useState } from 'react'
import { ChevronDown, ChevronUp, X } from 'lucide-react'
import { Button } from '../ui/button'
import { Input } from '../ui/input'
import { useAppTranslation } from '../../i18n'

/**
 * Find in this document (not the library search). Enter / Shift+Enter move
 * between matches; Escape closes and returns to where the person was, the
 * close button stays at the current match.
 */
export function ReaderFindBar({ onFind, onGo, onClose }: {
  onFind: (query: string) => number
  onGo: (index: number) => void
  /** `returnToStart`: the person cancelled (Escape) rather than stopping at a match. */
  onClose: (returnToStart: boolean) => void
}) {
  const { t } = useAppTranslation()
  const [query, setQuery] = useState('')
  const [count, setCount] = useState(0)
  const [index, setIndex] = useState(-1)
  useEffect(() => {
    const handle = window.setTimeout(() => {
      // The reader makes the first match current and shows it.
      const found = onFind(query)
      setCount(found); setIndex(found ? 0 : -1)
    }, 150)
    return () => window.clearTimeout(handle)
    // onFind/onGo are stable for the document shown.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query])
  const step = (delta: number) => {
    if (!count) return
    const next = (index + delta + count) % count
    setIndex(next); onGo(next)
  }
  return <div role="search" aria-label={t('reading.findInDocument')} className="reader-find-bar flex shrink-0 items-center gap-1 border-b border-border bg-background/95 px-3 py-1.5 backdrop-blur">
    <Input autoFocus className="h-8 min-w-0 flex-1" aria-label={t('reading.findInDocument')} placeholder={t('reading.findPlaceholder')} value={query} maxLength={200}
      onChange={event => setQuery(event.target.value)}
      onKeyDown={event => {
        if (event.nativeEvent.isComposing) return
        if (event.key === 'Enter') { event.preventDefault(); step(event.shiftKey ? -1 : 1) }
        else if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onClose(true) }
      }} />
    <span className="min-w-14 text-center text-xs tabular-nums text-muted-foreground" aria-live="polite">
      {query.trim() ? (count ? t('reading.findCount', { current: index + 1, count }) : t('reading.findNone')) : ''}
    </span>
    <Button variant="ghost" size="icon-sm" disabled={!count} aria-label={t('reading.findPrevious')} onClick={() => step(-1)}><ChevronUp className="size-4" /></Button>
    <Button variant="ghost" size="icon-sm" disabled={!count} aria-label={t('reading.findNext')} onClick={() => step(1)}><ChevronDown className="size-4" /></Button>
    <Button variant="ghost" size="icon-sm" aria-label={t('reading.findClose')} onClick={() => onClose(false)}><X className="size-4" /></Button>
  </div>
}
