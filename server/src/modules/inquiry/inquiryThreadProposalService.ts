import type { ServerConfig } from "../../config";
import { getDbPool } from "../../db/pool";
import { inheritContentAccessGrants } from "../access/contentAccessInheritance";
import { assertProjectWriter } from "../projects/access";
import { insertProposalRow } from "../proposals/reviewPackets";
import {
  HttpError,
  optionalString,
  requiredString,
  withQueryableTransaction,
  type Queryable,
  type SpaceUserIdentity,
} from "../routeUtils/common";

export interface InquiryThreadProposalActor {
  agentId?: string | null;
  runId?: string | null;
  idempotencyKey?: string | null;
  visibility?: "private" | "space_shared" | "selected_users";
}

/** Drafts a new Inquiry Thread without granting the Agent direct write authority. */
export class InquiryThreadProposalService {
  constructor(private readonly db: Queryable) {}

  static fromConfig(config: ServerConfig): InquiryThreadProposalService {
    if (!config.databaseUrl) throw new HttpError(502, "SERVER_DATABASE_URL is required");
    return new InquiryThreadProposalService(getDbPool(config.databaseUrl));
  }

  async proposeThread(
    identity: SpaceUserIdentity,
    projectId: string,
    body: Record<string, unknown>,
    actor: InquiryThreadProposalActor = {},
  ): Promise<{ proposal: Record<string, unknown> }> {
    await assertProjectWriter(this.db, identity.spaceId, projectId, identity.userId);
    const kind = optionalString(body.kind) ?? "question";
    if (kind !== "question" && kind !== "hypothesis") {
      throw new HttpError(422, "kind must be question or hypothesis");
    }
    const statement = requiredString(body.statement, "statement");

    if (actor.runId && actor.idempotencyKey) {
      const existing = await this.db.query<{ id: string; status: string }>(
        `SELECT id, status FROM proposals
          WHERE space_id=$1 AND created_by_run_id=$2
            AND proposal_type='inquiry_thread_create' AND action_idempotency_key=$3`,
        [identity.spaceId, actor.runId, actor.idempotencyKey],
      );
      if (existing.rows[0]) return { proposal: existing.rows[0] };
    }

    if (actor.runId) {
      const continuation = await this.db.query<{ proposal_id: string }>(
        `SELECT accepted.id AS proposal_id
           FROM runs continuation_run
           JOIN agent_run_groups run_group
             ON run_group.space_id = continuation_run.space_id
            AND run_group.id = continuation_run.run_group_id
           JOIN messages trigger_message
             ON trigger_message.space_id = run_group.space_id
            AND trigger_message.id = run_group.trigger_message_id
           JOIN proposals accepted
             ON accepted.space_id = trigger_message.space_id
            AND accepted.id = trigger_message.metadata_json->>'continuation_proposal_id'
          WHERE continuation_run.space_id = $1
            AND continuation_run.id = $2
            AND accepted.proposal_type = 'inquiry_thread_create'
            AND accepted.status = 'accepted'
          LIMIT 1`,
        [identity.spaceId, actor.runId],
      );
      if (continuation.rows[0]) {
        throw new HttpError(
          409,
          "Accepting an Inquiry question cannot create another question; continue the accepted question instead",
        );
      }
    }

    const payload: Record<string, unknown> = {
      proposal_type: "inquiry_thread_create",
      action_id: "inquiry.propose_thread",
      project_id: projectId,
      kind,
      statement,
      ...(optionalString(body.answerability) ? { answerability: optionalString(body.answerability) } : {}),
      ...(optionalString(body.resolution_criteria) ? { resolution_criteria: optionalString(body.resolution_criteria) } : {}),
      ...(optionalString(body.proposed_claim) ? { proposed_claim: optionalString(body.proposed_claim) } : {}),
      ...(optionalString(body.predictions) ? { predictions: optionalString(body.predictions) } : {}),
      ...(optionalString(body.falsification_criteria) ? { falsification_criteria: optionalString(body.falsification_criteria) } : {}),
    };
    const visibility = actor.visibility ?? "space_shared";
    const normalizedStatement = statement.trim().toLocaleLowerCase().replace(/\s+/gu, " ");
    const proposal = await withQueryableTransaction(this.db, async (db) => {
      if (actor.agentId) {
        // A retried or re-planned decomposition run must not spawn a second
        // pending Proposal for the same question. Coalesce on (project,
        // agent, normalized statement) rather than exact tool-call identity,
        // so this holds even when the model does not reuse an idempotency
        // key across attempts.
        await db.query(
          "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
          [`inquiry-thread-propose:${identity.spaceId}:${projectId}:${normalizedStatement}`],
        );
        const existing = await db.query<Record<string, unknown> & { id: string }>(
          `SELECT id, space_id, created_by_user_id, project_folder_id,
                  created_by_run_id, proposal_type, status, risk_level, urgency,
                  preview, title, payload_json, rationale, visibility,
                  review_deadline, expires_at, created_at, reviewed_at, project_id
             FROM proposals
            WHERE space_id=$1 AND project_id=$2 AND proposal_type='inquiry_thread_create'
              AND status='pending' AND created_by_agent_id=$3
              AND lower(trim(regexp_replace(payload_json->>'statement', '\\s+', ' ', 'g')))=$4`,
          [identity.spaceId, projectId, actor.agentId, normalizedStatement],
        );
        if (existing.rows[0]) return existing.rows[0];
      }
      const inserted = await insertProposalRow(db, {
        spaceId: identity.spaceId,
        proposalType: "inquiry_thread_create",
        title: `Create research ${kind}: ${statement}`,
        payload,
        rationale: "Agent-drafted Inquiry Thread from a Room conversation, pending review.",
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
