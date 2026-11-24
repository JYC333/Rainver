import { StrictMode } from 'react'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, expect, it, vi } from 'vitest'
import { pluginFrontendEntries, type PluginViewOps } from '@rainver/protocol'
import { pluginsApi, queryPluginOperation, callPluginOperation } from '../../api/client'
import { bundledPlugin } from './manifestCatalog'
import { PluginSlot } from './PluginSlot'
import type { PluginSlotComponent } from './slotTypes'

vi.mock('../../contexts/SpaceContext', () => ({
  useSpace: () => ({ userId: 'user', activeSpaceId: 'space' }),
}))
vi.mock('../../api/client', () => ({
  pluginsApi: { list: vi.fn() },
  queryPluginOperation: vi.fn(),
  callPluginOperation: vi.fn(),
}))

afterEach(() => {
  vi.restoreAllMocks()
  vi.resetAllMocks()
})

it.each([
  { pluginId: 'diary', entryId: 'journal', write: 'entry.save', submit: 'Save now' },
  { pluginId: 'finance_ledger', entryId: 'ledger', write: 'book.create', submit: 'Create' },
])('keeps the $pluginId draft through an enabled catalog refresh', async ({ pluginId, entryId, write, submit }) => {
  const bundle = bundledPlugin(pluginId)!
  const original = (await bundle.load()).default[entryId]!
  let currentOps: PluginViewOps | undefined
  const View: PluginSlotComponent = ({ ctx }) => {
    currentOps = ctx.ops
    const Page = original
    return <Page ctx={ctx} />
  }
  vi.spyOn(bundle, 'load').mockResolvedValue({ default: { [entryId]: View } })
  vi.mocked(pluginsApi.list).mockImplementation(async () => ({
    items: [{
      descriptor: {
        id: pluginId,
        version: bundle.manifest.version,
        frontend_entries: pluginFrontendEntries(bundle.manifest),
      },
      effective: { enabled: true },
    }],
  }) as Awaited<ReturnType<typeof pluginsApi.list>>)
  vi.mocked(queryPluginOperation).mockImplementation(async (id, input) => {
    const { date } = input as { date?: string }
    switch (id) {
      case 'plugin.diary.entry.list': return { status: 'succeeded', data: { entries: [] } }
      case 'plugin.diary.entry.get': return { status: 'succeeded', data: { date, entry: null } }
      case 'plugin.diary.entry.on_this_day': return { status: 'succeeded', data: { date, entries: [] } }
      case 'plugin.finance_ledger.book.list': return { status: 'succeeded', data: { books: [] } }
      default: throw new Error(`Unexpected read: ${id}`)
    }
  })
  vi.mocked(callPluginOperation).mockRejectedValue(new Error('Save unavailable'))
  // An editor's background autosave (diary: 1.5s after typing) is not what this
  // test watches, and a loaded machine can take that long to reach the refresh.
  // Hold such timers; a held timer keeps a truthy id, so a remount still sends
  // its pending save on unmount and fails the no-write check below. Testing
  // Library's own polling and timeouts run as usual.
  const realSetTimeout = globalThis.setTimeout
  vi.spyOn(globalThis, 'setTimeout').mockImplementation(((handler: TimerHandler, delay?: number, ...args: unknown[]) =>
    delay !== undefined && delay >= 1_000 && delay <= 5_000
      ? (-1 as unknown as ReturnType<typeof setTimeout>)
      : realSetTimeout(handler as () => void, delay, ...args)) as typeof setTimeout)

  render(<StrictMode><MemoryRouter><PluginSlot pluginId={pluginId} entryId={entryId} /></MemoryRouter></StrictMode>)
  if (pluginId === 'finance_ledger') fireEvent.click(await screen.findByRole('button', { name: '+ New book' }))
  const draft = await screen.findByRole('textbox')
  draft.focus()
  fireEvent.change(draft, { target: { value: 'Unsaved draft' } })
  const previousOps = currentOps!
  const readCount = vi.mocked(queryPluginOperation).mock.calls.length

  await act(async () => { window.dispatchEvent(new Event('focus')) })
  await waitFor(() => expect(currentOps).not.toBe(previousOps))
  expect(screen.getByRole('textbox')).toBe(draft)
  expect(draft).toHaveValue('Unsaved draft')
  expect(draft).toHaveFocus()
  expect(queryPluginOperation).toHaveBeenCalledTimes(readCount)
  expect(callPluginOperation).not.toHaveBeenCalled()

  const command = vi.spyOn(currentOps!, 'command')
  fireEvent.click(screen.getByRole('button', { name: submit }))
  await screen.findByText('Save unavailable')
  expect(command).toHaveBeenCalledWith(
    `plugin.${pluginId}.${write}`,
    expect.objectContaining(pluginId === 'diary' ? { content: 'Unsaved draft' } : { name: 'Unsaved draft' }),
    expect.any(String),
  )
})
