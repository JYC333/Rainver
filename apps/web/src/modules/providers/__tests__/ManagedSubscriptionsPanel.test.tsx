import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { ModelProviderOut } from '../../../api/client'
import ManagedSubscriptionsPanel from '../components/ManagedSubscriptionsPanel'

vi.mock('../../../api/client', async importOriginal => {
  const original = await importOriginal<typeof import('../../../api/client')>()
  return {
    ...original,
    providersApi: {
      ...original.providersApi,
      refreshSubscriptionQuota: vi.fn(),
      disconnectSubscription: vi.fn(),
      sendSubscriptionLoginInput: vi.fn(),
      subscriptionLoginStream: vi.fn(),
    },
  }
})

const codexProvider = {
  id: 'provider-codex',
  space_id: 'space-1',
  name: 'OpenAI Codex subscription',
  provider_type: 'openai_codex',
  base_url: 'https://chatgpt.com/backend-api',
  network_profile_id: null,
  claude_compatible_base_url: null,
  openai_compatible_base_url: null,
  default_model: 'gpt-5.6-sol',
  available_models: ['gpt-5.6-sol'],
  enabled: true,
  is_default: false,
  has_api_key: false,
  has_subscription: true,
  subscription_type: 'openai_codex',
  subscription_quota: {
    available: true,
    session_pct: 12,
    session_resets: null,
    week_pct: 34,
    week_resets: null,
    checked_at: '2026-08-14T00:00:00.000Z',
    error: null,
  },
  created_at: '2026-08-14T00:00:00.000Z',
  updated_at: '2026-08-14T00:00:00.000Z',
} satisfies ModelProviderOut

describe('ManagedSubscriptionsPanel', () => {
  it('shows Codex connection and quota without presenting OAuth secrets', () => {
    render(
      <ManagedSubscriptionsPanel
        providers={[codexProvider]}
        isInstanceAdmin
        onChanged={() => {}}
        onDisconnected={() => {}}
      />,
    )

    expect(screen.getByText('OpenAI Codex (ChatGPT Plus / Pro)')).toBeInTheDocument()
    expect(screen.getByText(/5h: 12% · week: 34%/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Refresh quota' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Disconnect' })).toBeInTheDocument()
    expect(document.body.textContent).not.toMatch(/access|refresh secret/i)
  })

  it('does not offer connect controls to a non-admin', () => {
    render(
      <ManagedSubscriptionsPanel
        providers={[]}
        isInstanceAdmin={false}
        onChanged={() => {}}
        onDisconnected={() => {}}
      />,
    )

    expect(screen.getByText(/requires the configured instance admin/i)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Connect' })).not.toBeInTheDocument()
  })
})
