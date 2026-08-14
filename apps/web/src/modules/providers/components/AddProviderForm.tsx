import { useState, type FormEvent } from 'react'
import { Loader2, Plus } from 'lucide-react'
import { toast } from 'sonner'
import { providersApi, type ModelProviderOut, type ProviderPresetOut, type ProviderType, type ProviderVendorOut } from '../../../api/client'
import { Button } from '../../../components/ui/button'
import { Input } from '../../../components/ui/input'
import { errMsg } from '../../../lib/utils'
import NetworkProfileSelector from '../../network_profiles/NetworkProfileSelector'
import {
  apiKeyRequiredForVendor,
  defaultBaseUrl,
  defaultEmbeddingDimensions,
  embeddingDimensionOptions,
  modelFieldCopy,
} from '../providerMetadata'
import type { AddProviderMode } from '../types'
import { ProviderCapabilityNotice } from './ProviderCapability'
import ProviderTypeSelect from './ProviderTypeSelect'

const CUSTOM_PRESET_ID = 'custom'

export default function AddProviderForm({
  onAdded,
  canCreate,
  mode,
  setMode,
  presets,
  vendors,
}: {
  onAdded: (provider: ModelProviderOut) => void
  canCreate: boolean
  mode: AddProviderMode | null
  setMode: (v: AddProviderMode | null) => void
  presets: ProviderPresetOut[]
  vendors: readonly ProviderVendorOut[]
}) {
  const [presetId, setPresetId] = useState(CUSTOM_PRESET_ID)
  const [name, setName] = useState('')
  const [providerType, setProviderType] = useState<ProviderType>('openai')
  const [apiKey, setApiKey] = useState('')
  const [defaultModel, setDefaultModel] = useState('')
  const [availableModels, setAvailableModels] = useState('')
  const [baseUrl, setBaseUrl] = useState('')
  const [claudeCompatibleBaseUrl, setClaudeCompatibleBaseUrl] = useState('')
  const [openAiCompatibleBaseUrl, setOpenAiCompatibleBaseUrl] = useState('')
  const [networkProfileId, setNetworkProfileId] = useState<string | null>(null)
  const [embeddingDimensions, setEmbeddingDimensions] = useState('1536')
  const [isDefault, setIsDefault] = useState(false)
  const [saving, setSaving] = useState(false)

  function resetProviderFields() {
    setPresetId(CUSTOM_PRESET_ID)
    setName('')
    setProviderType('openai')
    setApiKey('')
    setDefaultModel('')
    setAvailableModels('')
    setBaseUrl('')
    setClaudeCompatibleBaseUrl('')
    setOpenAiCompatibleBaseUrl('')
    setNetworkProfileId(null)
    setEmbeddingDimensions('1536')
    setIsDefault(false)
  }

  function reset() {
    resetProviderFields()
    setMode(null)
  }

  function presetById(id: string): ProviderPresetOut | null {
    return presets.find(candidate => candidate.id === id) ?? null
  }

  function firstPresetForMode(nextMode: AddProviderMode): ProviderPresetOut | null {
    const preferredId = nextMode === 'embedding'
      ? 'cohere_embedding'
      : nextMode === 'rerank'
        ? 'cohere_rerank'
        : null
    return (preferredId ? presetById(preferredId) : null)
      ?? presets.find(candidate => candidate.mode === nextMode)
      ?? null
  }

  function applyPreset(nextPresetId: string) {
    setPresetId(nextPresetId)
    if (nextPresetId === CUSTOM_PRESET_ID) {
      resetProviderFields()
      return
    }
    const preset = presetById(nextPresetId)
    if (!preset) return
    setName(preset.name)
    setProviderType(preset.provider_type)
    setBaseUrl(preset.base_url)
    setClaudeCompatibleBaseUrl(preset.claude_compatible_base_url ?? '')
    setOpenAiCompatibleBaseUrl(preset.openai_compatible_base_url ?? '')
    setDefaultModel(preset.default_model ?? '')
    setAvailableModels((preset.available_models ?? []).join(', '))
    if (preset.mode === 'embedding') {
      setEmbeddingDimensions(String(preset.embedding_dimensions ?? defaultEmbeddingDimensions(preset.provider_type)))
    }
  }

  function startAdd(nextMode: AddProviderMode) {
    resetProviderFields()
    setMode(nextMode)
    if (nextMode === 'chat') return
    const preset = firstPresetForMode(nextMode)
    if (preset) applyPreset(preset.id)
  }

  async function handleSubmit(event: FormEvent) {
    event.preventDefault()
    if (!canCreate) {
      toast.error('Select an operational space before adding a provider')
      return
    }
    const selectedPreset = presetId === CUSTOM_PRESET_ID ? null : presetById(presetId)
    const keyRequired = selectedPreset?.api_key_required ?? apiKeyRequiredForVendor(providerType, vendors)
    if (keyRequired && !apiKey.trim()) {
      toast.error('API key is required for this provider type')
      return
    }
    if (!selectedPreset && !baseUrl.trim()) {
      toast.error('Base URL is required')
      return
    }
    if (mode !== 'chat' && !selectedPreset) {
      toast.error('Select a provider preset')
      return
    }

    const parsedDimensions = Number(embeddingDimensions)
    if (mode === 'embedding' && (!Number.isInteger(parsedDimensions) || parsedDimensions < 64 || parsedDimensions > 4096)) {
      toast.error('Embedding dimensions must be between 64 and 4096')
      return
    }

    setSaving(true)
    try {
      const models = availableModels
        ? availableModels.split(',').map(model => model.trim()).filter(Boolean)
        : defaultModel ? [defaultModel.trim()] : []
      let provider: ModelProviderOut
      if (selectedPreset) {
        const response = await providersApi.createFromPreset({
          preset_id: selectedPreset.id,
          api_key: apiKey.trim() || undefined,
          name: name.trim() || undefined,
          default_model: defaultModel.trim() || undefined,
          available_models: models,
          embedding_dimensions: mode === 'embedding' ? parsedDimensions : undefined,
          network_profile_id: networkProfileId,
          is_default: isDefault,
        })
        provider = response.provider
      } else {
        provider = await providersApi.create({
          name: name.trim() || providerType,
          provider_type: providerType,
          api_key: apiKey.trim() || undefined,
          default_model: defaultModel.trim() || undefined,
          available_models: models,
          base_url: baseUrl.trim(),
          network_profile_id: networkProfileId,
          claude_compatible_base_url: claudeCompatibleBaseUrl.trim() || undefined,
          openai_compatible_base_url: openAiCompatibleBaseUrl.trim() || undefined,
          is_default: isDefault,
        })
      }
      toast.success('Provider added')
      reset()
      onAdded(provider)
    } catch (error) {
      toast.error(errMsg(error))
    } finally {
      setSaving(false)
    }
  }

  const selectedPreset = presetId === CUSTOM_PRESET_ID ? null : presetById(presetId)
  const modelCopy = modelFieldCopy(providerType, mode ?? undefined)
  const keyRequired = selectedPreset?.api_key_required ?? apiKeyRequiredForVendor(providerType, vendors)

  if (!mode) {
    return (
      <div className="flex flex-wrap gap-2">
        <Button variant="outline" size="sm" onClick={() => startAdd('chat')} disabled={!canCreate}>
          <Plus className="size-3.5 mr-1.5" />
          Add chat provider
        </Button>
        <Button variant="outline" size="sm" onClick={() => startAdd('embedding')} disabled={!canCreate}>
          <Plus className="size-3.5 mr-1.5" />
          Add embedding provider
        </Button>
        <Button variant="outline" size="sm" onClick={() => startAdd('rerank')} disabled={!canCreate}>
          <Plus className="size-3.5 mr-1.5" />
          Add rerank provider
        </Button>
      </div>
    )
  }

  const availablePresets = presets.filter(preset => preset.mode === mode)
  const allowCustomPreset = mode === 'chat'
  const formTitle = mode === 'embedding'
    ? 'Add embedding provider'
    : mode === 'rerank'
      ? 'Add rerank provider'
      : 'Add chat provider'
  const dimensionOptions = selectedPreset?.embedding_dimension_options?.length
    ? selectedPreset.embedding_dimension_options
    : embeddingDimensionOptions(providerType)

  if (vendors.length === 0) {
    // Reached only when the registry failed to load. Offering a picker with no
    // options would also drop the API-key requirement, since that fact is the
    // registry's too.
    return (
      <div className="rounded-md border border-border bg-muted/60 px-3 py-2 text-xs text-muted-foreground">
        Provider vendors could not be loaded, so a new provider cannot be configured right now. Reload to try again.
      </div>
    )
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-3 p-4 border border-border rounded-lg bg-accent/30">
      <div>
        <h2 className="text-sm font-medium text-foreground">{formTitle}</h2>
        <p className="text-xs text-muted-foreground">
          {mode === 'embedding'
            ? 'Configure an embedding endpoint for vector retrieval and backfill.'
            : mode === 'rerank'
              ? 'Configure a native rerank endpoint for hybrid rerank.'
              : 'Configure a chat-compatible endpoint for agents, synthesis, and model calls.'}
        </p>
      </div>
      <div className="space-y-1.5">
        <label className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider">Preset</label>
        <select
          value={presetId}
          onChange={event => applyPreset(event.target.value)}
          className="flex h-9 w-full rounded-md border border-border bg-input px-3 text-sm"
        >
          {allowCustomPreset && <option value={CUSTOM_PRESET_ID}>Custom</option>}
          {availablePresets.map(preset => (
            <option key={preset.id} value={preset.id}>{preset.label}</option>
          ))}
        </select>
      </div>
      {mode === 'chat' && !selectedPreset && (
        <div className="space-y-1.5">
          <label className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider">API protocol</label>
          <ProviderTypeSelect value={providerType} mode={mode} vendors={vendors} onChange={value => {
            setPresetId(CUSTOM_PRESET_ID)
            setProviderType(value)
            setBaseUrl(defaultBaseUrl(value, vendors))
          }} />
        </div>
      )}
      <ProviderCapabilityNotice providerType={providerType} vendors={vendors} mode={mode} />
      <div className="space-y-1.5">
        <label className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider">Display name</label>
        <Input value={name} onChange={event => setName(event.target.value)} placeholder="My OpenAI" className="text-sm" />
      </div>
      <div className="space-y-1.5">
        <label className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider">Base URL</label>
        <Input
          value={baseUrl}
          onChange={event => setBaseUrl(event.target.value)}
          placeholder={defaultBaseUrl(providerType, vendors) || 'https://gateway.example/v1'}
          className="font-mono text-sm"
          required={!selectedPreset}
          disabled={Boolean(selectedPreset)}
        />
      </div>
      {mode === 'chat' && (
        <>
          <div className="space-y-1.5">
            <label className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider">Claude-compatible URL (optional)</label>
            <Input value={claudeCompatibleBaseUrl} onChange={event => setClaudeCompatibleBaseUrl(event.target.value)} placeholder="https://api.example.com/anthropic" className="font-mono text-sm" disabled={Boolean(selectedPreset)} />
          </div>
          <div className="space-y-1.5">
            <label className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider">OpenAI-compatible URL (optional)</label>
            <Input value={openAiCompatibleBaseUrl} onChange={event => setOpenAiCompatibleBaseUrl(event.target.value)} placeholder="https://api.example.com/v1" className="font-mono text-sm" disabled={Boolean(selectedPreset)} />
          </div>
        </>
      )}
      <div className="space-y-1.5">
        <label className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider">Network</label>
        <NetworkProfileSelector value={networkProfileId} onChange={setNetworkProfileId} />
      </div>
      <div className="space-y-1.5">
        <label className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider">
          API Key {keyRequired ? '(required)' : '(optional)'}
        </label>
        <Input type="password" value={apiKey} onChange={event => setApiKey(event.target.value)} placeholder="sk-..." className="font-mono text-sm" />
      </div>
      <div className="space-y-1.5">
        <label className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider">{modelCopy.defaultLabel}</label>
        <Input value={defaultModel} onChange={event => setDefaultModel(event.target.value)} placeholder={modelCopy.defaultPlaceholder} className="font-mono text-sm" />
      </div>
      <div className="space-y-1.5">
        <label className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider">{modelCopy.availableLabel}</label>
        <Input value={availableModels} onChange={event => setAvailableModels(event.target.value)} placeholder={modelCopy.availablePlaceholder} className="font-mono text-sm" />
        <p className="text-xs text-muted-foreground">{modelCopy.help}</p>
      </div>
      {mode === 'embedding' && (
        <div className="space-y-1.5">
          <label className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider">Embedding dimensions</label>
          <select
            value={embeddingDimensions}
            onChange={event => setEmbeddingDimensions(event.target.value)}
            className="flex h-9 w-full rounded-md border border-border bg-input px-3 text-sm"
          >
            {dimensionOptions.map(value => (
              <option key={value} value={String(value)}>{value}</option>
            ))}
          </select>
          <p className="text-xs text-muted-foreground">Saved to this space's Retrieval Settings and used for embedding backfill.</p>
        </div>
      )}
      <label className="flex items-center gap-2 text-[13px]">
        <input type="checkbox" checked={isDefault} onChange={event => setIsDefault(event.target.checked)} className="accent-primary" />
        Set as default provider
      </label>
      <div className="flex gap-2">
        <Button type="submit" size="sm" disabled={saving}>{saving ? <Loader2 className="size-3.5 animate-spin" /> : 'Add provider'}</Button>
        <Button type="button" size="sm" variant="outline" onClick={reset}>Cancel</Button>
      </div>
    </form>
  )
}
