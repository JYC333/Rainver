import type { ProposalRow } from './repository.js';
import { insertProposalRow } from './reviewPackets.js';
import { inheritContentAccessGrants } from '../access/contentAccessInheritance.js';
import { OperationError } from '../systemActions/operations/errors.js';
import type { lockProposalTransitions } from '../systemActions/operations/proposalTransitions.js';
import type { Queryable } from '../routeUtils/common.js';

type Transitions = Awaited<ReturnType<typeof lockProposalTransitions>>;
type RevisionRow = Omit<ProposalRow, 'access_level'> & {
  access_level: 'full' | 'summary';
  summary: string | null;
  created_by_agent_id: string | null;
  required_approver_role: string | null;
  pending_operation_key: string | null;
};

/**
 * Unlinked drafts retain editing in place. A linked frozen request instead gets
 * a fresh review: no original payload, frozen evidence or approvals are reused.
 * The owner pre-admits every key before domain locks and revalidates authority.
 */
export async function revisePendingPayload(
  db: Queryable,
  transitions: Transitions,
  spaceId: string,
  id: string,
  payload: Record<string, unknown>,
): Promise<string> {
  transitions.assertCovered([id]);
  const old = (await db.query<RevisionRow>(
    "SELECT * FROM proposals WHERE id=$1 AND space_id=$2 AND status='pending'",
    [id, spaceId],
  )).rows[0];
  if (!old) throw new OperationError('operation_conflict', 409);
  if (!transitions.hasLinked(id)) {
    await db.query('UPDATE proposals SET payload_json=$3::jsonb,updated_at=now() WHERE id=$1 AND space_id=$2',
      [id, spaceId, JSON.stringify(payload)]);
    await transitions.finish();
    return id;
  }

  await db.query("UPDATE proposals SET status='superseded',updated_at=now() WHERE id=$1 AND space_id=$2 AND status='pending'", [id, spaceId]);
  const next = await insertProposalRow(db, {
    spaceId, proposalType: old.proposal_type, title: old.title, summary: old.summary,
    payload, rationale: old.rationale ?? 'Revised pending proposal',
    createdByUserId: old.created_by_user_id, ownerUserId: old.owner_user_id,
    createdByAgentId: old.created_by_agent_id, createdByRunId: old.created_by_run_id,
    projectId: old.project_id, projectFolderId: old.project_folder_id,
    visibility: old.visibility, accessLevel: old.access_level,
    riskLevel: old.risk_level, urgency: old.urgency, preview: old.preview,
    requiredApproverRole: old.required_approver_role,
    pendingOperationKey: old.pending_operation_key,
    reviewDeadline: old.review_deadline, expiresAt: old.expires_at,
    // The original run/call identity stays on its historical draft. The new
    // review has no linked operation receipt or inherited human approvals.
    actionIdempotencyKey: null,
  });
  await inheritContentAccessGrants(db, {
    spaceId, sourceResourceType: 'proposal', sourceResourceId: id,
    targetResourceType: 'proposal', targetResourceId: next.id,
    inheritedAt: new Date().toISOString(),
  });
  await transitions.finish();
  return next.id;
}
