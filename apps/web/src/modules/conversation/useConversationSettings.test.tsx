import { useState } from 'react'
import { act, renderHook } from '@testing-library/react'
import { expect, it, vi } from 'vitest'
import { useConversationSettings } from './useConversationSettings'
import type { AgentSessionConfiguration } from './ConversationSessionConfig'

const agent: AgentSessionConfiguration = { id: 'a', name: 'Agent', options: [], value: [], persistedValue: [], onChange: vi.fn() }
it('keeps consent and save failure across closed dialogs, blocks sends, and explicitly discards', async () => {
  const save = vi.fn().mockRejectedValue(new Error('Save refused'))
  const { result, rerender } = renderHook(({ identity }) => {
    const settings = useConversationSettings(identity)
    return { ...settings, agents: settings.configure([{ ...agent, onSave: save }]) }
  }, { initialProps: { identity: 'session-a' } })
  act(() => result.current.agents[0].onQuotaChange!(true))
  expect(result.current.agents[0].status).toBe('unsaved')
  act(() => { expect(result.current.beforeSend()).toBe(false) })
  expect(result.current.open).toBe(true)
  act(() => result.current.onOpenChange(false))
  expect(result.current.agents[0].draftAllowQuotaModelSwitch).toBe(true)
  await act(async () => { await expect(result.current.agents[0].onSave!([], true)).rejects.toThrow('Save refused') })
  expect(result.current.agents[0].status).toBe('failed')
  expect(result.current.agents[0].error).toBe('Save refused')
  act(() => result.current.onOpenChange(false))
  act(() => { expect(result.current.beforeSend()).toBe(false) })
  act(() => result.current.agents[0].onDiscard!())
  expect(result.current.agents[0].draftAllowQuotaModelSwitch).toBe(false)
  expect(result.current.beforeSend()).toBe(true)
  act(() => result.current.agents[0].onQuotaChange!(true))
  rerender({ identity: 'session-b' })
  expect(result.current.agents[0].status).toBe('saved')
  expect(result.current.agents[0].draftAllowQuotaModelSwitch).toBe(false)
  expect(result.current.open).toBe(false)
  expect(save).toHaveBeenCalledTimes(1)
})
it('does not let a late save failure restore a previous scope draft', async () => {
  let reject!: (error: Error) => void
  const { result, rerender } = renderHook(({ identity }) => {
    const settings = useConversationSettings(identity)
    return settings.configure([{ ...agent, onSave: () => new Promise<void>((_, fail) => { reject = fail }) }])
  }, { initialProps: { identity: 'member' } })
  let pending!: Promise<void>
  act(() => { pending = result.current[0].onSave!([]).catch(() => {}) })
  rerender({ identity: 'viewer' })
  rerender({ identity: 'member' })
  await act(async () => { reject(new Error('old failure')); await pending })
  expect(result.current[0].error).toBeUndefined()
  expect(result.current[0].status).toBe('saved')
})
it('recovers committed settings with reads only, including another failed read', async () => {
  const save = vi.fn().mockRejectedValue(Object.assign(new Error('Read failed'), { settingsSaved: true }))
  const reload = vi.fn().mockRejectedValueOnce(new DOMException('Conversation scope changed', 'AbortError'))
    .mockRejectedValueOnce(new Error('Still unavailable')).mockResolvedValue(undefined)
  const { result } = renderHook(() => {
    const settings = useConversationSettings('session')
    return { ...settings, agent: settings.configure([{ ...agent, onSave: save, onReload: reload }])[0] }
  })
  await act(async () => { await result.current.agent.onSave!([]).catch(() => {}) })
  expect(result.current.agent.refreshRequired).toBe(true)
  act(() => { expect(result.current.beforeSend()).toBe(false) })
  await act(async () => { await result.current.agent.onSave!([]).catch(() => {}) })
  expect(result.current.agent.refreshRequired).toBe(true)
  await act(async () => { await result.current.agent.onSave!([]).catch(() => {}) })
  expect(result.current.agent.refreshRequired).toBe(true)
  await act(async () => { await result.current.agent.onSave!([]) })
  expect(result.current.agent.refreshRequired).toBe(false)
  expect(result.current.beforeSend()).toBe(true)
  expect(save).toHaveBeenCalledTimes(1)
  expect(reload).toHaveBeenCalledTimes(3)
})

