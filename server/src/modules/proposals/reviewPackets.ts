import { randomUUID } from "node:crypto";
import type { ProposalAcceptResultType } from "@rainver/protocol";
import { assertCanReviewContextOpsPacket } from "../contextOps/reviewPolicy.js";
import type { Queryable } from "../routeUtils/common.js";
import type { ProposalApplyContext, ProposalApplyResult } from "./applierRegistry.js";
import type { ProposalRow } from "./repository.js";

/**
 * Shared plumbing for review/context-layer proposal packets.
 *
 * Every packet writer (memory maintenance, claim candidate, claim contradiction,
 * relation discovery, retrieval maintenance) writes the same 24-column
 * `proposals` row and, on accept, runs the same skeleton: validate the operation,
 * gate review through `assertCanReviewContextOpsPacket`, fan the packet into child
 * pending proposals, then mark the packet accepted with the generated child ids.
 * This module owns that one INSERT and that one accept-skeleton so the
 * positional-parameter ordering and the `canonical_write_performed` /
 * creator-only review invariants live in a single place. Each module keeps only
 * its own "payload → child drafts" mapping.
 */

export type ReviewScope = "private" | "space_ops";

export function reviewScopeValue(value: ReviewScope | undefined): ReviewScope {
  return value === "space_ops" ? "space_ops" : "private";
}

export function visibilityForReviewScope(value: ReviewScope | undefined): "private" | "space_shared" {
  return value === "space_ops" ? "space_shared" : "private";
}

export interface InsertProposalRowInput {
  id?: string;
  spaceId: string;
  proposalType: string;
  title: string;
  summary?: string | null;
  payload: unknown;
  rationale: string;
  createdByUserId: string | null;
  ownerUserId?: string | null;
  visibility: string;
  accessLevel?: "full" | "summary";
  riskLevel?: string;
  urgency?: string;
  preview?: boolean;
  status?: string;
  createdByRunId?: string | null;
  createdByAgentId?: string | null;
  projectFolderId?: string | null;
  projectId?: string | null;
  createdAt?: string;
  requiredApproverRole?: string | null;
  actionIdempotencyKey?:string|null;
}

export async function insertProposalRow(db: Queryable, input: InsertProposalRowInput): Promise<ProposalRow> {
  const id = input.id ?? randomUUID();
  const now = input.createdAt ?? new Date().toISOString();
  const result = await db.query<ProposalRow>(
    `INSERT INTO proposals (
       id, space_id, created_by_run_id, proposal_type, status, risk_level,
       urgency, preview, title, summary, payload_json, review_deadline,
       expires_at, created_at, updated_at, reviewed_at, reviewed_by,
       project_folder_id, rationale, created_by_agent_id, created_by_user_id, owner_user_id,
       required_approver_role, visibility, project_id, access_level, action_idempotency_key
     ) VALUES (
       $1, $2, $3, $4, $5, $6,
       $7, $8, $9, $10, $11::jsonb, NULL,
       NULL, $12, $12, NULL, NULL,
       $13, $14, $18, $15, $22,
       $19, $16, $17, $20, $21
     )
     RETURNING id, space_id, created_by_user_id, project_folder_id,
               created_by_run_id, proposal_type, status, risk_level, urgency,
               preview, title, payload_json, rationale, visibility,
               review_deadline, expires_at, created_at, reviewed_at,
               project_id,
               NULL::varchar AS egress_approval_id,
               NULL::varchar AS egress_approval_status`,
    [
      id,
      input.spaceId,
      input.createdByRunId ?? null,
      input.proposalType,
      input.status ?? "pending",
      input.riskLevel ?? "low",
      input.urgency ?? "normal",
      input.preview ?? false,
      input.title,
      input.summary ?? null,
      JSON.stringify(input.payload ?? {}),
      now,
      input.projectFolderId ?? null,
      input.rationale,
      input.createdByUserId,
      input.visibility,
      input.projectId ?? null,
      input.createdByAgentId ?? null,
      input.requiredApproverRole ?? null,
      input.accessLevel ?? "full",
      input.actionIdempotencyKey??null,
      input.ownerUserId === undefined ? input.createdByUserId : input.ownerUserId,
    ],
  );
  return result.rows[0]!;
}

