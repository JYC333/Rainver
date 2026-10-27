import { fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, expect, it, vi } from 'vitest'
import { notesApi, providersApi } from '../../../api/client'
import { ReadingListView } from '../researchArea/ReadingListView'
import type { ResearchReadingList } from '../../../types/api'

vi.mock('../../../core/spaceNav', async () => ({ SpaceLink: (await import('react-router-dom')).Link }))
afterEach(() => vi.restoreAllMocks())

it('opens research material with Project origin and returns to the research reading list', async () => {
  vi.spyOn(providersApi, 'usable').mockResolvedValue([])
  vi.spyOn(notesApi, 'linkingTo').mockResolvedValue([])
  const value = { items: [{ id: 'corpus-1', source_item_id: 'item-1', triage_status: 'relevant', read_status: 'unread', source_item: { title: 'Retained research material', excerpt: 'Retained preview' } }] } as unknown as ResearchReadingList
  render(<MemoryRouter><ReadingListView projectId="project-a" value={value} reload={vi.fn()} /></MemoryRouter>)
  fireEvent.click(screen.getByRole('button', { name: 'Retained research material' }))
  const link = new URL(screen.getByRole('link', { name: 'Open in reader' }).getAttribute('href')!, 'http://test')
  expect(link.pathname).toBe('/library/items/item-1')
  expect(link.searchParams.get('from')).toBe('project')
  expect(link.searchParams.get('returnTo')).toBe('/projects/project-a/research?tab=reading')
})
