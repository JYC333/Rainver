import i18n from './index'

/**
 * Locale-aware formatting for UI text. Every helper reads the current UI
 * locale from the one i18n instance, so it works in components, plain
 * utilities and async callbacks alike; nothing here keeps its own locale.
 *
 * A business day (a digest's day, a capture's day) is decided by its stored
 * time zone, never by the UI locale: pass `timeZone` where the value belongs
 * to one. Changing the locale changes only how the value is written.
 */

export type DateInput = string | number | Date | null | undefined

function currentLocale(): string {
  return i18n.resolvedLanguage ?? i18n.language ?? 'en'
}

function toDate(value: DateInput): Date | null {
  if (value === null || value === undefined || value === '') return null
  const date = value instanceof Date ? value : new Date(value)
  return Number.isNaN(date.getTime()) ? null : date
}

/** A date and time, e.g. "Oct 14, 2026, 3:05 PM" / "2026年10月14日 15:05". Empty input gives `fallback`. */
export function formatDateTime(value: DateInput, options: { timeZone?: string; fallback?: string } = {}): string {
  const date = toDate(value)
  if (!date) return options.fallback ?? '—'
  return new Intl.DateTimeFormat(currentLocale(), {
    dateStyle: 'medium',
    timeStyle: 'short',
    ...(options.timeZone ? { timeZone: options.timeZone } : {}),
  }).format(date)
}

/** A calendar date, e.g. "Oct 14, 2026". */
export function formatDate(value: DateInput, options: { timeZone?: string; fallback?: string } = {}): string {
  const date = toDate(value)
  if (!date) return options.fallback ?? '—'
  return new Intl.DateTimeFormat(currentLocale(), {
    dateStyle: 'medium',
    ...(options.timeZone ? { timeZone: options.timeZone } : {}),
  }).format(date)
}

/** A time of day, e.g. "3:05 PM" / "15:05". */
export function formatTime(value: DateInput, options: { timeZone?: string; fallback?: string } = {}): string {
  const date = toDate(value)
  if (!date) return options.fallback ?? '—'
  return new Intl.DateTimeFormat(currentLocale(), {
    timeStyle: 'short',
    ...(options.timeZone ? { timeZone: options.timeZone } : {}),
  }).format(date)
}

/** A moment written with explicit parts, e.g. `{ month: 'short', day: 'numeric' }`. */
export function formatDateParts(value: DateInput, options: Intl.DateTimeFormatOptions, fallback = '—'): string {
  const date = toDate(value)
  if (!date) return fallback
  return new Intl.DateTimeFormat(currentLocale(), options).format(date)
}

/**
 * A stored calendar day ("2026-10-14"), written in the UI locale. The day is
 * formatted as itself, so neither the locale nor the browser's time zone can
 * move it to a neighbouring day.
 */
export function formatCalendarDay(
  day: string,
  options: Intl.DateTimeFormatOptions = { weekday: 'short', month: 'short', day: 'numeric' },
): string {
  const date = toDate(`${day}T00:00:00Z`)
  if (!date) return day
  return new Intl.DateTimeFormat(currentLocale(), { ...options, timeZone: 'UTC' }).format(date)
}

/** A number with the locale's grouping, e.g. "12,345". */
export function formatNumber(value: number, options: Intl.NumberFormatOptions = {}): string {
  return new Intl.NumberFormat(currentLocale(), options).format(value)
}

const RELATIVE_UNITS: Array<[Intl.RelativeTimeFormatUnit, number]> = [
  ['year', 365 * 24 * 60 * 60],
  ['month', 30 * 24 * 60 * 60],
  ['week', 7 * 24 * 60 * 60],
  ['day', 24 * 60 * 60],
  ['hour', 60 * 60],
  ['minute', 60],
  ['second', 1],
]

/** How long ago (or until) a moment is, e.g. "3 minutes ago" / "3分钟前". */
export function formatRelativeTime(value: DateInput, now: Date = new Date(), fallback = '—'): string {
  const date = toDate(value)
  if (!date) return fallback
  const seconds = Math.round((date.getTime() - now.getTime()) / 1000)
  const formatter = new Intl.RelativeTimeFormat(currentLocale(), { numeric: 'auto' })
  for (const [unit, size] of RELATIVE_UNITS) {
    if (Math.abs(seconds) >= size || unit === 'second') return formatter.format(Math.round(seconds / size), unit)
  }
  return formatter.format(0, 'second')
}

/** A byte size in the locale's number format, e.g. "1.5 MB". */
export function formatBytes(bytes: number): string {
  const units = ['byte', 'kilobyte', 'megabyte', 'gigabyte', 'terabyte'] as const
  let value = bytes
  let unit = 0
  while (Math.abs(value) >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  return new Intl.NumberFormat(currentLocale(), {
    style: 'unit',
    unit: units[unit],
    unitDisplay: 'short',
    maximumFractionDigits: unit === 0 ? 0 : 1,
  }).format(value)
}
