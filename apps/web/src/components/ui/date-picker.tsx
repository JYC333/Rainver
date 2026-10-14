import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { CalendarDays, ChevronLeft, ChevronRight } from 'lucide-react'
import { cn } from '../../lib/utils'
import { useAppTranslation } from '../../i18n'

interface DatePickerProps {
  value: string
  onChange: (value: string) => void
  ariaLabel?: string
  placeholder?: string
  min?: string
  max?: string
  disabled?: boolean
  className?: string
}

/** Monday-first short weekday names in the UI locale (2024-01-01 was a Monday). */
function weekdayNames(locale: string): string[] {
  const format = new Intl.DateTimeFormat(locale, { weekday: 'short' })
  return Array.from({ length: 7 }, (_, index) => format.format(new Date(2024, 0, 1 + index)))
}

function pad(value: number): string {
  return String(value).padStart(2, '0')
}

function toIsoDate(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

function parseIsoDate(value: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
  if (!match) return null
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]))
  return Number.isNaN(date.getTime()) || toIsoDate(date) !== value ? null : date
}

function startOfMonth(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), 1)
}

function formatDate(value: string, locale: string): string {
  const date = parseIsoDate(value)
  if (!date) return value
  return new Intl.DateTimeFormat(locale, {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  }).format(date)
}

function formatMonth(date: Date, locale: string): string {
  return new Intl.DateTimeFormat(locale, {
    month: 'long',
    year: 'numeric',
  }).format(date)
}

function isDateOutsideRange(value: string, min?: string, max?: string): boolean {
  return (min !== undefined && value < min) || (max !== undefined && value > max)
}

export function DatePicker({
  value,
  onChange,
  ariaLabel,
  placeholder,
  min,
  max,
  disabled = false,
  className,
}: DatePickerProps) {
  const { t, locale } = useAppTranslation()
  const rootRef = useRef<HTMLDivElement>(null)
  const [open, setOpen] = useState(false)
  const [dropUp, setDropUp] = useState(false)
  const [viewDate, setViewDate] = useState(() => startOfMonth(parseIsoDate(value) ?? new Date()))

  useEffect(() => {
    if (open) {
      setViewDate(startOfMonth(parseIsoDate(value) ?? new Date()))
    }
  }, [open, value])

  useEffect(() => {
    function closeOnOutsideClick(event: MouseEvent) {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', closeOnOutsideClick)
    return () => document.removeEventListener('mousedown', closeOnOutsideClick)
  }, [])

  useLayoutEffect(() => {
    if (!open) return undefined
    function updatePlacement() {
      const rect = rootRef.current?.getBoundingClientRect()
      if (!rect) return
      setDropUp(rect.bottom + 320 > window.innerHeight && rect.top > 320)
    }
    updatePlacement()
    window.addEventListener('resize', updatePlacement)
    window.addEventListener('scroll', updatePlacement, true)
    return () => {
      window.removeEventListener('resize', updatePlacement)
      window.removeEventListener('scroll', updatePlacement, true)
    }
  }, [open])

  const firstDay = (viewDate.getDay() + 6) % 7
  const daysInMonth = new Date(viewDate.getFullYear(), viewDate.getMonth() + 1, 0).getDate()
  const days = Array.from({ length: firstDay + daysInMonth }, (_, index) => {
    if (index < firstDay) return null
    return new Date(viewDate.getFullYear(), viewDate.getMonth(), index - firstDay + 1)
  })
  const today = toIsoDate(new Date())

  function changeMonth(offset: number) {
    setViewDate(current => new Date(current.getFullYear(), current.getMonth() + offset, 1))
  }

  function selectDate(date: Date) {
    const nextValue = toIsoDate(date)
    if (isDateOutsideRange(nextValue, min, max)) return
    onChange(nextValue)
    setOpen(false)
  }

  return (
    <div ref={rootRef} className={cn('relative', className)}>
      <button
        type="button"
        disabled={disabled}
        aria-label={ariaLabel}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen(current => !current)}
        className={cn(
          'flex h-9 w-full items-center justify-between gap-2 rounded-md border border-border',
          'bg-input px-3 text-left text-sm text-foreground transition-colors',
          'hover:bg-accent focus:outline-none focus:ring-1 focus:ring-ring',
          'disabled:cursor-not-allowed disabled:opacity-60',
        )}
      >
        <span className={cn('truncate', !value && 'text-muted-foreground')}>{value ? formatDate(value, locale) : placeholder ?? t('core_ui.date_picker.placeholder')}</span>
        <CalendarDays className="size-3.5 shrink-0 text-muted-foreground" />
      </button>

      {open && !disabled && (
        <div
          role="dialog"
          aria-label={ariaLabel ?? t('core_ui.date_picker.choose_date')}
          className={cn(
            'absolute left-0 z-[1000] w-[min(19rem,calc(100vw-2rem))] rounded-lg border border-border bg-card p-3 shadow-md',
            dropUp ? 'bottom-full mb-1' : 'top-full mt-1',
          )}
        >
          <div className="flex items-center justify-between gap-2">
            <button
              type="button"
              aria-label={t('core_ui.date_picker.previous_month')}
              onClick={() => changeMonth(-1)}
              className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus:outline-none focus:ring-1 focus:ring-ring"
            >
              <ChevronLeft className="size-4" />
            </button>
            <span className="text-sm font-medium text-foreground">{formatMonth(viewDate, locale)}</span>
            <button
              type="button"
              aria-label={t('core_ui.date_picker.next_month')}
              onClick={() => changeMonth(1)}
              className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus:outline-none focus:ring-1 focus:ring-ring"
            >
              <ChevronRight className="size-4" />
            </button>
          </div>

          <div className="mt-3 grid grid-cols-7 gap-1 text-center text-[11px] font-medium text-muted-foreground">
            {weekdayNames(locale).map(day => <span key={day}>{day}</span>)}
          </div>
          <div className="mt-1 grid grid-cols-7 gap-1">
            {days.map((date, index) => {
              if (!date) return <span key={`empty-${index}`} className="h-8" aria-hidden="true" />
              const dateValue = toIsoDate(date)
              const selected = dateValue === value
              const disabledDate = isDateOutsideRange(dateValue, min, max)
              return (
                <button
                  key={dateValue}
                  type="button"
                  disabled={disabledDate}
                  aria-label={new Intl.DateTimeFormat(locale, { dateStyle: 'long' }).format(date)}
                  aria-pressed={selected}
                  onClick={() => selectDate(date)}
                  className={cn(
                    'h-8 rounded-md text-xs transition-colors focus:outline-none focus:ring-1 focus:ring-ring',
                    selected
                      ? 'bg-accent text-accent-foreground font-semibold'
                      : dateValue === today
                        ? 'border border-accent-foreground/40 text-accent-foreground hover:bg-accent'
                        : 'text-foreground hover:bg-accent',
                    disabledDate && 'cursor-not-allowed opacity-30 hover:bg-transparent',
                  )}
                >
                  {date.getDate()}
                </button>
              )
            })}
          </div>

          <div className="mt-3 flex items-center justify-between border-t border-border pt-2">
            <button
              type="button"
              className="text-xs text-accent-foreground hover:underline focus:outline-none focus:ring-1 focus:ring-ring"
              onClick={() => selectDate(new Date())}
              disabled={isDateOutsideRange(today, min, max)}
            >
              Today
            </button>
            {value && (
              <button
                type="button"
                className="text-xs text-muted-foreground hover:text-foreground hover:underline focus:outline-none focus:ring-1 focus:ring-ring"
                onClick={() => { onChange(''); setOpen(false) }}
              >
                Clear
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
