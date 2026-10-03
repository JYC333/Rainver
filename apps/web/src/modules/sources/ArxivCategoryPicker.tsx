import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Check, ChevronDown } from 'lucide-react'
import { Input } from '../../components/ui/input'
import type { SourceProviderCategoryGroup } from '../../types/api'

interface ArxivCategoryPickerProps {
  groups: readonly SourceProviderCategoryGroup[]
  value: string[]
  onChange: (value: string[]) => void
  maxSelected?: number
}

export function ArxivCategoryPicker({ groups, value, onChange, maxSelected = 10 }: ArxivCategoryPickerProps) {
  const [filter, setFilter] = useState('')
  const [open, setOpen] = useState(false)
  const [menuMaxHeight, setMenuMaxHeight] = useState(288)
  const [menuStyle, setMenuStyle] = useState<React.CSSProperties | null>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const visibleGroups = useMemo(() => {
    const needle = filter.trim().toLowerCase()
    if (!needle) return groups
    return groups
      .map(group => ({
        ...group,
        options: group.options.filter(option =>
          `${group.group} ${option.value} ${option.label}`.toLowerCase().includes(needle),
        ),
      }))
      .filter(group => group.options.length > 0)
  }, [filter, groups])

  function toggle(category: string) {
    if (value.includes(category)) {
      onChange(value.filter(item => item !== category))
      return
    }
    if (value.length >= maxSelected) return
    onChange([...value, category])
  }

  useEffect(() => {
    function handlePointerDown(event: MouseEvent) {
      const target = event.target as Node
      if (!rootRef.current?.contains(target) && !menuRef.current?.contains(target)) setOpen(false)
    }
    document.addEventListener('mousedown', handlePointerDown)
    return () => document.removeEventListener('mousedown', handlePointerDown)
  }, [])

  // Escape closes this list only. The Dialog around it dismisses on Escape
  // from a document-level capture listener, so the key is taken on the
  // window in the capture phase, before that listener ever sees it.
  useEffect(() => {
    if (!open) return undefined
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key !== 'Escape') return
      event.preventDefault()
      event.stopPropagation()
      setOpen(false)
    }
    window.addEventListener('keydown', handleKeyDown, true)
    return () => window.removeEventListener('keydown', handleKeyDown, true)
  }, [open])

  useLayoutEffect(() => {
    if (!open) return undefined
    function updatePlacement() {
      const trigger = rootRef.current?.querySelector('button')
      if (!trigger) return
      const rect = trigger.getBoundingClientRect()
      const viewportPadding = 16
      const bottomPadding = 24
      const gap = 4
      const maxWidth = Math.max(0, window.innerWidth - viewportPadding * 2)
      const width = Math.min(rect.width, maxWidth)
      const left = Math.min(Math.max(rect.left, viewportPadding), Math.max(viewportPadding, window.innerWidth - width - viewportPadding))
      const spaceBelow = window.innerHeight - rect.bottom - bottomPadding - gap
      const spaceAbove = rect.top - viewportPadding - gap
      const nextOpenUp = spaceBelow < 240 && spaceAbove > spaceBelow
      const availableSpace = nextOpenUp ? spaceAbove : spaceBelow
      setMenuMaxHeight(Math.max(48, Math.min(288, availableSpace)))
      setMenuStyle({
        left,
        width,
        top: nextOpenUp ? undefined : rect.bottom + gap,
        bottom: nextOpenUp ? window.innerHeight - rect.top + gap : undefined,
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

  return (
    <div ref={rootRef} className="relative space-y-2">
      <button
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => {
          setOpen(current => !current)
          if (open) setFilter('')
        }}
        className="flex h-9 w-full items-center justify-between gap-3 rounded-md border border-border bg-input px-3 text-left text-sm text-foreground transition-colors hover:bg-accent focus:outline-none focus:ring-1 focus:ring-ring"
      >
        <span className="truncate">{value.length > 0 ? value.join(', ') : 'Select categories'}</span>
        <ChevronDown className={`size-4 shrink-0 text-muted-foreground transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>
      {open && menuStyle && createPortal(
        <div
          ref={menuRef}
          className="pointer-events-auto fixed z-[1000] flex flex-col overflow-hidden rounded-lg border border-border bg-card p-2 shadow-md"
          style={{ ...menuStyle, height: menuMaxHeight, maxHeight: menuMaxHeight, pointerEvents: 'auto' }}
        >
          <Input
            value={filter}
            onChange={event => setFilter(event.target.value)}
            placeholder="Filter categories"
            className="mb-2 h-8"
          />
          <div
            className="min-h-0 flex-1 space-y-3 overflow-y-auto overscroll-contain pr-1"
            role="listbox"
            aria-label="arXiv categories"
            onWheel={event => event.stopPropagation()}
          >
            {visibleGroups.map(group => (
              <div key={group.group} className="space-y-1">
                <p className="px-2 text-[11px] font-semibold uppercase text-muted-foreground">{group.group}</p>
                <div className="grid gap-1.5 sm:grid-cols-2">
                  {group.options.map(option => {
                    const checked = value.includes(option.value)
                    const disabled = !checked && value.length >= maxSelected
                    return (
                      <label
                        key={option.value}
                        className={[
                          'flex min-h-9 cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-muted/70',
                          disabled ? 'cursor-not-allowed opacity-50' : '',
                        ].join(' ')}
                      >
                        <input
                          type="checkbox"
                          checked={checked}
                          disabled={disabled}
                          onChange={() => toggle(option.value)}
                        />
                        <span className="font-mono text-xs">{option.value}</span>
                        <span className="min-w-0 truncate text-xs text-muted-foreground">{option.label}</span>
                        {checked && <Check className="ml-auto size-3.5 shrink-0 text-accent-foreground" />}
                      </label>
                    )
                  })}
                </div>
              </div>
            ))}
            {visibleGroups.length === 0 && (
              <p className="px-2 py-3 text-xs text-muted-foreground">No categories match.</p>
            )}
          </div>
          <div className="mt-2 flex items-center justify-between border-t border-border px-2 pt-2 text-xs text-muted-foreground">
            <div className="flex items-center gap-3">
              <span>{value.length} of {maxSelected} selected</span>
              {value.length > 0 && (
                <button type="button" className="font-medium text-foreground hover:underline" onClick={() => onChange([])}>Clear</button>
              )}
            </div>
            <button type="button" className="font-medium text-foreground hover:underline" onClick={() => setOpen(false)}>Done</button>
          </div>
        </div>,
        document.body,
      )}
      <p className="text-xs text-muted-foreground">Select up to {maxSelected} categories.</p>
    </div>
  )
}
