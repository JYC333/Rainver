import { useEffect, useState } from 'react'
import { proposalsApi } from '../../api/client'
import { Button } from '../../components/ui/button'
import { SpaceLink } from '../../core/spaceNav'
import { errMsg } from '../../lib/utils'
import { useAppTranslation } from '../../i18n'
import type { ChatActionPreview } from '../../types/api'

export type ActionDecision = 'accept' | 'reject'

/*
 * Not AI Elements' `Confirmation` (plan P2), deliberately.
 *
 * That component is a presentational shell — a title, a request line, an
 * accepted and a rejected state, two buttons. This card is those things plus
 * the part that matters: it reconciles the Run's immutable action snapshot
 * against the live Proposal on mount, so a decision another Room member
 * already made cannot leave a stale pair of buttons for the next person to
 * press. Swapping it would trade that for markup, and pull the AI SDK back
 * into the tree for a component that renders from props.
 */
type ActionDisplayStatus = ChatActionPreview['status'] | 'superseded'

/** One decision-card entry for Room, Project sidecar and direct Agent chat. */
export function ActionPreviewCards({
  previews,
  viewerUserId,
  onDecision,
  testId,
}: {
  previews: readonly ChatActionPreview[]
  viewerUserId: string | null | undefined
  onDecision?: (preview: ChatActionPreview, action: ActionDecision) => Promise<void>
  testId?: string
}) {
  const cards = decidableByViewer(previews, viewerUserId)
  if (cards.length === 0) return null
  return (
    <div className="mt-2 space-y-2" data-testid={testId}>
      {cards.map((preview, index) => (
        <ActionPreviewCard
          key={`${preview.action_id}:${preview.proposal_id ?? index}`}
          preview={preview}
          onDecision={onDecision}
        />
      ))}
    </div>
  )
}

/** Completed actions belong to the Run audit; personal proposals stay private. */
export function decidableByViewer(
  previews: readonly ChatActionPreview[],
  viewerUserId: string | null | undefined,
): ChatActionPreview[] {
  return previews.filter(preview =>
    preview.status !== 'completed'
    && (!preview.decidable_by_user_id || preview.decidable_by_user_id === viewerUserId))
}

