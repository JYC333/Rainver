import {lockRunProposalAttachment} from './proposalTransitions.js';
import { createHash, randomUUID } from 'node:crypto';
import type { OperationActor, OperationOutcome } from '@rainver/protocol';
import type { Queryable } from '../../routeUtils/common.js';
import { OperationError } from './errors.js';
export function canonical(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`).join(',')}}`;
  throw new OperationError('operation_invalid_input', 422);
}
export function fingerprint(version: number, input: unknown, targets: unknown): string {
  return createHash('sha256').update(canonical({
    encoding: 1,
    version,
    input,
    targets
  })).digest('hex');
}
export interface RequestRow {
  id: string;
  space_id: string;
  operation_id: string;
  operation_version: number;
  fingerprint: string;
  state: string;
  proposal_id: string | null;
  result_json: OperationOutcome | null;
  http_status: number | null;
  terminal_at: string | null;
  frozen_json: unknown;
}
export function requestScope(actor: OperationActor, authority: string, operation: string, key: string): string[] {
  return [actor.space_id, actor.principal.kind, actor.principal.id, actor.on_behalf_of_user_id === null ? 'null' : `user:${actor.on_behalf_of_user_id}`, authority, operation, key];
}
export async function lockRequestKey(db: Queryable, scope: readonly string[]): Promise<void> {
  const digest = createHash('sha256').update(canonical(scope)).digest();
  const lock = await db.query<{
    locked: boolean;
  }>('SELECT pg_try_advisory_xact_lock($1::integer,$2::integer) AS locked', [digest.readInt32BE(0), digest.readInt32BE(4)]);
  if (!lock.rows[0]?.locked) throw new OperationError('idempotency_in_progress', 409, true);
}
export async function reserve(db: Queryable, scope: string[]): Promise<RequestRow | null> {
  await lockRequestKey(db,scope);
  const candidate = (await db.query<RequestRow>('SELECT * FROM operation_idempotency WHERE space_id=$1 AND principal_kind=$2 AND principal_id=$3 AND on_behalf=$4 AND authority_scope_id=$5 AND operation_id=$6 AND idempotency_key=$7', scope)).rows[0];
  if (!candidate) return null;
  if (candidate.proposal_id) await db.query('SELECT id FROM proposals WHERE id=$1 AND space_id=$2 FOR UPDATE', [candidate.proposal_id, scope[0]]);
  return (await db.query<RequestRow>('SELECT * FROM operation_idempotency WHERE id=$1 FOR UPDATE', [candidate.id])).rows[0] ?? null;
}
export async function record(db: Queryable, scope: string[], version: number, hash: string, state: string, body: OperationOutcome | null, status: number, proposalId: string | null = null, frozen: unknown = null): Promise<string> {
  if(state==='pending_approval'){
    const attachment=(await db.query<{created_by_run_id:string|null}>('SELECT created_by_run_id FROM proposals WHERE id=$1 AND space_id=$2',[proposalId,scope[0]])).rows[0];
    if(attachment?.created_by_run_id)await lockRunProposalAttachment(db,scope[0]!,attachment.created_by_run_id);
    const proposal=(await db.query<{status:string;payload_json:unknown;expired:boolean}>(`SELECT status,payload_json,(expires_at IS NOT NULL AND expires_at<=now()) AS expired
      FROM proposals WHERE id=$1 AND space_id=$2 FOR UPDATE`,[proposalId,scope[0]])).rows[0];
    if(!proposal || proposal.status!=='pending' || proposal.expired)throw new OperationError('operation_conflict',409);
    if(!frozen || typeof frozen!=='object' || !Object.hasOwn(frozen,'payload'))throw new OperationError('operation_approval_state_inconsistent',503);
    if(canonical(proposal.payload_json)!==canonical((frozen as {payload:unknown}).payload))throw new OperationError('operation_approval_state_inconsistent',503);
  }
  const id = randomUUID();
  await db.query(`INSERT INTO operation_idempotency(id,space_id,principal_kind,principal_id,on_behalf,authority_scope_id,operation_id,idempotency_key,operation_version,fingerprint,state,result_json,http_status,proposal_id,frozen_json,created_at,terminal_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13,$14,$15::jsonb,now(),CASE WHEN $11::varchar='pending_approval' THEN NULL ELSE now() END)`, [id, ...scope, version, hash, state, JSON.stringify(body), status, proposalId, JSON.stringify(frozen)]);
  return id;
}
export async function reconcile(db: Queryable, row: RequestRow): Promise<RequestRow> {
  if (row.state !== 'pending_approval') return row;
  const proposal = (await db.query<{
    status: string;
    expired: boolean;
  }>(`SELECT status,(expires_at IS NOT NULL AND expires_at<=now()) AS expired FROM proposals WHERE id=$1 AND space_id=$2`, [row.proposal_id, row.space_id])).rows[0];
  if (!proposal) throw new OperationError('operation_approval_state_inconsistent', 503);
  const state = proposal.status === 'rejected' ? 'rejected' : proposal.status === 'superseded' ? 'superseded' : proposal.status === 'pending' && proposal.expired ? 'expired' : null;
  if (state) {
    await db.query('UPDATE operation_idempotency SET state=$2,terminal_at=now() WHERE id=$1 AND state=\'pending_approval\'', [row.id, state]);
    return {
      ...row,
      state
    };
  }
  if (proposal.status !== 'pending') throw new OperationError('operation_approval_state_inconsistent', 503);
  return row;
}
