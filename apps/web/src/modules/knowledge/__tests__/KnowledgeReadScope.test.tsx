import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createMemoryRouter, RouterProvider } from 'react-router-dom'
import type { ReactNode } from 'react'
import KnowledgeDetailPage from '../KnowledgeDetailPage'
import SourcesPage from '../SourcesPage'
import { knowledgeApi, knowledgeSourcesApi } from '../../../api/client'
import type { KnowledgeItem, KnowledgeRelation, KnowledgeSourceSummary, Page } from '../../../types/api'

const scope = vi.hoisted(() => ({ activeSpaceId: 'space-a', activeSpaceName: 'Space A', userId: 'owner' }))
vi.mock('../../../contexts/SpaceContext', () => ({ useSpace: () => scope }))
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }))
vi.mock('../../../core/spaceNav', () => ({
  SpaceLink: ({ to, children }: { to: string; children: ReactNode }) => <a href={to}>{children}</a>,
}))
vi.mock('../../../api/client', () => ({
  knowledgeApi: { get: vi.fn(), relations: vi.fn(), proposeArchive: vi.fn() },
  knowledgeSourcesApi: { list: vi.fn() },
}))
vi.mock('../../focusAreas/FocusAreaField', () => ({ FocusAreaField: () => null }))
vi.mock('../KnowledgeDetailHeader', () => ({ default: ({ item, onArchive }: { item: KnowledgeItem; onArchive: () => void }) =>
  <div><h1>{item.title}</h1><p>{item.content}</p><button onClick={onArchive}>Archive item</button></div> }))
vi.mock('../KnowledgeProposalNotice', () => ({ default: () => null }))
vi.mock('../KnowledgeUpdateProposalForm', () => ({ default: () => null }))
vi.mock('../KnowledgeRelationProposalForm', () => ({ default: () => null }))
vi.mock('../KnowledgeSectionHeader', () => ({ default: () => <h1>Sources</h1> }))

function pending<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}
function item(id: string, title: string): KnowledgeItem {
  return { id, title, content: `${title} body`, owner_user_id: 'owner', focus_area_id: null } as KnowledgeItem
}
function mountDetail() {
  const router = createMemoryRouter([{ path: '/:itemId', element: <KnowledgeDetailPage /> }], { initialEntries: ['/first'] })
  const view = render(<RouterProvider router={router} />)
  return { router, ...view }
}

beforeEach(() => {
  vi.resetAllMocks()
  scope.activeSpaceId = 'space-a'
  vi.mocked(knowledgeApi.relations).mockResolvedValue([])
})

describe('Knowledge read scope', () => {
  it('does not restore a previous item after the current item is denied', async () => {
    const previous = pending<KnowledgeItem>()
    vi.mocked(knowledgeApi.get).mockImplementation(id => id === 'first'
      ? previous.promise : Promise.reject(new Error('404 Not found')))
    const { router } = mountDetail()
    await waitFor(() => expect(knowledgeApi.get).toHaveBeenCalledWith('first'))
    await act(async () => { await router.navigate('/second') })
    expect(await screen.findByText('Knowledge item not found or not authorized.')).toBeInTheDocument()
    await act(async () => { previous.resolve(item('first', 'Previous private item')) })
    expect(screen.queryByText('Previous private item')).not.toBeInTheDocument()
    expect(knowledgeApi.relations).not.toHaveBeenCalled()
  })

  it('does not restore relations from the previous Space after the new list is empty', async () => {
    const previous = pending<KnowledgeRelation[]>()
    vi.mocked(knowledgeApi.get).mockResolvedValue(item('first', 'Current item'))
    vi.mocked(knowledgeApi.relations).mockReturnValueOnce(previous.promise)
    const { router } = mountDetail()
    await waitFor(() => expect(knowledgeApi.relations).toHaveBeenCalledTimes(1))
    scope.activeSpaceId = 'space-b'
    await act(async () => { await router.navigate('/first?space=space-b') })
    expect(await screen.findByText('No visible relations.')).toBeInTheDocument()
    await act(async () => { previous.resolve([{ id: 'old-edge', space_id: 'space-a', from_object_id: 'first', to_object_id: 'hidden',
      link_type: 'related_to', status: 'active', evidence_summary: 'Previous private excerpt', confidence: null,
      source_proposal_id: null, created_by_user_id: null, created_by_agent_id: null, created_from_assessment_id: null,
      created_at: '2026-07-19T00:00:00Z', updated_at: '2026-07-19T00:00:00Z' }]) })
    expect(screen.queryByText('Previous private excerpt')).not.toBeInTheDocument()
    expect(screen.getByText('No visible relations.')).toBeInTheDocument()
  })

  it('clears the item when a command reports revoked access', async () => {
    vi.mocked(knowledgeApi.get).mockResolvedValue(item('first', 'Revoked item'))
    vi.mocked(knowledgeApi.proposeArchive).mockRejectedValue(new Error('404 Not found'))
    mountDetail()
    fireEvent.click(await screen.findByRole('button', { name: 'Archive item' }))
    expect(await screen.findByText('Knowledge item not found or not authorized.')).toBeInTheDocument()
    expect(screen.queryByText('Revoked item body')).not.toBeInTheDocument()
  })

  it('does not restore the previous Space source list after switching to an empty Space', async () => {
    const previous = pending<Page<KnowledgeSourceSummary>>()
    vi.mocked(knowledgeSourcesApi.list).mockReturnValueOnce(previous.promise)
      .mockResolvedValue({ items: [], total: 0, limit: 100, offset: 0 })
    const { rerender } = render(<SourcesPage />)
    await waitFor(() => expect(knowledgeSourcesApi.list).toHaveBeenCalledTimes(1))
    scope.activeSpaceId = 'space-b'
    rerender(<SourcesPage />)
    expect(await screen.findByText('No sources yet')).toBeInTheDocument()
    await act(async () => { previous.resolve({ items: [{ id: 'private-source', title: 'Previous private source' } as KnowledgeSourceSummary],
      total: 1, limit: 100, offset: 0 }) })
    expect(screen.queryByText('Previous private source')).not.toBeInTheDocument()
  })

  it('distinguishes an unavailable source list from an empty one', async () => {
    vi.mocked(knowledgeSourcesApi.list).mockRejectedValue(new Error('Service unavailable'))
    render(<SourcesPage />)
    expect(await screen.findByText('Sources unavailable: Service unavailable')).toBeInTheDocument()
    expect(screen.queryByText('No sources yet')).not.toBeInTheDocument()
  })
})
