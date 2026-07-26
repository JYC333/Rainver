import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "../../db/pool";
import type { ServerConfig } from "../../config";
import { HttpError, type Queryable } from "../routeUtils/common";
import { ActionApprovalGrantService } from "./actionApprovalGrantService";
import { redactEvidenceText } from "../runs/evidenceRedaction";
import { PgJobQueueRepository } from "../jobs/repository";

interface DecisionRow {
  id: string;
  space_id: string;
  run_id: string | null;
  actor_type: string | null;
  actor_id: string | null;
  action: string;
  resource_type: string | null;
  resource_id: string | null;
  decision: string;
  policy_rule_id: string | null;
  policy_source: string | null;
  metadata_json: Record<string, unknown> | null;
}

interface RunRow {
  id: string;
  space_id: string;
  agent_id: string;
  instructed_by_user_id: string | null;
  project_id: string | null;
}

export interface AuthorizationRequestOut {
  id: string;
  space_id: string;
  run_id: string;
  agent_id: string;
  instructed_by_user_id: string;
  policy_decision_record_id: string;
  action_id: string;
  policy_action: string;
  project_id: string | null;
  resource_kind: string | null;
  resource_id: string | null;
  reason: string;
  status: "pending" | "approved" | "rejected";
  resulting_action_grant_id: string | null;
  decided_by_user_id: string | null;
  requested_at: string;
  decided_at: string | null;
}

const REQUEST_COLUMNS = `
  id, space_id, run_id, agent_id, instructed_by_user_id,
  policy_decision_record_id, action_id, policy_action,
  project_id, resource_kind, resource_id, reason, status,
  resulting_action_grant_id, decided_by_user_id, requested_at, decided_at
`;

/**
 * Converts only an audited, same-Run denial into a bounded human request.
 * Only registry actions explicitly marked grantable may cross this boundary.
 */
export class AuthorizationRequestService {
  constructor(
    private readonly db: Pool,
    private readonly config: Pick<ServerConfig, "databaseUrl">,
  ) {}

