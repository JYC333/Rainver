import { useEffect, useState } from 'react'
import { FileText, NotebookPen, RefreshCw } from 'lucide-react'
import { useParams, useSearchParams } from 'react-router-dom'
import { toast } from 'sonner'
import { projectResearchApi, ApiRequestError } from '../../api/client'
import type { ResearchArea, ResearchReadingList } from '../../types/api'
import { SpaceLink as Link } from '../../core/spaceNav'
import { StatusBadge } from '../../components/ui/badge'
import { Button } from '../../components/ui/button'
import { Card } from '../../components/ui/card'
import { EmptyState } from '../../components/ui/empty-state'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../../components/ui/tabs'
import { errMsg } from '../../lib/utils'
import { ChecklistView } from './researchArea/ChecklistView'
import { ReadingListView } from './researchArea/ReadingListView'
import { FocusResearchWorkbench } from './FocusResearchWorkbench'
import { ProjectResearchStandingPanel } from './ProjectResearchStandingPanel'
import { ResearchSetupDialog } from './ResearchSetupDialog'
import { ResearchSettingsCard } from './ResearchSettingsCard'
import { useProjectResearch } from './useProjectResearch'
import ResearchRunsTab from './researchArea/ResearchRunsTab'

export default function ResearchAreaPage() {
  const { projectId = '' } = useParams()
  const [area, setArea] = useState<ResearchArea | null>(null)
  const [reading, setReading] = useState<ResearchReadingList | null>(null)
  // Standing discovery is the default view for goal-ambiguous work; the
  // Thread-scoped focus workflow stays one click away.
  // The tab is in the URL: attention items and the Inquiry Loop link straight
  // to a tab (`?tab=runs`), and a link that lands on the wrong tab is a link
  // that does not work.
  const [searchParams, setSearchParams] = useSearchParams()
  const tab = searchParams.get('tab') ?? 'standing'
  const setTab = (next: string) => {
    const params = new URLSearchParams(searchParams)
    if (next === 'standing') params.delete('tab')
    else params.set('tab', next)
    setSearchParams(params, { replace: true })
  }
  const [loading, setLoading] = useState(true)
  const [notInitialized, setNotInitialized] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [generatingReport, setGeneratingReport] = useState(false)
  const research = useProjectResearch(projectId)

  async function loadReading() {
    if (projectId) setReading(await projectResearchApi.readingList(projectId))
  }

  async function refreshArea() {
    try {
      setArea(await projectResearchApi.area(projectId))
    } catch (error) {
      toast.error(errMsg(error))
    }
  }

  useEffect(() => {
    if (!projectId) return
    setLoading(true)
    setNotInitialized(false)
    setLoadError(null)
    // The Project row itself comes from useProjectResearch; fetching it again
    // here would mean two requests for one page.
    void Promise.all([
      // Writers get the area created on first visit; readers on an
      // uninitialized project fall through to the empty state below.
      projectResearchApi.initializeArea(projectId).catch((error) => {
        if (error instanceof ApiRequestError && error.status === 404) return null
        throw error
      }),
      projectResearchApi.readingList(projectId),
    ]).then(([nextArea, nextReading]) => {
      setArea(nextArea)
      setNotInitialized(!nextArea)
      setReading(nextReading)
    }).catch((error) => {
      const message = errMsg(error)
      setLoadError(message)
      toast.error(message)
    }).finally(() => setLoading(false))
  }, [projectId])

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
        <EmptyState title="Research Area unavailable" description={loadError} />
      </div>
    )
  }
  if (notInitialized || !area) {
    return (
      <div className="p-6">
        <EmptyState
          title="Research Area not initialized"
          description="A project writer opens this page once to create the reading list and checklist."
        />
      </div>
    )
  }

  return (
    <div className="space-y-5 p-4 md:p-6">
      <header className="flex flex-wrap items-center gap-3">
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-xl font-semibold">{research.project?.current_focus ?? research.project?.name ?? 'Research Area'}</h1>
          <p className="text-sm text-muted-foreground">Living research documents evolve independently from report snapshots.</p>
        </div>
        {/* The notebook is no longer a tab here: notes are a Project-level
            surface, reachable from every Area rather than only this one. */}
        <Link to={`/projects/${projectId}/notes`}>
          <Button size="sm" variant="outline"><NotebookPen className="size-3.5" />Notes</Button>
        </Link>
        <Button size="sm" variant="ghost" onClick={() => void refreshArea()}><RefreshCw className="size-3.5" />Refresh</Button>
      </header>
      {/* One tab bar: the standing/focus workbench and the Area's own
          documents are the same Area. */}
      <Tabs value={tab} onValueChange={setTab}>
        <TabsList className="grid w-full grid-cols-6">
          <TabsTrigger value="standing">Standing overview</TabsTrigger>
          <TabsTrigger value="focus">Focus workbench</TabsTrigger>
          <TabsTrigger value="reading">Reading List</TabsTrigger>
          <TabsTrigger value="checklist">Checklist</TabsTrigger>
          <TabsTrigger value="reports"><FileText className="mr-1 size-4" />Reports</TabsTrigger>
          <TabsTrigger value="runs">Runs</TabsTrigger>
        </TabsList>
        {/* Standing and focus keep their own in-progress state (a setup draft,
            a selected Workflow), so switching between them must not unmount
            either one. */}
        <TabsContent value="standing" forceMount className="space-y-4 data-[state=inactive]:hidden">
          <ProjectResearchStandingPanel projectId={projectId} canAct={research.project?.status === 'active'} />
        </TabsContent>
        <TabsContent value="focus" forceMount className="space-y-4 data-[state=inactive]:hidden">
          {research.focusProps && <FocusResearchWorkbench {...research.focusProps} />}
          {research.settings && <ResearchSettingsCard settings={research.settings} />}
        </TabsContent>
        <TabsContent value="reading"><ReadingListView projectId={projectId} value={reading} reload={loadReading} /></TabsContent>
        <TabsContent value="checklist">
          <ChecklistView
            projectId={projectId}
            items={area.checklist}
            onChange={(items) => setArea({ ...area, checklist: items })}
          />
        </TabsContent>
        <TabsContent value="runs"><ResearchRunsTab projectId={projectId} /></TabsContent>
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

      {research.newSearch.thread && (
        <ResearchSetupDialog
          projectId={projectId}
          workflowId={research.newSearch.workflowId}
          threadId={research.newSearch.thread.id}
          open={research.newSearch.open}
          draft={research.newSearch.draft}
          busyAction={research.actionBusy}
          modelProviders={research.focusProps?.modelProviders ?? []}
          providerVendors={research.focusProps?.providerVendors ?? []}
          canAct={research.project?.status === 'active'}
          onOpenChange={research.newSearch.setOpen}
          onSave={(config, dialogWorkflowId) => research.saveInitialIntake(config, dialogWorkflowId ?? null)}
          onStart={(config, dialogWorkflowId) => research.startInitialIntake(config, dialogWorkflowId ?? null)}
        />
      )}
    </div>
  )
}
