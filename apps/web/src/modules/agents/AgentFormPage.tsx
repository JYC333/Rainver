import { useEffect, useState } from 'react'
import { useParams, useSearchParams } from 'react-router-dom'
import { useSpaceNavigate as useNavigate, SpaceLink as Link } from '../../core/spaceNav'
import { ChevronDown, ChevronRight, Loader2, Plus } from 'lucide-react'
import { toast } from 'sonner'
import { agentRolesApi, agentsApi, projectsApi } from '../../api/client'
import type {
  AgentRoleOut,
  AgentRoleVersionOut,
  CreateAgentFromRoleBody,
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
import { agentCreationReturnPath, withCreatedAgent } from '../projects/agentCreationReturn'
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
  const { roleId } = useParams()
  const [searchParams] = useSearchParams()
  const navigate = useNavigate()
  const { activeSpaceId } = useSpace()
  const [role, setRole] = useState<AgentRoleOut | null>(null)
  // The Role this path names could not be read (removed, or its plugin turned off).
  const [roleUnavailable, setRoleUnavailable] = useState(false)
  const [version, setVersion] = useState<AgentRoleVersionOut | null>(null)
  const [loading, setLoading] = useState(Boolean(roleId))
  const [saving, setSaving] = useState(false)
  const [advancedOpen, setAdvancedOpen] = useState(false)
  const [projects, setProjects] = useState<Project[]>([])
  // The one "New Agent" flow: start blank, or from an official catalog Role.
  // Choosing a Role keeps the Project and the return path this page was opened
  // with. A plugin's Role is a Project-specific assistant set up from its
  // plugin page in a Project, never offered here (the server lists none
  // without a Project; this filter keeps that true for any answer).
  const [roles, setRoles] = useState<AgentRoleOut[] | null>(null)
  const carriedQuery = searchParams.toString()
  const [selectedProjectId, setSelectedProjectId] = useState(searchParams.get('project') ?? '')
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [systemPrompt, setSystemPrompt] = useState('')
  const [schedule, setSchedule] = useState<ScheduleEditorValue>(() => scheduleEditorFromConfig(null))
  const [riskLevel, setRiskLevel] = useState<'low' | 'medium' | 'high' | 'critical'>('medium')
  const [inputs, setInputs] = useState<Record<string, boolean>>({})
  const [outputs, setOutputs] = useState<Record<string, boolean>>({})
  const [retrievalToolDomains, setRetrievalToolDomains] = useState<RetrievalToolDomainState>({
    memory: false,
    project_public_summary: false,
    source: false,
  })

  useEffect(() => {
    if (roleId) return
    let active = true
    agentRolesApi.list({ status: 'published' }).then(items => { if (active) setRoles(items.filter(item => !item.source_plugin_id)) }, () => { if (active) setRoles([]) })
    return () => { active = false }
  }, [roleId, activeSpaceId])

  // Both paths choose a Project (the Role path sends `project_id` too), so
  // both read the list — including a Role page opened directly or reloaded.
  useEffect(() => {
    let active = true
    projectsApi.list({ status: 'active', limit: 100 })
      .then(page => { if (active) setProjects(page.items) })
      .catch(() => { if (active) setProjects([]) })
    return () => { active = false }
  }, [activeSpaceId])

  useEffect(() => {
    // The two routes render this one component, so "start blank instead"
    // keeps the instance: back on the blank path nothing of the Role stays —
    // not its title, not its prefilled fields, not its policies on submit.
    setRole(null)
    setRoleUnavailable(false)
    setVersion(null)
    setName('')
    setDescription('')
    setSystemPrompt('')
    setSchedule(scheduleEditorFromConfig(null))
    setRiskLevel('medium')
    setInputs({})
    setOutputs({})
    setRetrievalToolDomains({ memory: false, project_public_summary: false, source: false })
    if (!roleId) {
      setLoading(false)
      return
    }
    let active = true
    setLoading(true)
    agentRolesApi.get(roleId)
      .then(async t => {
        if (!active) return
        setRole(t)
        setName(t.name)
        setDescription(t.description ?? '')
        if (!t.current_version_id) return
        const v = await agentRolesApi.getVersion(t.id, t.current_version_id)
        if (!active) return
        setVersion(v)
        setRiskLevel(v.execution_constraints.risk_level)
        setSystemPrompt('')
        setSchedule(scheduleEditorFromConfig(v.schedule_defaults_json))
        const enabledCtx = new Set(defaultInputContexts(v))
        setInputs(Object.fromEntries(allowedInputContexts(v).map(id => [id, enabledCtx.has(id)])))
        setOutputs(Object.fromEntries(allowedOutputTypes(v).map(id => [id, true])))
        setRetrievalToolDomains(readRetrievalToolDomains(v.tool_policy_json))
      })
      .catch(err => {
        if (!active) return
        setRole(null)
        setVersion(null)
        setRoleUnavailable(true)
        toast.error(errMsg(err))
      })
      .finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [roleId])
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
        },
      }
      const created = roleId
        ? await agentRolesApi.createAgent(roleId, {
            ...common,
            project_id: selectedProjectId || null,
          } satisfies CreateAgentFromRoleBody)
        : await agentsApi.create({
          ...common,
            project_id: selectedProjectId || null,
          })
      toast.success('Agent created')
      // Opened from a Project's Agents page or a Room's members: go back there
      // with the new Agent named, where one explicit confirmation adds it.
      const back = agentCreationReturnPath(searchParams.get('return_to'))
      // The new Agent's own Space, which a user-scoped entry (My Agents) need not have in its URL.
      navigate(back ? withCreatedAgent(back, created.id) : `/spaces/${encodeURIComponent(created.space_id)}/agents/${encodeURIComponent(created.id)}`)
    } catch (err) {
      toast.error(errMsg(err))
    } finally {
      setSaving(false)
    }
  }

  if (loading) {
    return <div className="p-6 flex items-center gap-2 text-muted-foreground"><Loader2 className="size-4 animate-spin" /> Loading…</div>
  }

  // Nothing to create from: say so and offer the blank form, instead of a form
  // that looks blank but would still submit to the missing Role.
  if (roleId && roleUnavailable) {
    return (
      <div className="p-6 max-w-2xl space-y-3" data-testid="agent-role-unavailable">
        <h1 className="text-xl font-semibold">New agent</h1>
        <p className="text-sm text-muted-foreground">
          This Role is not available to you here: it may have been removed, or it is a plugin's assistant, which is set up from that plugin's page in a Project.{' '}
          <Link to={`/agents/new${carriedQuery ? `?${carriedQuery}` : ''}`} className="underline">Start blank instead</Link>.
        </p>
      </div>
    )
  }

  const previewVersion = {
    context_policy_json: buildContextConfig(),
    output_policy_json: buildOutputConfig(),
    memory_policy_json: version?.memory_policy_json ?? {},
    tool_policy_json: mergeRetrievalToolDomains(version?.tool_policy_json ?? {}, retrievalToolDomains),
    risk_level: riskLevel,
  }

  return (
    <div className="p-6 max-w-2xl space-y-6">
      <div>
        <h1 className="text-xl font-semibold">{role ? `New agent: ${role.name}` : 'New agent'}</h1>
        <p className="text-sm text-muted-foreground">
          {role
            ? <>Role defaults are prefilled below. Adjust them before creating the agent, or <Link to={`/agents/new${carriedQuery ? `?${carriedQuery}` : ''}`} className="underline">start blank instead</Link>.</>
            : 'Start blank, or from an official Role below.'}
        </p>
        {role?.key && CREATE_NOTE[role.key] && (
          <p className="mt-2 text-sm rounded-md border border-border bg-accent/30 px-3 py-2">{CREATE_NOTE[role.key]}</p>
        )}
      </div>

      {!roleId && (
        <Card className="p-4 space-y-3" data-testid="agent-start-from">
          <CardTitle>Start from</CardTitle>
          <div className="grid gap-2 sm:grid-cols-2">
            <Button type="button" variant="secondary" className="h-auto justify-start whitespace-normal py-2 text-left" aria-pressed="true">
              <span><span className="block font-medium">Blank</span><span className="block text-xs text-muted-foreground">Configure everything yourself.</span></span>
            </Button>
            {(roles ?? []).map(item => (
              <Button
                key={item.id}
                type="button"
                variant="outline"
                className="h-auto justify-start whitespace-normal py-2 text-left"
                onClick={() => navigate(`/agents/roles/${encodeURIComponent(item.id)}/use${carriedQuery ? `?${carriedQuery}` : ''}`)}
              >
                <span className="min-w-0">
                  <span className="block font-medium">{item.name}</span>
                  {item.description && <span className="line-clamp-2 block text-xs text-muted-foreground">{item.description}</span>}
                </span>
              </Button>
            ))}
          </div>
          {roles === null && <p className="text-xs text-muted-foreground">Loading Roles…</p>}
        </Card>
      )}

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
                  // (ROUTING.md, "Effective trust"), so either of these
                  // leaves the Agent with no eligible candidate anywhere.
                  { value: 'high', label: 'High · no execution target reaches high trust yet', disabled: true },
                  { value: 'critical', label: 'Critical · no execution target reaches high trust yet', disabled: true },
                ]}
              />
              <p className="text-xs text-muted-foreground">
                High and critical risk require a high-trust execution target. Neither the Server Runtime nor a paired Host provides one yet, so an Agent set to either would never route.
              </p>
            </div>
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
          {(
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
                    Direct memory write, proposal-only outputs, and tool/shell access stay as the role defines them.
                  </p>
                )}
              </div>
            </div>
          )}
        </Card>

        <div className="flex gap-2">
          <Button type="submit" disabled={saving}>{saving ? <Loader2 className="size-4 animate-spin" /> : 'Create agent'}</Button>
          {/* Opened from a Project or Room: Cancel goes back there, as Create does. */}
          <Button type="button" variant="outline" asChild><Link to={agentCreationReturnPath(searchParams.get('return_to')) ?? (role ? '/agents/roles' : '/my-agents')}>Cancel</Link></Button>
          {!role && (
            <Button type="button" variant="ghost" asChild>
              <Link to="/agents/roles"><Plus className="size-3.5 mr-1" /> Roles</Link>
            </Button>
          )}
        </div>
      </form>
    </div>
  )
}
