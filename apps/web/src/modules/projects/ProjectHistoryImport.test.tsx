import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, expect, it, vi } from 'vitest'
import { ambientSessionsApi, projectFoldersApi } from '../../api/client'
import { ProjectHistoryImport } from './ProjectHistoryImport'

vi.mock('../../contexts/SpaceContext', () => ({ useSpace: () => ({ activeSpaceId: 'space', preferredSpaceId: 'space' }) }))
vi.mock('../../api/client', async original => ({ ...await original<typeof import('../../api/client')>(),
  ambientSessionsApi: { offer: vi.fn(), setReminder: vi.fn() },
  projectFoldersApi: { list: vi.fn(), locations: vi.fn() },
}))
const offer = (overrides = {}) => ({ policy: { entries: [], offered_at: '2026-01-01' }, counts: [],
  attention: { new_sessions: 0, updated_sessions: 1, incomplete_sessions: 1, uncertain: false }, ...overrides })
beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(projectFoldersApi.list).mockResolvedValue({ items: [{ id: 'folder', name: 'Parser' }] } as never)
  vi.mocked(projectFoldersApi.locations).mockResolvedValue([{ id: 'location', project_folder_id: 'folder', execution_host_kind: 'remote' }] as never)
  vi.mocked(ambientSessionsApi.offer).mockResolvedValue(offer() as never)
})
const show = (id = 'project') => render(<MemoryRouter><ProjectHistoryImport projectId={id} /></MemoryRouter>)
it('keeps partial/updated history visible despite an earlier offer; opening settings does not dismiss it', async () => {
  show()
  expect(await screen.findByTestId('ambient-import-banner')).toHaveTextContent('1 updated')
  await userEvent.click(screen.getByRole('link', { name: 'Review and import' }))
  expect(ambientSessionsApi.setReminder).not.toHaveBeenCalled()
  expect(screen.getByTestId('ambient-import-banner')).toBeVisible()
})
it.each(['later', 'never'] as const)('saves %s without hiding the manual entry', async mode => {
  show()
  await screen.findByTestId('ambient-import-banner')
  vi.mocked(ambientSessionsApi.setReminder).mockResolvedValue({ entries: [], offered_at: null } as never)
  vi.mocked(ambientSessionsApi.offer).mockResolvedValue(offer({ policy: { entries: [], reminder: mode === 'never' ? { enabled: false } : { enabled: true, snoozed_until: '2999-01-01T00:00:00Z' } } }) as never)
  await userEvent.click(screen.getByRole('button', { name: mode === 'never' ? 'Don’t remind for this folder' : 'Remind tomorrow' }))
  await waitFor(() => expect(screen.queryByTestId('ambient-import-banner')).not.toBeInTheDocument())
  expect(ambientSessionsApi.setReminder).toHaveBeenCalledWith('location', mode)
  await userEvent.click(screen.getByRole('button', { name: 'Import history' }))
  expect(screen.getByRole('link', { name: 'Review and import' })).toHaveAttribute('href', expect.stringContaining('/projects/project/folders/folder'))
})
it('keeps the manual entry after completion and never displays a false completion when discovery is uncertain', async () => {
  vi.mocked(ambientSessionsApi.offer).mockResolvedValue(offer({ attention: { new_sessions: 0, updated_sessions: 0, incomplete_sessions: 0, uncertain: true } }) as never)
  show()
  await userEvent.click(await screen.findByRole('button', { name: 'Import history' }))
  expect(screen.queryByTestId('ambient-import-banner')).not.toBeInTheDocument()
  expect(screen.getByText(/could not be fully checked/)).toBeVisible()
})
it('does not disclose a refused offer or retain it across project scopes', async () => {
  const view = show()
  await screen.findByTestId('ambient-import-banner')
  vi.mocked(ambientSessionsApi.offer).mockRejectedValue(new Error('forbidden'))
  view.rerender(<MemoryRouter><ProjectHistoryImport projectId="other" /></MemoryRouter>)
  expect(screen.queryByTestId('ambient-import-entry')).not.toBeInTheDocument()
  await waitFor(() => expect(ambientSessionsApi.offer).toHaveBeenCalledTimes(2))
  expect(screen.queryByTestId('ambient-import-entry')).not.toBeInTheDocument()
})
