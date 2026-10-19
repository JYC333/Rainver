import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ModelProviderOut, ProviderVendorOut } from '../../../api/client'
import i18n from '../../../i18n'
import ProviderCard from '../components/ProviderCard'

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))
vi.mock('../../../api/client', () => ({ providersApi: { patch: vi.fn(), grant: vi.fn() } }))
vi.mock('../../network_profiles/NetworkProfileSelector', () => ({ default: () => null }))

const vendors: ProviderVendorOut[] = [{
  id: 'openai', display_name: 'OpenAI', protocol: 'openai', supports_chat: true, supports_structured_output: true,
  supports_embedding: true, supports_rerank: false, default_base_url: null, api_key_required: true,
  subscription_only: false, self_hostable: false,
}]

const provider: ModelProviderOut = {
  id: 'provider-1', space_id: 'space-1', name: 'Team OpenAI', provider_type: 'openai',
  base_url: 'https://api.openai.com/v1', deployment: 'cloud', network_profile_id: null,
  claude_compatible_base_url: null, openai_compatible_base_url: null, default_model: 'gpt-4o',
  available_models: ['gpt-4o'], enabled: false, is_default: true, has_api_key: true, manageable: true,
  created_at: '2026-10-01T00:00:00.000Z', updated_at: '2026-10-01T00:00:00.000Z',
}

function renderCard() {
  return render(
    <ProviderCard
      config={provider}
      vendors={vendors}
      spaces={[{ id: 'space-2', name: 'Lab' } as never]}
      onDelete={vi.fn()}
      onTest={vi.fn()}
      onPatched={vi.fn()}
    />,
  )
}

afterEach(async () => { await i18n.changeLanguage('en') })

describe('ProviderCard', () => {
  it('labels the card, its capabilities and its edit form', () => {
    renderCard()
    expect(screen.getByText('Default')).toBeInTheDocument()
    expect(screen.getByText('Disabled')).toBeInTheDocument()
    expect(screen.getByText('API key set')).toBeInTheDocument()
    expect(screen.getByText('Chat')).toBeInTheDocument()
    expect(screen.getByText('direct')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Delete provider' })).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Edit' }))
    expect(screen.getByPlaceholderText('Replace API key (optional)')).toBeInTheDocument()
    expect(screen.getByText('Default chat model')).toBeInTheDocument()
  })

  it('reads in Chinese, keeping the provider and model names as written', async () => {
    await i18n.changeLanguage('zh-CN')
    renderCard()
    expect(screen.getByText('Team OpenAI')).toBeInTheDocument()
    expect(screen.getByText('默认')).toBeInTheDocument()
    expect(screen.getByText('已停用')).toBeInTheDocument()
    expect(screen.getByText('已设置 API 密钥')).toBeInTheDocument()
    expect(screen.getByText('对话')).toBeInTheDocument()
    expect(screen.getByText('直连')).toBeInTheDocument()
    expect(screen.getByRole('option', { name: '授权给空间…' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '删除提供方' })).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: '编辑' }))
    expect(screen.getByPlaceholderText('替换 API 密钥（可选）')).toBeInTheDocument()
    expect(screen.getByText('默认对话模型')).toBeInTheDocument()
    expect(screen.getAllByDisplayValue('gpt-4o').length).toBe(2)
  })
})
