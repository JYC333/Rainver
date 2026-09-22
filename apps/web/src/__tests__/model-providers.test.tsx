import type { ProviderVendorOut } from '../api/client'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'
import { toast } from 'sonner'

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

const { listMock, presetsMock, vendorsMock, createMock, createFromPresetMock, getRuntimeDefaultMock, setRuntimeDefaultMock, activeSpace } = vi.hoisted(() => ({
  listMock: vi.fn(),
  presetsMock: vi.fn(),
  vendorsMock: vi.fn(),
  createMock: vi.fn(),
  createFromPresetMock: vi.fn(),
  getRuntimeDefaultMock: vi.fn(),
  setRuntimeDefaultMock: vi.fn(),
  activeSpace: { id: 'personal-1', name: 'My Personal' },
}))

vi.mock('../api/client', () => ({
  agentsApi: {
    getSpaceRuntimeDefault: getRuntimeDefaultMock,
    setSpaceRuntimeDefault: setRuntimeDefaultMock,
  },
  authApi: { mySpaces: vi.fn().mockResolvedValue([{ id: 'personal-1', name: 'My Personal', type: 'personal', role: 'owner' }]) },
  acpAgentsApi: { registry: vi.fn().mockResolvedValue({ items: [] }), list: vi.fn().mockResolvedValue({ items: [] }) },
  hostsApi: { list: vi.fn().mockResolvedValue({ items: [] }), listRuntimeDefinitions: vi.fn().mockResolvedValue({ items: [] }) },
  providersApi: { list: listMock, presets: presetsMock, vendors: vendorsMock, create: createMock, createFromPreset: createFromPresetMock, delete: vi.fn(), test: vi.fn(), patch: vi.fn(), grant: vi.fn() },
}))

vi.mock('../contexts/SpaceContext', () => ({
  useSpace: () => ({ activeSpaceId: activeSpace.id, activeSpaceName: activeSpace.name }),
}))

vi.mock('../contexts/AuthContext', () => ({
  useAuth: () => ({ currentUser: { id: 'user-1', is_instance_admin: true } }),
}))

import ModelProvidersPage from '../modules/providers/ModelProvidersPage'

const EMPTY = /no model providers configured/i

const provider = {
  id: 'p1', space_id: 'personal-1', name: 'My OpenAI', provider_type: 'openai',
  base_url: 'https://api.openai.com/v1', claude_compatible_base_url: null, openai_compatible_base_url: 'https://api.openai.com/v1', default_model: 'gpt-4o', available_models: ['gpt-4o'],
  enabled: true, is_default: true, has_api_key: true, created_at: '', updated_at: '',
}

const providerPresets = [
  {
    id: 'cohere_embedding',
    mode: 'embedding',
    label: 'Cohere Embed',
    name: 'Cohere Embeddings',
    provider_type: 'cohere',
    base_url: 'https://api.cohere.com',
    default_model: 'embed-v4.0',
    available_models: ['embed-v4.0'],
    embedding_dimensions: 1536,
    embedding_dimension_options: [1536, 1024, 512, 256],
    api_key_required: true,
    task: 'retrieval_embedding',
  },
  {
    id: 'cohere_rerank',
    mode: 'rerank',
    label: 'Cohere Rerank',
    name: 'Cohere Rerank',
    provider_type: 'cohere',
    base_url: 'https://api.cohere.com',
    default_model: 'rerank-v4.0-pro',
    available_models: ['rerank-v4.0-pro'],
    embedding_dimensions: null,
    embedding_dimension_options: [],
    api_key_required: true,
    task: 'retrieval_rerank',
  },
  {
    id: 'minimax',
    mode: 'chat',
    label: 'MiniMax',
    name: 'MiniMax',
    provider_type: 'minimax',
    base_url: 'https://api.minimaxi.com/anthropic',
    claude_compatible_base_url: 'https://api.minimaxi.com/anthropic',
    openai_compatible_base_url: 'https://api.minimaxi.com/v1',
    default_model: 'MiniMax-M3',
    available_models: [
      'MiniMax-M3',
      'MiniMax-M2.7',
      'MiniMax-M2.7-highspeed',
      'MiniMax-M2.5',
      'MiniMax-M2.5-highspeed',
      'MiniMax-M2.1',
      'MiniMax-M2.1-highspeed',
      'MiniMax-M2',
    ],
    embedding_dimensions: null,
    embedding_dimension_options: [],
    api_key_required: true,
    task: null,
  },
]

