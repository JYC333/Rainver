import { useCallback, useEffect, useMemo, useState } from 'react'
import { FileCode2, FileText, Play, Plus, RefreshCw, Route } from 'lucide-react'
import { toast } from 'sonner'
import { agentsApi, capabilitiesFrameworkApi, projectWorkflowProfilesApi } from '../../api/client'
import { SpaceLink as Link } from '../../core/spaceNav'
import { errMsg } from '../../lib/utils'
import type {
  AgentOut,
  AgentRuntimeProfileOut,
  ProjectWorkflowProfile,
  Run,
  WorkflowRunDraftResponse,
  WorkflowTemplate,
} from '../../types/api'
import { Card, CardTitle } from '../../components/ui/card'
import { Button } from '../../components/ui/button'
import { Badge, StatusBadge } from '../../components/ui/badge'
import { Input } from '../../components/ui/input'
import { Label } from '../../components/ui/label'
import { Select } from '../../components/ui/select'
import { Textarea } from '../../components/ui/textarea'
import { ContextArtifactPicker } from '../artifacts/ContextArtifactPicker'
import { promptLibraryPath } from '../prompts/paths'

interface ProjectFolderOption {
  id: string
  name: string
  root_path?: string | null
}

interface ResearchWorkflowPanelProps {
  projectId: string
  projectName?: string
  folderOptions?: ProjectFolderOption[]
  onRunCreated?: (run: Run) => void | Promise<void>
}

const SOURCE_MODE_OPTIONS = [
  { value: 'project_sources', label: 'Linked project context' },
  { value: 'runtime_native', label: 'Runtime native' },
  { value: 'manual_urls', label: 'Prompt URLs' },
]

const AUTO_RESEARCH_FLOW = [
  { key: 'intake', label: 'Intake', detail: 'question and deliverable scope' },
  { key: 'source_discovery', label: 'Source discovery', detail: 'project context and permitted search paths' },
  { key: 'screening', label: 'Screening', detail: 'relevance, quality, and exclusions' },
  { key: 'extraction', label: 'Extraction', detail: 'evidence and claim capture' },
  { key: 'synthesis', label: 'Synthesis', detail: 'answer, caveats, and alternatives' },
  { key: 'citation_checks', label: 'Citation checks', detail: 'coverage and contradiction checks' },
  { key: 'final_report', label: 'Final report', detail: 'artifact-ready output' },
] as const

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
    : []
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value : null
}

function profileTemplate(
  profile: ProjectWorkflowProfile | null | undefined,
  templates: WorkflowTemplate[],
): WorkflowTemplate | null {
  if (!profile) return null
  return templates.find(template => template.id === profile.workflow_template_id) ?? null
}

function defaultProfileName(template: WorkflowTemplate | null, projectName?: string): string {
  if (!template) return ''
  return projectName ? `${projectName} ${template.name}` : `${template.name} Preset`
}

function warningLabel(warning: string): string {
  return warning.replace(/_/g, ' ')
}

