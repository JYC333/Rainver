import { act, fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { UpdateNotAppliedNotice } from './UpdateNotAppliedNotice'

const version = vi.hoisted(() => {
  const listeners = new Set<() => void>()
  const state = { shown: false }
  const set = (on: boolean) => { state.shown = on; for (const listener of listeners) listener() }
  return {
    set,
    readUpdateNotApplied: () => state.shown,
    subscribeUpdateNotApplied: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } },
    dismissUpdateNotApplied: vi.fn(() => set(false)),
    reloadLatestBuild: vi.fn(),
  }
})
vi.mock('../modules/settings/appVersion', () => version)

beforeEach(() => { version.set(false); version.reloadLatestBuild.mockReset() })

describe('update not applied after reload', () => {
  it('appears only when the requested update could not be activated, and retries only on request', async () => {
    render(<UpdateNotAppliedNotice />)
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    act(() => version.set(true))
    expect(screen.getByRole('alert')).toHaveTextContent('still on its previous version')
    expect(version.reloadLatestBuild).not.toHaveBeenCalled()
    version.reloadLatestBuild.mockRejectedValueOnce(new Error('Update timed out'))
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Update and reload' })) })
    expect(screen.getByRole('status')).toHaveTextContent('Could not verify or apply the update')
    version.reloadLatestBuild.mockResolvedValueOnce('kept')
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Update and reload' })) })
    expect(screen.getByRole('status')).toHaveTextContent('Reload cancelled')
    expect(version.reloadLatestBuild).toHaveBeenCalledTimes(2)
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }))
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })
})
