import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'

const { listMock, presetsMock, createMock, createFromPresetMock } = vi.hoisted(() => ({
  listMock: vi.fn(),
  presetsMock: vi.fn(),
  createMock: vi.fn(),
  createFromPresetMock: vi.fn(),
}))

vi.mock('../api/client', () => ({
  authApi: { mySpaces: vi.fn().mockResolvedValue([]) },
  providersApi: { list: listMock, presets: presetsMock, create: createMock, createFromPreset: createFromPresetMock, delete: vi.fn(), test: vi.fn(), patch: vi.fn(), grant: vi.fn() },
}))

vi.mock('../contexts/SpaceContext', () => ({
  useSpace: () => ({ activeSpaceId: 'personal-1', activeSpaceName: 'My Personal' }),
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

describe('ModelProvidersPage — open add form takes over the view', () => {
  beforeEach(() => {
    listMock.mockReset()
    presetsMock.mockReset()
    createMock.mockReset()
    createFromPresetMock.mockReset()
    presetsMock.mockResolvedValue(providerPresets)
  })

  it('shows the empty-state when there are no providers and the form is closed', async () => {
    listMock.mockResolvedValue([])
    render(<ModelProvidersPage />)
    expect(await screen.findByText(EMPTY)).toBeInTheDocument()
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
    expect(await screen.findByText('My OpenAI')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /add chat provider/i }))
    // Existing providers are not shown mid-add.
    expect(screen.queryByText('My OpenAI')).toBeNull()
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
})
