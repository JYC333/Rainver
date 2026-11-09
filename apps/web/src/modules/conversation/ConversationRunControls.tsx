import {TurnWorkspaceSummary} from './TurnWorkspaceSummary'
import { hasRunAuthorizationPause, useRunActions } from '../runs/useRunActions'
import { RunQuotaRecoveryControls, runQuotaRecovery } from '../runs/RunQuotaRecoveryControls'
import { RuntimeFailureNotice } from '../runs/RuntimeFailureNotice'
import { POLICY_APPROVER_MAX_RISK, POLICY_RISK_LEVEL_VALUES, PolicyRiskLevelEnum } from '@rainver/protocol'
import { ConversationScope, useConversationScope } from './ConversationScope'
import { createContext, useEffect, useState } from 'react'
import { Loader2, RefreshCw, Square } from 'lucide-react'
import { runsApi } from '../../api/client'
import type { AuthorizationRequest, Run } from '../../types/api'
import { Button } from '../../components/ui/button'
import { useAppTranslation } from '../../i18n'

const TERMINAL_RUN_STATUSES = new Set(['succeeded', 'failed', 'degraded', 'cancelled', 'orphaned'])
/** Presentation deduplication only; every action still rechecks its own Run. */
export const PresentedRunDecisions = createContext<ReadonlySet<string>>(new Set())

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
  reviewOnly = false,
  workspaceSummary = true,
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
  /** Background and detail surfaces reuse decisions without nesting workspaces. */
  reviewOnly?: boolean
  /** False where the surrounding surface shows one summary for a whole turn group. */
  workspaceSummary?: boolean
}) {
  const scope = useConversationScope()
  const { t } = useAppTranslation()
  const [run, setRun] = useState<Run | null>(suppliedRun ?? null)
  const [authorizationRequests, setAuthorizationRequests] = useState<AuthorizationRequest[]>([])
  const [authorizationLoaded, setAuthorizationLoaded] = useState(false)
  const [authorizationError, setAuthorizationError] = useState(false)
  const [authorizationRefresh, setAuthorizationRefresh] = useState(0)
  const [runLoadError, setRunLoadError] = useState(false)
  const actions = useRunActions(runId, scope, async next => {
    setRun(next)
    await onChanged?.()
  })
  const stopping = actions.busy?.kind === 'stop'
  const [retrying, setRetrying] = useState(false)
  const [retryError, setRetryError] = useState<string | null>(null)

  useEffect(() => setRun(suppliedRun ?? null), [suppliedRun, scope])
  useEffect(() => {
    if (run || !runId) return
    let cancelled = false
    setRunLoadError(false)
    void runsApi.get(runId, scope).then(next => { if (!cancelled) setRun(next) }).catch(() => { if (!cancelled && !scope.signal?.aborted) setRunLoadError(true) })
    return () => { cancelled = true }
  }, [run, runId, scope, authorizationRefresh])

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
    let cancelled = false
    setAuthorizationRequests([])
    setAuthorizationLoaded(false)
    setAuthorizationError(false)
    if (run?.status !== 'waiting_for_review') return
    void runsApi.authorizationRequests(runId, scope).then(requests => {
      if (!cancelled && !scope.signal?.aborted) { setAuthorizationRequests(requests); setAuthorizationLoaded(true) }
    }).catch(() => { if (!cancelled && !scope.signal?.aborted) setAuthorizationError(true) })
    return () => { cancelled = true }
  }, [run?.status, runId, scope, authorizationRefresh])
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
    {run && !reviewOnly && <RunQuotaRecoveryControls run={run} scope={scope} canControl={standing} onChanged={async next => { setRun(next); await onChanged?.() }} />}
    {run && <RuntimeFailureNotice key={`${run.space_id}:${run.id}`} run={run} flat={reviewOnly} />}
    {reviewOnly && typeof run?.contract_snapshot_json?.workspace_integration_id === 'string' && <p className="text-xs text-muted-foreground">{t('conversation_ui.run.background_repair')}</p>}
    {reviewOnly && run && ['queued','running'].includes(run.status) && <p role="status" className="text-xs text-muted-foreground">{t(run.status === 'queued' ? 'conversation_ui.run.queued' : 'conversation_ui.run.working')}</p>}
    {run?.status === 'waiting_for_review' && run.error_json?.supervisor_review === true && <p role="status" className="text-xs text-muted-foreground">{t('conversation_ui.run.execution_review')}</p>}
    {(authorizationError || runLoadError) && <div role="alert" className="flex flex-wrap items-center gap-2 text-xs text-destructive">{t('conversation_ui.run.actions_unavailable')}<Button size="sm" variant="outline" onClick={() => setAuthorizationRefresh(value => value + 1)}>{t('conversation_ui.run.reload_actions')}</Button></div>}
    {active && standing && !reviewOnly && run?.status !== 'waiting_for_review' && (
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
      {authorizationLoaded && canResume && !hasRunAuthorizationPause(run, authorizationRequests) && <Button size="sm" disabled={Boolean(actions.busy)} onClick={() => void actions.perform({ kind: 'resume' })}>{t(run.error_json?.supervisor_review === true ? 'conversation_ui.run.retry_execution' : 'conversation_ui.run.resume')}</Button>}
      {scope.actionUserId && authorizationLoaded && !canResume && run.error_json?.supervisor_review !== true && !hasRunAuthorizationPause(run, authorizationRequests) && <p className="text-xs text-muted-foreground">{risk.success
        ? t('conversation_ui.run.approval_required', { risk: t(`conversation_ui.run.risk.${risk.data}`) })
        : t('conversation_ui.run.approval_risk_missing')}</p>}
    </div>}
    {scope.actionUserId && standing && run?.status === 'waiting_for_review' && authorizationLoaded && !hasRunAuthorizationPause(run, authorizationRequests) && <Button size="sm" variant="outline" disabled={Boolean(actions.busy)} onClick={() => void actions.perform({ kind: 'abandon' })}>{t('conversation_ui.run.abandon')}</Button>}
    {scope.actionUserId && !standing && active && <p className="text-xs text-muted-foreground">{t('conversation_ui.run.no_run_authority')}</p>}
    {stopError && (!active || reviewOnly || run?.status === 'waiting_for_review') && <p className="text-xs text-destructive" role="alert">{stopError}</p>}
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
    {terminal && run && !reviewOnly && workspaceSummary && <TurnWorkspaceSummary runs={[run]} projectId={projectId} />}
  </div>
}
