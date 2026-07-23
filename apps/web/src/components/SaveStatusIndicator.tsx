import { useEffect, useState } from 'react'
import { Check } from 'lucide-react'
import { Button } from './ui/button'
import { Spinner } from './ui/spinner'
import type { SaveState } from '../hooks/useAutosave'

/** How long the "Saved" checkmark stays visible before fading out. */
const SAVED_VISIBLE_MS = 2000

/**
 * Auto-save status pill shared by every editor: "Unsaved" while a debounced
 * save is pending, "Saving…" in flight, then a "Saved" checkmark that shows
 * briefly and hides itself once nothing new has happened. Errors stay put
 * (with a retry) since those need the user's attention.
 */
export function SaveStatusIndicator({ state, onRetry }: { state: SaveState; onRetry: () => void }) {
  const [visible, setVisible] = useState(true)

  useEffect(() => {
    setVisible(true)
    if (state !== 'saved') return
    const timer = setTimeout(() => setVisible(false), SAVED_VISIBLE_MS)
    return () => clearTimeout(timer)
  }, [state])

  if (state === 'saved' && !visible) return null

  if (state === 'saving') {
    return (
      <span className="inline-flex items-center gap-1.5 text-muted-foreground">
        <Spinner size="sm" /> Saving…
      </span>
    )
  }
  if (state === 'error') {
    return (
      <span className="inline-flex items-center gap-1 text-destructive">
        Save failed
        <Button size="sm" variant="ghost" className="h-6 px-1.5 text-destructive hover:text-destructive" onClick={onRetry}>
          Retry
        </Button>
      </span>
    )
  }
  if (state === 'dirty') {
    return (
      <span className="inline-flex items-center gap-1.5 text-muted-foreground">
        <span className="size-1.5 rounded-full bg-warning" /> Unsaved
      </span>
    )
  }
  return (
    <span className="inline-flex items-center gap-1.5 text-success">
      <Check className="size-3.5" /> Saved
    </span>
  )
}
