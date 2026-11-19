import { isPolicyAuditRecoveryActive } from '../../policy/auditWriter.js';
import { randomUUID } from "node:crypto";
import type { Queryable } from '../../routeUtils/common.js';
import { OperationActorSchema, type OperationActor, type OperationOutcome } from '@rainver/protocol';
import type { ServerConfig } from '../../../config.js';
import { operationTransaction, runOperationWork } from '../../../db/operationTransaction.js';
import type { ProposalApplierRegistry } from '../../proposals/applierRegistry.js';
import { PgProposalApplyService } from '../../proposals/applyService.js';
import type { ProposalDecisionHooks } from '../../proposals/decisionHooks.js';
import type { ProposalApplyResult } from '../../proposals/applierRegistry.js';
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
/** The only accept result type produced solely through a linked operation request: this hook's
 * own failure body. `plugin_proposal` is not origin evidence — legacy host appliers return it too. */
const OPERATION_LINKED_RESULT_TYPES: ReadonlySet<string> = new Set(['operation_failure']);
/** `proposals.operation_request_linked`: set when an approval request is recorded, outlives its retention. */
export async function durablyLinked(db: Queryable, id: string, spaceId: string): Promise<boolean> {
  return (await db.query<{linked: boolean}>('SELECT operation_request_linked AS linked FROM proposals WHERE id=$1 AND space_id=$2', [id, spaceId])).rows[0]?.linked === true;
}
function scope(row: LinkedRequest): string[] {
  return [row.space_id, row.principal_kind, row.principal_id, row.on_behalf, row.authority_scope_id, row.operation_id, row.idempotency_key];
}
/** Integration port over the canonical service, not a second Proposal decision engine.
 * No production family registers a mapping until its writer/effect inventory passes.
 */
