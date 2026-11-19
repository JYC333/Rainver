import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { RunPluginDataPanel } from '../RunPluginDataPanel'
import { callOperation, queryOperation } from '../../../api/client'
import type { Run } from '../../../types/api'

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))
vi.mock('../../../api/client', () => ({ queryOperation: vi.fn(), callOperation: vi.fn() }))

const run = { id: 'run-1', space_id: 'team-1', status: 'running', instructed_by_user_id: 'member-1' } as unknown as Run
const read = { id: 'r1', run_id: 'run-1', agent_id: 'a1', action_id: 'plugin.diary_probe.entry.list', resource_type: 'plugin.diary_probe', resource_ids: ['e1', 'e2'], data_class: 'sensitive', grant_id: 'g1', accessed_at: '2026-11-16T10:00:00.000Z' }
const grant = { id: 'g1', space_id: 'team-1', plugin_id: 'diary_probe', toolset: 'read', data_class: 'sensitive', scope: 'run', data_owner_user_id: 'member-1', granted_by_user_id: 'member-1', target_run_id: 'run-1', plugin_version: '1.0.0', authority_hash: 'h', expanded: [], status: 'active', expires_at: '2026-11-16T11:00:00.000Z', revoked_at: null, created_at: '2026-11-16T09:00:00.000Z', reconsent: null }

const background = { ...grant, id: 'g2', scope: 'background', target_run_id: null, expires_at: '2026-11-17T09:00:00.000Z' }
let grantsForRun: unknown[] = [grant]

beforeEach(() => {
  vi.clearAllMocks()
  grantsForRun = [grant]
  vi.mocked(queryOperation).mockImplementation(async (id: string, input: unknown) => {
    if (id === 'agent_data_read.list') return { status: 'succeeded', data: { items: [read], has_more: false } } as never
    return { status: 'succeeded', data: { items: (input as { run_id?: string }).run_id ? grantsForRun : [] } } as never
  })
  vi.mocked(callOperation).mockResolvedValue({ status: 'succeeded', data: { run_id: 'run-1', revoked_grant_ids: ['g1'] } } as never)
})

describe('RunPluginDataPanel', () => {
  it('is absent for anyone but the person the Run acts for, and never queries for them', () => {
    const { container } = render(<RunPluginDataPanel run={run} currentUserId="owner-1" />)
    expect(container).toBeEmptyDOMElement()
    expect(queryOperation).not.toHaveBeenCalled()
  })

  it('lists content-free reads and consents and revokes the Run in one confirmed step', async () => {
    render(<RunPluginDataPanel run={run} currentUserId="member-1" />)
    expect(await screen.findByText('plugin.diary_probe.entry.list')).toBeVisible()
    expect(screen.getByText(/2 records/)).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: "Revoke this Run's data access" }))
    fireEvent.click(await screen.findByRole('button', { name: 'Revoke' }))
    await waitFor(() => expect(callOperation).toHaveBeenCalledWith('plugin_data_grant.revoke_run', { run_id: 'run-1' }, expect.any(String), { spaceId: 'team-1' }))
  })

  it('shows a background consent a scheduled Run used and revokes exactly that consent', async () => {
    grantsForRun = [background]
    vi.mocked(callOperation).mockResolvedValue({ status: 'succeeded', data: { ...background, status: 'revoked' } } as never)
    render(<RunPluginDataPanel run={run} currentUserId="member-1" />)
    expect(await screen.findByText('Your scheduled Runs')).toBeVisible()
    // One list query keyed by the Run; no separate Space-wide listing.
    expect(vi.mocked(queryOperation).mock.calls.map(call => call[0])).toEqual(['agent_data_read.list', 'plugin_data_grant.list'])
    fireEvent.click(screen.getByRole('button', { name: 'Stop background reads' }))
    await waitFor(() => expect(callOperation).toHaveBeenCalledWith('plugin_data_grant.revoke', { grant_id: 'g2' }, expect.any(String), { spaceId: 'team-1' }))
    expect(screen.getByRole('button', { name: "Revoke this Run's data access" })).toBeVisible()
  })

  it('labels Project Gmail consents with their Project scope, not private conversations only', async () => {
    grantsForRun = [
      { ...grant, id: 'g3', plugin_id: 'core:gmail', scope: 'project', target_run_id: null, expires_at: null },
      { ...grant, id: 'g4', plugin_id: 'core:gmail_digest', scope: 'project', target_run_id: null, expires_at: null },
    ]
    render(<RunPluginDataPanel run={run} currentUserId="member-1" />)
    expect(await screen.findByText('Gmail · read')).toBeVisible()
    expect(screen.getByText('Gmail digest · read')).toBeVisible()
    expect(screen.getAllByText('Only in this Project (its private conversations, Rooms and mainline), until revoked')).toHaveLength(2)
    expect(screen.queryByText(/Your private conversations/)).toBeNull()
  })
})