  async createFromDeniedDecision(input: {
    spaceId: string;
    runId: string;
    agentId: string;
    policyDecisionRecordId: string;
    reason: string;
  }): Promise<AuthorizationRequestOut> {
    const reason = redactEvidenceText(input.reason.trim()) ?? "";
    if (!reason || reason.length > 1000) throw new HttpError(422, "reason must contain 1 to 1000 characters");
    const client = await this.db.connect();
    try {
      await client.query("BEGIN");
      const decisionResult = await client.query<DecisionRow>(
        `SELECT id, space_id, run_id, actor_type, actor_id, action,
                resource_type, resource_id, decision,
                policy_rule_id, policy_source, metadata_json
           FROM policy_decision_records
          WHERE id = $1 AND space_id = $2 AND run_id = $3
          LIMIT 1`,
        [input.policyDecisionRecordId, input.spaceId, input.runId],
      );
      const runResult = await client.query<RunRow>(
        `SELECT id, space_id, agent_id, instructed_by_user_id, project_id
           FROM runs
          WHERE id = $1 AND space_id = $2 AND agent_id = $3
            AND status = 'running'
          LIMIT 1`,
        [input.runId, input.spaceId, input.agentId],
      );
      const decision = decisionResult.rows[0];
      const run = runResult.rows[0];
      if (!decision || !run) throw new HttpError(404, "Denied policy decision not found for an active Run");
      if (decision.decision !== "deny") throw new HttpError(409, "Only denied decisions can raise an authorization request");
      if (decision.actor_type !== "agent" || decision.actor_id !== input.agentId) {
        throw new HttpError(403, "Denied policy decision does not belong to this Run Agent");
      }
      if (!run.instructed_by_user_id) throw new HttpError(409, "Run has no instructing user who can review authorization");

      const requestClass = await classifyRequestableDecision(decision);
      if (!requestClass) {
        throw new HttpError(403, "This denial is a hard authorization boundary and cannot be requested");
      }
      const now = new Date().toISOString();
      const id = randomUUID();
      const inserted = await client.query<AuthorizationRequestOut>(
      `INSERT INTO authorization_requests (
         id, space_id, run_id, agent_id, instructed_by_user_id,
         policy_decision_record_id, action_id, policy_action,
         project_id, resource_kind, resource_id, reason, status, requested_at
       ) VALUES (
         $1, $2, $3, $4, $5,
         $6, $7, $8,
         $9, $10, $11, $12, 'pending', $13
       )
       ON CONFLICT (space_id, policy_decision_record_id) DO UPDATE
         SET reason = authorization_requests.reason
       RETURNING ${REQUEST_COLUMNS}`,
      [
        id,
        input.spaceId,
        input.runId,
        input.agentId,
        run.instructed_by_user_id,
        decision.id,
        requestClass.actionId,
        decision.action,
        run.project_id,
        decision.resource_type,
        decision.resource_id,
        reason,
        now,
      ],
      );
      const request = inserted.rows[0]!;
      if (request.status !== "pending") {
        throw new HttpError(409, "This denied decision already has a completed authorization request");
      }
      const paused = await client.query(
        `WITH updated AS (
           UPDATE runs
              SET status = 'waiting_for_review',
                  error_json = jsonb_build_object(
                    'error_code', 'authorization_request_pending',
                    'authorization_request_id', $3::text
                  ),
                  error_message = 'Agent authorization request is pending review.',
                  updated_at = $4
            WHERE id = $1 AND space_id = $2 AND status = 'running'
            RETURNING id, space_id
         )
         UPDATE run_attempts attempt
            SET status = 'waiting_for_review',
                error_code = 'authorization_request_pending',
                error_json = jsonb_build_object(
                  'error_code', 'authorization_request_pending',
                  'authorization_request_id', $3::text
                ),
                last_activity_at = $4,
                updated_at = $4
           FROM updated
          WHERE attempt.run_id = updated.id
            AND attempt.space_id = updated.space_id
            AND attempt.status = 'running'
            AND attempt.attempt_number = (
              SELECT max(candidate.attempt_number)
                FROM run_attempts candidate
               WHERE candidate.run_id = updated.id
                 AND candidate.space_id = updated.space_id
            )
         RETURNING updated.id`,
        [input.runId, input.spaceId, request.id, now],
      );
      if (!paused.rows[0]) throw new HttpError(409, "Run could not be paused for authorization review");
      await client.query("COMMIT");
      return request;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async listForRun(identity: { spaceId: string; userId: string }, runId: string): Promise<AuthorizationRequestOut[]> {
    const result = await this.db.query<AuthorizationRequestOut>(
      `SELECT ${REQUEST_COLUMNS}
         FROM authorization_requests ar
        WHERE ar.space_id = $1
          AND ar.run_id = $2
          AND (
            ar.instructed_by_user_id = $3
            OR EXISTS (
              SELECT 1 FROM space_memberships sm
               WHERE sm.space_id = ar.space_id
                 AND sm.user_id = $3
                 AND sm.status = 'active'
                 AND sm.role = 'owner'
            )
          )
        ORDER BY ar.requested_at ASC, ar.id ASC`,
      [identity.spaceId, runId, identity.userId],
    );
    return result.rows;
  }

  async decide(
    identity: { spaceId: string; userId: string },
    requestId: string,
    decision: "approved" | "rejected",
  ): Promise<AuthorizationRequestOut> {
    const client = await this.db.connect();
    try {
      await client.query("BEGIN");
      const locked = await client.query<AuthorizationRequestOut>(
        `SELECT ${REQUEST_COLUMNS}
           FROM authorization_requests
          WHERE id = $1 AND space_id = $2
          FOR UPDATE`,
        [requestId, identity.spaceId],
      );
      const request = locked.rows[0];
      if (!request) throw new HttpError(404, "Authorization request not found");
      if (request.status !== "pending") throw new HttpError(409, "Authorization request has already been decided");

      let grantId: string | null = null;
      if (decision === "approved") {
        grantId = await this.createGrant(client, identity, request);
      } else {
        await this.assertMayReview(client, identity, request);
      }
      const now = new Date().toISOString();
      const updated = await client.query<AuthorizationRequestOut>(
        `UPDATE authorization_requests
            SET status = $3,
                resulting_action_grant_id = $4,
                decided_by_user_id = $5,
                decided_at = $6
          WHERE id = $1 AND space_id = $2 AND status = 'pending'
          RETURNING ${REQUEST_COLUMNS}`,
        [requestId, identity.spaceId, decision, grantId, identity.userId, now],
      );
      if (!updated.rows[0]) throw new HttpError(409, "Authorization request has already been decided");
      const decided = updated.rows[0];
      await new PgJobQueueRepository(client).enqueue({
        job_type: "authorization_request_reconcile",
        space_id: request.space_id,
        user_id: identity.userId,
        agent_id: request.agent_id,
        payload: {
          authorization_request_id: request.id,
          run_id: request.run_id,
        },
        // The Run lock is released by the execution that surfaced this
        // request. A high durable retry ceiling also covers worker death until
        // the normal stale-lock reclaimer has run.
        max_attempts: 900,
      });
      await client.query("COMMIT");
      return decided;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  private async createGrant(
    client: PoolClient,
    identity: { spaceId: string; userId: string },
    request: AuthorizationRequestOut,
  ): Promise<string> {
    await this.assertMayReview(client, identity, request);
    const grant = await new ActionApprovalGrantService(client).create(this.config, identity, {
      agent_id: request.agent_id,
      action_id: request.action_id,
      target_run_id: request.run_id,
      max_uses: 1,
      expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    }, { authorization_request_id: request.id, run_id: request.run_id });
    return String((grant as { id: unknown }).id);
  }

  private async assertMayReview(
    db: Queryable,
    identity: { spaceId: string; userId: string },
    request: AuthorizationRequestOut,
  ): Promise<void> {
    const owner = await db.query(
      `SELECT 1 FROM space_memberships
        WHERE space_id = $1 AND user_id = $2 AND status = 'active' AND role = 'owner'
        LIMIT 1`,
      [identity.spaceId, identity.userId],
    );
    if (!owner.rows[0]) throw new HttpError(403, "Space owner access required");
  }
}

export async function classifyRequestableDecision(
  decision: DecisionRow,
): Promise<{ actionId: string } | null> {
  if (
    decision.policy_source === "hard_invariant"
    || decision.policy_rule_id !== "managed_system_action_grant_required"
  ) return null;
  const metadataActionId = stringValue(decision.metadata_json?.action_id)
    ?? stringValue(decision.metadata_json?.tool_name);
  if (
    !metadataActionId
    || decision.metadata_json?.surface !== "managed_run_system_action_gateway"
  ) return null;
  const { SYSTEM_ACTION_REGISTRY } = await import("@agent-space/protocol");
  const definition = SYSTEM_ACTION_REGISTRY.find(
    (candidate) =>
      candidate.grantable
      && candidate.policy_action === decision.action
      && candidate.id === metadataActionId,
  );
  return definition ? { actionId: definition.id } : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}
