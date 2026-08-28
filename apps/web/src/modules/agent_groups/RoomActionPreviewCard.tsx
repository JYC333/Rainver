import { useEffect, useState } from 'react'
import { proposalsApi } from '../../api/client'
import { Button } from '../../components/ui/button'
import { errMsg } from '../../lib/utils'
import type { ChatActionPreview } from '../../types/api'

export type RoomActionDecision = 'accept' | 'reject'
type RoomActionDisplayStatus = ChatActionPreview['status'] | 'superseded'

export function RoomActionPreviewCard({
  preview,
  onDecision,
}: {
  preview: ChatActionPreview
  onDecision: (preview: ChatActionPreview, action: RoomActionDecision) => Promise<void>
}) {
  const [status, setStatus] = useState<RoomActionDisplayStatus>(preview.status)
  const [checkingStatus, setCheckingStatus] = useState(Boolean(preview.proposal_id))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [resultMessage, setResultMessage] = useState<string | null>(null)
  const decidable = !checkingStatus && status === 'proposed' && Boolean(preview.proposal_id)
  const canContinue = (status === 'auto_applied' || status === 'rejected') && !resultMessage

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

  const continueAfterDecision = async (action: RoomActionDecision) => {
    setResultMessage(action === 'accept'
      ? `${appliedActionDescription(preview)}正在让助手继续下一步…`
      : '已拒绝，正在让助手根据你的决定继续…')
    try {
      await onDecision(preview, action)
      setResultMessage(action === 'accept'
        ? `${appliedActionDescription(preview)}助手正在下方继续。`
        : '已记录拒绝，助手正在下方继续。')
    } catch (continuationError) {
      setResultMessage(null)
      setError(`${action === 'accept' ? '确认结果已保存' : '拒绝结果已保存'}，但自动继续失败：${errMsg(continuationError)}`)
    }
  }

  const decide = async (action: RoomActionDecision) => {
    if (!preview.proposal_id) return
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
    ?? (status === 'auto_applied' ? appliedActionDescription(preview) : null)
    ?? (status === 'superseded' ? '这是重复提案，已与已有研究问题合并，无需再次确认。' : null)
  return (
    <div className="rounded-md border border-border bg-background p-3 text-foreground">
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-medium">{preview.title ?? preview.proposal_type ?? preview.action_id}</span>
        <span className="text-[10px] uppercase text-muted-foreground">
          {checkingStatus ? '正在确认状态…' : actionPreviewStatusLabel(status)}
        </span>
      </div>
      {preview.summary && <p className="mt-1 text-xs text-muted-foreground">{preview.summary}</p>}
      {preview.risk_level && <span className="mt-1 block text-[11px] text-muted-foreground">{preview.risk_level} risk</span>}
      {decidable && (
        <div className="mt-2 flex gap-2">
          <Button size="sm" disabled={busy} onClick={() => decide('accept')}>Accept</Button>
          <Button size="sm" variant="outline" disabled={busy} onClick={() => decide('reject')}>Reject</Button>
        </div>
      )}
      {canContinue && (
        <div className="mt-2">
          <Button size="sm" variant="outline" disabled={busy} onClick={continueFromDecided}>
            {busy ? '正在继续…' : status === 'rejected' ? '继续修改' : '继续下一步'}
          </Button>
        </div>
      )}
      {description && <p className="mt-2 text-xs text-muted-foreground">{description}</p>}
      {error && <p className="mt-1 text-xs text-destructive">{error}</p>}
    </div>
  )
}

function proposalStatus(status: string): RoomActionDisplayStatus {
  if (status === 'pending') return 'proposed'
  if (status === 'accepted') return 'auto_applied'
  if (status === 'rejected') return 'rejected'
  if (status === 'superseded') return 'superseded'
  return 'failed'
}

function appliedActionDescription(preview: ChatActionPreview): string {
  if (preview.action_id === 'project.propose_definition') {
    return '项目目标、范围和成功标准已保存。'
  }
  if (preview.action_id === 'inquiry.promote_knowledge') {
    return '已提升为空间级知识。'
  }
  return '这项变更已确认并保存。'
}

function actionPreviewStatusLabel(status: RoomActionDisplayStatus): string {
  return ({
    proposed: 'Needs confirmation',
    auto_applied: 'Accepted',
    completed: 'Completed',
    failed: 'Failed',
    rejected: 'Rejected',
    superseded: '重复 · 已合并',
  } as const)[status]
}
