import { formatNumber } from '../../i18n/format'

/** Bounded display precision; duration units follow the current UI locale. */
export function formatWorkDuration(seconds: number): string {
  const roundedSeconds = Math.round(seconds)
  const roundedMinutes = Math.round(seconds / 6) / 10
  const roundedHours = Math.round(seconds / 360) / 10
  const [unit, value] = roundedMinutes >= 60 ? ['hour', roundedHours] as const
    : roundedSeconds >= 60 ? ['minute', roundedMinutes] as const : ['second', roundedSeconds] as const
  return formatNumber(value, { style: 'unit', unit, unitDisplay: 'short', maximumFractionDigits: unit === 'second' ? 0 : 1 })
}
