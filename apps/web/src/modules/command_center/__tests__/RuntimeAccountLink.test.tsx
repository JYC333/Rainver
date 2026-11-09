import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { expect, it, vi } from 'vitest'
import RuntimeAccountLink from '../RuntimeAccountLink'

vi.mock('../../../contexts/SpaceContext', () => ({ useSpace: () => ({ activeSpaceId: 'space-1' }) }))

it('two CLI installations using one pool link to the same quota without duplicate percentages', () => {
  const usage = { pool_id: 'same-pool', host_id: 'host-a', runtime_key: 'claude_code', installation: 'own', checked_at: new Date().toISOString(),
    quota: { account_display: { email: "person@example.test", workspace_name: "Personal" }, account: { provider: 'anthropic' as const, product: 'claude' as const, account_id: 'a'.repeat(64), organization_id: null }, available: true, session_pct: 42, session_resets: null, week_pct: null, week_resets: null, error: null } }
  render(<MemoryRouter><RuntimeAccountLink usage={usage} hostId="host-a" runtimeKey="claude_code" installation="own" />
    <RuntimeAccountLink usage={{ ...usage, host_id: 'host-b', installation: 'managed:1' }} hostId="host-b" runtimeKey="claude_code" installation="managed:1" /></MemoryRouter>)
  const links = screen.getAllByRole('link', { name: 'View quota' })
  expect(links).toHaveLength(2)
  expect(links[0].getAttribute('href')).toBe(links[1].getAttribute('href'))
  expect(links[0]).toHaveAttribute('href', '/spaces/space-1/usage?tab=quotas&pool=same-pool')
  expect(screen.queryByText(/42%/)).toBeNull()
})

it('shows the full login email even when pool identity is unavailable', () => {
  const usage = { host_id: 'host-a', runtime_key: 'codex_cli', installation: 'own', checked_at: new Date().toISOString(),
    quota: { account: null, account_display: { email: 'person@example.test', workspace_name: 'Personal' }, available: true, session_pct: 42, session_resets: null, week_pct: null, week_resets: null, error: null } }
  render(<MemoryRouter><RuntimeAccountLink usage={usage} hostId="host-a" runtimeKey="codex_cli" installation="own" /></MemoryRouter>)
  expect(screen.getByText('person@example.test · Personal')).toBeInTheDocument()
})
