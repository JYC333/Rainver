import type { ServerConfig } from "../../config.js";
import {
  HttpError,
  requiredString,
  withQueryableTransaction,
  type Queryable,
  type SpaceUserIdentity,
} from "../routeUtils/common.js";
import { getDbPool } from "../../db/pool.js";
import { assertProjectWriter } from "../projects/access.js";
import { insertProposalRow } from "../proposals/reviewPackets.js";
import { inheritContentAccessGrants } from "../access/contentAccessInheritance.js";
import { THREAD_COLUMNS, THREAD_FROM, type ThreadRow } from "./threadService.js";

export interface InquiryConclusionProposalActor {
  agentId?: string | null;
  runId?: string | null;
  idempotencyKey?: string | null;
  visibility?: "private" | "space_shared" | "selected_users";
}

/**
 * Drafts an Inquiry Thread conclusion as a reviewable Proposal (plan:
 * `.agent/plans/project-conversational-advancement-plan.md`, Phase A). The
 * agent supplies the drafted cognitive-field changes as tool-call arguments;
 * this service only checks the Thread exists and is active, then stores the
 * draft. Deep validation (protected-field shape, no-op rejection, next-focus
 * enum) stays in `InquiryIterationService.recordIteration`, which the
 * `inquiry_conclusion` applier calls at accept time under the accepting
 * user's identity — matching how a direct user edit already writes an
 * Iteration; a conversational draft is a second legitimate trigger for the
 * same write authority, not a bypass of it (see `trigger_kind`).
 */
export class InquiryConclusionProposalService {
  constructor(private readonly db: Queryable) {}

  static fromConfig(config: ServerConfig): InquiryConclusionProposalService {
    if (!config.databaseUrl) throw new HttpError(502, "SERVER_DATABASE_URL is required");
    return new InquiryConclusionProposalService(getDbPool(config.databaseUrl));
  }

  async proposeConclusion(
    identity: SpaceUserIdentity,
    projectId: string,
    body: Record<string, unknown>,
    actor: InquiryConclusionProposalActor = {},
  ): Promise<{ proposal: Record<string, unknown> }> {
    await assertProjectWriter(this.db, identity.spaceId, projectId, identity.userId);
    const threadId = requiredString(body.thread_id, "thread_id");
    const changeSummary = requiredString(body.change_summary, "change_summary");

    if (actor.runId && actor.idempotencyKey) {
      const existing = await this.db.query<{ id: string; status: string }>(
        `SELECT id, status FROM proposals
          WHERE space_id=$1 AND created_by_run_id=$2
            AND proposal_type='inquiry_conclusion' AND action_idempotency_key=$3`,
        [identity.spaceId, actor.runId, actor.idempotencyKey],
      );
      if (existing.rows[0]) return { proposal: existing.rows[0] };
    }

    const thread = await this.db.query<ThreadRow>(
      `SELECT ${THREAD_COLUMNS} FROM ${THREAD_FROM}
        WHERE t.object_id = $1 AND t.space_id = $2 AND t.project_id = $3`,
      [threadId, identity.spaceId, projectId],
    );
    const row = thread.rows[0];
    if (!row) throw new HttpError(404, "Thread not found");
    if (row.lifecycle_status !== "active") {
      throw new HttpError(409, "Only an active Thread can be proposed a conclusion");
    }

    const { thread_id: _threadId, change_summary: _changeSummary, ...draftFields } = body;
    const payload: Record<string, unknown> = {
      proposal_type: "inquiry_conclusion",
      action_id: "inquiry.record_conclusion",
      thread_id: threadId,
      change_summary: changeSummary,
      ...draftFields,
    };

    const visibility = actor.visibility ?? "space_shared";
    const proposal = await withQueryableTransaction(this.db, async (db) => {
      if (actor.agentId) {
        // A Thread has one conclusion draft in flight at a time; a retried
        // or re-planned run must reuse it, not spawn a sibling.
        await db.query(
          "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
          [`inquiry-conclusion-propose:${identity.spaceId}:${threadId}`],
        );
        const existing = await db.query<Record<string, unknown> & { id: string }>(
          `SELECT id, space_id, created_by_user_id, project_folder_id,
                  created_by_run_id, proposal_type, status, risk_level, urgency,
                  preview, title, payload_json, rationale, visibility,
                  review_deadline, expires_at, created_at, reviewed_at, project_id
             FROM proposals
            WHERE space_id=$1 AND project_id=$2 AND proposal_type='inquiry_conclusion'
              AND status='pending' AND created_by_agent_id=$3
              AND payload_json->>'thread_id'=$4`,
          [identity.spaceId, projectId, actor.agentId, threadId],
        );
        if (existing.rows[0]) return existing.rows[0];
      }
      const inserted = await insertProposalRow(db, {
        spaceId: identity.spaceId,
        proposalType: "inquiry_conclusion",
        title: `Record conclusion: ${row.statement}`,
        payload,
        rationale: "Agent-drafted Inquiry Thread conclusion from a Room conversation, pending review.",
        createdByUserId: actor.agentId ? null : identity.userId,
        ownerUserId: identity.userId,
        createdByAgentId: actor.agentId ?? null,
        createdByRunId: actor.runId ?? null,
        actionIdempotencyKey: actor.idempotencyKey ?? null,
        projectId,
        visibility,
        riskLevel: "medium",
      });
      if (visibility === "selected_users" && actor.runId) {
        await inheritContentAccessGrants(db, {
          spaceId: identity.spaceId,
          sourceResourceType: "run",
          sourceResourceId: actor.runId,
          targetResourceType: "proposal",
          targetResourceId: inserted.id,
          inheritedAt: new Date().toISOString(),
        });
      }
      return inserted;
    });
    return { proposal: proposal as unknown as Record<string, unknown> };
  }
}