export function ResearchWorkflowPanel({
  projectId,
  projectName,
  folderOptions = [],
  onRunCreated,
}: ResearchWorkflowPanelProps) {
  const [templates, setTemplates] = useState<WorkflowTemplate[]>([])
  const [profiles, setProfiles] = useState<ProjectWorkflowProfile[]>([])
  const [agents, setAgents] = useState<AgentOut[]>([])
  const [selectedTemplateId, setSelectedTemplateId] = useState('')
  const [selectedProfileId, setSelectedProfileId] = useState('')
  const [profileName, setProfileName] = useState('')
  const [query, setQuery] = useState('')
  const [sourceMode, setSourceMode] = useState('project_sources')
  const [selectedAgentId, setSelectedAgentId] = useState('')
  const [runtimeProfiles, setRuntimeProfiles] = useState<AgentRuntimeProfileOut[]>([])
  const [selectedRuntimeProfileId, setSelectedRuntimeProfileId] = useState('')
  const [selectedFolderId, setSelectedFolderId] = useState('')
  const [selectedOutputs, setSelectedOutputs] = useState<string[]>([])
  const [selectedContextArtifactIds, setSelectedContextArtifactIds] = useState<string[]>([])
  const [draft, setDraft] = useState<WorkflowRunDraftResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [creatingProfile, setCreatingProfile] = useState(false)
  const [buildingDraft, setBuildingDraft] = useState(false)
  const [launchingRun, setLaunchingRun] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const [templateData, profileData, agentData] = await Promise.all([
        capabilitiesFrameworkApi.listWorkflowTemplates(),
        projectWorkflowProfilesApi.list(projectId),
        agentsApi.list({ status: 'active', limit: '100' }).catch(() => [] as AgentOut[]),
      ])
      const researchTemplates = templateData.filter(template => template.category === 'research')
      setTemplates(researchTemplates)
      setProfiles(profileData)
      setAgents(agentData.filter(agent => agent.status === 'active' && agent.current_version_id))
      setSelectedTemplateId(current => current || researchTemplates[0]?.id || '')
      setSelectedProfileId(current => current && profileData.some(profile => profile.id === current) ? current : '')
    } catch (e) {
      toast.error(errMsg(e))
    } finally {
      setLoading(false)
    }
  }, [projectId])

  useEffect(() => { load() }, [load])

  const selectedTemplate = useMemo(
    () => templates.find(template => template.id === selectedTemplateId) ?? null,
    [selectedTemplateId, templates],
  )
  const selectedProfile = useMemo(
    () => profiles.find(profile => profile.id === selectedProfileId) ?? null,
    [profiles, selectedProfileId],
  )
  const selectedAgent = useMemo(
    () => agents.find(agent => agent.id === selectedAgentId) ?? null,
    [agents, selectedAgentId],
  )
  const selectedRuntimeProfile = useMemo(
    () => runtimeProfiles.find(profile => profile.id === selectedRuntimeProfileId) ?? null,
    [runtimeProfiles, selectedRuntimeProfileId],
  )
  const selectedProfileTemplate = profileTemplate(selectedProfile, templates)
  const effectiveTemplate = selectedProfileTemplate ?? selectedTemplate
  const outputOptions = useMemo(
    () => effectiveTemplate?.output_artifact_types ?? selectedTemplate?.output_artifact_types ?? [],
    [effectiveTemplate, selectedTemplate],
  )

  useEffect(() => {
    if (selectedProfile) {
      setProfileName(selectedProfile.name)
      return
    }
    if (selectedTemplate) setProfileName(defaultProfileName(selectedTemplate, projectName))
  }, [projectName, selectedProfile, selectedTemplate])

  useEffect(() => {
    const defaults = stringArray(selectedProfile?.config_json.output_artifact_types)
    const next = defaults.length > 0 ? defaults : outputOptions
    setSelectedOutputs(current => {
      const filtered = selectedProfile
        ? next
        : current.length > 0
          ? current.filter(type => outputOptions.includes(type))
          : next
      if (filtered.length === current.length && filtered.every((type, index) => type === current[index])) {
        return current
      }
      return filtered
    })
  }, [outputOptions, selectedProfile])

  useEffect(() => {
    const mode =
      stringValue(selectedProfile?.config_json.source_mode) ??
      stringValue(effectiveTemplate?.default_config_json.source_mode)
    setSourceMode(mode ?? 'project_sources')
  }, [effectiveTemplate?.id, selectedProfile])

  useEffect(() => {
    if (!selectedAgentId) {
      setRuntimeProfiles([])
      setSelectedRuntimeProfileId('')
      return
    }
    let cancelled = false
    agentsApi.listRuntimeProfiles(selectedAgentId)
      .then(profiles => {
        if (cancelled) return
        setRuntimeProfiles(profiles)
        setSelectedRuntimeProfileId(current => {
          if (current && profiles.some(profile => profile.id === current)) return current
          return profiles.find(profile => profile.enabled && profile.is_default)?.id
            ?? profiles.find(profile => profile.enabled)?.id
            ?? ''
        })
      })
      .catch(() => {
        if (cancelled) return
        setRuntimeProfiles([])
        setSelectedRuntimeProfileId('')
      })
    return () => { cancelled = true }
  }, [selectedAgentId])

  useEffect(() => {
    setDraft(null)
  }, [query, sourceMode, selectedFolderId, selectedOutputs, selectedProfileId, selectedTemplateId])

  async function savePreset(mode: 'create' | 'update') {
    const template = effectiveTemplate
    if (!template) {
      toast.error('Select a workflow template')
      return
    }
    if (mode === 'update' && !selectedProfile) {
      toast.error('Select a saved preset to update')
      return
    }
    setCreatingProfile(true)
    try {
      const body = {
        workflow_template_id: template.id,
        name: profileName.trim() || defaultProfileName(template, projectName),
        enabled: true,
        config_json: {
          source_mode: sourceMode,
          output_artifact_types: selectedOutputs.length > 0 ? selectedOutputs : outputOptions,
        },
      }
      const saved = mode === 'update' && selectedProfile
        ? await projectWorkflowProfilesApi.update(projectId, selectedProfile.id, body)
        : await projectWorkflowProfilesApi.create(projectId, body)
      setProfiles(prev => [saved, ...prev.filter(profile => profile.id !== saved.id)])
      setSelectedProfileId(saved.id)
      toast.success(mode === 'update' ? 'Preset updated' : 'Preset saved')
    } catch (e) {
      toast.error(errMsg(e))
    } finally {
      setCreatingProfile(false)
    }
  }

  async function buildDraft() {
    const template = effectiveTemplate
    if (!template) {
      toast.error('Select a workflow template')
      return
    }
    if (!query.trim()) {
      toast.error('Enter a research question')
      return
    }
    setBuildingDraft(true)
    try {
      const configJson: Record<string, unknown> = {
        query: query.trim(),
        source_mode: sourceMode,
        output_artifact_types: selectedOutputs.length > 0 ? selectedOutputs : outputOptions,
      }
      const draftRequest = {
        agent_id: selectedAgentId || null,
        runtime_profile_id: selectedRuntimeProfileId || null,
        project_folder_id: selectedFolderId || null,
        config_json: configJson,
      }
      const result = selectedProfile
        ? await projectWorkflowProfilesApi.buildRunDraft(projectId, selectedProfile.id, draftRequest)
        : await projectWorkflowProfilesApi.buildTemplateRunDraft(projectId, template.id, draftRequest)
      setDraft({
        ...result,
        run_create_body: {
          ...result.run_create_body,
          // Project workflow launches should resolve runtime/provider/model
          // from the selected agent runtime profile instead of overriding it here.
          runtime_profile_id: selectedRuntimeProfileId || result.run_create_body.runtime_profile_id || null,
          adapter_type: null,
          model_provider_id: null,
          model: null,
        },
      })
      toast.success('Run draft ready')
    } catch (e) {
      toast.error(errMsg(e))
    } finally {
      setBuildingDraft(false)
    }
  }

  async function launchRun() {
    const agentId = selectedAgentId || draft?.run_create_body.agent_id || ''
    if (!draft || !agentId) {
      toast.error('Select an agent before launching')
      return
    }
    const {
      agent_id: _agentId,
      adapter_type: _adapterType,
      model_provider_id: _modelProviderId,
      model: _model,
      ...runBody
    } = draft.run_create_body
    runBody.runtime_profile_id = selectedRuntimeProfileId || draft.run_create_body.runtime_profile_id || null
    if (selectedContextArtifactIds.length > 0) runBody.context_artifact_ids = selectedContextArtifactIds
    setLaunchingRun(true)
    try {
      const run = await agentsApi.createRun(agentId, runBody)
      toast.success('Queued research run created')
      await onRunCreated?.(run)
    } catch (e) {
      toast.error(errMsg(e))
    } finally {
      setLaunchingRun(false)
    }
  }

  function toggleOutput(type: string) {
    setSelectedOutputs(current => {
      if (current.includes(type)) {
        const next = current.filter(item => item !== type)
        return next.length > 0 ? next : current
      }
      return [...current, type]
    })
  }

  const templateOptions = templates.map(template => ({ value: template.id, label: template.name }))
  const profileOptions = profiles.map(profile => {
    const template = profileTemplate(profile, templates)
    return {
      value: profile.id,
      label: `${profile.name}${template ? ` · ${template.name}` : ''}${profile.enabled ? '' : ' · disabled'}`,
    }
  })
  const agentOptions = agents.map(agent => ({
    value: agent.id,
    label: `${agent.name}${agent.adapter_type ? ` · ${agent.adapter_type}` : ''}`,
  }))
  const enabledRuntimeProfiles = runtimeProfiles.filter(profile => profile.enabled)
  const showRuntimeProfileSelect = enabledRuntimeProfiles.length > 1
  const runtimeProfileOptions = enabledRuntimeProfiles.map(profile => ({
    value: profile.id,
    label: `${profile.name}${profile.is_default ? ' · default' : ''}`,
  }))
  const folderSelectOptions = folderOptions.map(folder => ({
    value: folder.id,
    label: folder.name,
  }))
  const runtimeAdapterLabel = selectedRuntimeProfile?.adapter_type ?? selectedAgent?.adapter_type ?? 'agent default'
  const runtimeProviderLabel =
    selectedRuntimeProfile?.model?.provider_name ?? selectedAgent?.model?.provider_name ?? 'space/default provider'
  const runtimeModelLabel = selectedRuntimeProfile?.model?.model ?? selectedAgent?.model?.model ?? null
  const promptAssetKeys = effectiveTemplate?.prompt_asset_keys ?? []

  return (
    <Card className="p-4 space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <CardTitle>Research Workflows</CardTitle>
          <p className="text-xs text-muted-foreground mt-1">Run research workflows directly; save presets only when you want reusable defaults.</p>
        </div>
        <Button variant="ghost" size="sm" onClick={load} disabled={loading}>
          <RefreshCw className="size-4 mr-1" />
          {loading ? 'Refreshing…' : 'Refresh'}
        </Button>
      </div>

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1.1fr)_minmax(320px,0.9fr)]">
        <div className="space-y-4">
          <div className="grid gap-3 md:grid-cols-2">
            <div className="space-y-1.5">
              <Label className="text-xs">Workflow template</Label>
              <Select
                value={selectedTemplateId}
                options={templateOptions.length ? templateOptions : [{ value: '', label: 'No research templates' }]}
                onChange={value => {
                  setSelectedTemplateId(value)
                  setSelectedProfileId('')
                  const next = templates.find(template => template.id === value) ?? null
                  setProfileName(defaultProfileName(next, projectName))
                  setSelectedOutputs(next?.output_artifact_types ?? [])
                }}
              />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">Preset name</Label>
              <Input
                value={profileName}
                onChange={event => setProfileName(event.target.value)}
                placeholder={selectedTemplate ? defaultProfileName(selectedTemplate, projectName) : 'Preset name'}
              />
            </div>
          </div>

          <div className="flex flex-wrap gap-2">
            <Button onClick={() => savePreset('create')} disabled={creatingProfile || !effectiveTemplate}>
              <Plus className="size-4 mr-1" />
              {creatingProfile ? 'Saving…' : 'Save as preset'}
            </Button>
            {selectedProfile && (
              <Button variant="secondary" onClick={() => savePreset('update')} disabled={creatingProfile}>
                {creatingProfile ? 'Saving…' : 'Update preset'}
              </Button>
            )}
            {effectiveTemplate && (
              <div className="flex flex-wrap gap-1.5 items-center">
                {effectiveTemplate.output_artifact_types.map(type => (
                  <Badge key={type} variant="outline">{type}</Badge>
                ))}
              </div>
            )}
          </div>

          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            <div className="space-y-1.5">
              <Label className="text-xs">Saved preset</Label>
              <Select
                value={selectedProfileId}
                options={[{ value: '', label: 'No saved preset' }, ...profileOptions]}
                onChange={value => {
                  setSelectedProfileId(value)
                  const preset = profiles.find(profile => profile.id === value)
                  if (preset) setSelectedTemplateId(preset.workflow_template_id)
                  if (!value && selectedTemplate) {
                    setProfileName(defaultProfileName(selectedTemplate, projectName))
                    setSelectedOutputs(selectedTemplate.output_artifact_types)
                  }
                }}
              />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">Agent</Label>
              <Select
                value={selectedAgentId}
                options={[{ value: '', label: 'Select agent…' }, ...agentOptions]}
                onChange={setSelectedAgentId}
              />
              {selectedAgent && (
                <p className="text-[11px] text-muted-foreground">
                  Uses {runtimeAdapterLabel} with {runtimeProviderLabel}{runtimeModelLabel ? ` · ${runtimeModelLabel}` : ''}.
                </p>
              )}
            </div>
            {showRuntimeProfileSelect && (
              <div className="space-y-1.5">
                <Label className="text-xs">Runtime</Label>
                <Select
                  value={selectedRuntimeProfileId}
                  options={runtimeProfileOptions}
                  onChange={setSelectedRuntimeProfileId}
                />
              </div>
            )}
            <div className="space-y-1.5">
              <Label className="text-xs">Project Folder</Label>
              <Select
                value={selectedFolderId}
                options={[{ value: '', label: 'Project default' }, ...folderSelectOptions]}
                onChange={setSelectedFolderId}
              />
            </div>
          </div>

          <div className="space-y-1.5">
            <Label className="text-xs">Research question</Label>
            <Textarea
              value={query}
              onChange={event => setQuery(event.target.value)}
              rows={3}
              placeholder="What should this project research run answer?"
            />
          </div>

          <div className="space-y-1.5">
            <Label className="text-xs">Source mode</Label>
            <Select value={sourceMode} options={SOURCE_MODE_OPTIONS} onChange={setSourceMode} />
          </div>

          <ContextArtifactPicker
            title="Run context artifacts"
            description="Selected artifacts will be attached to this research run when launched."
            selectedArtifactIds={selectedContextArtifactIds}
            onChange={setSelectedContextArtifactIds}
            projectFolderId={selectedFolderId}
            projectId={projectId}
          />

          {outputOptions.length > 0 && (
            <div className="space-y-1.5">
              <Label className="text-xs">Outputs</Label>
              <div className="flex flex-wrap gap-1.5">
                {outputOptions.map(type => (
                  <button
                    key={type}
                    type="button"
                    onClick={() => toggleOutput(type)}
                    className="rounded-full focus:outline-none focus:ring-1 focus:ring-ring"
                  >
                    <Badge variant={selectedOutputs.includes(type) ? 'secondary' : 'outline'}>{type}</Badge>
                  </button>
                ))}
              </div>
            </div>
          )}

          <div className="flex flex-wrap gap-2">
            <Button
              variant="secondary"
              onClick={buildDraft}
              disabled={buildingDraft || !effectiveTemplate || selectedProfile?.enabled === false || !query.trim()}
            >
              <FileText className="size-4 mr-1" />
              {buildingDraft ? 'Building…' : 'Build run draft'}
            </Button>
            <Button onClick={launchRun} disabled={launchingRun || !draft || !(selectedAgentId || draft?.run_create_body.agent_id)}>
              <Play className="size-4 mr-1" />
              {launchingRun ? 'Launching…' : 'Launch queued run'}
            </Button>
          </div>
          {draft && !(selectedAgentId || draft.run_create_body.agent_id) && (
            <p className="text-xs text-muted-foreground">Select an agent to launch this draft.</p>
          )}
        </div>

        <div className="rounded-lg border border-border bg-muted/20 p-3 space-y-3 min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-medium">{selectedProfile?.name ?? 'Unsaved workflow run'}</span>
            {selectedProfile && <StatusBadge status={selectedProfile.enabled ? 'active' : 'disabled'} />}
            {effectiveTemplate && <Badge variant="outline">{effectiveTemplate.id}</Badge>}
          </div>

          {effectiveTemplate && (
            <p className="text-sm text-muted-foreground">{effectiveTemplate.description}</p>
          )}

          {effectiveTemplate && (
            <div className="rounded-md border border-border bg-background/70 p-3 space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <Route className="size-4 text-muted-foreground" />
                  <span className="text-sm font-medium">Auto research flow</span>
                </div>
                <Badge variant="secondary">research preset</Badge>
              </div>
              <div className="grid gap-2">
                {AUTO_RESEARCH_FLOW.map((step, index) => (
                  <div key={step.key} className="grid grid-cols-[22px_minmax(0,1fr)] gap-2">
                    <div className="flex h-5 w-5 items-center justify-center rounded-full border border-border text-[10px] font-medium">
                      {index + 1}
                    </div>
                    <div className="min-w-0">
                      <div className="text-xs font-medium text-foreground">{step.label}</div>
                      <div className="text-[11px] text-muted-foreground">{step.detail}</div>
                    </div>
                  </div>
                ))}
              </div>
              <div className="border-t border-border pt-3">
                <div className="mb-2 text-[11px] font-medium uppercase text-muted-foreground">Prompt chain</div>
                {promptAssetKeys.length > 0 ? (
                  <div className="space-y-1.5">
                    {promptAssetKeys.map(assetKey => (
                      <Button key={assetKey} asChild variant="outline" size="sm" className="w-full justify-start overflow-hidden">
                        <Link to={promptLibraryPath(assetKey)}>
                          <FileCode2 className="size-3.5 mr-1 shrink-0" />
                          <span className="truncate font-mono text-xs">{assetKey}</span>
                        </Link>
                      </Button>
                    ))}
                  </div>
                ) : (
                  <p className="text-xs text-muted-foreground">No prompt assets are registered for this template.</p>
                )}
              </div>
            </div>
          )}

          {effectiveTemplate && (
            <div className="grid gap-2 sm:grid-cols-2">
              <div>
                <div className="text-[11px] font-medium uppercase text-muted-foreground">Source</div>
                <div className="text-sm">{stringValue(selectedProfile?.config_json.source_mode) ?? sourceMode}</div>
              </div>
              <div>
                <div className="text-[11px] font-medium uppercase text-muted-foreground">Runtime</div>
                <div className="text-sm">
                  {selectedRuntimeProfile
                    ? `${selectedRuntimeProfile.name} · ${selectedRuntimeProfile.adapter_type}`
                    : selectedAgent?.adapter_type || 'agent default'}
                </div>
              </div>
            </div>
          )}

          {draft ? (
            <div className="space-y-3">
              <div className="flex flex-wrap gap-1.5">
                {draft.output_artifact_types.map(type => <Badge key={type} variant="secondary">{type}</Badge>)}
                {draft.capability_ids.map(id => <Badge key={id} variant="outline">{id}</Badge>)}
              </div>
              {draft.warnings.length > 0 && (
                <div className="flex flex-wrap gap-1.5">
                  {draft.warnings.map(warning => <Badge key={warning} variant="warning">{warningLabel(warning)}</Badge>)}
                </div>
              )}
              <div>
                <div className="text-[11px] font-medium uppercase text-muted-foreground mb-1">Prompt preview</div>
                {(draft.run_create_body.prompt_asset_key || draft.run_create_body.prompt_version_id || draft.run_create_body.prompt_content_hash) && (
                  <div className="mb-2 grid gap-2 text-xs sm:grid-cols-3">
                    <div className="rounded-md border border-border px-2 py-1.5">
                      <div className="text-[10px] uppercase text-muted-foreground">Asset</div>
                      <div className="truncate font-mono">{draft.run_create_body.prompt_asset_key ?? 'inline'}</div>
                    </div>
                    <div className="rounded-md border border-border px-2 py-1.5">
                      <div className="text-[10px] uppercase text-muted-foreground">Version</div>
                      <div className="truncate font-mono">{draft.run_create_body.prompt_version_id ?? 'unresolved'}</div>
                    </div>
                    <div className="rounded-md border border-border px-2 py-1.5">
                      <div className="text-[10px] uppercase text-muted-foreground">Hash</div>
                      <div className="truncate font-mono">{draft.run_create_body.prompt_content_hash?.slice(0, 12) ?? 'none'}</div>
                    </div>
                  </div>
                )}
                <pre className="text-xs whitespace-pre-wrap rounded-md border border-border bg-background/60 p-3 max-h-56 overflow-auto">
                  {draft.run_create_body.prompt}
                </pre>
              </div>
            </div>
          ) : (
            <div className="text-sm text-muted-foreground">
              {profiles.length === 0
                ? 'Fill in a question to build a run draft, or save these settings as a preset for reuse.'
                : 'Build a run draft to inspect the launch body before queueing a run.'}
            </div>
          )}
        </div>
      </div>
    </Card>
  )
}
