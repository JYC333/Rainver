import { isPolicyAuditRecoveryActive } from '../../policy/auditWriter.js';
import { randomUUID } from "node:crypto";
import type { PoolClient } from '../../../db/pool.js';
import { OperationActorSchema, type OperationActor, type OperationOutcome } from '@rainver/protocol';
import type { ServerConfig } from '../../../config.js';
import { operationTransaction, runOperationWork } from '../../../db/operationTransaction.js';
import type { ProposalApplierRegistry } from '../../proposals/applierRegistry.js';
import { PgProposalApplyService } from '../../proposals/applyService.js';
import { contentDecisionFromDb } from '../../access/contentAccessQuery.js';
import { enforce } from '../../policy/service.js';
import { loadActionRegistry } from '../../policy/actionRegistry.js';
import { sessionActor, assertCurrentActor, assertOperationGrant } from './actor.js';
import { reserve, reconcile, canonical, fingerprint, requestScope, type RequestRow } from './repository.js';
import { OperationError, OperationBusinessError, hidden } from './errors.js';
import type { OperationRegistration,ResolvedOperation } from './types.js';
type LinkedRequest = RequestRow & {
  principal_kind: string;
  principal_id: string;
  on_behalf: string;
  authority_scope_id: string;
  idempotency_key: string;
};
interface FrozenRequest {
  mapping: {mode:string;gate:unknown;proposal_type:string;requires_live_run:boolean};
  actor: OperationActor;
  input: unknown;
  targets: unknown;
  preconditions: unknown;
  payload: unknown;
  gate_rule: string | null;
}
function scope(row: LinkedRequest): string[] {
  return [row.space_id, row.principal_kind, row.principal_id, row.on_behalf, row.authority_scope_id, row.operation_id, row.idempotency_key];
}
/** Integration port over the canonical service, not a second Proposal decision engine.
 * No production family registers a mapping until its writer/effect inventory passes.
 */
