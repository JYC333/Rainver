import { useCallback, useEffect, useMemo, useState } from 'react'
import { Activity, FileText, Loader2, RefreshCw, Route, Save, ScanLine, ShieldCheck, Sparkles } from 'lucide-react'
import { toast } from 'sonner'
import { contextOpsApi, capabilitiesFrameworkApi, contextApi, projectFoldersApi, projectsApi, proposalsApi } from '../../api/client'
import { useSpace } from '../../contexts/SpaceContext'
import { SpaceLink as Link } from '../../core/spaceNav'
import { errMsg } from '../../lib/utils'
import type {
  ContextOpsContextObservationScanResponse,
  ContextEffectiveRoutingResponse,
  ContextPackConfig,
  ContextProfile,
  ContextRoutingManifest,
  Project,
  ProjectFolder,
  Proposal,
  SkillLibraryIndexItem,
} from '../../types/api'
import { Badge, StatusBadge } from '../../components/ui/badge'
import { Button } from '../../components/ui/button'
import { Card, CardTitle } from '../../components/ui/card'
import { EmptyState } from '../../components/ui/empty-state'
import { Input } from '../../components/ui/input'
import { Label } from '../../components/ui/label'
import { Select } from '../../components/ui/select'
import { Textarea } from '../../components/ui/textarea'

const OBSERVATION_POLICY_OPTIONS = [
  { value: 'manual', label: 'Manual' },
  { value: 'scheduled', label: 'Scheduled' },
  { value: 'disabled', label: 'Disabled' },
]

function fmt(dt: string | null | undefined): string {
  return dt ? new Date(dt).toLocaleString() : '-'
}

function defaultPack(): ContextPackConfig {
  return {
    title: '',
    skill_index_enabled: true,
    observation_policy: 'manual',
    notes: '',
  }
}

function severityVariant(severity: string): 'success' | 'warning' | 'destructive' | 'muted' {
  if (severity === 'red') return 'destructive'
  if (severity === 'yellow') return 'warning'
  if (severity === 'green') return 'success'
  return 'muted'
}

function normalizePack(value: ContextPackConfig | null | undefined): ContextPackConfig {
  return {
    ...defaultPack(),
    ...(value ?? {}),
  }
}

function emptyManifest(): ContextRoutingManifest {
  return {
    version: 1,
    default_agent_doc_paths: [],
    rules: [],
  }
}

function folderProfileFor(response: ContextEffectiveRoutingResponse, projectFolderId: string): ContextProfile | null {
  return response.profiles.find(profile => profile.scope_type === 'project_folder' && profile.scope_id === projectFolderId) ?? null
}

function parseManifest(draft: string): ContextRoutingManifest {
  const parsed = JSON.parse(draft) as unknown
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('routing_manifest_json must be an object')
  }
  return parsed as ContextRoutingManifest
}

function shortId(id: string): string {
  return id.length > 12 ? `${id.slice(0, 8)}...` : id
}

function permissionList(item: SkillLibraryIndexItem): string {
  return item.requested_permissions.length > 0
    ? item.requested_permissions.slice(0, 4).join(', ')
    : '-'
}

