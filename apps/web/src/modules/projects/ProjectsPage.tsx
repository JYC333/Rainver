import { useState, useEffect, useCallback } from 'react'
import { useSpaceNavigate as useNavigate } from '../../core/spaceNav'
import { FolderKanban, Plus, Target } from 'lucide-react'
import { toast } from 'sonner'
import { projectTemplatesApi, projectsApi } from '../../api/client'
import { useSpace } from '../../contexts/SpaceContext'
import { errMsg } from '../../lib/utils'
import type { Project, ProjectTemplateDescriptor } from '../../types/api'
import { ACADEMIC_TEMPLATE_KEY, templateKeyFromProject } from './templateUtils'
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
} from '../../components/ui/dialog'

function fmt(dt: string | null | undefined) {
  return dt ? new Date(dt).toLocaleString() : '—'
}

const FILTER_OPTIONS = [
  { value: 'active', label: 'Active' },
  { value: 'archived', label: 'Archived' },
]

function blankTemplateFirst(templates: ProjectTemplateDescriptor[]) {
  return [...templates].sort((left, right) => {
    if (left.key === 'blank') return -1
    if (right.key === 'blank') return 1
    return 0
  })
}

export default function ProjectsPage() {
  const navigate = useNavigate()
  const { activeSpaceId, activeSpaceName } = useSpace()
  const [projects, setProjects] = useState<Project[]>([])
  const [loading, setLoading] = useState(true)
  const [projectTemplates, setProjectTemplates] = useState<ProjectTemplateDescriptor[]>([])
  const [statusFilter, setStatusFilter] = useState('active')
  const [createOpen, setCreateOpen] = useState(false)
  const [creating, setCreating] = useState(false)
  const [newName, setNewName] = useState('')
  const [newDescription, setNewDescription] = useState('')
  const [newFocus, setNewFocus] = useState('')
  const [newGoal, setNewGoal] = useState('')
  const [newScope, setNewScope] = useState('')
  const [newSuccessDefinition, setNewSuccessDefinition] = useState('')
  const [newTemplateKey, setNewTemplateKey] = useState<string | null>(null)
  const [templatesLoaded, setTemplatesLoaded] = useState(false)

  const loadProjects = useCallback(async () => {
    if (!activeSpaceId) {
      setProjects([])
      setLoading(false)
      return
    }
    setLoading(true)
    try {
      const page = await projectsApi.list({ status: statusFilter, limit: 100 })
      setProjects(page.items)
    } catch (e) {
      toast.error(errMsg(e))
      setProjects([])
    } finally {
      setLoading(false)
    }
  }, [statusFilter, activeSpaceId])

  useEffect(() => { loadProjects() }, [loadProjects])

  useEffect(() => {
    if (!activeSpaceId) {
      setProjectTemplates([])
      setTemplatesLoaded(false)
      return
    }
    setTemplatesLoaded(false)
    projectTemplatesApi.list()
      .then(templates => {
        setProjectTemplates(templates)
        setNewTemplateKey(current => current && templates.some(template => template.key === current)
          ? current
          : templates.find(template => template.key === 'blank')?.key ?? templates[0]?.key ?? null)
      })
      .catch(e => {
        setProjectTemplates([])
        setNewTemplateKey(null)
        toast.error(`Could not load Project Templates: ${errMsg(e)}`)
      })
      .finally(() => setTemplatesLoaded(true))
  }, [activeSpaceId])

  async function createProject() {
    if (!newName.trim()) {
      toast.error('Name is required')
      return
    }
    if (!newTemplateKey) {
      toast.error('Select a Project Template before creating the Project')
      return
    }
    setCreating(true)
    try {
      const project = await projectsApi.create({
        name: newName.trim(),
        description: newDescription.trim() || null,
        current_focus: newFocus.trim() || null,
        settings_json: null,
        template_key: newTemplateKey,
        goal: newGoal.trim() || null,
        scope_included: newScope.trim() || null,
        success_definition: newSuccessDefinition.trim() || null,
      })
      toast.success('Project created')
      setCreateOpen(false)
      setNewName('')
      setNewDescription('')
      setNewFocus('')
      setNewTemplateKey(projectTemplates.find(template => template.key === 'blank')?.key ?? projectTemplates[0]?.key ?? null)
      setNewGoal('')
      setNewScope('')
      setNewSuccessDefinition('')
      navigate(`/projects/${project.id}`)
    } catch (e) {
      toast.error(errMsg(e))
    } finally {
      setCreating(false)
    }
  }

  function resetForm() {
    setNewName('')
    setNewDescription('')
    setNewFocus('')
    setNewTemplateKey(projectTemplates.find(template => template.key === 'blank')?.key ?? projectTemplates[0]?.key ?? null)
    setNewGoal('')
    setNewScope('')
    setNewSuccessDefinition('')
  }

  return (
    <div className="p-6 space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between pb-4 border-b border-border gap-4 flex-wrap">
        <div className="flex items-center gap-4">
          <div
            className="w-11 h-11 rounded-xl flex items-center justify-center shrink-0"
            style={{
              background: 'color-mix(in oklch, var(--primary) 12%, transparent)',
              border: '1px solid color-mix(in oklch, var(--primary) 35%, transparent)',
            }}
          >
            <FolderKanban className="size-5 text-accent-foreground" />
          </div>
          <div>
            <h1 className="text-xl font-semibold tracking-tight">Projects</h1>
            <p className="text-sm text-muted-foreground">Goal and knowledge context for long-lived objectives.</p>
            <p className="text-xs text-muted-foreground">
              Space: {activeSpaceName ?? activeSpaceId ?? 'No space selected'}
            </p>
          </div>
        </div>
        <Button onClick={() => setCreateOpen(true)} className="gap-1.5">
          <Plus className="size-4" />
          New project
        </Button>
      </div>

      {/* Status filter */}
      <div className="flex items-end gap-3">
        <div className="flex flex-col gap-1 min-w-[140px]">
          <Label className="text-xs">Status</Label>
          <Select
            value={statusFilter}
            options={FILTER_OPTIONS}
            onChange={setStatusFilter}
          />
        </div>
      </div>

      {/* List */}
      {loading ? (
        <Card className="p-6 space-y-3">
          <Skeleton className="h-24 w-full" />
          <Skeleton className="h-24 w-full" />
        </Card>
      ) : !activeSpaceId ? (
        <EmptyState
          title="No space selected."
          description="Select an operational space to browse projects."
        />
      ) : projects.length === 0 ? (
        <EmptyState
          title="No projects yet."
          description="Projects organize long-lived goals, research, artifacts, proposals, and Project Folders. Create a project to group work around a goal."
          action={
            <Button onClick={() => setCreateOpen(true)} className="gap-1.5">
              <Plus className="size-4" />
              Create Project
            </Button>
          }
        />
      ) : (
        <div className="grid gap-3 md:grid-cols-2">
          {projects.map(project => (
            <Card
              key={project.id}
              className="p-4 cursor-pointer hover:bg-accent/30 transition-colors"
              onClick={() => navigate(`/projects/${project.id}`)}
            >
              <div className="flex items-start justify-between gap-2 mb-2">
                <span className="font-medium text-sm leading-snug">{project.name}</span>
                <StatusBadge status={project.status} />
              </div>
              {project.description && (
                <p className="text-xs text-muted-foreground mb-2 line-clamp-2">{project.description}</p>
              )}
              {project.current_focus && (
                <div className="flex items-start gap-1.5 mb-2">
                  <Target className="size-3 text-accent-foreground mt-0.5 shrink-0" />
                  <p className="text-xs text-accent-foreground line-clamp-1">{project.current_focus}</p>
                </div>
              )}
              <div className="flex items-center gap-2 mt-2 text-xs text-muted-foreground">
                <Badge variant="outline">{project.status}</Badge>
                {templateKeyFromProject(project) === ACADEMIC_TEMPLATE_KEY && <Badge variant="secondary">Academic Research</Badge>}
                <span>Updated {fmt(project.updated_at)}</span>
              </div>
            </Card>
          ))}
        </div>
      )}

      {/* Create dialog */}
      <Dialog open={createOpen} onOpenChange={v => { setCreateOpen(v); if (!v) resetForm() }}>
        <DialogContent className="max-h-[calc(100dvh-2rem)] max-w-2xl overflow-y-auto">
          <DialogHeader>
            <DialogTitle>New project</DialogTitle>
            <DialogDescription className="sr-only">
              Create a project with optional description and current focus.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-1.5">
              <Label>Name <span className="text-destructive">*</span></Label>
              <Input
                value={newName}
                onChange={e => setNewName(e.target.value)}
                placeholder="e.g. Research paper on memory systems"
                onKeyDown={e => e.key === 'Enter' && createProject()}
              />
            </div>
            <div className="space-y-1.5">
              <Label>Description</Label>
              <Textarea
                value={newDescription}
                onChange={e => setNewDescription(e.target.value)}
                placeholder="What is this project about?"
                rows={2}
              />
            </div>
            <div className="space-y-1.5">
              <Label>Goal</Label>
              <Textarea
                value={newGoal}
                onChange={e => setNewGoal(e.target.value)}
                placeholder="What outcome should this project produce?"
                rows={3}
              />
            </div>
            <div className="space-y-1.5">
              <Label>Scope</Label>
              <Textarea
                value={newScope}
                onChange={e => setNewScope(e.target.value)}
                placeholder="What is included in this project?"
                rows={2}
              />
            </div>
            <div className="space-y-1.5">
              <Label>Success definition</Label>
              <Textarea
                value={newSuccessDefinition}
                onChange={e => setNewSuccessDefinition(e.target.value)}
                placeholder="How will you know this Project is successful?"
                rows={2}
              />
            </div>
            <div className="space-y-1.5">
              <Label>Current focus</Label>
              <Input
                value={newFocus}
                onChange={e => setNewFocus(e.target.value)}
                placeholder="What are you actively working on right now?"
              />
            </div>
            <div className="space-y-2">
              <Label>Project Template</Label>
              <div className="grid gap-2 sm:grid-cols-2">
                {blankTemplateFirst(projectTemplates)
                  .map(template => (
                    <button
                      key={template.key}
                      type="button"
                      className={[
                        'rounded-md border p-3 text-left transition-colors',
                        newTemplateKey === template.key
                          ? 'border-primary bg-primary/5'
                          : 'border-border bg-background hover:bg-muted/40',
                      ].join(' ')}
                      onClick={() => setNewTemplateKey(template.key)}
                    >
                      <div className="flex items-center gap-2">
                        <FolderKanban className="size-4 text-accent-foreground" />
                        <span className="text-sm font-medium">{template.name}</span>
                      </div>
                      <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">{template.description}</p>
                    </button>
                  ))}
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => { setCreateOpen(false); resetForm() }}>Cancel</Button>
            <Button onClick={createProject} disabled={creating || !newName.trim() || !templatesLoaded || !newTemplateKey}>
              {creating ? 'Creating…' : 'Create project'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
