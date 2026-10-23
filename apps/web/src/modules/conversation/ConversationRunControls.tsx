import { hasRunAuthorizationPause, useRunActions } from '../runs/useRunActions'
import { RunQuotaRecoveryControls, runQuotaRecovery } from '../runs/RunQuotaRecoveryControls'
import { POLICY_APPROVER_MAX_RISK, POLICY_RISK_LEVEL_VALUES, PolicyRiskLevelEnum } from '@rainver/protocol'
import { ConversationScope, useConversationScope } from './ConversationScope'
import { useEffect, useState } from 'react'
import { FileDiff, Loader2, RefreshCw, Square } from 'lucide-react'
import { artifactsApi, runsApi } from '../../api/client'
import { ConversationLink as Link } from './ConversationScope'
import type { Artifact, AuthorizationRequest, Run } from '../../types/api'
import { Button } from '../../components/ui/button'
import { useAppTranslation } from '../../i18n'

const TERMINAL_RUN_STATUSES = new Set(['succeeded', 'failed', 'degraded', 'cancelled', 'orphaned'])
const DIFF_ATTEMPTS = 5
const DIFF_DELAY_MS = 700

export function ConversationRunControls(props: Parameters<typeof ConversationRunControlsContent>[0] & { spaceId?: string }) {
  return <ConversationScope key={`${props.spaceId ?? props.run?.space_id ?? ''}:${props.runId}`} spaceId={props.spaceId ?? props.run?.space_id}><ConversationRunControlsContent key={`${props.spaceId ?? props.run?.space_id ?? ''}:${props.runId}`} {...props} /></ConversationScope>
}

