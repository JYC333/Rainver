import { useEffect, useMemo, useState } from 'react'
import { useParams } from 'react-router-dom'
import { useSpaceNavigate as useNavigate, SpaceLink as Link } from '../../core/spaceNav'
import { ChevronDown, ChevronRight, Loader2, Plus } from 'lucide-react'
import { toast } from 'sonner'
import { agentTemplatesApi, agentsApi, providersApi, runtimeToolsApi, type ModelProviderOut } from '../../api/client'
import type {
  AgentTemplateOut,
  AgentTemplateVersionOut,
  CreateAgentFromTemplateBody,
  SpaceRuntimeToolPolicyOut,
} from '../../types/api'
import { useSpace } from '../../contexts/SpaceContext'
import ProviderSelector from '../providers/ProviderSelector'
import { Button } from '../../components/ui/button'
import { Input } from '../../components/ui/input'
import { Textarea } from '../../components/ui/textarea'
import { Card, CardTitle } from '../../components/ui/card'
import { Badge } from '../../components/ui/badge'
import { errMsg } from '../../lib/utils'
import { SafetyView } from './ConfigCards'
import {
  RetrievalToolDomainControls,
  mergeRetrievalToolDomains,
  type RetrievalToolDomainState,
} from './RetrievalToolDomainControls'
import {
  allowedInputContexts,
  allowedOutputTypes,
  buildContextPolicy,
  buildOutputPolicy,
  defaultInputContexts,
  inputContextLabel,
  isMemoryOutput,
  outputTypeLabel,
} from './policyMap'

const CREATE_NOTE: Record<string, string> = {
  activity_reflector: 'This agent processes captures / activity records into typed proposals and a reflection summary for review.',
}

function Toggle({ checked, onChange, label, note }: { checked: boolean; onChange: (v: boolean) => void; label: string; note?: string }) {
  return (
    <label className="flex items-center justify-between gap-2 py-1.5 text-sm cursor-pointer">
      <span>{label}{note && <span className="text-xs text-muted-foreground ml-2">{note}</span>}</span>
      <input type="checkbox" checked={checked} onChange={e => onChange(e.target.checked)} />
    </label>
  )
}

function RuntimeVersionSelector({
  runtime,
  policies,
  value,
  onChange,
}: {
  runtime: string
  policies: SpaceRuntimeToolPolicyOut[]
  value: string
  onChange: (value: string) => void
}) {
  const policy = policies.find(item => item.runtime === runtime)
  if (!policy) return null
  const versions = policy.installed_versions.filter(version => version.installed)
  return (
    <div className="space-y-1.5">
      <label className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider">CLI runtime version</label>
      <select
        value={value}
        onChange={e => onChange(e.target.value)}
        className="flex h-9 w-full rounded-md border border-border bg-input px-3 text-sm"
      >
        <option value="">Space default ({policy.default_version ?? 'none'})</option>
        {versions.map(version => (
          <option key={version.version} value={version.version}>{version.version}</option>
        ))}
      </select>
    </div>
  )
}

function scheduleFromConfig(config: Record<string, unknown> | null | undefined) {
  const cronStr = typeof config?.cron === 'string' ? config.cron : ''
  const daily = /^0 (\d{1,2}) \* \* \*$/.exec(cronStr)
  if (daily) {
    return {
      scheduleMode: 'daily' as const,
      dailyHour: daily[1].padStart(2, '0'),
      cron: cronStr,
      scheduleEnabled: config?.enabled === true,
    }
  }
  if (cronStr) {
    return {
      scheduleMode: 'cron' as const,
      dailyHour: '08',
      cron: cronStr,
      scheduleEnabled: config?.enabled === true,
    }
  }
  return {
    scheduleMode: 'manual' as const,
    dailyHour: '08',
    cron: '0 8 * * *',
    scheduleEnabled: false,
  }
}

