import { useEffect, useState } from 'react'
import { useParams, useSearchParams } from 'react-router-dom'
import { useSpaceNavigate as useNavigate, SpaceLink as Link } from '../../core/spaceNav'
import { ChevronDown, ChevronRight, Loader2, Plus } from 'lucide-react'
import { toast } from 'sonner'
import { agentTemplatesApi, agentsApi, projectsApi } from '../../api/client'
import type {
  AgentTemplateOut,
  AgentTemplateVersionOut,
  CreateAgentFromTemplateBody,
  Project,
} from '../../types/api'
import { useSpace } from '../../contexts/SpaceContext'
import { Button } from '../../components/ui/button'
import { Input } from '../../components/ui/input'
import { Select } from '../../components/ui/select'
import { Textarea } from '../../components/ui/textarea'
import { Card, CardTitle } from '../../components/ui/card'
import { Badge } from '../../components/ui/badge'
import { errMsg } from '../../lib/utils'
import { SafetyView } from './ConfigCards'
import {
  ScheduleEditorFields,
  scheduleConfigFromEditor,
  scheduleEditorFromConfig,
  type ScheduleEditorValue,
} from './ScheduleEditor'
import {
  RetrievalToolDomainControls,
  mergeRetrievalToolDomains,
  readRetrievalToolDomains,
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

export default function AgentFormPage() {
  const { templateId } = useParams()
  const [searchParams] = useSearchParams()
  const navigate = useNavigate()
  const { activeSpaceId } = useSpace()
  const [template, setTemplate] = useState<AgentTemplateOut | null>(null)
  const [version, setVersion] = useState<AgentTemplateVersionOut | null>(null)
  const [loading, setLoading] = useState(Boolean(templateId))
  const [saving, setSaving] = useState(false)
  const [advancedOpen, setAdvancedOpen] = useState(false)
  const [projects, setProjects] = useState<Project[]>([])
  const [selectedProjectId, setSelectedProjectId] = useState(searchParams.get('project') ?? '')
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [systemPrompt, setSystemPrompt] = useState('')
  const [schedule, setSchedule] = useState<ScheduleEditorValue>(() => scheduleEditorFromConfig(null))
  const [riskLevel, setRiskLevel] = useState<'low' | 'medium' | 'high' | 'critical'>('medium')
  const [maxRunTimeSeconds, setMaxRunTimeSeconds] = useState(300)
  const [inputs, setInputs] = useState<Record<string, boolean>>({})
  const [outputs, setOutputs] = useState<Record<string, boolean>>({})
  const [retrievalToolDomains, setRetrievalToolDomains] = useState<RetrievalToolDomainState>({
    memory: false,
    project_public_summary: false,
    source: false,
  })

  useEffect(() => {
    if (templateId) return
    projectsApi.list({ status: 'active', limit: 100 })
      .then(page => setProjects(page.items))
      .catch(() => setProjects([]))
  }, [templateId])

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
        setRiskLevel(v.execution_constraints.risk_level)
        setMaxRunTimeSeconds(v.execution_constraints.max_run_time_seconds)
        setSystemPrompt('')
        setSchedule(scheduleEditorFromConfig(v.schedule_defaults_json))
        const enabledCtx = new Set(defaultInputContexts(v))
        setInputs(Object.fromEntries(allowedInputContexts(v).map(id => [id, enabledCtx.has(id)])))
        setOutputs(Object.fromEntries(allowedOutputTypes(v).map(id => [id, true])))
        setRetrievalToolDomains(readRetrievalToolDomains(v.tool_policy_json))
      })
      .catch(err => toast.error(errMsg(err)))
      .finally(() => setLoading(false))
  }, [templateId])
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

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!activeSpaceId) { toast.error('Select an operational space'); return }
    setSaving(true)
    try {
      const toolPolicy = mergeRetrievalToolDomains(version?.tool_policy_json ?? {}, retrievalToolDomains)
      const common = {
        name: name.trim(),
        description: description.trim() || null,
        system_prompt: systemPrompt.trim() || null,
        schedule_config_json: scheduleConfigFromEditor(schedule),
        context_policy_json: buildContextConfig(),
        output_policy_json: buildOutputConfig(),
        tool_policy_json: toolPolicy,
        execution_constraints: {
          risk_level: riskLevel,
          max_run_time_seconds: maxRunTimeSeconds,
        },
      }
      const created = templateId
        ? await agentTemplatesApi.createAgent(templateId, {
            ...common,
          } satisfies CreateAgentFromTemplateBody)
        : await agentsApi.create({
          ...common,
            project_id: selectedProjectId || null,
          })
      toast.success('Agent created')
      navigate(`/agents/${created.id}`)
    } catch (err) {
      toast.error(errMsg(err))
    } finally {
      setSaving(false)
    }
  }

  if (loading) {
    return <div className="p-6 flex items-center gap-2 text-muted-foreground"><Loader2 className="size-4 animate-spin" /> Loading…</div>
  }

  const previewVersion = {
    context_policy_json: buildContextConfig(),
    output_policy_json: buildOutputConfig(),
    memory_policy_json: version?.memory_policy_json ?? {},
    tool_policy_json: mergeRetrievalToolDomains(version?.tool_policy_json ?? {}, retrievalToolDomains),
    risk_level: riskLevel,
    max_run_time_seconds: maxRunTimeSeconds,
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
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <span className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider">Run risk</span>
              <Select
                ariaLabel="Run risk"
                value={riskLevel}
                onChange={value => setRiskLevel(value as typeof riskLevel)}
                options={[
                  { value: 'low', label: 'Low' },
                  { value: 'medium', label: 'Medium' },
                  // Risk requires trust, and no runtime or Host reaches `high`
                  // today (ROUTING.md, "Effective trust"), so either of these
                  // leaves the Agent with no eligible candidate anywhere.
                  { value: 'high', label: 'High · no execution target reaches high trust yet', disabled: true },
                  { value: 'critical', label: 'Critical · no execution target reaches high trust yet', disabled: true },
                ]}
              />
              <p className="text-xs text-muted-foreground">
                High and critical risk require a high-trust execution target. Neither the Server Runtime nor a paired Host provides one yet, so an Agent set to either would never route.
              </p>
            </div>
            <label className="space-y-1.5">
              <span className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider">Maximum run time (seconds)</span>
              <Input
                aria-label="Maximum run time (seconds)"
                type="number"
                min={1}
                max={3600}
                step={1}
                value={maxRunTimeSeconds}
                onChange={event => setMaxRunTimeSeconds(Number(event.target.value))}
                required
              />
            </label>
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
          {!templateId && (
            <div className="space-y-1.5">
              <label className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider">Project (optional)</label>
              <Select
                ariaLabel="Project (optional)"
                value={selectedProjectId}
                onChange={setSelectedProjectId}
                options={[
                  { value: '', label: 'No Project — personal Agent' },
                  ...projects.map(project => ({ value: project.id, label: project.name })),
                ]}
              />
              <p className="text-xs text-muted-foreground">A Project is required for a Project Location. Managed workspaces are Space-level and do not need a Project.</p>
            </div>
          )}
        </Card>

        <Card className="p-4 space-y-4">
          <CardTitle>Default execution</CardTitle>
          <p className="text-sm text-muted-foreground">
            New Agents receive a Server Runtime Profile for the release-pinned OpenCode installation. Choose a different Host, runtime installation, or ModelProvider after creation in Runtime Profiles. Native account state on the Server Runtime is shared by people authorized to run Agents there.
          </p>
        </Card>

        <Card className="p-4 space-y-4">
          <CardTitle>Tools</CardTitle>
          <RetrievalToolDomainControls
            value={retrievalToolDomains}
            onChange={setRetrievalToolDomains}
          />
        </Card>

        <Card className="p-4 space-y-3">
          <CardTitle>Schedule</CardTitle>
          <ScheduleEditorFields value={schedule} onChange={setSchedule} />
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
