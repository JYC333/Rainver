import {assertDaemonWorkspaceActor,DAEMON_WORKSPACE_OPERATIONS} from '../../hosts/workspaceActor.js';
import {safeInputErrors} from '../inputErrors.js';
import {assertCurrentPerson,personalReceiptSpace,PERSON_OPERATIONS} from './personAdmission.js';
import { resolveUserCreationActor } from './userContentCreation.js';
import {withOperationProposalDecisionOwner,prepareOperationRunTerminalOwner} from './proposalTransitions.js';
import {withPolicyAuditRecovery} from '../../policy/auditWriter.js';
import { getOperationAuditPool } from "../../../db/pool.js";
import { ContentAccessAuditService } from "../../contentAccess/audit.js";
import type { Pool } from '../../../db/pool.js';
import type { OperationActor, OperationResponse, OperationOutcome } from '@rainver/protocol';
import { OperationActorSchema, type PolicyCheckRequest } from '@rainver/protocol';
import type { ServerConfig } from '../../../config.js';
import { withTransaction } from '../../../db/tx.js';
import { operationTransaction, runOperationWork } from '../../../db/operationTransaction.js';
import { enforce } from '../../policy/service.js';
import { loadActionRegistry } from '../../policy/actionRegistry.js';
import { assertCurrentActor, assertOperationGrant } from './actor.js';
import { OperationError, OperationInputError, OperationBusinessError, hidden } from './errors.js';
import { reserve, record, reconcile, requestScope, fingerprint } from './repository.js';
import type { OperationRegistration } from './types.js';

/** Durable new-content commands whose Personal/Project placement the access owner chooses
 * exactly as their retained REST adapters always did. Never an arbitrary Space resolver. */
const DURABLE_PLACEMENT_COMMANDS = new Set(['activity.upload','activity.create','capture.create','source.channel.create', 'source.item.save_url', 'source.evidence.create', 'source.custom.draft.create', 'source.goal.setup.begin', 'source.goal.create', 'agent.create', 'agent.template.instantiate', 'agent.run.create', 'agent.chat.send', 'session.create', 'board.create', 'task.create']);
/** One create shared by a person's REST call and an Agent Run tool: placement applies to the person
 * principal only; an Agent keeps its Run's Space and Project. */
