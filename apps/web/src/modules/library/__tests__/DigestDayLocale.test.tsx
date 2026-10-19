import { afterEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import i18n from '../../../i18n'
import { DigestDayNav, DigestMissing } from '../DigestDay'

// A digest's day belongs to its timezone, never to the UI language: switching
// language rewrites how the day reads, not which day it is, which day a step
// or a backfill asks for, or who may ask.

const missing = {
  status: 'missing' as const,
  // Late in the day in UTC, which a browser east of UTC would call tomorrow.
  digest_date: '2026-10-14',
  timezone: 'Asia/Shanghai',
  period_start_utc: '2026-10-13T16:00:00.000Z',
  period_end_utc: '2026-10-14T16:00:00.000Z',
  reason: 'not_generated' as const,
  backfill_available: true,
}

afterEach(async () => { await i18n.changeLanguage('en') })

describe('digest day and language', () => {
  it('writes the same day in each language, and steps from that same day', async () => {
    const onSelect = vi.fn()
    const { unmount } = render(<DigestDayNav date="2026-10-14" timezone="Asia/Shanghai" onSelect={onSelect} canGoForward />)
    expect(screen.getByText(/Oct 14, 2026 · Asia\/Shanghai/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Next day' }))
    expect(onSelect).toHaveBeenLastCalledWith('2026-10-15')
    unmount()

    await i18n.changeLanguage('zh-CN')
    render(<DigestDayNav date="2026-10-14" timezone="Asia/Shanghai" onSelect={onSelect} canGoForward />)
    expect(screen.getByText(/2026年10月14日 · Asia\/Shanghai/)).toBeInTheDocument()
    // The accessible names are translated too; the step is the same.
    const previous = screen.getByRole('button', { name: i18n.t('digest_reports.previous_day') })
    expect(i18n.t('digest_reports.previous_day')).not.toBe('Previous day')
    fireEvent.click(previous)
    expect(onSelect).toHaveBeenLastCalledWith('2026-10-13')
  })

  it('backfills the stored day whatever the language, and offers it only to whom the server allows', async () => {
    await i18n.changeLanguage('zh-CN')
    const onBackfill = vi.fn(async () => undefined)
    const { rerender } = render(<DigestMissing missing={missing} onBackfill={onBackfill} />)
    expect(screen.getByText('2026年10月14日 没有摘要')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '补生成这一天' }))
    await waitFor(() => expect(onBackfill).toHaveBeenCalledWith('2026-10-14'))

    // Who may backfill is the server's answer, not the language's.
    rerender(<DigestMissing missing={{ ...missing, backfill_available: false }} onBackfill={onBackfill} />)
    expect(screen.queryByRole('button', { name: '补生成这一天' })).not.toBeInTheDocument()
  })

  it('explains a day that has not ended in the current language, with no backfill offered', async () => {
    render(<DigestMissing missing={{ ...missing, reason: 'day_not_complete', backfill_available: false }} onBackfill={vi.fn()} />)
    const english = i18n.t('digest_reports.missing_reason.day_not_complete')
    expect(screen.getByText(english)).toBeInTheDocument()
    expect(screen.queryByRole('button')).not.toBeInTheDocument()
    await i18n.changeLanguage('zh-CN')
    const chinese = i18n.t('digest_reports.missing_reason.day_not_complete')
    expect(chinese).not.toBe(english)
    await waitFor(() => expect(screen.getByText(chinese)).toBeInTheDocument())
  })
})
