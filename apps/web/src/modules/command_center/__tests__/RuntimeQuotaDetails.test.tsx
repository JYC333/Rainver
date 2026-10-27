import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { expect, it, vi } from 'vitest'
import RuntimeQuotaDetails from '../RuntimeQuotaDetails'

it.each([[0.14852, '0.1'], [0, '0.0'], [1, '1'], [12.34, '12'], [99.8, '100']])(
  'formats measured %s percent consistently in the summary and detail', async (value, formatted) => {
    render(<RuntimeQuotaDetails title="Precision" canRefresh={false} busy={false} online onRefresh={vi.fn()}
      usage={{ host_id: 'host', runtime_key: 'acp_antigravity_acp', installation: 'own', checked_at: '2026-10-27T08:00:00Z',
        quota: { available: true, session_pct: null, session_resets: null, week_pct: null, week_resets: null, error: null,
          windows: [{ id: 'gemini-weekly', label: 'Gemini weekly', used_pct: value, resets: null }] } }} />)
    expect(screen.getByText(`Highest used ${formatted}%`)).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Usage details for Precision' }))
    expect(screen.getByText(`${formatted}% used`)).toBeInTheDocument()
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuetext', `${formatted}% used`)
  },
)

it('keeps unreadable quota explicit and prevents read-only viewers from probing', async () => {
  const refresh = vi.fn()
  render(<RuntimeQuotaDetails title="Antigravity" canRefresh={false} busy={false} online onRefresh={refresh}
    usage={{ host_id: 'host', runtime_key: 'acp_antigravity_acp', installation: 'own', checked_at: '2026-10-26T12:00:00Z',
      quota: { available: false, session_pct: null, session_resets: null, week_pct: null, week_resets: null, error: 'Quota access denied',
        windows: [{ id: 'unknown', label: 'Gemini weekly', used_pct: null, resets: null }] } }} />)
  await userEvent.click(screen.getByRole('button', { name: 'Usage details for Antigravity' }))
  expect(screen.getByRole('status')).toHaveTextContent('Quota access denied')
  expect(screen.queryByRole('progressbar')).toBeNull()
  expect(screen.queryByRole('button', { name: 'Refresh usage' })).toBeNull()
  expect(refresh).not.toHaveBeenCalled()
})

it('allows a bounded explicit refresh from the detail view', async () => {
  const refresh = vi.fn()
  render(<RuntimeQuotaDetails title="Claude" canRefresh busy={false} online onRefresh={refresh} />)
  expect(screen.getByText('Usage not checked')).toBeInTheDocument()
  await userEvent.click(screen.getByRole('button', { name: 'Usage details for Claude' }))
  await userEvent.click(screen.getByRole('button', { name: 'Refresh usage' }))
  expect(refresh).toHaveBeenCalledOnce()
})

it('opens on hover, survives moving into the card, and closes after leaving', async () => {
  const user = userEvent.setup({ delay: null })
  render(<RuntimeQuotaDetails title="Hover account" canRefresh={false} busy={false} online onRefresh={vi.fn()} />)
  const trigger = screen.getByRole('button', { name: 'Usage details for Hover account' })
  await user.hover(trigger)
  const card = await screen.findByRole('dialog')
  await user.hover(card)
  expect(card).toBeInTheDocument()
  await user.unhover(card)
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  await user.click(trigger)
  expect(await screen.findByRole('dialog')).toBeInTheDocument()
  await user.keyboard('{Escape}')
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
})
