import { useCallback, useEffect, useMemo, useState } from 'react'
import { ArrowLeft, BookOpen, FileText, Plus, RefreshCw } from 'lucide-react'
import { useParams } from 'react-router-dom'
import { toast } from 'sonner'
import {
  projectResearchApi,
  projectsApi,
  providersApi,
  notesApi,
  ApiRequestError,
  type ModelProviderOut,
} from '../../api/client'
import type { Note, Project, ResearchArea, ResearchReadingList } from '../../types/api'
import { SpaceLink as Link } from '../../core/spaceNav'
import { StatusBadge } from '../../components/ui/badge'
import { Button } from '../../components/ui/button'
import { Card } from '../../components/ui/card'
import { EmptyState } from '../../components/ui/empty-state'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../../components/ui/tabs'
import { errMsg } from '../../lib/utils'
import { ChecklistView } from './researchArea/ChecklistView'
import { NotebookChatPanel } from './researchArea/NotebookChatPanel'
import { ProjectNoteCard } from './researchArea/NotebookView'
import { ReadingListView } from './researchArea/ReadingListView'

export default function ResearchAreaPage() {
  const { projectId = '' } = useParams()
  const [project, setProject] = useState<Project | null>(null)
  const [area, setArea] = useState<ResearchArea | null>(null)
  const [notes, setNotes] = useState<Note[]>([])
  const [notesLoading, setNotesLoading] = useState(true)
  const [creatingNote, setCreatingNote] = useState(false)
  const [reading, setReading] = useState<ResearchReadingList | null>(null)
  const [providers, setProviders] = useState<ModelProviderOut[]>([])
  const [tab, setTab] = useState('notebook')
  const [loading, setLoading] = useState(true)
  const [notInitialized, setNotInitialized] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [generatingReport, setGeneratingReport] = useState(false)

  async function loadReading() {
    if (projectId) setReading(await projectResearchApi.readingList(projectId))
  }

  // The area call returns a light notes listing (id/title/version) for
  // overview + AI grounding; the Notebook tab needs the full Note objects
  // (content_json) to actually edit them.
  const loadNotes = useCallback(async () => {
    setNotesLoading(true)
    try {
      const summaries = await notesApi.list({ project_id: projectId, status: 'active', limit: 200 })
      const full = await Promise.all(summaries.items.map(s => notesApi.get(s.id)))
      full.sort((a, b) => a.created_at.localeCompare(b.created_at))
      setNotes(full)
    } catch (error) {
      toast.error(errMsg(error))
    } finally {
      setNotesLoading(false)
    }
  }, [projectId])

  const refreshArea = useCallback(async () => {
    try {
      setArea(await projectResearchApi.area(projectId))
      await loadNotes()
    } catch (error) {
      toast.error(errMsg(error))
    }
  }, [projectId, loadNotes])

  useEffect(() => {
    if (!projectId) return
    setLoading(true)
    setNotInitialized(false)
    setLoadError(null)
    void Promise.all([
      projectsApi.get(projectId),
      // Writers get the area created on first visit; readers on an
      // uninitialized project fall through to the empty state below.
      projectResearchApi.initializeArea(projectId).catch((error) => {
        if (error instanceof ApiRequestError && error.status === 404) return null
        throw error
      }),
      projectResearchApi.readingList(projectId),
      providersApi.list(),
    ]).then(([nextProject, nextArea, nextReading, nextProviders]) => {
      setProject(nextProject)
      setArea(nextArea)
      setNotInitialized(!nextArea)
      setReading(nextReading)
      setProviders(nextProviders.filter((provider) => provider.enabled))
      if (nextArea) void loadNotes()
      else setNotesLoading(false)
    }).catch((error) => {
      const message = errMsg(error)
      setLoadError(message)
      toast.error(message)
    }).finally(() => setLoading(false))
    // loadNotes intentionally excluded: it's stable per projectId and this
    // effect already re-runs whenever projectId changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId])

  async function createNote() {
    if (!area) return
    setCreatingNote(true)
    try {
      const created = await notesApi.create({
        title: 'Untitled note',
        primary_project_id: projectId,
        collection_id: area.notes_collection_id,
      })
      setNotes(current => [...current, created])
    } catch (error) {
      toast.error(errMsg(error))
    } finally {
      setCreatingNote(false)
    }
  }

  const noteTitleById = useMemo(() => new Map(notes.map(n => [n.id, n.title])), [notes])

  async function generateReport() {
    setGeneratingReport(true)
    try {
      const operation = await projectResearchApi.generateReportSnapshot(projectId)
      toast.success(`Report snapshot queued · operation ${operation.id.slice(0, 8)}`)
    } catch (error) {
      toast.error(errMsg(error))
    } finally {
      setGeneratingReport(false)
    }
  }

  if (loading) {
    return <div className="p-6 text-sm text-muted-foreground">Loading research Area…</div>
  }
  if (loadError) {
    return (
      <div className="p-6">
        <Link to={`/projects/${projectId}`}><Button variant="ghost" size="sm"><ArrowLeft className="size-4" />Project</Button></Link>
        <EmptyState title="Research Area unavailable" description={loadError} />
      </div>
    )
  }
  if (notInitialized || !area) {
    return (
      <div className="p-6">
        <Link to={`/projects/${projectId}`}><Button variant="ghost" size="sm"><ArrowLeft className="size-4" />Project</Button></Link>
        <EmptyState
          title="Research Area not initialized"
          description="A project writer opens this page once to create the notebook, reading list, and checklist."
        />
      </div>
    )
  }

  return (
    <div className="space-y-5 p-4 md:p-6">
      <header className="flex flex-wrap items-center gap-3">
        <Link to={`/projects/${projectId}`}><Button variant="ghost" size="sm"><ArrowLeft className="size-4" />Project</Button></Link>
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-xl font-semibold">{project?.current_focus ?? project?.name ?? 'Research Area'}</h1>
          <p className="text-sm text-muted-foreground">Living research documents evolve independently from report snapshots.</p>
        </div>
        <Button size="sm" variant="ghost" onClick={() => void refreshArea()}><RefreshCw className="size-3.5" />Refresh</Button>
      </header>
      <Tabs value={tab} onValueChange={setTab}>
        <TabsList className="grid w-full grid-cols-4">
          <TabsTrigger value="notebook"><BookOpen className="mr-1 size-4" />Notebook</TabsTrigger>
          <TabsTrigger value="reading">Reading List</TabsTrigger>
          <TabsTrigger value="checklist">Checklist</TabsTrigger>
          <TabsTrigger value="reports"><FileText className="mr-1 size-4" />Reports</TabsTrigger>
        </TabsList>
        <TabsContent value="notebook" className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_22rem]">
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <p className="text-xs text-muted-foreground">
                These notes live in Knowledge &gt; Notes too — free to add, rename, or link like any other note.
              </p>
              <Button size="sm" variant="outline" disabled={creatingNote} onClick={() => void createNote()}>
                <Plus className="size-3.5" />Add note
              </Button>
            </div>
            {notesLoading && notes.length === 0 && <p className="text-sm text-muted-foreground">Loading notes…</p>}
            {notes.map((note) => (
              <ProjectNoteCard
                key={note.id}
                note={note}
                onSaved={(next) => setNotes((current) => current.map((value) => value.id === next.id ? next : value))}
                onDeleted={(id) => setNotes((current) => current.filter((value) => value.id !== id))}
              />
            ))}
          </div>
          <div className="lg:sticky lg:top-6 lg:h-[calc(100vh-9rem)] lg:self-start">
            <NotebookChatPanel
              projectId={projectId}
              providers={providers}
              noteTitleById={noteTitleById}
              onNotebookChanged={() => void loadNotes()}
            />
          </div>
        </TabsContent>
        <TabsContent value="reading"><ReadingListView projectId={projectId} value={reading} reload={loadReading} /></TabsContent>
        <TabsContent value="checklist">
          <ChecklistView
            projectId={projectId}
            items={area.checklist}
            onChange={(items) => setArea({ ...area, checklist: items })}
          />
        </TabsContent>
        <TabsContent value="reports" className="space-y-3">
          <div className="flex justify-end">
            <Button size="sm" variant="outline" disabled={generatingReport} onClick={() => void generateReport()}>
              <RefreshCw className="size-3.5" />{generatingReport ? 'Queueing…' : 'Generate new snapshot'}
            </Button>
          </div>
          {area.reports.length ? area.reports.map((report) => (
            <Link key={report.id} to={`/projects/${projectId}/research/reports/${report.id}`}>
              <Card className="mb-3 flex items-center justify-between p-4">
                <div><p className="font-medium">{report.research_question}</p><p className="text-xs text-muted-foreground">Version {report.research_question_version} · {new Date(report.created_at).toLocaleString()}</p></div>
                <StatusBadge status={report.status} />
              </Card>
            </Link>
          )) : <EmptyState title="No report snapshots" description="Completed synthesis reports will appear here." />}
        </TabsContent>
      </Tabs>
    </div>
  )
}
