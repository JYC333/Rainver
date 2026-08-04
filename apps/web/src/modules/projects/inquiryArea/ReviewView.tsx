import { useCallback, useEffect, useRef, useState } from 'react'
import { AlertTriangle, CheckCircle2, CircleDot, RefreshCw } from 'lucide-react'
import { toast } from 'sonner'
import { inquiryApi, type InquiryDeltaBrief } from '../../../api/client'
import { errMsg } from '../../../lib/utils'
import type { InquiryCandidate, InquiryReviewPacket, InquiryThread } from '../../../types/api'
import { Badge } from '../../../components/ui/badge'
import { Button } from '../../../components/ui/button'
import { Card } from '../../../components/ui/card'
import { EmptyState } from '../../../components/ui/empty-state'
import { Label } from '../../../components/ui/label'
import { Select } from '../../../components/ui/select'
import { Textarea } from '../../../components/ui/textarea'
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '../../../components/ui/dialog'
import { ReasonDialog } from './dialogs'

function DeltaOverview({ brief, generating, onRegenerate }: {
  brief: InquiryDeltaBrief | null
  generating: boolean
  onRegenerate: () => void
}) {
  const content = brief?.content
  const since = brief?.coverage_start
    ? `since ${new Date(brief.coverage_start).toLocaleString()}`
    : 'across this Project’s whole history'

  return (
    <Card className="p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-sm font-medium">What changed {since}</p>
          {content && (
            <p className="text-xs text-muted-foreground">
              {content.input_and_coverage_window.signal_count} Evidence Signal
              {content.input_and_coverage_window.signal_count === 1 ? '' : 's'} · generated{' '}
              {brief ? new Date(brief.created_at).toLocaleString() : ''}
            </p>
          )}
        </div>
        <Button size="sm" variant="outline" onClick={onRegenerate} disabled={generating}>
          <RefreshCw className={`size-4 ${generating ? 'animate-spin' : ''}`} />
          {brief ? 'Summarize what’s new since this' : 'Summarize new information'}
        </Button>
      </div>

      {content && (
        content.no_change_statement
          ? <p className="mt-3 text-sm text-muted-foreground">{content.no_change_statement}</p>
          : (
            <div className="mt-3 space-y-3">
              {content.challenged_positions.length > 0 && (
                <section>
                  <p className="mb-1 flex items-center gap-1.5 text-xs font-medium text-destructive">
                    <AlertTriangle className="size-3" />Challenged
                  </p>
                  {content.challenged_positions.map(item => (
                    <p key={item.thread_id} className="truncate text-sm">
                      {item.statement} <span className="text-muted-foreground">· {item.count} contradicting</span>
                    </p>
                  ))}
                </section>
              )}
              {content.gap_changes.length > 0 && (
                <section>
                  <p className="mb-1 flex items-center gap-1.5 text-xs font-medium text-amber-600">
                    <CircleDot className="size-3" />Gap changes
                  </p>
                  {content.gap_changes.map(item => (
                    <p key={item.thread_id} className="truncate text-sm">
                      {item.statement}{' '}
                      <span className="text-muted-foreground">· {item.new_gaps} new, {item.filled_gaps} filled</span>
                    </p>
                  ))}
                </section>
              )}
              {content.reinforced_positions.length > 0 && (
                <section>
                  <p className="mb-1 flex items-center gap-1.5 text-xs font-medium text-emerald-600">
                    <CheckCircle2 className="size-3" />Reinforced
                  </p>
                  {content.reinforced_positions.map(item => (
                    <p key={item.thread_id} className="truncate text-sm">
                      {item.statement} <span className="text-muted-foreground">· {item.count} supporting</span>
                    </p>
                  ))}
                </section>
              )}
            </div>
          )
      )}
    </Card>
  )
}

