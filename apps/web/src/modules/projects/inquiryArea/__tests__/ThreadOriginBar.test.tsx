import type { ReactNode } from 'react'
import { render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ThreadOriginBar } from '../ThreadOriginBar'
import { inquiryApi } from '../../../../api/client'
import type { InquiryOpenStep } from '../../../../types/api'

vi.mock('../../../../api/client', () => ({
  inquiryApi: { listOpenSteps: vi.fn() },
}))

vi.mock('../../../../core/spaceNav', () => ({
  SpaceLink: ({ to, children }: { to: string; children: ReactNode }) => <a href={to}>{children}</a>,
}))

function openStep(overrides: Partial<InquiryOpenStep>): InquiryOpenStep {
  return {
    id: 'step-1', project_id: 'project-1', thread_id: 'thread-1',
    kind: 'search_acquisition', status: 'in_progress', slot: 'background', note: null,
    target_ref_kind: null, target_ref_id: null, iteration_id: null, origin: 'user',
    started_at: '2026-08-13T00:00:00.000Z', completed_at: null,
    created_at: '2026-08-13T00:00:00.000Z',
    statement: 'Does caching help?',
    ...overrides,
  }
}

beforeEach(() => {
  vi.mocked(inquiryApi.listOpenSteps).mockReset()
})

describe('ThreadOriginBar', () => {
  it('names the Thread that sent the user here, with a way back to it', async () => {
    vi.mocked(inquiryApi.listOpenSteps).mockResolvedValue([openStep({})])
    render(<ThreadOriginBar projectId="project-1" kinds={['search_acquisition']} />)

    expect(await screen.findByText('Does caching help?')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /Back to the Thread/ }))
      .toHaveAttribute('href', '/projects/project-1/inquiry?thread=thread-1')
  })

  it('does not claim a Thread whose step belongs to another Area', async () => {
    // The whole point of the filter: Operations must not announce a Thread that
    // is off being read or written up somewhere else.
    vi.mocked(inquiryApi.listOpenSteps).mockResolvedValue([
      openStep({ id: 'step-2', kind: 'read_evidence', slot: 'primary', statement: 'Elsewhere entirely' }),
    ])
    render(<ThreadOriginBar projectId="project-1" kinds={['search_acquisition']} />)

    await waitFor(() => expect(inquiryApi.listOpenSteps).toHaveBeenCalled())
    expect(screen.queryByText('Elsewhere entirely')).not.toBeInTheDocument()
  })

  it('shows every Thread that sent work to this Area, not just the first', async () => {
    vi.mocked(inquiryApi.listOpenSteps).mockResolvedValue([
      openStep({}),
      openStep({ id: 'step-3', thread_id: 'thread-2', statement: 'Is eviction correct?' }),
    ])
    render(<ThreadOriginBar projectId="project-1" kinds={['search_acquisition']} />)

    expect(await screen.findByText('Does caching help?')).toBeInTheDocument()
    expect(screen.getByText('Is eviction correct?')).toBeInTheDocument()
  })

  it('renders nothing at all when no step points here, reserving no space', async () => {
    vi.mocked(inquiryApi.listOpenSteps).mockResolvedValue([])
    const { container } = render(<ThreadOriginBar projectId="project-1" kinds={['synthesize']} />)

    await waitFor(() => expect(inquiryApi.listOpenSteps).toHaveBeenCalled())
    expect(container).toBeEmptyDOMElement()
  })

  it('stays out of the way when the context cannot be loaded', async () => {
    // Context is an aid; failing to fetch it must never keep the Area the user
    // actually asked for off the screen.
    vi.mocked(inquiryApi.listOpenSteps).mockRejectedValue(new Error('offline'))
    const { container } = render(<ThreadOriginBar projectId="project-1" kinds={['search_acquisition']} />)

    await waitFor(() => expect(inquiryApi.listOpenSteps).toHaveBeenCalled())
    expect(container).toBeEmptyDOMElement()
  })
})
