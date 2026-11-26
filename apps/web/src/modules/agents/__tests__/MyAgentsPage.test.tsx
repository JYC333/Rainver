import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { MyAgent, MyAgentsPage as Page } from '@rainver/protocol'
import MyAgentsPage from '../MyAgentsPage'
import { agentsApi } from '../../../api/client'

vi.mock('../../../api/client', () => ({ agentsApi: { listMine: vi.fn() } }))
const space = vi.hoisted(() => ({ preferredSpaceId: 'home' as string | null }))
vi.mock('../../../contexts/SpaceContext', () => ({
  useSpace: () => ({ userId: 'u1', activeSpaceId: null, preferredSpaceId: space.preferredSpaceId }),
}))

const base: MyAgent = {
  agent_id: 'a', space_id: 'home', space_name: 'Personal', name: 'Agent', description: null, status: 'active',
  access: 'owner', management: 'manage', can_open_detail: true, can_direct_chat: true, plugin_id: null,
  home_project: null, usable_room_count: 0, locations: [],
}
const entry = (patch: Partial<MyAgent>): MyAgent => ({ ...base, ...patch })
/** Stands in for the server's digest of the whole list: equal exactly when the lists are. */
const revisionOf = (all: MyAgent[]) => all.map(item => `${item.agent_id}:${item.name}:${item.access}:${item.management}`).join('|') || 'empty'
const page = (items: MyAgent[]): Page => ({ items, total: items.length, limit: 50, offset: 0, revision: revisionOf(items) })
const renderPage = () => render(<MemoryRouter><MyAgentsPage /></MemoryRouter>)
const card = async (name: string) => (await screen.findByText(name)).closest('[data-testid="my-agent-card"]') as HTMLElement

