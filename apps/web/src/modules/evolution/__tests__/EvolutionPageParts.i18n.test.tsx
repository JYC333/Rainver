import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setLocale } from '../../../i18n'
import { StatusBadge } from '../../../components/ui/badge'
import type { EvolutionTarget } from '../../../types/api'
import { OverviewCards, SignalDialog, TargetConfigDialog, TargetList } from '../EvolutionPageParts'

describe('Evolution page language', () => {
  beforeEach(() => act(() => setLocale('en')))
  afterEach(() => act(() => setLocale('en')))

  it('updates the overview when the browser language changes', () => {
    render(<OverviewCards summary={{
      active_targets: 2,
      signals_collected: 3,
      pending_proposals: 1,
      recent_runs: 4,
    }} />)

    expect(screen.getByText('Improvement targets')).toBeInTheDocument()
    expect(screen.getByText('Trigger signals')).toBeInTheDocument()

    act(() => setLocale('zh-CN'))

    expect(screen.getByText('改进目标')).toBeInTheDocument()
    expect(screen.getByText('触发信号')).toBeInTheDocument()
  })

  it('localizes a target status without changing the shared badge or target ID', async () => {
    const onSelect = vi.fn()
    const user = userEvent.setup({ delay: null })
    render(<StatusBadge status="paused" />)
    render(<TargetList
      targets={[{
        id: 'target-1',
        target_name: 'Example',
        target_type: 'agent_version',
        risk_level: 'medium',
        enabled: true,
        status: 'paused',
        recent_signal_count: 0,
        capability_key: 'example',
      } as EvolutionTarget]}
      selectedTargetId={null}
      onSelect={onSelect}
      onConfigure={vi.fn()}
    />)

    expect(screen.getByText('paused')).toBeInTheDocument()
    expect(screen.getByText('Paused')).toBeInTheDocument()

    act(() => setLocale('zh-CN'))

    expect(screen.getByText('paused')).toBeInTheDocument()
    expect(screen.getByText('暂停')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: /Example/ }))
    expect(onSelect).toHaveBeenCalledWith('target-1')
  })

  it('keeps the signal wire value when the dialog language changes', async () => {
    const onSubmit = vi.fn()
    const user = userEvent.setup({ delay: null })
    render(<SignalDialog
      open
      target={{ target_name: 'Example' } as EvolutionTarget}
      saving={false}
      onOpenChange={vi.fn()}
      onSubmit={onSubmit}
    />)

    expect(screen.getByText('Runtime failure')).toBeInTheDocument()
    act(() => setLocale('zh-CN'))
    expect(screen.getByText('运行失败')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: '保存信号' }))
    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({
      signal_type: 'runtime_failure',
      source_type: 'manual',
      severity: 'medium',
    }))
  })

  it('clears the last constraint of an edited target rather than leaving it to the server merge', async () => {
    const onSubmit = vi.fn(async () => {})
    render(<TargetConfigDialog
      open
      mode="edit"
      target={{
        id: 'target-1', target_name: 'Example', target_type: 'agent_version', risk_level: 'medium',
        enabled: true, status: 'active', engine_policy_json: {},
        metadata_json: { constraints: ['Do not change the tone'] },
      } as unknown as EvolutionTarget}
      saving={false}
      onOpenChange={vi.fn()}
      onSubmit={onSubmit}
    />)

    fireEvent.change(screen.getByDisplayValue('Do not change the tone'), { target: { value: '' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save target' }))

    // The server merges metadata shallowly: an absent key keeps its old value.
    await waitFor(() => expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({ metadata_json: expect.objectContaining({ constraints: [] }) }),
      'edit',
    ))
  })
})
