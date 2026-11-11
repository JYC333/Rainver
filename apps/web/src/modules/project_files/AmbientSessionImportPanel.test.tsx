import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { toast } from 'sonner'
import { describe, expect, it, vi } from 'vitest'
import { ambientSessionsApi } from '../../api/client'
import type { AmbientSyncReport, WorkspaceLocation } from '../../types/api'
import { AmbientSessionImportPanel } from './AmbientSessionImportPanel'

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() } }))
vi.mock('../../api/client', async importOriginal => {
  const original = await importOriginal<typeof import('../../api/client')>()
  return {
    ...original,
    ambientSessionsApi: {
      ...original.ambientSessionsApi,
      offer: vi.fn(async () => ({
        policy: { entries: [] },
        counts: [{ location_id: 'loc', runtime_key: 'claude_code', installation: 'own', session_count: 2, oldest_updated_at: null, newest_updated_at: null, error: null }],
      })),
      list: vi.fn(async () => ({ sessions: [] })),
      sync: vi.fn(),
    },
  }
})

const location = { id: 'loc', execution_host_kind: 'remote' } as unknown as WorkspaceLocation
const report = (overrides: Partial<AmbientSyncReport>): AmbientSyncReport => ({
  location_id: 'loc', runtime_key: 'claude_code', installation: 'own', sessions_seen: 2, sessions_written: 2, records_inserted: 2,
  records_unchanged: 0, records_conflicted: 0, marked_gone: 0, usage_events: 0, usage_failures: 0, malformed_sessions: 0,
  failed_sessions: 0, partial_sessions: 0, error: null, ...overrides,
})

async function importNow(answer: AmbientSyncReport) {
  vi.mocked(toast.success).mockClear()
  vi.mocked(toast.error).mockClear()
  vi.mocked(ambientSessionsApi.sync).mockResolvedValueOnce(answer)
  const view = render(<AmbientSessionImportPanel location={location} />)
  await userEvent.click(await screen.findByRole('button', { name: /Import now/ }))
  await waitFor(() => expect(vi.mocked(toast.success).mock.calls.length + vi.mocked(toast.error).mock.calls.length).toBe(1))
  view.unmount()
}

describe('AmbientSessionImportPanel import outcome', () => {
  it('never shows a sync with a session read only in part as a success, and says what it kept', async () => {
    await importNow(report({ partial_sessions: 1, error: "a session's history could only be read in part; the next sync retries it" }))
    expect(toast.success).not.toHaveBeenCalled()
    expect(toast.error).toHaveBeenCalledWith(expect.stringMatching(/^2 sessions, 2 new records \(1 only in part\) saved, then the import stopped: a session's history/))
  })

  it('shows a whole import as a success', async () => {
    await importNow(report({}))
    expect(toast.error).not.toHaveBeenCalled()
    expect(toast.success).toHaveBeenCalledWith('2 sessions, 2 new records')
  })
})