function AcceptDialog({ open, onOpenChange, candidate, onConfirm }: {
  open: boolean
  onOpenChange: (open: boolean) => void
  candidate: InquiryCandidate | null
  onConfirm: (changeSummary: string) => Promise<void>
}) {
  const [changeSummary, setChangeSummary] = useState('')
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (open && candidate) setChangeSummary(candidate.summary ?? candidate.title)
  }, [open, candidate])

  async function confirm() {
    if (!changeSummary.trim()) { toast.error('A change summary is required'); return }
    setSaving(true)
    try {
      await onConfirm(changeSummary.trim())
      onOpenChange(false)
    } catch (error) {
      toast.error(errMsg(error))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Accept this change</DialogTitle>
          <DialogDescription>
            Accepting applies the proposed position change and records an Iteration on the Thread in the same transaction.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3 py-2">
          {candidate && Object.keys(candidate.proposed_change).length > 0 && (
            <div className="space-y-1.5">
              <Label>Proposed change</Label>
              <div className="space-y-1 rounded-md bg-muted p-2 text-xs">
                {Object.entries(candidate.proposed_change).map(([key, value]) => (
                  <p key={key}>
                    <span className="text-muted-foreground">{key.replace(/_/g, ' ')}:</span>{' '}
                    {typeof value === 'object' ? JSON.stringify(value) : String(value)}
                  </p>
                ))}
              </div>
            </div>
          )}
          <div className="space-y-1.5">
            <Label>Change summary <span className="text-destructive">*</span></Label>
            <Textarea value={changeSummary} onChange={event => setChangeSummary(event.target.value)} rows={3} />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button onClick={confirm} disabled={saving}>{saving ? 'Accepting…' : 'Accept'}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function DeferDialog({ open, onOpenChange, onConfirm }: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onConfirm: (reason: string, deferUntil: string) => Promise<void>
}) {
  const [reason, setReason] = useState('')
  const [until, setUntil] = useState('')
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (!open) return
    setReason('')
    setUntil(new Date(Date.now() + 7 * 86_400_000).toISOString().slice(0, 10))
  }, [open])

  async function confirm() {
    if (!reason.trim() || !until) { toast.error('A reason and a review date are required'); return }
    setSaving(true)
    try {
      await onConfirm(reason.trim(), new Date(`${until}T00:00:00`).toISOString())
      onOpenChange(false)
    } catch (error) {
      toast.error(errMsg(error))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Defer this change</DialogTitle>
          <DialogDescription>It leaves the review queue and comes back on the date you pick.</DialogDescription>
        </DialogHeader>
        <div className="space-y-3 py-2">
          <div className="space-y-1.5">
            <Label>Why defer it? <span className="text-destructive">*</span></Label>
            <Textarea value={reason} onChange={event => setReason(event.target.value)} rows={2} />
          </div>
          <div className="space-y-1.5">
            <Label>Review again on <span className="text-destructive">*</span></Label>
            <input
              type="date"
              value={until}
              onChange={event => setUntil(event.target.value)}
              aria-label="Review again on"
              className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button onClick={confirm} disabled={saving}>{saving ? 'Deferring…' : 'Defer'}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function CandidateCard({ candidate, threads, otherCandidates, onDecide, onOpenThread }: {
  candidate: InquiryCandidate
  threads: InquiryThread[]
  otherCandidates: InquiryCandidate[]
  onDecide: (decision: string, body: Record<string, unknown>) => Promise<void>
  onOpenThread: (threadId: string) => void
}) {
  const [mergeOpen, setMergeOpen] = useState(false)
  const [mergeTargetId, setMergeTargetId] = useState('')
  const [deciding, setDeciding] = useState(false)
  const [acceptOpen, setAcceptOpen] = useState(false)
  const [deferOpen, setDeferOpen] = useState(false)
  const [gapOpen, setGapOpen] = useState(false)
  const [signals, setSignals] = useState(candidate.signals ?? null)

  const thread = threads.find(item => item.id === candidate.thread_id)
  const hasProposal = Object.keys(candidate.proposed_change).length > 0

  async function loadEvidence() {
    try {
      const detail = await inquiryApi.getCandidate(candidate.project_id, candidate.id)
      setSignals(detail.signals ?? [])
    } catch (error) { toast.error(errMsg(error)) }
  }

  /**
   * `onDecide` deliberately rejects so a dialog can stay open on failure. The
   * decisions that have no dialog need their own reporting, or a failed
   * dismiss/merge would be silent.
   */
  async function decideDirectly(decision: string, body: Record<string, unknown>) {
    setDeciding(true)
    try {
      await onDecide(decision, body)
    } catch (error) {
      toast.error(errMsg(error))
    } finally {
      setDeciding(false)
    }
  }

  return (
    <Card className="p-4">
      <div className="space-y-1">
        <p className="text-sm font-medium">{candidate.title}</p>
        {candidate.summary && <p className="text-sm text-muted-foreground">{candidate.summary}</p>}
        {thread && (
          <button type="button" onClick={() => onOpenThread(thread.id)} className="block truncate text-xs text-muted-foreground underline">
            Affects: {thread.statement}
          </button>
        )}
      </div>

      {hasProposal
        ? (
          <div className="mt-2 space-y-1 rounded-md bg-muted p-2 text-xs">
            {Object.entries(candidate.proposed_change).map(([key, value]) => (
              <p key={key}>
                <span className="text-muted-foreground">{key.replace(/_/g, ' ')}:</span>{' '}
                {typeof value === 'object' ? JSON.stringify(value) : String(value)}
              </p>
            ))}
          </div>
        )
        : <p className="mt-2 text-xs text-amber-600">No concrete position change was proposed, so this cannot be accepted as-is.</p>}

      {signals && signals.length > 0 && (
        <div className="mt-2 space-y-0.5">
          {signals.map(signal => (
            <p key={signal.id} className="text-xs text-muted-foreground">
              {signal.classification.replace(/_/g, ' ')} · {signal.model_version ?? 'manual'}
              {signal.confidence !== null ? ` · confidence ${Math.round(signal.confidence * 100)}%` : ''}
            </p>
          ))}
        </div>
      )}

      <div className="mt-3 flex flex-wrap gap-1.5">
        {signals === null && <Button size="sm" variant="ghost" onClick={loadEvidence}>Show evidence</Button>}
        <Button size="sm" disabled={!hasProposal} onClick={() => setAcceptOpen(true)}>Accept</Button>
        <Button size="sm" variant="outline" onClick={() => setMergeOpen(current => !current)} disabled={otherCandidates.length === 0}>Merge</Button>
        <Button size="sm" variant="outline" onClick={() => setGapOpen(true)}>Record as gap</Button>
        <Button size="sm" variant="outline" onClick={() => setDeferOpen(true)}>Defer</Button>
        <Button size="sm" variant="ghost" disabled={deciding} onClick={() => decideDirectly('dismiss', {})}>Dismiss</Button>
      </div>

      {mergeOpen && (
        <div className="mt-2 flex flex-wrap items-center gap-2 border-t pt-2">
          <Select
            ariaLabel="Merge target Candidate"
            value={mergeTargetId}
            onChange={setMergeTargetId}
            options={[
              { value: '', label: 'Select the Candidate that should remain' },
              ...otherCandidates.map(item => ({ value: item.id, label: item.title })),
            ]}
          />
          <Button size="sm" disabled={!mergeTargetId || deciding} onClick={() => decideDirectly('merge', { target_candidate_id: mergeTargetId })}>
            Confirm merge
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setMergeOpen(false)}>Cancel</Button>
        </div>
      )}

      <AcceptDialog
        open={acceptOpen}
        onOpenChange={setAcceptOpen}
        candidate={candidate}
        onConfirm={changeSummary => onDecide('accept', { edits: {}, change_summary: changeSummary })}
      />
      <DeferDialog
        open={deferOpen}
        onOpenChange={setDeferOpen}
        onConfirm={(reason, deferUntil) => onDecide('defer', { reason, defer_until: deferUntil })}
      />
      <ReasonDialog
        open={gapOpen}
        onOpenChange={setGapOpen}
        title="Record this as a gap"
        description="Creates a new gap Question from this evidence instead of changing the current position."
        label="New gap Question"
        placeholder="What does this evidence leave unanswered?"
        required
        confirmLabel="Create gap Question"
        onConfirm={gapStatement => onDecide('gap', { gap_statement: gapStatement })}
      />
    </Card>
  )
}

/**
 * Digesting new evidence: a bounded packet of Candidates, opened by an
 * overview of what actually moved since the last review rather than five
 * isolated decisions with no shared context.
 */
export function ReviewView({ projectId, threads, candidates, deferredCandidates, onOpenThread, onChanged }: {
  projectId: string
  threads: InquiryThread[]
  candidates: InquiryCandidate[]
  deferredCandidates: InquiryCandidate[]
  onOpenThread: (threadId: string) => void
  onChanged: () => Promise<void>
}) {
  const [packet, setPacket] = useState<InquiryReviewPacket | null>(null)
  const [brief, setBrief] = useState<InquiryDeltaBrief | null>(null)
  const [generating, setGenerating] = useState(false)

  useEffect(() => {
    let cancelled = false
    inquiryApi.latestDeltaBrief(projectId)
      .then(result => { if (!cancelled) setBrief(result) })
      .catch(() => { if (!cancelled) setBrief(null) })
    return () => { cancelled = true }
  }, [projectId])

  // An open packet holds Candidates for this user; leaving without closing it
  // would strand them, so unmount releases the packet the same way an explicit
  // "view all" does. The ref exists so the cleanup can read the current packet
  // without re-subscribing on every packet change.
  const packetRef = useRef<InquiryReviewPacket | null>(null)
  useEffect(() => { packetRef.current = packet }, [packet])
  useEffect(() => () => {
    const open = packetRef.current
    if (open?.status === 'open' && open.id) void inquiryApi.closeReviewPacket(projectId, open.id)
  }, [projectId])

  const regenerate = useCallback(async () => {
    setGenerating(true)
    try {
      // Continuing from the previous Brief's coverage end is what makes this a
      // delta instead of a re-summary of the whole Project every time.
      setBrief(await inquiryApi.generateDeltaBrief(projectId, brief?.coverage_end ?? null))
    } catch (error) {
      toast.error(errMsg(error))
    } finally {
      setGenerating(false)
    }
  }, [brief, projectId])

  async function openPacket() {
    try {
      setPacket(await inquiryApi.openReviewPacket(projectId, 5))
    } catch (error) { toast.error(errMsg(error)) }
  }

  async function closePacket() {
    try {
      if (packet?.id) await inquiryApi.closeReviewPacket(projectId, packet.id)
      setPacket(null)
      await onChanged()
    } catch (error) { toast.error(errMsg(error)) }
  }

  const reviewing = packet?.status === 'open' ? packet.candidates : candidates

  async function decide(candidate: InquiryCandidate, decision: string, body: Record<string, unknown>) {
    await inquiryApi.decideCandidate(projectId, candidate.id, { decision, ...body })
    if (packet?.status === 'open') {
      const remaining = packet.candidates.filter(item => item.id !== candidate.id)
      if (remaining.length === 0 && packet.id) {
        await inquiryApi.closeReviewPacket(projectId, packet.id)
        setPacket(null)
      } else {
        setPacket({ ...packet, candidates: remaining })
      }
    }
    await onChanged()
  }

  async function reopen(candidateId: string) {
    try {
      await inquiryApi.reopenCandidate(projectId, candidateId)
      await onChanged()
    } catch (error) { toast.error(errMsg(error)) }
  }

  return (
    <div className="space-y-4">
      <DeltaOverview brief={brief} generating={generating} onRegenerate={regenerate} />

      <div className="flex flex-wrap items-center gap-3">
        <p className="text-sm">
          {candidates.length === 0
            ? 'Nothing is waiting for your decision.'
            : `${candidates.length} material change${candidates.length === 1 ? '' : 's'} need review.`}
        </p>
        <div className="flex-1" />
        {packet?.status === 'open'
          ? <Button size="sm" variant="outline" onClick={closePacket}>View all pending</Button>
          : <Button size="sm" disabled={candidates.length === 0} onClick={openPacket}>Start a review checkpoint</Button>}
      </div>

      {reviewing.length === 0 && candidates.length === 0 && (
        <EmptyState title="Nothing to review" description="Material changes from monitoring and evidence arrive here." />
      )}

      <div className="space-y-3">
        {reviewing.map(candidate => (
          <CandidateCard
            key={candidate.id}
            candidate={candidate}
            threads={threads}
            otherCandidates={candidates.filter(item => item.id !== candidate.id)}
            onDecide={(decision, body) => decide(candidate, decision, body)}
            onOpenThread={onOpenThread}
          />
        ))}
      </div>

      {deferredCandidates.length > 0 && (
        <Card className="p-4">
          <p className="mb-2 text-sm font-medium">Deferred for later review</p>
          <div className="space-y-1">
            {deferredCandidates.map(candidate => (
              <div key={candidate.id} className="flex items-center gap-2 rounded-md border p-2">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm">{candidate.title}</p>
                  <p className="text-xs text-muted-foreground">
                    {candidate.decision_reason ?? 'No reason recorded'}
                    {candidate.defer_until ? ` · returns ${new Date(candidate.defer_until).toLocaleDateString()}` : ''}
                  </p>
                </div>
                <Badge variant="outline" className="text-[10px]">deferred</Badge>
                <Button size="sm" variant="outline" onClick={() => reopen(candidate.id)}>Reopen</Button>
              </div>
            ))}
          </div>
        </Card>
      )}
    </div>
  )
}