export function operationProposalService(config: ServerConfig, registry: ProposalApplierRegistry, registrations: ReadonlyMap<string, OperationRegistration>): PgProposalApplyService {
  const linked = async (db: PoolClient, id: string) => (await db.query<LinkedRequest>('SELECT * FROM operation_idempotency WHERE proposal_id=$1', [id])).rows[0];
  return new PgProposalApplyService(config, registry, {
    async usesAtomicAudit(db, id) {
      return !!(await linked(db, id));
    },
    async runApply(db,id,apply) {
      if(!await linked(db,id))return apply(db);
      const port=operationTransaction(db);
      try{return await runOperationWork(()=>apply(port.db));}finally{port.close();}
    },
    async beforeDecision(db, id, identity, _decision) {
      const candidate = await linked(db, id);
      if (!candidate) return true;
      if (candidate.space_id !== identity.spaceId) throw hidden();
      // Current decision authority before exposing or changing linked outcome metadata.
      await assertCurrentActor(db, sessionActor(identity));
      if ((await contentDecisionFromDb(db, identity, 'proposal', id, {
        includeOversight: false
      })) === 'deny') throw hidden();
      // External transaction owners must wrap their full commit/rollback lifecycle,
      // not only acceptInTransaction, before a mapped family may participate.
      if (!isPolicyAuditRecoveryActive()) throw new OperationError('operation_approval_mapping_unavailable', 503);
      const locked = await reserve(db, scope(candidate));
      if (!locked) throw new OperationError('operation_approval_state_inconsistent', 503);
      const row = await reconcile(db, locked);
      if (row.state !== 'pending_approval') return false;
      // Hold mutable approver membership/Project ownership through the canonical role check.
      await assertCurrentActor(db,sessionActor(identity),true);
      await db.query('SELECT p.id FROM projects p JOIN proposals proposal ON proposal.project_id=p.id AND proposal.space_id=p.space_id WHERE proposal.id=$1 AND proposal.space_id=$2 FOR NO KEY UPDATE OF p',[id,identity.spaceId]);
      return true;
    },
    async beforeApply(db, id) {
      const row = await linked(db, id);
      if (!row) return;
      const item = registrations.get(row.operation_id),
        frozen = row.frozen_json as FrozenRequest;
      // Canonical role/risk/owner/egress authorization has now succeeded.
      if (!item?.approval) throw new OperationError('operation_approval_mapping_unavailable', 503);
      if (!OperationActorSchema.safeParse(frozen?.actor).success || frozen.actor.space_id !== row.space_id || fingerprint(row.operation_version, frozen.input, frozen.targets) !== row.fingerprint) throw new OperationError('operation_approval_state_inconsistent', 503);
      if(canonical(requestScope(frozen.actor,row.authority_scope_id,row.operation_id,row.idempotency_key))!==canonical(scope(row)))throw new OperationError('operation_approval_state_inconsistent',503);
      if (item.definition.version !== row.operation_version || canonical(frozen.mapping)!==canonical({mode:item.approval.mode,gate:item.approval.gate,proposal_type:item.approval.proposalType,requires_live_run:item.approval.requiresLiveRun??false})) {
        await supersede(db, id, row.id);
        return false;
      }
      const port = operationTransaction(db);
      let resolved:ResolvedOperation;
      try {
        await assertCurrentActor(port.db, frozen.actor, true, !item.approval.requiresLiveRun);
        await assertOperationGrant(port.db, frozen.actor, item.definition.id);
        resolved = await runOperationWork(()=>item.resolve(port.db, frozen.input, frozen.actor));
        await runOperationWork(()=>item.authorize(port.db, frozen.input, frozen.actor,resolved));
        const proposal = (await db.query<{
          payload_json: unknown;
        }>('SELECT payload_json FROM proposals WHERE id=$1 AND space_id=$2', [id, row.space_id])).rows[0];
        if (!proposal || canonical(proposal.payload_json) !== canonical(frozen.payload) || canonical(resolved.targets) !== canonical(frozen.targets) || canonical(await runOperationWork(()=>item.approval!.preconditions(port.db, frozen.input, frozen.actor))) !== canonical(frozen.preconditions)) {
          await supersede(db, id, row.id);
          return false;
        }
      } finally {
        port.close();
      }
      const satisfied = item.approval.mode === 'blocked_command' ? item.approval.gate.policy_rule_id : undefined;
      if (satisfied && satisfied !== frozen.gate_rule) throw new OperationError('operation_approval_state_inconsistent', 503);
      const policy = await enforce({
        ...config,
        auditTransaction: db
      }, await loadActionRegistry(), {
        action: item.definition.policy_action,
        actor_type: frozen.actor.principal.kind,
        actor_id: frozen.actor.principal.id,
        space_id: row.space_id,
        resource_space_id: row.space_id,
        resource_type: resolved.resourceType,
        resource_id: resolved.resourceId,
        force_record: true,
        proposal_id: id,
        context: {
          ...item.policyContext?.(frozen.input, frozen.actor),
          action_id: item.definition.id,
          trigger_origin: frozen.actor.effective_origin,
          instructed_by_user_id: frozen.actor.on_behalf_of_user_id
        }
      }, satisfied);
      if (policy.decision?.decision === 'deny') throw hidden();
      if (policy.status === 'error' || !policy.policy_decision_record_id) throw new OperationError('operation_audit_unavailable', 503, true);
      if (policy.status !== 'allow') throw hidden();
      await db.query('SAVEPOINT operation_approved_work');
    },
    async applyFailed(db, id, error) {
      const row = await linked(db, id);
      if (!row) throw error;
      const classified = error instanceof OperationBusinessError ? error : error instanceof OperationError ? undefined : registrations.get(row.operation_id)?.classifyError?.(error);
      if (!(classified instanceof OperationBusinessError)) throw error;
      await db.query('ROLLBACK TO SAVEPOINT operation_approved_work');
      const body = classified.body(randomUUID());
      await db.query("UPDATE operation_idempotency SET state='failed',result_json=$2::jsonb,http_status=$3,terminal_at=now() WHERE id=$1 AND state='pending_approval'", [row.id, JSON.stringify(body), classified.httpStatus]);
      return {
        result_type: 'operation_failure',
        result: body,
        finalStatus: 'superseded'
      };
    },
    async afterApply(db, id, result) {
      const row = await linked(db, id);
      if (!row || row.state === 'failed') return;
      const item = registrations.get(row.operation_id);
      if (!item?.approval || result.rollback) throw new OperationError('operation_approval_mapping_unavailable', 503);
      if (result.finalStatus === 'superseded') {
        await db.query("UPDATE operation_idempotency SET state='superseded',terminal_at=now() WHERE id=$1", [row.id]);
        return;
      }
      const output = item.definition.output_schema.safeParse(result.result);
      if (!output.success) throw new OperationError('operation_invalid_output', 500);
      const port = operationTransaction(db);
      try { await runOperationWork(async()=>item.authorizeResult?.(port.db, output.data, (row.frozen_json as FrozenRequest).actor)); }
      finally { port.close(); }
      const body: OperationOutcome = {
        status: 'succeeded',
        data: output.data
      };
      await db.query("UPDATE operation_idempotency SET state='succeeded',result_json=$2::jsonb,http_status=$3,terminal_at=now() WHERE id=$1 AND state='pending_approval'", [row.id, JSON.stringify(body),item.successStatus ?? 200]);
    },
    async afterReject(db, id) {
      const row = await linked(db, id);
      if (row) await db.query("UPDATE operation_idempotency SET state='rejected',terminal_at=now() WHERE id=$1 AND state='pending_approval'", [row.id]);
    }
  });
}
async function supersede(db: PoolClient, proposalId: string, requestId: string) {
  await db.query("UPDATE proposals SET status='superseded',updated_at=now() WHERE id=$1 AND status='pending'", [proposalId]);
  await db.query("UPDATE operation_idempotency SET state='superseded',terminal_at=now() WHERE id=$1 AND state='pending_approval'", [requestId]);
}
