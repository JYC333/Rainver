import { describe, expect, it } from 'vitest'
import { scheduleSummary } from '../policyMap'
import {
  isScheduleEditorValueValid,
  scheduleConfigFromEditor,
  scheduleEditorFromConfig,
} from '../scheduleEditorState'

describe('shared Agent schedule editor state', () => {
  it('preserves an every_hours interval and its schedule metadata', () => {
    const config = {
      enabled: true,
      every_hours: 6,
      timezone: 'America/Los_Angeles',
      manual_run_allowed: false,
    }
    const editor = scheduleEditorFromConfig(config)

    expect(editor.mode).toBe('interval')
    expect(editor.intervalHours).toBe('6')
    expect(scheduleConfigFromEditor(editor)).toEqual(config)
    expect(scheduleSummary({ schedule_config_json: config })).toMatchObject({
      kind: 'interval',
      label: 'Every 6 hours',
      enabled: true,
      timezone: 'America/Los_Angeles',
      manualRunAllowed: false,
    })
  })

  it('preserves interval_hours and cron-encoded intervals without converting their storage shape', () => {
    const fieldInterval = scheduleEditorFromConfig({ enabled: false, interval_hours: 12 })
    expect(scheduleConfigFromEditor(fieldInterval)).toEqual({ enabled: false, interval_hours: 12 })

    const cronInterval = scheduleEditorFromConfig({ enabled: true, cron: '0 */4 * * *' })
    expect(cronInterval.mode).toBe('interval')
    expect(cronInterval.intervalHours).toBe('4')
    expect(scheduleConfigFromEditor(cronInterval)).toEqual({ enabled: true, cron: '0 */4 * * *' })
  })

  it('retains the existing daily and custom-cron editing semantics', () => {
    const daily = scheduleEditorFromConfig({ enabled: true, cron: '0 7 * * *', timezone: 'UTC' })
    expect(daily.mode).toBe('daily')
    expect(scheduleConfigFromEditor(daily)).toEqual({ enabled: true, timezone: 'UTC', cron: '0 7 * * *' })

    const custom = scheduleEditorFromConfig({ enabled: true, cron: '15 3 * * 1' })
    expect(custom.mode).toBe('cron')
    expect(scheduleConfigFromEditor(custom)).toEqual({ enabled: true, cron: '15 3 * * 1' })
  })

  it('does not allow invalid numeric cadence values to be saved', () => {
    expect(isScheduleEditorValueValid({
      ...scheduleEditorFromConfig({ every_hours: 6 }),
      intervalHours: '0',
    })).toBe(false)
    expect(isScheduleEditorValueValid({
      ...scheduleEditorFromConfig({ cron: '0 8 * * *' }),
      dailyHour: '24',
    })).toBe(false)
  })

  it('refuses an empty custom cron rather than saving `cron: \'\'`', () => {
    const custom = scheduleEditorFromConfig({ enabled: true, cron: '15 3 * * 1' })
    expect(custom.mode).toBe('cron')
    expect(isScheduleEditorValueValid({ ...custom, cron: '' })).toBe(false)
    expect(isScheduleEditorValueValid({ ...custom, cron: '   ' })).toBe(false)
    expect(isScheduleEditorValueValid(custom)).toBe(true)
  })
})
