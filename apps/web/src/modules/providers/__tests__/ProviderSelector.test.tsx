import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { describe, expect, it, vi } from 'vitest'
import ProviderSelector from '../ProviderSelector'
import { providersApi } from '../../../api/client'

vi.mock('../../../api/client', () => ({
  providersApi: {
    list: vi.fn().mockResolvedValue([]),
    models: vi.fn(),
    vendors: vi.fn().mockResolvedValue([]),
  },
}))

vi.mock('../../../contexts/SpaceContext', () => ({
  useSpace: () => ({
    activeSpaceId: 'personal-1',
    preferredSpaceId: 'personal-1',
  }),
}))

const routerFuture = { v7_relativeSplatPath: true, v7_startTransition: true } as const

describe('ProviderSelector', () => {
  it('links provider creation to the current space in the same tab', async () => {
    render(
      <MemoryRouter future={routerFuture}>
        <ProviderSelector value={null} onChange={() => {}} required />
      </MemoryRouter>,
    )

    const link = await screen.findByRole('link', { name: /define a provider/i })
    expect(link).toHaveAttribute('href', '/spaces/personal-1/providers')
    expect(link).not.toHaveAttribute('target')
  })

  it('offers a provider to a vendor-protocol runtime only when it has the URL its vendor protocol needs', async () => {
    const provider = (id: string, provider_type: string, urls: Record<string, string | null>) => ({
      id, name: id, provider_type, enabled: true, default_model: null, available_models: [],
      claude_compatible_base_url: null, openai_compatible_base_url: null, ...urls,
    })
    vi.mocked(providersApi.list).mockResolvedValueOnce([
      provider('anthropic-ok', 'anthropic', { claude_compatible_base_url: 'https://api.anthropic.com' }),
      provider('anthropic-openai-only', 'anthropic', { openai_compatible_base_url: 'https://gw.example/v1' }),
      provider('openai-ok', 'openai', { openai_compatible_base_url: 'https://api.openai.com/v1' }),
      provider('cohere', 'cohere', { openai_compatible_base_url: 'https://gw.example/v1' }),
    ] as never)
    vi.mocked(providersApi.vendors).mockResolvedValueOnce([
      { id: 'anthropic', protocol: 'anthropic_messages' },
      { id: 'openai', protocol: 'openai_completions' },
      { id: 'cohere', protocol: 'cohere_v2' },
    ] as never)
    render(
      <MemoryRouter future={routerFuture}>
        <ProviderSelector value={null} onChange={() => {}} requireVendorCompatible />
      </MemoryRouter>,
    )

    expect(await screen.findByRole('option', { name: /anthropic-openai-only .*no Claude-compatible URL/ })).toBeDisabled()
    expect(screen.getByRole('option', { name: /^anthropic-ok \(anthropic\)$/ })).toBeEnabled()
    expect(screen.getByRole('option', { name: /^openai-ok \(openai\)$/ })).toBeEnabled()
    expect(screen.getByRole('option', { name: /cohere .*protocol not supported/ })).toBeDisabled()
  })
})
