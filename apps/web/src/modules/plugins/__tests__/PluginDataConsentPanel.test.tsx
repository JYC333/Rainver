import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { PluginDataConsentPanel } from '../PluginDataConsentPanel'
import { callOperation, projectsApi, queryOperation } from '../../../api/client'

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))
vi.mock('../../../api/client', () => ({ queryOperation: vi.fn(), callOperation: vi.fn(), projectsApi: { get: vi.fn() } }))

const pin = (action_id: string) => ({ action_id, action_version: 1, data_class: 'sensitive', side_effects: 'none', gate_class: null })
const background = { plugin_id: 'journal', plugin_name: 'Journal', plugin_version: '1.0.0', toolset: 'read', data_class: 'sensitive', scope: 'background', authority_hash: 'contract-1', tools: [pin('plugin.journal.entry.list')], default_expires_in_seconds: 86_400, active_grant_id: null, changes: null }
const grant = { id: 'g-bg', space_id: 'team-1', plugin_id: 'journal', toolset: 'read', data_class: 'sensitive', scope: 'background', data_owner_user_id: 'member-1', granted_by_user_id: 'member-1', target_run_id: null, plugin_version: '1.0.0', authority_hash: 'contract-1', expanded: background.tools, status: 'active', expires_at: '2026-11-18T09:00:00.000Z', revoked_at: null, created_at: '2026-11-17T09:00:00.000Z', reconsent: null }
let state: { options: unknown[]; items: unknown[] }

beforeEach(() => {
  vi.clearAllMocks()
  state = { options: [background], items: [] }
  vi.mocked(queryOperation).mockImplementation(async () => ({ status: 'succeeded', data: { items: state.items, consentable: state.options } }) as never)
  vi.mocked(callOperation).mockImplementation(async (id: string) => {
    if (id === 'plugin_data_grant.create') { state = { options: [{ ...background, active_grant_id: grant.id }], items: [grant] }; return { status: 'succeeded', data: grant } as never }
    state = { options: [background], items: [{ ...grant, status: 'revoked' }] }
    return { status: 'succeeded', data: { ...grant, status: 'revoked' } } as never
  })
})