it('discards consent without save authority but preserves committed read obligations', async () => {
  const save = vi.fn().mockRejectedValue(Object.assign(new Error('Read failed'), { settingsSaved: true }))
  const reload = vi.fn().mockResolvedValue(undefined)
  const { result, rerender } = renderHook(({ writable }) => {
    const settings = useConversationSettings('session')
    return { ...settings, agent: settings.configure([{ ...agent, onSave: writable ? save : undefined, onReload: reload }])[0] }
  }, { initialProps: { writable: true } })
  act(() => result.current.agent.onQuotaChange!(true))
  rerender({ writable: false })
  act(() => result.current.agent.onDiscard!())
  expect(result.current.agent.draftAllowQuotaModelSwitch).toBe(false)
  expect(result.current.beforeSend()).toBe(true)
  expect(save).not.toHaveBeenCalled()
  rerender({ writable: true })
  await act(async () => { await result.current.agent.onSave!([], true).catch(() => {}) })
  rerender({ writable: false })
  act(() => result.current.agent.onDiscard!())
  expect(result.current.agent.refreshRequired).toBe(true)
  act(() => { expect(result.current.beforeSend()).toBe(false) })
  await act(async () => { await result.current.agent.onSave!([]) })
  expect(result.current.beforeSend()).toBe(true)
  expect(save).toHaveBeenCalledOnce()
  expect(reload).toHaveBeenCalledOnce()
})

it('cannot discard quota consent during a real pending save', async () => {
  let finish!: () => void
  const change = vi.fn()
  const { result } = renderHook(() => {
    const settings = useConversationSettings('saving')
    return settings.configure([{ ...agent, onChange: change,
      onSave: () => new Promise<void>(resolve => { finish = resolve }) }])[0]
  })
  act(() => result.current.onQuotaChange!(true))
  let saving!: Promise<void>
  act(() => { saving = result.current.onSave!([], true) })
  act(() => result.current.onDiscard!())
  expect(result.current.status).toBe('saving')
  expect(result.current.draftAllowQuotaModelSwitch).toBe(true)
  expect(change).not.toHaveBeenCalled()
  await act(async () => { finish(); await saving })
})

const model = (value: string) => ({ id: 'model', category: 'model', type: 'select' as const, value })
const approval = (value: string) => ({ id: 'approval', category: 'mode', type: 'select' as const, value })
const options = [
  { id: 'model', category: 'model', type: 'select' as const, name: 'Model', description: null, current_value: 'old',
    options: ['old', 'new'].map(value => ({ value, name: value, description: null, group: null })) },
  { id: 'approval', category: 'mode', type: 'select' as const, name: 'Approval', description: null, current_value: 'ask',
    options: ['ask', 'never'].map(value => ({ value, name: value, description: null, group: null })) },
]
it('autosaves only model against the persisted baseline, preserving consent and other drafts through read recovery', async () => {
  const save = vi.fn().mockRejectedValue(Object.assign(new Error('read failed'), { settingsSaved: true }))
  const reload = vi.fn().mockResolvedValue([model('new'), approval('ask')])
  const change = vi.fn()
  const { result } = renderHook(() => {
    const settings = useConversationSettings('scope')
    return { ...settings, agent: settings.configure([{ ...agent, options, value: [model('old'), approval('never')],
      persistedValue: [model('old'), approval('ask')], onChange: change, onSave: save, onReload: reload }])[0] }
  })
  act(() => result.current.agent.onQuotaChange!(true))
  await act(async () => result.current.agent.onModelChange!([model('new'), approval('never')]))
  expect(save).toHaveBeenCalledWith([approval('ask'), model('new')], undefined)
  expect(result.current.agent.refreshRequired).toBe(true)
  expect(result.current.agent.draftAllowQuotaModelSwitch).toBe(true)
  await act(async () => { await result.current.agent.onSave!([]) })
  expect(save).toHaveBeenCalledOnce()
  expect(change).toHaveBeenLastCalledWith([model('new'), approval('never')])
  expect(result.current.agent.draftAllowQuotaModelSwitch).toBe(true)
})

