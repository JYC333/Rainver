/**
 * Durable policy audit writer.
 *
 * Writes a single `policy_decision_records` row in its own statement,
 * independent of any business transaction.
 *
 * The envelope is already sanitized (`buildAuditEnvelope` →
 * `sanitizePolicyMetadata`); this writer performs no further redaction.
 */

import { getDbPool } from "../../db/pool.js";

import type { PolicyAuditEnvelope } from "@rainver/protocol";

export class PolicyAuditPersistError extends Error {
  readonly action: string;
  readonly actorId: string | null;
  constructor(action: string, actorId: string | null) {
    super(`PolicyAuditPersistError: durable audit write failed for ${action}`);
    this.action = action;
    this.actorId = actorId ?? null;
    this.name = "PolicyAuditPersistError";
  }
}

const INSERT_SQL = `
  INSERT INTO policy_decision_records (
    id, space_id, actor_type, actor_id, actor_ref_json, action,
    resource_type, resource_id, decision, risk_level, required_approver_role,
    approval_capability, policy_rule_id, policy_source, policy_id, audit_code,
    run_id, proposal_id, metadata_json, created_at
  ) VALUES (
    gen_random_uuid(), $1, $2, $3, $4, $5,
    $6, $7, $8, $9, $10,
    $11, $12, $13, $14, $15,
    $16, $17, $18, $19
  )
  RETURNING id
`;

/**
 * Persist one audit record. Resolves on success; throws on failure so the
 * caller can apply the fail-closed / best-effort policy. Does not decide the
 * failure mode itself.
 */
export async function writePolicyAudit(
  databaseUrl: string,
  env: PolicyAuditEnvelope,
): Promise<string> {
  const pool = getDbPool(databaseUrl);
  const result = await pool.query<{ id: string }>(INSERT_SQL, [
    env.space_id ?? null,
    env.actor_type ?? null,
    env.actor_id ?? null,
    env.actor_ref_json ?? null,
    env.action,
    env.resource_type ?? null,
    env.resource_id ?? null,
    env.decision,
    env.risk_level,
    env.required_approver_role ?? null,
    env.approval_capability ?? null,
    env.policy_rule_id ?? null,
    env.policy_source ?? null,
    env.policy_id ?? null,
    env.audit_code ?? null,
    env.run_id ?? null,
    env.proposal_id ?? null,
    env.metadata_json ?? null,
    env.created_at,
  ]);
  const row = result.rows[0];
  if (!row) {
    throw new PolicyAuditPersistError(env.action, env.actor_id ?? null);
  }
  return row.id;
}
