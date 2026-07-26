import { useEffect, useState, useCallback, useRef } from 'react'
import { useParams } from 'react-router-dom'
import { SpaceLink as Link } from '../../core/spaceNav'
import { ArrowLeft, ExternalLink, FileCode2, FlaskConical, Loader2, Save, ShieldCheck, UserRoundCheck, XCircle } from 'lucide-react'
import { toast } from 'sonner'
import { artifactsApi, authorizationRequestsApi, evolutionApi, runsApi } from '../../api/client'
import { errMsg } from '../../lib/utils'
import type { ActivityRecord, Artifact, AuthorizationRequest, Proposal, Run, RunAttempt, RunEvaluation, RunFinalization, RunLogicalIO, RunSupervisorDecision, RunVerificationResult } from '../../types/api'
import { Card } from '../../components/ui/card'
import { Button } from '../../components/ui/button'
import { Badge, StatusBadge } from '../../components/ui/badge'
import { Skeleton } from '../../components/ui/skeleton'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../../components/ui/tabs'
import { EmptyState } from '../../components/ui/empty-state'
import { PreviewBadge, DryRunBanner, UrgencyBadge } from '../../components/PreviewBadge'
import { useRun, RUN_TERMINAL_STATUSES } from '../../hooks/useRun'
import { ScopeBadge } from '../../components/ScopeBadge'
import { useSpace } from '../../contexts/SpaceContext'
import { PersonalContextPanel } from './PersonalContextPanel'
import { isGrantDerivedProposal } from '../memory/EgressReviewNotice'
import { promptLibraryPath } from '../prompts/paths'
import { ContentAccessControl } from '../../components/ContentAccessControl'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '../../components/ui/dialog'
import { Input } from '../../components/ui/input'
import { Label } from '../../components/ui/label'
import { Textarea } from '../../components/ui/textarea'

type RunDetailTab = 'io' | 'activities' | 'artifacts' | 'proposals' | 'contract' | 'verification' | 'route' | 'attempts'
type OptionalRunResource = 'io' | 'activities' | 'artifacts' | 'proposals' | 'authorization' | 'attempts' | 'evaluations' | 'verifications' | 'finalizations'

async function loadOptionalRunResource<T>(loader: Promise<T>, fallback: T): Promise<{ value: T; error: string | null }> {
  try {
    return { value: await loader, error: null }
  } catch (error) {
    return { value: fallback, error: errMsg(error) }
  }
}

function fmt(dt: string | null | undefined) {
  return dt ? new Date(dt).toLocaleString() : '—'
}

interface PromptRef {
  key: string
  label: string
  versionId: string | null
  contentHash: string | null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value : null
}

function JsonBlock({ value }: { value: unknown }) {
  return <pre className="max-h-96 overflow-auto rounded-md border border-border bg-muted/40 p-3 text-xs">{JSON.stringify(value ?? {}, null, 2)}</pre>
}

function promptRefsForRun(run: Run): PromptRef[] {
  const refs: PromptRef[] = []
  if (run.prompt_asset_key) {
    refs.push({
      key: run.prompt_asset_key,
      label: 'run',
      versionId: run.prompt_version_id ?? null,
      contentHash: run.prompt_content_hash ?? null,
    })
  }

  const prompts = isRecord(run.output_json?.prompts) ? run.output_json.prompts : null
  if (prompts) {
    for (const [label, value] of Object.entries(prompts)) {
      if (!isRecord(value)) continue
      const key = stringOrNull(value.asset_key)
      if (!key || refs.some(ref => ref.key === key && ref.label === label)) continue
      refs.push({
        key,
        label,
        versionId: stringOrNull(value.version_id),
        contentHash: stringOrNull(value.content_hash),
      })
    }
  }
  return refs
}

