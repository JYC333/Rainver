import { useState, useEffect, useCallback, useRef } from 'react'
import { useParams } from 'react-router-dom'
import { useSpaceNavigate as useNavigate, SpaceLink as Link } from '../../core/spaceNav'
import {
  FolderKanban, Target, Edit2, Archive, ChevronLeft,
  Package, CheckCircle, Folder, Cpu, Database, Workflow,
  HelpCircle, Scale, ListTodo, GraduationCap, FileText, Layers,
  MessageSquareText, Settings as SettingsIcon,
} from 'lucide-react'
import { toast } from 'sonner'
import { projectsApi, activityApi } from '../../api/client'
import { useSpace } from '../../contexts/SpaceContext'
import { errMsg, isNotFoundError } from '../../lib/utils'
import type { Project, ProjectOverview, ActivityInboxRecord } from '../../types/api'
import { Card } from '../../components/ui/card'
import { Button } from '../../components/ui/button'
import { Badge, StatusBadge } from '../../components/ui/badge'
import { Label } from '../../components/ui/label'
import { Input } from '../../components/ui/input'
import { Textarea } from '../../components/ui/textarea'
import { Select } from '../../components/ui/select'
import { Skeleton } from '../../components/ui/skeleton'
import { EmptyState } from '../../components/ui/empty-state'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  ConfirmDialog,
} from '../../components/ui/dialog'
import EditProjectBriefGoalDialog from './EditProjectBriefGoalDialog'
import EditProjectInstructionDialog from './EditProjectInstructionDialog'

function fmt(dt: string | null | undefined) {
  return dt ? new Date(dt).toLocaleString() : '—'
}

/* ── Project settings dialog ──────────────────────────────────────────────── */
interface EditDialogProps {
  project: Project
  open: boolean
  onOpenChange: (v: boolean) => void
  onSaved: (updated: Project) => void
}