export function operationProposalService(config: ServerConfig, registry: ProposalApplierRegistry, registrations: ReadonlyMap<string, OperationRegistration>): PgProposalApplyService {
  return new PgProposalApplyService(config, registry, operationProposalDecisionHooks(config, registrations));
}
/** The decision hooks behind {@link operationProposalService}; exported for direct real-PG checks. */
export function operationProposalDecisionHooks(config: ServerConfig, registrations: ReadonlyMap<string, OperationRegistration>): ProposalDecisionHooks {
  const linked = async (db: Queryable, id: string) => (await db.query<LinkedRequest>('SELECT * FROM operation_idempotency WHERE proposal_id=$1', [id])).rows[0];
  return {
    async usesAtomicAudit(db, id) {
      return !!(await linked(db, id));
    },
    async runApply(db,id,apply) {
      const row=await linked(db,id);
      if(!row)return apply(db);
      // beforeApply has verified the frozen requester against the reserved key,
      // live authority, payload and mapping. The reviewer remains userId.
      const requester=(row.frozen_json as FrozenRequest).actor;
      const port=operationTransaction(db);
      try{return await runOperationWork(()=>apply(port.db,requester));}finally{port.close();}
    },
    async beforeDecision(db, id, identity, _decision) {
      const candidate = await linked(db, id);
      // Retention pruned the request (only after it was terminal): its frozen version, preconditions
      // and requester are gone, so a new decision key can neither apply nor reject it. The durable
      // origin marker, not the request row, decides; unlinked (legacy) Proposals decide normally.
      if (!candidate) return !(await durablyLinked(db, id, identity.spaceId));
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
      if (row.state !== 'pending_approval') {
        // The first accept after derived expiry commits `expired` (with its refusal as the accept
        // receipt) instead of rolling the reconcile back behind a 404; later decisions see 404.
        return _decision === 'accept' && locked.state === 'pending_approval' && row.state === 'expired' ? expiredDecision() : false;
      }
      // The reviewer receives the result the accepted request produces.
      const item = registrations.get(row.operation_id);
      if (_decision === 'accept' && item?.authorizeApprovedResult) {
        const frozen = row.frozen_json as FrozenRequest, port = operationTransaction(db);
        try { await runOperationWork(() => item.authorizeApprovedResult!(port.db, {input: frozen.input, actor: frozen.actor}, identity, false)); } finally { port.close(); }
      }
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
        return superseded();
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
        if (!proposal || canonical(proposal.payload_json) !== canonical(frozen.payload) || canonical(resolved.targets) !== canonical(frozen.targets) || canonical(await runOperationWork(()=>item.approval!.preconditions(port.db, frozen.input, frozen.actor, 'approve'))) !== canonical(frozen.preconditions)) {
          return superseded();
        }
      } finally {
        port.close();
      }
      const satisfied = item.approval.mode === 'blocked_command' ? item.approval.gate.policy_rule_id : undefined;
      if (satisfied && satisfied !== frozen.gate_rule) throw new OperationError('operation_approval_state_inconsistent', 503);
      const policy = await enforce({
        ...config,
        auditTransaction: db
      }, await loadActionRegistry(config), {
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
          ...item.policyContext?.(frozen.input, frozen.actor, resolved),
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
      // A SQL failure may have aborted the transaction. Preserve the effect's
      // original failure rather than replacing it with this lookup's 25P02.
      let row:LinkedRequest|undefined;
      try { row = await linked(db, id); } catch { throw error; }
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
    async authorizeAcceptReplay(db, id, identity, stored) {
      const row = await linked(db, id);
      if (!row) {
        // Retention prunes the original request independently of this receipt. Without its frozen
        // requester the result gate cannot be rechecked, so an operation-linked result is refused.
        // The Proposal's durable origin marker is the authority; a still-registered mapping of its
        // type is extra fail-closed evidence. Unlinked (legacy) receipts keep their replay.
        if (stored.resultType && OPERATION_LINKED_RESULT_TYPES.has(stored.resultType)) throw new OperationError('operation_result_unavailable', 410);
        const proposal = (await db.query<{proposal_type: string}>('SELECT proposal_type FROM proposals WHERE id=$1 AND space_id=$2', [id, identity.spaceId])).rows[0];
        if (await durablyLinked(db, id, identity.spaceId) || proposal && [...registrations.values()].some(item => item.approval?.proposalType === proposal.proposal_type)) throw new OperationError('operation_result_unavailable', 410);
        return;
      }
      const item = registrations.get(row.operation_id), frozen = row.frozen_json as FrozenRequest;
      if (!item || !OperationActorSchema.safeParse(frozen?.actor).success) throw hidden();
      if (!item.authorizeApprovedResult) return;
      const port = operationTransaction(db);
      try { await runOperationWork(() => item.authorizeApprovedResult!(port.db, {input: frozen.input, actor: frozen.actor}, identity, true)); } finally { port.close(); }
    },
    async afterReject(db, id) {
      const row = await linked(db, id);
      if (row) await db.query("UPDATE operation_idempotency SET state='rejected',terminal_at=now() WHERE id=$1 AND state='pending_approval'", [row.id]);
    }
  };
}
/** A stale approval is a decision, not a missing Proposal: the canonical accept path commits the
 * Proposal as `superseded` and {@link ProposalDecisionHooks.afterApply} marks the linked request
 * `superseded`, so the original request replays `operation_approval_superseded` and the accept
 * receipt carries the same refusal without applying anything. */
function superseded(): ProposalApplyResult {
  return {
    result_type: 'operation_failure',
    result: new OperationError('operation_approval_superseded', 409).body(randomUUID()) as unknown as Record<string, unknown>,
    finalStatus: 'superseded'
  };
}
/** An accept that finds its linked request expired: nothing is applied and the Proposal stays
 * pending (derived expiry, as cleanup leaves it); the receipt carries `operation_approval_expired`. */
function expiredDecision(): ProposalApplyResult {
  return {
    result_type: 'operation_failure',
    result: new OperationError('operation_approval_expired', 409).body(randomUUID()) as unknown as Record<string, unknown>
  };
}
