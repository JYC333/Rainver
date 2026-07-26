import { useState, useEffect, useCallback, useRef } from 'react'
import { useParams, useSearchParams } from 'react-router-dom'
import { useSpaceNavigate as useNavigate, SpaceLink as Link } from '../../core/spaceNav'
import {
  FolderKanban, Target, Edit2, Archive, Plus, Trash2, ChevronLeft,
  Activity, Package, CheckCircle, Folder, Cpu, Database, Rss, Link2, FileText, RefreshCw,
  BookOpen, MessageSquareText, Settings as SettingsIcon,
} from 'lucide-react'
import { toast } from 'sonner'
import { projectsApi, projectFoldersApi, activityApi, artifactsApi, proposalsApi, runsApi, memoryApi, sourcesApi, readerApi, automationsApi, projectResearchApi, providersApi, inquiryApi } from '../../api/client'
import { ACADEMIC_TEMPLATE_KEY, templateKeyFromProject } from './templateUtils'
import { useSpace } from '../../contexts/SpaceContext'
import { errMsg, isNotFoundError } from '../../lib/utils'
import type {
  Project, ProjectOverview, ProjectSummary, ProjectFolder, ProjectFolderScanCandidate,
  ActivityInboxRecord, Artifact, Proposal, Run, Memory,
  SourceChannel, ProjectSourceBinding, SourceItem, ExtractedEvidence,
  ReaderAnnotation, AutomationOut, SourcePostProcessingItemDecision,
  ProjectResearchReport, ProjectResearchInitialIntakeInput, ProjectResearchCheckpoint, ProjectResearchLiteratureMatrixItem,
  ProjectResearchQuestionRefinement, ProjectResearchWorkflow,
  ProjectOperation, ProjectResearchScanSummary,
  InquiryThread,
} from '../../types/api'
import { Card } from '../../components/ui/card'
import { Button } from '../../components/ui/button'
import { Badge, StatusBadge } from '../../components/ui/badge'
import { Label } from '../../components/ui/label'
import { Input } from '../../components/ui/input'
import { Textarea } from '../../components/ui/textarea'
import { Select } from '../../components/ui/select'
import { Skeleton } from '../../components/ui/skeleton'
import { EmptyState } from '../../components/ui/empty-state'
import { ResearchWorkflowPanel } from '../capabilities/ResearchWorkflowPanel'
import { AcademicResearchWorkbench, researchOperationStage, objectValue, numberValue } from './AcademicResearchWorkbench'
import { isResearchHumanReviewCheckpoint, researchCheckpointLabel } from './researchReviewAttention'
import { researchSetupDraftFromWorkflow } from './researchSetupDraft'
import { researchWorkflowForDisplayFrom } from './researchWorkflowView'
import { ProjectSourceLinkDialog } from './ProjectSourceLinkDialog'
import { sourceQueryText } from '../sources/sourceQueryText'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  ConfirmDialog,
} from '../../components/ui/dialog'

function fmt(dt: string | null | undefined) {
  return dt ? new Date(dt).toLocaleString() : '—'
}

const FOLDER_KINDS = [
  { value: 'code', label: 'Code' },
  { value: 'data', label: 'Data' },
  { value: 'docs', label: 'Docs' },
]

const TERMINAL_RUN_STATUSES = new Set(['succeeded', 'failed', 'degraded', 'cancelled', 'waiting_for_review', 'waiting_for_dependency'])

function upsertById<T extends { id: string }>(current: T[], next: T): T[] {
  const index = current.findIndex(item => item.id === next.id)
  if (index === -1) return [next, ...current]
  return current.map(item => item.id === next.id ? next : item)
}

function mergeById<T extends { id: string }>(current: T[], incoming: T[]): T[] {
  return incoming.reduce((result, item) => upsertById(result, item), current)
}

function researchLifecycleSignature(operations: ProjectOperation[]): string {
  return operations
    .filter(operation => operation.kind === 'research')
    .sort((left, right) => left.id.localeCompare(right.id))
    .map(operation => [
      operation.id,
      operation.status,
      String(operation.progress_json.current_stage ?? ''),
      String(operation.progress_json.failed_stage ?? ''),
      String(operation.progress_json.partial ?? ''),
    ].join(':'))
    .join('|')
}

/* ── Summary card ─────────────────────────────────────────────────────────── */
interface SummaryCardProps {
  icon: React.ReactNode
  label: string
  count: number
}

function SummaryCard({ icon, label, count }: SummaryCardProps) {
  return (
    <div className="bg-card border border-border rounded-lg p-4 flex flex-col gap-2">
      <div className="flex items-center gap-2 text-muted-foreground">
        {icon}
        <span className="text-xs font-medium uppercase tracking-wide">{label}</span>
      </div>
      <div className="text-2xl font-semibold" style={{ fontFamily: 'var(--font-mono)' }}>
        {count}
      </div>
    </div>
  )
}

/* ── Project settings dialog ──────────────────────────────────────────────── */
interface ResearchSettingsProps {
  currentItemLimit: number | null
  // Whether an intake operation already exists: once it does, a lower value
  // can't be applied (already-spent budget can't be un-spent), only raised.
  // Before that, the setting is just a draft value and any 1-10000 value is fine.
  hasLiveOperation: boolean
  hasStartedWorkflow: boolean
  busy: boolean
  onUpdateItemLimit: (newLimit: number) => void
  snapshot: {
    question: string
    monitors: string[]
    history: string
    maxItems: number | null
    monitoringField: string
  }
}

interface EditDialogProps {
  project: Project
  open: boolean
  onOpenChange: (v: boolean) => void
  onSaved: (updated: Project) => void
  research: ResearchSettingsProps | null
}

