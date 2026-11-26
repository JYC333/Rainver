import { afterEach, describe, expect, it } from 'vitest'
import i18n from './index'
import { formatBytes, formatConversationTimestamp, formatDate, formatDateTime, formatNumber, formatRelativeTime, formatTime } from './format'

afterEach(async () => { await i18n.changeLanguage('en') })

describe('locale-aware formatting', () => {
  it('writes the same moment in the current UI locale, without changing its day', async () => {
    const moment = '2026-10-14T23:30:00Z'
    expect(formatDate(moment, { timeZone: 'UTC' })).toBe('Oct 14, 2026')
    await i18n.changeLanguage('zh-CN')
    expect(formatDate(moment, { timeZone: 'UTC' })).toBe('2026年10月14日')
    // The business time zone decides the day, not the locale.
    expect(formatDate(moment, { timeZone: 'Asia/Shanghai' })).toBe('2026年10月15日')
  })

  it('adds calendar context to older conversation messages while keeping their clock time', async () => {
    const now = new Date(2026, 10, 25, 0, 5)
    expect(formatConversationTimestamp(now, now)).toBe(formatTime(now))
    for (const [date, label] of [
      [new Date(2026, 10, 24, 23, 55), 'yesterday'],
      [new Date(2026, 10, 23, 23, 55), '2 days ago'],
      [new Date(2026, 10, 11, 23, 55), '2 weeks ago'],
      [new Date(2026, 8, 25, 23, 55), '2 months ago'],
    ] as const) {
      expect(formatConversationTimestamp(date, now)).toBe(`${label} · ${formatTime(date)}`)
    }
    const old = new Date(2025, 10, 25, 12)
    expect(formatConversationTimestamp(old, now)).toBe(formatDateTime(old))
    await i18n.changeLanguage('zh-CN')
    const yesterday = new Date(2026, 10, 24, 23, 55)
    expect(formatConversationTimestamp(yesterday, now)).toBe(`昨天 · ${formatTime(yesterday)}`)
  })

  it('formats numbers, sizes and relative times per locale, and empty input as a dash', async () => {
    expect(formatNumber(12345)).toBe('12,345')
    expect(formatBytes(1536)).toBe('1.5 kB')
    expect(formatRelativeTime(new Date(Date.UTC(2026, 9, 14, 12, 0)), new Date(Date.UTC(2026, 9, 14, 12, 3)))).toBe('3 minutes ago')
    expect(formatDateTime(null)).toBe('—')
    await i18n.changeLanguage('zh-CN')
    expect(formatRelativeTime(new Date(Date.UTC(2026, 9, 14, 12, 0)), new Date(Date.UTC(2026, 9, 14, 12, 3)))).toBe('3分钟前')
  })
})
