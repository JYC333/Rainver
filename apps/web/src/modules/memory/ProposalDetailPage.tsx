import { useEffect, useState } from 'react'
import { useParams } from 'react-router-dom'
import { SpaceLink as Link } from '../../core/spaceNav'
import { ArrowLeft } from 'lucide-react'
import { toast } from 'sonner'
import { proposalsApi } from '../../api/client'
import { useSpace } from '../../contexts/SpaceContext'
import { errMsg } from '../../lib/utils'
import type { Proposal, ProposalAcceptOut } from '../../types/api'
import { Card } from '../../components/ui/card'
import { Button } from '../../components/ui/button'
import { Badge, StatusBadge } from '../../components/ui/badge'
import { Skeleton } from '../../components/ui/skeleton'
import { PreviewBadge, UrgencyBadge } from '../../components/PreviewBadge'
import { EgressReviewNotice, isGrantDerivedProposal } from './EgressReviewNotice'
import { codePatchAcceptOptions } from './codePatchConfirm'
import { ContentAccessControl } from '../../components/ContentAccessControl'
import { notifyReviewAttentionChanged } from '../../core/reviewAttention'

function fmt(dt: string | null | undefined) {
  return dt ? new Date(dt).toLocaleString() : '—'
}

export default function ProposalDetailPage() {
  const { proposalId = '' } = useParams()
  const { activeSpaceId, activeSpaceName, userId } = useSpace()
  const [p, setP] = useState<Proposal | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!proposalId) return
    if (!activeSpaceId) {
      setP(null)
      setLoading(false)
      return
    }
    let cancelled = false
    ;(async () => {
      setLoading(true)
      try {
        const r = await proposalsApi.get(proposalId)
        if (!cancelled) setP(r)
      } catch (e) {
        if (!cancelled) {
          toast.error(errMsg(e))
          setP(null)
        }
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => { cancelled = true }
  }, [proposalId, activeSpaceId])

  // Every pending proposal, as on the list: plan reviews, capability installs
  // and the rest are sent here to be decided, and a type the server cannot
  // apply yet is reported by `decide`.
  const canDecide = p?.status === 'pending'

  async function decide(action: 'accept' | 'reject') {
    if (!p) return
    setBusy(true)
    try {
      if (action === 'accept') {
        const options = codePatchAcceptOptions(p)
        if (options === null) return
        const out: ProposalAcceptOut = await proposalsApi.accept(p.id, options)
        if (out.result_type === 'memory_entry') {
          toast.success('Accepted — memory entry created.')
        } else if (out.result_type === 'code_patch_apply') {
          const n = out.result.updated_paths.length
          toast.success(`Accepted — ${n} file${n === 1 ? '' : 's'} updated.`)
        } else if (out.result_type === 'knowledge_item') {
          toast.success('Accepted — knowledge item created.')
        } else if (out.result_type === 'claim') {
          toast.success('Accepted — claim updated.')
        } else if (out.result_type === 'object_relation') {
          toast.success('Accepted — object relation created.')
        } else if (out.result_type === 'retrieval_maintenance_packet') {
          const n = out.result.generated_child_proposal_count ?? out.result.generated_child_proposal_ids?.length ?? 0
          toast.success(`Accepted — ${n} child proposal${n === 1 ? '' : 's'} created.`)
        } else if (out.result_type === 'claim_candidate_packet') {
          const n = out.result.generated_child_proposal_count ?? out.result.generated_child_proposal_ids?.length ?? 0
          const skipped = out.result.skipped_child_proposal_count ?? 0
          toast.success(`Accepted — ${n} child proposal${n === 1 ? '' : 's'} created${skipped ? `, ${skipped} skipped` : ''}.`)
        } else {
          toast.success('Proposal accepted.')
        }
      } else {
        await proposalsApi.reject(p.id)
        toast.success('Proposal rejected.')
      }
      notifyReviewAttentionChanged()
      const r = await proposalsApi.get(p.id)
      setP(r)
    } catch (e) {
      const message = errMsg(e)
      if (message.includes('GrantingUserApprovalRequired') || message.includes('egress_granting_user')) {
        toast.error('Granting-user approval is required before this can be applied.')
      } else if (
        message.includes('not_implemented') ||
        message.includes('not implemented') ||
        message.includes('unsupported') ||
        message.includes('422')
      ) {
        toast.error('This proposal type cannot be applied yet. Reject it to dismiss, or leave it pending.')
      } else {
        toast.error(message)
      }
    } finally {
      setBusy(false)
    }
  }

  async function approveEgress() {
    if (!p) return
    setBusy(true)
    try {
      await proposalsApi.approveEgressGrantingUserProposal(p.id, { grant_id: p.grant_id ?? undefined })
      toast.success('Egress review approval recorded')
      notifyReviewAttentionChanged()
      setP(await proposalsApi.get(p.id))
    } catch (e) {
      toast.error(errMsg(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="p-6 space-y-6 max-w-3xl">
      <Button variant="ghost" size="sm" asChild>
        <Link to="/proposals"><ArrowLeft className="size-4 mr-1" />Proposals</Link>
      </Button>

      {loading && <Skeleton className="h-40 w-full" />}

      {!loading && !p && (
        <Card className="p-8 text-center text-sm text-muted-foreground">
          {activeSpaceId ? 'Proposal not found.' : 'Select an operational space to view this proposal.'}
        </Card>
      )}

      {!loading && p && (
        <Card className="p-5 space-y-4">
          <div className="flex flex-wrap justify-between gap-3 items-start">
            <div>
              <h1 className="text-lg font-semibold tracking-tight">{p.proposed_title}</h1>
              <p className="text-xs text-muted-foreground">
                Viewing: {activeSpaceName ?? activeSpaceId ?? 'No operational space selected'}
              </p>
            </div>
            <div className="flex flex-wrap gap-1.5 shrink-0">
              <ContentAccessControl resourceType="proposal" resourceId={p.id} ownerUserId={p.user_id || null} />
              {canDecide && (
                <>
                <Button size="sm" variant="success" disabled={busy} onClick={() => decide('accept')}>Accept</Button>
                <Button size="sm" variant="destructive" disabled={busy} onClick={() => decide('reject')}>Reject</Button>
                </>
              )}
            </div>
          </div>
          <div className="flex flex-wrap gap-1.5 items-center">
            <Badge variant="secondary">{p.proposal_type}</Badge>
            <StatusBadge status={p.status} />
            <UrgencyBadge urgency={p.urgency} />
            {isGrantDerivedProposal(p) && (
              <Badge variant={p.egress_approval_status === 'approved' ? 'success' : 'warning'}>
                {p.egress_approval_status === 'approved' ? 'egress approved' : 'egress gated'}
              </Badge>
            )}
            {p.preview && <PreviewBadge />}
            {p.created_by_run_id && (
              <Link to={`/runs/${p.created_by_run_id}`} className="text-xs text-accent-foreground hover:underline">
                Open run
              </Link>
            )}
          </div>
          <EgressReviewNotice
            proposal={p}
            currentUserId={userId}
            targetSpaceName={activeSpaceName ?? activeSpaceId ?? 'this space'}
            approving={busy}
            onApprove={approveEgress}
          />
          <p className="text-xs text-muted-foreground">
            review_deadline {fmt(p.review_deadline)} · expires {fmt(p.expires_at)}
          </p>
          <p className="text-sm whitespace-pre-wrap">{p.proposed_content}</p>
          {p.proposal_type === 'retrieval_maintenance_packet' && (
            <div className="rounded-md border border-border bg-muted/30 p-3 text-sm">
              <p className="font-medium">Maintenance packet</p>
              <p className="mt-1 text-xs text-muted-foreground">
                Accepting this packet creates child Knowledge relation proposals where supported. Review the linked maintenance report artifact from the producing run or Artifacts page for full findings.
              </p>
            </div>
          )}
          <p className="text-xs text-muted-foreground italic">Rationale: {p.rationale}</p>
          <p className="text-xs text-muted-foreground">{fmt(p.created_at)}</p>
          {p.status === 'accepted' && p.resulting_memory_id && (
            <div className="pt-2 border-t border-border">
              <Link
                to={`/memory/${p.resulting_memory_id}`}
                className="text-xs text-accent-foreground hover:underline"
              >
                View created memory →
              </Link>
            </div>
          )}
        </Card>
      )}
    </div>
  )
}
