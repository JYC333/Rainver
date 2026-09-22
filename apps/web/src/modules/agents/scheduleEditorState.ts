export type ScheduleEditorMode = 'manual' | 'daily' | 'interval' | 'cron'

type IntervalStorage =
  | { kind: 'field'; key: 'every_hours' | 'interval_hours' }
  | { kind: 'cron' }

export interface ScheduleEditorValue {
  mode: ScheduleEditorMode
  enabled: boolean
  dailyHour: string
  intervalHours: string
  cron: string
  preserved: Record<string, unknown>
  intervalStorage: IntervalStorage
}

export const SCHEDULE_CADENCE_OPTIONS = [
  { value: 'manual', label: 'Manual only' },
  { value: 'daily', label: 'Daily' },
  { value: 'interval', label: 'Every N hours' },
  { value: 'cron', label: 'Custom cron' },
]

export function scheduleEditorFromConfig(value: unknown): ScheduleEditorValue {
  const config = isRecord(value) ? value : {}
  const cron = typeof config.cron === 'string' ? config.cron : ''
  const daily = /^0 (\d{1,2}) \* \* \*$/.exec(cron)
  const hourly = /^0 \*\/(\d{1,2}) \* \* \*$/.exec(cron)
  const hasEveryHours = Object.prototype.hasOwnProperty.call(config, 'every_hours')
  const hasIntervalHours = Object.prototype.hasOwnProperty.call(config, 'interval_hours')
  const explicitInterval = hasEveryHours ? config.every_hours : hasIntervalHours ? config.interval_hours : null
  const intervalStorage: IntervalStorage = hasEveryHours
    ? { kind: 'field', key: 'every_hours' }
    : hasIntervalHours
      ? { kind: 'field', key: 'interval_hours' }
      : hourly
        ? { kind: 'cron' }
        : { kind: 'field', key: 'every_hours' }
  const mode: ScheduleEditorMode = explicitInterval != null
    ? 'interval'
    : daily
      ? 'daily'
      : hourly
        ? 'interval'
        : cron
          ? 'cron'
          : 'manual'
  const preserved = { ...config }
  delete preserved.enabled
  delete preserved.cron
  delete preserved.every_hours
  delete preserved.interval_hours

  return {
    mode,
    enabled: config.enabled === true,
    dailyHour: daily?.[1].padStart(2, '0') ?? '08',
    intervalHours: String(explicitInterval ?? hourly?.[1] ?? '6'),
    cron: cron || '0 8 * * *',
    preserved,
    intervalStorage,
  }
}

export function scheduleConfigFromEditor(value: ScheduleEditorValue): Record<string, unknown> {
  const config: Record<string, unknown> = {
    ...value.preserved,
    enabled: value.mode !== 'manual' && value.enabled,
  }
  if (value.mode === 'manual') {
    config.cron = null
    return config
  }
  if (value.mode === 'daily') {
    config.cron = `0 ${Number(value.dailyHour)} * * *`
    return config
  }
  if (value.mode === 'interval') {
    const hours = Number(value.intervalHours)
    if (value.intervalStorage.kind === 'cron') config.cron = `0 */${hours} * * *`
    else config[value.intervalStorage.key] = hours
    return config
  }
  config.cron = value.cron
  return config
}

export function isScheduleEditorValueValid(value: ScheduleEditorValue): boolean {
  if (value.mode === 'daily') {
    const hour = Number(value.dailyHour)
    return Number.isInteger(hour) && hour >= 0 && hour <= 23
  }
  if (value.mode === 'interval') {
    const hours = Number(value.intervalHours)
    return Number.isInteger(hours) && hours > 0
  }
  // An empty cron is not "no schedule": the editor is in cron mode, and
  // `scheduleConfigFromEditor` would store `cron: ''` for it.
  if (value.mode === 'cron') return value.cron.trim().length > 0
  return true
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
