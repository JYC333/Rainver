import { useState } from 'react'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { SavedConversationSessionConfig, type SessionConfigSelection } from './ConversationSessionConfig'
import { RunModelLabel } from './RunModelLabel'

const initial: SessionConfigSelection[] = [{ id: 'fast', type: 'boolean', category: 'model_config', value: false }]
function Editor({ save, persisted }: { save: (value: SessionConfigSelection[]) => Promise<void>; persisted?: SessionConfigSelection[] }) {
  const [value, setValue] = useState(initial)
  return <SavedConversationSessionConfig
    options={[{ id: 'fast', name: 'Fast mode', description: null, type: 'boolean', category: 'model_config', current_value: false }]}
    value={value} onChange={setValue} onSave={save} persistedValue={persisted} />
}

describe('explicit conversation settings', () => {
  it('shows unsaved, saving and confirmed saved states', async () => {
    let finish!: () => void
    const save = vi.fn(() => new Promise<void>(resolve => { finish = resolve }))
    render(<Editor save={save} />)
    expect(screen.getByRole('status')).toHaveTextContent('Not saved')
    fireEvent.click(screen.getByRole('switch', { name: 'Fast mode' }))
    expect(save).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(save).toHaveBeenCalledWith([{ ...initial[0], value: true }])
    expect(screen.getByRole('button', { name: 'Saving…' })).toBeDisabled()
    finish()
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Saved · applies to future runs'))
    fireEvent.click(screen.getByRole('switch', { name: 'Fast mode' }))
    expect(screen.getByRole('status')).toHaveTextContent('Not saved')
  })

  it('shows a failed save and allows retry without losing the choice', async () => {
    const save = vi.fn().mockRejectedValueOnce(new Error('Connection failed')).mockResolvedValueOnce(undefined)
    render(<Editor save={save} />)
    fireEvent.click(screen.getByRole('switch', { name: 'Fast mode' }))
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Connection failed')
    expect(screen.getByRole('switch', { name: 'Fast mode' })).toHaveAttribute('aria-checked', 'true')
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Saved · applies to future runs'))
    expect(save).toHaveBeenCalledTimes(2)
  })

  it('says when a saved choice is no longer offered by the runtime', () => {
    render(<Editor save={vi.fn()} persisted={[{ id: 'model', type: 'select', category: 'model', value: 'retired' }]} />)
    expect(screen.getByRole('note')).toHaveTextContent('Saved model “retired” is no longer offered by this runtime')
  })

  it('shows server readback as saved after reload', () => {
    render(<Editor save={vi.fn()} persisted={initial} />)
    expect(screen.getByRole('status')).toHaveTextContent('Saved · applies to future runs')
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled()
  })
})

describe('model identity display', () => {
  it('never presents the requested model as the observed model', () => {
    const { rerender } = render(<RunModelLabel model={{ requested: 'ops', reported: null, status: 'pending' }} />)
    expect(screen.getByText('Requested model: ops')).toBeInTheDocument()
    expect(screen.getByText('Runtime-reported model: Pending confirmation')).toBeInTheDocument()
    rerender(<RunModelLabel model={{ requested: 'ops', reported: null, status: 'unknown' }} />)
    expect(screen.getByText('Runtime-reported model: Unknown')).toBeInTheDocument()
    rerender(<RunModelLabel model={{ requested: 'ops', reported: 'canonical-ops', status: 'reported' }} />)
    expect(screen.getByText('Runtime-reported model: canonical-ops')).toBeInTheDocument()
    rerender(<RunModelLabel model={{ requested: null, reported: 'opus', status: 'reported',
      dropped: [{ id: 'model', category: 'model', value: 'retired', reason: 'value_unavailable' }] }} />)
    expect(screen.getByText('Requested model: Runtime default')).toBeInTheDocument()
    expect(screen.getByRole('status')).toHaveTextContent('Saved model “retired” is no longer offered by this runtime; this run used the runtime default.')
  })
})
