import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { createDiaryPage } from '../../../../plugins/official/diary/web/src/DiaryPage'
import { saveDiaryEntry } from '../../../../plugins/official/diary/web/src/saveQueue'
import type { DiaryApi, DiaryEntry, DiaryWebHost } from '../../../../plugins/official/diary/web/src/host'
import { DIARY_MESSAGES } from '../../../../plugins/official/diary/web/src/messages'

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

function renderPage(api: DiaryApi, locale = 'en') {
  const host: DiaryWebHost = {
    api,
    Link: ({ to, children }) => <a href={to}>{children}</a>,
    usePluginState: () => ({ loading: false, enabled: true }),
    useLocale: () => locale,
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
  it('sends the latest edit after the in-flight save, including when leaving and reopening the day', async () => {
    const today = localToday()
    const { api, release } = heldApi([])
    const saved: string[] = []
    const completions: Array<() => void> = []
    api.saveEntry = vi.fn((date: string, content: string) => new Promise<{ entry: DiaryEntry }>(resolve => {
      completions.push(() => { saved.push(content); resolve({ entry: entry(date, content) }) })
    }))
    const first = renderPage(api)
    await release(today)
    await release(new Date().toISOString().slice(0, 10))
    fireEvent.change(await screen.findByRole('textbox'), { target: { value: 'A' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save now' }))
    await waitFor(() => expect(api.saveEntry).toHaveBeenCalledTimes(1))
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'B' } })
    first.unmount()
    renderPage(api)
    await release(today)
    await release(new Date().toISOString().slice(0, 10))
    fireEvent.change(await screen.findByRole('textbox'), { target: { value: 'C' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save now' }))
    expect(api.saveEntry).toHaveBeenCalledTimes(1)
    await act(async () => completions.shift()!())
    await waitFor(() => expect(api.saveEntry).toHaveBeenCalledTimes(2))
    expect(api.saveEntry).toHaveBeenLastCalledWith(today, 'B')
    await act(async () => completions.shift()!())
    await waitFor(() => expect(api.saveEntry).toHaveBeenCalledTimes(3))
    expect(api.saveEntry).toHaveBeenLastCalledWith(today, 'C')
    await act(async () => completions.shift()!())
    expect(saved).toEqual(['A', 'B', 'C'])
  })

  it('continues saving the latest text after an earlier save fails', async () => {
    const { api } = heldApi([])
    api.saveEntry = vi.fn()
      .mockRejectedValueOnce(new Error('Temporary failure'))
      .mockResolvedValueOnce({ entry: entry('2026-10-05', 'B') })
    const first = saveDiaryEntry(api, '2026-10-05', 'A')
    const second = saveDiaryEntry(api, '2026-10-05', 'B')
    await expect(first).rejects.toThrow('Temporary failure')
    await expect(second).resolves.toEqual({ entry: entry('2026-10-05', 'B') })
    expect(api.saveEntry).toHaveBeenLastCalledWith('2026-10-05', 'B')
  })

  it('does not send a queued edit using a changed Space or authentication context', async () => {
    const { api } = heldApi([])
    let context = 'first'
    api.saveContextKey = () => context
    const queued = saveDiaryEntry(api, '2026-10-05', 'Private edit')
    context = 'second'
    await expect(queued).rejects.toThrow('Diary save context changed')
    expect(api.saveEntry).not.toHaveBeenCalled()
  })

  it('does not flush the previous context\'s text when the editor unmounts after a context switch', async () => {
    const { api, release } = heldApi([])
    let context = 'first'
    api.saveContextKey = () => context
    const page = renderPage(api)
    await release(localToday())
    fireEvent.change(await screen.findByRole('textbox'), { target: { value: 'Private edit' } })
    context = 'second'
    await act(async () => page.unmount())
    expect(api.saveEntry).not.toHaveBeenCalled()
  })
  it('shows the day that was picked even when an earlier read answers last', async () => {
    const today = localToday()
    const { api, release } = heldApi([entry(today, 'Written today'), entry('2025-03-04', 'Written in March')])
    renderPage(api)
    fireEvent.click(await screen.findByRole('button', { name: 'Mar 4, 2025' }))

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

    fireEvent.click(await screen.findByRole('button', { name: 'Mar 4, 2025' }))

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

  it('reads in the host locale, keeping each entry on its own calendar day', async () => {
    const today = localToday()
    const { api, release } = heldApi([entry('2025-03-04', '三月写的')])
    renderPage(api, 'zh-CN')
    await release(today)
    await release(new Date().toISOString().slice(0, 10))

    expect(await screen.findByRole('button', { name: '立即保存' })).toBeInTheDocument()
    expect(screen.getByText('历史')).toBeInTheDocument()
    expect(screen.getByRole('textbox')).toHaveAttribute('placeholder', '今天在想些什么？')
    expect(await screen.findByRole('button', { name: '2025年3月4日' })).toBeInTheDocument()
  })

  it('has the same messages in every language it ships', () => {
    const keys = Object.keys(DIARY_MESSAGES.en).sort()
    for (const messages of Object.values(DIARY_MESSAGES)) expect(Object.keys(messages).sort()).toEqual(keys)
  })
})
