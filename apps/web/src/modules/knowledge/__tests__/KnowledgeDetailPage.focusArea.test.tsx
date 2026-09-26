import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import KnowledgeDetailPage from '../KnowledgeDetailPage'
import { focusAreasApi, knowledgeApi } from '../../../api/client'

vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }))
vi.mock('../../../contexts/SpaceContext', () => ({
  useSpace: () => ({ activeSpaceId: 'space-1', activeSpaceName: 'Space One', userId: 'user-1' }),
}))
vi.mock('../../../core/spaceNav', () => ({
  SpaceLink: ({ to, children, ...props }: { to: string; children: ReactNode }) => <a href={to} {...props}>{children}</a>,
}))
vi.mock('../../../api/client', () => ({
  focusAreasApi: { list: vi.fn(), setForObject: vi.fn().mockResolvedValue(undefined) },
  knowledgeApi: { get: vi.fn(), relations: vi.fn().mockResolvedValue([]) },
}))
vi.mock('../KnowledgeDetailHeader', () => ({ default: ({ item }: { item: { title: string } }) => <h1>{item.title}</h1> }))
vi.mock('../KnowledgeProposalNotice', () => ({ default: () => null }))
vi.mock('../KnowledgeUpdateProposalForm', () => ({ default: () => null }))
vi.mock('../KnowledgeRelationsPanel', () => ({ default: () => null }))
vi.mock('../KnowledgeRelationProposalForm', () => ({ default: () => null }))

const areas = [
  { id: 'domain-1', name: 'Work', archived_at: null },
  { id: 'domain-2', name: 'Health', archived_at: null },
]

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/knowledge/wiki/item-1']}>
      <Routes>
        <Route path="/knowledge/wiki/:itemId" element={<KnowledgeDetailPage />} />
      </Routes>
    </MemoryRouter>,
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(focusAreasApi.list).mockResolvedValue(areas as never)
})

describe('Knowledge Item Domain classification', () => {
  it('lets a viewer file ownerless knowledge in a Domain from the item page', async () => {
    vi.mocked(knowledgeApi.get).mockResolvedValue({
      id: 'item-1', title: 'Shared concept', owner_user_id: null, focus_area_id: 'domain-1',
    } as never)
    renderPage()

    const selector = await screen.findByRole('button', { name: 'Domain' })
    await waitFor(() => expect(selector).toHaveTextContent('Work'))
    fireEvent.click(selector)
    fireEvent.click(screen.getByRole('option', { name: 'Health' }))
    await waitFor(() => expect(focusAreasApi.setForObject).toHaveBeenCalledWith('item-1', 'domain-2'))
    expect(selector).toHaveTextContent('Health')
    fireEvent.click(selector)
    fireEvent.click(screen.getByRole('option', { name: 'No domain' }))
    await waitFor(() => expect(focusAreasApi.setForObject).toHaveBeenCalledWith('item-1', null))
    expect(selector).toHaveTextContent('No domain')
  })

  it('shows another owner’s Domain without offering a write', async () => {
    vi.mocked(knowledgeApi.get).mockResolvedValue({
      id: 'item-1', title: 'Shared concept', owner_user_id: 'user-2', focus_area_id: 'domain-1',
    } as never)
    renderPage()

    const selector = await screen.findByRole('button', { name: 'Domain' })
    await waitFor(() => expect(selector).toHaveTextContent('Work'))
    expect(selector).toBeDisabled()
    expect(focusAreasApi.setForObject).not.toHaveBeenCalled()
  })
})