// Project settings is one dialog with a "General" section every project has,
// plus Profile-specific sections (only "Research", for academic_research
// projects, today). New Project Profiles add their own section here rather
// than a bespoke settings entry point elsewhere on the page.
function EditProjectDialog({ project, open, onOpenChange, onSaved, research }: EditDialogProps) {
  const [name, setName] = useState(project.name)
  const [description, setDescription] = useState(project.description ?? '')
  const [focus, setFocus] = useState(project.current_focus ?? '')
  const [saving, setSaving] = useState(false)
  const [itemLimitInput, setItemLimitInput] = useState('')

  useEffect(() => {
    if (open) {
      setName(project.name)
      setDescription(project.description ?? '')
      setFocus(project.current_focus ?? '')
      setItemLimitInput('')
    }
  }, [open, project])

  async function save() {
    if (!name.trim()) {
      toast.error('Name is required')
      return
    }
    setSaving(true)
    try {
      const updated = await projectsApi.update(project.id, {
        name: name.trim(),
        description: description.trim() || null,
        current_focus: focus.trim() || null,
      })
      toast.success('Project updated')
      onSaved(updated)
      onOpenChange(false)
    } catch (e) {
      toast.error(errMsg(e))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Project settings</DialogTitle>
          <DialogDescription className="sr-only">
            Update this project's name, description, current focus, and Profile-specific settings.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-5 py-2">
          <div className="space-y-4">
            <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">General</p>
            <div className="space-y-1.5">
              <Label>Name <span className="text-destructive">*</span></Label>
              <Input value={name} onChange={e => setName(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label>Description</Label>
              <Textarea
                value={description}
                onChange={e => setDescription(e.target.value)}
                rows={3}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="project-current-focus">{research ? 'Research question' : 'Current focus'}</Label>
              <Input
                id="project-current-focus"
                value={focus}
                onChange={e => setFocus(e.target.value)}
                placeholder={research ? 'What question should this research answer?' : 'What are you actively working on right now?'}
              />
              {research?.hasStartedWorkflow && (
                <p className="text-xs text-muted-foreground">
                  Saving a new question does not rewrite existing screening decisions or reports. After saving, you will choose how to apply the change.
                </p>
              )}
            </div>
          </div>
          {research && (
            <div className="space-y-2 border-t border-border pt-4">
              <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Research</p>
              <div className="rounded-md border border-border bg-muted/20 p-3 text-xs">
                <p className="font-medium text-foreground">Saved intake configuration</p>
                <dl className="mt-2 space-y-1.5 text-muted-foreground">
                  <div><dt className="inline font-medium text-foreground">Question: </dt><dd className="inline">{research.snapshot.question || 'Not set'}</dd></div>
                  <div><dt className="inline font-medium text-foreground">Monitors: </dt><dd className="inline">{research.snapshot.monitors.length ? research.snapshot.monitors.join(' · ') : 'None selected'}</dd></div>
                  <div><dt className="inline font-medium text-foreground">Initial import: </dt><dd className="inline">{research.snapshot.history}</dd></div>
                  <div><dt className="inline font-medium text-foreground">Import limit: </dt><dd className="inline">{research.snapshot.maxItems?.toLocaleString() ?? 'Not set'} items shared across monitors (initial import only)</dd></div>
                  <div><dt className="inline font-medium text-foreground">Monitoring: </dt><dd className="inline">{research.snapshot.monitoringField}</dd></div>
                </dl>
              </div>
              <div className="space-y-1.5">
                <div className="flex items-center justify-between gap-2">
                  <Label>Item limit</Label>
                  <span className="text-sm font-medium">{research.currentItemLimit !== null ? research.currentItemLimit.toLocaleString() : '—'}</span>
                </div>
                <div className="flex items-center gap-2">
                  <Input
                    type="number"
                    min={1}
                    max={10000}
                    placeholder={research.currentItemLimit !== null ? String(research.currentItemLimit) : 'e.g. 10000'}
                    value={itemLimitInput}
                    onChange={event => setItemLimitInput(event.target.value)}
                    aria-label="New item limit"
                  />
                  <Button
                    variant="outline"
                    onClick={() => {
                      research.onUpdateItemLimit(Number(itemLimitInput))
                      setItemLimitInput('')
                    }}
                    disabled={
                      research.busy
                      || !itemLimitInput
                      || Number(itemLimitInput) < 1
                      || Number(itemLimitInput) > 10000
                      || (research.hasLiveOperation && Number(itemLimitInput) <= (research.currentItemLimit ?? 0))
                    }
                  >
                    Update
                  </Button>
                </div>
                <p className="text-xs text-muted-foreground">
                  {research.hasLiveOperation
                    ? 'Intake is already running; this can only be raised, not lowered.'
                    : 'Applies once the literature intake starts. Saved to the intake setup draft now.'}
                </p>
              </div>
            </div>
          )}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button onClick={save} disabled={saving || !name.trim()}>
            {saving ? 'Saving…' : 'Save changes'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/* ── Create Project Folder dialog ─────────────────────────────────────────── */
type FolderCreateSource = 'managed' | 'clone' | 'connect'

interface CreateProjectFolderDialogProps {
  projectId: string
  open: boolean
  onOpenChange: (v: boolean) => void
  onCreated: () => void
}

function CreateProjectFolderDialog({ projectId, open, onOpenChange, onCreated }: CreateProjectFolderDialogProps) {
  const [source, setSource] = useState<FolderCreateSource>('managed')
  const [name, setName] = useState('')
  const [kind, setKind] = useState('code')
  const [repoUrl, setRepoUrl] = useState('')
  const [candidates, setCandidates] = useState<ProjectFolderScanCandidate[]>([])
  const [selectedCandidatePath, setSelectedCandidatePath] = useState('')
  const [scanning, setScanning] = useState(false)
  const [creating, setCreating] = useState(false)

  useEffect(() => {
    if (!open) return
    setSource('managed')
    setName('')
    setKind('code')
    setRepoUrl('')
    setCandidates([])
    setSelectedCandidatePath('')
  }, [open])

  useEffect(() => {
    if (!open || source !== 'connect') return
    setScanning(true)
    projectFoldersApi.scan(projectId)
      .then(result => setCandidates(result.items))
      .catch(() => setCandidates([]))
      .finally(() => setScanning(false))
  }, [open, source, projectId])

  async function submit() {
    if (!name.trim()) {
      toast.error('Name is required')
      return
    }
    if (source === 'connect' && !selectedCandidatePath) {
      toast.error('Select a directory to connect')
      return
    }
    setCreating(true)
    try {
      await projectFoldersApi.create(projectId, {
        name: name.trim(),
        kind: kind as ProjectFolder['kind'],
        repo_url: source === 'clone' ? repoUrl.trim() || null : null,
        root_path: source === 'connect' ? selectedCandidatePath : null,
      })
      toast.success('Project Folder created')
      onCreated()
      onOpenChange(false)
    } catch (e) {
      toast.error(errMsg(e))
    } finally {
      setCreating(false)
    }
  }

  const candidateOptions = candidates.map(c => ({ value: c.path, label: c.name }))

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New Project Folder</DialogTitle>
          <DialogDescription>
            Create a managed directory, clone a repository, or connect an existing directory as a Folder owned by this Project.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4 py-2">
          <div className="space-y-1.5">
            <Label>Source</Label>
            <Select
              value={source}
              options={[
                { value: 'managed', label: 'Create managed Folder' },
                { value: 'clone', label: 'Clone repository' },
                { value: 'connect', label: 'Connect existing Folder' },
              ]}
              onChange={value => setSource(value as FolderCreateSource)}
            />
          </div>
          <div className="space-y-1.5">
            <Label>Name</Label>
            <Input value={name} onChange={e => setName(e.target.value)} placeholder="Folder name" />
          </div>
          <div className="space-y-1.5">
            <Label>Kind</Label>
            <Select value={kind} options={FOLDER_KINDS} onChange={setKind} />
          </div>
          {source === 'clone' && (
            <div className="space-y-1.5">
              <Label>Repository URL</Label>
              <Input value={repoUrl} onChange={e => setRepoUrl(e.target.value)} placeholder="https://…" />
            </div>
          )}
          {source === 'connect' && (
            <div className="space-y-1.5">
              <Label>Existing directory</Label>
              {scanning ? (
                <p className="text-xs text-muted-foreground">Scanning…</p>
              ) : candidateOptions.length === 0 ? (
                <p className="text-xs text-muted-foreground">No unregistered directories found.</p>
              ) : (
                <Select
                  value={selectedCandidatePath}
                  options={[{ value: '', label: 'Select a directory…' }, ...candidateOptions]}
                  onChange={setSelectedCandidatePath}
                />
              )}
            </div>
          )}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button onClick={submit} disabled={creating || !name.trim()}>
            {creating ? 'Creating…' : 'Create Folder'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function isManualUrlItem(item: SourceItem) {
  return item.item_type === 'external_url' && item.metadata_json?.created_by === 'manual_url'
}

interface ProjectSourceOption {
  value: string
  label: string
  connectionId: string
}

interface SaveProjectUrlDialogProps {
  open: boolean
  onOpenChange: (v: boolean) => void
  sourceOptions: ProjectSourceOption[]
  onSaved: () => void
}

function SaveProjectUrlDialog({ open, onOpenChange, sourceOptions, onSaved }: SaveProjectUrlDialogProps) {
  const [url, setUrl] = useState('')
  const [title, setTitle] = useState('')
  const [connectionId, setConnectionId] = useState('')
  const [queueContent, setQueueContent] = useState(false)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (!open) return
    setUrl('')
    setTitle('')
    setQueueContent(false)
    setConnectionId(sourceOptions[0]?.value ?? '')
  }, [open, sourceOptions])

  async function submit() {
    if (!url.trim()) {
      toast.error('URL is required')
      return
    }
    if (!connectionId) {
      toast.error('Link a source before saving URLs to this project')
      return
    }
    setSaving(true)
    try {
      const selectedSource = sourceOptions.find(option => option.value === connectionId)
      if (!selectedSource) {
        toast.error('Select a project channel before saving URLs')
        return
      }
      const row = await sourcesApi.createManualUrl({
        url: url.trim(),
        title: title.trim() || undefined,
        connection_id: selectedSource.connectionId,
        queue_content: queueContent,
      })
      if (row.connection_id !== selectedSource.connectionId) {
        await sourcesApi.updateItem(row.id, { connection_id: selectedSource.connectionId })
      }
      toast.success('URL saved')
      onSaved()
      onOpenChange(false)
    } catch (e) {
      toast.error(errMsg(e))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Save URL</DialogTitle>
          <DialogDescription>
            Save a URL into this project by attaching it to one of the project-linked sources.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4 py-2">
          <div className="space-y-1.5">
            <Label>Page URL</Label>
            <Input
              value={url}
              onChange={event => setUrl(event.target.value)}
              placeholder="https://example.com/post"
              required
            />
          </div>
          <div className="space-y-1.5">
            <Label>Title</Label>
            <Input
              value={title}
              onChange={event => setTitle(event.target.value)}
              placeholder="Optional"
            />
          </div>
          <div className="space-y-1.5">
            <Label>Source</Label>
            {sourceOptions.length === 0 ? (
              <p className="text-xs text-muted-foreground">Link a source before saving URLs to this project.</p>
            ) : (
              <Select
                value={connectionId}
                options={sourceOptions}
                onChange={setConnectionId}
              />
            )}
          </div>
          <label className="flex items-center gap-2 text-sm text-muted-foreground">
            <input
              type="checkbox"
              className="size-4 rounded border-border"
              checked={queueContent}
              onChange={event => setQueueContent(event.target.checked)}
            />
            Queue extraction
          </label>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button onClick={submit} disabled={saving || !url.trim() || !connectionId}>
            {saving ? 'Saving…' : 'Save URL'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/* ── Main page ─────────────────────────────────────────────────────────────── */
export default function ProjectDetailPage() {
  const { projectId } = useParams<{ projectId: string }>()
  const [searchParams, setSearchParams] = useSearchParams()
  const navigate = useNavigate()
  const { activeSpaceId } = useSpace()

  const [project, setProject] = useState<Project | null>(null)
  const [summary, setSummary] = useState<ProjectSummary | null>(null)
  const [kernelOverview, setKernelOverview] = useState<ProjectOverview | null>(null)
  const [folders, setFolders] = useState<ProjectFolder[]>([])
  const [recentActivities, setRecentActivities] = useState<ActivityInboxRecord[]>([])
  const [recentArtifacts, setRecentArtifacts] = useState<Artifact[]>([])
  const [pendingProposals, setPendingProposals] = useState<Proposal[]>([])
  const [recentRuns, setRecentRuns] = useState<Run[]>([])
  const [projectMemory, setProjectMemory] = useState<Memory[]>([])
  const [sourceChannels, setSourceChannels] = useState<SourceChannel[]>([])
  const [sourceBindings, setSourceBindings] = useState<ProjectSourceBinding[]>([])
  const [recentSourceItems, setRecentSourceItems] = useState<SourceItem[]>([])
  const [recentEvidence, setRecentEvidence] = useState<ExtractedEvidence[]>([])
  const [sourceRecommendations, setSourceRecommendations] = useState<SourcePostProcessingItemDecision[]>([])
  const [readerAnnotations, setReaderAnnotations] = useState<ReaderAnnotation[]>([])
  const [automations, setAutomations] = useState<AutomationOut[]>([])
  const [operations, setOperations] = useState<ProjectOperation[]>([])
  const [researchWorkflows, setResearchWorkflows] = useState<ProjectResearchWorkflow[]>([])
  const [selectedResearchWorkflowId, setSelectedResearchWorkflowId] = useState<string | null>(null)
  const [researchScanSummaries, setResearchScanSummaries] = useState<ProjectResearchScanSummary[]>([])
  const [researchCheckpoints, setResearchCheckpoints] = useState<ProjectResearchCheckpoint[]>([])
  const [literatureMatrix, setLiteratureMatrix] = useState<ProjectResearchLiteratureMatrixItem[]>([])
  const [researchReports, setResearchReports] = useState<ProjectResearchReport[]>([])
  const [modelProviders, setModelProviders] = useState<Awaited<ReturnType<typeof providersApi.list>>>([])
  const [inquiryThreads, setInquiryThreads] = useState<InquiryThread[]>([])
  const [researchActionBusy, setResearchActionBusy] = useState<string | null>(null)
  const [researchDataLoading, setResearchDataLoading] = useState(true)
  const [loading, setLoading] = useState(true)
  const [detailsLoading, setDetailsLoading] = useState(false)
  const [notFound, setNotFound] = useState(false)
  const [editOpen, setEditOpen] = useState(false)
  const [archiveConfirmOpen, setArchiveConfirmOpen] = useState(false)
  const [linkOpen, setLinkOpen] = useState(false)
  const [sourceLinkOpen, setSourceLinkOpen] = useState(false)
  const [saveUrlOpen, setSaveUrlOpen] = useState(false)
  const [bindingToRemove, setBindingToRemove] = useState<ProjectSourceBinding | null>(null)
  const [updatingItemSourceId, setUpdatingItemSourceId] = useState<string | null>(null)
  const [backfillingBindingId, setBackfillingBindingId] = useState<string | null>(null)
  const [removingBindingId, setRemovingBindingId] = useState<string | null>(null)
  const [archiving, setArchiving] = useState(false)

  useEffect(() => {
    if (searchParams.get('create_folder') === '1') setLinkOpen(true)
  }, [searchParams])

  const setFolderDialogOpen = useCallback((open: boolean) => {
    setLinkOpen(open)
    if (!open && searchParams.has('create_folder')) {
      setSearchParams(previous => {
        const next = new URLSearchParams(previous)
        next.delete('create_folder')
        return next
      }, { replace: true })
    }
  }, [searchParams, setSearchParams])

  // React StrictMode (dev only) intentionally double-invokes this effect on
  // mount, and the mount effect below has no cleanup to cancel the first
  // call — without this guard every page load fires its ~25-call waterfall
  // twice concurrently, which does nothing useful and doubles real load on
  // the backend (worse: two copies of the heaviest query compete for the
  // same CPU, making both run slower than either alone). Collapse a second
  // call for the same project into the load already in flight instead of
  // starting a redundant one; a call after the previous one finished (e.g.
  // the explicit refresh after resolving a research question) still runs.
  const loadAllInFlightRef = useRef<{ key: string; promise: Promise<void> } | null>(null)

  const loadAll = useCallback(async () => {
    const key = `${projectId ?? ''}:${activeSpaceId ?? ''}`
    if (loadAllInFlightRef.current?.key === key) return loadAllInFlightRef.current.promise
    const promise = loadAllImpl()
    loadAllInFlightRef.current = { key, promise }
    try {
      await promise
    } finally {
      if (loadAllInFlightRef.current?.promise === promise) loadAllInFlightRef.current = null
    }
  }, [projectId, activeSpaceId])

  const loadAllImpl = useCallback(async () => {
    if (!projectId || !activeSpaceId) {
      setResearchDataLoading(false)
      setLoading(false)
      return
    }
    setLoading(true)
    setResearchDataLoading(true)
    setNotFound(false)
    let resolvedTemplateKey: string | null = null
    try {
      const [proj, summ, folderPage, overview] = await Promise.all([
        projectsApi.get(projectId),
        projectsApi.getSummary(projectId),
        projectFoldersApi.list(projectId, { limit: '200' }),
        projectsApi.getOverview(projectId),
      ])
      setProject(proj)
      setSummary(summ)
      setFolders(folderPage.items)
      setKernelOverview(overview)
      resolvedTemplateKey = templateKeyFromProject(proj)
      setLoading(false)
    } catch (e) {
      setDetailsLoading(false)
      setResearchDataLoading(false)
      if (isNotFoundError(e)) {
        setNotFound(true)
      } else {
        toast.error(errMsg(e))
      }
      setLoading(false)
      return
    }

    setDetailsLoading(true)
    // Each fetch below feeds its own independent card/section — batching
    // them behind one `Promise.all([...]).then(([a, b, c]) => ...)` made
    // every fast one (most resolve in well under 100ms) sit on screen as
    // "loading" until the single slowest call in that batch finished, even
    // though the data was ready much earlier. Applying each result via its
    // own `.then(setState)` lets a section render the moment its own
    // request completes, independent of its siblings' speed. The outer
    // `Promise.all` here is only for knowing when the whole stage is done
    // (loading flags, error toast) — not for gating when any one piece of
    // state updates.
    // For academic projects, AcademicResearchWorkbench (rendered inline as
    // the page's primary content) is the only consumer of this data, and it
    // doesn't use these four — they only feed the plain-project "Sources
    // consumption"/"Project activity" sections further down, which are
    // themselves only rendered for non-academic projects. Skip fetching
    // data that would just sit unused, and reset it to empty explicitly (not
    // "leave whatever's there") so navigating from a non-academic project to
    // an academic one doesn't leave stale data in state.
    // Academic Research presentation is a Template-provenance default (what
    // a Project created from the academic Template looks like from day
    // one) — it is not a permanent Area/capability gate: a Project's
    // primary_mode and every installed Area remain independently reachable
    // regardless of this value. See the Project Model Clean-Cutover plan.
    const isAcademic = resolvedTemplateKey === ACADEMIC_TEMPLATE_KEY
    const genericLoad = Promise.all([
      isAcademic ? Promise.resolve(setRecentActivities([])) : activityApi.list({ project_id: projectId, limit: 5 }).then(setRecentActivities),
      isAcademic ? Promise.resolve(setRecentArtifacts([])) : artifactsApi.list({ project_id: projectId, limit: 5 }).then(arts => setRecentArtifacts(arts.items)),
      isAcademic ? Promise.resolve(setPendingProposals([])) : proposalsApi.list({ project_id: projectId, status: 'pending', limit: 5 }).then(props => setPendingProposals(props.items)),
      runsApi.list({ project_id: projectId, limit: 5 }).then(setRecentRuns),
      memoryApi.list({ project_id: projectId, limit: 5 }).then(mems => setProjectMemory(mems.items)),
      sourcesApi.channels().then(setSourceChannels),
      sourcesApi.projectSourceBindings({ project_id: projectId }).then(setSourceBindings),
      sourcesApi.projectItems({ project_id: projectId, limit: 5 }).then(sourceItems => setRecentSourceItems(sourceItems.items.map(projectItem => projectItem.item))),
      isAcademic ? Promise.resolve(setRecentEvidence([])) : sourcesApi.evidence({ project_id: projectId, status: 'active', limit: 5 }).then(evidenceItems => setRecentEvidence(evidenceItems.items)),
      isAcademic ? Promise.resolve(setSourceRecommendations([])) : sourcesApi.postProcessingDecisions({ project_id: projectId, limit: 20 }).catch(() => ({ items: [] as SourcePostProcessingItemDecision[], total: 0, limit: 20, offset: 0 }))
        .then(recommendations => setSourceRecommendations(recommendations.items.filter(item => item.relevance !== 'not_relevant').slice(0, 5))),
      isAcademic ? Promise.resolve(setReaderAnnotations([])) : readerApi.listByProject(projectId, 5).catch(() => ({ items: [] as ReaderAnnotation[] })).then(readerAnns => setReaderAnnotations(readerAnns.items)),
      automationsApi.list({ project_id: projectId }).catch(() => [] as AutomationOut[]).then(allAutomations => setAutomations(allAutomations.filter(a => a.status !== 'archived'))),
      (projectsApi.operations ? projectsApi.operations(projectId).catch(() => [] as ProjectOperation[]) : Promise.resolve([] as ProjectOperation[])).then(setOperations),
    ])

    const researchLoad = isAcademic
      ? (async () => {
          try {
            let workflows: Awaited<ReturnType<typeof projectResearchApi.workflows>> = []
            await Promise.all([
              projectResearchApi.workflows(projectId).then(value => { workflows = value; setResearchWorkflows(value) }),
              projectResearchApi.literatureMatrix(projectId).then(setLiteratureMatrix),
              projectResearchApi.reports(projectId).then(setResearchReports),
              projectResearchApi.scanSummaries(projectId).then(setResearchScanSummaries),
              providersApi.list().catch(() => []).then(setModelProviders),
              inquiryApi.listThreads(projectId).then(setInquiryThreads),
            ])
            const storedWorkflowId = window.localStorage.getItem(`project:${projectId}:research-workflow`)
            const activeWorkflow = researchWorkflowForDisplayFrom(workflows, storedWorkflowId)
            setSelectedResearchWorkflowId(activeWorkflow?.id ?? null)
            setResearchCheckpoints(
              activeWorkflow ? await projectResearchApi.checkpoints(projectId, activeWorkflow.id) : [],
            )
          } catch (researchError) {
            setResearchWorkflows([])
            setResearchScanSummaries([])
            setResearchCheckpoints([])
            setLiteratureMatrix([])
            setResearchReports([])
            setModelProviders([])
            setInquiryThreads([])
            throw researchError
          }
        })()
      : (async () => {
          setResearchWorkflows([])
          setResearchScanSummaries([])
          setResearchCheckpoints([])
          setLiteratureMatrix([])
          setResearchReports([])
          setModelProviders([])
        })()

    try {
      await Promise.all([genericLoad, researchLoad])
    } catch (e) {
      toast.error(errMsg(e))
    } finally {
      setDetailsLoading(false)
      setResearchDataLoading(false)
    }
  }, [projectId, activeSpaceId])

  const refreshOperations = useCallback(async (): Promise<ProjectOperation[] | null> => {
    if (!projectId) return null
    try {
      const nextOperations = await projectsApi.operations(projectId)
      setOperations(nextOperations)
      try {
        setRecentRuns(await runsApi.list({ project_id: projectId, limit: 5 }))
      } catch {
        // Run status is supplementary to the operation read model.
      }
      return nextOperations
    } catch {
      // Keep the last known operation state visible on a transient refresh failure.
      return null
    }
  }, [projectId])

  const refreshResearchState = useCallback(async () => {
    if (!projectId || !activeSpaceId) return
    try {
      const [operationRows, workflows] = await Promise.all([
        projectsApi.operations(projectId),
        projectResearchApi.workflows(projectId),
      ])
      const activeWorkflow = researchWorkflowForDisplayFrom(workflows, selectedResearchWorkflowId)
      setOperations(operationRows)
      setResearchWorkflows(workflows)
      const [checkpoints, matrix, reports, scanSummaries] = await Promise.all([
        activeWorkflow
          ? projectResearchApi.checkpoints(projectId, activeWorkflow.id).catch(() => [] as ProjectResearchCheckpoint[])
          : Promise.resolve([] as ProjectResearchCheckpoint[]),
        projectResearchApi.literatureMatrix(projectId).catch(() => [] as ProjectResearchLiteratureMatrixItem[]),
        projectResearchApi.reports(projectId).catch(() => [] as ProjectResearchReport[]),
        projectResearchApi.scanSummaries(projectId).catch(() => [] as ProjectResearchScanSummary[]),
      ])
      setResearchCheckpoints(checkpoints)
      setLiteratureMatrix(matrix)
      setResearchReports(reports)
      setResearchScanSummaries(scanSummaries)
    } catch {
      // Keep the last known research state visible on a transient refresh failure.
    }
  }, [projectId, activeSpaceId, selectedResearchWorkflowId])

  const refreshSourceSelection = useCallback(async () => {
    if (!projectId) return
    try {
      const [channels, bindings] = await Promise.all([
        sourcesApi.channels(),
        sourcesApi.projectSourceBindings({ project_id: projectId }),
      ])
      setSourceChannels(channels)
      setSourceBindings(bindings)
    } catch {
      // Keep the current source selection visible on a transient refresh failure.
    }
  }, [projectId])

  const refreshProjectSources = useCallback(async () => {
    if (!projectId) return
    try {
      const [bindings, sourceItems, evidenceItems, recommendations] = await Promise.all([
        sourcesApi.projectSourceBindings({ project_id: projectId }),
        sourcesApi.projectItems({ project_id: projectId, limit: 5 }),
        sourcesApi.evidence({ project_id: projectId, status: 'active', limit: 5 }),
        sourcesApi.postProcessingDecisions({ project_id: projectId, limit: 20 }).catch(() => ({ items: [] as SourcePostProcessingItemDecision[], total: 0, limit: 20, offset: 0 })),
      ])
      setSourceBindings(bindings)
      setRecentSourceItems(sourceItems.items.map(projectItem => projectItem.item))
      setRecentEvidence(evidenceItems.items)
      setSourceRecommendations(recommendations.items.filter(item => item.relevance !== 'not_relevant').slice(0, 5))
    } catch {
      // Keep the current source module visible on a transient refresh failure.
    }
  }, [projectId])

  const refreshFolderData = useCallback(async () => {
    if (!projectId) return
    try {
      const [folderPage, nextSummary] = await Promise.all([
        projectFoldersApi.list(projectId, { limit: '200' }),
        projectsApi.getSummary(projectId),
      ])
      setFolders(folderPage.items)
      setSummary(nextSummary)
    } catch {
      // Keep the current Folder module visible on a transient refresh failure.
    }
  }, [projectId])

  useEffect(() => { loadAll() }, [loadAll])

  const researchProgressPollBusy = useRef(false)
  const researchLifecycleSignatureRef = useRef<string | null>(null)
  const researchReviewToastIdsRef = useRef(new Map<string, string>())
  const hasActiveResearchOperation = operations.some(
    operation => operation.kind === 'research' && ['active', 'waiting_review'].includes(operation.status),
  )
  const hasActiveProjectRun = recentRuns.some(run => !TERMINAL_RUN_STATUSES.has(run.status))

  const refreshRecentRuns = useCallback(async () => {
    if (!projectId) return
    try {
      setRecentRuns(await runsApi.list({ project_id: projectId, limit: 5 }))
    } catch {
      // Keep the last known run state visible on a transient refresh failure.
    }
  }, [projectId])

  useEffect(() => {
    if (!projectId || (!hasActiveProjectRun && !hasActiveResearchOperation)) return
    void refreshRecentRuns()
    const timer = window.setInterval(() => { void refreshRecentRuns() }, 5_000)
    return () => window.clearInterval(timer)
  }, [projectId, hasActiveProjectRun, hasActiveResearchOperation, refreshRecentRuns])

  useEffect(() => {
    if (!projectId) return
    const pendingIds = new Set(
      researchCheckpoints
        .filter(checkpoint => checkpoint.status === 'pending' && isResearchHumanReviewCheckpoint(checkpoint))
        .map(checkpoint => checkpoint.id),
    )

    for (const checkpoint of researchCheckpoints) {
      if (
        checkpoint.status !== 'pending'
        || !isResearchHumanReviewCheckpoint(checkpoint)
        || researchReviewToastIdsRef.current.has(checkpoint.id)
      ) continue
      const toastId = `research-review:${projectId}:${checkpoint.id}`
      researchReviewToastIdsRef.current.set(checkpoint.id, toastId)
      toast.warning('Research review required', {
        id: toastId,
        duration: Infinity,
        description: `${researchCheckpointLabel(checkpoint)} is ready for your review. The workflow is paused until you decide.`,
        action: {
          label: 'Review now',
          onClick: () => {
            const section = document.getElementById('research-checkpoints')
            if (section) {
              section.scrollIntoView({ behavior: 'smooth', block: 'center' })
            } else {
              navigate(`/projects/${projectId}`)
            }
          },
        },
      })
    }

    for (const [checkpointId, toastId] of researchReviewToastIdsRef.current) {
      if (pendingIds.has(checkpointId)) continue
      toast.dismiss(toastId)
      researchReviewToastIdsRef.current.delete(checkpointId)
    }
  }, [navigate, projectId, researchCheckpoints])

  const refreshResearchProgress = useCallback(async () => {
    const nextOperations = await refreshOperations()
    if (!nextOperations) return
    const nextSignature = researchLifecycleSignature(nextOperations)
    const previousSignature = researchLifecycleSignatureRef.current
    researchLifecycleSignatureRef.current = nextSignature
    if (previousSignature !== null && previousSignature !== nextSignature) {
      await refreshResearchState()
    }
  }, [refreshOperations, refreshResearchState])

  useEffect(() => {
    if (!hasActiveResearchOperation) return
    const refresh = async () => {
      if (researchProgressPollBusy.current) return
      researchProgressPollBusy.current = true
      try {
        await refreshResearchProgress()
      } finally {
        researchProgressPollBusy.current = false
      }
    }
    void refresh()
    const timer = window.setInterval(() => { void refresh() }, 5_000)
    return () => window.clearInterval(timer)
  }, [hasActiveResearchOperation, refreshResearchProgress])

  async function archive() {
    if (!project) return
    setArchiving(true)
    try {
      const updated = await projectsApi.archive(project.id)
      setProject(updated)
      toast.success('Project archived')
    } catch (e) {
      toast.error(errMsg(e))
    } finally {
      setArchiving(false)
    }
  }

  async function unregisterFolder(folder: ProjectFolder) {
    try {
      await projectFoldersApi.unregister(project!.id, folder.id)
      toast.success('Project Folder unregistered')
      setFolders(prev => prev.filter(f => f.id !== folder.id))
    } catch (e) {
      toast.error(errMsg(e))
    }
  }

  async function updateProjectItemSource(item: SourceItem, connectionId: string) {
    if (item.connection_id === connectionId) return
    setUpdatingItemSourceId(item.id)
    try {
      const updatedItem = await sourcesApi.updateItem(item.id, { connection_id: connectionId })
      toast.success('Item source updated')
      setRecentSourceItems(current => current.map(currentItem => currentItem.id === updatedItem.id ? updatedItem : currentItem))
    } catch (e) {
      toast.error(errMsg(e))
    } finally {
      setUpdatingItemSourceId(null)
    }
  }

  async function backfillSourceBinding(binding: ProjectSourceBinding) {
    if (!projectId) return
    setBackfillingBindingId(binding.id)
    try {
      const result = await sourcesApi.backfillProjectSourceBinding(projectId, binding.id)
      toast.success(`Backfilled ${result.created_links} project items`)
      await Promise.all([refreshProjectSources(), refreshOperations()])
    } catch (e) {
      toast.error(errMsg(e))
    } finally {
      setBackfillingBindingId(null)
    }
  }

  async function removeSourceBinding(binding: ProjectSourceBinding) {
    if (!projectId) return
    setRemovingBindingId(binding.id)
    try {
      await (projectsApi.deleteSourceBinding ?? sourcesApi.deleteProjectSourceBinding)(projectId, binding.id)
      toast.success('Source removed from project')
      setBindingToRemove(null)
      await refreshProjectSources()
    } catch (e) {
      toast.error(errMsg(e))
    } finally {
      setRemovingBindingId(null)
    }
  }

  async function startInitialResearch(config: ProjectResearchInitialIntakeInput) {
    if (!project) return
    setResearchActionBusy('start-initial-intake')
    try {
      const response = await projectResearchApi.startInitialIntake(project.id, {
        ...config,
        ...(selectedResearchWorkflowId ? { workflow_id: selectedResearchWorkflowId } : {}),
      })
      if (response.workflow) setResearchWorkflows(current => upsertById(current, response.workflow!))
      setOperations(current => upsertById(current, response.operation))
      setSourceChannels(current => mergeById(current, response.source_channels))
      setSourceBindings(current => mergeById(current, response.source_bindings))
      toast.success('Initial literature research started')
    } catch (e) {
      toast.error(errMsg(e))
    } finally {
      setResearchActionBusy(null)
    }
  }

  async function saveInitialIntake(config: ProjectResearchInitialIntakeInput): Promise<boolean> {
    if (!project) return false
    setResearchActionBusy('save-initial-intake')
    try {
      const workflow = await projectResearchApi.saveInitialIntakeDraft(project.id, {
        ...config,
        ...(selectedResearchWorkflowId ? { workflow_id: selectedResearchWorkflowId } : {}),
      })
      setResearchWorkflows((current) => {
        const existing = current.findIndex((item) => item.id === workflow.id)
        if (existing === -1) return [workflow, ...current]
        return current.map((item) => item.id === workflow.id ? workflow : item)
      })
      toast.success('Initial literature intake setup saved')
      return true
    } catch (e) {
      toast.error(errMsg(e))
      return false
    } finally {
      setResearchActionBusy(null)
    }
  }

  async function refineResearchQuestion(input: { research_question: string; history: Array<{ role: 'user' | 'assistant'; content: string }>; execution: { model_provider_id?: string; model_name?: string } }): Promise<ProjectResearchQuestionRefinement> {
    if (!project) throw new Error('Project is not loaded')
    return projectResearchApi.refineQuestion(project.id, input)
  }

  async function loadResearchQuestionImpact() {
    if (!project) throw new Error('Project is not loaded')
    if (!selectedResearchWorkflowId) throw new Error('Select a research question first')
    return projectResearchApi.questionChangeImpact(project.id, selectedResearchWorkflowId)
  }

  async function resolveResearchQuestion(strategy: import('../../types/api').ProjectResearchQuestionResolutionStrategy): Promise<boolean> {
    if (!project) return false
    setResearchActionBusy('apply-question')
    try {
      if (!selectedResearchWorkflowId) throw new Error('Select a research question first')
      await projectResearchApi.resolveQuestionChange(project.id, selectedResearchWorkflowId, strategy)
      toast.success(strategy === 'rescreen' ? 'Corpus re-screening started' : strategy === 'synthesis_only' ? 'New synthesis started' : 'Research question applied to future runs')
      await loadAll()
      return true
    } catch (e) {
      toast.error(errMsg(e))
      return false
    } finally {
      setResearchActionBusy(null)
    }
  }

  async function extendResearchHistory(config: { from: string; to?: string; max_items: number }) {
    if (!project) return
    const workflow = researchWorkflowForDisplayFrom(researchWorkflows, selectedResearchWorkflowId)
    if (!workflow) {
      toast.error('Start and complete the initial literature intake before extending history')
      return
    }
    setResearchActionBusy('extend-history')
    try {
      await projectResearchApi.historyBackfill(project.id, workflow.id, config)
      toast.success('Historical backfill started')
      await refreshOperations()
    } catch (e) {
      toast.error(errMsg(e))
    } finally {
      setResearchActionBusy(null)
    }
  }

  async function triggerIncrementalResearch() {
    if (!project) return
    const workflow = researchWorkflowForDisplayFrom(researchWorkflows, selectedResearchWorkflowId)
    if (!workflow) {
      toast.error('Start the initial literature intake before running an incremental scan')
      return
    }
    setResearchActionBusy('incremental')
    try {
      await projectResearchApi.triggerIncremental(project.id, workflow.id)
      toast.success('Incremental research scan started')
      await refreshOperations()
    } catch (e) {
      toast.error(errMsg(e))
    } finally {
      setResearchActionBusy(null)
    }
  }

  async function retryResearchOperation(operationId: string) {
    if (!project) return
    const operation = operations.find(item => item.id === operationId && item.kind === 'research' && item.status === 'failed')
    if (!operation) return
    setResearchActionBusy('retry-operation')
    try {
      await projectResearchApi.retryOperation(project.id, operation.id)
      toast.success('Research operation retry queued')
      await Promise.all([
        refreshOperations(),
        operation.progress_json.failed_stage === 'monitor_setup' ? refreshSourceSelection() : Promise.resolve(),
      ])
    } catch (e) {
      toast.error(errMsg(e))
    } finally {
      setResearchActionBusy(null)
    }
  }

  async function reconcileResearchOperation(operationId: string) {
    if (!project) return
    const operation = operations.find(item => item.id === operationId)
    if (!operation) {
      toast.error('The research operation is no longer in the page state. Refresh the project and try again.')
      return
    }
    setResearchActionBusy('reconcile-operation')
    try {
      const reconciled = await projectResearchApi.reconcileOperation(project.id, operation.id)
      await Promise.all([refreshOperations(), refreshResearchState()])
      const stillInSynthesis = reconciled.status === 'active'
        && reconciled.progress_json.current_stage === 'synthesis'
      if (stillInSynthesis) {
        const boundRunStatus = reconciled.reconcile_diagnostic?.bound_run_status
        toast.error(boundRunStatus
          ? `The operation is still in synthesis because its bound run is ${boundRunStatus}. Open that run to inspect it.`
          : 'The operation is still in synthesis and has no readable bound run. Check the server reconciliation log.')
      } else {
        toast.success('Research operation status synchronized')
      }
    } catch (e) {
      toast.error(errMsg(e))
    } finally {
      setResearchActionBusy(null)
    }
  }

  async function rescanResearchBackfill() {
    if (!project) return
    const operation = operations.find(item => item.kind === 'research'
      && item.progress_json.workflow_id === selectedResearchWorkflowId
      && ['baseline', 'historical_backfill'].includes(String(item.progress_json.run_kind))
      && researchOperationStage(item) !== 'monitor_setup'
      && item.progress_json.partial !== true)
    if (!operation) return
    setResearchActionBusy('rescan-backfill')
    try {
      await projectResearchApi.rescanBackfill(project.id, operation.id)
      toast.success('Rescan queued using the current monitor query')
      await refreshOperations()
    } catch (e) {
      toast.error(errMsg(e))
    } finally {
      setResearchActionBusy(null)
    }
  }

  async function decideResearchCheckpoint(checkpoint: ProjectResearchCheckpoint, decision: 'approved' | 'rejected') {
    if (!project) return
    setResearchActionBusy(`checkpoint-${checkpoint.id}`)
    try {
      await projectResearchApi.decideCheckpoint(project.id, checkpoint.workflow_id, checkpoint.id, { decision })
      const toastId = researchReviewToastIdsRef.current.get(checkpoint.id)
      if (toastId) {
        toast.dismiss(toastId)
        researchReviewToastIdsRef.current.delete(checkpoint.id)
      }
      toast.success(decision === 'approved' ? 'Checkpoint approved' : 'Checkpoint rejected')
      await Promise.all([
        refreshResearchState(),
        checkpoint.checkpoint_type === 'idea_review' && decision === 'approved' ? refreshSourceSelection() : Promise.resolve(),
      ])
    } catch (e) {
      toast.error(errMsg(e))
    } finally {
      setResearchActionBusy(null)
    }
  }

  async function rebuildLiteratureMatrix() {
    if (!project) return
    setResearchActionBusy('rebuild-matrix')
    try {
      const rows = await projectResearchApi.rebuildLiteratureMatrix(project.id)
      setLiteratureMatrix(rows)
      const workflow = researchWorkflowForDisplayFrom(researchWorkflows, selectedResearchWorkflowId)
      if (workflow?.status === 'active') {
        const updatedWorkflow = await projectResearchApi.runStage(project.id, workflow.id, 'screening_matrix')
        setResearchWorkflows(current => upsertById(current, updatedWorkflow))
      }
      toast.success(`Literature matrix rebuilt with ${rows.length} papers`)
    } catch (e) {
      toast.error(errMsg(e))
    } finally {
      setResearchActionBusy(null)
    }
  }

  async function runIntegrityGate() {
    if (!project) return
    const scopedReports = researchReports.filter(item => item.workflow_id === selectedResearchWorkflowId)
    const report = scopedReports.find(item => item.status !== 'rejected') ?? scopedReports[0]
    if (!report) {
      toast.error('Generate a research report before running integrity')
      return
    }
    setResearchActionBusy('run-integrity')
    try {
      await projectResearchApi.runReportIntegrity(project.id, report.id)
      await refreshResearchState()
      toast.success('Integrity report created')
    } catch (e) {
      toast.error(errMsg(e))
    } finally {
      setResearchActionBusy(null)
    }
  }

  async function handleWorkflowRunCreated(run: Run) {
    setRecentRuns(current => [run, ...current.filter(item => item.id !== run.id)].slice(0, 5))
    if (!projectId) return
    try {
      setSummary(await projectsApi.getSummary(projectId))
    } catch {
      // The newly created run is already visible; summary refresh is best-effort.
    }
  }

  if (loading) {
    return (
      <div className="p-6 space-y-4">
        <Skeleton className="h-10 w-64" />
        <Skeleton className="h-32 w-full" />
        <Skeleton className="h-32 w-full" />
      </div>
    )
  }

  if (notFound || !project) {
    return (
      <div className="p-6">
        <EmptyState
          title="Project not found"
          description="This project may have been deleted or you may not have access."
          action={<Button variant="ghost" onClick={() => navigate('/projects')}>Back to projects</Button>}
        />
      </div>
    )
  }

  const workflowFolderOptions = folders.map(folder => ({
    id: folder.id,
    name: folder.name,
    root_path: folder.root_path,
  }))
  const sourceChannelById = Object.fromEntries(sourceChannels.map(channel => [channel.id, channel])) as Record<string, SourceChannel>
  const linkedSourceChannels = sourceBindings
    .map(binding => sourceChannelById[binding.source_channel_id])
    .filter((channel): channel is SourceChannel => Boolean(channel))
  const projectSourceOptions = Array.from(
    new Map(
      linkedSourceChannels.map(channel => [
        channel.source_connection_id,
        {
          value: channel.source_connection_id,
          label: `${channel.name} · ${channel.provider.display_name ?? channel.provider.key ?? 'Provider'}`,
          connectionId: channel.source_connection_id,
        },
      ]),
    ).values(),
  )
  // Academic Research presentation is a Template-provenance default; see
  // the matching comment in loadAllImpl's isAcademic computation.
  const isAcademicProject = templateKeyFromProject(project) === ACADEMIC_TEMPLATE_KEY
  // Item limit is a Research setting: it is independent of the question and
  // monitor setup. Once a backfill operation has plans, editing raises the
  // live plans' budget; before that, it updates only the saved limit draft.
  const researchOperationForSettings = operations.find(item => item.kind === 'research'
    && item.progress_json.workflow_id === selectedResearchWorkflowId
    && ['baseline', 'historical_backfill'].includes(String(item.progress_json.run_kind))
    && numberValue(objectValue(item.progress_json.history).max_items) > 0)
  const researchSetupDraft = researchSetupDraftFromWorkflow(
    researchWorkflowForDisplayFrom(researchWorkflows, selectedResearchWorkflowId),
    String(researchWorkflowForDisplayFrom(researchWorkflows, selectedResearchWorkflowId)?.state_json.research_question ?? ''),
    sourceBindings.filter(binding => binding.status === 'active').map(binding => binding.source_channel_id),
  )
  const researchMonitorLabels = linkedSourceChannels.length
    ? linkedSourceChannels.map(channel => channel.name)
    : researchSetupDraft.query_strategy_id
      ? [`Adaptive strategy ${researchSetupDraft.query_strategy_id.slice(0, 8)}`]
      : []
  const currentItemLimit = researchOperationForSettings
    ? numberValue(objectValue(researchOperationForSettings.progress_json.history).max_items) || null
    : Number(researchSetupDraft.max_items) || null
  async function updateResearchItemLimit(newLimit: number) {
    if (!project) return
    if (researchOperationForSettings) {
      setResearchActionBusy('update-item-limit')
      try {
        await projectResearchApi.updateItemLimit(project.id, researchOperationForSettings.id, newLimit)
        toast.success('Research item limit updated')
        await refreshResearchState()
      } catch (e) {
        toast.error(errMsg(e))
      } finally {
        setResearchActionBusy(null)
      }
      return
    }
    setResearchActionBusy('update-item-limit')
    try {
      const workflow = await projectResearchApi.updateInitialItemLimit(project.id, newLimit, selectedResearchWorkflowId)
      setResearchWorkflows(current => upsertById(current, workflow))
      toast.success('Research item limit updated')
    } catch (e) {
      toast.error(errMsg(e))
    } finally {
      setResearchActionBusy(null)
    }
  }
  const visibleOperations = operations.filter(operation =>
    ['draft', 'active', 'waiting_review'].includes(operation.status)
    && !(isAcademicProject && operation.kind === 'research'),
  )

  return (
    <div className="p-6 space-y-6">
      {/* Breadcrumb */}
      <Link to="/projects" className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors">
        <ChevronLeft className="size-3" />
        Projects
      </Link>

      {/* Header */}
      <div className="flex items-start justify-between gap-4 flex-wrap pb-4 border-b border-border">
        <div className="flex items-start gap-4">
          <div
            className="w-11 h-11 rounded-xl flex items-center justify-center shrink-0 mt-0.5"
            style={{
              background: 'color-mix(in oklch, var(--primary) 12%, transparent)',
              border: '1px solid color-mix(in oklch, var(--primary) 35%, transparent)',
            }}
          >
            {isAcademicProject
              ? <BookOpen className="size-5 text-accent-foreground" />
              : <FolderKanban className="size-5 text-accent-foreground" />}
          </div>
          <div className="space-y-1">
            <div className="flex items-center gap-2 flex-wrap">
              <h1 className="text-xl font-semibold tracking-tight">{project.name}</h1>
              <StatusBadge status={project.status} />
              {isAcademicProject && <Badge variant="secondary">Academic Research</Badge>}
            </div>
            {project.description && (
              <p className="text-sm text-muted-foreground max-w-2xl">{project.description}</p>
            )}
            <p className="text-xs text-muted-foreground">Updated {fmt(project.updated_at)}</p>
          </div>
        </div>
        <div className="flex gap-2 shrink-0">
          <Button asChild size="sm" className="gap-1.5"><Link to={`/projects/${project.id}/rooms`}><MessageSquareText className="size-3.5" />Rooms</Link></Button>
          <Button variant="outline" size="sm" className="gap-1.5" onClick={() => setEditOpen(true)}>
            <SettingsIcon className="size-3.5" />
            Settings
          </Button>
          {project.status === 'active' && (
            <Button variant="outline" size="sm" className="gap-1.5" onClick={() => setArchiveConfirmOpen(true)} disabled={archiving}>
              <Archive className="size-3.5" />
              {archiving ? 'Archiving…' : 'Archive'}
            </Button>
          )}
        </div>
      </div>

      {kernelOverview && (
        <Card className="p-4 space-y-3">
          <div className="flex items-start gap-4 flex-wrap">
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <Badge variant="outline">{kernelOverview.project.primary_mode}</Badge>
                <span className="text-xs text-muted-foreground">Primary mode</span>
              </div>
              <p className="mt-2 text-sm font-medium">{kernelOverview.brief?.goal ?? 'Add a Project Brief goal to orient the work.'}</p>
              <p className="text-xs text-muted-foreground">{kernelOverview.mode_projection.current_state_summary}</p>
            </div>
            <Select
              value={kernelOverview.project.primary_mode}
              options={kernelOverview.available_modes.map(mode => ({
                value: mode,
                label: mode.charAt(0).toUpperCase() + mode.slice(1),
              }))}
              onChange={async value => {
                try {
                  await projectsApi.transitionMode(project.id, value, 'Changed from Project shell')
                  const next = await projectsApi.getOverview(project.id)
                  setKernelOverview(next)
                  setProject(current => current ? { ...current, primary_mode: next.project.primary_mode } : current)
                } catch (e) { toast.error(errMsg(e)) }
              }}
            />
          </div>
          <div className="flex gap-2 flex-wrap">
            {kernelOverview.area_summaries.map(item => (
              <Badge key={item.mode} variant="secondary">
                {item.mode}: {item.summary.count}
              </Badge>
            ))}
            {kernelOverview.attention.length > 0 && (
              <Badge variant="destructive">{kernelOverview.attention.length} need attention</Badge>
            )}
          </div>
          {(kernelOverview.mode_projection.next_actions.length > 0 || kernelOverview.mode_projection.focus_set.length > 0) && (
            <div className="flex gap-2 flex-wrap">
              {kernelOverview.mode_projection.next_actions.map(action => (
                <Button key={action.id} size="sm" asChild><Link to={action.href}>{action.label}</Link></Button>
              ))}
              {kernelOverview.mode_projection.focus_set.slice(0, 3).map(item => (
                <Button key={item.id} size="sm" variant="outline" asChild><Link to={item.href}>{item.label}</Link></Button>
              ))}
            </div>
          )}
          {(kernelOverview.setup_checklist?.length ?? 0) > 0 && (
            <div className="border-t pt-3">
              <div className="mb-2 flex items-center justify-between gap-2">
                <p className="text-sm font-medium">Setup checklist</p>
                {kernelOverview.template && <Badge variant="outline">Created from {kernelOverview.template.name}</Badge>}
              </div>
              <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                {kernelOverview.setup_checklist?.map(item => (
                  <Link key={item.id} to={item.href} className="flex items-start justify-between gap-2 rounded-md border p-2 text-sm hover:bg-muted/40">
                    <span><span className="block">{item.label}{item.required ? ' *' : ''}</span><span className="text-xs text-muted-foreground">{item.detail}</span></span>
                    <Badge variant={item.status === 'ready' ? 'success' : item.required ? 'warning' : 'outline'}>{item.status}</Badge>
                  </Link>
                ))}
              </div>
              <p className="mt-2 text-xs text-muted-foreground">A Workflow is created only when its required inputs are ready and you explicitly start it.</p>
            </div>
          )}
          {kernelOverview.attention.length > 0 && (
            <div className="border-t pt-3">
              <p className="mb-2 text-sm font-medium">Needs attention</p>
              <div className="grid gap-2 sm:grid-cols-2">
                {kernelOverview.attention.map(item => (
                  <Link key={item.id} to={item.href} className="rounded-md border border-destructive/30 p-3 hover:bg-destructive/5">
                    <p className="text-sm font-medium">{item.title}</p>
                    {item.summary && <p className="mt-1 text-xs text-muted-foreground">{item.summary}</p>}
                  </Link>
                ))}
              </div>
            </div>
          )}
        </Card>
      )}

      {/* Summary cards */}
      {summary && !isAcademicProject && (
        <section className="space-y-2">
          <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">Overview</h2>
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
            <SummaryCard icon={<Activity className="size-3.5" />} label="Activities" count={summary.activity_count} />
            <SummaryCard icon={<Package className="size-3.5" />} label="Artifacts" count={summary.artifact_count} />
            <SummaryCard icon={<CheckCircle className="size-3.5" />} label="Proposals" count={summary.pending_proposal_count} />
            <SummaryCard icon={<Folder className="size-3.5" />} label="Project Folders" count={summary.project_folder_count} />
            <SummaryCard icon={<Cpu className="size-3.5" />} label="Active runs" count={summary.active_run_count} />
            <SummaryCard icon={<Database className="size-3.5" />} label="Memory" count={summary.memory_entry_count} />
          </div>
        </section>
      )}

      {!isAcademicProject && visibleOperations.length > 0 && <section className="space-y-2">
        <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">Operations</h2>
        <div className="grid gap-3 md:grid-cols-2">
          {visibleOperations.map(operation => {
            const total=Number(operation.progress_json.total ?? 0),completed=Number(operation.progress_json.completed ?? 0),failed=Number(operation.progress_json.failed ?? 0)
            return <Card key={operation.id} className="p-4 space-y-2"><div className="flex items-center justify-between gap-2"><p className="text-sm font-medium truncate">{operation.title}</p><StatusBadge status={operation.status} /></div><p className="text-xs text-muted-foreground">{operation.kind.replace(/_/g,' ')} · {total ? `${completed}/${total} complete` : 'Preparing'}{failed ? ` · ${failed} failed` : ''}</p><div className="h-1.5 rounded bg-muted overflow-hidden"><div className="h-full bg-primary" style={{width:total?`${Math.min(100,completed/total*100)}%`:'5%'}} /></div>{operation.links&&operation.links.length>0&&<div className="flex flex-wrap gap-2">{operation.links.map(link=>{const to=link.target_type==='run'?`/runs/${link.target_id}`:link.target_type==='proposal'?`/proposals/${link.target_id}`:link.target_type==='source_backfill_plan'?`/projects/${project.id}/sources`:null;return to?<Link key={`${link.target_type}:${link.target_id}`} to={to} className="text-xs text-accent-foreground hover:underline">{link.role.replace(/_/g,' ')}</Link>:<span key={`${link.target_type}:${link.target_id}`} className="text-xs text-muted-foreground">{link.role.replace(/_/g,' ')}</span>})}</div>}</Card>
          })}
        </div>
      </section>}

      {/* Project focus is presentation state for non-Inquiry work. Academic
          Questions are owned by the selected Inquiry Thread/Workflow. */}
      {!isAcademicProject && <section className="space-y-2">
        <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">
          {isAcademicProject ? 'Research question' : 'Current focus'}
        </h2>
        {project.current_focus ? (
          <Card className="p-4">
            <div className="flex items-center justify-between gap-3">
              <div className="flex min-w-0 items-start gap-2">
                <Target className="size-4 text-accent-foreground mt-0.5 shrink-0" />
                <p className="text-sm">{project.current_focus}</p>
              </div>
              <Button variant="outline" size="sm" className="shrink-0 gap-1.5" onClick={() => setEditOpen(true)}>
                <Edit2 className="size-3.5" />
                {isAcademicProject ? 'Edit question' : 'Edit focus'}
              </Button>
            </div>
          </Card>
        ) : (
          <Card className="p-4">
            <p className="text-sm text-muted-foreground">
              {isAcademicProject
                ? 'No research question set. Add one to focus source monitoring, screening, and analysis.'
                : 'No current focus set. Add one to help agents and future project views understand what matters right now.'}
            </p>
            <Button variant="ghost" size="sm" className="mt-2 -ml-1" onClick={() => setEditOpen(true)}>
              <Edit2 className="size-3.5 mr-1.5" />
              {isAcademicProject ? 'Set research question' : 'Set focus'}
            </Button>
          </Card>
        )}
      </section>}

      {isAcademicProject && (
        <AcademicResearchWorkbench
          project={project}
          sourceChannels={sourceChannels}
          sourceBindings={sourceBindings}
          recentSourceItems={recentSourceItems}
          recentEvidence={recentEvidence}
          readerAnnotations={readerAnnotations}
          researchWorkflows={researchWorkflows}
          selectedWorkflowId={selectedResearchWorkflowId}
          onSelectWorkflow={workflowId => {
            setSelectedResearchWorkflowId(workflowId)
            window.localStorage.setItem(`project:${project.id}:research-workflow`, workflowId)
            projectResearchApi.checkpoints(project.id, workflowId)
              .then(setResearchCheckpoints)
              .catch(error => toast.error(errMsg(error)))
          }}
          researchScanSummaries={researchScanSummaries.filter(item => item.workflow_id === selectedResearchWorkflowId)}
          researchCheckpoints={researchCheckpoints}
          literatureMatrix={literatureMatrix}
          researchReports={researchReports.filter(item => item.workflow_id === selectedResearchWorkflowId)}
          researchOperations={operations}
          researchRunStatuses={Object.fromEntries(recentRuns.map(run => [run.id, run.status]))}
          researchDataLoading={researchDataLoading}
          modelProviders={modelProviders}
          questionThreads={inquiryThreads}
          researchActionBusy={researchActionBusy}
          onSaveInitialIntake={saveInitialIntake}
          onRefineQuestion={refineResearchQuestion}
          onStartInitialIntake={startInitialResearch}
          onExtendHistory={extendResearchHistory}
          onTriggerIncremental={triggerIncrementalResearch}
          onLoadQuestionImpact={loadResearchQuestionImpact}
          onResolveQuestion={resolveResearchQuestion}
          onRetryOperation={retryResearchOperation}
          onReconcileOperation={reconcileResearchOperation}
          onOpenSettings={() => setEditOpen(true)}
          onRescanBackfill={rescanResearchBackfill}
          onDecideCheckpoint={decideResearchCheckpoint}
          onRebuildMatrix={rebuildLiteratureMatrix}
          onRunIntegrity={runIntegrityGate}
          onEditQuestion={() => navigate(`/projects/${project.id}/inquiry`)}
        />
      )}

      {isAcademicProject && (
        <details className="rounded-lg border border-border bg-card p-4">
          <summary className="cursor-pointer select-none text-sm font-medium">Project details</summary>
          <p className="mt-2 text-xs text-muted-foreground">General project records are available here when needed; research results and the next action stay primary above.</p>
          <div className="mt-3 flex flex-wrap gap-x-3 gap-y-2 text-xs">
            <Link className="text-accent-foreground hover:underline" to={`/activity?project_id=${project.id}`}>{summary?.activity_count ?? recentActivities.length} activities</Link>
            <Link className="text-accent-foreground hover:underline" to={`/runs?project_id=${project.id}`}>{recentRuns.length} recent runs</Link>
            <Link className="text-accent-foreground hover:underline" to={`/proposals?project_id=${project.id}`}>{summary?.pending_proposal_count ?? pendingProposals.length} pending proposals</Link>
            <Link className="text-accent-foreground hover:underline" to={`/artifacts?project_id=${project.id}`}>{summary?.artifact_count ?? recentArtifacts.length} artifacts</Link>
            <Link className="text-accent-foreground hover:underline" to="/automations">{automations.length} automations</Link>
            <button type="button" className="text-accent-foreground hover:underline" onClick={() => setLinkOpen(true)}>{folders.length} Project Folders</button>
          </div>
        </details>
      )}

      {!isAcademicProject && (
        <section className="space-y-2">
          <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">Research workflows</h2>
          <ResearchWorkflowPanel
            projectId={project.id}
            projectName={project.name}
            folderOptions={workflowFolderOptions}
            onRunCreated={handleWorkflowRunCreated}
          />
        </section>
      )}

      {/* Sources consumption */}
      {!isAcademicProject && <section className="space-y-2">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">
              {isAcademicProject ? 'Research corpus' : 'Sources'}
            </h2>
            {detailsLoading && <Badge variant="muted">Loading</Badge>}
          </div>
          <div className="flex gap-2">
            {project.status === 'active' && (
              <>
                <Button variant="secondary" size="sm" className="gap-1.5" onClick={() => setSaveUrlOpen(true)}>
                  <FileText className="size-3.5" />
                  Save URL
                </Button>
                <Button variant="secondary" size="sm" className="gap-1.5" onClick={() => setSourceLinkOpen(true)}>
                  <Link2 className="size-3.5" />
                  Link source
                </Button>
              </>
            )}
            <Button variant="outline" size="sm" asChild>
              <Link to={`/projects/${project.id}/sources`}>
                <Rss className="size-3.5" />
                Manage sources
              </Link>
            </Button>
          </div>
        </div>
        <div className="grid gap-3 lg:grid-cols-3">
          <Card className="p-4">
            <div className="flex items-center gap-2 text-muted-foreground mb-3">
              <Link2 className="size-3.5" />
              <span className="text-xs font-medium uppercase tracking-wide">
                {isAcademicProject ? 'Literature sources' : 'Linked sources'}
              </span>
            </div>
            {sourceBindings.length === 0 ? (
              <p className="text-xs text-muted-foreground">
                {isAcademicProject
                  ? 'No literature sources are scoped to this research project.'
                  : 'No source bindings are scoped to this project.'}
              </p>
            ) : (
              <div className="space-y-2">
                {sourceBindings.slice(0, 4).map(binding => {
                  const channel = sourceChannelById[binding.source_channel_id]
                  return (
                    <div key={binding.id} className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <p className="text-sm font-medium truncate">{channel?.name ?? binding.source_channel_id}</p>
                        <p className="text-xs text-muted-foreground truncate">{channel?.provider.display_name ?? channel?.provider.key ?? binding.binding_key} · {channel ? sourceQueryText(channel) : 'Configured channel'}</p>
                      </div>
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        className="shrink-0 gap-1.5"
                        disabled={project.status !== 'active' || binding.status !== 'active' || backfillingBindingId === binding.id || removingBindingId === binding.id}
                        onClick={() => backfillSourceBinding(binding)}
                      >
                        <RefreshCw className="size-3.5" />
                        {backfillingBindingId === binding.id ? 'Backfilling…' : 'Backfill history'}
                      </Button>
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        className="shrink-0 gap-1.5 text-destructive hover:text-destructive"
                        disabled={project.status !== 'active' || binding.status === 'archived' || removingBindingId === binding.id}
                        onClick={() => setBindingToRemove(binding)}
                      >
                        <Trash2 className="size-3.5" />
                        {removingBindingId === binding.id ? 'Removing…' : 'Remove'}
                      </Button>
                    </div>
                  )
                })}
                {sourceBindings.length > 4 && <p className="text-xs text-muted-foreground">+{sourceBindings.length - 4} more</p>}
              </div>
            )}
            <div className="flex gap-1.5 flex-wrap mt-3">
              <Badge variant="outline">{sourceBindings.length} bindings</Badge>
              <Badge variant="muted">{linkedSourceChannels.length} channels</Badge>
            </div>
          </Card>
          <Card className="p-4">
            <div className="flex items-center gap-2 text-muted-foreground mb-3">
              <FileText className="size-3.5" />
              <span className="text-xs font-medium uppercase tracking-wide">
                {isAcademicProject ? 'Recent papers' : 'Recent items'}
              </span>
            </div>
            {recentSourceItems.length === 0 ? (
              <p className="text-xs text-muted-foreground">
                {isAcademicProject ? 'No project-linked papers or source items yet.' : 'No project-linked source items yet.'}
              </p>
            ) : (
              <div className="space-y-2">
                {recentSourceItems.map(item => (
                  <div key={item.id} className="min-w-0">
                    <p className="text-sm font-medium truncate">{item.title || 'Untitled item'}</p>
                    <p className="text-xs text-muted-foreground truncate">{item.source_domain ?? item.source_uri ?? item.library_status}</p>
                    {isManualUrlItem(item) && projectSourceOptions.length > 0 && (
                      <div className="mt-2">
                        <Select
                          size="sm"
                          value={item.connection_id ?? ''}
                          options={projectSourceOptions}
                          disabled={updatingItemSourceId === item.id}
                          onChange={value => updateProjectItemSource(item, value)}
                        />
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </Card>
          <Card className="p-4">
            <div className="flex items-center gap-2 text-muted-foreground mb-3">
              <CheckCircle className="size-3.5" />
              <span className="text-xs font-medium uppercase tracking-wide">Active evidence</span>
            </div>
            {recentEvidence.length === 0 ? (
              <p className="text-xs text-muted-foreground">No active evidence is linked to this project.</p>
            ) : (
              <div className="space-y-2">
                {recentEvidence.map(row => (
                  <div key={row.id} className="min-w-0">
                    <p className="text-sm font-medium truncate">{row.title}</p>
                    <p className="text-xs text-muted-foreground line-clamp-2">{row.content_excerpt ?? row.source_uri ?? row.evidence_type}</p>
                  </div>
                ))}
              </div>
            )}
          </Card>

          <Card className="p-4">
            <div className="flex items-center gap-2 text-muted-foreground mb-3">
              <Target className="size-3.5" />
              <span className="text-xs font-medium uppercase tracking-wide">
                {isAcademicProject ? 'Screening recommendations' : 'Source recommendations'}
              </span>
            </div>
            {sourceRecommendations.length === 0 ? (
              <p className="text-xs text-muted-foreground">
                {isAcademicProject
                  ? 'No screening recommendations for this research corpus yet.'
                  : 'No post-processing recommendations for this project yet.'}
              </p>
            ) : (
              <div className="space-y-2">
                {sourceRecommendations.map(decision => {
                  const channel = sourceChannels.find(item => item.id === decision.source_channel_id)
                  return (
                    <div key={decision.id} className="min-w-0">
                      <div className="flex items-center gap-1.5">
                        <Badge variant={decision.relevance === 'relevant' ? 'default' : decision.relevance === 'maybe' ? 'outline' : 'muted'}>
                          {decision.relevance}
                        </Badge>
                        {decision.confidence !== null && <Badge variant="muted">{Math.round(decision.confidence * 100)}%</Badge>}
                      </div>
                      <p className="mt-1 text-sm font-medium truncate">{decision.item.title ?? decision.source_item_id}</p>
                      <p className="text-xs text-muted-foreground line-clamp-2">{decision.reason ?? decision.item.source_domain ?? decision.review_status}</p>
                      {channel && (
                        <Link to={`/sources/${channel.source_connection_id}`} className="mt-1 block text-xs text-accent-foreground hover:underline">
                          {channel.source_name}
                        </Link>
                      )}
                    </div>
                  )
                })}
              </div>
            )}
          </Card>

          <Card className="p-4">
            <div className="flex items-center gap-2 text-muted-foreground mb-3">
              <FileText className="size-3.5" />
              <span className="text-xs font-medium uppercase tracking-wide">Reader annotations</span>
            </div>
            {readerAnnotations.length === 0 ? (
              <p className="text-xs text-muted-foreground">No shared reader annotations from sources bound to this project.</p>
            ) : (
              <div className="space-y-2">
                {readerAnnotations.map(ann => (
                  ann.document_type === 'source_item' ? (
                    <Link
                      key={ann.id}
                      to={`/library/items/${ann.document_id}`}
                      className="block min-w-0 rounded hover:bg-muted/50 -mx-1 px-1 py-0.5 transition-colors"
                    >
                      <p className="text-xs text-muted-foreground capitalize">{ann.annotation_type}</p>
                      <p className="text-sm line-clamp-2 italic">{ann.quote_text}</p>
                    </Link>
                  ) : (
                    <div key={ann.id} className="min-w-0">
                      <p className="text-xs text-muted-foreground capitalize">{ann.annotation_type}</p>
                      <p className="text-sm line-clamp-2 italic">{ann.quote_text}</p>
                    </div>
                  )
                ))}
              </div>
            )}
          </Card>
        </div>
      </section>}

      {/* Project Folders */}
      {!isAcademicProject && <section className="space-y-2">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">Project Folders</h2>
          {project.status === 'active' && (
            <Button variant="outline" size="sm" className="gap-1.5" onClick={() => setLinkOpen(true)}>
              <Plus className="size-3.5" />
              New Folder
            </Button>
          )}
        </div>
        {folders.length === 0 ? (
          <Card className="flex items-center justify-between gap-3 p-4">
            <p className="text-sm text-muted-foreground">
              No Project Folders yet. Create a managed Folder, clone a repository, or connect an existing directory for code, docs, or data.
            </p>
            <div className="flex shrink-0 gap-2">
              <Button size="sm" variant="outline" asChild><Link to={`/projects/${project.id}/files`}>Files &amp; Code</Link></Button>
              {project.status === 'active' && <Button size="sm" onClick={() => setLinkOpen(true)}>Create Folder</Button>}
            </div>
          </Card>
        ) : (
          <div className="space-y-2">
            {folders.map(folder => (
              <Card key={folder.id} className="p-3 flex items-center justify-between gap-3">
                <div className="flex items-center gap-3 min-w-0">
                  <Folder className="size-4 text-muted-foreground shrink-0" />
                  <div className="min-w-0">
                    <p className="text-sm font-medium truncate">{folder.name}</p>
                    {folder.root_path && (
                      <p className="text-xs text-muted-foreground font-mono truncate">{folder.root_path}</p>
                    )}
                  </div>
                  <Badge variant="outline" className="shrink-0">{folder.kind}</Badge>
                  {folder.is_primary && <Badge variant="secondary" className="shrink-0">primary</Badge>}
                </div>
                {project.status === 'active' && (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="text-muted-foreground hover:text-destructive shrink-0"
                    onClick={() => unregisterFolder(folder)}
                  >
                    <Trash2 className="size-3.5" />
                  </Button>
                )}
              </Card>
            ))}
          </div>
        )}
      </section>}

      {/* Project activity — scoped to this project */}
      <section className="space-y-4">
        <div className="flex items-center gap-2">
          <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">{isAcademicProject ? 'Project Memory' : 'Project activity'}</h2>
          {detailsLoading && <Badge variant="muted">Loading</Badge>}
        </div>

        {/* Recent activities */}
        {!isAcademicProject && <div className="space-y-1.5">
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium text-muted-foreground">Recent Activities</span>
            <Link to={`/activity?project_id=${project.id}`} className="text-xs text-accent-foreground hover:underline">View all →</Link>
          </div>
          {recentActivities.length === 0 ? (
            <Card className="p-3"><p className="text-xs text-muted-foreground">No activities for this project.</p></Card>
          ) : (
            <div className="space-y-1.5">
              {recentActivities.map(a => (
                <Card key={a.id} className="px-3 py-2 flex items-center justify-between gap-2">
                  <div className="min-w-0">
                    <p className="text-xs font-medium truncate">{a.title || a.content?.slice(0, 60) || '—'}</p>
                    <p className="text-xs text-muted-foreground">{a.source_type}</p>
                  </div>
                  <Badge variant="outline">{a.status}</Badge>
                </Card>
              ))}
            </div>
          )}
        </div>}

        {/* Recent artifacts */}
        {!isAcademicProject && <div className="space-y-1.5">
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium text-muted-foreground">Recent Artifacts</span>
            <Link to={`/artifacts?project_id=${project.id}`} className="text-xs text-accent-foreground hover:underline">View all →</Link>
          </div>
          {recentArtifacts.length === 0 ? (
            <Card className="p-3"><p className="text-xs text-muted-foreground">No artifacts for this project.</p></Card>
          ) : (
            <div className="space-y-1.5">
              {recentArtifacts.map(a => (
                <Card key={a.id} className="px-3 py-2 flex items-center justify-between gap-2">
                  <p className="text-xs font-medium truncate">{a.title}</p>
                  <Badge variant="outline">{a.artifact_type}</Badge>
                </Card>
              ))}
            </div>
          )}
        </div>}

        {/* Pending proposals */}
        {!isAcademicProject && <div className="space-y-1.5">
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium text-muted-foreground">Pending Proposals</span>
            <Link to={`/proposals?project_id=${project.id}`} className="text-xs text-accent-foreground hover:underline">View all →</Link>
          </div>
          {pendingProposals.length === 0 ? (
            <Card className="p-3"><p className="text-xs text-muted-foreground">No pending proposals for this project.</p></Card>
          ) : (
            <div className="space-y-1.5">
              {pendingProposals.map(p => (
                <Card key={p.id} className="px-3 py-2 flex items-center justify-between gap-2">
                  <div className="min-w-0">
                    <p className="text-xs font-medium truncate">{p.proposed_title || p.proposal_type}</p>
                    <p className="text-xs text-muted-foreground">{p.proposal_type}</p>
                  </div>
                  <Badge variant="outline">{p.urgency}</Badge>
                </Card>
              ))}
            </div>
          )}
        </div>}

        {/* Recent runs */}
        {!isAcademicProject && <div className="space-y-1.5">
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium text-muted-foreground">Recent Runs</span>
            <Link to={`/runs?project_id=${project.id}`} className="text-xs text-accent-foreground hover:underline">View all →</Link>
          </div>
          {recentRuns.length === 0 ? (
            <Card className="p-3"><p className="text-xs text-muted-foreground">No runs for this project.</p></Card>
          ) : (
            <div className="space-y-1.5">
              {recentRuns.map(r => (
                <Card key={r.id} className="px-3 py-2 flex items-center justify-between gap-2">
                  <div className="min-w-0">
                    <p className="text-xs font-medium font-mono truncate">{r.id.slice(-8)}</p>
                    <p className="text-xs text-muted-foreground">{r.mode} · {r.agent_id?.slice(-8)}</p>
                  </div>
                  <Badge variant="outline">{r.status}</Badge>
                </Card>
              ))}
            </div>
          )}
        </div>}

        {/* Automations bound to this project */}
        {!isAcademicProject && <div className="space-y-1.5">
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium text-muted-foreground">Automations</span>
            <Link to="/automations" className="text-xs text-accent-foreground hover:underline">View all →</Link>
          </div>
          {automations.length === 0 ? (
            <Card className="p-3"><p className="text-xs text-muted-foreground">No automations bound to this project.</p></Card>
          ) : (
            <div className="space-y-1.5">
              {automations.map(a => (
                <Card key={a.id} className="px-3 py-2 flex items-center justify-between gap-2">
                  <div className="min-w-0">
                    <p className="text-xs font-medium truncate">{a.name}</p>
                    <p className="text-xs text-muted-foreground">{a.trigger_type}{a.next_run_at ? ` · next ${new Date(a.next_run_at).toLocaleString()}` : ''}</p>
                  </div>
                  <Badge variant="outline">{a.status}</Badge>
                </Card>
              ))}
            </div>
          )}
        </div>}

        {/* Project memory */}
        <div className="space-y-1.5">
          <div className="flex items-center justify-between">
            {!isAcademicProject && <span className="text-xs font-medium text-muted-foreground">Project Memory</span>}
            <Link to={`/memory?project_id=${project.id}`} className="text-xs text-accent-foreground hover:underline">View all →</Link>
          </div>
          {projectMemory.length === 0 ? (
            <Card className="p-3"><p className="text-xs text-muted-foreground">No memory entries for this project.</p></Card>
          ) : (
            <div className="space-y-1.5">
              {projectMemory.slice(0, isAcademicProject ? 3 : projectMemory.length).map(m => (
                <Card key={m.id} className="px-3 py-2 flex items-center justify-between gap-2">
                  <div className="min-w-0">
                    <p className="text-xs font-medium truncate">{m.title || m.content?.slice(0, 60) || '—'}</p>
                    <p className="text-xs text-muted-foreground">{m.type} · {m.scope}</p>
                  </div>
                  <Badge variant="outline">{m.status}</Badge>
                </Card>
              ))}
            </div>
          )}
        </div>
      </section>

      {/* Dialogs */}
      <ConfirmDialog
        open={archiveConfirmOpen}
        onOpenChange={setArchiveConfirmOpen}
        title={`Archive “${project.name}”?`}
        description="The project will be hidden from active project lists, while its research records and artifacts remain preserved."
        confirmLabel="Archive project"
        onConfirm={() => { void archive() }}
      />

      <ConfirmDialog
        open={Boolean(bindingToRemove)}
        onOpenChange={open => { if (!open && !removingBindingId) setBindingToRemove(null) }}
        title="Remove source from project?"
        description="This stops the project from consuming the source. The Source and its monitors remain available for other projects."
        confirmLabel="Remove source"
        onConfirm={() => { if (bindingToRemove) void removeSourceBinding(bindingToRemove) }}
      />

      <EditProjectDialog
        project={project}
        open={editOpen}
        onOpenChange={setEditOpen}
        onSaved={updated => setProject(updated)}
        research={isAcademicProject ? {
          currentItemLimit,
          hasLiveOperation: researchOperationForSettings !== undefined,
          hasStartedWorkflow: researchWorkflows.some(workflow => workflow.status !== 'not_started'),
          busy: researchActionBusy !== null,
          onUpdateItemLimit: updateResearchItemLimit,
          snapshot: {
            question: project.current_focus ?? '',
            monitors: researchMonitorLabels,
            history: researchSetupDraft.history_mode === 'all_available' ? 'All available history' : `${researchSetupDraft.from || '—'} to ${researchSetupDraft.to || '—'}`,
            maxItems: Number(researchSetupDraft.max_items) || null,
            monitoringField: researchSetupDraft.monitoring_field === 'lastUpdatedDate' ? 'Last update date' : 'Submission date',
          },
        } : null}
      />

      <CreateProjectFolderDialog
        projectId={project.id}
        open={linkOpen}
        onOpenChange={setFolderDialogOpen}
        onCreated={refreshFolderData}
      />

      <ProjectSourceLinkDialog
        projectId={project.id}
        open={sourceLinkOpen}
        onOpenChange={setSourceLinkOpen}
        channels={sourceChannels}
        bindings={sourceBindings}
        onLinked={refreshProjectSources}
      />

      <SaveProjectUrlDialog
        open={saveUrlOpen}
        onOpenChange={setSaveUrlOpen}
        sourceOptions={projectSourceOptions}
        onSaved={refreshProjectSources}
      />
    </div>
  )
}
