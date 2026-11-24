import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import ErrorBoundary from './ErrorBoundary'
import { isModuleLoadFailure } from './ModuleLoadFailure'

const version = vi.hoisted(() => ({
  currentBuild: { id: 'running', builtAt: '' },
  fetchLatestBuild: vi.fn(),
  reloadLatestBuild: vi.fn(),
}))
vi.mock('../modules/settings/appVersion', () => version)

const reload = vi.fn()
function Broken({ message }: { message: string }): never { throw new TypeError(message) }
const failedImport = 'Failed to fetch dynamically imported module: https://rainver.test/assets/ProjectFilesPage-abc12345.js'

async function renderFailure(message = failedImport) {
  render(<ErrorBoundary><Broken message={message} /></ErrorBoundary>)
  await act(async () => {})
}

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {})
  vi.stubGlobal('location', { ...window.location, reload })
  version.fetchLatestBuild.mockReset()
  version.reloadLatestBuild.mockReset().mockResolvedValue(undefined)
  reload.mockReset()
})
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

describe('module load failures', () => {
  it('recognises each engine’s failed dynamic import, not other errors', () => {
    expect(isModuleLoadFailure(new TypeError(failedImport))).toBe(true)
    expect(isModuleLoadFailure(new TypeError('Importing a module script failed.'))).toBe(true)
    expect(isModuleLoadFailure(new TypeError('error loading dynamically imported module: /assets/x.js'))).toBe(true)
    expect(isModuleLoadFailure(new Error('Unable to preload CSS for /assets/x.css'))).toBe(true)
    expect(isModuleLoadFailure(new Error('Failed to fetch'))).toBe(false)
    expect(isModuleLoadFailure('Importing a module script failed.')).toBe(false)
  })

  it('offers the update when a newer build replaced this tab’s, and reloads only on request', async () => {
    version.fetchLatestBuild.mockResolvedValue({ id: 'newer', builtAt: '' })
    await renderFailure()
    expect(screen.getByRole('status')).toHaveTextContent('Rainver was updated after this tab opened')
    expect(screen.queryByText('Try again')).not.toBeInTheDocument()
    expect(version.reloadLatestBuild).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Update and reload' }))
    expect(version.reloadLatestBuild).toHaveBeenCalledOnce()
    expect(reload).not.toHaveBeenCalled()
  })

  it('staying at the unsaved-input prompt keeps the panel and its update for another try', async () => {
    version.fetchLatestBuild.mockResolvedValue({ id: 'newer', builtAt: '' })
    version.reloadLatestBuild.mockResolvedValue('kept')
    await renderFailure()
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Update and reload' })) })
    expect(screen.getByRole('status')).toHaveTextContent('Reload cancelled. Your unsaved input is still on this page')
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Update and reload' })) })
    expect(version.reloadLatestBuild).toHaveBeenCalledTimes(2)
  })

  it('does not reload when the server is unreachable; checking again can then offer a reload', async () => {
    version.fetchLatestBuild.mockRejectedValueOnce(new TypeError('Failed to fetch'))
    await renderFailure('Importing a module script failed.')
    expect(screen.getByRole('status')).toHaveTextContent('the server cannot be reached')
    expect(screen.queryByRole('button', { name: /reload/i })).not.toBeInTheDocument()
    version.fetchLatestBuild.mockResolvedValue({ id: 'running', builtAt: '' })
    fireEvent.click(screen.getByRole('button', { name: 'Check again' }))
    await act(async () => {})
    expect(screen.getByRole('status')).toHaveTextContent('The download was interrupted')
    expect(reload).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Reload this tab' }))
    expect(reload).toHaveBeenCalledOnce()
    expect(version.reloadLatestBuild).not.toHaveBeenCalled()
  })

  it('keeps the existing panel and retry for other render errors', async () => {
    await renderFailure('Cannot read properties of undefined')
    expect(screen.getByText('Cannot read properties of undefined')).toBeInTheDocument()
    expect(screen.getByText('Try again')).toBeInTheDocument()
    expect(version.fetchLatestBuild).not.toHaveBeenCalled()
  })
})