const providerVendors = [
  { id: 'openai', display_name: 'OpenAI', protocol: 'openai_completions', supports_chat: true, supports_structured_output: true, supports_embedding: true, supports_rerank: false, default_base_url: 'https://api.openai.com/v1', api_key_required: true, subscription_only: false },
  { id: 'openai_codex', display_name: 'OpenAI Codex (ChatGPT subscription)', protocol: 'openai_codex_responses', supports_chat: true, supports_structured_output: true, supports_embedding: false, supports_rerank: false, default_base_url: 'https://chatgpt.com/backend-api', api_key_required: false, subscription_only: true },
  { id: 'deepseek', display_name: 'DeepSeek', protocol: 'openai_completions', supports_chat: true, supports_structured_output: true, supports_embedding: false, supports_rerank: false, default_base_url: 'https://api.deepseek.com', api_key_required: true, subscription_only: false },
  { id: 'anthropic', display_name: 'Anthropic', protocol: 'anthropic_messages', supports_chat: true, supports_structured_output: true, supports_embedding: false, supports_rerank: false, default_base_url: 'https://api.anthropic.com', api_key_required: true, subscription_only: false },
  { id: 'minimax', display_name: 'MiniMax', protocol: 'anthropic_messages', supports_chat: true, supports_structured_output: true, supports_embedding: false, supports_rerank: false, default_base_url: 'https://api.minimaxi.com/anthropic', api_key_required: true, subscription_only: false },
  { id: 'ollama', display_name: 'Ollama', protocol: 'openai_completions', supports_chat: true, supports_structured_output: true, supports_embedding: true, supports_rerank: false, default_base_url: 'http://localhost:11434', api_key_required: false, subscription_only: false },
  { id: 'openai_compatible', display_name: 'OpenAI-compatible endpoint', protocol: 'openai_completions', supports_chat: true, supports_structured_output: true, supports_embedding: true, supports_rerank: false, default_base_url: null, api_key_required: false, subscription_only: false },
  { id: 'cohere', display_name: 'Cohere', protocol: 'cohere_v2', supports_chat: false, supports_structured_output: false, supports_embedding: true, supports_rerank: true, default_base_url: 'https://api.cohere.com', api_key_required: true, subscription_only: false },
  { id: 'zeroentropy', display_name: 'ZeroEntropy', protocol: 'zeroentropy', supports_chat: false, supports_structured_output: false, supports_embedding: true, supports_rerank: true, default_base_url: 'https://api.zeroentropy.dev/v1', api_key_required: true, subscription_only: false },
] satisfies ProviderVendorOut[]

