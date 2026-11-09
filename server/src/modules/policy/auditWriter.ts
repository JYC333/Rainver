import type {Queryable} from "../routeUtils/common.js";
/**
 * Durable policy audit writer.
 *
 * Writes one sanitized policy decision, either independently or through the
 * explicit transaction port. Transaction owners can recover rolled-back audits.
 *
 * The envelope is already sanitized (`buildAuditEnvelope` →
 * `sanitizePolicyMetadata`); this writer performs no further redaction.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { getOperationAuditPool, getDbPool } from "../../db/pool.js";

import type { PolicyAuditEnvelope } from "@rainver/protocol";

interface AuditAttempt { envelope: PolicyAuditEnvelope; id: string | null }
const rollbackAudits = new AsyncLocalStorage<AuditAttempt[]>();
export function isPolicyAuditRecoveryActive(): boolean {
  return rollbackAudits.getStore() !== undefined;
}
/** Wrap the transaction owner, so recovery runs only after rollback/release.
 * Check recorded ids first: a lost COMMIT response must not duplicate a committed audit.
 * No business input/output or original exception text is added to recovery metadata.
 */
export async function withPolicyAuditRecovery<T>(databaseUrl: string | null | undefined, work: () => Promise<T>): Promise<T> {
  if (!databaseUrl || rollbackAudits.getStore()) return work();
  const attempts: AuditAttempt[] = [];
  try {
    return await rollbackAudits.run(attempts, work);
  } catch (error) {
    for (const attempt of attempts) {
      try {
        const audit = getOperationAuditPool(databaseUrl);
        if (attempt.id && (await audit.query('SELECT id FROM policy_decision_records WHERE id=$1', [attempt.id])).rows.length) continue;
        await writePolicyAudit(databaseUrl, {...attempt.envelope, metadata_json: {
          ...attempt.envelope.metadata_json, operation_outcome: 'failed'
        }}, audit, attempt.id ?? undefined);
      } catch { /* Denial/failure remains authoritative if recovery storage is unavailable. */ }
    }
    throw error;
  }
}

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
    COALESCE($20::varchar(36), gen_random_uuid()::text), $1, $2, $3, $4, $5,
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
  transaction?: Queryable,
  recoveryRecordId?: string,
): Promise<string> {
  const pool = transaction ?? getDbPool(databaseUrl);
  const attempt = transaction && rollbackAudits.getStore() ? {envelope: structuredClone(env), id: null as string | null} : null;
  if (attempt) rollbackAudits.getStore()!.push(attempt);
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
    recoveryRecordId ?? null,
  ]);
  const row = result.rows[0];
  if (!row) {
    throw new PolicyAuditPersistError(env.action, env.actor_id ?? null);
  }
  if (attempt) attempt.id = row.id;
  return row.id;
}