/**
 * Look up an existing pending packet proposal by lineage_key.
 * Returns the existing proposal id if found, null otherwise.
 *
 * Packet generators embed a deterministic `lineage_key` in their payload so
 * callers can skip creation when equivalent work is already pending review.
 */
export async function lookupExistingPendingPacket(
  db: Queryable,
  spaceId: string,
  proposalType: string,
  lineageKey: string,
): Promise<string | null> {
  const result = await db.query<{ id: string }>(
    `SELECT id FROM proposals
      WHERE space_id = $1
        AND proposal_type = $2
        AND payload_json->>'lineage_key' = $3
        AND status = 'pending'
      LIMIT 1`,
    [spaceId, proposalType, lineageKey],
  );
  return result.rows[0]?.id ?? null;
}

export interface ChildProposalDraft {
  id?: string;
  proposalType: string;
  title: string;
  summary?: string | null;
  payload: Record<string, unknown>;
  rationale: string;
  visibility?: string;
  projectFolderId?: string | null;
  projectId?: string | null;
  riskLevel?: string;
}

/** Insert one child proposal generated from an accepted packet. */
export async function insertChildProposalRow(
  context: ProposalApplyContext,
  draft: ChildProposalDraft,
): Promise<string> {
  const row = await insertProposalRow(context.db, {
    id: draft.id,
    spaceId: context.proposal.space_id,
    proposalType: draft.proposalType,
    title: draft.title,
    summary: draft.summary ?? null,
    payload: draft.payload,
    rationale: draft.rationale,
    createdByUserId: context.proposal.created_by_user_id ?? context.userId,
    visibility: draft.visibility ?? "private",
    riskLevel: draft.riskLevel ?? "medium",
    projectFolderId: draft.projectFolderId ?? null,
    projectId: draft.projectId ?? null,
  });
  return row.id;
}

export interface AcceptReviewPacketBuild {
  children: ChildProposalDraft[];
  /** Optional per-candidate skip records (claim/relation packets track these). */
  skipped?: Record<string, unknown>[];
  /** Extra keys merged into the accepted packet's stored payload. */
  finalPayloadExtra?: Record<string, unknown>;
  /** Extra keys merged into the apply result. */
  resultExtra?: Record<string, unknown>;
}

export interface AcceptReviewPacketOptions {
  expectedOperation: string;
  resultType: ProposalAcceptResultType;
  privateMessage: string;
  invalidPayload: () => Error;
  build: (
    payload: Record<string, unknown>,
    context: ProposalApplyContext,
  ) => Promise<AcceptReviewPacketBuild> | AcceptReviewPacketBuild;
}

/**
 * Run the shared packet-accept skeleton: validate operation, enforce the
 * creator-only / `space_ops` review gate, create the child proposals the caller's
 * `build` produced, and mark the packet accepted. Never writes canonical rows.
 */
export async function acceptReviewPacket(
  context: ProposalApplyContext,
  options: AcceptReviewPacketOptions,
): Promise<ProposalApplyResult> {
  const payload = context.proposal.payload_json ?? {};
  if (payload.operation !== options.expectedOperation) throw options.invalidPayload();
  await assertCanReviewContextOpsPacket(context.db, context.proposal, context.userId, options.privateMessage);

  const built = await options.build(payload, context);
  const childProposalIds: string[] = [];
  for (const child of built.children) {
    childProposalIds.push(await insertChildProposalRow(context, child));
  }

  const now = new Date().toISOString();
  const skipped = built.skipped;
  const proposalPayloadPatch = {
    ...payload,
    generated_child_proposal_ids: childProposalIds,
    generated_child_proposal_count: childProposalIds.length,
    accepted_by_user_id: context.userId,
    accepted_at: now,
    ...(skipped
      ? { skipped_child_proposal_count: skipped.length, skipped_child_proposals: skipped }
      : {}),
    ...(built.finalPayloadExtra ?? {}),
  };

  return {
    result_type: options.resultType,
    result: {
      generated_child_proposal_ids: childProposalIds,
      generated_child_proposal_count: childProposalIds.length,
      ...(skipped ? { skipped_child_proposal_count: skipped.length } : {}),
      ...(built.resultExtra ?? {}),
    },
    proposalPayloadPatch,
  };
}
