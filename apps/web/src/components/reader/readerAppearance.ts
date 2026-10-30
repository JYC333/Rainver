import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react'
import { toast } from 'sonner'
import { ReaderAppearanceSchema, type ReaderAppearance } from '@rainver/protocol'
import { readerApi } from '../../api/client'
import { errMsg } from '../../lib/utils'
import { registerInMemoryResidue } from '../../lib/sessionResidue'

export const DEFAULT_READER_APPEARANCE: ReaderAppearance = ReaderAppearanceSchema.parse({})

// The person's appearance, kept for this tab so a second document opens
// without a flash of the defaults. It is theirs: logout drops it.
let cached: ReaderAppearance | null = null
registerInMemoryResidue(() => { cached = null })

const LINE_HEIGHT = { compact: 1.55, normal: 1.75, relaxed: 1.95 } as const
const MEASURE = { narrow: '32em', medium: '38em', wide: '46em' } as const
const FONT = { sans: 'inherit', serif: 'ui-serif, Georgia, "Songti SC", "Noto Serif CJK SC", "Source Han Serif SC", serif' } as const

/** The column's custom properties for an appearance (see .reader-column in index.css). */
export function appearanceStyle(appearance: ReaderAppearance): CSSProperties {
  return {
    ...(appearance.font_size ? { '--reader-font-size': `${appearance.font_size}px` } : {}),
    '--reader-line-height': String(LINE_HEIGHT[appearance.line_height]),
    '--reader-measure': MEASURE[appearance.width],
    '--reader-font-family': FONT[appearance.font],
  } as CSSProperties
}

/**
 * The Reader's appearance from the person's own user settings (the same on
 * every device). A change applies at once and is saved shortly after; a save
 * that fails says so and keeps what is shown, so the person can try again.
 */
export function useReaderAppearance() {
  const [appearance, setAppearance] = useState<ReaderAppearance>(() => cached ?? DEFAULT_READER_APPEARANCE)
  const [loaded, setLoaded] = useState(cached !== null)
  // A change made before the stored value arrives is not overwritten by it.
  const changedRef = useRef(false)
  const saveTimer = useRef<number | undefined>(undefined)
  const pending = useRef<ReaderAppearance | null>(null)

  useEffect(() => {
    let cancelled = false
    readerApi.getAppearance().then(value => {
      if (cancelled || changedRef.current) return
      const parsed = ReaderAppearanceSchema.catch(DEFAULT_READER_APPEARANCE).parse(value)
      cached = parsed; setAppearance(parsed)
    }).catch(() => { /* the defaults stay; reading is unaffected */ }).finally(() => { if (!cancelled) setLoaded(true) })
    return () => { cancelled = true }
  }, [])

  const flush = useCallback(() => {
    window.clearTimeout(saveTimer.current)
    const value = pending.current
    pending.current = null
    if (value) readerApi.putAppearance(value).catch(error => toast.error(errMsg(error)))
  }, [])
  useEffect(() => flush, [flush])

  const change = useCallback((patch: Partial<ReaderAppearance>) => {
    changedRef.current = true
    setAppearance(current => {
      const next = { ...current, ...patch }
      cached = next; pending.current = next
      return next
    })
    window.clearTimeout(saveTimer.current)
    saveTimer.current = window.setTimeout(flush, 500)
  }, [flush])

  const reset = useCallback(() => change(DEFAULT_READER_APPEARANCE), [change])
  return { appearance, loaded, change, reset }
}