export default function ContextConfigurationPage() {
  const { activeSpaceId, activeSpaceName } = useSpace()
  const [projects, setProjects] = useState<Project[]>([])
  const [selectedProjectId, setSelectedProjectId] = useState('')
  const [folders, setFolders] = useState<ProjectFolder[]>([])
  const [selectedFolderId, setSelectedFolderId] = useState('')
  const [routing, setRouting] = useState<ContextEffectiveRoutingResponse | null>(null)
  const [routingDraft, setRoutingDraft] = useState('')
  const [packDraft, setPackDraft] = useState<ContextPackConfig>(defaultPack)
  const [skills, setSkills] = useState<SkillLibraryIndexItem[]>([])
  const [proposals, setProposals] = useState<Proposal[]>([])
  const [observation, setObservation] = useState<ContextOpsContextObservationScanResponse | null>(null)
  const [loading, setLoading] = useState(false)
  const [foldersLoading, setFoldersLoading] = useState(false)
  const [routingLoading, setRoutingLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [scanning, setScanning] = useState<'preview' | 'persist' | null>(null)

  const projectOptions = useMemo(
    () => projects.map(project => ({ value: project.id, label: project.name })),
    [projects],
  )

  const folderOptions = useMemo(
    () => folders.map(folder => ({ value: folder.id, label: folder.name })),
    [folders],
  )

  const selectedFolder = useMemo(
    () => folders.find(folder => folder.id === selectedFolderId) ?? null,
    [folders, selectedFolderId],
  )

  const loadRouting = useCallback(async (projectFolderId: string) => {
    setRoutingLoading(true)
    try {
      const next = await contextApi.getFolderRouting(projectFolderId)
      const folderProfile = folderProfileFor(next, projectFolderId)
      setRouting(next)
      setRoutingDraft(JSON.stringify(folderProfile?.routing_manifest_json ?? emptyManifest(), null, 2))
      setPackDraft(normalizePack(folderProfile?.context_pack_json))
    } catch (error) {
      toast.error(errMsg(error))
      setRouting(null)
      setRoutingDraft('')
      setPackDraft(defaultPack())
    } finally {
      setRoutingLoading(false)
    }
  }, [])

  const loadPage = useCallback(async () => {
    if (!activeSpaceId) {
      setProjects([])
      setSelectedProjectId('')
      setFolders([])
      setSelectedFolderId('')
      setRouting(null)
      setSkills([])
      setProposals([])
      setObservation(null)
      return
    }
    setLoading(true)
    try {
      const [projectResult, skillResult, proposalResult, observationResult] = await Promise.allSettled([
        projectsApi.list({ status: 'active', limit: 200 }),
        capabilitiesFrameworkApi.listSkillLibraryIndex(),
        proposalsApi.list({ status: 'pending', limit: 8 }),
        contextOpsApi.contextObservationScan({ window_days: 1, limit: 25, persist_report: false }),
      ])
      if (projectResult.status === 'fulfilled') {
        const items = projectResult.value.items
        setProjects(items)
        setSelectedProjectId(current =>
          items.some(project => project.id === current) ? current : items[0]?.id || '',
        )
      } else {
        toast.error(errMsg(projectResult.reason))
      }
      if (skillResult.status === 'fulfilled') setSkills(skillResult.value.items)
      if (proposalResult.status === 'fulfilled') setProposals(proposalResult.value.items)
      if (observationResult.status === 'fulfilled') setObservation(observationResult.value)
    } finally {
      setLoading(false)
    }
  }, [activeSpaceId])

  useEffect(() => {
    void loadPage()
  }, [loadPage])

  useEffect(() => {
    if (!selectedProjectId) {
      setFolders([])
      setSelectedFolderId('')
      return
    }
    let cancelled = false
    setFoldersLoading(true)
    ;(async () => {
      try {
        const page = await projectFoldersApi.list(selectedProjectId, { limit: '200' })
        if (cancelled) return
        setFolders(page.items)
        setSelectedFolderId(current =>
          page.items.some(folder => folder.id === current) ? current : page.items[0]?.id || '',
        )
      } catch (error) {
        if (!cancelled) {
          toast.error(errMsg(error))
          setFolders([])
          setSelectedFolderId('')
        }
      } finally {
        if (!cancelled) setFoldersLoading(false)
      }
    })()
    return () => { cancelled = true }
  }, [selectedProjectId])

  useEffect(() => {
    if (!selectedFolderId) return
    void loadRouting(selectedFolderId)
  }, [selectedFolderId, loadRouting])

  async function handleSave() {
    if (!selectedFolderId) return
    setSaving(true)
    try {
      const manifest = parseManifest(routingDraft)
      const saved = await contextApi.updateFolderRouting(selectedFolderId, {
        context_pack_json: packDraft,
        routing_manifest_json: manifest,
      })
      setRouting(saved)
      setRoutingDraft(JSON.stringify(folderProfileFor(saved, selectedFolderId)?.routing_manifest_json ?? manifest, null, 2))
      toast.success('Context routing saved')
    } catch (error) {
      toast.error(errMsg(error))
    } finally {
      setSaving(false)
    }
  }

  async function handleScan(persist: boolean) {
    setScanning(persist ? 'persist' : 'preview')
    try {
      const next = await contextOpsApi.contextObservationScan({ window_days: 1, limit: 25, persist_report: persist })
      setObservation(next)
      if (persist && next.artifact_id) toast.success('Observation artifact created')
    } catch (error) {
      toast.error(errMsg(error))
    } finally {
      setScanning(null)
    }
  }

  const rules = routing?.effective_manifest.rules ?? []
  const docs = routing?.selected_agent_doc_paths ?? []

  return (
    <div className="p-6 space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border pb-4">
        <div className="flex items-center gap-4">
          <div className="flex size-11 shrink-0 items-center justify-center rounded-lg border border-border bg-muted">
            <Route className="size-5 text-muted-foreground" />
          </div>
          <div>
            <h1 className="text-xl font-semibold tracking-tight">Context Configuration</h1>
            <p className="text-sm text-muted-foreground">Viewing: {activeSpaceName ?? activeSpaceId ?? 'No operational space selected'}</p>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Select
            options={projectOptions}
            value={selectedProjectId}
            onChange={setSelectedProjectId}
            className="w-56"
            disabled={projectOptions.length === 0}
          />
          <Select
            options={folderOptions}
            value={selectedFolderId}
            onChange={setSelectedFolderId}
            className="w-56"
            disabled={foldersLoading || folderOptions.length === 0}
          />
          <Button variant="outline" size="sm" onClick={() => void loadPage()} disabled={loading || !activeSpaceId}>
            {loading ? <Loader2 className="size-4 animate-spin" /> : <RefreshCw className="size-4" />}
            Refresh
          </Button>
        </div>
      </div>

      {!activeSpaceId ? (
        <EmptyState title="No operational space selected" />
      ) : projectOptions.length === 0 ? (
        <Card>
          <EmptyState title="No projects" />
        </Card>
      ) : folderOptions.length === 0 ? (
        <Card>
          <EmptyState title="No Project Folders" />
        </Card>
      ) : (
        <>
          <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_24rem]">
            <div className="space-y-4">
              <Card className="space-y-4">
                <div className="flex items-center justify-between gap-3">
                  <CardTitle>Context Pack</CardTitle>
                  <div className="flex items-center gap-2">
                    {selectedFolder && <Badge variant="outline">{selectedFolder.kind}</Badge>}
                    {selectedFolder && <StatusBadge status={selectedFolder.status} />}
                  </div>
                </div>
                <div className="grid gap-3 md:grid-cols-2">
                  <div className="space-y-1.5">
                    <Label>Title</Label>
                    <Input
                      value={typeof packDraft.title === 'string' ? packDraft.title : ''}
                      onChange={event => setPackDraft(current => ({ ...current, title: event.target.value }))}
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label>Observation policy</Label>
                    <Select
                      options={OBSERVATION_POLICY_OPTIONS}
                      value={typeof packDraft.observation_policy === 'string' ? packDraft.observation_policy : 'manual'}
                      onChange={value => setPackDraft(current => ({ ...current, observation_policy: value as ContextPackConfig['observation_policy'] }))}
                    />
                  </div>
                </div>
                <label className="flex items-center gap-2 text-sm text-muted-foreground">
                  <input
                    type="checkbox"
                    checked={packDraft.skill_index_enabled !== false}
                    onChange={event => setPackDraft(current => ({ ...current, skill_index_enabled: event.target.checked }))}
                    className="size-4 accent-primary"
                  />
                  Skill index enabled
                </label>
                <div className="space-y-1.5">
                  <Label>Notes</Label>
                  <Textarea
                    value={typeof packDraft.notes === 'string' ? packDraft.notes : ''}
                    onChange={event => setPackDraft(current => ({ ...current, notes: event.target.value }))}
                    className="min-h-24"
                  />
                </div>
              </Card>

              <Card className="space-y-4">
                <div className="flex items-center justify-between gap-3">
                  <CardTitle>Routing Rules</CardTitle>
                  <Button size="sm" onClick={handleSave} disabled={saving || routingLoading || !routingDraft.trim()}>
                    {saving ? <Loader2 className="size-4 animate-spin" /> : <Save className="size-4" />}
                    Save
                  </Button>
                </div>
                {routingLoading ? (
                  <div className="flex h-48 items-center justify-center text-sm text-muted-foreground">
                    <Loader2 className="mr-2 size-4 animate-spin" />
                    Loading
                  </div>
                ) : (
                  <Textarea
                    value={routingDraft}
                    onChange={event => setRoutingDraft(event.target.value)}
                    className="min-h-72 font-mono text-xs"
                    spellCheck={false}
                  />
                )}
                <div className="divide-y divide-border rounded-md border border-border">
                  {rules.length === 0 ? (
                    <div className="px-3 py-4 text-sm text-muted-foreground">No routing rules</div>
                  ) : rules.map(rule => (
                    <div key={`${rule.id ?? rule.path_glob}:${rule.priority ?? 100}`} className="grid gap-2 px-3 py-2 text-sm md:grid-cols-[minmax(0,1fr)_minmax(0,1.5fr)]">
                      <div className="min-w-0">
                        <div className="truncate font-mono text-xs">{rule.path_glob}</div>
                        <div className="mt-1 flex flex-wrap gap-1">
                          {rule.module_id && <Badge variant="outline">{rule.module_id}</Badge>}
                          <Badge variant="muted">p{rule.priority ?? 100}</Badge>
                        </div>
                      </div>
                      <div className="min-w-0 text-xs text-muted-foreground">
                        {(rule.agent_doc_paths ?? []).join(', ') || '-'}
                      </div>
                    </div>
                  ))}
                </div>
              </Card>
            </div>

            <div className="space-y-4">
              <Card>
                <CardTitle>Loaded .agent Docs</CardTitle>
                <div className="mt-3 flex flex-wrap gap-1.5">
                  {docs.length === 0 ? (
                    <span className="text-sm text-muted-foreground">-</span>
                  ) : docs.map(path => (
                    <Badge key={path} variant="secondary" className="max-w-full truncate">
                      {path}
                    </Badge>
                  ))}
                </div>
              </Card>

              <Card>
                <div className="mb-3 flex items-center justify-between gap-3">
                  <CardTitle>Skill Library Index</CardTitle>
                  <Sparkles className="size-4 text-muted-foreground" />
                </div>
                <div className="space-y-2">
                  {skills.length === 0 ? (
                    <p className="text-sm text-muted-foreground">-</p>
                  ) : skills.slice(0, 8).map(item => (
                    <div key={item.skill_package.id} className="rounded-md border border-border px-3 py-2 text-sm">
                      <div className="flex items-center justify-between gap-2">
                        <span className="min-w-0 truncate font-medium">{item.effective_name}</span>
                        <Badge variant={item.overlay ? 'success' : 'muted'}>{item.overlay ? 'overlay' : 'base'}</Badge>
                      </div>
                      <div className="mt-1 truncate text-xs text-muted-foreground">
                        {item.effective_alias ?? item.skill_package.package_name} · {permissionList(item)}
                      </div>
                    </div>
                  ))}
                </div>
              </Card>
            </div>
          </div>

          <div className="grid gap-4 xl:grid-cols-2">
            <Card>
              <div className="mb-3 flex items-center justify-between gap-3">
                <div className="flex items-center gap-2">
                  <Activity className="size-4 text-muted-foreground" />
                  <CardTitle>Context Ops Observation</CardTitle>
                </div>
                <div className="flex gap-2">
                  <Button variant="outline" size="sm" onClick={() => void handleScan(false)} disabled={scanning != null}>
                    {scanning === 'preview' ? <Loader2 className="size-4 animate-spin" /> : <ScanLine className="size-4" />}
                    Scan
                  </Button>
                  <Button variant="outline" size="sm" onClick={() => void handleScan(true)} disabled={scanning != null}>
                    {scanning === 'persist' ? <Loader2 className="size-4 animate-spin" /> : <FileText className="size-4" />}
                    Artifact
                  </Button>
                </div>
              </div>
              {observation ? (
                <div className="space-y-3">
                  <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                    <Badge variant="destructive">red {observation.report.counts.red ?? 0}</Badge>
                    <Badge variant="warning">yellow {observation.report.counts.yellow ?? 0}</Badge>
                    <Badge variant="success">green {observation.report.counts.green ?? 0}</Badge>
                    <span>{fmt(observation.report.generated_at)}</span>
                    <span>canonical_write_performed={String(observation.canonical_write_performed)}</span>
                    {observation.artifact_id && (
                      <Link to={`/artifacts/${observation.artifact_id}`} className="text-foreground hover:underline">
                        {shortId(observation.artifact_id)}
                      </Link>
                    )}
                  </div>
                  <div className="space-y-2">
                    {observation.report.observations.map((item, index) => (
                      <div key={`${item.title}:${index}`} className="rounded-md border border-border px-3 py-2 text-sm">
                        <div className="flex items-center gap-2">
                          <Badge variant={severityVariant(item.severity)}>{item.severity}</Badge>
                          <span className="font-medium">{item.title}</span>
                        </div>
                        <p className="mt-1 text-xs text-muted-foreground">{item.summary}</p>
                      </div>
                    ))}
                  </div>
                </div>
              ) : (
                <p className="text-sm text-muted-foreground">-</p>
              )}
            </Card>

            <Card>
              <div className="mb-3 flex items-center gap-2">
                <ShieldCheck className="size-4 text-muted-foreground" />
                <CardTitle>Pending Proposals</CardTitle>
              </div>
              <div className="space-y-2">
                {proposals.length === 0 ? (
                  <p className="text-sm text-muted-foreground">-</p>
                ) : proposals.map(proposal => (
                  <div key={proposal.id} className="rounded-md border border-border px-3 py-2 text-sm">
                    <div className="flex items-center justify-between gap-2">
                      <Link to={`/proposals/${proposal.id}`} className="min-w-0 truncate font-medium hover:underline">
                        {proposal.proposed_title}
                      </Link>
                      <StatusBadge status={proposal.status} />
                    </div>
                    <div className="mt-1 flex flex-wrap gap-1 text-xs text-muted-foreground">
                      <Badge variant="outline">{proposal.proposal_type}</Badge>
                      <span>{fmt(proposal.created_at)}</span>
                    </div>
                  </div>
                ))}
              </div>
            </Card>
          </div>
        </>
      )}
    </div>
  )
}