export default function RunDetailPage() {
  const { runId = '' } = useParams()
  const { spaces, activeSpaceId, activeSpaceName, personalSpaceId, userId } = useSpace()
  const [reloadKey, setReloadKey] = useState(0)
  const [executingRun, setExecutingRun] = useState(false)
  const [recoveryBusy, setRecoveryBusy] = useState(false)
  const [abandonOpen, setAbandonOpen] = useState(false)
  const [abandonReason, setAbandonReason] = useState('')
  const { run: polled, loading, error } = useRun(runId && activeSpaceId ? runId : null, reloadKey)
  const [activities, setActivities] = useState<ActivityRecord[]>([])
  const [artifacts, setArtifacts] = useState<Artifact[]>([])
  const [proposals, setProposals] = useState<Proposal[]>([])
  const [authorizationRequests, setAuthorizationRequests] = useState<AuthorizationRequest[]>([])
  const [authorizationBusyId, setAuthorizationBusyId] = useState<string | null>(null)
  const [attempts, setAttempts] = useState<RunAttempt[]>([])
  const [supervisorDecisions, setSupervisorDecisions] = useState<RunSupervisorDecision[]>([])
  const [evaluations, setEvaluations] = useState<RunEvaluation[]>([])
  const [verifications, setVerifications] = useState<RunVerificationResult[]>([])
  const [finalizations, setFinalizations] = useState<RunFinalization[]>([])
  const [logicalIO, setLogicalIO] = useState<RunLogicalIO | null>(null)
  const [subresourceErrors, setSubresourceErrors] = useState<Partial<Record<OptionalRunResource, string>>>({})
  const [routeDecision, setRouteDecision] = useState<Record<string, unknown> | null>(null)
  const [routeDecisionError, setRouteDecisionError] = useState<string | null>(null)
  const [resourceScopeKey, setResourceScopeKey] = useState<string | null>(null)
  const [tabLoading, setTabLoading] = useState(true)
  const [activeTab, setActiveTab] = useState<RunDetailTab>('io')
  const [workflowOpen, setWorkflowOpen] = useState(false)
  const [workflowName, setWorkflowName] = useState('')
  const [workflowDescription, setWorkflowDescription] = useState('')
  const [workflowPreview, setWorkflowPreview] = useState<Record<string, unknown> | null>(null)
  const [workflowPreviewScopeKey, setWorkflowPreviewScopeKey] = useState<string | null>(null)
  const [workflowBusy, setWorkflowBusy] = useState(false)
  const loadGeneration = useRef(0)
  const workflowPreviewGeneration = useRef(0)
  const workflowPreviewStateRef = useRef({
    runId,
    activeSpaceId,
    name: workflowName.trim() || undefined,
    description: workflowDescription.trim() || undefined,
  })
  workflowPreviewStateRef.current = {
    runId,
    activeSpaceId,
    name: workflowName.trim() || undefined,
    description: workflowDescription.trim() || undefined,
  }

  const clearWorkflowPreview = useCallback(() => {
    setWorkflowPreview(null)
    setWorkflowPreviewScopeKey(null)
  }, [])

  const invalidateWorkflowPreview = useCallback(() => {
    workflowPreviewGeneration.current += 1
    clearWorkflowPreview()
    setWorkflowBusy(false)
  }, [clearWorkflowPreview])

  const loadSubs = useCallback(async () => {
    const generation = loadGeneration.current + 1
    loadGeneration.current = generation
    const requestScopeKey = `${activeSpaceId ?? 'none'}:${runId}`
    const isCurrentRequest = () => loadGeneration.current === generation

    if (!runId) {
      setResourceScopeKey(requestScopeKey)
      return
    }
    if (!activeSpaceId) {
      setActivities([])
      setArtifacts([])
      setProposals([])
      setAuthorizationRequests([])
      setAttempts([])
      setSupervisorDecisions([])
      setEvaluations([])
      setVerifications([])
      setFinalizations([])
      setLogicalIO(null)
      setRouteDecision(null)
      setRouteDecisionError(null)
      setSubresourceErrors({})
      setResourceScopeKey(requestScopeKey)
      setTabLoading(false)
      return
    }

    setResourceScopeKey(null)
    setActivities([])
    setArtifacts([])
    setProposals([])
    setAuthorizationRequests([])
    setAttempts([])
    setSupervisorDecisions([])
    setEvaluations([])
    setVerifications([])
    setFinalizations([])
    setLogicalIO(null)
    setRouteDecision(null)
    setRouteDecisionError(null)
    setSubresourceErrors({})
    setTabLoading(true)
    try {
      const [io, a, ar, pr, authRequests, attemptResult, nextEvaluations, nextVerifications, nextFinalizations, nextRoute] = await Promise.all([
        loadOptionalRunResource(Promise.resolve().then(() => runsApi.logicalIO(runId)), null),
        loadOptionalRunResource(runsApi.activities(runId, { limit: '100' }), { items: [], total: 0, limit: 100, offset: 0 }),
        loadOptionalRunResource(runsApi.artifacts(runId, { limit: '100' }), { items: [], total: 0, limit: 100, offset: 0 }),
        loadOptionalRunResource(runsApi.proposals(runId, { limit: '100' }), { items: [], total: 0, limit: 100, offset: 0 }),
        loadOptionalRunResource(runsApi.authorizationRequests(runId), []),
        loadOptionalRunResource(runsApi.attempts(runId), { attempts: [], supervisor_decisions: [] }),
        loadOptionalRunResource(runsApi.evaluations(runId), []),
        loadOptionalRunResource(runsApi.verifications(runId), []),
        loadOptionalRunResource(runsApi.finalizations(runId), []),
        runsApi.routeDecision(runId)
          .then(value => ({ value, error: null as string | null }))
          .catch(error => ({ value: null, error: errMsg(error) })),
      ])
      if (!isCurrentRequest()) return
      setLogicalIO(io.value)
      setActivities(a.value.items)
      setArtifacts(ar.value.items)
      setProposals(pr.value.items)
      setAuthorizationRequests(authRequests.value)
      setAttempts(attemptResult.value.attempts)
      setSupervisorDecisions(attemptResult.value.supervisor_decisions)
      setEvaluations(nextEvaluations.value)
      setVerifications(nextVerifications.value)
      setFinalizations(nextFinalizations.value)
      setSubresourceErrors({
        io: io.error ?? undefined,
        activities: a.error ?? undefined,
        artifacts: ar.error ?? undefined,
        proposals: pr.error ?? undefined,
        authorization: authRequests.error ?? undefined,
        attempts: attemptResult.error ?? undefined,
        evaluations: nextEvaluations.error ?? undefined,
        verifications: nextVerifications.error ?? undefined,
        finalizations: nextFinalizations.error ?? undefined,
      })
      setRouteDecision(nextRoute.value)
      setRouteDecisionError(nextRoute.error)
      setResourceScopeKey(requestScopeKey)
    } catch (e) {
      if (!isCurrentRequest()) return
      setActivities([])
      setArtifacts([])
      setProposals([])
      setAuthorizationRequests([])
      setAttempts([])
      setSupervisorDecisions([])
      setEvaluations([])
      setVerifications([])
      setFinalizations([])
      setLogicalIO(null)
      setRouteDecision(null)
      setRouteDecisionError(null)
      setSubresourceErrors({})
      setResourceScopeKey(requestScopeKey)
      toast.error(errMsg(e))
    } finally {
      if (isCurrentRequest()) setTabLoading(false)
    }
  }, [runId, activeSpaceId])

  useEffect(() => {
    void loadSubs()
  }, [loadSubs])

  useEffect(() => {
    setActiveTab('io')
  }, [runId])

  useEffect(() => {
    setReloadKey(k => k + 1)
  }, [activeSpaceId])

  useEffect(() => {
    invalidateWorkflowPreview()
    setWorkflowOpen(false)
    setWorkflowName('')
    setWorkflowDescription('')
  }, [runId, activeSpaceId, invalidateWorkflowPreview])

  // Sub-resources are created when the run finishes; refetch when polling reaches a terminal status
  // (mount-only loadSubs() would leave tabs empty after queued → succeeded without leaving the page).
  useEffect(() => {
    if (!runId || !polled?.status) return
    if (
      polled.status !== 'waiting_for_review'
      && !RUN_TERMINAL_STATUSES.has(polled.status)
    ) return
    void loadSubs()
  }, [runId, polled?.status, loadSubs])

  async function exportArt(id: string) {
    try {
      await artifactsApi.export(id)
      toast.success('Download started')
    } catch (e) {
      toast.error(errMsg(e))
    }
  }

  async function runQueuedExecution() {
    if (!runId) return
    setExecutingRun(true)
    try {
      await runsApi.executeQueuedRun(runId)
      toast.success('Run finished — status should be terminal (e.g. succeeded).')
      setReloadKey(k => k + 1)
      await loadSubs()
    } catch (e) {
      toast.error(errMsg(e))
    } finally {
      setExecutingRun(false)
    }
  }

  async function resumeWaitingRun() {
    if (!runId) return
    setRecoveryBusy(true)
    try {
      await runsApi.resume(runId)
      toast.success('Run resumed and queued')
      setReloadKey(k => k + 1)
      await loadSubs()
    } catch (e) {
      toast.error(errMsg(e))
    } finally {
      setRecoveryBusy(false)
    }
  }

  async function abandonWaitingRun() {
    if (!runId) return
    setRecoveryBusy(true)
    try {
      await runsApi.abandon(runId, { reason: abandonReason.trim() || undefined })
      toast.success('Run abandoned')
      setAbandonOpen(false)
      setAbandonReason('')
      setReloadKey(k => k + 1)
      await loadSubs()
    } catch (e) {
      toast.error(errMsg(e))
    } finally {
      setRecoveryBusy(false)
    }
  }

  async function decideAuthorization(requestId: string, decision: 'approve' | 'reject') {
    setAuthorizationBusyId(requestId)
    try {
      const updated = decision === 'approve'
        ? await authorizationRequestsApi.approve(requestId)
        : await authorizationRequestsApi.reject(requestId)
      setAuthorizationRequests(current => current.map(item => item.id === updated.id ? updated : item))
      toast.success(decision === 'approve' ? 'Authorization granted' : 'Authorization request rejected')
      setReloadKey(key => key + 1)
      await loadSubs()
    } catch (e) {
      toast.error(errMsg(e))
    } finally {
      setAuthorizationBusyId(null)
    }
  }

  async function previewWorkflow() {
    if (!runId || !activeSpaceId) return
    const generation = workflowPreviewGeneration.current + 1
    workflowPreviewGeneration.current = generation
    const requestRunId = runId
    const requestSpaceId = activeSpaceId
    const requestName = workflowName.trim() || undefined
    const requestDescription = workflowDescription.trim() || undefined
    const isCurrentRequest = () => (
      workflowPreviewGeneration.current === generation
      && workflowPreviewStateRef.current.runId === requestRunId
      && workflowPreviewStateRef.current.activeSpaceId === requestSpaceId
      && workflowPreviewStateRef.current.name === requestName
      && workflowPreviewStateRef.current.description === requestDescription
    )

    clearWorkflowPreview()
    setWorkflowBusy(true)
    try {
      const preview = await evolutionApi.previewWorkflowFromRun({
        run_id: requestRunId,
        display_name: requestName,
        description: requestDescription,
      })
      if (isCurrentRequest()) {
        setWorkflowPreview(preview)
        setWorkflowPreviewScopeKey(`${requestSpaceId}:${requestRunId}`)
      }
    } catch (e) {
      if (isCurrentRequest()) {
        clearWorkflowPreview()
        toast.error(errMsg(e))
      }
    } finally {
      if (workflowPreviewGeneration.current === generation) setWorkflowBusy(false)
    }
  }

  async function saveWorkflow() {
    if (!runId || !activeSpaceId || !workflowPreview || workflowPreviewScopeKey !== `${activeSpaceId}:${runId}`) return
    setWorkflowBusy(true)
    try {
      const result = await evolutionApi.saveWorkflowFromRun({
        run_id: runId,
        display_name: workflowName.trim() || undefined,
        description: workflowDescription.trim() || undefined,
      })
      toast.success(result.status === 'proposal_required' ? 'Workflow proposal created for review' : 'Workflow draft saved')
      setWorkflowOpen(false)
      clearWorkflowPreview()
    } catch (e) { toast.error(errMsg(e)) } finally { setWorkflowBusy(false) }
  }

  const currentResourceScopeKey = `${activeSpaceId ?? 'none'}:${runId}`
  const resourcesReady = resourceScopeKey === currentResourceScopeKey
  const polledMatchesScope = Boolean(
    polled && polled.id === runId && polled.space_id === activeSpaceId,
  )

  if ((loading && !polled) || (polled !== null && !polledMatchesScope)) {
    return (
      <div className="p-6 space-y-4 max-w-4xl">
        <Skeleton className="h-10 w-64" />
        <Skeleton className="h-40 w-full" />
      </div>
    )
  }

  if (error || !polled) {
    const isNotFound = !activeSpaceId
      || (error?.includes('404') ?? false)
      || (error?.toLowerCase().includes('not found') ?? false)
    return (
      <div className="p-6">
        <Button variant="ghost" asChild>
          <Link to="/runs"><ArrowLeft className="size-4 mr-1" />Runs</Link>
        </Button>
        {!activeSpaceId ? (
          <EmptyState
            className="mt-6"
            title="No space selected"
            description="Select an operational space to inspect this run."
          />
        ) : isNotFound ? (
          <EmptyState
            className="mt-6"
            title="Run not found or not in this space"
            description="This run may not exist, or it may not be visible in your current space."
            action={
              <Button variant="ghost" asChild>
                <Link to="/runs">Back to Runs</Link>
              </Button>
            }
          />
        ) : (
          <p className="text-destructive mt-4 text-sm">{error}</p>
        )}
      </div>
    )
  }

  const r: Run = polled
  const executionSpace = spaces.find(s => s.id === r.space_id)
  const canReviewAuthorization = executionSpace?.role === 'owner'
  const instructedBy = r.instructed_by_user_id
    ? 'User'
    : r.instructed_by_agent_id
      ? 'Agent'
      : '—'
  const promptRefs = promptRefsForRun(r)
  const runAuthorizationId = stringOrNull(r.error_json?.authorization_request_id)
  const runAuthorization = runAuthorizationId
    ? authorizationRequests.find(request => request.id === runAuthorizationId)
    : authorizationRequests.find(request => request.status === 'pending')
  const hasAuthorizationPause = Boolean(runAuthorizationId || runAuthorization)

  return (
    <>
    <div className="p-6 space-y-6 max-w-4xl">
      <Button variant="ghost" size="sm" asChild>
        <Link to="/runs"><ArrowLeft className="size-4" /></Link>
      </Button>

      <div className="space-y-3 border-b border-border pb-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <h1 className="text-xl font-semibold tracking-tight">{r.instruction ?? r.prompt ?? `${r.run_type} Run`}</h1>
          <div className="flex flex-wrap items-center gap-2"><ContentAccessControl resourceType="run" resourceId={r.id} ownerUserId={r.owner_user_id ?? null} />{r.status === 'waiting_for_review' && !hasAuthorizationPause && <><Button size="sm" onClick={() => void resumeWaitingRun()} disabled={recoveryBusy}><UserRoundCheck className="size-3.5" /> Resume</Button><Button size="sm" variant="destructive" onClick={() => setAbandonOpen(true)} disabled={recoveryBusy}><XCircle className="size-3.5" /> Abandon</Button></>}{(r.status === 'succeeded' || r.status === 'degraded') && <Button size="sm" variant="outline" onClick={() => setWorkflowOpen(true)}><Save className="size-3.5" /> Save as workflow</Button>}</div>
        </div>
        <p className="text-xs text-muted-foreground">Viewing: {activeSpaceName ?? activeSpaceId ?? 'No operational space selected'}</p>
        <div className="flex flex-wrap gap-1.5 items-center">
          <StatusBadge status={r.status} />
          <Badge variant="secondary">{r.mode}</Badge>
          {r.mode === 'dry_run' && <PreviewBadge />}
          <Badge variant="outline">{r.run_type}</Badge>
          <ScopeBadge visibility={r.visibility} />
        </div>
        {r.mode === 'dry_run' && <DryRunBanner />}
        <p className="text-xs text-muted-foreground">
          created {fmt(r.created_at)} · started {fmt(r.started_at)} · ended {fmt(r.ended_at)}
        </p>
        <Card className="p-4 space-y-3">
          <div className="flex items-center justify-between gap-2 flex-wrap">
            <h2 className="text-sm font-semibold">Run Context</h2>
            <ScopeBadge visibility={r.visibility} />
          </div>
          <div className="grid gap-2 text-sm sm:grid-cols-2">
            <p><span className="text-muted-foreground">Execution space</span><br /><span>{executionSpace?.name ?? 'Unavailable space'}</span></p>
            <p><span className="text-muted-foreground">Project context</span><br /><span>{r.project_folder_id ? 'Project Folder attached' : 'No Project Folder'}</span></p>
            <p><span className="text-muted-foreground">Instructed by</span><br /><span>{instructedBy}</span></p>
            <p><span className="text-muted-foreground">Context snapshot</span><br /><span>{r.context_snapshot_id ? 'Captured' : 'Not captured'}</span></p>
          </div>
          <details className="rounded-md border border-border bg-muted/20 p-3 text-xs">
            <summary className="cursor-pointer font-medium">Technical identifiers</summary>
            <div className="mt-3 grid gap-2 sm:grid-cols-2">
              <p className="break-all"><span className="text-muted-foreground">run_id</span><br /><span className="font-mono select-all">{r.id}</span></p>
              <p className="break-all"><span className="text-muted-foreground">agent_id</span><br /><span className="font-mono select-all">{r.agent_id}</span></p>
              <p className="break-all"><span className="text-muted-foreground">agent_version_id</span><br /><span className="font-mono select-all">{r.agent_version_id}</span></p>
              <p className="break-all"><span className="text-muted-foreground">project_folder_id</span><br /><span className="font-mono select-all">{r.project_folder_id ?? '—'}</span></p>
              <p className="break-all"><span className="text-muted-foreground">context_snapshot_id</span><br /><span className="font-mono select-all">{r.context_snapshot_id ?? '—'}</span></p>
              <p className="break-all"><span className="text-muted-foreground">space_id</span><br /><span className="font-mono select-all">{r.space_id}</span></p>
            </div>
          </details>
          <div className="rounded-md border border-border bg-muted/30 p-3 text-xs text-muted-foreground space-y-1">
            <div>Memory scope: Space-scoped memory.</div>
            <div>Personal context grants can be used for reasoning only.</div>
            <div>Separate approval is required before anything is written to a shared space.</div>
          </div>
        </Card>
        {(r.resolved_model?.provider_id || r.resolved_model?.model) && (
          <Card className="p-4 space-y-2">
            <h2 className="text-sm font-semibold">Model configuration</h2>
            <div className="grid gap-2 text-sm sm:grid-cols-2">
              <p>
                <span className="text-muted-foreground">Provider</span><br />
                <span>{r.resolved_model?.provider_name ?? r.resolved_model?.provider_id ?? '—'}</span>
              </p>
              <p>
                <span className="text-muted-foreground">Model</span><br />
                <span className="font-mono text-xs">{r.resolved_model?.model ?? '—'}</span>
              </p>
              <p>
                <span className="text-muted-foreground">Source</span><br />
                <span>{r.resolved_model?.source ?? 'none'}</span>
              </p>
              <p>
                <span className="text-muted-foreground">Used by adapter</span><br />
                <span>{r.resolved_model?.used_by_adapter ? 'Yes' : 'No'}</span>
              </p>
            </div>
            {r.resolved_model?.disclosure_note && (
              <p className="text-xs text-muted-foreground rounded-md border border-border bg-muted/30 p-3">
                {r.resolved_model.disclosure_note}
              </p>
            )}
          </Card>
        )}
        {promptRefs.length > 0 && (
          <Card className="p-4 space-y-3">
            <div className="flex items-center gap-2">
              <FileCode2 className="size-4 text-muted-foreground" />
              <h2 className="text-sm font-semibold">Prompt provenance</h2>
            </div>
            <div className="space-y-2">
              {promptRefs.map(ref => (
                <div key={`${ref.label}:${ref.key}`} className="grid gap-2 rounded-md border border-border p-3 sm:grid-cols-[minmax(0,1fr)_180px_120px] sm:items-center">
                  <div className="min-w-0">
                    <div className="text-[11px] font-medium uppercase text-muted-foreground">{ref.label}</div>
                    <Link to={promptLibraryPath(ref.key)} className="inline-flex min-w-0 max-w-full items-center gap-1 text-sm hover:underline">
                      <span className="truncate font-mono">{ref.key}</span>
                      <ExternalLink className="size-3 shrink-0" />
                    </Link>
                  </div>
                  <div className="min-w-0">
                    <div className="text-[11px] font-medium uppercase text-muted-foreground">Version</div>
                    <div className="truncate font-mono text-xs">{ref.versionId ?? 'unresolved'}</div>
                  </div>
                  <div className="min-w-0">
                    <div className="text-[11px] font-medium uppercase text-muted-foreground">Hash</div>
                    <div className="truncate font-mono text-xs">{ref.contentHash?.slice(0, 12) ?? 'none'}</div>
                  </div>
                </div>
              ))}
            </div>
          </Card>
        )}
        <PersonalContextPanel
          run={r}
          currentUserId={userId}
          personalSpaceId={personalSpaceId}
          spaces={spaces}
        />
        {authorizationRequests.length > 0 && (
          <Card className="p-4 space-y-3">
            <div>
              <h2 className="text-sm font-semibold">Authorization requests</h2>
              <p className="text-xs text-muted-foreground">Requests are bound to an audited denial from this Run. Credential and cross-space boundaries cannot appear here.</p>
            </div>
            {authorizationRequests.map(request => (
              <div key={request.id} className="rounded-md border border-border p-3 space-y-2">
                <div className="flex items-center justify-between gap-2">
                  <div>
                    <p className="text-sm font-medium">{request.action_id}</p>
                    <p className="text-xs text-muted-foreground">{request.policy_action}</p>
                  </div>
                  <StatusBadge status={request.status} />
                </div>
                <p className="text-sm">{request.reason}</p>
                <p className="text-xs text-muted-foreground">Requested {fmt(request.requested_at)}</p>
                {request.status === 'pending' && canReviewAuthorization && (
                  <div className="flex gap-2">
                    <Button size="sm" onClick={() => void decideAuthorization(request.id, 'approve')} disabled={authorizationBusyId === request.id}>
                      <ShieldCheck className="size-3.5" /> Approve
                    </Button>
                    <Button size="sm" variant="outline" onClick={() => void decideAuthorization(request.id, 'reject')} disabled={authorizationBusyId === request.id}>
                      Reject
                    </Button>
                  </div>
                )}
                {request.status === 'pending' && !canReviewAuthorization && (
                  <p className="text-xs text-muted-foreground">A Space owner must review this request.</p>
                )}
              </div>
            ))}
          </Card>
        )}
        {r.status === 'waiting_for_review' && subresourceErrors.authorization && (
          <Card className="p-4 space-y-3 border-destructive/30">
            <div>
              <h2 className="text-sm font-semibold">Authorization requests unavailable</h2>
              <p className="text-sm text-muted-foreground">{subresourceErrors.authorization}</p>
            </div>
            <Button size="sm" variant="outline" onClick={() => void loadSubs()}>
              Retry authorization requests
            </Button>
          </Card>
        )}
        {r.status === 'failed' && r.error_message && (
          <Card className="p-3 border-destructive/30 bg-destructive/5 text-sm text-destructive">
            {r.error_message}
            {r.error_json && (
              <details className="mt-2 text-xs text-foreground">
                <summary className="cursor-pointer select-none hover:underline">Show diagnostic error data</summary>
                <JsonBlock value={r.error_json} />
              </details>
            )}
          </Card>
        )}
        {r.status === 'degraded' && r.error_json && (
          <Card className="p-3 border-warning/30 bg-warning/5 text-sm">
            <p className="font-medium">Run diagnostics</p>
            <details className="mt-2 text-xs text-muted-foreground">
              <summary className="cursor-pointer select-none hover:text-foreground">Show diagnostic error data</summary>
              <JsonBlock value={r.error_json} />
            </details>
          </Card>
        )}
        {r.task_id && (
          <Link to={`/tasks/${r.task_id}`} className="text-sm text-accent-foreground hover:underline inline-flex items-center gap-1">
            Open linked task <ExternalLink className="size-3" />
          </Link>
        )}

        {r.status === 'queued' && (
          <div className="rounded-lg border border-border bg-muted/30 p-3 space-y-2 mt-2">
            <p className="text-xs text-muted-foreground">
              Dev: execute this queued run through the configured runtime.
            </p>
            <Button
              type="button"
              size="sm"
              variant="secondary"
              className="gap-1.5"
              disabled={executingRun}
              onClick={runQueuedExecution}
            >
              <FlaskConical className="size-4" />
              {executingRun ? 'Running…' : 'Execute run'}
            </Button>
          </div>
        )}
      </div>

      <Tabs value={activeTab} onValueChange={value => setActiveTab(value as RunDetailTab)}>
        <TabsList>
          <TabsTrigger value="io">Input / output</TabsTrigger>
          <TabsTrigger value="activities">Activities</TabsTrigger>
          <TabsTrigger value="artifacts">Artifacts</TabsTrigger>
          <TabsTrigger value="proposals">Proposals</TabsTrigger>
          <TabsTrigger value="contract">Contract</TabsTrigger>
          <TabsTrigger value="verification">Verification</TabsTrigger>
          <TabsTrigger value="route">Route</TabsTrigger>
          <TabsTrigger value="attempts">Attempts ({resourcesReady ? attempts.length : 0})</TabsTrigger>
        </TabsList>

        <TabsContent value="io" className="mt-4 space-y-3">
          {tabLoading || !resourcesReady ? <Skeleton className="h-24 w-full" /> : subresourceErrors.io ? (
            <EmptyState title="Logical I/O unavailable" description={subresourceErrors.io} />
          ) : !logicalIO ? (
            <Card className="p-8 text-center text-sm text-muted-foreground">No logical I/O is available.</Card>
          ) : (
            <>
              <Card className="p-4 space-y-2">
                <h3 className="text-sm font-medium">Runtime-neutral input</h3>
                <JsonBlock value={logicalIO.input} />
              </Card>
              <Card className="p-4 space-y-2">
                <h3 className="text-sm font-medium">Canonical output</h3>
                <JsonBlock value={logicalIO.output} />
              </Card>
              <Card className="p-4 space-y-2">
                <h3 className="text-sm font-medium">Semantic runtime events</h3>
                <JsonBlock value={logicalIO.events} />
              </Card>
            </>
          )}
        </TabsContent>

        <TabsContent value="activities" className="mt-4 space-y-3">
          {tabLoading || !resourcesReady ? <Skeleton className="h-24 w-full" /> : subresourceErrors.activities ? <EmptyState title="Activities unavailable" description={subresourceErrors.activities} /> : activities.length === 0 ? (
            <Card className="p-8 text-center text-sm text-muted-foreground">No activities.</Card>
          ) : (
            activities.map(act => (
              <Card key={act.id} className="p-4 border-l-2 border-l-primary/40">
                <div className="flex justify-between gap-2 flex-wrap">
                  <Link
                    to={`/activity/${act.id}`}
                    className="text-sm font-medium text-accent-foreground hover:underline"
                  >
                    {act.title ?? act.activity_type}
                  </Link>
                  <span className="text-xs text-muted-foreground">{fmt(act.occurred_at)}</span>
                </div>
                <Badge variant="outline" className="mt-2">{act.activity_type}</Badge>
                <ScopeBadge visibility={act.visibility} className="mt-2 ml-1" omitShared />
                {act.content && <p className="text-xs text-muted-foreground mt-2 whitespace-pre-wrap">{act.content}</p>}
              </Card>
            ))
          )}
        </TabsContent>

        <TabsContent value="artifacts" className="mt-4 space-y-3">
          {tabLoading || !resourcesReady ? <Skeleton className="h-24 w-full" /> : subresourceErrors.artifacts ? <EmptyState title="Artifacts unavailable" description={subresourceErrors.artifacts} /> : artifacts.length === 0 ? (
            <Card className="p-8 text-center text-sm text-muted-foreground">No artifacts.</Card>
          ) : (
            artifacts.map(a => (
              <Card key={a.id} className="p-4 flex flex-wrap justify-between gap-2">
                <div>
                  <Link
                    to={`/artifacts/${a.id}`}
                    className="font-medium text-sm text-accent-foreground hover:underline"
                  >
                    {a.title}
                  </Link>
                  <div className="flex gap-1.5 mt-1 flex-wrap">
                    <Badge variant="secondary">{a.artifact_type}</Badge>
                    <ScopeBadge visibility={a.visibility} omitShared />
                    {a.preview && <PreviewBadge />}
                    <span className="text-xs text-muted-foreground">{fmt(a.created_at)}</span>
                  </div>
                </div>
                <Button size="sm" variant="outline" onClick={() => exportArt(a.id)}>Export</Button>
              </Card>
            ))
          )}
        </TabsContent>

        <TabsContent value="proposals" className="mt-4 space-y-3">
          {tabLoading || !resourcesReady ? <Skeleton className="h-24 w-full" /> : subresourceErrors.proposals ? <EmptyState title="Proposals unavailable" description={subresourceErrors.proposals} /> : proposals.length === 0 ? (
            <Card className="p-8 text-center text-sm text-muted-foreground">No proposals.</Card>
          ) : (
            proposals.map(p => (
              <Card key={p.id} className="p-4 space-y-2">
                <div className="flex flex-wrap gap-1.5 items-center">
                  <Link
                    to={`/proposals/${p.id}`}
                    className="font-medium text-sm text-accent-foreground hover:underline"
                  >
                    {p.proposed_title}
                  </Link>
                  <Badge variant="outline">{p.proposal_type}</Badge>
                  <StatusBadge status={p.status} />
                  <UrgencyBadge urgency={p.urgency} />
                  {isGrantDerivedProposal(p) && (
                    <Badge variant={p.egress_approval_status === 'approved' ? 'success' : 'warning'}>
                      {p.egress_approval_status === 'approved' ? 'egress approved' : 'egress gated'}
                    </Badge>
                  )}
                  <ScopeBadge visibility={p.visibility} omitShared />
                  {p.preview && <PreviewBadge />}
                  {p.expired && <Badge variant="destructive">EXPIRED</Badge>}
                </div>
                <p className="text-xs text-muted-foreground">
                  review_deadline {fmt(p.review_deadline)} · expires {fmt(p.expires_at)}
                </p>
                {p.created_by_run_id && p.created_by_run_id !== runId && (
                  <Link to={`/runs/${p.created_by_run_id}`} className="text-xs text-accent-foreground hover:underline">
                    From run {p.created_by_run_id.slice(0, 10)}…
                  </Link>
                )}
              </Card>
            ))
          )}
        </TabsContent>

        <TabsContent value="contract" className="mt-4 space-y-3">
          <Card className="p-4"><div className="mb-3 flex items-center gap-2"><ShieldCheck className="size-4 text-muted-foreground" /><h2 className="text-sm font-semibold">Immutable run contract</h2></div><div className="mb-3 flex flex-wrap gap-1.5"><Badge variant="outline">sandbox {r.required_sandbox_level ?? 'unknown'}</Badge><Badge variant="secondary">workflow {r.workflow_version_id ?? 'static/fallback'}</Badge></div><JsonBlock value={r.contract_snapshot_json} /></Card>
        </TabsContent>

        <TabsContent value="verification" className="mt-4 space-y-3">
          <Card className="p-4"><h2 className="text-sm font-semibold">Verification results</h2>{!resourcesReady ? <Skeleton className="mt-3 h-24 w-full" /> : subresourceErrors.verifications ? <EmptyState title="Verification results unavailable" description={subresourceErrors.verifications} /> : verifications.length === 0 ? <p className="mt-3 text-sm text-muted-foreground">No verification results recorded.</p> : <div className="mt-3 space-y-2">{verifications.map(result => <div key={result.id} className="rounded-md border border-border p-3"><div className="flex flex-wrap items-center gap-1.5"><StatusBadge status={result.status} /><Badge variant="outline">{result.verifier_type}</Badge><span className="text-xs text-muted-foreground">{result.verifier_version}</span></div><p className="mt-1 text-sm text-muted-foreground">{result.summary ?? '—'}</p></div>)}</div>}</Card>
          <Card className="p-4"><h2 className="text-sm font-semibold">Post-run evaluations</h2>{!resourcesReady ? <Skeleton className="mt-3 h-24 w-full" /> : subresourceErrors.evaluations ? <EmptyState title="Evaluations unavailable" description={subresourceErrors.evaluations} /> : evaluations.length === 0 ? <p className="mt-3 text-sm text-muted-foreground">No evaluation records.</p> : <div className="mt-3 space-y-2">{evaluations.map(evaluation => <div key={evaluation.id} className="rounded-md border border-border p-3"><div className="flex flex-wrap items-center gap-1.5"><StatusBadge status={evaluation.outcome_status} /><Badge variant="outline">{evaluation.evaluator_type}</Badge><span className="text-xs text-muted-foreground">{fmt(evaluation.evaluated_at)}</span></div><p className="mt-1 text-xs text-muted-foreground">{evaluation.failure_reason_code ?? 'No failure reason'}</p></div>)}</div>}</Card>
          <Card className="p-4"><h2 className="text-sm font-semibold">Finalization history</h2>{!resourcesReady ? <Skeleton className="mt-3 h-24 w-full" /> : subresourceErrors.finalizations ? <EmptyState title="Finalization history unavailable" description={subresourceErrors.finalizations} /> : finalizations.length === 0 ? <p className="mt-3 text-sm text-muted-foreground">No finalization records.</p> : <div className="mt-3 space-y-2">{finalizations.map(finalization => <div key={finalization.id} className="flex flex-wrap items-center gap-1.5 rounded-md border border-border p-3"><Badge variant="outline">attempt {finalization.attempt_number}</Badge><StatusBadge status={finalization.outcome_status} /><span className="text-xs text-muted-foreground">{finalization.finalizer_version}</span></div>)}</div>}</Card>
        </TabsContent>

        <TabsContent value="route" className="mt-4"><Card className="p-4"><h2 className="mb-3 text-sm font-semibold">Route decision</h2>{!resourcesReady ? <Skeleton className="h-24 w-full" /> : routeDecisionError ? <EmptyState title="Route decision unavailable" description={routeDecisionError} /> : routeDecision ? <JsonBlock value={routeDecision} /> : <EmptyState title="No persisted route decision" description="This run did not produce a durable routing decision." />}</Card></TabsContent>

        <TabsContent value="attempts" className="mt-4 space-y-3"><Card className="p-4"><h2 className="text-sm font-semibold">Execution attempts</h2>{!resourcesReady ? <Skeleton className="h-24 w-full" /> : subresourceErrors.attempts ? <EmptyState title="Attempts unavailable" description={subresourceErrors.attempts} /> : attempts.length === 0 ? <p className="mt-3 text-sm text-muted-foreground">No attempt records.</p> : <div className="mt-3 space-y-2">{attempts.map(attempt => <div key={attempt.id} className="rounded-md border border-border p-3"><div className="flex flex-wrap items-center gap-1.5"><Badge variant="outline">attempt {attempt.attempt_number}</Badge><StatusBadge status={attempt.status} /><span className="text-xs text-muted-foreground">{fmt(attempt.started_at)} → {fmt(attempt.ended_at)}</span></div>{attempt.error_code && <p className="mt-1 text-xs text-destructive">{attempt.error_code}</p>}</div>)}</div>}</Card><Card className="p-4"><h2 className="text-sm font-semibold">Supervisor decisions</h2>{!resourcesReady ? <Skeleton className="h-24 w-full" /> : subresourceErrors.attempts ? <EmptyState title="Supervisor decisions unavailable" description={subresourceErrors.attempts} /> : supervisorDecisions.length === 0 ? <p className="mt-3 text-sm text-muted-foreground">No supervisor decisions.</p> : <div className="mt-3 space-y-2">{supervisorDecisions.map(decision => <div key={decision.id} className="flex flex-wrap items-center gap-1.5 rounded-md border border-border p-3"><Badge variant="secondary">{decision.decision}</Badge><Badge variant="outline">{decision.reason_code}</Badge><span className="text-xs text-muted-foreground">{fmt(decision.created_at)}</span></div>)}</div>}</Card></TabsContent>
      </Tabs>
    </div>

      <Dialog open={workflowOpen} onOpenChange={open => {
        setWorkflowOpen(open)
        if (!open) invalidateWorkflowPreview()
      }}>
        <DialogContent className="max-w-3xl"><DialogHeader><DialogTitle>Save run as workflow</DialogTitle><DialogDescription>This creates a draft or a proposal depending on the source run's risk. Preview is read-only and uses the server's verified evidence.</DialogDescription></DialogHeader><div className="space-y-4"><div className="space-y-1.5"><Label>Display name</Label><Input value={workflowName} onChange={event => { invalidateWorkflowPreview(); setWorkflowName(event.target.value) }} placeholder="Saved workflow" /></div><div className="space-y-1.5"><Label>Description</Label><Textarea value={workflowDescription} onChange={event => { invalidateWorkflowPreview(); setWorkflowDescription(event.target.value) }} placeholder="What should this workflow be reused for?" /></div>{workflowPreview && workflowPreviewScopeKey === `${activeSpaceId}:${runId}` && <JsonBlock value={workflowPreview} />}</div><DialogFooter><Button variant="outline" onClick={() => void previewWorkflow()} disabled={workflowBusy}>{workflowBusy && <Loader2 className="size-3.5 animate-spin" />} Preview</Button><Button onClick={() => void saveWorkflow()} disabled={workflowBusy || workflowPreviewScopeKey !== `${activeSpaceId}:${runId}` || !workflowPreview}>{workflowBusy && <Loader2 className="size-3.5 animate-spin" />} Save workflow</Button></DialogFooter></DialogContent>
      </Dialog>
      <Dialog open={abandonOpen} onOpenChange={open => { if (!recoveryBusy) setAbandonOpen(open) }}>
        <DialogContent>
          <DialogHeader><DialogTitle>Abandon waiting Run</DialogTitle><DialogDescription>This marks the Run cancelled and finalizes its audit record. It cannot be resumed afterwards.</DialogDescription></DialogHeader>
          <div className="space-y-1.5"><Label>Reason (optional)</Label><Textarea value={abandonReason} onChange={event => setAbandonReason(event.target.value)} placeholder="Why is this review being abandoned?" /></div>
          <DialogFooter><Button variant="ghost" onClick={() => setAbandonOpen(false)} disabled={recoveryBusy}>Cancel</Button><Button variant="destructive" onClick={() => void abandonWaitingRun()} disabled={recoveryBusy}>{recoveryBusy && <Loader2 className="size-3.5 animate-spin" />} Abandon Run</Button></DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
