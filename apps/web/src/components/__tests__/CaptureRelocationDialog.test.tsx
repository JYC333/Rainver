import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'

const { relocationPreview, relocate } = vi.hoisted(() => ({
  relocationPreview: vi.fn(),
  relocate: vi.fn().mockResolvedValue({}),
}))

vi.mock('../../api/client', () => ({
  captureApi: { relocationPreview, relocate },
}))

import { CaptureRelocationDialog } from '../CaptureRelocationDialog'

const preview = {
  activity_id: 'activity-1',
  note_id: 'note-1',
  blocks: [
    { block_id: 'anchor', text: 'The control group is wrong.', anchored: true },
    { block_id: 'orphan-1', text: 'because the baseline drifted', anchored: false },
  ],
  can_move: true,
  can_copy_out: false,
}

function open(overrides: Partial<typeof preview> = {}, projectId: string | null = 'project-1') {
  relocationPreview.mockResolvedValue({ ...preview, ...overrides })
  render(
    <CaptureRelocationDialog
      activityId="activity-1"
      projectId={projectId}
      open
      onOpenChange={() => {}}
    />,
  )
}

beforeEach(() => vi.clearAllMocks())

describe('CaptureRelocationDialog', () => {
  it('preselects the anchored block and leaves the orphans for the user to decide', async () => {
    open()
    await screen.findByText('The control group is wrong.')

    const boxes = screen.getAllByRole('checkbox') as HTMLInputElement[]
    expect(boxes[0].checked).toBe(true)
    expect(boxes[1].checked).toBe(false)
  })

  it('carries only the checked blocks', async () => {
    open()
    await screen.findByText('because the baseline drifted')
    fireEvent.click(screen.getAllByRole('checkbox')[1]!)
    fireEvent.click(screen.getByRole('button', { name: 'Move' }))

    await waitFor(() => expect(relocate).toHaveBeenCalledWith('activity-1', {
      destination: 'project_raw',
      mode: 'move',
      block_ids: ['anchor', 'orphan-1'],
      project_id: 'project-1',
    }))
  })

  it('refuses a copy out and says why when the Space forbids it', async () => {
    open({ can_move: false, can_copy_out: false })
    await screen.findByText('The control group is wrong.')
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'personal_inbox' } })

    expect(await screen.findByText(/does not allow copying content/i)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Copy' })).toBeDisabled()
    expect(relocate).not.toHaveBeenCalled()
  })

  it('discloses that a copy out is announced to the other members', async () => {
    open({ can_move: false, can_copy_out: true })
    await screen.findByText('The control group is wrong.')
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'personal_inbox' } })

    // ADR 0013 decision 11: disclosed before the action, not after it.
    expect(await screen.findByText(/other members are told it left/i)).toBeInTheDocument()
  })
})
