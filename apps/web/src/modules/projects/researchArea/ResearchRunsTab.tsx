import { useCallback, useEffect, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { Plus } from 'lucide-react'
import { inquiryApi, projectResearchApi, projectsApi } from '../../../api/client'
import type { InquiryThread, ProjectOperation, ProjectResearchCheckpoint, ProjectResearchWorkflow } from '../../../types/api'
import { Button } from '../../../components/ui/button'
import { Card } from '../../../components/ui/card'
import { SpaceLink as Link } from '../../../core/spaceNav'
import { errMsg } from '../../../lib/utils'
import { ResearchOperationRow } from '../ResearchOperationRow'
import { toast } from 'sonner'
import { notifyReviewAttentionChanged } from '../../../core/reviewAttention'
import { researchCheckpointOperationId, researchReviewToastId } from '../researchReviewAttention'
import { ThreadOriginBar } from '../inquiryArea/ThreadOriginBar'

/**
 * Every evidence search this Project is running, with its Checkpoint
 * controls — one row per Question or Hypothesis Thread.
 *
 * This lived on an Operations Area beside Automations, Runs and alerts. Those
 * three were Space-level objects filtered to the Project, and the alerts were
 * already in the attention list; the research rows were the only thing on
 * that page that belonged to the Project, and they belong to Research.
 */
export default function ResearchRunsTab({ projectId }: { projectId: string }) {
  const [searchParams] = useSearchParams()
  const selectedOperationId = searchParams.get('open')
  const [operations, setOperations] = useState<ProjectOperation[]>([])
  const [researchWorkflows, setResearchWorkflows] = useState<ProjectResearchWorkflow[]>([])
  const [researchCheckpoints, setResearchCheckpoints] = useState<ProjectResearchCheckpoint[]>([])
  const [inquiryThreads, setInquiryThreads] = useState<InquiryThread[]>([])
  const [researchBusy, setResearchBusy] = useState<string | null>(null)

  const load = useCallback(async () => {
    const [nextOperations, nextWorkflows, nextThreads] = await Promise.all([
      projectsApi.operations(projectId),
      projectResearchApi.workflows(projectId).catch(() => [] as ProjectResearchWorkflow[]),
      inquiryApi.listThreads(projectId).catch(() => [] as InquiryThread[]),
    ])
    setOperations(nextOperations)
    setResearchWorkflows(nextWorkflows)
    setInquiryThreads(nextThreads)
    // Checkpoints are scoped per Workflow — one fetch per Workflow that has a
    // research operation showing, not per Workflow that ever existed.
    const relevantWorkflowIds = [...new Set(
      nextOperations.filter(operation => operation.kind === 'research').map(operation => String(operation.progress_json.workflow_id ?? '')).filter(Boolean),
    )]
    const checkpointLists = await Promise.all(
      relevantWorkflowIds.map(workflowId => projectResearchApi.checkpoints(projectId, workflowId).catch(() => [] as ProjectResearchCheckpoint[])),
    )
    setResearchCheckpoints(checkpointLists.flat())
  }, [projectId])
  useEffect(() => { load().catch(error => toast.error(String(error))) }, [load])

  async function decideCheckpoint(checkpoint: ProjectResearchCheckpoint, decision: 'approved' | 'rejected') {
    setResearchBusy(`checkpoint-${checkpoint.id}`)
    try {
      await projectResearchApi.decideCheckpoint(projectId, checkpoint.workflow_id, checkpoint.id, { decision })
      toast.dismiss(researchReviewToastId(projectId, checkpoint.id))
      toast.success(decision === 'approved' ? 'Checkpoint approved' : 'Checkpoint rejected')
      await load()
      notifyReviewAttentionChanged()
    } catch (error) {
      toast.error(errMsg(error))
    } finally {
      setResearchBusy(null)
    }
  }

  async function retryOperation(operationId: string) {
    setResearchBusy('retry-operation')
    try {
      await projectResearchApi.retryOperation(projectId, operationId)
      toast.success('Research operation retry queued')
      await load()
    } catch (error) {
      toast.error(errMsg(error))
    } finally {
      setResearchBusy(null)
    }
  }

  async function cancelOperation(operationId: string) {
    setResearchBusy(`cancel-operation-${operationId}`)
    try {
      const result = await projectResearchApi.cancelOperation(projectId, operationId)
      toast.success(result.already_terminal
        ? 'This research operation had already stopped'
        : 'Research operation stopped; its running work is being cancelled')
      await load()
    } catch (error) {
      toast.error(errMsg(error))
    } finally {
      setResearchBusy(null)
    }
  }

  async function reconcileOperation(operationId: string) {
    setResearchBusy('reconcile-operation')
    try {
      await projectResearchApi.reconcileOperation(projectId, operationId)
      toast.success('Research operation status synchronized')
      await load()
    } catch (error) {
      toast.error(errMsg(error))
    } finally {
      setResearchBusy(null)
    }
  }

  const researchOperations = operations.filter(operation => operation.kind === 'research')
  const workflowById = new Map(researchWorkflows.map(workflow => [workflow.id, workflow]))
  const threadById = new Map(inquiryThreads.map(thread => [thread.id, thread]))
  const checkpointsByWorkflowId = new Map<string, ProjectResearchCheckpoint[]>()
  for (const checkpoint of researchCheckpoints) {
    checkpointsByWorkflowId.set(checkpoint.workflow_id, [...(checkpointsByWorkflowId.get(checkpoint.workflow_id) ?? []), checkpoint])
  }

  return (
    <div className="space-y-4">
      <ThreadOriginBar projectId={projectId} kinds={['search_acquisition']} />
      <Card className="space-y-3 p-4">
        <div className="flex items-center justify-between gap-3">
          <div>
            <h2 className="font-medium">Evidence searches</h2>
            <p className="text-xs text-muted-foreground">Every search this Project is running, one per Question or Hypothesis Thread — not just the last one you had open.</p>
          </div>
          <Button size="sm" variant="outline" asChild>
            {/* Question/Hypothesis definition lives on the Inquiry page — this
                routes there first so the search-setup dialog only ever opens
                for a Thread that is already picked. */}
            <Link to={`/projects/${projectId}/inquiry?research_intent=1`}><Plus className="size-3.5" />New search</Link>
          </Button>
        </div>
        {researchOperations.length === 0 && <p className="text-sm text-muted-foreground">No evidence searches yet.</p>}
        {researchOperations.map(operation => {
          const workflowId = String(operation.progress_json.workflow_id ?? '')
          const workflow = workflowById.get(workflowId)
          const thread = workflow?.primary_thread_id ? threadById.get(workflow.primary_thread_id) : undefined
          return (
            <div key={operation.id} id={`operation-${operation.id}`} className={selectedOperationId === operation.id ? 'rounded-md ring-2 ring-primary/40' : ''}>
              <ResearchOperationRow
                operation={operation}
                workflow={workflow}
                thread={thread}
                checkpoints={(checkpointsByWorkflowId.get(workflowId) ?? [])
                  .filter(checkpoint => researchCheckpointOperationId(checkpoint) === operation.id)}
                busyAction={researchBusy}
                reconciling={researchBusy === 'reconcile-operation'}
                onDecideCheckpoint={decideCheckpoint}
                onReconcileOperation={operationId => void reconcileOperation(operationId)}
                onRetryOperation={operationId => void retryOperation(operationId)}
                onCancelOperation={operationId => void cancelOperation(operationId)}
              />
            </div>
          )
        })}
      </Card>
    </div>
  )
}
