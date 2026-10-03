import { ShieldAlert } from 'lucide-react'
import type { Proposal } from '../../types/api'
import { Badge } from '../../components/ui/badge'
import { Button } from '../../components/ui/button'

export function isGrantDerivedProposal(proposal: Proposal): boolean {
  return (
    proposal.proposal_type === 'egress_review' ||
    proposal.requires_approval_type === 'egress_granting_user' ||
    Boolean(proposal.grant_id)
  )
}

function hasGrantingUserApproval(proposal: Proposal): boolean {
  return proposal.egress_approval_status === 'approved'
}

interface EgressReviewNoticeProps {
  proposal: Proposal
  currentUserId: string
  targetSpaceName: string
  approving?: boolean
  compact?: boolean
  onApprove?: () => void
}

export function EgressReviewNotice({
  proposal,
  currentUserId,
  targetSpaceName,
  approving = false,
  compact = false,
  onApprove,
}: EgressReviewNoticeProps) {
  if (!isGrantDerivedProposal(proposal)) return null

  // A content-owner review names its approvers as a list; the single field
  // is the granting user of a grant-derived one.
  const isGrantingUser = proposal.required_approver_user_id === currentUserId
    || (proposal.required_approver_user_ids ?? []).includes(currentUserId)
  const approved = hasGrantingUserApproval(proposal)

  return (
    <div className="rounded-md border border-warning/30 bg-warning/5 p-3 space-y-2">
      <div className="flex items-start gap-2">
        <ShieldAlert className="size-4 text-warning shrink-0 mt-0.5" />
        <div className="min-w-0">
          <p className="text-sm font-medium">Personal context egress review</p>
          <p className="text-xs text-muted-foreground">
            This proposal is metadata-only. It was derived from personal context and requires the granting user's approval before any shared-content review can proceed.
          </p>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant={approved ? 'success' : 'warning'}>
          {approved ? 'granting-user approved' : 'granting-user approval required'}
        </Badge>
        {!approved && proposal.status === 'pending' && isGrantingUser && onApprove && (
          <Button type="button" size="sm" variant="success" disabled={approving} onClick={onApprove}>
            {approving ? 'Approving...' : 'Approve egress review'}
          </Button>
        )}
        {!approved && proposal.status === 'pending' && !isGrantingUser && (
          <span className="text-xs text-muted-foreground">Waiting for approval from the granting user.</span>
        )}
      </div>
      {!compact && (
        <p className="text-xs text-muted-foreground">
          This approval does not create shared content by itself. It records that the granting user allows this grant-derived output to proceed to the next shared-content review step. Actual shared artifact or memory creation requires a separate review pipeline.
        </p>
      )}
      {compact && approved && (
        <p className="text-xs text-muted-foreground">
          Approval recorded. Shared content is not created automatically.
        </p>
      )}
    </div>
  )
}
