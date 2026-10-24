import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { AppVersionPanel } from '../AppVersionPanel'
import { fetchLatestBuild, reloadLatestBuild } from '../appVersion'
vi.mock('../appVersion', () => ({ currentBuild: { id: 'build-a', builtAt: '' }, fetchLatestBuild: vi.fn(), reloadLatestBuild: vi.fn(), readLayoutDiagnostics: () => ({ build: 'build-a' }) }))
beforeEach(() => vi.clearAllMocks())
describe('application version', () => {
  it('shows the running build and confirms only a successful matching response', async () => {
    vi.mocked(fetchLatestBuild).mockResolvedValue({ id: 'build-a', builtAt: '' })
    render(<AppVersionPanel />)
    expect(screen.getByText('build-a')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Check for updates' }))
    await screen.findByText('This page matches the build currently served by this address.')
    expect(screen.queryByRole('button', { name: 'Update and reload' })).not.toBeInTheDocument()
  })
  it('offers reload for a different build, only applying it on explicit click', async () => {
    vi.mocked(fetchLatestBuild).mockResolvedValue({ id: 'build-b', builtAt: '' })
    render(<AppVersionPanel />)
    fireEvent.click(screen.getByRole('button', { name: 'Check for updates' }))
    const update = await screen.findByRole('button', { name: 'Update and reload' })
    expect(reloadLatestBuild).not.toHaveBeenCalled()
    fireEvent.click(update)
    await waitFor(() => expect(reloadLatestBuild).toHaveBeenCalledOnce())
  })
  it('does not claim the page is current when the network check fails', async () => {
    vi.mocked(fetchLatestBuild).mockRejectedValue(new Error('offline'))
    render(<AppVersionPanel />)
    fireEvent.click(screen.getByRole('button', { name: 'Check for updates' }))
    await screen.findByText('Could not verify or apply the update. Check your connection and retry.')
    expect(screen.queryByText('This page matches the build currently served by this address.')).not.toBeInTheDocument()
  })
})