it('blocks synchronous reentry and sending, and ignores completion after scope changes', async () => {
  let finish!: (value: typeof agent.value) => void
  const save = vi.fn(() => new Promise<typeof agent.value>(resolve => { finish = resolve }))
  const change = vi.fn()
  const { result, rerender } = renderHook(({ identity }) => {
    const settings = useConversationSettings(identity)
    return { ...settings, agent: settings.configure([{ ...agent, options, value: [model('old')], onChange: change, onSave: save }])[0] }
  }, { initialProps: { identity: 'a' } })
  act(() => {
    result.current.agent.onModelChange!([model('new')])
    result.current.agent.onModelChange!([model('old')])
    expect(result.current.beforeSend()).toBe(false)
  })
  expect(save).toHaveBeenCalledOnce()
  act(() => result.current.onOpenChange(false))
  expect(result.current.agent.status).toBe('saving')
  rerender({ identity: 'b' })
  await act(async () => finish([model('new')]))
  expect(change).toHaveBeenCalledOnce()
  expect(result.current.agent.modelPending).toBe(false)
})

it('first-message model selection changes only the draft and never saves a nonexistent session', () => {
  const save = vi.fn(), change = vi.fn()
  const { result } = renderHook(() => {
    const settings = useConversationSettings('new')
    return { ...settings, agent: settings.configure([{ ...agent, beforeFirstSend: true, options, onChange: change, onSave: save }])[0] }
  })
  act(() => result.current.agent.onModelChange!([model('new')]))
  expect(change).toHaveBeenCalledWith([model('new')])
  expect(save).not.toHaveBeenCalled()
  expect(result.current.beforeSend()).toBe(true)
})

it('merges confirmed server values and overlays only genuinely dirty non-model fields', async () => {
  const change = vi.fn()
  const save = vi.fn().mockResolvedValue([model('new'), approval('never')])
  const { result } = renderHook(() => {
    const settings = useConversationSettings('scope')
    return settings.configure([{...agent, options, persistedValue:[model('old'), approval('ask')],
      value:[model('old'), approval('ask')], onChange:change, onSave:save}])[0]
  })
  await act(async () => result.current.onModelChange!([model('new'), approval('ask')]))
  expect(change).toHaveBeenLastCalledWith([model('new'), approval('never')])
})

it('compares non-terminal select and boolean choices by semantics, without hiding real edits', async () => {
  const fast = (value: boolean) => ({ id: 'fast', type: 'boolean' as const, category: 'model_config', value })
  const configOptions = [...options, { id: 'fast', name: 'Fast', description: null, type: 'boolean' as const, category: 'model_config', current_value: false }]
  const initial: AgentSessionConfiguration['value'] = [approval('ask'), fast(false), model('old')]
  const { result } = renderHook(() => {
    const [value, setValue] = useState(initial)
    const [persisted, setPersisted] = useState(initial)
    const settings = useConversationSettings('semantic')
    return { ...settings, agent: settings.configure([{ ...agent, options: configOptions, value, persistedValue: persisted,
      onChange: setValue, onSave: async next => { setPersisted([...next].reverse()); setValue(next); return next } }])[0] }
  })
  act(() => result.current.agent.onChange([fast(false), model('old'), approval('never')]))
  expect(result.current.agent.status).toBe('unsaved')
  act(() => result.current.agent.onChange([fast(false), model('old'), approval('ask')]))
  expect(result.current.agent.status).toBe('saved')
  act(() => result.current.agent.onChange([model('old'), approval('ask'), fast(true)]))
  expect(result.current.beforeSend()).toBe(false)
  act(() => result.current.agent.onChange([model('old'), approval('ask'), fast(false)]))
  expect(result.current.agent.status).toBe('saved')
  act(() => result.current.agent.onChange([model('old'), approval('never'), fast(true)]))
  act(() => result.current.agent.onQuotaChange!(true))
  await act(async () => result.current.agent.onModelChange!([approval('never'), fast(true), model('new')]))
  expect(result.current.agent.value).toEqual([model('new'), approval('never'), fast(true)])
  expect(result.current.agent.status).toBe('unsaved')
  expect(result.current.agent.draftAllowQuotaModelSwitch).toBe(true)
  act(() => result.current.agent.onDiscard!())
  expect(result.current.agent.value).toEqual([model('new'), approval('ask'), fast(false)])
  expect(result.current.agent.status).toBe('saved')
  act(() => result.current.agent.onChange([model('new'), fast(false), approval('never')]))
  await act(async () => { await result.current.agent.onSave!(result.current.agent.value) })
  expect(result.current.agent.status).toBe('saved')
  expect(result.current.beforeSend()).toBe(true)
})