function ConversationRunControlsContent({
  runId,
  run: suppliedRun,
  projectId,
  onRetry,
  agentLabel,
  showStatus = true,
  onChanged,
  onAuthorizationDisplayed,
}: {
  runId: string
  run?: Run | null
  projectId?: string | null
  /** The containing surface supplies retry unless readOnly or delegated; Run standing is separate. */
  onRetry?: (runId: string) => Promise<void>
  /** Whose Run these controls belong to, when one message started several. */
  agentLabel?: string
  /** Room Agent turns already state their own progress beside the work. */
  showStatus?: boolean
  onChanged?: () => void | Promise<void>
  onAuthorizationDisplayed?: (ids: string[]) => void
}) {
  const scope = useConversationScope()
  const { t } = useAppTranslation()
  const [run, setRun] = useState<Run | null>(suppliedRun ?? null)
  const [authorizationRequests, setAuthorizationRequests] = useState<AuthorizationRequest[]>([])
  const [authorizationLoaded, setAuthorizationLoaded] = useState(false)
  const actions = useRunActions(runId, scope, async next => {
    setRun(next)
    await onChanged?.()
  })
  const stopping = actions.busy?.kind === 'stop'
  const [retrying, setRetrying] = useState(false)
  const [retryError, setRetryError] = useState<string | null>(null)
  const [refreshToken, setRefreshToken] = useState(0)

  useEffect(() => setRun(suppliedRun ?? null), [suppliedRun, scope])
  useEffect(() => {
    if (run || !runId) return
    let cancelled = false
    void runsApi.get(runId, scope).then(next => { if (!cancelled) setRun(next) }).catch(() => undefined)
    return () => { cancelled = true }
  }, [run, runId, scope])

  useEffect(() => {
    if (!run || (run.status !== 'cancelling' && (suppliedRun || TERMINAL_RUN_STATUSES.has(run.status)))) return
    let cancelled = false
    const poll = () => {
      void runsApi.get(runId, scope).then(next => {
        if (!cancelled) {
          setRun(next)
        }
      }).catch(() => undefined)
    }
    const timer = window.setInterval(poll, run.status === 'cancelling' ? 700 : 2000)
    poll()
    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [run?.status, runId, scope, suppliedRun])

  const standing = !scope.actionUserId || Boolean(run && (run.owner_user_id === scope.actionUserId || run.instructed_by_user_id === scope.actionUserId))
  // UI eligibility only; owning endpoints reauthorize every command.
  const risk = PolicyRiskLevelEnum.safeParse(run?.error_json?.risk_level)
  const ceiling = scope.actionRole ? POLICY_APPROVER_MAX_RISK[scope.actionRole] : undefined
  const riskAllowed = risk.success && ceiling !== undefined
    && POLICY_RISK_LEVEL_VALUES.indexOf(risk.data) <= POLICY_RISK_LEVEL_VALUES.indexOf(ceiling)
  const canResume = !scope.actionUserId || (run?.error_json?.supervisor_review === true ? standing : riskAllowed)
  const terminal = Boolean(run && TERMINAL_RUN_STATUSES.has(run.status))
  const active = Boolean(run && !terminal)
  useEffect(() => {
    setAuthorizationRequests([])
    setAuthorizationLoaded(false)
    if (run?.status !== 'waiting_for_review') return
    void runsApi.authorizationRequests(runId, scope).then(requests => {
      if (!scope.signal?.aborted) { setAuthorizationRequests(requests); setAuthorizationLoaded(true) }
    }).catch(() => undefined)
  }, [run?.status, runId, scope])
  useEffect(() => {
    if (authorizationLoaded) onAuthorizationDisplayed?.(authorizationRequests.filter(request => request.status === 'pending').map(request => request.id))
  }, [authorizationLoaded, authorizationRequests, onAuthorizationDisplayed])
  const stopError = actions.error
  const stop = async () => { if (active) await actions.perform({ kind: 'stop' }) }
  const retry = async () => {
    if (!onRetry || retrying) return
    setRetrying(true)
    setRetryError(null)
    try {
      await onRetry(runId)
    } catch (error) {
      if (scope.signal?.aborted) return
      setRetryError(error instanceof Error ? error.message : t('conversation_ui.run.retry_failed'))
    } finally {
      setRetrying(false)
    }
  }

  const showStandaloneLabel = Boolean(agentLabel && (active || run?.status === 'failed' || run?.status === 'cancelled'))
  return <div className="mt-2 w-full min-w-0 max-w-full space-y-2 empty:hidden" data-testid={`conversation-run-controls-${runId}`}>
    {showStandaloneLabel && <div className="text-[11px] font-medium text-muted-foreground">{agentLabel}</div>}
    {run && <RunQuotaRecoveryControls run={run} scope={scope} canControl={standing} onChanged={async next => { setRun(next); await onChanged?.() }} />}
    {active && standing && (
      <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground" role="status" aria-live="polite">
        {showStatus && !runQuotaRecovery(run!) && <span>{stopping || run?.status === 'cancelling' ? t('conversation_ui.run.stopping') : run?.status === 'queued' ? t('conversation_ui.run.queued') : run?.status === 'waiting_for_dependency' ? t('conversation_ui.run.waiting_previous') : t('conversation_ui.run.working')}</span>}
        <Button type="button" size="sm" variant="outline" className="h-7" disabled={Boolean(actions.busy) || run?.status === 'cancelling'} onClick={() => void stop()}>
          <Square className="mr-1 size-3" />{t('conversation_ui.run.stop')}
        </Button>
        {stopError && <span className="text-destructive" role="alert">{stopError}</span>}
      </div>
    )}
    {run?.status === 'waiting_for_review' && <div className="flex flex-wrap gap-2">
      {authorizationRequests.filter(request => request.status === 'pending').map(request => <div key={request.id} className="space-y-1"><p className="text-xs">{request.reason}</p>{!scope.actionUserId || scope.actionRole === 'owner' ? <div className="flex gap-2">
        <Button size="sm" disabled={Boolean(actions.busy)} onClick={() => void actions.perform({ kind: 'approve', requestId: request.id })}>{t('conversation_ui.run.approve')}</Button>
        <Button size="sm" variant="outline" disabled={Boolean(actions.busy)} onClick={() => void actions.perform({ kind: 'reject', requestId: request.id })}>{t('conversation_ui.run.reject')}</Button>
      </div> : <p className="text-xs text-muted-foreground">{t('conversation_ui.run.no_authorization_authority')}</p>}</div>)}
      {authorizationLoaded && canResume && !hasRunAuthorizationPause(run, authorizationRequests) && <Button size="sm" disabled={Boolean(actions.busy)} onClick={() => void actions.perform({ kind: 'resume' })}>{t('conversation_ui.run.resume')}</Button>}
      {scope.actionUserId && authorizationLoaded && !canResume && run.error_json?.supervisor_review !== true && !hasRunAuthorizationPause(run, authorizationRequests) && <p className="text-xs text-muted-foreground">{risk.success
        ? t('conversation_ui.run.approval_required', { risk: t(`conversation_ui.run.risk.${risk.data}`) })
        : t('conversation_ui.run.approval_risk_missing')}</p>}
    </div>}
    {scope.actionUserId && standing && run?.status === 'waiting_for_review' && authorizationLoaded && !hasRunAuthorizationPause(run, authorizationRequests) && <Button size="sm" variant="outline" disabled={Boolean(actions.busy)} onClick={() => void actions.perform({ kind: 'abandon' })}>{t('conversation_ui.run.abandon')}</Button>}
    {scope.actionUserId && !standing && active && <p className="text-xs text-muted-foreground">{t('conversation_ui.run.no_run_authority')}</p>}
    {stopError && !active && <p className="text-xs text-destructive" role="alert">{stopError}</p>}
    {actions.refreshError && <p className="text-xs text-muted-foreground" role="status">{t('conversation_ui.run.refresh_failed', { message: actions.refreshError })}</p>}
    {run?.status === 'cancelled' && <p className="text-xs text-muted-foreground">{t('conversation_ui.run.cancelled')}</p>}
    {run?.status === 'failed' && onRetry && (
      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" size="sm" variant="outline" className="h-7" disabled={retrying} onClick={() => void retry()}>
          {retrying ? <Loader2 className="mr-1 size-3 animate-spin" /> : <RefreshCw className="mr-1 size-3" />}{t('conversation_ui.run.retry')}
        </Button>
        {retryError && <span className="text-xs text-destructive" role="alert">{retryError}</span>}
      </div>
    )}
    {terminal && run && <ConversationChangesCard run={run} projectId={projectId} agentLabel={showStandaloneLabel ? undefined : agentLabel} refreshToken={refreshToken} onRefresh={() => setRefreshToken(value => value + 1)} />}
  </div>
}

function ConversationChangesCard({ run, projectId, agentLabel, refreshToken, onRefresh }: {
  run: Run
  projectId?: string | null
  agentLabel?: string
  refreshToken: number
  onRefresh: () => void
}) {
  const scope = useConversationScope()
  const { t } = useAppTranslation()
  const [artifact, setArtifact] = useState<Artifact | null>(null)
  const [state, setState] = useState<'checking' | 'no-change' | 'ready' | 'truncated' | 'unavailable'>('checking')
  const hostRun = Boolean(run.host_task_thread_id || run.workspace_location_id)

  useEffect(() => {
    let cancelled = false
    setArtifact(null)
    if (!hostRun) {
      setState('no-change')
      return () => { cancelled = true }
    }
    setState('checking')
    void (async () => {
      for (let attempt = 0; attempt < DIFF_ATTEMPTS && !cancelled && !scope.signal?.aborted; attempt += 1) {
        try {
          const page = await runsApi.artifacts(run.id, { limit: '50' }, scope)
          const summary = page.items.find(item => item.artifact_type === 'remote_diff')
          if (summary) {
            const detail = await artifactsApi.get(summary.id, undefined, scope)
            if (cancelled || scope.signal?.aborted) return
            setArtifact(detail)
            const hasChanges = detail.has_inline_content || Boolean(detail.content)
            const truncated = detail.metadata_json?.truncated === true
            setState(!hasChanges ? 'no-change' : truncated ? 'truncated' : 'ready')
            return
          }
        } catch {
          // A terminal Run may be readable before its Host artifact upload is.
        }
        if (attempt < DIFF_ATTEMPTS - 1) await new Promise(resolve => window.setTimeout(resolve, DIFF_DELAY_MS))
      }
      if (!cancelled) setState('unavailable')
    })()
    return () => { cancelled = true }
  }, [hostRun, refreshToken, run.id, scope])

  // An empty diff is not an action or a result the conversation needs to show.
  // Keep unavailable distinct: the upload may have failed, so it is not proof
  // that the Run made no changes.
  if (state === 'checking' || state === 'no-change') return null

  const status = state === 'unavailable'
    ? run.status === 'failed' ? t('conversation_ui.changes.unavailable_failed') : t('conversation_ui.changes.unavailable')
    : state === 'truncated' ? t('conversation_ui.changes.truncated') : t('conversation_ui.changes.recorded')
  return <div className="w-full min-w-0 max-w-full rounded-md border border-border bg-muted/20 px-2.5 py-2 text-xs" data-testid={`changes-${run.id}`}>
    {agentLabel && <div className="mb-1 text-[11px] font-medium text-muted-foreground">{agentLabel}</div>}
    <div className="flex min-w-0 flex-wrap items-start gap-1.5 font-medium"><FileDiff className="mt-0.5 size-3.5 shrink-0" /><span>{t('conversation_ui.changes.title')}</span><span className="min-w-0 break-words font-normal text-muted-foreground">· {status}</span></div>
    {artifact?.content && <details className="mt-1.5">
      <summary className="cursor-pointer text-muted-foreground">{t('conversation_ui.changes.preview')}</summary>
      <pre className="mt-1 max-h-56 overflow-auto whitespace-pre-wrap break-words rounded bg-background p-2 text-[10px]">{artifact.content}</pre>
    </details>}
    <div className="mt-1.5 flex flex-wrap gap-3">
      {artifact && <Link to={`/artifacts/${artifact.id}`} className="text-accent-foreground underline-offset-2 hover:underline">{t('conversation_ui.changes.open_exact')}</Link>}
      {projectId && <Link to={`/projects/${projectId}/files`} className="text-accent-foreground underline-offset-2 hover:underline">{t('conversation_ui.changes.files')}</Link>}
      {state === 'unavailable' && <button type="button" className="text-accent-foreground underline-offset-2 hover:underline" onClick={onRefresh}>{t('conversation_ui.changes.check_again')}</button>}
    </div>
  </div>
}