export default function AgentFormPage() {
  const { templateId } = useParams()
  const navigate = useNavigate()
  const { activeSpaceId } = useSpace()
  const [template, setTemplate] = useState<AgentTemplateOut | null>(null)
  const [version, setVersion] = useState<AgentTemplateVersionOut | null>(null)
  const [loading, setLoading] = useState(Boolean(templateId))
  const [saving, setSaving] = useState(false)
  const [advancedOpen, setAdvancedOpen] = useState(false)

  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [systemPrompt, setSystemPrompt] = useState('')
  const [modelSelection, setModelSelection] = useState<{ provider_id: string; model: string } | null>(null)
  const [defaultProvider, setDefaultProvider] = useState<ModelProviderOut | null>(null)
  const [runtime, setRuntime] = useState<string>('model_api')
  const [runtimePolicies, setRuntimePolicies] = useState<SpaceRuntimeToolPolicyOut[]>([])
  const [runtimeToolVersion, setRuntimeToolVersion] = useState<string>('')
  const [scheduleMode, setScheduleMode] = useState<'manual' | 'daily' | 'cron'>('manual')
  const [dailyHour, setDailyHour] = useState('08')
  const [cron, setCron] = useState('0 8 * * *')
  const [scheduleEnabled, setScheduleEnabled] = useState(false)
  const [inputs, setInputs] = useState<Record<string, boolean>>({})
  const [outputs, setOutputs] = useState<Record<string, boolean>>({})
  const [maxTokens, setMaxTokens] = useState('')
  const [temperature, setTemperature] = useState('')
  const [retrievalToolDomains, setRetrievalToolDomains] = useState<RetrievalToolDomainState>({
    memory: false,
    project_public_summary: false,
    source: false,
  })

  useEffect(() => {
    Promise.all([
      runtimeToolsApi.spacePolicies().catch(() => [] as SpaceRuntimeToolPolicyOut[]),
      providersApi.list().catch(() => [] as ModelProviderOut[]),
    ])
      .then(([policies, providers]) => {
        setRuntimePolicies(policies)
        const provider = providers.find(p => p.is_default && p.enabled) ?? null
        setDefaultProvider(provider)
        if (provider?.default_model) {
          setModelSelection(prev => prev ?? { provider_id: provider.id, model: provider.default_model ?? '' })
        }
      })
      .catch(() => {
        setRuntimePolicies([])
        setDefaultProvider(null)
      })
  }, [])

  useEffect(() => {
    if (!templateId) {
      setLoading(false)
      return
    }
    setLoading(true)
    agentTemplatesApi.get(templateId)
      .then(async t => {
        setTemplate(t)
        setName(t.name)
        setDescription(t.description ?? '')
        if (!t.current_version_id) return
        const v = await agentTemplatesApi.getVersion(t.id, t.current_version_id)
        setVersion(v)
        setSystemPrompt('')
        const runtimePolicy = v.runtime_policy_json as Record<string, unknown>
        const nextRuntime = typeof runtimePolicy.default_adapter_type === 'string' ? runtimePolicy.default_adapter_type : 'model_api'
        setRuntime(nextRuntime)
        const modelConfig = v.model_config_json as Record<string, unknown>
        setMaxTokens(typeof modelConfig.max_tokens === 'number' ? String(modelConfig.max_tokens) : '')
        setTemperature(typeof modelConfig.temperature === 'number' ? String(modelConfig.temperature) : '')
        if (typeof modelConfig.model === 'string' && defaultProvider) {
          setModelSelection({ provider_id: defaultProvider.id, model: modelConfig.model })
        }
        const schedule = scheduleFromConfig(v.schedule_defaults_json as Record<string, unknown>)
        setScheduleMode(schedule.scheduleMode)
        setDailyHour(schedule.dailyHour)
        setCron(schedule.cron)
        setScheduleEnabled(schedule.scheduleEnabled)
        const enabledCtx = new Set(defaultInputContexts(v))
        setInputs(Object.fromEntries(allowedInputContexts(v).map(id => [id, enabledCtx.has(id)])))
        setOutputs(Object.fromEntries(allowedOutputTypes(v).map(id => [id, true])))
        setRetrievalToolDomains({ memory: false, project_public_summary: false, source: false })
      })
      .catch(err => toast.error(errMsg(err)))
      .finally(() => setLoading(false))
  }, [templateId])

  const enabledRuntimeSet = new Set(
    runtimePolicies
      .filter(policy =>
        policy.policy_id &&
        policy.enabled &&
        policy.installed_versions.some(version => version.installed),
      )
      .map(policy => policy.runtime),
  )
  const cliRuntimes = runtimePolicies.filter(policy => enabledRuntimeSet.has(policy.runtime))
  const runtimeOptions = useMemo(() => {
    const options = [
      { value: 'model_api', label: 'API — call a model provider (no tools)' },
      ...cliRuntimes.map(c => ({ value: c.runtime, label: `${c.runtime} (tools, filesystem)` })),
    ]
    if (!options.some(option => option.value === runtime)) {
      options.push({ value: runtime, label: `${runtime} (template default)` })
    }
    return options
  }, [cliRuntimes, runtime])

  const isCli = runtime !== 'model_api'
  const isClaudeCli = runtime === 'claude_code'
  const isCodexCli = runtime === 'codex_cli'
  const providerRequired = !isCli
  const showProviderSelector = !isCli || isClaudeCli || isCodexCli
  function buildScheduleConfig(): Record<string, unknown> {
    if (scheduleMode === 'manual') return { enabled: false, cron: null }
    if (scheduleMode === 'daily') return { enabled: scheduleEnabled, cron: `0 ${Number(dailyHour)} * * *` }
    return { enabled: scheduleEnabled, cron }
  }

  function buildContextConfig(): Record<string, unknown> {
    const base = version?.context_policy_json ?? {}
    const enabledInputs = Object.entries(inputs).filter(([, on]) => on).map(([key]) => key)
    return buildContextPolicy(base, enabledInputs)
  }

  function buildOutputConfig(): Record<string, unknown> {
    const base = version?.output_policy_json ?? {}
    const enabledOutputs = Object.entries(outputs).filter(([, on]) => on).map(([key]) => key)
    return buildOutputPolicy(base, enabledOutputs)
  }

  function buildModelConfig(): Record<string, unknown> {
    const cfg: Record<string, unknown> = { ...(version?.model_config_json ?? {}) }
    const selectedModel = modelSelection?.model?.trim()
    if (showProviderSelector && selectedModel) cfg.model = selectedModel
    else delete cfg.model
    if (maxTokens.trim()) cfg.max_tokens = Number(maxTokens)
    else delete cfg.max_tokens
    if (temperature.trim()) cfg.temperature = Number(temperature)
    else delete cfg.temperature
    return cfg
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!activeSpaceId) { toast.error('Select an operational space'); return }
    if (providerRequired && !modelSelection?.provider_id) {
      toast.error('Select a model provider for the API runtime')
      return
    }
    setSaving(true)
    try {
      const runtimeConfig = {
        adapter_type: runtime,
        ...(isCli && runtimeToolVersion ? { runtime_tool_version: runtimeToolVersion } : {}),
      }
      const runtimeConfigWithTools = mergeRetrievalToolDomains(runtimeConfig, retrievalToolDomains)
      const common = {
        name: name.trim(),
        description: description.trim() || null,
        system_prompt: systemPrompt.trim() || null,
        model_config_json: buildModelConfig(),
        schedule_config_json: buildScheduleConfig(),
        context_policy_json: buildContextConfig(),
        output_policy_json: buildOutputConfig(),
      }
      const created = templateId
        ? await agentTemplatesApi.createAgent(templateId, {
            ...common,
            adapter_type: runtime,
            runtime_config_json: runtimeConfigWithTools,
            default_model_provider_id: showProviderSelector ? (modelSelection?.provider_id ?? null) : null,
            default_model: showProviderSelector ? (modelSelection?.model || null) : null,
          } satisfies CreateAgentFromTemplateBody)
        : await agentsApi.create({
            ...common,
            adapter_type: runtime,
            runtime_config_json: runtimeConfigWithTools,
            default_model_provider_id: showProviderSelector ? (modelSelection?.provider_id ?? null) : null,
            default_model: showProviderSelector ? (modelSelection?.model || null) : null,
          })
      toast.success('Agent created')
      navigate(`/agents/${created.id}`)
    } catch (err) {
      toast.error(errMsg(err))
    } finally {
      setSaving(false)
    }
  }

  function handleRuntimeChange(next: string) {
    setRuntime(next)
    const policy = runtimePolicies.find(p => p.runtime === next)
    setRuntimeToolVersion(policy?.default_version ?? '')
  }

  if (loading) {
    return <div className="p-6 flex items-center gap-2 text-muted-foreground"><Loader2 className="size-4 animate-spin" /> Loading…</div>
  }

  const previewVersion = {
    context_policy_json: buildContextConfig(),
    output_policy_json: buildOutputConfig(),
    memory_policy_json: version?.memory_policy_json ?? {},
    tool_policy_json: version?.tool_policy_json ?? {},
  }

  return (
    <div className="p-6 max-w-2xl space-y-6">
      <div>
        <h1 className="text-xl font-semibold">{template ? `New agent: ${template.name}` : 'New agent'}</h1>
        <p className="text-sm text-muted-foreground">
          {template
            ? "Template defaults are prefilled below. Adjust them before creating the agent."
            : <>Configure the agent below, or <Link to="/agents/templates" className="underline">start from a template</Link>.</>}
        </p>
        {template?.key && CREATE_NOTE[template.key] && (
          <p className="mt-2 text-sm rounded-md border border-border bg-accent/30 px-3 py-2">{CREATE_NOTE[template.key]}</p>
        )}
      </div>

      <form onSubmit={handleSubmit} className="space-y-6">
        <Card className="p-4 space-y-4">
          <CardTitle>Agent</CardTitle>
          <div className="space-y-1.5">
            <label className="text-[11px] font-medium text-muted-foreground uppercase">Name</label>
            <Input value={name} onChange={e => setName(e.target.value)} required />
          </div>
          <div className="space-y-1.5">
            <label className="text-[11px] font-medium text-muted-foreground uppercase">Description</label>
            <Input value={description} onChange={e => setDescription(e.target.value)} />
          </div>
          <div className="space-y-1.5">
            <label className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider">System prompt</label>
            <Textarea
              value={systemPrompt}
              onChange={e => setSystemPrompt(e.target.value)}
              rows={4}
              placeholder="You are a daily news summarizer. Be concise and factual..."
            />
          </div>
        </Card>

        <Card className="p-4 space-y-4">
          <CardTitle>Runtime &amp; model</CardTitle>
          <div className="space-y-1.5">
            <label className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider">Runtime</label>
            <select
              value={runtime}
              onChange={e => handleRuntimeChange(e.target.value)}
              className="flex h-9 w-full rounded-md border border-border bg-input px-3 text-sm"
            >
              {runtimeOptions.map(option => (
                <option key={option.value} value={option.value}>{option.label}</option>
              ))}
            </select>
            <p className="text-xs text-muted-foreground">
              {isCli
                ? isClaudeCli
                  ? 'Uses Claude Code login by default; optionally select a Claude-compatible provider below.'
                  : isCodexCli
                    ? 'Uses Codex login by default; optionally select an OpenAI-compatible provider below.'
                    : 'Uses the CLI with its own login; the model is managed by the CLI runtime.'
                : 'Runs a prompt against a configured model provider. Pick the provider below.'}
            </p>
          </div>
          {isCli && (
            <RuntimeVersionSelector
              runtime={runtime}
              policies={runtimePolicies}
              value={runtimeToolVersion}
              onChange={setRuntimeToolVersion}
            />
          )}
          {showProviderSelector && (
            <ProviderSelector
              value={modelSelection}
              onChange={setModelSelection}
              required={providerRequired}
              requireClaudeCompatible={isClaudeCli}
              requireOpenAiCompatible={isCodexCli}
              emptyLabel={isClaudeCli ? 'Claude Code default' : isCodexCli ? 'Codex default' : defaultProvider?.default_model ? 'System default provider' : undefined}
            />
          )}
          <RetrievalToolDomainControls
            value={retrievalToolDomains}
            onChange={setRetrievalToolDomains}
          />
        </Card>

        <Card className="p-4 space-y-3">
          <CardTitle>Schedule</CardTitle>
          <div className="space-y-1.5">
            <label className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider">Cadence</label>
            <select value={scheduleMode} onChange={e => setScheduleMode(e.target.value as typeof scheduleMode)} className="flex h-9 w-full rounded-md border border-border bg-input px-3 text-sm">
              <option value="manual">Manual only</option>
              <option value="daily">Daily</option>
              <option value="cron">Custom cron</option>
            </select>
          </div>
          {scheduleMode === 'daily' && (
            <div className="space-y-1.5">
              <label className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider">Hour (UTC)</label>
              <Input value={dailyHour} onChange={e => setDailyHour(e.target.value)} className="w-24" />
            </div>
          )}
          {scheduleMode === 'cron' && (
            <div className="space-y-1.5">
              <label className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider">Cron expression</label>
              <Input value={cron} onChange={e => setCron(e.target.value)} className="font-mono" />
            </div>
          )}
          {scheduleMode !== 'manual' && (
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={scheduleEnabled} onChange={e => setScheduleEnabled(e.target.checked)} /> Enabled
            </label>
          )}
        </Card>

        <Card className="p-4">
          <button type="button" onClick={() => setAdvancedOpen(o => !o)} className="flex w-full items-center gap-2 text-sm font-medium">
            {advancedOpen ? <ChevronDown className="size-4" /> : <ChevronRight className="size-4" />}
            Advanced settings
            <span className="text-xs font-normal text-muted-foreground">inputs, outputs &amp; limits</span>
          </button>
          {advancedOpen && (
            <div className="mt-4 space-y-5">
              <div>
                <p className="text-sm font-medium mb-1">Inputs</p>
                {version && allowedInputContexts(version).length > 0 ? (
                  <div className="divide-y divide-border">
                    {allowedInputContexts(version).map(id => (
                      <Toggle key={id} label={inputContextLabel(id)} checked={Boolean(inputs[id])} onChange={v => setInputs(s => ({ ...s, [id]: v }))} />
                    ))}
                  </div>
                ) : (
                  <p className="text-xs text-muted-foreground">No durable input contexts are preconfigured.</p>
                )}
              </div>

              <div>
                <p className="text-sm font-medium mb-1">Allowed outputs</p>
                {version && allowedOutputTypes(version).length > 0 ? (
                  <div className="divide-y divide-border">
                    {allowedOutputTypes(version).map(id => (
                      <Toggle
                        key={id}
                        label={outputTypeLabel(id)}
                        note={isMemoryOutput(id) ? 'always review' : undefined}
                        checked={Boolean(outputs[id])}
                        onChange={v => setOutputs(s => ({ ...s, [id]: v }))}
                      />
                    ))}
                  </div>
                ) : (
                  <p className="text-xs text-muted-foreground">No durable output types are preconfigured.</p>
                )}
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <label className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider">Max tokens</label>
                  <Input value={maxTokens} onChange={e => setMaxTokens(e.target.value)} placeholder="8192" />
                </div>
                <div className="space-y-1.5">
                  <label className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider">Temperature</label>
                  <Input value={temperature} onChange={e => setTemperature(e.target.value)} placeholder="(default)" />
                </div>
              </div>

              <div className="border-t border-border pt-4">
                <SafetyView version={previewVersion} />
                {version && (
                  <p className="mt-2 text-xs text-muted-foreground">
                    <Badge variant="muted">locked</Badge>{' '}
                    Direct memory write, proposal-only outputs, and tool/shell access stay as the template defines them.
                  </p>
                )}
              </div>
            </div>
          )}
        </Card>

        <div className="flex gap-2">
          <Button type="submit" disabled={saving}>{saving ? <Loader2 className="size-4 animate-spin" /> : 'Create agent'}</Button>
          <Button type="button" variant="outline" asChild><Link to={template ? '/agents/templates' : '/agents'}>Cancel</Link></Button>
          {!template && (
            <Button type="button" variant="ghost" asChild>
              <Link to="/agents/templates"><Plus className="size-3.5 mr-1" /> Templates</Link>
            </Button>
          )}
        </div>
      </form>
    </div>
  )
}
