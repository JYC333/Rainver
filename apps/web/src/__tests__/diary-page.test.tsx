import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { createDiaryPage } from '../../../../plugins/official/diary/web/src/DiaryPage'
import type { DiaryApi, DiaryEntry, DiaryWebHost } from '../../../../plugins/official/diary/web/src/host'

function entry(date: string, content: string): DiaryEntry {
  return { id: `entry-${date}`, user_id: 'user-1', entry_date: date, content, created_at: '', updated_at: '' }
}

/** A diary server whose reads for a date answer only when the test releases that date. */
function heldApi(stored: DiaryEntry[]) {
  const waiting = new Map<string, Array<() => void>>()
  const held = <T,>(date: string, value: () => T) => new Promise<T>(resolve => {
    waiting.set(date, [...(waiting.get(date) ?? []), () => resolve(value())])
  })
  const forDate = (date: string) => stored.filter(item => item.entry_date.slice(5) === date.slice(5))
  const api: DiaryApi = {
    today: vi.fn(() => {
      const date = new Date().toISOString().slice(0, 10)
      return held(date, () => ({ date, entry: stored.find(item => item.entry_date === date) ?? null }))
    }),
    onThisDay: vi.fn((date: string) => held(date, () => ({ date, entries: forDate(date) }))),
    listEntries: vi.fn(async () => ({ entries: stored })),
    saveEntry: vi.fn(async (date: string, content: string) => ({ entry: entry(date, content) })),
    deleteEntry: vi.fn(async () => ({ deleted: true })),
    reflections: vi.fn(async (date: string) => ({ entry_date: date, reflections: [] })),
  }
  const release = (date: string) => act(async () => {
    const resolvers = waiting.get(date) ?? []
    waiting.delete(date)
    resolvers.forEach(resolve => resolve())
  })
  return { api, release }
}

function renderPage(api: DiaryApi) {
  const host: DiaryWebHost = {
    api,
    Link: ({ to, children }) => <a href={to}>{children}</a>,
    usePluginState: () => ({ loading: false, enabled: true }),
  }
  const Page = createDiaryPage(host)
  return render(<Page />)
}

function localToday(): string {
  const now = new Date()
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
}

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllEnvs()
})

describe('DiaryPage', () => {
  it('shows the day that was picked even when an earlier read answers last', async () => {
    const today = localToday()
    const { api, release } = heldApi([entry(today, 'Written today'), entry('2025-03-04', 'Written in March')])
    renderPage(api)
    fireEvent.click(await screen.findByRole('button', { name: '2025-03-04' }))

    await release(today)
    await release(new Date().toISOString().slice(0, 10))
    await release('2025-03-04')

    await waitFor(() => expect(screen.getByRole('textbox')).toHaveValue('Written in March'))
  })

  it('saves what was typed when the person moves to another day before the autosave fires', async () => {
    const today = localToday()
    const { api, release } = heldApi([entry('2025-03-04', 'Written in March')])
    renderPage(api)
    await release(today)
    await release(new Date().toISOString().slice(0, 10))
    fireEvent.change(await screen.findByRole('textbox'), { target: { value: 'Unsaved thought' } })

    fireEvent.click(await screen.findByRole('button', { name: '2025-03-04' }))

    await waitFor(() => expect(api.saveEntry).toHaveBeenCalledWith(today, 'Unsaved thought'))
  })

  it("opens the person's own calendar day, not the UTC one", async () => {
    vi.stubEnv('TZ', 'Asia/Shanghai')
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-10-01T23:30:00Z'))
    const { api } = heldApi([])
    renderPage(api)

    expect(await screen.findByRole('heading', { name: /October 2, 2026/ })).toBeInTheDocument()
    expect(api.today).not.toHaveBeenCalled()
    expect(api.onThisDay).toHaveBeenCalledWith('2026-10-02')
  })
})
