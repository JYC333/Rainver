import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'

const { createCapture } = vi.hoisted(() => ({
  createCapture: vi.fn().mockResolvedValue({
    activity_id: 'activity-1',
    destination: 'personal_inbox',
    space_id: 'personal-1',
    project_id: null,
    visibility: 'private',
    status: 'raw',
    note_id: null,
    note_title: null,
  }),
}))

const { captureContext } = vi.hoisted(() => ({
  captureContext: { value: { projectId: null as string | null, target: null as { objectId: string; title: string } | null } },
}))

vi.mock('../api/client', () => ({
  captureApi: { create: createCapture },
}))

vi.mock('../contexts/CaptureContext', () => ({
  useProjectCaptureContext: () => captureContext.value,
}))

const { spaceState } = vi.hoisted(() => ({ spaceState: { memberCount: 3 as number | undefined } }))

vi.mock('../contexts/SpaceContext', () => ({
  useSpace: () => ({
    spaces: [
      { id: 'personal-1', name: 'My Personal', type: 'personal', role: 'owner', member_count: 1, created_at: '', updated_at: '' },
      { id: 'team-1', name: 'Acme Team', type: 'team', role: 'member', member_count: spaceState.memberCount, created_at: '', updated_at: '' },
    ],
    personalSpaceId: 'personal-1',
    activeSpaceId: 'team-1',
    activeSpaceName: 'Acme Team',
  }),
}))

import { FloatingQuickCapture } from '../components/FloatingQuickCapture'
import { subscribeNoteChanged } from '../core/noteEvents'

const routerFuture = { v7_relativeSplatPath: true, v7_startTransition: true } as const
const PLACEHOLDER = 'Capture a thought or paste a link…'

function open() {
  render(<MemoryRouter future={routerFuture}><FloatingQuickCapture /></MemoryRouter>)
  fireEvent.click(screen.getByLabelText('Quick capture'))
  return screen.getByPlaceholderText(PLACEHOLDER)
}

beforeEach(() => {
  vi.clearAllMocks()
  captureContext.value = { projectId: null, target: null }
  spaceState.memberCount = 3
})

describe('FloatingQuickCapture outside a Project', () => {
  it('offers the personal inbox only, and says so before anything is typed', () => {
    open()
    expect(screen.getByText('→ personal inbox · pending · only you')).toBeInTheDocument()
    // One destination is not a choice, so no control is offered for it.
    expect(screen.queryByRole('radiogroup')).toBeNull()
  })

  it('captures to the personal inbox independently of the Space being browsed', async () => {
    const box = open()
    fireEvent.change(box, { target: { value: 'A private thought' } })
    fireEvent.click(screen.getByRole('button', { name: 'Capture' }))
    await waitFor(() => expect(createCapture).toHaveBeenCalledWith({
      text: 'A private thought',
      destination: 'personal_inbox',
    }))
  })
})

