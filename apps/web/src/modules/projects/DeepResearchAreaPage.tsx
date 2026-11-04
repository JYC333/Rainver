import {useProblemText} from './problemWorkspace/strings'
import { useEffect, useState } from 'react'
import { FileText, NotebookPen, RefreshCw } from 'lucide-react'
import { useParams, useSearchParams } from 'react-router-dom'
import { toast } from 'sonner'
import { projectResearchApi, ApiRequestError } from '../../api/client'
import type { ResearchArea, ResearchReadingList,ProjectResearchReport } from '../../types/api'
import { SpaceLink as Link } from '../../core/spaceNav'
import { StatusBadge } from '../../components/ui/badge'
import { Button } from '../../components/ui/button'
import { Card } from '../../components/ui/card'
import { EmptyState } from '../../components/ui/empty-state'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../../components/ui/tabs'
import { errMsg } from '../../lib/utils'
import { ChecklistView } from './researchArea/ChecklistView'
import { ReadingListView } from './researchArea/ReadingListView'
import ResearchRunsTab from './researchArea/ResearchRunsTab'

export default function DeepResearchAreaPage() {
  const { projectId = '' } = useParams()
  const text=useProblemText()
  const [area, setArea] = useState<ResearchArea | null>(null)
  const [reading, setReading] = useState<ResearchReadingList | null>(null)
  // Explicit deep-research entry; preserve existing workbench and history tabs.
  // The tab is in the URL: attention items and the Inquiry Loop link straight
  // to a tab (`?tab=runs`), and a link that lands on the wrong tab is a link
  // that does not work.
  const [searchParams, setSearchParams] = useSearchParams()
  const [reportPage,setReportPage]=useState<{items:ProjectResearchReport[];next_cursor:string|null}>({items:[],next_cursor:null})
  async function moreReports(){try{const p=await projectResearchApi.reportPage(projectId,reportPage.next_cursor??undefined);setReportPage(old=>({...p,items:[...old.items,...p.items]}))}catch(error){toast.error(errMsg(error))}}
  const tab = searchParams.get('tab') ?? 'runs'
  const setTab = (next: string) => {
    const params = new URLSearchParams(searchParams)
    params.set('tab', next)
    setSearchParams(params)
  }
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [generatingReport, setGeneratingReport] = useState(false)

  async function moreReading(){if(!reading)return;try{const p=await projectResearchApi.readingList(projectId,{offset:String(reading.items.length),limit:'50'});setReading(old=>old?{...p,items:[...old.items,...p.items]}:p)}catch(error){toast.error(errMsg(error))}}
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
    setLoadError(null)
    // Existing documents are reads; only an explicit action may initialize work.
    let live=true;
    void Promise.all([
      tab==='checklist'?projectResearchApi.area(projectId).catch(error=>{if(error instanceof ApiRequestError&&error.status===404)return null;throw error}):Promise.resolve(null),
      tab==='reading'?projectResearchApi.readingList(projectId).catch(error=>{if(error instanceof ApiRequestError&&error.status===404)return null;throw error}):Promise.resolve(null),
      tab==='reports'?projectResearchApi.reportPage(projectId):Promise.resolve({items:[],next_cursor:null}),
    ]).then(([nextArea, nextReading,nextReports]) => {
      if(!live)return;setReportPage(nextReports);
      setArea(nextArea)
      setReading(nextReading)
    }).catch((error) => {
      if(!live)return;const message = errMsg(error)
      setLoadError(message)
      toast.error(message)
    }).finally(() => {if(live)setLoading(false)})
    return()=>{live=false}
  }, [projectId,tab])

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

  return (
    <div className="space-y-5 p-4 md:p-6">
      <Link className="text-sm text-primary underline" to={`/projects/${projectId}/inquiry${searchParams.get('thread')?`?thread=${encodeURIComponent(searchParams.get('thread')!)}`:''}`}>{text('Problem workspace','问题推进')}</Link>
      <header className="flex flex-wrap items-center gap-3">
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-xl font-semibold">{text('Research records','研究记录')}</h1>
          <p className="text-sm text-muted-foreground">Living research documents evolve independently from report snapshots.</p>
        </div>
        {/* Notes are a Project-level surface, reachable from every Area.
            Do not put the notebook back as a tab of this page. */}
        <Link to={`/projects/${projectId}/notes`}>
          <Button size="sm" variant="outline"><NotebookPen className="size-3.5" />Notes</Button>
        </Link>
        <Button size="sm" variant="ghost" onClick={() => void refreshArea()}><RefreshCw className="size-3.5" />Refresh</Button>
      </header>
      {searchParams.get('workflow_id')&&<Button variant="outline" onClick={()=>{const p=new URLSearchParams(searchParams);p.delete('workflow_id');setSearchParams(p)}}>{text('Show all workflows','显示全部研究')}</Button>}
      <Tabs value={tab} onValueChange={setTab}>
        <TabsList className="flex h-auto flex-wrap">
          <TabsTrigger value="reading">{text('Reading List','阅读')}</TabsTrigger>
          <TabsTrigger value="checklist">{text('Checklist','检查清单')}</TabsTrigger>
          <TabsTrigger value="reports"><FileText className="mr-1 size-4" />{text('Reports','报告')}</TabsTrigger>
          <TabsTrigger value="runs">{text('Runs','运行')}</TabsTrigger>
        </TabsList>
        <TabsContent value="reading"><ReadingListView projectId={projectId} value={reading} reload={loadReading} />{reading&&reading.items.length<reading.total&&<Button variant="outline" onClick={()=>void moreReading()}>{text('More material','更多材料')}</Button>}</TabsContent>
        <TabsContent value="checklist">
          <ChecklistView
            projectId={projectId}
            items={area?.checklist??[]}
            onChange={(update) => setArea(current => current ? { ...current, checklist: update(current.checklist) } : current)}
          />
        </TabsContent>
        <TabsContent value="runs"><ResearchRunsTab projectId={projectId} /></TabsContent>
        <TabsContent value="reports" className="space-y-3">
          <div className="flex justify-end">
            <Button size="sm" variant="outline" disabled={generatingReport} onClick={() => void generateReport()}>
              <RefreshCw className="size-3.5" />{generatingReport ? 'Queueing…' : 'Generate new snapshot'}
            </Button>
          </div>
          {reportPage.items.length ? reportPage.items.filter(r=>!searchParams.get('workflow_id')||r.workflow_id===searchParams.get('workflow_id')).map((report) => (
            <Link key={report.id} to={`/projects/${projectId}/research/reports/${report.id}?${searchParams}`}>
              <Card className="mb-3 flex items-center justify-between p-4">
                <div><p className="font-medium">{report.research_question}</p><p className="text-xs text-muted-foreground">Version {report.research_question_version} · {new Date(report.created_at).toLocaleString()}</p></div>
                <StatusBadge status={report.status} />
              </Card>
            </Link>
          )) : <EmptyState title="No report snapshots" description="Completed synthesis reports will appear here." />}
          {reportPage.next_cursor&&<Button variant="outline" onClick={()=>void moreReports()}>{text('More reports','更多报告')}</Button>}
        </TabsContent>
      </Tabs>

    </div>
  )
}
