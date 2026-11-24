import {workspaceSensitiveReadBlocker} from '../../projectFolders/workspaceSensitiveReadBlocker.js';
import {assertDaemonWorkspaceActor} from '../../hosts/workspaceActor.js';
import {safeInputErrors} from '../inputErrors.js';
import {assertCurrentPerson,personalReceiptSpace} from './personAdmission.js';
import {validateRegistration} from './registrationRules.js';
import { resolveUserCreationActor } from './userContentCreation.js';
import {withOperationProposalDecisionOwner,prepareOperationRunTerminalOwner} from './proposalTransitions.js';
import {withPolicyAuditRecovery} from '../../policy/auditWriter.js';
import { getOperationAuditPool } from "../../../db/pool.js";
import { ContentAccessAuditService } from "../../contentAccess/audit.js";
import type { Pool } from '../../../db/pool.js';
import type { OperationActor, OperationResponse, OperationOutcome } from '@rainver/protocol';
import { DUPLICATE_TASK_CANCELLATION_REASON, OperationActorSchema, type PolicyCheckRequest } from '@rainver/protocol';
import type { ServerConfig } from '../../../config.js';
import { withTransaction } from '../../../db/tx.js';
import { operationTransaction, runOperationWork } from '../../../db/operationTransaction.js';
import { enforce } from '../../policy/service.js';
import { loadActionRegistry } from '../../policy/actionRegistry.js';
import { assertCurrentActor, assertOperationGrant } from './actor.js';
import { OperationError, OperationInputError, OperationBusinessError, OperationRefusal, hidden } from './errors.js';
import { reserve, record, reconcile, requestScope, fingerprint } from './repository.js';
import type { OperationRegistration } from './types.js';
import { classifyRegisteredError, executeRegistered, registeredPolicyRequest, resolveRegisteredInput } from './registrationSteps.js';

const taskStatusSensitiveReadMessages = new Map([
  ['task_status_not_cancellation', 'Only eligible duplicate-task cancellations can change Task status from this conversation after a restricted data read. Review the status change on the Project Board.'],
  ['task_cancellation_requires_fixed_reason', `For an eligible duplicate Task, cancel with the exact reason "${DUPLICATE_TASK_CANCELLATION_REASON}" and omit extra details.`],
  ['task_not_shared', 'This Task is private. Cancellation from this conversation after a restricted data read is limited to shared Project Tasks. Review the Task on the Project Board.'],
  ['task_already_started_or_closed', 'This Task is outside its initial pending statuses or has already been closed. Review its current status on the Project Board before changing it.'],
  ['task_has_work_history', 'This Task has work history or execution or publication dependencies. Review its activity on the Project Board before cancelling it.'],
]);

