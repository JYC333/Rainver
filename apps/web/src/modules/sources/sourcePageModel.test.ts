// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'
import { hourlyFormMinuteFromRule, scheduleRuleFromForm } from './sourcePageModel'

// Node re-reads TZ when process.env.TZ is assigned, which is what stubEnv does.
afterEach(() => { vi.unstubAllEnvs() })

// The server runs an hourly rule at its UTC minute. Daily and weekly rules
// already translate the local time typed into the form; hourly must too, or
// a half-hour-offset zone runs thirty minutes off what was typed.
describe('hourly schedule minutes', () => {
  it('sends the UTC minute for the local minute typed, and reads it back as typed', () => {
    vi.stubEnv('TZ', 'Asia/Kolkata')
    const now = new Date('2026-10-03T10:00:00+05:30')
    expect(new Date(now).getTimezoneOffset()).toBe(-330)

    const rule = scheduleRuleFromForm('hourly', { weekday: '', hour: '', minute: '15' }, now)
    expect(rule).toEqual({ frequency: 'hourly', minute: 45 })
    expect(hourlyFormMinuteFromRule(45, now)).toBe('15')
  })
})
