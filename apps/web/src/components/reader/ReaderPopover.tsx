import { useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { Button } from '../ui/button'

const GAP = 8
const MAX_WIDTH = 320

/** Where the panel fits: under the button, inside the visible viewport, scrolling when taller than the room left. */
function placement(button: HTMLElement, align: 'start' | 'end'): CSSProperties {
  const rect = button.getBoundingClientRect()
  const viewport = window.visualViewport
  const left0 = viewport?.offsetLeft ?? 0, top0 = viewport?.offsetTop ?? 0
  const width = Math.min(MAX_WIDTH, (viewport?.width ?? window.innerWidth) - GAP * 2)
  const right = left0 + (viewport?.width ?? window.innerWidth)
  const bottom = top0 + (viewport?.height ?? window.innerHeight)
  const wanted = align === 'end' ? rect.right - width : rect.left
  const left = Math.max(left0 + GAP, Math.min(wanted, right - width - GAP))
  const top = Math.min(rect.bottom + 4, bottom - 160)
  return { position: 'fixed', left, top, width, maxHeight: Math.max(160, bottom - top - GAP), overflowY: 'auto' }
}

/**
 * A button with a small non-modal panel under it (Reader appearance, progress).
 * The panel is placed inside the visible viewport (a 320px phone, zoom, the soft
 * keyboard) and scrolls when it is taller than the room left. Escape or a press
 * outside closes it and gives focus back to the button.
 */
export function ReaderPopover({ label, icon, children, align = 'end' }: { label: string; icon: ReactNode; children: (close: () => void) => ReactNode; align?: 'start' | 'end' }) {
  const [open, setOpen] = useState(false)
  const [style, setStyle] = useState<CSSProperties>({})
  const id = useId()
  const rootRef = useRef<HTMLDivElement>(null)
  const buttonRef = useRef<HTMLButtonElement>(null)
  const close = () => { setOpen(false); buttonRef.current?.focus() }
  useLayoutEffect(() => {
    if (!open) return
    const place = () => { if (buttonRef.current) setStyle(placement(buttonRef.current, align)) }
    place()
    window.addEventListener('resize', place)
    window.visualViewport?.addEventListener('resize', place)
    window.visualViewport?.addEventListener('scroll', place)
    return () => {
      window.removeEventListener('resize', place)
      window.visualViewport?.removeEventListener('resize', place)
      window.visualViewport?.removeEventListener('scroll', place)
    }
  }, [open, align])
  useEffect(() => {
    if (!open) return
    const onDown = (event: PointerEvent) => { if (!rootRef.current?.contains(event.target as Node)) setOpen(false) }
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close() } }
    window.addEventListener('pointerdown', onDown)
    const root = rootRef.current
    root?.addEventListener('keydown', onKey)
    return () => { window.removeEventListener('pointerdown', onDown); root?.removeEventListener('keydown', onKey) }
  }, [open])
  return <div ref={rootRef} className="relative">
    <Button ref={buttonRef} variant="ghost" size="icon-sm" aria-label={label} title={label} aria-expanded={open} aria-controls={open ? id : undefined}
      onClick={() => setOpen(value => !value)}>{icon}</Button>
    {open && <div id={id} role="dialog" aria-label={label} style={style}
      className="reader-popover-panel z-40 rounded-lg border border-border bg-card p-3 text-card-foreground shadow-lg">
      {children(close)}
    </div>}
  </div>
}
