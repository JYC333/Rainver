import { afterEach, describe, expect, it } from 'vitest'
import i18n from './index'
import { formatBytes, formatDate, formatDateTime, formatNumber, formatRelativeTime } from './format'

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

  it('formats numbers, sizes and relative times per locale, and empty input as a dash', async () => {
    expect(formatNumber(12345)).toBe('12,345')
    expect(formatBytes(1536)).toBe('1.5 kB')
    expect(formatRelativeTime(new Date(Date.UTC(2026, 9, 14, 12, 0)), new Date(Date.UTC(2026, 9, 14, 12, 3)))).toBe('3 minutes ago')
    expect(formatDateTime(null)).toBe('—')
    await i18n.changeLanguage('zh-CN')
    expect(formatRelativeTime(new Date(Date.UTC(2026, 9, 14, 12, 0)), new Date(Date.UTC(2026, 9, 14, 12, 3)))).toBe('3分钟前')
  })
})
