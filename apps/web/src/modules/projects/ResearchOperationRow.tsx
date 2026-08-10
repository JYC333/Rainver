import { useState } from 'react'
import { ChevronDown, ChevronRight, HelpCircle, FlaskConical, RefreshCw } from 'lucide-react'
import type { InquiryThread, ProjectOperation, ProjectResearchCheckpoint, ProjectResearchWorkflow } from '../../types/api'
import { Badge } from '../../components/ui/badge'
import { Button } from '../../components/ui/button'
import {
  researchOperationDetail, researchOperationNextStep, researchOperationPercent, researchOperationSteps,
} from './FocusResearchWorkbench'
import { researchFailurePresentation } from './researchResultState'
import { isResearchHumanReviewCheckpoint } from './researchReviewAttention'
import { ResearchCheckpointReview } from './ResearchCheckpointReview'

interface ResearchOperationRowProps {
  operation: ProjectOperation
  workflow: ProjectResearchWorkflow | undefined
  thread: InquiryThread | undefined
  checkpoints: ProjectResearchCheckpoint[]
  busyAction: string | null
  reconciling: boolean
  onDecideCheckpoint: (checkpoint: ProjectResearchCheckpoint, decision: 'approved' | 'rejected') => void
  onReconcileOperation: (operationId: string) => void
  onRetryOperation: (operationId: string) => void
}

/**
 * One compact row per research workflow's operation — this is where multiple
 * concurrently running/pending research searches live now that a Project
 * can have more than one (previously Overview only ever showed a single
 * selected workflow's progress, which doesn't scale once every Question or
 * Hypothesis Thread can start its own).
 */
export function ResearchOperationRow({
  operation, workflow, thread, checkpoints, busyAction, reconciling,
  onDecideCheckpoint, onReconcileOperation, onRetryOperation,
}: ResearchOperationRowProps) {
  const pendingCheckpoints = checkpoints.filter(checkpoint => checkpoint.status === 'pending' && isResearchHumanReviewCheckpoint(checkpoint))
  const [expanded, setExpanded] = useState(operation.status === 'failed' || pendingCheckpoints.length > 0)
  const title = (typeof workflow?.state_json.research_question === 'string' && workflow.state_json.research_question.trim())
    || operation.title
  const steps = researchOperationSteps(operation)
  const failure = operation.status === 'failed' ? researchFailurePresentation(operation) : null

  return (
    <div className="rounded border border-border">
      <button
        type="button"
        className="flex w-full items-start justify-between gap-3 p-3 text-left hover:bg-muted/40"
        onClick={() => setExpanded(value => !value)}
      >
        <div className="flex min-w-0 items-start gap-2">
          {expanded ? <ChevronDown className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" /> : <ChevronRight className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />}
          {thread?.kind === 'hypothesis'
            ? <FlaskConical className="mt-0.5 size-3.5 shrink-0 text-accent-foreground" />
            : <HelpCircle className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />}
          <div className="min-w-0">
            <p className="truncate text-sm font-medium">{title}</p>
            <p className="mt-0.5 truncate text-xs text-muted-foreground">{researchOperationDetail(operation)}</p>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {pendingCheckpoints.length > 0 && <Badge variant="warning">Review needed</Badge>}
          <Badge variant={operation.status === 'failed' ? 'destructive' : operation.status === 'waiting_review' ? 'warning' : 'outline'}>
            {operation.status.replace(/_/g, ' ')}
          </Badge>
        </div>
      </button>
      {operation.status !== 'completed' && operation.status !== 'failed' && (
        <div className="px-3">
          <div className="h-1.5 overflow-hidden rounded-full bg-muted">
            <div className="h-full rounded-full bg-primary transition-all" style={{ width: `${researchOperationPercent(operation)}%` }} />
          </div>
        </div>
      )}
      {expanded && (
        <div className="space-y-3 border-t border-border p-3">
          <p className="text-xs text-muted-foreground">{researchOperationNextStep(operation)}</p>
          <div className="flex flex-wrap gap-1.5">
            {steps.map(step => (
              <Badge key={step.title} variant={step.status === 'done' ? 'success' : step.status === 'failed' ? 'destructive' : step.status === 'active' ? 'default' : step.status === 'blocked' ? 'warning' : 'outline'}>
                {step.title}
              </Badge>
            ))}
          </div>
          {failure && (
            <div role="alert" className="rounded-md border border-destructive/30 bg-destructive/5 p-3">
              <p className="text-sm font-medium text-destructive">{failure.conclusion}</p>
              <p className="mt-1 text-xs text-muted-foreground">{failure.suggestion}</p>
              <details className="mt-2 text-xs text-muted-foreground">
                <summary className="cursor-pointer select-none hover:text-foreground">Technical details</summary>
                <pre className="mt-2 max-h-56 overflow-auto rounded border border-border bg-background/80 p-2 font-mono text-[11px] whitespace-pre-wrap">{failure.technical}</pre>
              </details>
            </div>
          )}
          {operation.status === 'failed' && (
            <Button size="sm" variant="outline" onClick={() => onRetryOperation(operation.id)}>
              <RefreshCw className="size-3.5" />Retry
            </Button>
          )}
          {pendingCheckpoints.map(checkpoint => (
            <ResearchCheckpointReview
              key={checkpoint.id}
              checkpoint={checkpoint}
              onDecide={decision => onDecideCheckpoint(checkpoint, decision)}
              onRefresh={() => onReconcileOperation(operation.id)}
              refreshing={reconciling && busyAction === 'reconcile-operation'}
            />
          ))}
        </div>
      )}
    </div>
  )
}