const PERSON_PLACEMENT_SHARED_COMMANDS = new Set(['task.create']);
// Proposal submission retains the access-owned placement of the old REST create
// entry, without enabling an approval execution mapping. No other proposal may
// resolve a caller into another Space.
const PROPOSAL_PLACEMENT_COMMANDS = new Map<string,{proposalType:string;gateClass:string}>([['knowledge.item.propose_create',{proposalType:'knowledge_create',gateClass:'exposure'}],['knowledge.claim.propose_create',{proposalType:'claim_create',gateClass:'exposure'}],['memory.propose_create',{proposalType:'memory_create',gateClass:'belief_reach'}]]);
/** Stateless per invocation; registry/executors are composed once and retain no caller. */
export class OperationExecutor {
  readonly registrations: ReadonlyMap<string, OperationRegistration>;
  constructor(private readonly pool: Pool, private readonly config: ServerConfig, registrations: readonly OperationRegistration[]) {
    const map = new Map<string, OperationRegistration>();
    for (const item of registrations) {
      const d = item.definition;
      if (map.has(d.id) || !d.execution || d.execution.tx !== 'core_owned' || d.execution.kind === 'query' && (d.side_effects !== 'none' || d.idempotency_required || d.gate_class !== null || d.proposal_type !== null || !item.readKind || item.readKind === 'content' && !item.readAudit || !!item.afterCommit) || item.approval?.gate.kind === 'hard_gate' && item.approval.gate.gate_class !== d.gate_class) throw new Error('Invalid migrated operation registration');
      if (item.approval && (d.execution.kind !== 'command' || item.approval.atomicStatusWritersVerified !== true || !item.approval.proposalType || item.approval.mode === 'blocked_command' && !item.approval.gate.policy_rule_id)) throw new Error('Approval mapping has not passed canonical transition enablement');
      const placement = PROPOSAL_PLACEMENT_COMMANDS.get(d.id), proposalPlacement = d.side_effects==='proposal' && !!placement && d.gate_class===placement.gateClass && d.proposal_type===placement.proposalType;
      const directPlacement = d.gate_class===null && d.proposal_type===null && (d.side_effects==='draft' || DURABLE_PLACEMENT_COMMANDS.has(d.id) && d.side_effects==='durable');
      const shared = PERSON_PLACEMENT_SHARED_COMMANDS.has(d.id) && d.allowed_actor_types.length===2 && d.allowed_actor_types.includes('user') && d.allowed_actor_types.includes('agent') && [...d.visibility].every(surface=>surface==='public_api'||surface==='agent_tool');
      if (item.userContentCreation && (d.execution.kind!=='command' || !proposalPlacement && !directPlacement || !shared && (d.allowed_actor_types.length!==1 || d.allowed_actor_types[0]!=='user' || d.grantable || [...d.visibility].some(surface=>surface!=='public_api')) || item.approval)) throw new Error('Human content placement requires an explicitly admitted user-only creation command');
      if(item.proposalDecisionOwner&&(d.execution.kind!=='command'||item.approval||item.userContentCreation||item.runTerminalOwner))throw new Error('Proposal decision preparation requires a direct command transaction owner');
      if(item.runTerminalOwner&&(d.execution.kind!=='command'||item.approval||item.userContentCreation))throw new Error('Run terminal preparation requires a direct command transaction owner');
      if(item.admission && ((item.admission.kind==='person'?!PERSON_OPERATIONS.has(d.id):!DAEMON_WORKSPACE_OPERATIONS.has(d.id))||d.execution.kind!=='command'||d.allowed_actor_types.length!==1||d.allowed_actor_types[0]!==(item.admission.kind==='person'?'user':'system')||d.grantable||[...d.visibility].some(s=>s!=='public_api')||item.approval||item.userContentCreation||item.proposalDecisionOwner||item.runTerminalOwner||!item.domainAuthorizationFirst||!item.authorizeResult))throw new Error('Invalid person admission registration');
      map.set(d.id, item);
    }
    this.registrations = map;
  }
  async execute(id: string, raw: unknown, actor: OperationActor, requestId: string, key?: string, version?: number): Promise<OperationResponse> {
    let decisionId: string | null = null;
    let failureAudit: PolicyCheckRequest | undefined;
    let notification: (() => Promise<void>) | undefined;
    let readyToCommit = false;
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
      if (!OperationActorSchema.safeParse(actor).success) throw hidden();
      const item = this.registrations.get(id);
      if (!item) throw hidden();
      const d = item.definition;
      if (!d.allowed_actor_types.includes(actor.principal.kind) || !d.visibility.has(actor.surface === 'web' ? 'public_api' : actor.surface)) throw hidden();
      const personScoped=item.admission?.kind==='person';
      const assertActor=(db:Parameters<typeof assertCurrentActor>[0],lock=false)=>personScoped?assertCurrentPerson(db,actor,lock):item.admission?.kind==='daemon_workspace'?assertDaemonWorkspaceActor(db,actor,lock):assertCurrentActor(db,actor,lock);
      await assertActor(this.pool);
      await assertOperationGrant(this.pool, actor, id);
      const parsed = d.input_schema.safeParse(raw);
      if (!parsed.success) throw new OperationInputError(safeInputErrors(d,parsed.error));
      let input = parsed.data;
      const command = d.execution!.kind === 'command';
      if (command && (!key || key.length > 256 || !/^[\x21-\x7e]+$/.test(key))) throw new OperationError('idempotency_key_required', 422);
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
          const scope = await runOperationWork(()=>item.resolve(tx.db, input, actor, {requestId,idempotencyKey:key??null}));
          if (item.normalizeInput) {
            const normalized = d.input_schema.safeParse(item.normalizeInput(input, scope));
            if (!normalized.success) throw new OperationError('operation_internal_error',500);
            input = normalized.data;
          }
          const identity = command ? requestScope(receiptActor, scope.authority, id, key!) : null;
          const work = async () => {
          let previous = identity ? await reserve(client, identity) : null;
          if (placing) {
            await assertCurrentActor(tx.db, requestActor, true);
            const current = await resolveUserCreationActor(tx.db, input, requestActor,id);
            if (current.space_id !== actor.space_id) throw new OperationError('operation_conflict', 409);
          }
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
          const policyRequest: PolicyCheckRequest = {
            action: d.policy_action,
            force_record: true,
            actor_type: actor.principal.kind,
            actor_id: actor.principal.id,
            space_id: storageSpace,
            resource_space_id: storageSpace,
            resource_type: scope.resourceType,
            resource_id: scope.resourceId,
            run_id: actor.run_id,
            context: {
              ...item.policyContext?.(input, actor, scope),
              action_id: id,
              trigger_origin: actor.effective_origin,
              instructed_by_user_id: actor.on_behalf_of_user_id
            },
            metadata_json: {
              operation_request_id: requestId,
              ...(placing ? {request_space_id:requestActor.space_id} : {})
            }
          };
          if (command) failureAudit = policyRequest;
          const policy = await enforce({
            ...this.config,
            auditTransaction: command ? tx.db : getOperationAuditPool(this.config.databaseUrl!)
          }, await loadActionRegistry(this.config), policyRequest);
          decisionId = policy.policy_decision_record_id ?? null;
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
            }
            if ('error' in body) body.error.request_id = requestId;
            return finish(response(body, previous.http_status!, true));
          }
          if (version !== undefined && version !== d.version) throw new OperationError('operation_version_unsupported', 409);
          if (policy.decision?.decision === 'require_approval' || item.approval?.mode === 'proposal_submission') {
            if (!identity || !item.approval || policy.decision?.decision === 'require_approval' && policy.decision.policy_rule_id !== item.approval.gate.policy_rule_id) throw new OperationError('operation_approval_mapping_unavailable', 503);
            const preconditions = await runOperationWork(()=>item.approval!.preconditions(tx.db, input, actor));
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
            const output = await runOperationWork(() => item.execute(tx.db, input, actor,
              Object.freeze({requestId,idempotencyKey:key??null})));
            const validated = d.output_schema.safeParse(output);
            if (!validated.success) throw new OperationError('operation_invalid_output', 500);
            await runOperationWork(async()=>item.authorizeResult?.(tx.db, validated.data, actor));
            if (!command && item.readAudit) await withTransaction(getOperationAuditPool(this.config.databaseUrl!), audit => item.readAudit!({
              recordReads: (resourceType, resourceIds) => new ContentAccessAuditService(audit).recordReads({
                spaceId: actor.space_id,
                resourceType,
                resourceIds,
                viewerUserId: actor.on_behalf_of_user_id!,
                agentId: actor.agent_id,
                runId: actor.run_id,
                accessType: 'operation_query'
              })
            }, input, validated.data, actor, output)).catch(() => {
              throw new OperationError('operation_audit_unavailable', 503, true);
            });
            const body: OperationOutcome = {
              status: 'succeeded',
              data: validated.data
            };
            const successStatus=typeof item.successStatus==='function'?item.successStatus(validated.data):item.successStatus??200;
            if (identity) await record(client, identity, d.version, hash, 'succeeded', body, successStatus);
            await terminalOwner?.finish();
            if (command && item.afterCommit) notification = () => item.afterCommit!(validated.data, actor);
            return finish(response(body, successStatus));
          } catch (caught) {
            // Domain adapters explicitly classify deterministic, safe failures. Unknown errors stay internal.
            const error = caught instanceof OperationError ? caught : item.classifyError?.(caught) ?? caught;
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
            throw error instanceof OperationError ? error : item.classifyError?.(error) ?? error;
          }
        } finally {
          terminalOwner?.close();
          tx.close();
        }
      });
      const committed=await(item.runTerminalOwner||item.policyAuditRecovery?withPolicyAuditRecovery(this.config.databaseUrl,transaction):transaction());
      try {
        await notification?.();
      } catch {/* Notifications are rebuildable; never turn committed business work into failure. */}
      return committed;
    } catch (error) {
      const code = (error as {
        code?: string;
      })?.code;
      const transient = readyToCommit || !!code && (/^(08|ECONN|ETIMEDOUT)/.test(code) || ['40001', '40P01', '55P03', '57P01'].includes(code));
      const e = error instanceof OperationError ? error : [403, 404].includes((error as {
        statusCode?: number;
      })?.statusCode ?? 0) ? hidden() : new OperationError(transient ? 'operation_temporarily_unavailable' : 'operation_internal_error', transient ? 503 : 500, transient);
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
