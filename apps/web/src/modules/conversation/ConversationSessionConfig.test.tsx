import { useState } from 'react'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { ConversationAgentConfiguration, ConversationAgentSessionConfigs, SavedConversationSessionConfig, type SessionConfigSelection } from './ConversationSessionConfig'
import { RunModelLabel } from './RunModelLabel'

const initial: SessionConfigSelection[] = [{ id: 'fast', type: 'boolean', category: 'model_config', value: false }]
function Editor({ save, persisted }: { save: (value: SessionConfigSelection[]) => Promise<void>; persisted?: SessionConfigSelection[] }) {
  const [value, setValue] = useState(initial)
  return <SavedConversationSessionConfig
    options={[{ id: 'fast', name: 'Fast mode', description: null, type: 'boolean', category: 'model_config', current_value: false }]}
    value={value} onChange={setValue} onSave={save} persistedValue={persisted} />
}

describe('explicit conversation settings', () => {
  it('defaults model switching off, saves explicit consent and reads it back', async () => {
    const save = vi.fn().mockResolvedValue(undefined)
    const view = render(<SavedConversationSessionConfig options={[]} value={[]} onChange={vi.fn()} onSave={save}
      persistedValue={[]} quotaModelSwitchAvailable />)
    const checkbox = screen.getByRole('checkbox', { name: /Automatically switch models/ })
    expect(checkbox).not.toBeChecked()
    fireEvent.click(checkbox)
    expect(save).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(save).toHaveBeenCalledWith([], true))
    view.unmount()
    render(<SavedConversationSessionConfig options={[]} value={[]} onChange={vi.fn()} onSave={save}
      persistedValue={[]} quotaModelSwitchAvailable allowQuotaModelSwitch />)
    expect(screen.getByRole('checkbox')).toBeChecked()
    expect(screen.queryByRole('button', { name: 'Save' })).not.toBeInTheDocument()
  })
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
    await waitFor(() => expect(screen.queryByRole('status')).not.toBeInTheDocument())
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
    await waitFor(() => expect(screen.queryByRole('status')).not.toBeInTheDocument())
    expect(save).toHaveBeenCalledTimes(2)
  })

  it('says when a saved choice is no longer offered by the runtime', () => {
    render(<Editor save={vi.fn()} persisted={[{ id: 'model', type: 'select', category: 'model', value: 'retired' }]} />)
    expect(screen.getByRole('note')).toHaveTextContent('Saved model “retired” is no longer offered by this runtime')
  })

  it('shows server readback as saved after reload', () => {
    render(<Editor save={vi.fn()} persisted={initial} />)
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Save' })).not.toBeInTheDocument()
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

const modelOptions = [{ id: 'model', name: 'Model', description: null, category: 'model', type: 'select' as const, current_value: 'default',
  options: [{ value: 'default', name: 'Default model', description: null, group: null }, { value: 'saved', name: 'Saved model', description: null, group: null }] }]
const agentConfig = { id: 'agent', name: 'Assistant', options: modelOptions, value: [{ id: 'model', type: 'select' as const, category: 'model', value: 'default' }], onChange: vi.fn() }
it('shows the participant count even without parameters, and expands only the selected Agent', () => {
  render(<ConversationAgentSessionConfigs agents={[agentConfig, { ...agentConfig, id: 'reviewer', name: 'Reviewer', options: [] }]} />)
  fireEvent.click(screen.getByRole('button', { name: 'Conversation settings · 2' }))
  expect(screen.getByRole('dialog', { name: 'Conversation settings' })).toBeVisible()
  expect(screen.getByText('Reviewer')).toBeVisible()
  expect(screen.getByRole('button', {name:'Model'})).toBeVisible()
  const model = screen.getByRole('button', { name: 'Model' })
  fireEvent.click(screen.getByRole('button', { name: 'Other parameters · Assistant' }))
  expect(screen.getByRole('button', { name: 'Model' })).toBe(model)
})
it('keeps the entry visible for a parameterless direct conversation', () => {
  render(<ConversationAgentSessionConfigs agents={[{...agentConfig, options: []}]} />)
  expect(screen.getByRole('button', {name: 'Conversation settings · 1'})).toBeVisible()
})

it.each(['running', 'no save', 'catalog error', 'empty options'])('allows local discard with %s', reason => {
  const discard = vi.fn()
  render(<ConversationAgentConfiguration disabled={reason === 'running'} agent={{ ...agentConfig,
    options: reason === 'empty options' || reason === 'catalog error' ? [] : modelOptions,
    unavailableReason: reason === 'catalog error' ? 'Catalog failed' : undefined,
    status: 'unsaved', onSave: reason === 'running' ? vi.fn() : undefined, onDiscard: discard, draftAllowQuotaModelSwitch: true,
  }} />)
  fireEvent.click(screen.getByRole('button', { name: 'Other parameters · Assistant' }))
  expect(screen.getByRole('button', { name: 'Discard changes' })).toBeEnabled()
  expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled()
  fireEvent.click(screen.getByRole('button', { name: 'Discard changes' }))
  expect(discard).toHaveBeenCalledOnce()
})
it('prevents discard while saving and exposes only read recovery after a committed save', async () => {
  const discard = vi.fn(), reload = vi.fn()
  const view = render(<SavedConversationSessionConfig options={[]} value={[]} onChange={vi.fn()} status="saving" onDiscard={discard} />)
  expect(screen.getByRole('button', { name: 'Discard changes' })).toBeDisabled()
  view.rerender(<SavedConversationSessionConfig options={[]} value={[]} onChange={vi.fn()} status="failed" disabled refreshRequired onSave={reload} onDiscard={discard} />)
  expect(screen.queryByRole('button', { name: 'Discard changes' })).not.toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: 'Refresh saved settings' }))
  await waitFor(() => expect(reload).toHaveBeenCalledOnce())
  expect(discard).not.toHaveBeenCalled()
})

it('does not report a valid model as withdrawn when the other parameters are expanded', () => {
  render(<ConversationAgentConfiguration defaultExpanded agent={{...agentConfig,
    persistedValue: agentConfig.value, quotaModelSwitchAvailable: true, status: 'saved', onSave: vi.fn(),
  }} />)
  expect(screen.getByRole('button', { name: 'Model' })).toHaveTextContent('Default model')
  expect(screen.queryByText(/no longer offered/)).not.toBeInTheDocument()
  expect(screen.queryByRole('button', { name: 'Save' })).not.toBeInTheDocument()
})

it('opens parameters from the Agent name but keeps model and Remove clicks independent', async () => {
  const removed = vi.fn()
  render(<ConversationAgentConfiguration agent={{...agentConfig, onSave:vi.fn()}}
    actions={<button onClick={removed}>Remove</button>} />)
  const disclosure = screen.getByRole('button', {name:'Other parameters · Assistant'})
  expect(disclosure).toHaveAttribute('aria-expanded','false')
  fireEvent.click(screen.getByText('Assistant', {exact:true}))
  expect(disclosure).toHaveAttribute('aria-expanded','true')
  fireEvent.click(screen.getByRole('button', {name:'Model'}))
  expect(disclosure).toHaveAttribute('aria-expanded','true')
  fireEvent.click(await screen.findByRole('option', {name:'Saved model'}))
  expect(disclosure).toHaveAttribute('aria-expanded','true')
  fireEvent.click(screen.getByRole('button', {name:'Remove'}))
  expect(removed).toHaveBeenCalledOnce()
  expect(disclosure).toHaveAttribute('aria-expanded','true')
  fireEvent.click(disclosure)
  expect(disclosure).toHaveAttribute('aria-expanded','false')
})
