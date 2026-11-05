import { useRef, useState, useEffect, useId, useLayoutEffect, type CSSProperties, type KeyboardEvent } from 'react'
import { createPortal } from 'react-dom'
import { ChevronDown, Check } from 'lucide-react'
import { cn } from '../../lib/utils'

const TABBABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]'

export interface SelectOption {
  value: string
  label: string
  /** Shown but not choosable — for example an offline host. */
  disabled?: boolean
}

interface SelectProps {
  options: SelectOption[]
  value: string
  onChange: (value: string) => void
  className?: string
  size?: 'sm' | 'md'
  dropUp?: boolean
  disabled?: boolean
  ariaLabel?: string
  /** Render inside the current stacking context. Useful for modal dialogs. */
  portal?: boolean
}

export function Select({ options, value, onChange, className, size = 'md', dropUp = false, disabled = false, ariaLabel, portal = true }: SelectProps) {
  const [open, setOpen] = useState(false)
  const [insideDialog, setInsideDialog] = useState(false)
  const triggerRef = useRef<HTMLDivElement>(null)
  const buttonRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  // Focus has been placed on an option since this menu opened.
  const focusPlaced = useRef(false)
  const listboxId = useId()
  const [menuStyle, setMenuStyle] = useState<CSSProperties | null>(null)
  const selected = options.find(o => o.value === value)

  useEffect(() => {
    function handler(e: MouseEvent) {
      const target = e.target as Node
      if (triggerRef.current?.contains(target) || menuRef.current?.contains(target)) return
      setOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [])

  useLayoutEffect(() => {
    if (!open) {
      setInsideDialog(false)
      setMenuStyle(null)
      return undefined
    }
    setInsideDialog(Boolean(triggerRef.current?.closest('[role="dialog"]')))
    function updatePosition() {
      const trigger = triggerRef.current
      if (!trigger) return
      const rect = trigger.getBoundingClientRect()
      const gap = 4
      const viewportPadding = 8
      // Measure the menu's own natural content width (it's mounted off-screen with
      // `width: max-content` via measureStyle below until the first position is computed)
      // instead of assuming a fixed width. Do not use a fixed floor wider than
      // the content. The menu would be wider than narrow trigger/viewport
      // combinations can fit, and the viewport clamp would pin it far from
      // the trigger.
      const naturalWidth = menuRef.current?.getBoundingClientRect().width ?? rect.width
      const maxWidth = Math.min(Math.max(rect.width, naturalWidth), window.innerWidth - viewportPadding * 2)
      // Prefer aligning the menu's left edge with the trigger's left edge. If that would
      // overflow the viewport's right edge, align the menu's right edge with the trigger's
      // right edge instead, so the menu stays visually anchored to the trigger rather than
      // jumping to a position determined purely by viewport width.
      const preferredLeft = rect.left + maxWidth > window.innerWidth - viewportPadding
        ? rect.right - maxWidth
        : rect.left
      const left = Math.min(
        Math.max(preferredLeft, viewportPadding),
        Math.max(viewportPadding, window.innerWidth - maxWidth - viewportPadding),
      )
      setMenuStyle({
        position: 'fixed',
        left,
        top: dropUp ? undefined : rect.bottom + gap,
        bottom: dropUp ? window.innerHeight - rect.top + gap : undefined,
        width: maxWidth,
        minWidth: Math.min(rect.width, maxWidth),
        maxHeight: dropUp
          ? Math.max(120, rect.top - gap * 2)
          : Math.max(120, window.innerHeight - rect.bottom - gap * 2),
      })
    }
    updatePosition()
    window.addEventListener('resize', updatePosition)
    window.addEventListener('scroll', updatePosition, true)
    return () => {
      window.removeEventListener('resize', updatePosition)
      window.removeEventListener('scroll', updatePosition, true)
    }
  }, [dropUp, open])

  const h = size === 'sm' ? 'h-7' : 'h-9'
  const renderInPlace = !portal || insideDialog

  // An open menu takes the focus on its selected option (or the first
  // choosable one), so the keyboard works inside it wherever it is rendered.
  // A portaled menu is focused once it has its position (hidden before).
  useEffect(() => {
    if (!open) { focusPlaced.current = false; return }
    if (focusPlaced.current || (!renderInPlace && !menuStyle)) return
    const items = enabledOptions()
    const target = items.find(item => item.getAttribute('aria-selected') === 'true') ?? items[0]
    if (target) { target.focus({ preventScroll: true }); focusPlaced.current = true }
  })

  function enabledOptions() {
    return Array.from(menuRef.current?.querySelectorAll<HTMLButtonElement>('[role="option"]:not(:disabled)') ?? [])
  }
  function close(returnFocus: boolean) {
    setOpen(false)
    if (returnFocus) buttonRef.current?.focus()
  }
  function onMenuKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const items = enabledOptions()
    const index = items.indexOf(document.activeElement as HTMLButtonElement)
    const move = (next: number) => { event.preventDefault(); items[Math.max(0, Math.min(items.length - 1, next))]?.focus() }
    if (event.key === 'ArrowDown') move(index + 1)
    else if (event.key === 'ArrowUp') move(index < 0 ? 0 : index - 1)
    else if (event.key === 'Home') move(0)
    else if (event.key === 'End') move(items.length - 1)
    else if (event.key === 'Tab') {
      // Tab leaves the control from the trigger's place in the page: the
      // browser's own next stop would be another option (in place) or the
      // end of the document (portaled), both gone once the menu closes.
      event.preventDefault()
      close(true)
      focusNextAfterTrigger(event.shiftKey ? -1 : 1)
    }
  }
  function focusNextAfterTrigger(direction: 1 | -1) {
    const trigger = buttonRef.current
    if (!trigger) return
    // Within a dialog, the dialog is the page.
    const scope: ParentNode = trigger.closest('[role="dialog"]') ?? document
    const candidates = Array.from(scope.querySelectorAll<HTMLElement>(TABBABLE))
      .filter(element => element.tabIndex >= 0 && !menuRef.current?.contains(element))
    const ordered = direction === 1 ? candidates.slice(candidates.indexOf(trigger) + 1) : candidates.slice(0, candidates.indexOf(trigger)).reverse()
    // The first one that actually takes focus (hidden ones do not).
    for (const element of ordered) {
      element.focus()
      if (document.activeElement === element) return
    }
  }
  function onTriggerKeyDown(event: KeyboardEvent<HTMLButtonElement>) {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); setOpen(true) }
  }

  // Escape closes the menu and nothing else, as in SearchableMultiSelect: a
  // Radix dialog dismisses from a capturing document listener, so the
  // window's capture phase is the one that runs first. Focus inside the menu
  // returns to the trigger.
  useEffect(() => {
    if (!open) return undefined
    function handleKeyDown(event: globalThis.KeyboardEvent) {
      if (event.key !== 'Escape') return
      event.preventDefault()
      const within = menuRef.current?.contains(document.activeElement)
      setOpen(false)
      if (within) buttonRef.current?.focus()
    }
    window.addEventListener('keydown', handleKeyDown, true)
    return () => window.removeEventListener('keydown', handleKeyDown, true)
  }, [open])
  // Placeholder style used for the one frame (flushed before paint, so invisible to the user)
  // between mount and the first computed position: mounts the menu off-screen so its natural
  // content width can be measured via menuRef above.
  const measureStyle: CSSProperties = { position: 'fixed', top: -9999, left: -9999, visibility: 'hidden', width: 'max-content' }
  const menu = (
    <div
      ref={menuRef}
      id={listboxId}
      role="listbox"
      aria-label={ariaLabel}
      onKeyDown={onMenuKeyDown}
      style={renderInPlace ? { maxHeight: 'min(18rem, 40vh)' } : menuStyle ?? measureStyle}
      className={cn(
        'z-[1000] overflow-auto rounded-lg border border-border bg-card shadow-md',
        renderInPlace
          ? ['absolute left-0 right-0', dropUp ? 'bottom-full mb-1' : 'top-full mt-1']
          : 'fixed',
      )}
    >
      {options.map(opt => (
        <button
          key={opt.value}
          type="button"
          role="option"
          aria-selected={opt.value === value}
          aria-disabled={opt.disabled}
          disabled={opt.disabled}
          onClick={event => {
            if (opt.disabled) return
            onChange(opt.value)
            // A keyboard choice (detail 0) returns to the trigger; a pointer choice leaves focus alone.
            close(event.detail === 0)
          }}
          className={cn(
            'flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm transition-colors outline-none focus-visible:bg-accent focus-visible:text-foreground',
            opt.disabled
              ? 'text-muted-foreground/50 cursor-not-allowed'
              : opt.value === value
                ? 'text-foreground bg-accent'
                : 'text-muted-foreground hover:text-foreground hover:bg-accent',
          )}
        >
          <span className="flex-1 truncate">{opt.label}</span>
          {opt.value === value && <Check size={12} className="shrink-0 text-accent-foreground" />}
        </button>
      ))}
    </div>
  )

  return (
    <div className={cn('relative', className)} ref={triggerRef}>
      <button
        ref={buttonRef}
        type="button"
        disabled={disabled}
        onClick={() => setOpen(o => !o)}
        onKeyDown={onTriggerKeyDown}
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listboxId : undefined}
        className={cn(
          'flex w-full items-center justify-between gap-1.5 rounded-md border border-border',
          'bg-input px-3 text-sm text-foreground transition-colors',
          'hover:bg-accent focus:outline-none focus:ring-1 focus:ring-ring disabled:cursor-not-allowed disabled:opacity-60',
          h,
        )}
      >
        <span className="truncate">{selected?.label ?? value}</span>
        <ChevronDown size={13} className="shrink-0 text-muted-foreground" />
      </button>

      {open && !disabled && (renderInPlace ? menu : portal ? createPortal(menu, document.body) : null)}
    </div>
  )
}