describe('PluginDataConsentPanel', () => {
  it('is absent when there is nothing this person may consent to', async () => {
    state = { options: [], items: [] }
    const { container } = render(<PluginDataConsentPanel spaceId="team-1" spaceName="Family" />)
    await waitFor(() => expect(queryOperation).toHaveBeenCalledWith('plugin_data_grant.list', {}, { spaceId: 'team-1' }))
    expect(container).toBeEmptyDOMElement()
  })

  it('shows the frozen tools, scope and expiry, consents only after confirmation, then revokes that consent', async () => {
    render(<PluginDataConsentPanel spaceId="team-1" spaceName="Family" />)
    expect(await screen.findByText('plugin.journal.entry.list')).toBeVisible()
    expect(screen.getByText(/Your own scheduled Runs, read only/)).toBeVisible()
    expect(screen.getByText(/Expires 24 h after you allow it/)).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: 'Allow Journal · read' }))
    expect(callOperation).not.toHaveBeenCalled()
    fireEvent.click(await screen.findByRole('button', { name: 'Allow' }))
    await waitFor(() => expect(callOperation).toHaveBeenCalledWith('plugin_data_grant.create',
      { plugin_id: 'journal', toolset: 'read', data_class: 'sensitive', scope: 'background', authority_hash: 'contract-1', expires_in_seconds: 86_400 }, expect.any(String), { spaceId: 'team-1' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Revoke Journal · read' }))
    await waitFor(() => expect(callOperation).toHaveBeenCalledWith('plugin_data_grant.revoke', { grant_id: 'g-bg' }, expect.any(String), { spaceId: 'team-1' }))
    expect(await screen.findByRole('button', { name: 'Allow Journal · read' })).toBeVisible()
  })

  it('keeps an active consent revocable with its frozen tools after its plugin is turned off', async () => {
    // Disabled: the server offers no option, the grant itself is still listed.
    state = { options: [], items: [{ ...grant, expanded: [pin('plugin.journal.entry.list'), pin('plugin.journal.old.list')] }, { ...grant, id: 'g-old', status: 'revoked' }] }
    render(<PluginDataConsentPanel spaceId="team-1" spaceName="Family" />)
    expect(await screen.findByText('plugin.journal.entry.list, plugin.journal.old.list')).toBeVisible()
    expect(screen.getByText(/Frozen when you allowed it \(v1\.0\.0\)/)).toBeVisible()
    expect(screen.getByText(/not offered for new consent right now/)).toBeVisible()
    expect(screen.queryByRole('button', { name: /^Allow/ })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Revoke journal · read' }))
    await waitFor(() => expect(callOperation).toHaveBeenCalledWith('plugin_data_grant.revoke', { grant_id: 'g-bg' }, expect.any(String), { spaceId: 'team-1' }))
    expect(callOperation).toHaveBeenCalledTimes(1)
  })

  it('refreshes the options when a consent confirmed before an upgrade is refused', async () => {
    const upgraded = { ...background, authority_hash: 'contract-2', plugin_version: '1.1.0', tools: [pin('plugin.journal.entry.list'), pin('plugin.journal.mood.list')] }
    vi.mocked(callOperation).mockImplementation(async () => { state = { options: [upgraded], items: [] }; throw new Error('This plugin changed after you reviewed it; refresh and confirm the consent again') })
    render(<PluginDataConsentPanel spaceId="team-1" spaceName="Family" />)
    fireEvent.click(await screen.findByRole('button', { name: 'Allow Journal · read' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Allow' }))
    await waitFor(() => expect(callOperation).toHaveBeenCalledWith('plugin_data_grant.create', expect.objectContaining({ authority_hash: 'contract-1' }), expect.any(String), { spaceId: 'team-1' }))
    // The refreshed option shows the new tools; nothing is allowed until it is confirmed again.
    expect(await screen.findByText('plugin.journal.entry.list, plugin.journal.mood.list')).toBeVisible()
    expect(callOperation).toHaveBeenCalledTimes(1)
  })

  it('lists a core Project consent with its Project and purpose, naming the Project only while it can be opened', async () => {
    const core = (id: string, plugin_id: string, purpose: string, project_id: string) =>
      ({ ...grant, id, plugin_id, scope: 'project', project_id, connection_id: 'c-1', purpose, expires_at: null, plugin_version: '1', expanded: [pin('source.gmail.read')] })
    state = { options: [background], items: [
      core('g-read', 'core:gmail', 'on_demand_read', 'p-1'), core('g-daily', 'core:gmail_digest', 'daily_digest', 'p-1'),
      core('g-rule', 'core:gmail_digest', 'rule_digest', 'p-gone'),
    ] }
    vi.mocked(projectsApi.get).mockImplementation(async (id: string) => {
      if (id === 'p-1') return { id, name: 'Admissions', current_user_can_read: true } as never
      throw Object.assign(new Error('Not found'), { status: 404 })
    })
    render(<PluginDataConsentPanel spaceId="team-1" spaceName="Family" />)
    expect(await screen.findByText(/Project: Admissions · reads your mail when you ask in its conversations/)).toBeVisible()
    expect(screen.getByText(/Project: Admissions · daily inbox digest/)).toBeVisible()
    expect(screen.getByText(/A Project you can no longer open · digest of monitor matches/)).toBeVisible()
    expect(projectsApi.get).toHaveBeenCalledWith('p-1', { spaceId: 'team-1' })
    expect(projectsApi.get).toHaveBeenCalledTimes(2)
    // Never the scheduled-Run scope (only the ordinary offer carries it), the raw consent id or the plugin "not offered" note.
    expect(screen.getAllByText(/Your own scheduled Runs/)).toHaveLength(1)
    expect(screen.queryByText(/core:gmail/)).toBeNull()
    expect(screen.queryByText(/not offered for new consent/)).toBeNull()
    expect(screen.getByRole('button', { name: 'Revoke Gmail · read' })).toBeVisible()
    fireEvent.click(screen.getAllByRole('button', { name: 'Revoke Gmail digest · read' })[0]!)
    await waitFor(() => expect(callOperation).toHaveBeenCalledWith('plugin_data_grant.revoke', { grant_id: 'g-daily' }, expect.any(String), { spaceId: 'team-1' }))
    // An ordinary plugin offer beside them is unchanged.
    expect(screen.getByText(/Your own scheduled Runs, read only · Expires 24 h/)).toBeVisible()
  })

  it('keeps the fallback when the Project answers but this person may not read it', async () => {
    const core = (id: string, project_id: string) =>
      ({ ...grant, id, plugin_id: 'core:gmail', scope: 'project', project_id, connection_id: 'c-1', purpose: 'on_demand_read', expires_at: null, plugin_version: '1', expanded: [pin('source.gmail.read')] })
    state = { options: [background], items: [core('g-limited', 'p-limited'), core('g-unflagged', 'p-unflagged')] }
    vi.mocked(projectsApi.get).mockImplementation(async (id: string) => id === 'p-limited'
      ? { id, name: 'Restricted Admissions', current_user_can_read: false } as never
      : { id, name: 'Unflagged Admissions' } as never)
    render(<PluginDataConsentPanel spaceId="team-1" spaceName="Family" />)
    await waitFor(() => expect(screen.getAllByText(/A Project you can no longer open · reads your mail when you ask/)).toHaveLength(2))
    expect(screen.queryByText(/Admissions/)).toBeNull()
    expect(projectsApi.get).toHaveBeenCalledTimes(2)
    // The ordinary plugin offer beside them is unchanged.
    expect(screen.getByText(/Your own scheduled Runs, read only · Expires 24 h/)).toBeVisible()
  })

  it('names what an update changed since the last consent', async () => {
    state = { options: [{ ...background, changes: { added: ['plugin.journal.mood.list'], removed: [], changed: [] } }], items: [] }
    render(<PluginDataConsentPanel spaceId="team-1" spaceName="Family" />)
    expect(await screen.findByText(/1 added, 0 removed, 0 changed/)).toBeVisible()
  })
})
