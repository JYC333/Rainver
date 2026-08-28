import { useState, useEffect, useCallback, useRef } from 'react'
import { useParams } from 'react-router-dom'
import { useSpaceNavigate as useNavigate, SpaceLink as Link } from '../../core/spaceNav'
import {
  FolderKanban, Target, Edit2, Archive, ChevronLeft,
  Settings as SettingsIcon,
} from 'lucide-react'
import { toast } from 'sonner'
import { projectsApi } from '../../api/client'
import { useSpace } from '../../contexts/SpaceContext'
import { errMsg, isNotFoundError } from '../../lib/utils'
import type { Project, ProjectOverview } from '../../types/api'
import { Card } from '../../components/ui/card'
import { Button } from '../../components/ui/button'
import { StatusBadge } from '../../components/ui/badge'
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
import ProjectPulse from './ProjectPulse'
import { AmbientImportBanner } from './AmbientImportBanner'
import EditProjectInstructionDialog from './EditProjectInstructionDialog'

function fmt(dt: string | null | undefined) {
  return dt ? new Date(dt).toLocaleString() : '—'
}

/* ── Project settings dialog ──────────────────────────────────────────────── */
interface EditDialogProps {
  project: Project
  overview: ProjectOverview | null
  open: boolean
  onOpenChange: (v: boolean) => void
  onSaved: (updated: Project) => void
  onModeChanged: (overview: ProjectOverview) => void
}

// General Project settings only. Research intake configuration used to share
// this dialog; it belongs to the Research Area, which owns that state.
function EditProjectDialog({ project, overview, open, onOpenChange, onSaved, onModeChanged }: EditDialogProps) {
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
          {overview && (
            <div className="space-y-1.5">
              <Label>How this Project advances</Label>
              {/* Settings, not the front page: it changes only the Loop's stage
                  wording and the Assistant's framing, and is changed rarely. */}
              <Select
                ariaLabel="How this Project advances"
                value={overview.project.primary_mode}
                options={overview.available_modes.map(mode => ({
                  value: mode,
                  label: mode.charAt(0).toUpperCase() + mode.slice(1),
                }))}
                onChange={async value => {
                  try {
                    await projectsApi.transitionMode(project.id, value, 'Changed from Project settings')
                    onModeChanged(await projectsApi.getOverview(project.id))
                  } catch (e) { toast.error(errMsg(e)) }
                }}
              />
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

/* ── Main page ─────────────────────────────────────────────────────────────── */

/**
 * Pulse: what this Project is for, and what is going on in it.
 *
 * The header and the goal line are this page's own; the situation — what
 * needs attention, what is moving, what was reported — is `ProjectPulse`.
 * It used to carry four more blocks: a "Next" of Mode-generated links that
 * all pointed at Areas the sidebar already lists, a "Recent activity" that
 * was the raw-material queue under another name and jumped out of the
 * Project to see more, an "In this project" that was a second copy of the
 * Areas list with counts, and a Mode selector on the front page for a thing
 * changed once. Each duplicated something on the same screen.
 */
export default function ProjectDetailPage() {
  const { projectId } = useParams<{ projectId: string }>()
  const navigate = useNavigate()
  const { activeSpaceId, spaces, userId } = useSpace()

  const [project, setProject] = useState<Project | null>(null)
  const [kernelOverview, setKernelOverview] = useState<ProjectOverview | null>(null)
  const [loading, setLoading] = useState(true)
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

  /**
   * `quiet` refetches without the page skeleton. A surface acting on
   * something the overview reports needs the list to refresh, and blanking
   * the whole page for it would unmount the surface mid-action — the person
   * would see a flash and the acting component would reload twice.
   */
  const loadImpl = useCallback(async (quiet = false) => {
    if (!projectId || !activeSpaceId) {
      setLoading(false)
      return
    }
    if (!quiet) setLoading(true)
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
      if (isNotFoundError(e)) setNotFound(true)
      else toast.error(errMsg(e))
      setLoading(false)
    }
  }, [projectId, activeSpaceId])

  const load = useCallback(async (quiet = false) => {
    const key = `${projectId ?? ''}:${activeSpaceId ?? ''}`
    if (loadInFlightRef.current?.key === key) return loadInFlightRef.current.promise
    const promise = loadImpl(quiet)
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

      {/* What this Project is for, and what it is on right now. */}
      <Card className="p-4">
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div className="min-w-0 flex-1 space-y-2">
            <div>
              <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Goal</p>
              <p className="mt-1 text-sm font-medium">
                {kernelOverview?.brief?.goal ?? 'No goal yet.'}
              </p>
            </div>
            <div className="flex items-start gap-2">
              <Target className="mt-0.5 size-4 shrink-0 text-accent-foreground" />
              <p className="text-sm">
                {project.current_focus ?? (
                  <span className="text-muted-foreground">No current focus set.</span>
                )}
              </p>
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-2">
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
      </Card>

      {/* Made once, on the first visit after a folder is bound: a person's own
             terminal history becoming Project content is a decision, not a
             consequence of binding a folder. */}
      {projectId && <AmbientImportBanner projectId={projectId} />}

      {/* The situation, before anyone opens the Board: what is waiting on this
             person, what is moving, and what has been reported lately. */}
      {projectId && (
        <ProjectPulse
          projectId={projectId}
          overview={kernelOverview}
          /* The overview owns the attention list, so acting on an item from
             Pulse has to reload it here — a suggestion that stays on the list
             after being taken is the failure the classes exist to prevent. */
          onOverviewChanged={() => { void load(true) }}
        />
      )}

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
        overview={kernelOverview}
        open={editOpen}
        onOpenChange={setEditOpen}
        onSaved={updated => setProject(updated)}
        onModeChanged={next => {
          setKernelOverview(next)
          setProject(current => current ? { ...current, primary_mode: next.project.primary_mode } : current)
        }}
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
