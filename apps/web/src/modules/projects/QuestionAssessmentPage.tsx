import { useCallback, useEffect, useMemo, useState } from 'react'
import { ArrowLeft } from 'lucide-react'
import { useParams } from 'react-router-dom'
import { inquiryApi, projectResearchApi, providersApi, type ModelProviderOut, type ProviderVendorOut } from '../../api/client'
import type { InquiryThreadDetail, ProjectResearchQuestionAssessmentSession, ProjectResearchWorkflow } from '../../types/api'
import { SpaceLink as Link } from '../../core/spaceNav'
import { Badge } from '../../components/ui/badge'
import { Button } from '../../components/ui/button'
import { Skeleton } from '../../components/ui/skeleton'
import { QuestionRefinementPanel } from './QuestionRefinementPanel'
import { errMsg } from '../../lib/utils'

export default function QuestionAssessmentPage() {
  const { projectId = '', threadId = '' } = useParams()
  const [thread, setThread] = useState<InquiryThreadDetail | null>(null)
  const [workflows, setWorkflows] = useState<ProjectResearchWorkflow[]>([])
  const [providers, setProviders] = useState<ModelProviderOut[]>([])
  const [providerVendors, setProviderVendors] = useState<ProviderVendorOut[]>([])
  const [assessmentSession, setAssessmentSession] = useState<ProjectResearchQuestionAssessmentSession | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    if (!projectId || !threadId) return
    setLoading(true)
    setError(null)
    try {
      const [nextThread, nextWorkflows, nextProviders, nextProviderVendors, nextAssessmentSession] = await Promise.all([
        inquiryApi.getThread(projectId, threadId),
        projectResearchApi.workflows(projectId),
        providersApi.list(),
        providersApi.vendors().catch(() => [] as ProviderVendorOut[]),
        projectResearchApi.questionAssessment(projectId, threadId),
      ])
      setThread(nextThread)
      setWorkflows(nextWorkflows)
      setProviders(nextProviders)
      setProviderVendors(nextProviderVendors)
      setAssessmentSession(nextAssessmentSession)
    } catch (loadError) {
      setError(errMsg(loadError))
    } finally {
      setLoading(false)
    }
  }, [projectId, threadId])

  useEffect(() => {
    void load()
  }, [load])

  const refreshAfterChange = useCallback(async () => {
    const [nextThread, nextWorkflows] = await Promise.all([
      inquiryApi.getThread(projectId, threadId),
      projectResearchApi.workflows(projectId),
    ])
    setThread(nextThread)
    setWorkflows(nextWorkflows)
  }, [projectId, threadId])

  const linkedDraftWorkflow = useMemo(() => workflows.find(workflow =>
    workflow.primary_thread_id === threadId && workflow.status !== 'archived',
  ) ?? null, [threadId, workflows])

  if (loading) {
    return (
      <div className="space-y-4 p-6">
        <Skeleton className="h-8 w-72" />
        <Skeleton className="h-[680px] w-full" />
      </div>
    )
  }

  if (error || !thread) {
    return (
      <div className="space-y-4 p-6">
        <Button variant="ghost" size="sm" asChild><Link to={`/projects/${projectId}/inquiry`}><ArrowLeft className="size-4" />Back to Inquiry</Link></Button>
        <p className="text-sm text-destructive">{error ?? 'Inquiry Thread not found.'}</p>
      </div>
    )
  }

  return (
    <div className="space-y-5 p-4 sm:p-6">
      <div>
        <Button variant="ghost" size="sm" className="-ml-2 mb-2" asChild>
          <Link to={`/projects/${projectId}/inquiry?thread=${thread.id}`}><ArrowLeft className="size-4" />Back to Inquiry</Link>
        </Button>
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant="outline">{thread.kind}</Badge>
          <Badge variant="secondary">v{thread.version}</Badge>
        </div>
        <h1 className="mt-2 text-2xl font-semibold">{thread.kind === 'hypothesis' ? 'Assess Inquiry' : 'Assess Research Question'}</h1>
        <p className="mt-1 max-w-4xl text-sm text-muted-foreground">
          Keep the structured research framework and the discussion in view together. Each conversational turn updates the framework; confirmation writes the final wording back to the Inquiry Thread.
        </p>
      </div>

      <QuestionRefinementPanel
        projectId={projectId}
        thread={thread}
        linkedDraftWorkflow={linkedDraftWorkflow}
        modelProviders={providers}
        providerVendors={providerVendors}
        assessmentSession={assessmentSession}
        canAct={thread.lifecycle_status === 'active'}
        onChanged={refreshAfterChange}
      />
    </div>
  )
}