function ActionPreviewCard({
  preview,
  onDecision,
}: {
  preview: ChatActionPreview
  onDecision?: (preview: ChatActionPreview, action: ActionDecision) => Promise<void>
}) {
  const { t } = useAppTranslation()
  const [status, setStatus] = useState<ActionDisplayStatus>(preview.status)
  const [checkingStatus, setCheckingStatus] = useState(Boolean(preview.proposal_id))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [resultMessage, setResultMessage] = useState<string | null>(null)
  const decidable = Boolean(onDecision) && !checkingStatus && status === 'proposed' && Boolean(preview.proposal_id)
  const canContinue = Boolean(onDecision) && (status === 'auto_applied' || status === 'rejected') && !resultMessage
  const appliedDescription = preview.action_id === 'project.propose_definition'
    ? t('mixed_surfaces.action_preview.action_project_definition_saved')
    : preview.action_id === 'inquiry.promote_knowledge'
      ? t('mixed_surfaces.action_preview.action_knowledge_promoted')
      : t('mixed_surfaces.action_preview.action_change_saved')
  const statusLabels: Record<ActionDisplayStatus, string> = {
    proposed: t('mixed_surfaces.action_preview.status_proposed'),
    auto_applied: t('mixed_surfaces.action_preview.status_auto_applied'),
    completed: t('mixed_surfaces.action_preview.status_completed'),
    failed: t('mixed_surfaces.action_preview.status_failed'),
    rejected: t('mixed_surfaces.action_preview.status_rejected'),
    superseded: t('mixed_surfaces.action_preview.status_superseded'),
  }
  const riskLabel = preview.risk_level === 'low'
    ? t('mixed_surfaces.action_preview.risk_low')
    : preview.risk_level === 'medium'
      ? t('mixed_surfaces.action_preview.risk_medium')
      : preview.risk_level === 'high'
        ? t('mixed_surfaces.action_preview.risk_high')
        : preview.risk_level === 'critical'
          ? t('mixed_surfaces.action_preview.risk_critical')
          : preview.risk_level
            ? t('mixed_surfaces.action_preview.risk_other', { level: preview.risk_level })
            : null

  // Action previews are immutable Run snapshots. Always reconcile them with
  // the live Proposal so another member's decision cannot leave stale buttons.
  useEffect(() => {
    if (!preview.proposal_id) return
    let cancelled = false
    proposalsApi.get(preview.proposal_id).then(proposal => {
      if (cancelled) return
      setStatus(proposalStatus(proposal.status))
    }).catch(() => { /* retain the auditable snapshot when refresh is unavailable */ })
      .finally(() => {
        if (!cancelled) setCheckingStatus(false)
      })
    return () => { cancelled = true }
  }, [preview.proposal_id])

  const continueAfterDecision = async (action: ActionDecision) => {
    if (!onDecision) return
    setResultMessage(action === 'accept'
      ? t('mixed_surfaces.action_preview.continuing_after_accept', { action: appliedDescription })
      : t('mixed_surfaces.action_preview.continuing_after_reject'))
    try {
      await onDecision(preview, action)
      setResultMessage(action === 'accept'
        ? t('mixed_surfaces.action_preview.continued_after_accept', { action: appliedDescription })
        : t('mixed_surfaces.action_preview.continued_after_reject'))
    } catch (continuationError) {
      setResultMessage(null)
      setError(t(action === 'accept' ? 'mixed_surfaces.action_preview.accept_continuation_failed' : 'mixed_surfaces.action_preview.reject_continuation_failed', { error: errMsg(continuationError) }))
    }
  }

  const decide = async (action: ActionDecision) => {
    if (!onDecision || !preview.proposal_id) return
    setBusy(true)
    setError(null)
    try {
      if (action === 'accept') await proposalsApi.accept(preview.proposal_id)
      else await proposalsApi.reject(preview.proposal_id)
      setStatus(action === 'accept' ? 'auto_applied' : 'rejected')
      await continueAfterDecision(action)
    } catch (decisionError) {
      setError(errMsg(decisionError))
    } finally {
      setBusy(false)
    }
  }

  const continueFromDecided = async () => {
    setBusy(true)
    setError(null)
    await continueAfterDecision(status === 'rejected' ? 'reject' : 'accept')
    setBusy(false)
  }

  const description = resultMessage
    ?? (status === 'auto_applied' ? appliedDescription : null)
    ?? (status === 'superseded' ? t('mixed_surfaces.action_preview.superseded_description') : null)
  return (
    <div className="rounded-md border border-border bg-background p-3 text-foreground">
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-medium">{preview.title ?? preview.proposal_type ?? preview.action_id}</span>
        <span className="text-[10px] uppercase text-muted-foreground">
          {checkingStatus ? t('mixed_surfaces.action_preview.checking_status') : statusLabels[status]}
        </span>
      </div>
      {preview.summary && <p className="mt-1 text-xs text-muted-foreground">{preview.summary}</p>}
      {riskLabel && <span className="mt-1 block text-[11px] text-muted-foreground">{riskLabel}</span>}
      {decidable && (
        <div className="mt-2 flex gap-2">
          <Button size="sm" disabled={busy} onClick={() => decide('accept')}>{t('mixed_surfaces.action_preview.accept')}</Button>
          <Button size="sm" variant="outline" disabled={busy} onClick={() => decide('reject')}>{t('mixed_surfaces.action_preview.reject')}</Button>
        </div>
      )}
      {canContinue && (
        <div className="mt-2">
          <Button size="sm" variant="outline" disabled={busy} onClick={continueFromDecided}>
            {busy ? t('mixed_surfaces.action_preview.continue_busy') : status === 'rejected' ? t('mixed_surfaces.action_preview.continue_rejected') : t('mixed_surfaces.action_preview.continue_accepted')}
          </Button>
        </div>
      )}
      {!onDecision && preview.proposal_id && (
        <SpaceLink className="mt-2 block w-fit text-[11px] text-accent-foreground hover:underline" to={`/proposals/${preview.proposal_id}`}>
          {t('mixed_surfaces.action_preview.review_proposal')}
        </SpaceLink>
      )}
      {description && <p className="mt-2 text-xs text-muted-foreground">{description}</p>}
      {error && <p className="mt-1 text-xs text-destructive">{error}</p>}
    </div>
  )
}

function proposalStatus(status: string): ActionDisplayStatus {
  if (status === 'pending') return 'proposed'
  if (status === 'accepted') return 'auto_applied'
  if (status === 'rejected') return 'rejected'
  if (status === 'superseded') return 'superseded'
  return 'failed'
}