describe('ModelProvidersPage — open add form takes over the view', () => {
  beforeEach(() => {
    activeSpace.id = 'personal-1'
    activeSpace.name = 'My Personal'
    listMock.mockReset()
    presetsMock.mockReset()
    vendorsMock.mockReset()
    createMock.mockReset()
    createFromPresetMock.mockReset()
    getRuntimeDefaultMock.mockResolvedValue(null)
    setRuntimeDefaultMock.mockReset()
    presetsMock.mockResolvedValue(providerPresets)
    // The vendor registry is the server's; the page reads it rather than
    // holding its own copy of which vendors can chat, embed, or rerank.
    vendorsMock.mockResolvedValue(providerVendors)
  })

  it('shows the empty-state when there are no providers and the form is closed', async () => {
    listMock.mockResolvedValue([])
    render(<ModelProvidersPage />)
    expect(await screen.findByText(EMPTY)).toBeInTheDocument()
  })

  it('saves an explicit OpenCode default for future Agent Profiles', async () => {
    listMock.mockResolvedValue([provider])
    setRuntimeDefaultMock.mockResolvedValue({
      space_id: 'personal-1',
      runtime_key: 'opencode',
      backend_mode: 'model_provider',
      model_provider_id: provider.id,
      model_name: provider.default_model,
      state: 'ready',
      state_reason: null,
    })
    render(<ModelProvidersPage />)
    await screen.findByRole('heading', { name: 'My OpenAI' })

    fireEvent.click(screen.getByRole('button', { name: 'OpenCode backend mode' }))
    fireEvent.click(screen.getByRole('option', { name: provider.name }))
    expect(screen.getByLabelText('OpenCode default model')).toHaveValue(provider.default_model)
    fireEvent.click(screen.getByRole('button', { name: 'Save default for future Agents' }))

    await waitFor(() => expect(setRuntimeDefaultMock).toHaveBeenCalledWith({
      runtime_key: 'opencode',
      backend_mode: 'model_provider',
      model_provider_id: provider.id,
      model_name: provider.default_model,
    }))
  })

  it('hides the empty-state while the add form is open', async () => {
    listMock.mockResolvedValue([])
    render(<ModelProvidersPage />)
    await screen.findByText(EMPTY)
    fireEvent.click(screen.getByRole('button', { name: /add chat provider/i }))
    // The form is open now; the "no providers" notice must not also be shown.
    expect(screen.queryByText(EMPTY)).toBeNull()
    expect(screen.getByText(/set as default provider/i)).toBeInTheDocument()
  })

  it('hides the existing provider list while the add form is open', async () => {
    listMock.mockResolvedValue([provider])
    render(<ModelProvidersPage />)
    expect(await screen.findByRole('heading', { name: 'My OpenAI' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /add chat provider/i }))
    // Existing providers are not shown mid-add — not in a card, and not as an
    // option of the runtime-default picker either.
    expect(screen.queryByText('My OpenAI')).toBeNull()
    expect(screen.queryByLabelText('OpenCode default backend')).toBeNull()
  })

  it('shows a repair state, and writes nothing, when the saved default Provider is gone', async () => {
    // Plan Phase 4 §4: a deleted or disabled Provider must produce a visible
    // repair state for future provisioning, never a silent native fallback.
    listMock.mockResolvedValue([])
    // The server derives the repair state from the grant ∧ enabled join that
    // Profile admission uses; the page must render that, not its own guess.
    getRuntimeDefaultMock.mockResolvedValue({
      space_id: 'personal-1',
      runtime_key: 'opencode',
      backend_mode: 'model_provider',
      model_provider_id: 'gone-1',
      model_name: 'gpt-4o',
      state: 'needs_repair',
      state_reason: 'The selected ModelProvider is no longer enabled or granted to this Space',
    })
    render(<ModelProvidersPage />)

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('The selected ModelProvider is no longer enabled or granted to this Space')
    expect(screen.getByRole('button', { name: 'OpenCode backend mode' })).toHaveTextContent(/needs repair/)
    expect(setRuntimeDefaultMock).not.toHaveBeenCalled()
  })

  it('keeps the Providers list readable when the runtime default fails to load', async () => {
    // One failing call in the page's fan-out used to reject the whole
    // Promise.all and blank the page. The card reports its own failure and
    // offers a retry; nothing is saved over a template nobody could read.
    listMock.mockResolvedValue([provider])
    getRuntimeDefaultMock.mockRejectedValueOnce(new Error('runtime default unavailable'))
    render(<ModelProvidersPage />)

    expect(await screen.findByRole('heading', { name: 'My OpenAI' })).toBeInTheDocument()
    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('runtime default unavailable')
    expect(screen.getByRole('button', { name: 'Save default for future Agents' })).toBeDisabled()

    getRuntimeDefaultMock.mockResolvedValue({
      space_id: 'personal-1',
      runtime_key: 'opencode',
      backend_mode: 'model_provider',
      model_provider_id: provider.id,
      model_name: provider.default_model,
      state: 'ready',
      state_reason: null,
    })
    fireEvent.click(within(alert).getByRole('button', { name: 'Retry' }))

    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull())
    expect(screen.getByRole('button', { name: 'OpenCode backend mode' })).toHaveTextContent(provider.name)
    expect(screen.getByRole('button', { name: 'Save default for future Agents' })).toBeEnabled()
  })

  it('applies the MiniMax preset to the add form', async () => {
    listMock.mockResolvedValue([])
    render(<ModelProvidersPage />)
    await screen.findByText(EMPTY)
    fireEvent.click(screen.getByRole('button', { name: /add chat provider/i }))

    fireEvent.change(screen.getAllByRole('combobox')[0], { target: { value: 'minimax' } })

    expect(screen.getAllByDisplayValue('MiniMax').length).toBeGreaterThanOrEqual(1)
    expect(screen.getAllByDisplayValue('https://api.minimaxi.com/anthropic')).toHaveLength(2)
    expect(screen.getByDisplayValue('https://api.minimaxi.com/v1')).toBeInTheDocument()
    expect(screen.getByDisplayValue('MiniMax-M3')).toBeInTheDocument()
    expect(screen.getByDisplayValue(
      'MiniMax-M3, MiniMax-M2.7, MiniMax-M2.7-highspeed, MiniMax-M2.5, MiniMax-M2.5-highspeed, MiniMax-M2.1, MiniMax-M2.1-highspeed, MiniMax-M2',
    )).toBeInTheDocument()
  })

  it('opens embedding provider setup with the Cohere preset', async () => {
    listMock.mockResolvedValue([])
    render(<ModelProvidersPage />)
    await screen.findByText(EMPTY)
    fireEvent.click(screen.getByRole('button', { name: /add embedding provider/i }))

    expect(screen.getByRole('heading', { name: /add embedding provider/i })).toBeInTheDocument()
    expect(screen.getAllByRole('combobox')[0]).toHaveValue('cohere_embedding')
    expect(screen.getByDisplayValue('1536')).toBeInTheDocument()
    expect(screen.getAllByDisplayValue('Cohere Embeddings').length).toBeGreaterThanOrEqual(1)
    expect(screen.getByDisplayValue('https://api.cohere.com')).toBeInTheDocument()
    expect(screen.getAllByDisplayValue('embed-v4.0').length).toBeGreaterThanOrEqual(1)
    expect(screen.queryByText(/api protocol/i)).toBeNull()
    expect(screen.queryByText(/claude-compatible url/i)).toBeNull()
    expect(screen.queryByText(/openai-compatible url/i)).toBeNull()
    expect(screen.queryByDisplayValue('rerank-v4.0-pro')).toBeNull()
  })

  it('opens rerank provider setup with the Cohere preset', async () => {
    listMock.mockResolvedValue([])
    render(<ModelProvidersPage />)
    await screen.findByText(EMPTY)
    fireEvent.click(screen.getByRole('button', { name: /add rerank provider/i }))

    expect(screen.getByRole('heading', { name: /add rerank provider/i })).toBeInTheDocument()
    expect(screen.getAllByRole('combobox')[0]).toHaveValue('cohere_rerank')
    expect(screen.getAllByDisplayValue('Cohere Rerank').length).toBeGreaterThanOrEqual(1)
    expect(screen.getByDisplayValue('https://api.cohere.com')).toBeInTheDocument()
    expect(screen.getAllByDisplayValue('rerank-v4.0-pro').length).toBeGreaterThanOrEqual(1)
    expect(screen.queryByText(/api protocol/i)).toBeNull()
    expect(screen.queryByText(/embedding dimensions/i)).toBeNull()
    expect(screen.queryByText(/claude-compatible url/i)).toBeNull()
    expect(screen.queryByText(/openai-compatible url/i)).toBeNull()
  })

  it('creates an embedding provider and configures dimensions plus task policy', async () => {
    listMock.mockResolvedValue([])
    createFromPresetMock.mockResolvedValue({ provider: {
      ...provider,
      id: 'co-embed',
      name: 'Cohere Embeddings',
      provider_type: 'cohere',
      base_url: 'https://api.cohere.com',
      default_model: 'embed-v4.0',
      available_models: ['embed-v4.0'],
    } })
    render(<ModelProvidersPage />)
    await screen.findByText(EMPTY)
    fireEvent.click(screen.getByRole('button', { name: /add embedding provider/i }))
    fireEvent.change(screen.getByPlaceholderText('sk-...'), { target: { value: 'co-key' } })
    fireEvent.submit(screen.getByRole('button', { name: /add provider/i }).closest('form') as HTMLFormElement)

    await waitFor(() => expect(createFromPresetMock).toHaveBeenCalled())
    expect(createFromPresetMock).toHaveBeenCalledWith(expect.objectContaining({
      preset_id: 'cohere_embedding',
      name: 'Cohere Embeddings',
      api_key: 'co-key',
      default_model: 'embed-v4.0',
      available_models: ['embed-v4.0'],
      embedding_dimensions: 1536,
      network_profile_id: null,
    }))
    expect(createMock).not.toHaveBeenCalled()
    expect(await screen.findByText('Cohere Embeddings')).toBeInTheDocument()
    expect(listMock).toHaveBeenCalledTimes(1)
  })

  it('offers only vendors the server says can chat, and never a subscription-only one', async () => {
    // Gate 18. A Codex provider is connected in the subscriptions panel, not by
    // pasting an API key, so it must not appear in this picker — and gate 17:
    // a vendor the registry publishes an endpoint for pre-fills that endpoint,
    // which the hardcoded list could not do for DeepSeek.
    listMock.mockResolvedValue([])
    render(<ModelProvidersPage />)
    await screen.findByText(EMPTY)
    fireEvent.click(screen.getByRole('button', { name: /add chat provider/i }))

    const selects = await screen.findAllByRole('combobox')
    const vendorSelect = selects.find(select =>
      Array.from(select.querySelectorAll('option')).some(option => option.getAttribute('value') === 'deepseek'),
    )
    expect(vendorSelect, 'the vendor picker should be rendered for a custom chat provider').toBeTruthy()
    const values = Array.from(vendorSelect!.querySelectorAll('option')).map(option => option.getAttribute('value'))
    expect(values).toContain('deepseek')
    expect(values).not.toContain('openai_codex')
    // Retrieval-only vendors are not chat vendors.
    expect(values).not.toContain('cohere')

    fireEvent.change(vendorSelect!, { target: { value: 'deepseek' } })
    const baseUrlInput = await screen.findByPlaceholderText('https://api.deepseek.com')
    expect(baseUrlInput).toHaveValue('https://api.deepseek.com')

    createMock.mockResolvedValue({
      ...provider,
      id: 'deepseek-1',
      name: 'deepseek',
      provider_type: 'deepseek',
      base_url: 'https://api.deepseek.com',
    })
    fireEvent.change(screen.getByPlaceholderText('sk-...'), { target: { value: 'deepseek-key' } })
    fireEvent.submit(screen.getByRole('button', { name: /add provider/i }).closest('form') as HTMLFormElement)
    await waitFor(() => expect(createMock).toHaveBeenCalledWith(expect.objectContaining({
      provider_type: 'deepseek',
      base_url: 'https://api.deepseek.com',
    })))
  })

  it('refuses to configure a provider when the vendor registry did not load', async () => {
    // Without the registry the form cannot say which vendors exist or which
    // need a key, so an empty picker would silently drop the key requirement.
    listMock.mockResolvedValue([])
    vendorsMock.mockRejectedValue(new Error('registry offline'))
    render(<ModelProvidersPage />)
    await screen.findByText(EMPTY)
    expect(screen.getByRole('button', { name: /add chat provider/i })).toBeDisabled()
    expect(screen.getByRole('button', { name: /add embedding provider/i })).toBeDisabled()
    expect(screen.getByRole('button', { name: /add rerank provider/i })).toBeDisabled()
    expect(toast.error).toHaveBeenCalledWith('Provider catalog unavailable: registry offline')
  })

  it('ignores a provider load that completes after the active space changes', async () => {
    let resolveFirstLoad!: (providers: typeof provider[]) => void
    listMock
      .mockImplementationOnce(() => new Promise<typeof provider[]>(resolve => { resolveFirstLoad = resolve }))
      .mockResolvedValueOnce([{ ...provider, id: 'p2', space_id: 'team-2', name: 'Team Provider' }])

    const view = render(<ModelProvidersPage />)
    activeSpace.id = 'team-2'
    activeSpace.name = 'Team'
    view.rerender(<ModelProvidersPage />)

    expect(await screen.findByText('Team Provider')).toBeInTheDocument()
    resolveFirstLoad([{ ...provider, name: 'Stale Personal Provider' }])

    await waitFor(() => expect(listMock).toHaveBeenCalledTimes(2))
    expect(screen.queryByText('Stale Personal Provider')).toBeNull()
    expect(screen.getByText('Team Provider')).toBeInTheDocument()
  })
})