/** Stateless per invocation; registry/executors are composed once and retain no caller. */
export class OperationExecutor {
  readonly registrations: ReadonlyMap<string, OperationRegistration>;
  constructor(private readonly pool: Pool, private readonly config: ServerConfig, registrations: readonly OperationRegistration[]) {
    const map = new Map<string, OperationRegistration>();
    for (const item of registrations) {
      const d = item.definition;
      if (map.has(d.id)) throw new Error('Invalid migrated operation registration');
      validateRegistration(item);
      map.set(d.id, item);
    }
    this.registrations = map;
  }
  /** The pre-transaction admission every execution begins with: actor shape,
   * surface, current actor and grant, the operation's own input schema and its
   * transport-key rule. Reads only; nothing is reserved, audited or written. */
  private async admit(id: string, raw: unknown, actor: OperationActor, key?: string) {
    if (!OperationActorSchema.safeParse(actor).success) throw hidden();
    const item = this.registrations.get(id);
    if (!item) throw hidden();
    const d = item.definition;
    if (!d.allowed_actor_types.includes(actor.principal.kind) || !d.visibility.has(actor.surface === 'web' ? 'public_api' : actor.surface)) throw hidden();
    const personScoped=item.admission?.kind==='person';
    if(personScoped)await assertCurrentPerson(this.pool,actor);
    else if(item.admission?.kind==='daemon_workspace')await assertDaemonWorkspaceActor(this.pool,actor);
    else await assertCurrentActor(this.pool,actor);
    await assertOperationGrant(this.pool, actor, id);
    const parsed = d.input_schema.safeParse(raw);
    if (!parsed.success) throw new OperationInputError(safeInputErrors(d,parsed.error));
    const command = d.execution!.kind === 'command';
    if (command && (!key || key.length > 256 || !/^[\x21-\x7e]+$/.test(key))) throw new OperationError('idempotency_key_required', 422);
    return {item, input: parsed.data as unknown, command};
  }
  /**
   * `execute`'s own admission, run alone by an entry before an owner step that
   * spends or has local effects outside the transaction (a route's `prepare` /
   * `around`). A request execute would refuse for its actor, input or key is
   * refused here with the same response, before anything is spent; `execute`
   * still repeats every check and authorizes under its locks.
   */
  async preflight(id: string, raw: unknown, actor: OperationActor, requestId: string, key?: string): Promise<{ok: true; input: unknown} | {ok: false; response: OperationResponse}> {
    try {
      return {ok: true, input: (await this.admit(id, raw, actor, key)).input};
    } catch (error) {
      const e = operationFailure(error, false);
      return {ok: false, response: {http_status: e.httpStatus, request_id: requestId, replayed: false, policy_decision_record_id: null, body: e.body(requestId)}};
    }
  }
  async execute(id: string, raw: unknown, actor: OperationActor, requestId: string, key?: string, version?: number, signal?: AbortSignal): Promise<OperationResponse> {
    let decisionId: string | null = null;
    let failureAudit: PolicyCheckRequest | undefined;
    let notification: (() => Promise<void>) | undefined;
    let readyToCommit = false;
    let release: {data: unknown; facts: unknown; replayed: boolean} | undefined;
    const finish = (result: OperationResponse): OperationResponse => {
      readyToCommit = true;
      return result;
    };
    const response = (body: OperationOutcome, status = 200, replayed = false): OperationResponse => ({
      http_status: status,
      request_id: requestId,
      replayed,
      policy_decision_record_id: decisionId,
      body
    });
    try {
      const admitted = await this.admit(id, raw, actor, key);
      const {item, command} = admitted;
      const d = item.definition;
      const personScoped=item.admission?.kind==='person';
      const assertActor=(db:Parameters<typeof assertCurrentActor>[0],lock=false)=>personScoped?assertCurrentPerson(db,actor,lock):item.admission?.kind==='daemon_workspace'?assertDaemonWorkspaceActor(db,actor,lock):assertCurrentActor(db,actor,lock);
      let input = admitted.input;
      const requestActor = actor;
      const transaction = () => withTransaction(this.pool, async client => {
        if (!command) await client.query('SET TRANSACTION READ ONLY');
        const tx = operationTransaction(client);
        let terminalOwner:Awaited<ReturnType<typeof prepareOperationRunTerminalOwner>>|undefined;
        try {
          const placing = !!item.userContentCreation && requestActor.principal.kind === 'user';
          if (placing) actor = await resolveUserCreationActor(tx.db, input, requestActor,id);
          const storageSpace=personScoped?await personalReceiptSpace(tx.db,actor.principal.id):actor.space_id;
          const receiptActor={...actor,space_id:storageSpace};
          const resolved = await resolveRegisteredInput(item, tx.db, input, actor, {requestId,idempotencyKey:key??null});
          const scope = resolved.scope;
          input = resolved.input;
          const identity = command ? requestScope(receiptActor, scope.authority, id, key!) : null;
          const work = async () => {
          let previous = identity ? await reserve(client, identity) : null;
          if (placing) {
            await assertCurrentActor(tx.db, requestActor, true);
            const current = await resolveUserCreationActor(tx.db, input, requestActor,id);
            if (current.space_id !== actor.space_id) throw new OperationError('operation_conflict', 409);
          }
          if(item.lockBeforeActor&&actor.principal.kind==='agent')await runOperationWork(()=>item.lockBeforeActor!(tx.db,input,actor,scope));
          if(item.domainAuthorizationFirst){
            if(item.approval||placing||item.runTerminalOwner)throw new OperationError('operation_internal_error',500);
            await assertActor(tx.db);
            await assertOperationGrant(tx.db,actor,id);
            const body=previous?.result_json;
            if(body&&'data' in body){
              if(!d.output_schema.safeParse(body.data).success)throw new OperationError('operation_result_unavailable',410);
              await runOperationWork(async()=>item.authorizeResult?.(tx.db,body.data,actor));
            }else await runOperationWork(()=>item.authorize(tx.db,input,actor,scope));
          }
          await assertActor(tx.db, command);
          if(personScoped && await personalReceiptSpace(tx.db,actor.principal.id)!==storageSpace)throw new OperationError('operation_conflict',409);
          await assertOperationGrant(tx.db, actor, id);
          if(item.runTerminalOwner&&!previous){
            terminalOwner=await runOperationWork(()=>prepareOperationRunTerminalOwner(client,tx.db,actor.space_id,
              db=>item.runTerminalOwner!.discover(db,input,actor)));
          }
          if(!item.domainAuthorizationFirst)await runOperationWork(()=>item.authorize(tx.db, input, actor, scope));
          const policyRequest = await registeredPolicyRequest(tx.db, item, input, actor, scope, {space: storageSpace, metadata: {
            operation_request_id: requestId,
            ...(placing ? {request_space_id:requestActor.space_id} : {})
          }});
          if (command) failureAudit = policyRequest;
          const policy = await enforce({
            ...this.config,
            auditTransaction: command ? tx.db : getOperationAuditPool(this.config.databaseUrl!)
          }, await loadActionRegistry(this.config), policyRequest);
          decisionId = policy.policy_decision_record_id ?? null;
          // A missing data-owner consent is requestable through authorization.request (ADR 0030).
          if (policy.decision?.decision === 'deny' && policy.decision.policy_rule_id === 'plugin_data_consent_required') throw new OperationError('operation_consent_required', 403);
          if ((id === 'workspace.change.complete' || id === 'workspace.integration.retry')
            && policy.decision?.decision === 'deny'
            && policy.decision.policy_rule_id === 'hard_invariant_sensitive_plugin_read_egress') {
            throw new OperationRefusal(409, 'workspaces', workspaceSensitiveReadBlocker.message, {code: workspaceSensitiveReadBlocker.code});
          }
          if (id === 'task.set_status' && actor.principal.kind === 'agent'
            && policy.decision?.decision === 'deny'
            && policy.decision.policy_rule_id === 'hard_invariant_sensitive_plugin_read_egress') {
            // Authorization already established full access and Project write authority.
            const blocker = scope.policyFacts?.task_status_sensitive_read_blocker;
            const message = typeof blocker === 'string' ? taskStatusSensitiveReadMessages.get(blocker) : undefined;
            throw new OperationRefusal(409, 'tasks',
              message ?? 'This conversation cannot change the Task status under its current data-access restrictions. Review the Task on the Project Board.',
              {code: message ? blocker : 'task_status_restricted_context'});
          }
          if (policy.decision?.decision === 'deny') throw hidden();
          if (policy.status === 'error' || !decisionId) throw new OperationError('operation_audit_unavailable', 503, true);
          const hash = fingerprint(version ?? d.version, item.fingerprintInput ? await runOperationWork(async()=>item.fingerprintInput!(input)) : input, scope.targets);
          if (previous) {
            previous = await reconcile(client, previous);
            if (previous.operation_version !== d.version) throw new OperationError('operation_version_unsupported', 409);
            if (previous.fingerprint !== hash) throw new OperationError('idempotency_key_reused', 422);
            if (previous.state === 'pending_approval') return finish(response({
              status: 'pending_approval',
              proposal_id: previous.proposal_id!
            }, 202, true));
            if (['rejected', 'expired', 'superseded'].includes(previous.state)) return finish(response(new OperationError(`operation_approval_${previous.state}` as 'operation_approval_rejected', 409).body(requestId), 409, true));
            if (!previous.result_json) throw new OperationError('operation_result_unavailable', 410);
            const body = previous.result_json;
            if ('data' in body) {
              if (!d.output_schema.safeParse(body.data).success) throw new OperationError('operation_result_unavailable', 410);
              await runOperationWork(async()=>item.authorizeResult?.(tx.db, body.data, actor));
              if (item.releaseGate) release = {data: body.data, facts: (previous.frozen_json as {release?: unknown} | null)?.release ?? null, replayed: true};
            }
            if ('error' in body) body.error.request_id = requestId;
            return finish(response(body, previous.http_status!, true));
          }
          if (version !== undefined && version !== d.version) throw new OperationError('operation_version_unsupported', 409);
          if (policy.decision?.decision === 'require_approval' || item.approval?.mode === 'proposal_submission') {
            if (!identity || !item.approval || policy.decision?.decision === 'require_approval' && policy.decision.policy_rule_id !== item.approval.gate.policy_rule_id) throw new OperationError('operation_approval_mapping_unavailable', 503);
            const preconditions = await runOperationWork(()=>item.approval!.preconditions(tx.db, input, actor, 'propose'));
            const proposalId = await runOperationWork(()=>item.approval!.create(tx.db, input, actor));
            const proposal = (await tx.db.query<{
              proposal_type: string;
              payload_json: unknown;
            }>("SELECT proposal_type,payload_json FROM proposals WHERE id=$1 AND space_id=$2 AND status='pending'", [proposalId, actor.space_id])).rows[0];
            if (!proposal || proposal.proposal_type !== item.approval.proposalType) throw new OperationError('operation_approval_mapping_unavailable', 503);
            const body: OperationOutcome = {
              status: 'pending_approval',
              proposal_id: proposalId
            };
            await record(client, identity, d.version, hash, 'pending_approval', body, 202, proposalId, {
              actor,
              input,
              targets: scope.targets,
              preconditions,
              payload: proposal.payload_json,
              gate_rule: policy.decision?.policy_rule_id ?? null,
              mapping: {mode:item.approval.mode, gate:item.approval.gate, proposal_type:item.approval.proposalType,requires_live_run:item.approval.requiresLiveRun??false}
            });
            return finish(response(body, 202));
          }
          if (command) await client.query('SAVEPOINT operation_work');
          try {
            const {output, data} = await executeRegistered(item, tx.db, input, actor, Object.freeze({requestId,idempotencyKey:key??null,...(signal?{signal}:{})}));
            const releaseFacts = item.releaseGate ? item.releaseFacts?.(output) ?? null : undefined;
            if (!command && item.readAudit) await withTransaction(getOperationAuditPool(this.config.databaseUrl!), audit => item.readAudit!({
              hostTransaction: audit,
              recordReads: (resourceType, resourceIds) => new ContentAccessAuditService(audit).recordReads({
                spaceId: actor.space_id,
                resourceType,
                resourceIds,
                viewerUserId: actor.on_behalf_of_user_id!,
                agentId: actor.agent_id,
                runId: actor.run_id,
                actionId: actor.principal.kind === 'agent' ? id : null,
                accessType: 'operation_query'
              })
            }, input, data, actor, output)).catch(() => {
              throw new OperationError('operation_audit_unavailable', 503, true);
            });
            const body: OperationOutcome = {
              status: 'succeeded',
              data: data
            };
            const successStatus=typeof item.successStatus==='function'?item.successStatus(data):item.successStatus??200;
            if (identity) await record(client, identity, d.version, hash, 'succeeded', body, successStatus, null, item.releaseGate ? {release: releaseFacts} : null);
            if (item.releaseGate) release = {data: data, facts: releaseFacts, replayed: false};
            await terminalOwner?.finish();
            if (command && item.afterCommit) notification = () => item.afterCommit!(data, actor);
            return finish(response(body, successStatus));
          } catch (caught) {
            // Domain adapters explicitly classify deterministic, safe failures. Unknown errors stay internal.
            const error = classifyRegisteredError(item, caught);
            if (identity && error instanceof OperationBusinessError) {
              await client.query('ROLLBACK TO SAVEPOINT operation_work');
              const body = error.body(requestId);
              await record(client, identity, d.version, hash, 'failed', body, error.httpStatus);
              return finish(response(body, error.httpStatus));
            }
            throw error;
          }
          };
          try { return item.proposalDecisionOwner && identity
            ? await withOperationProposalDecisionOwner(tx.db,actor.space_id,await item.proposalDecisionOwner.roots(tx.db,input,actor),identity,work,actor.on_behalf_of_user_id!,item.proposalDecisionOwner.bundle,roots=>item.proposalDecisionOwner!.prepare?.(tx.db,roots,actor,input)??Promise.resolve())
            : await work();
          } catch(error) {
            // Preparation runs before Proposal row locks and the work savepoint;
            // preserve explicitly classified refusals on first use and replay.
            throw classifyRegisteredError(item, error);
          }
        } finally {
          terminalOwner?.close();
          tx.close();
        }
      });
      const committed=await(item.runTerminalOwner||item.policyAuditRecovery?withPolicyAuditRecovery(this.config.databaseUrl,transaction):transaction());
      if (release) {
        // Nothing leaves the server before its release gate commits; a command's committed
        // receipt stays and a retry with the same key is released through this same gate.
        const pending = release;
        try {
          await withTransaction(getOperationAuditPool(this.config.databaseUrl!), audit => item.releaseGate!(audit, {input, data: pending.data, facts: pending.facts, actor, replayed: pending.replayed}));
        } catch {
          return response(new OperationError('operation_audit_unavailable', 503, true).body(requestId), 503);
        }
      }
      try {
        await notification?.();
      } catch {/* Notifications are rebuildable; never turn committed business work into failure. */}
      return committed;
    } catch (error) {
      const e = operationFailure(error, readyToCommit);
      if (failureAudit) {
        // Only append failure audit after resolving COMMIT uncertainty. A committed admission audit is never duplicated.
        try {
          const committed = decisionId ? (await this.pool.query('SELECT id FROM policy_decision_records WHERE id=$1', [decisionId])).rows.length > 0 : false;
          if (!committed) {
            const audit = await enforce({...this.config, auditTransaction: getOperationAuditPool(this.config.databaseUrl!), auditRecordId: decisionId ?? undefined}, await loadActionRegistry(this.config), {
              ...failureAudit,
              metadata_json: {
                ...failureAudit.metadata_json,
                operation_outcome: 'failed',
                error_code: e.code
              }
            });
            decisionId = audit.policy_decision_record_id ?? null;
          }
        } catch {/* A failed audit never releases business output or grants admission. */}
      }
      return response(e.body(requestId), e.httpStatus);
    }
  }
}

/** One mapping from a thrown failure to its safe operation error. */
function operationFailure(error: unknown, readyToCommit: boolean): OperationError {
  const code = (error as {code?: string})?.code;
  const transient = readyToCommit || !!code && (/^(08|ECONN|ETIMEDOUT)/.test(code) || ['40001', '40P01', '55P03', '57P01'].includes(code));
  return error instanceof OperationError ? error : [403, 404].includes((error as {statusCode?: number})?.statusCode ?? 0) ? hidden() : new OperationError(transient ? 'operation_temporarily_unavailable' : 'operation_internal_error', transient ? 503 : 500, transient);
}