// General Project settings only. Research intake configuration used to share
// this dialog; it belongs to the Research Area, which owns that state.
function EditProjectDialog({ project, open, onOpenChange, onSaved }: EditDialogProps) {
  const [name, setName] = useState(project.name)
  const [description, setDescription] = useState(project.description ?? '')
  const [focus, setFocus] = useState(project.current_focus ?? '')
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (open) {
      setName(project.name)
      setDescription(project.description ?? '')
      setFocus(project.current_focus ?? '')
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
            Update this project's name, description, and current focus.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4 py-2">
          <div className="space-y-1.5">
            <Label>Name <span className="text-destructive">*</span></Label>
            <Input value={name} onChange={e => setName(e.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label>Description</Label>
            <Textarea value={description} onChange={e => setDescription(e.target.value)} rows={3} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="project-current-focus">Current focus</Label>
            <Input
              id="project-current-focus"
              value={focus}
              onChange={e => setFocus(e.target.value)}
              placeholder="What are you actively working on right now?"
            />
          </div>
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

/* ── Entity summary row ───────────────────────────────────────────────────── */

/** Icons are presentation, so they live here rather than in the entity
 *  registry the server composes these rows from. An entity with no icon of
 *  its own still renders — it gets the generic one. */
const ENTITY_ICONS: Record<string, React.ReactNode> = {
  inquiry_thread: <HelpCircle className="size-4" />,
  research_workflow: <FileText className="size-4" />,
  decision_case: <Scale className="size-4" />,
  task: <ListTodo className="size-4" />,
  automation: <Workflow className="size-4" />,
  learning_item: <GraduationCap className="size-4" />,
  project_folder: <Folder className="size-4" />,
  run: <Cpu className="size-4" />,
  proposal: <CheckCircle className="size-4" />,
  artifact: <Package className="size-4" />,
  memory_entry: <Database className="size-4" />,
}

/** One line per entity: how much of it this Project has, and the way in.
 *  The rows themselves are chosen by the server — the current Mode's
 *  placeholders plus whatever the Project actually has data for. */
function EntitySummaryRow({ row }: { row: ProjectOverview['entity_summaries'][number] }) {
  return (
    <Link
      to={row.href}
      className="flex items-center justify-between gap-3 rounded-md border border-border px-3 py-2.5 transition-colors hover:bg-muted/40"
    >
      <div className="flex min-w-0 items-center gap-2.5">
        <span className="text-muted-foreground">{ENTITY_ICONS[row.entity_type] ?? <Layers className="size-4" />}</span>
        <div className="min-w-0">
          <p className="text-sm font-medium">{row.label}</p>
          <p className="truncate text-xs text-muted-foreground">{row.detail}</p>
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        {row.status !== 'ok' && (
          <Badge variant={row.status === 'blocked' ? 'destructive' : 'warning'}>{row.status}</Badge>
        )}
        <span className="text-lg font-semibold" style={{ fontFamily: 'var(--font-mono)' }}>{row.count}</span>
      </div>
    </Link>
  )
}

/* ── Main page ─────────────────────────────────────────────────────────────── */

/**
 * The Project Overview is a thin aggregation layer over Areas.
 *
 * It answers four questions and nothing else: what is this Project for, what
 * should happen next, what just happened, and how much of each kind of thing
 * exists. It used to also host the research workbench, Project Sources, and
 * Project Folders — surfaces that the Research, Sources, and Files Areas each
 * already own a route for — plus a second copy of the sidebar's setup
 * checklist and attention list.
 */
export default function ProjectDetailPage() {
  const { projectId } = useParams<{ projectId: string }>()
  const navigate = useNavigate()
  const { activeSpaceId, spaces, userId } = useSpace()

  const [project, setProject] = useState<Project | null>(null)
  const [kernelOverview, setKernelOverview] = useState<ProjectOverview | null>(null)
  const [recentActivities, setRecentActivities] = useState<ActivityInboxRecord[]>([])
  const [loading, setLoading] = useState(true)
  const [detailsLoading, setDetailsLoading] = useState(false)
  const [notFound, setNotFound] = useState(false)
  const [editOpen, setEditOpen] = useState(false)
  const [briefGoalOpen, setBriefGoalOpen] = useState(false)
  const [instructionOpen, setInstructionOpen] = useState(false)
  const [archiveConfirmOpen, setArchiveConfirmOpen] = useState(false)
  const [archiving, setArchiving] = useState(false)

  // React StrictMode (dev only) intentionally double-invokes the mount effect,
  // which has no cleanup to cancel the first call — collapse a second call for
  // the same project into the load already in flight.
  const loadInFlightRef = useRef<{ key: string; promise: Promise<void> } | null>(null)

  const loadImpl = useCallback(async () => {
    if (!projectId || !activeSpaceId) {
      setLoading(false)
      return
    }
    setLoading(true)
    setNotFound(false)
    try {
      const [proj, overview] = await Promise.all([
        projectsApi.get(projectId),
        projectsApi.getOverview(projectId),
      ])
      setProject(proj)
      setKernelOverview(overview)
      setLoading(false)
    } catch (e) {
      setDetailsLoading(false)
      if (isNotFoundError(e)) setNotFound(true)
      else toast.error(errMsg(e))
      setLoading(false)
      return
    }

    setDetailsLoading(true)
    try {
      await activityApi.list({ project_id: projectId, limit: 8 }).then(setRecentActivities)
    } catch (e) {
      toast.error(errMsg(e))
    } finally {
      setDetailsLoading(false)
    }
  }, [projectId, activeSpaceId])

  const load = useCallback(async () => {
    const key = `${projectId ?? ''}:${activeSpaceId ?? ''}`
    if (loadInFlightRef.current?.key === key) return loadInFlightRef.current.promise
    const promise = loadImpl()
    loadInFlightRef.current = { key, promise }
    try {
      await promise
    } finally {
      if (loadInFlightRef.current?.promise === promise) loadInFlightRef.current = null
    }
  }, [projectId, activeSpaceId, loadImpl])

  useEffect(() => { void load() }, [load])

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

  const nextActions = kernelOverview?.mode_projection.next_actions ?? []
  const focusSet = kernelOverview?.mode_projection.focus_set ?? []

  return (
    <div className="p-6 space-y-6">
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
            <FolderKanban className="size-5 text-accent-foreground" />
          </div>
          <div className="space-y-1">
            <div className="flex items-center gap-2 flex-wrap">
              <h1 className="text-xl font-semibold tracking-tight">{project.name}</h1>
              <StatusBadge status={project.status} />
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

      {/* 1. What this Project is for, and what it is on right now. */}
      <Card className="p-4 space-y-3">
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div className="min-w-0 flex-1 space-y-2">
            <div>
              <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Goal</p>
              <p className="mt-1 text-sm font-medium">
                {kernelOverview?.brief?.goal ?? 'Add a Project Brief goal to orient the work.'}
              </p>
            </div>
            <div className="flex items-start gap-2">
              <Target className="mt-0.5 size-4 shrink-0 text-accent-foreground" />
              <p className="text-sm">
                {project.current_focus ?? (
                  <span className="text-muted-foreground">No current focus set. Add one so agents and Areas know what matters right now.</span>
                )}
              </p>
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {kernelOverview && (
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
            )}
            <Button variant="outline" size="sm" className="gap-1.5" onClick={() => setBriefGoalOpen(true)}>
              <Edit2 className="size-3.5" />
              Edit goal
            </Button>
            {(project.current_user_can_approve_context === true || project.owner_user_id === userId || ['owner', 'admin'].includes(spaces.find(space => space.id === activeSpaceId)?.role ?? '')) && (
              <Button variant="outline" size="sm" onClick={() => setInstructionOpen(true)}>Instruction</Button>
            )}
            <Button variant="outline" size="sm" className="gap-1.5" onClick={() => setEditOpen(true)}>
              <Edit2 className="size-3.5" />
              Edit focus
            </Button>
          </div>
        </div>
        {kernelOverview?.mode_projection.current_state_summary && (
          <p className="text-xs text-muted-foreground">{kernelOverview.mode_projection.current_state_summary}</p>
        )}
      </Card>

      {/* 2. What should happen next, as this Project's current mode sees it.
             Pending review items live in the shell sidebar, which is on screen
             from every Area — not duplicated here. */}
      <section className="space-y-2">
        <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">Next</h2>
        {nextActions.length === 0 && focusSet.length === 0 ? (
          <Card className="p-3"><p className="text-xs text-muted-foreground">No next action suggested for this mode yet.</p></Card>
        ) : (
          <div className="flex flex-wrap gap-2">
            {nextActions.map(action => (
              <Button key={action.id} size="sm" asChild><Link to={action.href}>{action.label}</Link></Button>
            ))}
            {focusSet.slice(0, 3).map(item => (
              <Button key={item.id} size="sm" variant="outline" asChild><Link to={item.href}>{item.label}</Link></Button>
            ))}
          </div>
        )}
      </section>

      {/* 3. What just happened, across every domain. */}
      <section className="space-y-2">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">Recent activity</h2>
            {detailsLoading && <Badge variant="muted">Loading</Badge>}
          </div>
          <Link to={`/activity?project_id=${project.id}`} className="text-xs text-accent-foreground hover:underline">View all →</Link>
        </div>
        {recentActivities.length === 0 ? (
          <Card className="p-3"><p className="text-xs text-muted-foreground">Nothing has happened in this project yet.</p></Card>
        ) : (
          <div className="space-y-1.5">
            {recentActivities.map(item => (
              <Card key={item.id} className="px-3 py-2 flex items-center justify-between gap-2">
                <div className="min-w-0">
                  <p className="text-xs font-medium truncate">{item.title || item.content?.slice(0, 60) || '—'}</p>
                  <p className="text-xs text-muted-foreground">{item.source_type}</p>
                </div>
                <Badge variant="outline">{item.status}</Badge>
              </Card>
            ))}
          </div>
        )}
      </section>

      {/* 4. How much of each kind of thing this Project holds, and the way in. */}
      <section className="space-y-2">
        <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">In this project</h2>
        {(kernelOverview?.entity_summaries.length ?? 0) === 0 ? (
          <Card className="p-3"><p className="text-xs text-muted-foreground">This Project has no entity summaries yet.</p></Card>
        ) : (
          <div className="grid gap-2 md:grid-cols-2">
            {kernelOverview?.entity_summaries.map(row => (
              <EntitySummaryRow key={row.entity_type} row={row} />
            ))}
          </div>
        )}
      </section>

      <ConfirmDialog
        open={archiveConfirmOpen}
        onOpenChange={setArchiveConfirmOpen}
        title={`Archive “${project.name}”?`}
        description="The project will be hidden from active project lists, while its research records and artifacts remain preserved."
        confirmLabel="Archive project"
        onConfirm={() => { void archive() }}
      />

      <EditProjectDialog
        project={project}
        open={editOpen}
        onOpenChange={setEditOpen}
        onSaved={updated => setProject(updated)}
      />
      <EditProjectBriefGoalDialog
        projectId={project.id}
        brief={kernelOverview?.brief ?? null}
        canPublish={project.current_user_can_approve_context === true || project.owner_user_id === userId || ['owner', 'admin'].includes(spaces.find(space => space.id === activeSpaceId)?.role ?? '')}
        open={briefGoalOpen}
        onOpenChange={setBriefGoalOpen}
        onSaved={updated => {
          setKernelOverview(current => current ? { ...current, brief: updated } : current)
          setProject(current => current ? { ...current, active_brief_version_id: updated.id } : current)
        }}
      />
      <EditProjectInstructionDialog projectId={project.id} open={instructionOpen} onOpenChange={setInstructionOpen} />
    </div>
  )
}