describe('FloatingQuickCapture destination inference', () => {
  it('defaults hand-typed text to marginalia on the Area object', async () => {
    captureContext.value = { projectId: 'project-1', target: { objectId: 'thread-1', title: 'H3' } }
    const box = open()
    expect(screen.getByRole('radio', { name: 'marginalia on H3 · only you', checked: true })).toBeInTheDocument()
    fireEvent.change(box, { target: { value: 'the control group here is wrong' } })
    fireEvent.click(screen.getByRole('button', { name: 'Capture' }))
    await waitFor(() => expect(createCapture).toHaveBeenCalledWith({
      text: 'the control group here is wrong',
      destination: 'object_marginalia',
      project_id: 'project-1',
      target_id: 'thread-1',
    }))
  })

  it('defaults to project marginalia when the Area declares no object', () => {
    captureContext.value = { projectId: 'project-1', target: null }
    open()
    expect(screen.getByRole('radio', { name: 'project marginalia · only you', checked: true })).toBeInTheDocument()
  })

  it('defaults pasted text to project raw material, so external material is not privatised', async () => {
    captureContext.value = { projectId: 'project-1', target: { objectId: 'thread-1', title: 'H3' } }
    const box = open()
    fireEvent.paste(box)
    fireEvent.change(box, { target: { value: 'a passage a teammate sent' } })
    expect(screen.getByRole('radio', { name: 'project raw material · pending · team visible', checked: true })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Capture' }))
    await waitFor(() => expect(createCapture).toHaveBeenCalledWith({
      text: 'a passage a teammate sent',
      destination: 'project_raw',
      project_id: 'project-1',
    }))
  })

  it('defaults a typed URL to project raw material', () => {
    captureContext.value = { projectId: 'project-1', target: null }
    const box = open()
    fireEvent.change(box, { target: { value: 'https://example.com/paper' } })
    expect(screen.getByRole('radio', { name: 'project raw material · pending · team visible', checked: true })).toBeInTheDocument()
  })
})

describe('FloatingQuickCapture destination override', () => {
  it('lists all four destinations inside a Project and switches in one click', async () => {
    captureContext.value = { projectId: 'project-1', target: { objectId: 'thread-1', title: 'H3' } }
    const box = open()
    for (const option of [
      'marginalia on H3 · only you',
      'project marginalia · only you',
      'project raw material · pending · team visible',
      'personal inbox · pending · only you',
    ]) expect(screen.getByRole('radio', { name: option })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('radio', { name: 'personal inbox · pending · only you' }))
    fireEvent.change(box, { target: { value: 'unrelated thought' } })
    fireEvent.click(screen.getByRole('button', { name: 'Capture' }))
    await waitFor(() => expect(createCapture).toHaveBeenCalledWith({
      text: 'unrelated thought',
      destination: 'personal_inbox',
    }))
  })

  it('forgets the chosen destination after the capture, rather than remembering it', async () => {
    captureContext.value = { projectId: 'project-1', target: null }
    const box = open()
    fireEvent.click(screen.getByRole('radio', { name: 'project raw material · pending · team visible' }))
    fireEvent.change(box, { target: { value: 'first' } })
    fireEvent.click(screen.getByRole('button', { name: 'Capture' }))
    await waitFor(() => expect(createCapture).toHaveBeenCalledTimes(1))
    await waitFor(() =>
      expect(screen.getByRole('radio', { name: 'project marginalia · only you', checked: true })).toBeInTheDocument())
  })

  it('forgets an abandoned choice when the composer is closed', async () => {
    captureContext.value = { projectId: 'project-1', target: null }
    open()
    fireEvent.click(screen.getByRole('radio', { name: 'project raw material · pending · team visible' }))
    expect(screen.getByRole('radio', { name: 'project raw material · pending · team visible', checked: true })).toBeInTheDocument()
    fireEvent.click(screen.getByLabelText('Close quick capture'))
    fireEvent.click(screen.getByLabelText('Quick capture'))
    expect(screen.getByRole('radio', { name: 'project marginalia · only you', checked: true })).toBeInTheDocument()
  })
})

describe('FloatingQuickCapture in a single-member Space', () => {
  it('keeps the team wording until the Space list has actually loaded', () => {
    spaceState.memberCount = undefined
    captureContext.value = { projectId: 'project-1', target: null }
    open()
    // Missing data must not read as "no team here" — that understates sharing.
    expect(screen.getByRole('radio', { name: 'project marginalia · only you', checked: true })).toBeInTheDocument()
  })

  it('drops the team / mine wording while keeping the same destinations', () => {
    spaceState.memberCount = 1
    captureContext.value = { projectId: 'project-1', target: null }
    open()
    expect(screen.getByRole('radio', { name: 'project marginalia', checked: true })).toBeInTheDocument()
    expect(screen.getByRole('radio', { name: 'project raw material · pending' })).toBeInTheDocument()
    expect(screen.getByRole('radio', { name: 'personal inbox · pending' })).toBeInTheDocument()
  })
})

describe('FloatingQuickCapture announces the write', () => {
  it('tells the open surfaces which note changed, so nothing has to poll for it', async () => {
    captureContext.value = { projectId: 'project-1', target: null }
    createCapture.mockResolvedValueOnce({
      activity_id: 'activity-2',
      destination: 'project_marginalia',
      space_id: 'team-1',
      project_id: 'project-1',
      visibility: 'private',
      status: 'raw',
      note_id: 'note-9',
      note_title: 'Marginalia',
    })
    const heard = vi.fn()
    const stop = subscribeNoteChanged(heard)

    const box = open()
    fireEvent.change(box, { target: { value: 'a margin note' } })
    fireEvent.click(screen.getByRole('button', { name: 'Capture' }))

    await waitFor(() => expect(heard).toHaveBeenCalledWith({
      noteId: 'note-9',
      projectId: 'project-1',
      reason: 'capture',
    }))
    stop()
  })

  it('stays quiet when the capture landed in the inbox rather than a note', async () => {
    const heard = vi.fn()
    const stop = subscribeNoteChanged(heard)

    const box = open()
    fireEvent.change(box, { target: { value: 'a private thought' } })
    fireEvent.click(screen.getByRole('button', { name: 'Capture' }))

    await waitFor(() => expect(createCapture).toHaveBeenCalledTimes(1))
    expect(heard).not.toHaveBeenCalled()
    stop()
  })
})
