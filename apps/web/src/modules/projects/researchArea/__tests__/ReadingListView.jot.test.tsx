import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ReadingListView } from '../ReadingListView'
import type { ResearchReadingList } from '../../../../types/api'

// NC/N7: the jot affordance is the evidence-side half of "notes and evidence
// connect both ways". What matters here is that one click records the link —
// the two-step version (leave for Notes, create, come back for the id) is why
// the connection was never made in practice.

const { jot, linkingTo } = vi.hoisted(() => ({ jot: vi.fn(), linkingTo: vi.fn() }))

vi.mock('../../../../api/client', () => ({
  notesApi: { jot, linkingTo },
  projectResearchApi: { updateEvidenceCard: vi.fn(), askAi: vi.fn() },
  projectsApi: { updateCorpusItem: vi.fn() },
  providersApi: { list: vi.fn().mockResolvedValue([]) },
}))
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))
vi.mock('../../../../core/spaceNav', async () => {
  const { Link } = await import('react-router-dom')
  return { SpaceLink: Link }
})

function readingList(overrides: Partial<ResearchReadingList['items'][number]> = {}): ResearchReadingList {
  return {
    items: [{
      id: 'corpus-1', space_id: 'space-1', project_id: 'project-1',
      object_id: 'source-1', source_item_id: 'item-1', evidence_id: null,
      source_connection_id: null, source_decision_id: null,
      role: 'reference', status: 'active', triage_status: 'relevant', read_status: 'unread',
      relevance: 'relevant', confidence: null, reason: null, added_by_user_id: null,
      metadata_json: {}, created_at: '', updated_at: '', last_reviewed_at: null, last_read_at: null,
      object: { id: 'source-1', title: 'Attention Is All You Need', summary: null } as never,
      source_item: null, evidence: null, evidence_card: null,
      ...overrides,
    }],
    total: 1, limit: 20, offset: 0,
  }
}

function renderView(value: ResearchReadingList) {
  return render(
    <MemoryRouter>
      <ReadingListView projectId="project-1" value={value} reload={vi.fn()} />
    </MemoryRouter>,
  )
}

beforeEach(() => {
  jot.mockReset()
  linkingTo.mockReset()
  linkingTo.mockResolvedValue([])
})

describe('ReadingListView jot a note', () => {
  it('creates the note and its link from the card in one step', async () => {
    jot.mockResolvedValue({ id: 'note-1' })
    renderView(readingList())
    const user = userEvent.setup()

    await user.click(await screen.findByRole('button', { name: 'Jot a note' }))
    await user.type(screen.getByLabelText('Note about Attention Is All You Need'), 'Depth needs residuals.')
    await user.click(screen.getByRole('button', { name: 'Save note' }))

    await waitFor(() => expect(jot).toHaveBeenCalledWith({
      target_id: 'source-1',
      text: 'Depth needs residuals.',
      project_id: 'project-1',
    }))
  })

  it('appends to the note already jotted against the material', async () => {
    // Resolved from the recorded link, not from this session — reloading the
    // page must not offer a fresh note for material that already has one.
    linkingTo.mockResolvedValue([{ source_id: 'note-1', source_type: 'note' }])
    jot.mockResolvedValue({ id: 'note-1' })
    renderView(readingList())
    const user = userEvent.setup()

    await user.click(await screen.findByRole('button', { name: 'Add to note' }))
    await user.type(screen.getByLabelText('Note about Attention Is All You Need'), 'Second thought.')
    await user.click(screen.getByRole('button', { name: 'Save note' }))

    await waitFor(() => expect(jot).toHaveBeenCalledWith(expect.objectContaining({ note_id: 'note-1' })))
  })

  it('offers no jot where there is nothing linkable', async () => {
    // A corpus row targets exactly one of object / source_item / evidence, and
    // only the object is a `space_objects` row a note_link can point at.
    renderView(readingList({ object_id: null, object: null }))
    await waitFor(() => expect(linkingTo).not.toHaveBeenCalled())
    expect(screen.queryByRole('button', { name: 'Jot a note' })).toBeNull()
  })
})