describe('MyAgentsPage', () => {
  beforeEach(() => { vi.mocked(agentsApi.listMine).mockReset(); space.preferredSpaceId = 'home' })

  it('lists Agents by Space and opens each in its own Space, offering only what the person may do', async () => {
    vi.mocked(agentsApi.listMine).mockResolvedValue(page([
      entry({ agent_id: 'own', name: 'Own helper', description: 'Mine' }),
      entry({ agent_id: 'room', space_id: 'team', space_name: 'Team', name: 'Room helper', access: 'room_only', management: 'room_only',
        can_open_detail: false, can_direct_chat: false, usable_room_count: 1,
        locations: [{ project_id: 'p1', project_name: 'Applications', plugin_state: null, rooms: [{ room_id: 'r1', title: 'Drafts', is_mainline: false }] }] }),
      entry({ agent_id: 'many', space_id: 'team', space_name: 'Team', name: 'Busy helper', access: 'shared', management: 'owner_only', usable_room_count: 3,
        locations: [
          { project_id: 'p1', project_name: 'Applications', plugin_state: null, rooms: [{ room_id: 'r1', title: 'Drafts', is_mainline: false }, { room_id: 'r2', title: 'Reviews', is_mainline: false }] },
          { project_id: 'p2', project_name: 'Thesis', plugin_state: null, rooms: [{ room_id: 'r3', title: 'Writing', is_mainline: false }] },
        ] }),
    ]))
    renderPage()
    expect(await screen.findByRole('region', { name: 'Personal' })).toBeInTheDocument()
    expect(screen.getByRole('region', { name: 'Team' })).toBeInTheDocument()

    const own = await card('Own helper')
    expect(within(own).getByRole('link', { name: 'Details' })).toHaveAttribute('href', '/spaces/home/agents/own')
    expect(within(own).getByRole('link', { name: 'Chat' })).toHaveAttribute('href', '/spaces/home/agents/own/chat')
    expect(within(own).getByText('No Room available')).toBeInTheDocument()

    // Room-only: its one Room by name, and no detail or chat.
    const room = await card('Room helper')
    expect(within(room).queryByRole('link', { name: 'Details' })).toBeNull()
    expect(within(room).queryByRole('link', { name: 'Chat' })).toBeNull()
    expect(within(room).getByRole('link', { name: 'Room: Applications · Drafts' })).toHaveAttribute('href', '/spaces/team/projects/p1/rooms?room=r1')
    expect(within(room).getByText(/shared it into your Rooms only/)).toBeInTheDocument()

    // Several Rooms: collapsed to a count, expanded by Project.
    const busy = await card('Busy helper')
    expect(within(busy).getByText(/Only its owner can edit or manage it/)).toBeInTheDocument()
    expect(within(busy).queryByRole('link', { name: 'Writing' })).toBeNull()
    fireEvent.click(within(busy).getByRole('button', { name: 'Available in 3 Rooms' }))
    expect(within(busy).getByText('Thesis')).toBeInTheDocument()
    expect(within(busy).getByRole('link', { name: 'Writing' })).toHaveAttribute('href', '/spaces/team/projects/p2/rooms?room=r3')
    expect(within(busy).getByRole('link', { name: 'Reviews' })).toHaveAttribute('href', '/spaces/team/projects/p1/rooms?room=r2')
  })

  it('says where a plugin assistant is unavailable, links its plugin page, and marks a stopped Agent', async () => {
    vi.mocked(agentsApi.listMine).mockResolvedValue(page([
      entry({ agent_id: 'phd', space_id: 'team', space_name: 'Team', name: 'Applications assistant', plugin_id: 'phd_application', can_direct_chat: false,
        home_project: { project_id: 'p1', project_name: 'Applications', plugin_state: 'ready' }, usable_room_count: 1,
        locations: [
          { project_id: 'p1', project_name: 'Applications', plugin_state: 'ready', rooms: [{ room_id: 'r1', title: 'Drafts', is_mainline: false }] },
          { project_id: 'p2', project_name: 'Backup', plugin_state: 'unbound', rooms: [{ room_id: 'r2', title: 'Old', is_mainline: false }] },
        ] }),
      entry({ agent_id: 'off', name: 'Stopped helper', status: 'disabled', can_direct_chat: false }),
    ]))
    renderPage()
    const phd = await card('Applications assistant')
    expect(within(phd).getByRole('link', { name: 'Room: Applications · Drafts' })).toBeInTheDocument()
    expect(within(phd).getByText(/Backup: plugin unbound from this Project/)).toBeInTheDocument()
    expect(within(phd).getByRole('link', { name: 'Plugin page' }).getAttribute('href')).toMatch(/^\/spaces\/team\/projects\/p1\/plugins\/phd_application\//)
    expect(within(phd).queryByRole('link', { name: 'Chat' })).toBeNull()
    const stopped = await card('Stopped helper')
    expect(within(stopped).getByText('Stopped')).toBeInTheDocument()
    expect(within(stopped).getByText(/it accepts no new requests/)).toBeInTheDocument()
  })

  it('asks the server for the chosen filters and never keeps an answer after a failure', async () => {
    vi.mocked(agentsApi.listMine).mockResolvedValueOnce(page([entry({ name: 'Own helper' })]))
    renderPage()
    await screen.findByText('Own helper')
    expect(agentsApi.listMine).toHaveBeenLastCalledWith({ manage: 'all', source: 'all', limit: 50, offset: 0 })
    vi.mocked(agentsApi.listMine).mockRejectedValueOnce(new Error('denied'))
    await userEvent.click(screen.getByRole('button', { name: 'Management' }))
    await userEvent.click(await screen.findByRole('option', { name: 'I can manage' }))
    await waitFor(() => expect(agentsApi.listMine).toHaveBeenLastCalledWith({ manage: 'manageable', source: 'all', limit: 50, offset: 0 }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Agents could not be loaded.')
    expect(screen.queryByText('Own helper')).toBeNull()
    vi.mocked(agentsApi.listMine).mockResolvedValueOnce(page([]))
    await userEvent.click(screen.getByRole('button', { name: 'Source' }))
    await userEvent.click(await screen.findByRole('option', { name: 'Room use only' }))
    await waitFor(() => expect(agentsApi.listMine).toHaveBeenLastCalledWith({ manage: 'manageable', source: 'room_only', limit: 50, offset: 0 }))
    expect(await screen.findByText('No agents match these filters.')).toBeInTheDocument()
  })

  it('keeps loaded Agents and says so when "Show more" fails, then retries', async () => {
    vi.mocked(agentsApi.listMine).mockResolvedValueOnce({ items: [entry({ name: 'First helper' })], total: 2, limit: 50, offset: 0, revision: 'r1' })
    renderPage()
    await screen.findByText('First helper')
    vi.mocked(agentsApi.listMine).mockRejectedValueOnce(new Error('offline'))
    await userEvent.click(screen.getByRole('button', { name: 'Show more' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('More agents could not be loaded.')
    expect(screen.getByText('First helper')).toBeInTheDocument()
    vi.mocked(agentsApi.listMine).mockResolvedValueOnce({ items: [entry({ agent_id: 'b', name: 'Second helper' })], total: 2, limit: 50, offset: 1, revision: 'r1' })
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(await screen.findByText('Second helper')).toBeInTheDocument()
    expect(agentsApi.listMine).toHaveBeenLastCalledWith({ manage: 'all', source: 'all', limit: 50, offset: 1 })
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('opens Roles and New agent in a known Space, and keeps them inert while there is none', async () => {
    vi.mocked(agentsApi.listMine).mockResolvedValue(page([]))
    const { unmount } = renderPage()
    expect(await screen.findByRole('link', { name: 'New agent' })).toHaveAttribute('href', '/spaces/home/agents/new')
    expect(screen.getByRole('link', { name: 'Roles' })).toHaveAttribute('href', '/spaces/home/agents/roles')
    unmount()
    // A person with no active Space (or before their Spaces load): an empty list, and no link that lands on Home.
    space.preferredSpaceId = null
    renderPage()
    expect(await screen.findByText(/No agents/)).toBeInTheDocument()
    expect(screen.queryByRole('link', { name: 'New agent' })).toBeNull()
    expect(screen.queryByRole('link', { name: 'Roles' })).toBeNull()
    expect(screen.getByText('New agent').closest('[aria-disabled="true"]')).not.toBeNull()
  })

  it('never shows a plugin source on a Room-only entry', async () => {
    vi.mocked(agentsApi.listMine).mockResolvedValue(page([
      entry({ agent_id: 'r', name: 'Room assistant', access: 'room_only', management: 'room_only', can_open_detail: false, can_direct_chat: false,
        plugin_id: 'phd_application', usable_room_count: 1,
        locations: [{ project_id: 'p1', project_name: 'Applications', plugin_state: null, rooms: [{ room_id: 'r1', title: 'Drafts', is_mainline: false }] }] }),
    ]))
    renderPage()
    const room = await card('Room assistant')
    expect(within(room).queryByText('Plugin')).toBeNull()
    expect(within(room).queryByRole('link', { name: 'Plugin page' })).toBeNull()
  })

  describe('a quiet refresh never rewrites a list that moved on', () => {
    const many = (n: number, label = 'Helper') => Array.from({ length: n }, (_, i) => entry({ agent_id: `a${i}`, name: `${label} ${i}` }))
    const cards = () => screen.queryAllByTestId('my-agent-card')
    const names = () => cards().map(item => item.querySelector('p > span')?.textContent)
    const refresh = () => document.dispatchEvent(new Event('visibilitychange'))
    function deferred<T>() {
      let resolve!: (value: T) => void
      const promise = new Promise<T>(r => { resolve = r })
      return { promise, resolve }
    }
    const slice = (all: MyAgent[], limit: number, offset: number): Page => ({ items: all.slice(offset, offset + limit), total: all.length, limit, offset, revision: revisionOf(all) })
    const reads = () => vi.mocked(agentsApi.listMine).mock.calls.map(([query]) => [query?.limit, query?.offset])

    it('drops a refresh that was in flight when "Show more" loaded the next page', async () => {
      const all = many(120)
      vi.mocked(agentsApi.listMine).mockResolvedValueOnce(slice(all, 50, 0))
      renderPage()
      await screen.findByText('Helper 49')
      const late = deferred<Page>()
      vi.mocked(agentsApi.listMine).mockReturnValueOnce(late.promise)
      refresh()
      await waitFor(() => expect(agentsApi.listMine).toHaveBeenCalledTimes(2))
      vi.mocked(agentsApi.listMine).mockResolvedValueOnce(slice(all, 50, 50))
      await userEvent.click(screen.getByRole('button', { name: 'Show more' }))
      await screen.findByText('Helper 99')
      expect(agentsApi.listMine).toHaveBeenLastCalledWith({ manage: 'all', source: 'all', limit: 50, offset: 50 })
      // The refresh read before the page answers last: it describes 50 entries, not the 100 shown.
      late.resolve(slice(many(120, 'Stale'), 50, 0))
      await new Promise(resolve => setTimeout(resolve, 20))
      expect(cards()).toHaveLength(100)
      expect(screen.queryByText('Stale 0')).toBeNull()
      // The next refresh reads the whole loaded range again.
      vi.mocked(agentsApi.listMine).mockResolvedValueOnce(slice(many(120, 'Fresh'), 100, 0))
      refresh()
      await screen.findByText('Fresh 99')
      expect(agentsApi.listMine).toHaveBeenLastCalledWith({ manage: 'all', source: 'all', limit: 100, offset: 0 })
      expect(cards()).toHaveLength(100)
    })

    it('re-reads the loaded range with the next page when "Show more" finds the list moved, repeating and skipping nothing', async () => {
      let all = many(60)
      vi.mocked(agentsApi.listMine).mockImplementation(async query => slice(all, query?.limit ?? 50, query?.offset ?? 0))
      renderPage()
      await screen.findByText('Helper 49')
      vi.mocked(agentsApi.listMine).mockClear()
      // One entry was added in front meanwhile: the next page would start with one already shown.
      all = [entry({ agent_id: 'new', name: 'Added helper' }), ...all]
      await userEvent.click(screen.getByRole('button', { name: 'Show more' }))
      await screen.findByText('Added helper')
      expect(reads()).toEqual([[50, 50], [100, 0]])
      expect(names()).toEqual(all.map(item => item.name))
      expect(screen.getAllByText('Helper 49')).toHaveLength(1)
      // The server position ends the list: no "Show more" that re-reads its last entry forever.
      expect(screen.queryByRole('button', { name: 'Show more' })).toBeNull()
    })

    it('re-reads when two entries trade places across the "Show more" boundary while the boundary entries stay put', async () => {
      let all = many(120)
      vi.mocked(agentsApi.listMine).mockImplementation(async query => slice(all, query?.limit ?? 50, query?.offset ?? 0))
      renderPage()
      await screen.findByText('Helper 49')
      vi.mocked(agentsApi.listMine).mockClear()
      // The 11th entry is renamed to sort 56th and the 56th to sort 11th: appending the next page
      // as it is now would show a10 twice and never show a55.
      const next = [...all]
      next[10] = entry({ agent_id: 'a55', name: 'Helper 55 renamed' })
      next[55] = entry({ agent_id: 'a10', name: 'Helper 10 renamed' })
      all = next
      await userEvent.click(screen.getByRole('button', { name: 'Show more' }))
      await screen.findByText('Helper 55 renamed')
      expect(reads()).toEqual([[50, 50], [100, 0]])
      expect(names()).toEqual(all.slice(0, 100).map(item => item.name))
      expect(new Set(names()).size).toBe(100)
      expect(screen.queryByText('Helper 10')).toBeNull()
      // It continues from the re-read list.
      await userEvent.click(screen.getByRole('button', { name: 'Show more' }))
      await screen.findByText('Helper 119')
      expect(reads()).toEqual([[50, 50], [100, 0], [50, 100]])
      expect(cards()).toHaveLength(120)
    })

    it('drops a "Show more" re-read in flight when the filters change', async () => {
      let all = many(60)
      vi.mocked(agentsApi.listMine).mockImplementation(async query => slice(all, query?.limit ?? 50, query?.offset ?? 0))
      renderPage()
      await screen.findByText('Helper 49')
      all = [entry({ agent_id: 'new', name: 'Added helper' }), ...all]
      const late = deferred<Page>()
      vi.mocked(agentsApi.listMine).mockImplementationOnce(async query => slice(all, query?.limit ?? 50, query?.offset ?? 0))
        .mockReturnValueOnce(late.promise)
        .mockResolvedValueOnce(page([entry({ agent_id: 'm', name: 'Managed helper' })]))
      await userEvent.click(screen.getByRole('button', { name: 'Show more' }))
      await waitFor(() => expect(reads().at(-1)).toEqual([100, 0]))
      await userEvent.click(screen.getByRole('button', { name: 'Management' }))
      await userEvent.click(await screen.findByRole('option', { name: 'I can manage' }))
      await screen.findByText('Managed helper')
      const fresh = deferred<Page>()
      vi.mocked(agentsApi.listMine).mockReturnValueOnce(fresh.promise)
      const beforeRefresh = reads().length
      refresh()
      expect(reads()).toHaveLength(beforeRefresh + 1)

      await act(async () => { late.resolve(slice(all, 100, 0)) })
      await act(async () => {
        fresh.resolve(page([entry({ agent_id: 'm', name: 'Updated managed helper' })]))
      })
      expect(await screen.findByText('Updated managed helper')).toBeInTheDocument()
      expect(screen.queryByText('Added helper')).toBeNull()
      expect(cards()).toHaveLength(1)
    })

    it('refreshes a loaded range past the server page size in several reads, never cutting it short', async () => {
      const all = many(260)
      vi.mocked(agentsApi.listMine).mockImplementation(async query => slice(all, query?.limit ?? 50, query?.offset ?? 0))
      renderPage()
      await screen.findByText('Helper 49')
      for (let shown = 50; shown < 250; shown += 50) {
        await userEvent.click(screen.getByRole('button', { name: 'Show more' }))
        await screen.findByText(`Helper ${shown + 49}`)
      }
      expect(cards()).toHaveLength(250)
      const renamed = many(260, 'Renamed')
      vi.mocked(agentsApi.listMine).mockClear()
      vi.mocked(agentsApi.listMine).mockImplementation(async query => slice(renamed, query?.limit ?? 50, query?.offset ?? 0))
      refresh()
      await screen.findByText('Renamed 249')
      // Contiguous server pages; both carried one revision, so they were cut from one list.
      expect(reads()).toEqual([[200, 0], [50, 200]])
      expect(cards()).toHaveLength(250)
      expect(screen.queryByText('Helper 0')).toBeNull()
    })

    /** Loads 250 of `all` through "Show more", answering every read from `list()` as it is at that moment. */
    async function load250(list: () => MyAgent[]) {
      vi.mocked(agentsApi.listMine).mockImplementation(async query => slice(list(), query?.limit ?? 50, query?.offset ?? 0))
      renderPage()
      await screen.findByText('Helper 49')
      for (let shown = 50; shown < 250; shown += 50) {
        await userEvent.click(screen.getByRole('button', { name: 'Show more' }))
        await screen.findByText(`Helper ${shown + 49}`)
      }
      vi.mocked(agentsApi.listMine).mockClear()
    }

    it('starts a long refresh over when an entry is added in front between its reads, skipping and repeating nothing', async () => {
      let all = many(260)
      await load250(() => all)
      const added = entry({ agent_id: 'new', name: 'Added helper' })
      vi.mocked(agentsApi.listMine).mockImplementation(async query => {
        const answer = slice(all, query?.limit ?? 50, query?.offset ?? 0)
        if (query?.offset === 0 && !all.includes(added)) all = [added, ...all]
        return answer
      })
      refresh()
      await screen.findByText('Added helper')
      expect(reads()).toEqual([[200, 0], [50, 200], [200, 0], [50, 200]])
      expect(names()).toEqual(all.slice(0, 250).map(item => item.name))
      // 261 now: the one pushed past the loaded range is still one "Show more" away.
      await userEvent.click(screen.getByRole('button', { name: 'Show more' }))
      expect(agentsApi.listMine).toHaveBeenLastCalledWith({ manage: 'all', source: 'all', limit: 50, offset: 250 })
      await screen.findByText('Helper 259')
      expect(cards()).toHaveLength(261)
      expect(screen.queryByRole('button', { name: 'Show more' })).toBeNull()
    })

    it('starts over when an entry is removed between reads, and keeps the list when it never settles', async () => {
      let all = many(260)
      await load250(() => all)
      // A revoked entry before the second read: the stitched list would skip one.
      vi.mocked(agentsApi.listMine).mockImplementation(async query => {
        const answer = slice(all, query?.limit ?? 50, query?.offset ?? 0)
        if (query?.offset === 0 && all[3]?.agent_id === 'a3') all = all.filter(item => item.agent_id !== 'a3')
        return answer
      })
      refresh()
      await waitFor(() => expect(screen.queryByText('Helper 3')).toBeNull())
      expect(names()).toEqual(all.slice(0, 250).map(item => item.name))
      // A list that moves before every second read: a bounded number of tries, then the current answer stays.
      vi.mocked(agentsApi.listMine).mockClear()
      let n = 0
      vi.mocked(agentsApi.listMine).mockImplementation(async query => {
        const answer = slice(all, query?.limit ?? 50, query?.offset ?? 0)
        if (query?.offset === 0) all = [entry({ agent_id: `x${n}`, name: `Churn ${n++}` }), ...all]
        return answer
      })
      refresh()
      await waitFor(() => expect(agentsApi.listMine).toHaveBeenCalledTimes(6))
      await new Promise(resolve => setTimeout(resolve, 20))
      expect(agentsApi.listMine).toHaveBeenCalledTimes(6)
      expect(screen.queryByText(/Churn/)).toBeNull()
      expect(cards()).toHaveLength(250)
    })

    it('starts over when two entries trade places across the page boundary while the boundary entry stays put', async () => {
      let all = many(260)
      await load250(() => all)
      // Between the reads, the 11th entry is renamed to sort 211th and the 211th to sort 11th:
      // the 200th..201st entries do not move, so no single boundary entry would notice.
      vi.mocked(agentsApi.listMine).mockImplementation(async query => {
        const answer = slice(all, query?.limit ?? 50, query?.offset ?? 0)
        if (query?.offset === 0 && all[10]?.agent_id === 'a10') {
          const next = [...all]
          next[10] = entry({ agent_id: 'a210', name: 'Helper 210 renamed' })
          next[210] = entry({ agent_id: 'a10', name: 'Helper 10 renamed' })
          all = next
        }
        return answer
      })
      refresh()
      await screen.findByText('Helper 210 renamed')
      expect(reads()).toEqual([[200, 0], [50, 200], [200, 0], [50, 200]])
      expect(names()).toEqual(all.slice(0, 250).map(item => item.name))
      expect(new Set(names()).size).toBe(250)
      expect(screen.queryByText('Helper 10')).toBeNull()
      expect(screen.getByText('Helper 10 renamed')).toBeInTheDocument()
    })

    it('starts over when access to a shown entry changes between reads, showing what the person may do now', async () => {
      let all = many(260)
      await load250(() => all)
      expect(within(await card('Helper 5')).queryByText('Room use only')).toBeNull()
      // Same entries in the same places; only what the person may do with one changed.
      vi.mocked(agentsApi.listMine).mockImplementation(async query => {
        const answer = slice(all, query?.limit ?? 50, query?.offset ?? 0)
        if (query?.offset === 0 && all[5]?.access === 'owner') {
          all = all.map((item, i) => i === 5 ? { ...item, access: 'room_only', management: 'room_only', can_open_detail: false, can_direct_chat: false } : item)
        }
        return answer
      })
      refresh()
      await waitFor(async () => expect(within(await card('Helper 5')).getByText('Room use only')).toBeInTheDocument())
      expect(reads()).toEqual([[200, 0], [50, 200], [200, 0], [50, 200]])
      expect(cards()).toHaveLength(250)
    })

    it('lets the latest of a timed and a visibility refresh win, whichever answers last', async () => {
      const interval = vi.spyOn(window, 'setInterval')
      vi.mocked(agentsApi.listMine).mockResolvedValueOnce(slice(many(10), 50, 0))
      renderPage()
      await screen.findByText('Helper 9')
      const tick = interval.mock.calls.find(([, ms]) => ms === 30_000)?.[0] as () => void
      interval.mockRestore()
      expect(tick).toBeTypeOf('function')
      const older = deferred<Page>()
      const newer = deferred<Page>()
      vi.mocked(agentsApi.listMine).mockReturnValueOnce(older.promise).mockReturnValueOnce(newer.promise)
      refresh()
      tick()
      await waitFor(() => expect(agentsApi.listMine).toHaveBeenCalledTimes(3))
      newer.resolve(slice(many(10, 'Newer'), 50, 0))
      await screen.findByText('Newer 9')
      older.resolve(slice(many(10, 'Older'), 50, 0))
      await new Promise(resolve => setTimeout(resolve, 20))
      expect(screen.queryByText('Older 0')).toBeNull()
      expect(cards()).toHaveLength(10)
    })

    it('stops a "Show more" whose list never settles after bounded reads, keeps the list, then retries', async () => {
      let all = many(320)
      await load250(() => all)
      let n = 0
      let churn = true
      vi.mocked(agentsApi.listMine).mockImplementation(async query => {
        // Every read finds one more entry in front.
        if (churn) all = [entry({ agent_id: `n${n}`, name: `Arrived ${n++}` }), ...all]
        return slice(all, query?.limit ?? 50, query?.offset ?? 0)
      })
      await userEvent.click(screen.getByRole('button', { name: 'Show more' }))
      await screen.findByText('More agents could not be loaded.')
      // The page, then the range in server-sized pages, started over at most three times: never an endless loop.
      expect(reads()).toEqual([[50, 250], [200, 0], [100, 200], [200, 0], [100, 200], [200, 0], [100, 200]])
      expect(names()).toEqual(many(250).map(item => item.name))
      churn = false
      vi.mocked(agentsApi.listMine).mockClear()
      await userEvent.click(screen.getByRole('button', { name: 'Retry' }))
      await screen.findByText(`Arrived ${n - 1}`)
      expect(reads()).toEqual([[50, 250], [200, 0], [100, 200]])
      expect(names()).toEqual(all.slice(0, 300).map(item => item.name))
      expect(screen.queryByText('More agents could not be loaded.')).toBeNull()
    })

    it('drops a refresh in flight when the filters change, and shows a revoked entry gone', async () => {
      vi.mocked(agentsApi.listMine).mockResolvedValueOnce(slice(many(3), 50, 0))
      renderPage()
      await screen.findByText('Helper 2')
      // Access to one entry was revoked: the refresh answers without it.
      vi.mocked(agentsApi.listMine).mockResolvedValueOnce(page([many(3)[0]!, many(3)[2]!]))
      refresh()
      await waitFor(() => expect(screen.queryByText('Helper 1')).toBeNull())
      expect(cards()).toHaveLength(2)
      const late = deferred<Page>()
      vi.mocked(agentsApi.listMine).mockReturnValueOnce(late.promise).mockResolvedValueOnce(page([entry({ agent_id: 'm', name: 'Managed helper' })]))
      refresh()
      await userEvent.click(screen.getByRole('button', { name: 'Management' }))
      await userEvent.click(await screen.findByRole('option', { name: 'I can manage' }))
      await screen.findByText('Managed helper')
      late.resolve(slice(many(3, 'Unfiltered'), 50, 0))
      await new Promise(resolve => setTimeout(resolve, 20))
      expect(screen.queryByText('Unfiltered 0')).toBeNull()
      expect(cards()).toHaveLength(1)
    })
  })
})
