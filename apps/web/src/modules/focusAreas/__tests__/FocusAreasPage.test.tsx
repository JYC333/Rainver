import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { FocusAreaDetail } from '../FocusAreasPage'
import { focusAreasApi, knowledgeApi, notesApi, projectsApi } from '../../../api/client'

vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }))
vi.mock('../../../core/spaceNav', () => ({
  SpaceLink: ({ to, children, ...props }: { to: string; children: ReactNode }) => <a href={to} {...props}>{children}</a>,
}))
vi.mock('../../knowledge/KnowledgeSectionHeader', () => ({ default: () => null }))
vi.mock('../../../api/client', () => ({
  focusAreasApi: {
    get: vi.fn(),
    contents: vi.fn(),
    setForProject: vi.fn().mockResolvedValue(undefined),
    setForObject: vi.fn().mockResolvedValue(undefined),
  },
  projectsApi: { list: vi.fn() },
  notesApi: { list: vi.fn() },
  knowledgeApi: { list: vi.fn() },
}))

const AREA = 'area-1'

function page<T>(items: T[], total: number, offset = 0) {
  return { items, total, limit: 100, offset }
}

function contents(overrides: Record<string, unknown> = {}) {
  return {
    projects: [],
    objects: [],
    projects_next_cursor: null,
    objects_next_cursor: null,
    ...overrides,
  }
}

function renderDetail() {
  return render(
    <MemoryRouter initialEntries={[`/knowledge/domains/${AREA}`]}>
      <Routes>
        <Route path="/knowledge/domains/:focusAreaId" element={<FocusAreaDetail />} />
      </Routes>
    </MemoryRouter>,
  )
}

async function pickerOptions(label: string): Promise<string[]> {
  fireEvent.click(await screen.findByRole('button', { name: label }))
  const options = screen.getAllByRole('option').map((o) => o.textContent ?? '')
  fireEvent.click(screen.getByRole('button', { name: label }))
  return options
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(focusAreasApi.get).mockResolvedValue({ id: AREA, name: 'Health', description: null } as never)
  vi.mocked(focusAreasApi.contents).mockResolvedValue(contents() as never)
  vi.mocked(projectsApi.list).mockResolvedValue(page([], 0) as never)
  vi.mocked(notesApi.list).mockResolvedValue(page([], 0) as never)
  vi.mocked(knowledgeApi.list).mockResolvedValue(page([], 0) as never)
})

describe('Domain contents continuation', () => {
  it('appends the next page of one list without repeating the other', async () => {
    vi.mocked(focusAreasApi.contents)
      .mockResolvedValueOnce(contents({
        projects: [{ id: 'p1', name: 'Clinic', status: 'active' }],
        objects: [{ id: 'o1', object_type: 'note', title: 'First note' }],
        objects_next_cursor: 'objects-1',
      }) as never)
      .mockResolvedValueOnce(contents({
        projects: [{ id: 'p1', name: 'Clinic', status: 'active' }],
        objects: [{ id: 'o2', object_type: 'knowledge_item', title: 'Second item' }],
      }) as never)
    renderDetail()

    expect(await screen.findByText('First note')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Load more projects in this domain' })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Load more notes and knowledge in this domain' }))

    expect(await screen.findByText('Second item')).toBeInTheDocument()
    expect(focusAreasApi.contents).toHaveBeenLastCalledWith(AREA, { objects_cursor: 'objects-1' })
    expect(screen.getByText('First note')).toBeInTheDocument()
    expect(screen.getAllByText('Clinic')).toHaveLength(1)
    expect(screen.queryByRole('button', { name: 'Load more notes and knowledge in this domain' })).not.toBeInTheDocument()
  })
})

describe('Domain classification pickers', () => {
  it('pages Projects past the first page and leaves out ones already filed here', async () => {
    vi.mocked(projectsApi.list)
      .mockResolvedValueOnce(page([
        { id: 'p-filed', name: 'Already here', focus_area_id: AREA },
        { id: 'p-b', name: 'Budget', focus_area_id: null },
      ], 3) as never)
      .mockResolvedValueOnce(page([{ id: 'p-c', name: 'Checkups', focus_area_id: 'area-2' }], 3, 2) as never)
    renderDetail()

    expect(await pickerOptions('Add a project…')).toEqual(['Add a project…', 'Budget'])
    fireEvent.click(screen.getByRole('button', { name: 'Load more projects to add' }))
    await waitFor(() => expect(projectsApi.list).toHaveBeenLastCalledWith({ status: 'active', limit: 200, offset: 2 }))
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Load more projects to add' })).not.toBeInTheDocument())
    expect(await pickerOptions('Add a project…')).toEqual(['Add a project…', 'Budget', 'Checkups'])

    // Filing an entry from a later page keeps the loaded pages and drops only it.
    fireEvent.click(screen.getByRole('button', { name: 'Add a project…' }))
    fireEvent.click(screen.getByRole('option', { name: 'Checkups' }))
    fireEvent.click(screen.getByRole('button', { name: 'Add' }))
    await waitFor(() => expect(focusAreasApi.setForProject).toHaveBeenCalledWith('p-c', AREA))
    await waitFor(async () => expect(await pickerOptions('Add a project…')).toEqual(['Add a project…', 'Budget']))
    expect(projectsApi.list).toHaveBeenCalledTimes(2)
  })

  it('continues only the note or knowledge source that has more', async () => {
    vi.mocked(notesApi.list)
      .mockResolvedValueOnce(page([{ id: 'n1', title: 'Sleep log', focus_area_id: null }], 2) as never)
      .mockResolvedValueOnce(page([{ id: 'n2', title: null, focus_area_id: null }], 2, 1) as never)
    vi.mocked(knowledgeApi.list)
      .mockResolvedValueOnce(page([{ id: 'k1', title: 'Vitamin D', focus_area_id: null }], 1) as never)
    renderDetail()

    expect(await pickerOptions('Add a note or knowledge item…'))
      .toEqual(['Add a note or knowledge item…', 'Sleep log', 'Vitamin D'])
    fireEvent.click(screen.getByRole('button', { name: 'Load more notes and knowledge items to add' }))
    await waitFor(() => expect(notesApi.list).toHaveBeenLastCalledWith({ limit: 100, offset: 1 }))
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Load more notes and knowledge items to add' })).not.toBeInTheDocument())
    expect(knowledgeApi.list).toHaveBeenCalledTimes(1)
    expect(await pickerOptions('Add a note or knowledge item…'))
      .toEqual(['Add a note or knowledge item…', 'Sleep log', 'Untitled note', 'Vitamin D'])
  })
})
