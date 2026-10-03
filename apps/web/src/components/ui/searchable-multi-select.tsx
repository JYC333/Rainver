import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { Check, ChevronDown, Search } from 'lucide-react'
import { createPortal } from 'react-dom'
import { cn } from '../../lib/utils'
import { Input } from './input'

export interface SearchableMultiSelectOption {
  value: string
  label: string
  description?: string
  meta?: string
}

interface SearchableMultiSelectProps {
  options: SearchableMultiSelectOption[]
  value: string[]
  onChange: (value: string[]) => void
  placeholder?: string
  searchPlaceholder?: string
  emptyMessage?: string
  triggerLabel?: string
  ariaLabel?: string
  disabled?: boolean
}

export function SearchableMultiSelect({
  options,
  value,
  onChange,
  placeholder = 'Select items',
  searchPlaceholder = 'Search items',
  emptyMessage = 'No items match.',
  triggerLabel,
  ariaLabel,
  disabled = false,
}: SearchableMultiSelectProps) {
  const [open, setOpen] = useState(false)
  const [filter, setFilter] = useState('')
  const [menuStyle, setMenuStyle] = useState<CSSProperties | null>(null)
  const [menuMaxHeight, setMenuMaxHeight] = useState(288)
  const rootRef = useRef<HTMLDivElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)

  const visibleOptions = useMemo(() => {
    const needle = filter.trim().toLowerCase()
    if (!needle) return options
    return options.filter(option =>
      `${option.label} ${option.description ?? ''} ${option.meta ?? ''}`.toLowerCase().includes(needle),
    )
  }, [filter, options])

  useEffect(() => {
    function handlePointerDown(event: MouseEvent) {
      const target = event.target as Node
      if (!rootRef.current?.contains(target) && !menuRef.current?.contains(target)) setOpen(false)
    }
    document.addEventListener('mousedown', handlePointerDown)
    return () => document.removeEventListener('mousedown', handlePointerDown)
  }, [])

  // Escape closes the menu and nothing else. A Radix dialog around this
  // control dismisses on Escape from a capturing listener on the document,
  // which runs before anything on the elements; the window's capture phase
  // is the one place that runs earlier, and an Escape marked handled there
  // is one the dialog leaves alone.
  useEffect(() => {
    if (!open) return undefined
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key !== 'Escape') return
      event.preventDefault()
      setOpen(false)
    }
    window.addEventListener('keydown', handleKeyDown, true)
    return () => window.removeEventListener('keydown', handleKeyDown, true)
  }, [open])

  useLayoutEffect(() => {
    if (!open) return undefined
    function updatePlacement() {
      const trigger = rootRef.current?.querySelector('[data-searchable-multi-select-trigger]')
      if (!(trigger instanceof HTMLElement)) return
      const rect = trigger.getBoundingClientRect()
      const dialog = rootRef.current?.closest('[role="dialog"]')
      const dialogRect = dialog?.getBoundingClientRect()
      const viewportPadding = 16
      const bottomPadding = 24
      const gap = 4
      const width = Math.min(Math.max(rect.width, 320), window.innerWidth - viewportPadding * 2)
      const left = Math.min(
        Math.max(rect.left, viewportPadding),
        Math.max(viewportPadding, window.innerWidth - width - viewportPadding),
      )
      const spaceBelow = window.innerHeight - rect.bottom - bottomPadding - gap
      const spaceAbove = rect.top - viewportPadding - gap
      const openUp = spaceBelow < 240 && spaceAbove > spaceBelow
      const availableSpace = openUp ? spaceAbove : spaceBelow
      setMenuMaxHeight(Math.max(160, Math.min(320, availableSpace)))
      setMenuStyle({
        position: dialogRect ? 'absolute' : 'fixed',
        left: dialogRect ? left - dialogRect.left : left,
        width,
        top: openUp
          ? undefined
          : dialogRect
            ? rect.bottom - dialogRect.top + gap
            : rect.bottom + gap,
        bottom: openUp
          ? dialogRect
            ? dialogRect.bottom - rect.top + gap
            : window.innerHeight - rect.top + gap
          : undefined,
      })
    }
    updatePlacement()
    window.addEventListener('resize', updatePlacement)
    window.addEventListener('scroll', updatePlacement, true)
    return () => {
      window.removeEventListener('resize', updatePlacement)
      window.removeEventListener('scroll', updatePlacement, true)
    }
  }, [open])

  function toggle(valueToToggle: string) {
    onChange(value.includes(valueToToggle)
      ? value.filter(item => item !== valueToToggle)
      : [...value, valueToToggle])
  }

  const triggerText = value.length > 0
    ? `${value.length} selected`
    : triggerLabel ?? placeholder

  return (
    <div ref={rootRef} className="relative min-w-0">
      <button
        type="button"
        data-searchable-multi-select-trigger
        disabled={disabled}
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen(current => !current)}
        className={cn(
          'flex h-9 w-full items-center justify-between gap-3 rounded-md border border-border bg-input px-3 text-left text-sm text-foreground transition-colors',
          'hover:bg-accent focus:outline-none focus:ring-1 focus:ring-ring disabled:cursor-not-allowed disabled:opacity-60',
        )}
      >
        <span className="truncate">{triggerText}</span>
        <ChevronDown className={cn('size-4 shrink-0 text-muted-foreground transition-transform', open && 'rotate-180')} />
      </button>

      {open && menuStyle && createPortal(
        <div
          ref={menuRef}
          role="presentation"
          aria-label={ariaLabel ? `${ariaLabel} options` : undefined}
          onPointerDownCapture={event => event.stopPropagation()}
          onMouseDown={event => event.stopPropagation()}
          className="z-[1000] flex flex-col overflow-hidden rounded-lg border border-border bg-card p-2 shadow-md"
          style={{ ...menuStyle, height: menuMaxHeight, maxHeight: menuMaxHeight }}
        >
          <div className="relative">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              autoFocus
              value={filter}
              onChange={event => setFilter(event.target.value)}
              placeholder={searchPlaceholder}
              className="h-8 pl-8"
            />
          </div>
          <div
            className="min-h-0 flex-1 overflow-y-auto overscroll-contain py-1 pr-1"
            role="listbox"
            aria-label={ariaLabel ?? 'Options'}
            aria-multiselectable="true"
            onWheel={event => event.stopPropagation()}
          >
            {visibleOptions.map(option => {
              const selected = value.includes(option.value)
              return (
                <button
                  key={option.value}
                  type="button"
                  role="option"
                  aria-selected={selected}
                  onClick={() => toggle(option.value)}
                  className="flex w-full items-start gap-2 rounded-md px-2 py-2 text-left transition-colors hover:bg-muted/70 focus:bg-muted/70 focus:outline-none"
                >
                  <span className={cn('mt-0.5 flex size-4 shrink-0 items-center justify-center rounded border', selected ? 'border-primary bg-primary text-primary-foreground' : 'border-border')}>
                    {selected && <Check className="size-3" />}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-2">
                      <span className="truncate text-sm font-medium">{option.label}</span>
                      {option.meta && <span className="shrink-0 text-[11px] text-muted-foreground">{option.meta}</span>}
                    </span>
                    {option.description && <span className="mt-0.5 block truncate text-xs text-muted-foreground">{option.description}</span>}
                  </span>
                </button>
              )
            })}
            {visibleOptions.length === 0 && <p className="px-2 py-4 text-xs text-muted-foreground">{emptyMessage}</p>}
          </div>
          <div className="flex items-center justify-between border-t border-border px-2 pt-2 text-xs text-muted-foreground">
            <span>{value.length} selected</span>
            <div className="flex items-center gap-3">
              {value.length > 0 && <button type="button" className="font-medium text-foreground hover:underline" onClick={() => onChange([])}>Clear</button>}
              <button type="button" className="font-medium text-foreground hover:underline" onClick={() => setOpen(false)}>Done</button>
            </div>
          </div>
        </div>,
        rootRef.current?.closest('[role="dialog"]') ?? document.body,
      )}
    </div>
  )
}
