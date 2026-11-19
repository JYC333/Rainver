import { proposalReportDependencies as proposalReportDependenciesSync } from "../retrieval/proposalReportDependencies.js";
import {CodePatchDecisionRefusal} from '../projectFolders/codePatchDecisionErrors.js';
import {codePatchDecisionAudit,codePatchEffectReceipt} from '../projectFolders/codePatchEffectContext.js';
import {assertCurrentActor,sessionActor} from '../systemActions/operations/actor.js';
import {assertProposalTransaction,withCheckpointDecisionOwner,lockProposalTransitions} from '../systemActions/operations/proposalTransitions.js';
import {OperationError} from '../systemActions/operations/errors.js';
import {pluginProposalContributor} from '../plugins/proposalContributions.js';
import {operationProposalService,durablyLinked} from "../systemActions/operations/approvals.js";
import {pluginOperations} from "../plugins/operationRegistry.js";
import { isPolicyAuditRecoveryActive, withPolicyAuditRecovery } from "../policy/auditWriter.js";
import type {ProposalDecisionHooks} from "./decisionHooks.js";
import { isProjectOwnerLevel } from "../projects/access.js";
import { randomUUID } from "node:crypto";
import * as protocol from "@rainver/protocol";
import type { PoolClient } from "../../db/pool.js";
import type { ServerConfig } from "../../config.js";
import { getDbPool } from "../../db/pool.js";
import { contentDecisionFromDb } from "../access/contentAccessQuery.js";
import { roomRunReadAccessSql } from "../access/contentAccessSql.js";
import {
  enforceProposalApply,
  type EnforceResult,
} from "../policy/service.js";
import { ProposalRiskLevelError } from "../policy/gateway.js";
import {
  createDefaultProposalApplierRegistry,
  type ProposalApplierContributor,
  type ProposalApplierRegistry,
  type ProposalApplyResult,
} from "./applierRegistry.js";
import {
  PgProposalRepository,
} from "./repository.js";
import { proposalActivityAudience } from "./decisionActivity.js";
import { PgSnapshotStore } from "../projectFolders/snapshotStore.js";
import { prepareCodePatchPlan } from "../projectFolders/codePatch.js";
import { HttpError,type Queryable } from "../routeUtils/common.js";
import { MemoryAudienceError, MemoryOperatorEditRequiredError } from "../memory/memoryApplyRepository.js";
import type {
  ProposalAcceptOut,
  ProposalAcceptResultType,
  ProposalApprovalOut,
  ProposalOut,
} from "@rainver/protocol";
import { ActionApprovalGrantService } from "../policy/actionApprovalGrantService.js";
import { EvolutionSignalEmitter } from "../evolution/signalEmitters.js";
import { memoryProposalDecider, type MemoryProposalDecider } from "../memory/memoryProposalDecider.js";
import { OWNER_ONLY_PROPOSAL_TYPES } from "../ontology/entities.js";

/**
 * The accept response is a union discriminated on `result_type`, and the
 * applier registry types its payload only as an object, so the boundary parses
 * rather than asserts. This is also the one place a protocol schema validates
 * a server response, which is what keeps the typed members honest: an applier
 * that stops returning what its contract declares fails here instead of
 * quietly reaching the client.
 */
async function acceptOut(
  proposal: ProposalOut,
  result: { result_type: ProposalAcceptResultType; result: Record<string, unknown> },
): Promise<ProposalAcceptOut> {
  return protocol.ProposalAcceptOutSchema.parse({
    proposal,
    result_type: result.result_type,
    result: result.result,
  }) as ProposalAcceptOut;
}

export class ProposalApplyHttpError extends Error {
  constructor(
    readonly statusCode: number,
    readonly detail: unknown,
  ) {
    super(typeof detail === "string" ? detail : "proposal apply failed");
    this.name = "ProposalApplyHttpError";
  }
}

async function roomRunReadableForUser(
  client: Queryable,
  proposal: Pick<ApplyProposalRow, "created_by_run_id" | "space_id">,
  userId: string,
): Promise<boolean> {
  // Ordinary proposals have no originating Run and therefore have no Room
  // membership boundary to re-check. Avoid an unnecessary SQL probe here and
  // keep the Room-specific predicate limited to inherited Run output.
  if (!proposal.created_by_run_id) return true;
  const result = await client.query<{ allowed: boolean }>(
    `SELECT ${roomRunReadAccessSql("$1", "$2", "$3")} AS allowed`,
    [proposal.created_by_run_id, proposal.space_id, userId],
  );
  return result.rows[0]?.allowed === true;
}

type ProposalDecisionKind = "accept" | "reject" | "rollback" | "egress_approval";

/** The state each decision acts on. */
const DECISION_STATUS: Record<ProposalDecisionKind, string> = {
  accept: "pending",
  reject: "pending",
  egress_approval: "pending",
  rollback: "accepted",
};

/**
 * The one reach rule for deciding a proposal: it is in this Space, in the
 * state the decision acts on, readable to the person, and — for a Run's
 * proposal — inside a Room the person can read. What each decision needs on
 * top (apply authority, reject authority, taint ownership, the patch's own
 * checks) stays with the decision.
 */
async function authorizeProposalDecision(
  client: Queryable,
  proposal: ApplyProposalRow | null,
  identity: { spaceId: string; userId: string },
  kind: ProposalDecisionKind,
  expectedStatus = DECISION_STATUS[kind],
): Promise<ApplyProposalRow | null> {
  if (!proposal || proposal.space_id !== identity.spaceId || proposal.status !== expectedStatus) return null;
  if ((await contentDecisionFromDb(client, identity, "proposal", proposal.id)) === "deny") return null;
  if (!(await roomRunReadableForUser(client, proposal, identity.userId))) return null;
  return proposal;
}

/**
 * The files an accepted code patch wrote, with the hash of what it wrote,
 * recorded at apply. A patch without that record cannot show its files are
 * untouched, so it is not rolled back.
 */
function appliedCodePatchFiles(payload: Record<string, unknown> | null): Array<{ path: string; sha256: string }> {
  const files = Array.isArray(payload?.applied_files) ? payload.applied_files as unknown[] : [];
  const parsed = files.flatMap((file) => {
    const row = file as { path?: unknown; sha256?: unknown } | null;
    return typeof row?.path === "string" && typeof row.sha256 === "string"
      ? [{ path: row.path, sha256: row.sha256 }]
      : [];
  });
  if (parsed.length === 0 || parsed.length !== files.length) {
    throw new ProposalApplyHttpError(409, "This code patch has no record of what it wrote, so it cannot be rolled back safely");
  }
  return parsed;
}

interface ProposalAcceptOptions {
  confirmIncompletePatch?: boolean;
  /** Only the bundle coordinator may apply a proposal while it owns the member row. */
  allowBundleMemberDecision?: boolean;
  /**
   * The person deciding directly (`isPersonActingDirectly`: their own web or API call, no Agent, Run
   * or continuation). Required for an owner-only card (`OWNER_ONLY_PROPOSAL_TYPES`); see
   * `assertOwnerCardDecision`.
   */
  ownerCardDecision?: boolean;
}

type ProposalTransactionCallback = () => Promise<void>;

export interface ProposalTransactionResult<T> {
  outcome: T;
  /** Compensate external side effects if the owning transaction cannot commit. */
  rollback?: () => Promise<void>;
  /** Advisory work that runs only after a successful COMMIT. */
  postCommit?: () => Promise<void>;
}

interface ApplyProposalRow {
  id: string;
  space_id: string;
  proposal_type: string;
  status: string;
  risk_level: string | null;
  preview: boolean;
  payload_json: Record<string, unknown> | null;
  project_folder_id: string | null;
  visibility: string;
  created_by_user_id: string | null;
  owner_user_id: string | null;
  created_by_agent_id: string | null;
  created_by_run_id: string | null;
  project_id: string | null;
  title: string | null;
  required_approver_role: string | null;
  /** Derived expiry (pending past `expires_at`): no entry may decide it. */
  expired: boolean;
}

interface GrantRow {
  id: string;
  granting_user_id: string;
  target_space_id: string;
  target_run_id: string;
  status: string;
  egress_review_expires_at: unknown;
}

interface ApprovalRow {
  id: string;
  proposal_id: string;
  approval_type: string;
  approver_user_id: string;
  grant_id: string | null;
  target_space_id: string | null;
  status: string;
  metadata_json: Record<string, unknown> | null;
  created_at: unknown;
  revoked_at: unknown;
}

export class PgProposalApplyService {
  constructor(
    private readonly config: ServerConfig,
    private readonly registry: ProposalApplierRegistry = createDefaultProposalApplierRegistry(),
    private readonly decisionHooks?: ProposalDecisionHooks,
  ) {}

  static fromConfig(
    config: ServerConfig,
    contributor?: ProposalApplierContributor,
  ): PgProposalApplyService {
    const registry=createDefaultProposalApplierRegistry(contributor??pluginProposalContributor(config));
    // The decision hooks stay installed with an empty Operation registry: an independent applier
    // (a legacy host plugin) must not bypass the durable-origin replay gate of a pruned request.
    return operationProposalService(config,registry,new Map(pluginOperations(config).map(o=>[o.definition.id,o])));
  }

  supportedProposalTypes(): ReadonlySet<string> {
    return this.registry.registeredTypes();
  }

  async accept(
    proposalId: string,
    identity: { spaceId: string; userId: string },
    options: ProposalAcceptOptions = {},
  ): Promise<ProposalAcceptOut | null> {
    return withPolicyAuditRecovery(this.config.databaseUrl, () => this.acceptDecision(proposalId, identity, options));
  }

  private async acceptDecision(
    proposalId: string,
    identity: { spaceId: string; userId: string },
    options: ProposalAcceptOptions = {},
  ): Promise<ProposalAcceptOut | null> {
    if (!this.config.databaseUrl) throw new Error("Proposal apply requires SERVER_DATABASE_URL");
    const candidate=await new PgProposalRepository(getDbPool(this.config.databaseUrl)).getVisible(identity.spaceId,identity.userId,proposalId);
    if(candidate?.proposal_type==='code_patch')return (await import('../projectFolders/codePatchDecision.js')).queueCodePatchDecision(this.config,this,proposalId,identity,'apply',options);
    const client = await this.connect();
    let transactionResult: ProposalTransactionResult<ProposalAcceptOut> | null = null;
    try {
      await client.query("BEGIN");
      if(!await this.visibleDecisionCandidate(client,proposalId,identity)){await client.query('COMMIT');return null;}
      transactionResult = await withCheckpointDecisionOwner(client,identity.spaceId,[proposalId],()=>this.acceptInTransaction(client, proposalId, identity, options),identity.userId);
      await client.query("COMMIT");
      if (transactionResult?.postCommit) await transactionResult.postCommit().catch(() => undefined);
      return transactionResult?.outcome ?? null;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      if (transactionResult?.rollback) await transactionResult.rollback().catch(() => undefined);
      throw normalizeApplyError(error);
    } finally {
      client.release();
    }
  }

  /**
   * Apply a proposal without owning BEGIN/COMMIT. The caller may use the
   * callback to update a related domain row before this transaction commits.
   * This is the transaction boundary used by evolution bundles.
   */
  /** Durable bundle intent preflight. Same canonical reach/role/risk/owner gates;
   * no applier or status write, and all policy audits join the owner's tx. */
  async prepareBundlePatchInTransaction(db:Queryable,proposalId:string,identity:{spaceId:string;userId:string}){
    const proposal=await authorizeProposalDecision(db,await this.getProposalForUpdate(db,proposalId),identity,'accept');
    if(!proposal)throw new ProposalApplyHttpError(404,'Proposal not found');
    const config={...this.config,auditTransaction:db};
    return prepareCodePatchPlan({config,db,proposal,userId:identity.userId},'bundle_prepare');
  }

  async prepareBundleDecisionInTransaction(client:Queryable,proposalId:string,identity:{spaceId:string;userId:string},decision:'approve'|'reject'){
    const proposal=await authorizeProposalDecision(client,await this.getProposalForUpdate(client,proposalId),identity,decision==='approve'?'accept':'reject');
    if(!proposal||proposal.preview)throw new ProposalApplyHttpError(404,'Proposal not found');
    if(proposal.expired)throw new ProposalApplyHttpError(409,'Proposal decision no longer available');
    if(decision==='reject'){
      if(!await canRejectProposal(client,proposal,identity.userId))throw new ProposalApplyHttpError(404,'Proposal not found');
    }else{
      if((await client.query('SELECT id FROM operation_idempotency WHERE space_id=$1 AND proposal_id=$2',[identity.spaceId,proposalId])).rows.length && !this.decisionHooks)throw new OperationError('operation_approval_mapping_unavailable',503);
      assertIncompleteCodePatchConfirmation(proposal.proposal_type,proposal.payload_json,false);
      await this.assertRequiredContextOwnerApprovals(client,proposal);
      await this.enforceApplyPolicy(client,proposal,identity.userId,true,'bundle_prepare');
    }
    return proposal;
  }

  /** Standalone intent preparation uses the same canonical gates as final apply.
   * No external filesystem check, status success or new approval is produced. */
  async authorizeCodePatchReceipt(db:Queryable,id:string,identity:{spaceId:string;userId:string}){
    if(!await this.visibleDecisionCandidate(db,id,identity))throw new ProposalApplyHttpError(404,'Proposal not found');
    const p=await this.getProposalForUpdate(db,id);if(!p||p.proposal_type!=='code_patch')throw new ProposalApplyHttpError(404,'Proposal not found');
    await assertCurrentActor(db,sessionActor(identity));
    await this.enforceApplyPolicy(db,p,identity.userId,true,'code_patch_receipt');return p;
  }

  async prepareCodePatchDecisionInTransaction(db:Queryable,id:string,identity:{spaceId:string;userId:string},phase:'apply'|'rollback',options:ProposalAcceptOptions={}){
    await assertCurrentActor(db,sessionActor(identity));
    if(phase==='rollback'&&(await lockProposalTransitions(db,identity.spaceId,[id],true)).hasAnyLinked&&!this.decisionHooks)throw new OperationError('operation_approval_mapping_unavailable',503);
    const proposal=await authorizeProposalDecision(db,await this.getProposalForUpdate(db,id),identity,phase==='apply'?'accept':'rollback');
    if(!proposal||proposal.proposal_type!=='code_patch'||proposal.preview)throw new ProposalApplyHttpError(404,'Proposal not found');
    if(phase==='apply'&&proposal.expired)throw new ProposalApplyHttpError(409,'Proposal decision no longer available');
    if(phase==='apply')await this.assertBundleMemberMayBeDecided(db,id,options.allowBundleMemberDecision===true);
    if(phase==='apply'){
      if((await db.query('SELECT id FROM operation_idempotency WHERE space_id=$1 AND proposal_id=$2',[identity.spaceId,id])).rows.length&&!this.decisionHooks)throw new OperationError('operation_approval_mapping_unavailable',503);
      if(this.decisionHooks&&await this.decisionHooks.beforeDecision(db,id,identity,'accept')!==true)throw new ProposalApplyHttpError(409,'Proposal decision no longer available');
      assertIncompleteCodePatchConfirmation(proposal.proposal_type,proposal.payload_json,options.confirmIncompletePatch===true);
      await this.assertRequiredContextOwnerApprovals(db,proposal);
    }
    await this.enforceApplyPolicy(db,proposal,identity.userId,true,'code_patch_'+phase+'_prepare');
    const atomicConfig={...this.config,auditTransaction:db};
    const plan=await prepareCodePatchPlan({config:atomicConfig,db,proposal,userId:identity.userId},phase+'_prepare');
    if(phase==='apply')return {...plan,snapshotId:null};
    const snapshot=await new PgSnapshotStore(db).getByProposal(id,identity.spaceId);
    if(!snapshot)throw new CodePatchDecisionRefusal(404,'No available snapshot found for this proposal');
    const applied=new Map(appliedCodePatchFiles(proposal.payload_json).map(f=>[f.path,f.sha256]));
    const originals=[...new Map([...snapshot.files].reverse().map(f=>[f.path,f])).values()];
    const operations:import('../projectFolders/codePatch.js').CodePatchEffectOperation[]=originals.map(file=>{
      const hash=applied.get(file.path);if(!hash)throw new ProposalApplyHttpError(409,'Snapshot does not match applied files');
      return {type:file.existed?'replace_file':'remove_file',path:file.path,content:file.content??'',...(file.encoding==='base64'?{encoding:'base64' as const}:{}),preimage_exists:true,preimage_sha256:hash};
    });
    return {...plan,operations,snapshotId:snapshot.id};
  }

  async commitCodePatchRollbackInTransaction(db:Queryable,id:string,identity:{spaceId:string;userId:string},snapshotId:string,paths:string[]){
    const receipt=codePatchEffectReceipt(id);
    if(!receipt)throw new ProposalApplyHttpError(503,'Rollback requires a durable effect receipt');
    const transitions=await lockProposalTransitions(db,identity.spaceId,[id],true);
    const plan=await this.prepareCodePatchDecisionInTransaction(db,id,identity,'rollback');
    if(plan.snapshotId!==snapshotId||receipt.root!==plan.root||receipt.protectedFolder!==plan.folder.protected)throw new CodePatchDecisionRefusal(409,'Rollback snapshot/target changed');
    const audience=proposalActivityAudience(plan.proposal,identity.userId);
    await new PgSnapshotStore(db).markRolledBack(snapshotId,identity.userId);
    await db.query("UPDATE proposals SET status='rolled_back',updated_at=now() WHERE id=$1 AND space_id=$2 AND status='accepted'",[id,identity.spaceId]);
    await db.query(`INSERT INTO activity_records (
      id,space_id,source_run_id,user_id,project_folder_id,activity_type,title,content,payload_json,
      occurred_at,created_at,status,updated_at,source_kind,source_trust,visibility,owner_user_id
    ) VALUES($1,$2,NULL,$3,$4,'proposal.code_patch.rolled_back',$5,$6,$7::jsonb,now(),now(),
      'processed',now(),'project_folder_event','internal_system',$8,$9)`,[
      randomUUID(),identity.spaceId,identity.userId,plan.proposal.project_folder_id,
      plan.proposal.title??'Code patch rolled back',`Rolled back code patch proposal ${id}.`,
      JSON.stringify({proposal_id:id,restored_paths:paths,file_count:paths.length}),audience.visibility,audience.ownerUserId]);
    await transitions.finish();return {rolled_back_paths:paths};
  }

  /** Refuses (409) accepting a report-derived Proposal whose report is not
   * releasable to the decider now (`proposalReportWithheld`). Returns the
   * checked dependency key for the post-lock comparison. */
  private async assertReportDependenciesReleasable(client: Queryable, proposalId: string, identity: { spaceId: string; userId: string }): Promise<string> {
    const row = (await client.query<{ proposal_type: string; payload_json: unknown }>(
      "SELECT proposal_type, payload_json FROM proposals WHERE space_id = $1 AND id = $2",
      [identity.spaceId, proposalId],
    )).rows[0];
    if (!row) return "";
    const { proposalReportWithheld } = await import("../retrieval/proposalReportRelease.js");
    if (await proposalReportWithheld(client, identity, row)) {
      throw new ProposalApplyHttpError(409, "The report this proposal derives from is no longer available to you");
    }
    return reportDependencyKey(row.proposal_type, row.payload_json);
  }

  async acceptInTransaction(
    client: Queryable,
    proposalId: string,
    identity: { spaceId: string; userId: string },
    options: ProposalAcceptOptions = {},
    afterApply?: ProposalTransactionCallback,
  ): Promise<ProposalTransactionResult<ProposalAcceptOut> | null> {
    let rollbackOnFailure: (() => Promise<void>) | null = null;
    try {
      if(!await this.visibleDecisionCandidate(client,proposalId,identity))return null;
      await assertOwnerCardDecision(client,proposalId,identity.spaceId,options.ownerCardDecision===true);
      // A report-derived Proposal applies findings frozen from its report; it
      // is decided only while that report is releasable to the decider. The
      // report closure (Source rows first) is pinned before the Proposal row
      // lock and held to commit; the locked payload must name the same reports.
      const reportDependencies = await this.assertReportDependenciesReleasable(client, proposalId, identity);
      if((!this.decisionHooks || !isPolicyAuditRecoveryActive()) &&
        (await client.query('SELECT id FROM operation_idempotency WHERE proposal_id=$1 AND space_id=$2',[proposalId,identity.spaceId])).rowCount)
        throw new OperationError('operation_approval_mapping_unavailable',503);
      const transitions=await lockProposalTransitions(client,identity.spaceId,[proposalId],true,!isPolicyAuditRecoveryActive());
      if(transitions.hasAnyLinked && !isPolicyAuditRecoveryActive())throw new OperationError('operation_approval_mapping_unavailable',503);
      const admitted = this.decisionHooks ? await this.decisionHooks.beforeDecision(client,proposalId,identity,"accept") : true;
      if (admitted === false) return null;
      const proposal = await authorizeProposalDecision(
        client, await this.getProposalForUpdate(client, proposalId), identity, "accept",
      );
      if (!proposal || proposal.preview) return null;
      if (admitted !== true) {
        // Decided without applying: the Proposal keeps its status; the hook's state commits.
        await transitions.finish();
        const current = await new PgProposalRepository(client).getVisible(identity.spaceId, identity.userId, proposalId);
        if (!current) return null;
        return { outcome: await acceptOut(current, admitted) };
      }
      // Derived expiry: nothing applies and the Proposal stays pending. A linked request's hook has
      // already committed its own `expired` receipt; an unlinked Proposal has no request to commit,
      // and an `operation_failure` receipt would claim a link, so it is refused outright.
      if (proposal.expired) throw new OperationError('operation_approval_expired', 409);
      if (reportDependencyKey(proposal.proposal_type, proposal.payload_json) !== reportDependencies) {
        throw new ProposalApplyHttpError(409, "The report this proposal derives from changed; review it again");
      }

      await this.assertBundleMemberMayBeDecided(client, proposal.id, options.allowBundleMemberDecision === true);
      assertIncompleteCodePatchConfirmation(
        proposal.proposal_type,
        proposal.payload_json,
        options.confirmIncompletePatch === true,
      );
      await this.assertRequiredContextOwnerApprovals(client, proposal);
      if(isMemoryProposal(proposal.proposal_type))await assertCurrentActor(client,sessionActor(identity),true);
      await this.enforceApplyPolicy(client, proposal, identity.userId,true);
      const decided=await this.decisionHooks?.beforeApply?.(client,proposalId);
      if(decided===false)return null;
      let result:ProposalApplyResult;
      const apply = (db:Queryable = client, requester?:protocol.OperationActor) => {
        const config={...this.config,auditTransaction:db};
        return this.registry.apply({
        proposalTransitions:transitions,
        config,
        db,
        proposal: {
          id: proposal.id,
          space_id: proposal.space_id,
          proposal_type: proposal.proposal_type,
          title: proposal.title,
          payload_json: proposal.payload_json,
          project_folder_id: proposal.project_folder_id,
          visibility: proposal.visibility,
          created_by_user_id: proposal.created_by_user_id,
          owner_user_id: proposal.owner_user_id,
          created_by_agent_id: proposal.created_by_agent_id,
          created_by_run_id: proposal.created_by_run_id,
          project_id: proposal.project_id,
        },
        userId: identity.userId,
        requester,
        ownerCardDecision: options.ownerCardDecision === true,
      });};
      if(decided&&typeof decided==='object')result=decided;
      else try { result = this.decisionHooks?.runApply ? await this.decisionHooks.runApply(client,proposalId,apply) : await apply(); } catch(error) {
        if(!this.decisionHooks?.applyFailed)throw error;
        result=await this.decisionHooks.applyFailed(client,proposalId,error);
      }
      await this.decisionHooks?.afterApply(client,proposalId,result);
      rollbackOnFailure = result.rollback ?? null;
      if (afterApply) await afterApply();
      await this.markProposalFinal(client, proposal, identity.userId, result.finalStatus ?? "accepted", result.proposalPayloadPatch);
      await transitions.finish();
      const accepted = await new PgProposalRepository(client).getVisible(
        identity.spaceId,
        identity.userId,
        proposalId,
      );
      if (!accepted) throw new Error("accepted proposal is not visible after apply");
      return {
        outcome: await acceptOut(accepted, result),
        rollback: rollbackOnFailure ?? undefined,
      };
    } catch (error) {
      if (rollbackOnFailure) await rollbackOnFailure().catch(() => undefined);
      rollbackOnFailure = null;
      throw normalizeApplyError(error);
    }
  }

  /** Formal decision port: typed effects or durable external-effect intent,
   * never a new transaction or a nested top-level executor. */
  async acceptOperationInTransaction(db:Queryable,id:string,identity:{spaceId:string;userId:string},options:ProposalAcceptOptions={}) {
    await assertProposalTransaction(db);
    const proposal=await this.getProposalForUpdate(db,id,false);
    if(proposal?.proposal_type==='code_patch')return (await import('../projectFolders/codePatchDecision.js')).queueCodePatchInTransaction(this.config,this,db,id,identity,'apply',options);
    return (await this.acceptInTransaction(db,id,identity,options))?.outcome??null;
  }

  async rollbackInTransaction(db:Queryable,id:string,identity:{spaceId:string;userId:string}) {
    await assertProposalTransaction(db);
    const result=await (await import('../projectFolders/codePatchDecision.js')).queueCodePatchInTransaction(this.config,this,db,id,identity,'rollback');
    return result as protocol.CodePatchDecisionReceipt|null;
  }

  /** Called after complete key admission and before Proposal rows, preserving
   * Source/report release lock order for packet and derived child writers. */
  async prepareReportDependenciesInTransaction(db:Queryable,ids:readonly string[],identity:{spaceId:string;userId:string}) {
    for(const id of [...ids].sort()){
      if(!await this.visibleDecisionCandidate(db,id,identity))throw new ProposalApplyHttpError(404,'Proposal not found');
      await this.assertReportDependenciesReleasable(db,id,identity);
    }
  }

  async authorizeBundleOperationInTransaction(db:Queryable,ids:readonly string[],identity:{spaceId:string;userId:string},decision:'approve'|'reject') {
    await assertProposalTransaction(db);
    for(const id of [...ids].sort()) {
      const proposal=await this.getProposalForUpdate(db,id,false);
      if(!proposal || !await this.visibleDecisionCandidate(db,id,identity) || proposal.preview)throw new ProposalApplyHttpError(404,'Proposal not found');
      if(proposal.project_id)await db.query('SELECT id FROM projects WHERE id=$1 AND space_id=$2 FOR SHARE',[proposal.project_id,identity.spaceId]);
      if(decision==='reject') {if(!await canRejectProposal(db,proposal,identity.userId))throw new ProposalApplyHttpError(404,'Proposal not found');}
      else await this.enforceApplyPolicy(db,proposal,identity.userId,true,'bundle_operation_authorize');
    }
  }

  /** Recheck the rollback's own authority on replay, never member approval roles. */
  async authorizeBundleRollbackOperationInTransaction(db:Queryable,bundleId:string,identity:{spaceId:string;userId:string}) {
    await assertProposalTransaction(db);
    const row=(await db.query<{id:string}>(`SELECT id FROM proposals WHERE space_id=$1
      AND proposal_type='evolution_bundle_rollback' AND payload_json->>'bundle_id'=$2
      AND status IN ('pending','accepted') ORDER BY created_at DESC,id DESC LIMIT 1`,[identity.spaceId,bundleId])).rows[0];
    if(!row)return; // First execution creates and authorizes the canonical rollback Proposal.
    const proposal=await this.getProposalForUpdate(db,row.id,false);
    if(!proposal||!await this.visibleDecisionCandidate(db,row.id,identity))throw new ProposalApplyHttpError(404,'Proposal not found');
    await this.enforceApplyPolicy(db,proposal,identity.userId,true,'bundle_rollback_operation_authorize');
  }

  async authorizeAcceptOperationInTransaction(db:Queryable,id:string,identity:{spaceId:string;userId:string},replay=false,stored:{resultType?:string}={}) {
    await assertProposalTransaction(db);
    const proposal=await this.getProposalForUpdate(db,id,false);
    if(!proposal || !await this.visibleDecisionCandidate(db,id,identity) || proposal.preview || !['pending','accepted','superseded','rolled_back'].includes(proposal.status))throw new ProposalApplyHttpError(404,'Proposal not found');
    await assertCurrentActor(db,sessionActor(identity),true);
    if(proposal.project_id)await db.query('SELECT id FROM projects WHERE id=$1 AND space_id=$2 FOR SHARE',[proposal.project_id,identity.spaceId]);
    await this.enforceApplyPolicy(db,proposal,identity.userId,true,'operation_accept_authorize');
    // The stored accept body carries the linked operation's result: release it only through that result's live gate.
    if(replay)await this.decisionHooks?.authorizeAcceptReplay?.(db,id,identity,stored);
  }

  async authorizeRollbackOperationInTransaction(db:Queryable,id:string,identity:{spaceId:string;userId:string},replay=false) {
    await assertProposalTransaction(db);
    const proposal=await this.getProposalForUpdate(db,id,false);
    if(!proposal || proposal.proposal_type!=='code_patch' || !await this.visibleDecisionCandidate(db,id,identity) || proposal.preview || !['accepted','rolled_back'].includes(proposal.status))throw new ProposalApplyHttpError(404,'Proposal not found');
    await assertCurrentActor(db,sessionActor(identity),true);
    if(proposal.project_id)await db.query('SELECT id FROM projects WHERE id=$1 AND space_id=$2 FOR SHARE',[proposal.project_id,identity.spaceId]);
    await this.enforceApplyPolicy(db,proposal,identity.userId,true,'operation_rollback_authorize');
  }

  async acceptAgentProposalIfGranted(
    proposalId: string,
    action: { actionId: string; projectId?: string | null; resourceKind?: string | null; resourceId?: string | null },
  ): Promise<ProposalAcceptOut | null> {
    const client = await this.connect();
    let rollbackOnFailure: (() => Promise<void>) | null = null;
    try {
      await client.query("BEGIN");
      const scope=(await client.query<{space_id:string}>('SELECT space_id FROM proposals WHERE id=$1',[proposalId])).rows[0];
      if(!scope){await client.query('ROLLBACK');return null;}
      const transitions=await lockProposalTransitions(client,scope.space_id,[proposalId],true);
      // A pruned request leaves only its durable marker; a grant never decides an operation approval.
      if(transitions.hasAnyLinked||await durablyLinked(client,proposalId,scope.space_id))throw new OperationError('operation_approval_mapping_unavailable',503);
      const proposal = await this.getProposalForUpdate(client, proposalId);
      // A standing action grant never decides an owner-only card (`assertOwnerCardDecision`).
      if (!proposal || proposal.status !== "pending" || proposal.expired || proposal.preview || !proposal.created_by_agent_id || isOwnerOnlyProposal(proposal)) {
        await client.query("ROLLBACK");
        return null;
      }
      await this.assertBundleMemberMayBeDecided(client, proposal.id, false);
      const { loadSystemActionRegistry } = await import("../systemActions/registry.js");
      const definition = (await loadSystemActionRegistry(this.config)).get(action.actionId);
      const payloadActionId = proposal.payload_json?.action_id;
      if (
        !definition
        || !definition.grantable
        || !definition.proposal_type
        || payloadActionId !== action.actionId
        || definition.proposal_type !== proposal.proposal_type
        || (action.projectId != null && action.projectId !== proposal.project_id)
      ) {
        await client.query("ROLLBACK");
        return null;
      }
      const grant = await new ActionApprovalGrantService(client,this.config).consumeMatching({
        spaceId: proposal.space_id,
        agentId: proposal.created_by_agent_id,
        actionId: action.actionId,
        runId: proposal.created_by_run_id,
        projectId: action.projectId ?? proposal.project_id,
        resourceKind: action.resourceKind,
        resourceId: action.resourceId,
      });
      if (!grant) { await client.query("ROLLBACK"); return null; }
      const grantId = String(grant.id);
      const grantingUserId = String(grant.granted_by_user_id);
      await this.enforceApplyPolicy(client, proposal, grantingUserId);
      const result = await this.registry.apply({ config: this.config, db: client, proposal: {
        id: proposal.id, space_id: proposal.space_id, proposal_type: proposal.proposal_type,
        title: proposal.title, payload_json: proposal.payload_json, project_folder_id: proposal.project_folder_id,
        visibility: proposal.visibility, created_by_user_id: proposal.created_by_user_id,
        owner_user_id: proposal.owner_user_id,
        created_by_agent_id: proposal.created_by_agent_id,
        created_by_run_id: proposal.created_by_run_id, project_id: proposal.project_id,
      }, userId: grantingUserId });
      rollbackOnFailure = result.rollback ?? null;
      await client.query(
        `INSERT INTO proposal_approvals (id, proposal_id, approval_type, approver_user_id, action_grant_id, status, metadata_json, created_at)
         VALUES ($1,$2,'action_grant',$3,$4,'approved',$5::jsonb,$6)`,
        [randomUUID(), proposal.id, grantingUserId, grantId, JSON.stringify({ approval_source: `action_grant:${grantId}`, action_id: action.actionId }), new Date().toISOString()],
      );
      await this.markProposalFinal(client, proposal, grantingUserId, result.finalStatus ?? "accepted", result.proposalPayloadPatch);
      await transitions.finish();
      const accepted = await new PgProposalRepository(client).getVisible(proposal.space_id, grantingUserId, proposal.id);
      if (!accepted) throw new Error("accepted proposal is not visible after grant apply");
      await client.query("COMMIT");
      return await acceptOut(accepted, result);
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      if (rollbackOnFailure) await rollbackOnFailure().catch(() => undefined);
      throw error;
    }
    finally { client.release(); }
  }

  async reject(
    proposalId: string,
    identity: { spaceId: string; userId: string },
  ): Promise<ProposalOut | null> {
    return withPolicyAuditRecovery(this.config.databaseUrl, () => this.rejectDecision(proposalId, identity));
  }

  private async rejectDecision(
    proposalId: string,
    identity: { spaceId: string; userId: string },
  ): Promise<ProposalOut | null> {
    const client = await this.connect();
    try {
      await client.query("BEGIN");
      const rejected = await this.rejectTransaction(client, proposalId, identity);
      if (!rejected) {
        await client.query("COMMIT");
        return null;
      }
      await client.query("COMMIT");
      if (rejected.postCommit) await rejected.postCommit().catch(() => undefined);
      return rejected.outcome;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw normalizeApplyError(error);
    } finally {
      client.release();
    }
  }

  /** Formal public rejection preserves the canonical Bundle gate. */
  async rejectOperationInTransaction(client:Queryable,proposalId:string,identity:{spaceId:string;userId:string},ownerCardDecision=false) {
    return this.rejectTransaction(client,proposalId,identity,undefined,false,ownerCardDecision);
  }

  async authorizeRejectOperationInTransaction(client:Queryable,proposalId:string,identity:{spaceId:string;userId:string},replay=false) {
    await assertProposalTransaction(client);
    if(!await this.visibleDecisionCandidate(client,proposalId,identity))throw new ProposalApplyHttpError(404,'Proposal not found');
    if(!replay)await lockProposalTransitions(client,identity.spaceId,[proposalId],true,false);
    const candidate=await this.getProposalForUpdate(client,proposalId);
    if(!candidate || !(replay?['rejected']:['pending','rejected']).includes(candidate.status))throw new ProposalApplyHttpError(404,'Proposal not found');
    const proposal=await authorizeProposalDecision(client,candidate,identity,'reject',candidate.status);
    if(!proposal)throw new ProposalApplyHttpError(404,'Proposal not found');
    if(proposal.project_id)await client.query('SELECT id FROM projects WHERE id=$1 AND space_id=$2 FOR NO KEY UPDATE',[proposal.project_id,identity.spaceId]);
    if(!await canRejectProposal(client,proposal,identity.userId))throw new ProposalApplyHttpError(404,'Proposal not found');
    await this.assertBundleMemberMayBeDecided(client,proposal.id,false);
  }

  async afterRejectOperationCommit(proposal:ProposalOut) {
    await this.emitDecisionSignalBestEffort({spaceId:proposal.space_id,proposalId:proposal.id,status:'rejected',proposalType:proposal.proposal_type,createdByRunId:proposal.created_by_run_id??null});
  }

  async rejectInTransaction(
    client: Queryable,
    proposalId: string,
    identity: { spaceId: string; userId: string },
    afterReject?: ProposalTransactionCallback,
  ): Promise<ProposalTransactionResult<ProposalOut> | null> {
    const rejected = await this.rejectTransaction(client, proposalId, identity, afterReject, true);
    return rejected;
  }

  private async rejectTransaction(
    client: Queryable,
    proposalId: string,
    identity: { spaceId: string; userId: string },
    afterReject?: ProposalTransactionCallback,
    allowBundleMemberDecision = false,
    ownerCardDecision = false,
  ): Promise<ProposalTransactionResult<ProposalOut> | null> {
    if(!await this.visibleDecisionCandidate(client,proposalId,identity))return null;
    await assertOwnerCardDecision(client,proposalId,identity.spaceId,ownerCardDecision);
    if(!isPolicyAuditRecoveryActive() &&
      (await client.query('SELECT id FROM operation_idempotency WHERE proposal_id=$1 AND space_id=$2',[proposalId,identity.spaceId])).rowCount)
      throw new OperationError('operation_approval_mapping_unavailable',503);
    const transitions=await lockProposalTransitions(client,identity.spaceId,[proposalId],true,!isPolicyAuditRecoveryActive());
    if(this.decisionHooks && await this.decisionHooks.beforeDecision(client,proposalId,identity,"reject")!==true)return null;
    const proposal = await authorizeProposalDecision(
      client, await this.getProposalForUpdate(client, proposalId), identity, "reject",
    );
    if (!proposal || !(await canRejectProposal(client, proposal, identity.userId))) return null;
    // An expired Proposal is no longer decided (a linked one's hook has already refused it).
    if (proposal.expired) throw new OperationError('operation_approval_expired', 409);
    await this.assertBundleMemberMayBeDecided(client, proposal.id, allowBundleMemberDecision);
    const updated = await client.query(
      `UPDATE proposals
          SET status = 'rejected', reviewed_at = $3, reviewed_by = $4, updated_at = $3
        WHERE id = $1 AND space_id = $2 AND status = 'pending'`,
      [proposalId, identity.spaceId, new Date().toISOString(), identity.userId],
    );
    if ((updated.rowCount ?? 0) === 0) return null;
    await releaseRejectedCustomSourceHandlerVersion(client, proposalId, identity.spaceId);
    await releaseRejectedSourceRecipeVersion(client, proposalId, identity.spaceId);
    await releaseRejectedSourceChannelDraft(client, proposal);
    await releaseRejectedSourceBackfillPlan(client, proposal);
    await this.decisionHooks?.afterReject(client,proposalId);
    if (afterReject) await afterReject();
    await transitions.finish();
    const out = await new PgProposalRepository(client).getVisible(identity.spaceId, identity.userId, proposalId);
    if (!out) throw new Error("rejected proposal is not visible after reject");
    return {
      outcome: out,
      postCommit: () => this.emitDecisionSignalBestEffort({
        spaceId: identity.spaceId,
        proposalId,
        status: "rejected",
        proposalType: proposal.proposal_type,
        createdByRunId: proposal.created_by_run_id,
      }),
    };
  }

  async approveEgressGrantingUser(
    proposalId: string,
    identity: { spaceId: string; userId: string },
    grantIdInput: string | null,
  ): Promise<ProposalApprovalOut> {
    const client = await this.connect();
    try {
      await client.query("BEGIN");
      const approval = await this.approveEgressGrantingUserInTransaction(client, proposalId, identity, grantIdInput);
      await client.query("COMMIT");
      return approval;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  /** Join the caller's transaction; the consent belongs to identity.userId,
   * independently of the Proposal's requester or eventual decider. */
  async approveEgressGrantingUserInTransaction(
    client: Queryable,
    proposalId: string,
    identity: { spaceId: string; userId: string },
    grantIdInput: string | null,
  ): Promise<ProposalApprovalOut> {
    const consent = await this.authorizeEgressConsentInTransaction(client, proposalId, identity, grantIdInput);
    return approvalToOut(await this.upsertEgressApproval(client, consent.proposal, identity.userId,
      consent.grantId, consent.metadata, consent.targetSpaceId));
  }

  /** Read and pin current consent authority on every invocation, including replay.
   * Never publishes or accepts the Proposal and never substitutes its requester. */
  async authorizeEgressConsentInTransaction(
    client: Queryable,
    proposalId: string,
    identity: { spaceId: string; userId: string },
    grantIdInput: string | null,
  ) {
    await assertProposalTransaction(client);
    await assertCurrentActor(client, sessionActor(identity), true);
    const proposal = await authorizeProposalDecision(
      client, await this.getProposalForUpdate(client, proposalId), identity, "egress_approval",
    );
    if (!proposal) throw new ProposalApplyHttpError(404, "Proposal not found");
    // Consent toward an expired Proposal decides nothing and is refused like accept/reject,
    // first use and keyed replay alike; no approval row is written.
    if (proposal.expired) throw new OperationError('operation_approval_expired', 409);
    const taintOwnerApprovers = requiredTaintOwnerApprovers(proposal.payload_json);
    if (taintOwnerApprovers.length > 0) {
      if (!taintOwnerApprovers.includes(identity.userId)) {
        throw new ProposalApplyHttpError(403, "only a required taint owner can approve this egress");
      }
      if (grantIdInput) {
        throw new ProposalApplyHttpError(422, "grant_id must be omitted for context-taint owner approval");
      }
      return { proposal, grantId: null, targetSpaceId: proposal.space_id, metadata: {
        approval_type: "egress_granting_user",
        approval_source: "context_taint_owner",
        raw_private_memory_included: false,
        personal_summary_persisted: false,
      } };
    }
    const grantId = grantIdInput ?? await this.inferGrantId(client, proposal);
    if (!grantId) throw new ProposalApplyHttpError(422, "grant_id is required");
    const grant = await this.getGrant(client, grantId);
    if (!grant) throw new ProposalApplyHttpError(403, "grant not found");
    this.validateGrantApproval(proposal, grant, identity.userId, grantId);
    return { proposal, grantId, targetSpaceId: grant.target_space_id, metadata: {
      approval_type: "egress_granting_user",
      raw_private_memory_included: false,
      personal_summary_persisted: false,
    } };
  }

  private async upsertEgressApproval(
    client: Queryable,
    proposal: ApplyProposalRow,
    userId: string,
    grantId: string | null,
    metadata: Record<string, unknown>,
    targetSpaceId: string = proposal.space_id,
  ): Promise<ApprovalRow> {
      const existing = await client.query<ApprovalRow>(
        `SELECT id, proposal_id, approval_type, approver_user_id, grant_id,
                target_space_id, status, metadata_json, created_at, revoked_at
           FROM proposal_approvals
          WHERE proposal_id = $1
            AND approval_type = 'egress_granting_user'
            AND approver_user_id = $2
            AND grant_id IS NOT DISTINCT FROM $3
            AND status = 'approved'
            AND revoked_at IS NULL
          ORDER BY created_at DESC
          LIMIT 1`,
        [proposal.id, userId, grantId],
      );
      let approval = existing.rows[0];
      if (!approval) {
        const inserted = await client.query<ApprovalRow>(
          `INSERT INTO proposal_approvals
             (id, proposal_id, approval_type, approver_user_id, grant_id,
              target_space_id, status, metadata_json, created_at, revoked_at)
           VALUES ($1, $2, 'egress_granting_user', $3, $4, $5, 'approved',
                   $6::jsonb, $7, NULL)
           RETURNING id, proposal_id, approval_type, approver_user_id, grant_id,
                     target_space_id, status, metadata_json, created_at, revoked_at`,
          [
            randomUUID(),
            proposal.id,
            userId,
            grantId,
            targetSpaceId,
            JSON.stringify(metadata),
            new Date().toISOString(),
          ],
        );
        approval = inserted.rows[0]!;
      }
      return approval;
  }

  async rollback(proposalId:string,identity:{spaceId:string;userId:string}):Promise<import('@rainver/protocol').CodePatchDecisionReceipt|null>{
    return (await import('../projectFolders/codePatchDecision.js')).queueCodePatchRollback(this.config,this,proposalId,identity);
  }

  private async connect(): Promise<PoolClient> {
    if (!this.config.databaseUrl) {
      throw new Error("Proposal apply requires SERVER_DATABASE_URL");
    }
    return getDbPool(this.config.databaseUrl).connect();
  }

  private async emitDecisionSignalBestEffort(input: {
    spaceId: string;
    proposalId: string;
    status: string;
    proposalType: string | null;
    createdByRunId: string | null;
  }): Promise<void> {
    if (!this.config.databaseUrl) return;
    try {
      await new EvolutionSignalEmitter(getDbPool(this.config.databaseUrl)).emitProposalDecision(input);
    } catch {
      // Evolution telemetry is advisory and must not change a committed
      // proposal decision into an API failure.
    }
  }

  private async visibleDecisionCandidate(client:Queryable,id:string,identity:{spaceId:string;userId:string}):Promise<boolean>{
    const proposal=await this.getProposalForUpdate(client,id,false);
    if(!proposal || proposal.space_id!==identity.spaceId)return false;
    if((await client.query('SELECT id FROM operation_idempotency WHERE proposal_id=$1 AND space_id=$2',[id,identity.spaceId])).rowCount)
      await assertCurrentActor(client,sessionActor(identity));
    return (await contentDecisionFromDb(client,identity,"proposal",id))!=="deny"
      && await roomRunReadableForUser(client,proposal,identity.userId);
  }

  private async getProposalForUpdate(
    client: Queryable,
    proposalId: string,
    lock=true,
  ): Promise<ApplyProposalRow | null> {
    const result = await client.query<ApplyProposalRow>(
      `SELECT proposal.id, proposal.space_id, proposal.proposal_type,
              proposal.status, proposal.risk_level, proposal.preview,
              proposal.payload_json, proposal.project_folder_id,
              proposal.created_by_user_id, proposal.owner_user_id, proposal.created_by_agent_id,
              proposal.created_by_run_id, proposal.visibility,
              proposal.project_id, proposal.title,
              proposal.required_approver_role,
              (proposal.status = 'pending' AND proposal.expires_at IS NOT NULL
                AND proposal.expires_at <= now()) AS expired
         FROM proposals proposal
        WHERE proposal.id = $1
        ${lock?"FOR UPDATE":""}`,
      [proposalId],
    );
    return result.rows[0] ?? null;
  }

  private async markProposalFinal(
    client: Queryable,
    proposal: ApplyProposalRow,
    userId: string,
    status: "accepted" | "superseded",
    payloadPatch?: Record<string, unknown>,
  ): Promise<void> {
    const now = new Date().toISOString();
    if (payloadPatch) {
      await client.query(
        `UPDATE proposals
            SET status = $6,
                reviewed_at = COALESCE(reviewed_at, $3),
                reviewed_by = COALESCE(reviewed_by, $4),
                payload_json = $5::jsonb,
                updated_at = $3
          WHERE id = $1
            AND space_id = $2
            AND status = 'pending'`,
        [proposal.id, proposal.space_id, now, userId, JSON.stringify(payloadPatch), status],
      );
    } else {
      await client.query(
        `UPDATE proposals
            SET status = $5,
                reviewed_at = COALESCE(reviewed_at, $3),
                reviewed_by = COALESCE(reviewed_by, $4),
                updated_at = $3
          WHERE id = $1
            AND space_id = $2
            AND status = 'pending'`,
        [proposal.id, proposal.space_id, now, userId, status],
      );
    }
  }

  private async enforceApplyPolicy(
    client: Queryable,
    proposal: ApplyProposalRow,
    userId: string,
    linkedClosure=false,
    phase='apply',
  ): Promise<void> {
    await assertRequiredOwnerMayDecide(client, proposal, userId);
    const role = await effectiveApproverRole(client, proposal, userId);
    const result = await enforceProposalApply(
      (linkedClosure || !!codePatchEffectReceipt(proposal.id) || await this.decisionHooks?.usesAtomicAudit?.(client,proposal.id)) ? {...this.config,auditTransaction:client} : this.config,
      {
        user_id: userId,
        space_id: proposal.space_id,
        proposal_id: proposal.id,
        proposal_type: proposal.proposal_type,
        declared_risk: proposal.risk_level,
        required_approver_role: proposal.required_approver_role,
        proposal_payload: proposal.payload_json,
        metadata_json: { server_apply: true,decision_phase:phase,...codePatchDecisionAudit() },
        private_owner_decision: isOwnerOnlyProposal(proposal) && proposal.visibility === "private" && proposal.owner_user_id === userId,
      },
      role,
      this.registry.registeredTypes(),
    ).catch(error=>{throw normalizeApplyError(error);});
    if (result.status !== "allow") {
      if(proposal.proposal_type==='code_patch'&&result.status!=='error')throw new CodePatchDecisionRefusal(403,'Code patch decision refused by policy');
      throw policyResultToHttpError(result);
    }
  }

  private async assertBundleMemberMayBeDecided(
    client: Queryable,
    proposalId: string,
    allowedByBundleCoordinator: boolean,
  ): Promise<void> {
    if (allowedByBundleCoordinator) return;
    const result = await client.query<{ bundle_id: string }>(
      `SELECT bm.bundle_id
         FROM evolution_bundle_members bm
         JOIN evolution_bundles b ON b.id = bm.bundle_id
        WHERE bm.proposal_id = $1
          AND bm.status = 'pending'
          AND b.status IN ('pending_review', 'partially_approved')
        LIMIT 1`,
      [proposalId],
    );
    if (result.rows[0]) {
      throw new ProposalApplyHttpError(409, {
        code: "proposal_bundled",
        bundle_id: result.rows[0].bundle_id,
        message: "This proposal is owned by an active evolution bundle; decide it from the bundle inbox.",
      });
    }
  }

  private async inferGrantId(
    client: Queryable,
    proposal: ApplyProposalRow,
  ): Promise<string | null> {
    const payload = proposal.payload_json ?? {};
    const grantId = stringValue(payload.grant_id);
    if (grantId) return grantId;
    const grantIds = payload.personal_memory_grant_ids;
    if (Array.isArray(grantIds) && grantIds.length === 1 && typeof grantIds[0] === "string") {
      return grantIds[0];
    }
    const sourceRunId = stringValue(payload.source_run_id) ?? proposal.created_by_run_id;
    if (!sourceRunId) return null;
    const run = await client.query<{ grant_id: string | null }>(
      `SELECT context_taint_json->'personal_memory_grant_ids'->>0 AS grant_id
         FROM runs
        WHERE id = $1`,
      [sourceRunId],
    );
    return run.rows[0]?.grant_id ?? null;
  }

  private async assertRequiredContextOwnerApprovals(
    client: Queryable,
    proposal: ApplyProposalRow,
  ): Promise<void> {
    const requiredOwners = requiredTaintOwnerApprovers(proposal.payload_json);
    if (requiredOwners.length === 0) return;
    const approved = await client.query<{ approver_user_id: string }>(
      `SELECT approver_user_id
         FROM proposal_approvals
        WHERE proposal_id = $1
          AND approval_type = 'egress_granting_user'
          AND approver_user_id = ANY($2::varchar[])
          AND grant_id IS NULL
          AND status = 'approved'
          AND revoked_at IS NULL ORDER BY approver_user_id,id FOR SHARE`,
      [proposal.id, requiredOwners],
    );
    const approvedIds = new Set(approved.rows.map((row) => row.approver_user_id));
    const missing = requiredOwners.filter((userId) => !approvedIds.has(userId));
    if (missing.length > 0) {
      throw new ProposalApplyHttpError(409, {
        code: "content_owner_egress_approval_required",
        required_approver_user_ids: missing,
        message: "Publishing context-tainted output requires every contributing content owner's approval.",
      });
    }
  }

  private async getGrant(client: Queryable, grantId: string): Promise<GrantRow | null> {
    const result = await client.query<GrantRow>(
      `SELECT id, granting_user_id, target_space_id, target_run_id, status,
              egress_review_expires_at
         FROM personal_memory_grants
        WHERE id = $1 FOR SHARE`,
      [grantId],
    );
    return result.rows[0] ?? null;
  }

  private validateGrantApproval(
    proposal: ApplyProposalRow,
    grant: GrantRow,
    userId: string,
    grantId: string,
  ): void {
    const payload = proposal.payload_json ?? {};
    if (grant.granting_user_id !== userId) {
      throw new ProposalApplyHttpError(
        403,
        "only granting_user_id can approve grant-derived egress",
      );
    }
    if (payload.raw_private_memory_included === true) {
      throw new ProposalApplyHttpError(403, "raw private memory cannot be approved for egress");
    }
    if (grant.status === "revoked" || grant.status === "expired" || grant.status === "failed") {
      throw new ProposalApplyHttpError(403, `grant status ${JSON.stringify(grant.status)} cannot approve egress`);
    }
    const payloadGrantId = stringValue(payload.grant_id);
    if (payloadGrantId && payloadGrantId !== grantId) {
      throw new ProposalApplyHttpError(403, "proposal grant_id does not match approval grant_id");
    }
    const payloadGrantIds = payload.personal_memory_grant_ids;
    if (Array.isArray(payloadGrantIds) && !payloadGrantIds.map(String).includes(grantId)) {
      throw new ProposalApplyHttpError(
        403,
        "proposal personal_memory_grant_ids does not include approval grant_id",
      );
    }
    if (stringValue(payload.target_space_id) && payload.target_space_id !== grant.target_space_id) {
      throw new ProposalApplyHttpError(403, "proposal target_space_id does not match grant target_space_id");
    }
    if (proposal.space_id !== grant.target_space_id) {
      throw new ProposalApplyHttpError(403, "proposal space_id does not match grant target_space_id");
    }
    const sourceRunId = stringValue(payload.source_run_id) ?? proposal.created_by_run_id;
    if (!sourceRunId) {
      throw new ProposalApplyHttpError(403, "grant-derived proposal is missing source_run_id");
    }
    if (sourceRunId !== grant.target_run_id) {
      throw new ProposalApplyHttpError(403, "proposal source_run_id does not match grant target_run_id");
    }
    const deadline = dateFrom(grant.egress_review_expires_at);
    if (deadline && deadline.getTime() <= Date.now()) {
      throw new ProposalApplyHttpError(403, "egress review deadline has passed");
    }
  }
}

async function releaseRejectedSourceChannelDraft(client: Queryable, proposal: ApplyProposalRow): Promise<void> {
  if (proposal.proposal_type !== "source_channel_activation") return;
  const channelId = stringValue(proposal.payload_json?.source_channel_id);
  if (!channelId) return;
  const now = new Date().toISOString();
  await client.query(`UPDATE source_channels SET status='archived', updated_at=$3 WHERE id=$1 AND space_id=$2 AND status='paused'`, [channelId, proposal.space_id, now]);
  await client.query(`UPDATE source_connections SET status='archived', updated_at=$3 WHERE id=(SELECT source_connection_id FROM source_channels WHERE id=$1 AND space_id=$2) AND space_id=$2 AND status='paused'`, [channelId, proposal.space_id, now]);
  await client.query(`WITH RECURSIVE dependent AS (
    SELECT id FROM proposals WHERE space_id=$1 AND payload_json->>'depends_on_proposal_id'=$2
    UNION SELECT p.id FROM proposals p JOIN dependent d ON p.payload_json->>'depends_on_proposal_id'=d.id WHERE p.space_id=$1
  ) UPDATE proposals SET status='superseded',updated_at=$3 WHERE space_id=$1 AND status='pending' AND id IN (SELECT id FROM dependent)`,[proposal.space_id,proposal.id,now]);
}

async function releaseRejectedSourceBackfillPlan(client: Queryable,proposal:ApplyProposalRow):Promise<void>{
  if(proposal.proposal_type!=="source_backfill_start")return;
  const planId=stringValue(proposal.payload_json?.source_backfill_plan_id);
  if(!planId)return;
  await client.query(`UPDATE source_backfill_plans SET status='draft',proposal_id=NULL,updated_at=$3 WHERE id=$1 AND space_id=$2 AND proposal_id=$4 AND status='proposed'`,[planId,proposal.space_id,new Date().toISOString(),proposal.id]);
}

async function releaseRejectedCustomSourceHandlerVersion(
  client: Queryable,
  proposalId: string,
  spaceId: string,
): Promise<void> {
  const released = await client.query<{ source_connection_id: string }>(
    `UPDATE source_handler_versions
        SET status = 'draft',
            proposal_id = NULL
      WHERE space_id = $1
        AND proposal_id = $2
        AND status = 'pending_approval'
      RETURNING source_connection_id`,
    [spaceId, proposalId],
  );
  // A rejected repair proposal ends that repair attempt like any other failed
  // one; left at repair_pending, the connection could never be repaired again.
  const connectionIds = released.rows.map((row) => row.source_connection_id);
  if (connectionIds.length === 0) return;
  await client.query(
    `UPDATE source_connections
        SET repair_status = 'repair_required', updated_at = now()
      WHERE space_id = $1
        AND id = ANY($2::text[])
        AND repair_status = 'repair_pending'
        AND NOT EXISTS (
          SELECT 1 FROM source_handler_versions v
           WHERE v.space_id = source_connections.space_id
             AND v.source_connection_id = source_connections.id
             AND v.status = 'pending_approval'
        )`,
    [spaceId, connectionIds],
  );
}

async function releaseRejectedSourceRecipeVersion(
  client: Queryable,
  proposalId: string,
  spaceId: string,
): Promise<void> {
  await client.query(
    `UPDATE source_recipe_versions
        SET status = 'draft',
            proposal_id = NULL
      WHERE space_id = $1
        AND proposal_id = $2
        AND status = 'pending_approval'`,
    [spaceId, proposalId],
  );
}

export function assertIncompleteCodePatchConfirmation(
  proposalType: string,
  payloadJson: Record<string, unknown> | null,
  confirmed: boolean,
): void {
  if (proposalType !== "code_patch") return;
  const payload = recordValue(payloadJson);
  if (payload.incomplete_patch !== true || confirmed) return;
  throw new ProposalApplyHttpError(422, {
    code: "incomplete_patch_requires_confirmation",
    message: (
      "This code_patch proposal has incomplete_patch=true: some agent file changes were skipped " +
      "and the patch is partial. Pass confirm_incomplete_patch=true to apply it anyway."
    ),
    skipped_changes: skippedChangesForDetail(payload),
  });
}

function skippedChangesForDetail(payload: Record<string, unknown>): unknown[] {
  if (Array.isArray(payload.skipped_changes)) return payload.skipped_changes;
  if (Array.isArray(payload.skipped)) return payload.skipped;
  return [];
}

function recordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/**
 * A proposal that names one person, by identity rather than by role.
 *
 * Role is what everything else here arbitrates on, and for the Agent's own
 * memory that is the wrong question: a Space owner or admin satisfies any role
 * a persona proposal could require, and they are exactly the person
 * [ADR 0003](../../../../.agent/decisions/0003-memory-proposal-flow.md) §5 says
 * must not be able to change what someone else's Agent has become. So the
 * proposal carries `required_owner_user_id` and only that person decides it —
 * no role elevation substitutes, and the Project-owner promotion below does
 * not apply either.
 */
/** See `memoryProposalDecider`: derived from the row or applier fields, never a payload scope claim. */
type DeciderShape = { space_id: string; proposal_type: string; payload_json: Record<string, unknown> | null; created_by_agent_id?: string | null; owner_user_id?: string | null };

/**
 * An owner-only private proposal (a Gmail monitor draft) names its decider by
 * identity too: the person whose private turn drafted it. Nobody else — a
 * Space owner, admin or oversight role included — decides it.
 */
function isOwnerOnlyProposal(proposal: { proposal_type: string }): boolean {
  return OWNER_ONLY_PROPOSAL_TYPES.includes(proposal.proposal_type);
}

/**
 * An owner-only card (a Gmail monitor, digest or private-check card) is decided only by its owner
 * acting directly on it — never carried by an Agent (`proposal.decide`), a continuation, a bundle or
 * an automatic acceptance. Any other path finds no such Proposal (404) and nothing is written; ordinary
 * Proposals are unaffected. The card appliers that write a standing consent also refuse without it.
 */
async function assertOwnerCardDecision(client: Queryable, proposalId: string, spaceId: string, ownerCardDecision: boolean): Promise<void> {
  if (ownerCardDecision) return;
  const type = (await client.query<{ proposal_type: string }>(`SELECT proposal_type FROM proposals WHERE id=$1 AND space_id=$2`, [proposalId, spaceId])).rows[0]?.proposal_type;
  if (type !== undefined && isOwnerOnlyProposal({ proposal_type: type })) throw new ProposalApplyHttpError(404, "Proposal not found");
}

function requiredOwnerUserId(
  client: Queryable,
  proposal: DeciderShape,
): Promise<MemoryProposalDecider> {
  if (isOwnerOnlyProposal(proposal)) return Promise.resolve({ required: true, userId: proposal.owner_user_id ?? null });
  return memoryProposalDecider(client, proposal);
}

async function assertRequiredOwnerMayDecide(
  client: Queryable,
  proposal: DeciderShape,
  userId: string,
): Promise<void> {
  if (isOwnerOnlyProposal(proposal)) {
    // Hidden, not forbidden: the row is owner-only and its existence is not disclosed.
    if (!proposal.owner_user_id || proposal.owner_user_id !== userId) throw new ProposalApplyHttpError(404, "Proposal not found");
    return;
  }
  const required = await requiredOwnerUserId(client, proposal);
  if (required.required && required.userId !== userId) {
    throw new HttpError(403, "Only this Agent's owner can decide what it has become");
  }
}

export function canRejectProposalWithRole(
  proposal: {
    created_by_user_id: string | null;
    owner_user_id: string | null;
    created_by_agent_id: string | null;
    required_approver_role: string | null;
    payload_json?: Record<string, unknown> | null;
  },
  userId: string,
  role: string | null,
  /** The Agent-derived decider for an Agent-scope Memory proposal; see `requiredOwnerUserId`. */
  requiredOwner: { required: true; userId: string | null } | { required: false } = { required: false },
): boolean {
  // A proposal that names one person by identity is that person's alone, to
  // decline as much as to accept: leaving reject on role would let a Space
  // admin throw away a persona change the Agent's owner has not seen.
  if (requiredOwner.required) return requiredOwner.userId === userId;
  if (proposal.created_by_user_id === userId) return true;
  // Agent-authored proposals retain Agent attribution, while owner_user_id is
  // the trusted server-populated identity of the instructing human. Give that
  // human the same ability to decline their draft as a direct creator.
  if (proposal.created_by_agent_id && proposal.owner_user_id === userId) return true;
  const requiredRole = normalizeRequiredApproverRole(proposal.required_approver_role);
  return Boolean(requiredRole && role && roleSatisfiesRequiredApprover(role, requiredRole));
}

async function canRejectProposal(
  client: Queryable,
  proposal: ApplyProposalRow,
  userId: string,
): Promise<boolean> {
  return canRejectProposalWithRole(
    proposal,
    userId,
    await effectiveApproverRole(client, proposal, userId),
    await requiredOwnerUserId(client, proposal),
  );
}

/**
 * The role a decision is judged by. `required_approver_role: "owner"` on a
 * Project-scoped proposal means the Project's owner, which is what the
 * applier's own authority check (`assertProjectOwnerLevel`) asks. Do not
 * compare the Space role alone. A Project owner who is a Space member would
 * be shown the Accept button and then refused by it — and, read by accept
 * alone, could accept a proposal they are answered 404 for declining.
 */
async function effectiveApproverRole(
  client: Queryable,
  proposal: Pick<ApplyProposalRow, "space_id" | "project_id">,
  userId: string,
): Promise<string | null> {
  const spaceRole = await getMembershipRole(client, userId, proposal.space_id);
  return spaceRole !== "owner" && proposal.project_id
    && await isProjectOwnerLevel(client, proposal.space_id, proposal.project_id, userId)
    ? "owner"
    : spaceRole;
}

function normalizeRequiredApproverRole(role: string | null | undefined): "owner" | "admin" | "reviewer" | null {
  if (!role) return null;
  if (role === "owner" || role === "admin" || role === "reviewer") return role;
  return "owner";
}

function roleSatisfiesRequiredApprover(
  actorRole: string,
  requiredRole: "owner" | "admin" | "reviewer",
): boolean {
  return roleRank(actorRole) >= roleRank(requiredRole);
}

function roleRank(role: string): number {
  if (role === "owner") return 3;
  if (role === "admin") return 2;
  if (role === "reviewer") return 1;
  return 0;
}

async function getMembershipRole(
  client: Queryable,
  userId: string,
  spaceId: string,
): Promise<string | null> {
  const result = await client.query<{ role: string }>(
    `SELECT role
       FROM space_memberships
      WHERE space_id = $1 AND user_id = $2 AND status = 'active'
      LIMIT 1`,
    [spaceId, userId],
  );
  return result.rows[0]?.role ?? null;
}

function policyResultToHttpError(result: EnforceResult): ProposalApplyHttpError {
  if (result.status === "error") {
    return new ProposalApplyHttpError(500, result.message ?? result.error_code ?? "Policy audit failed");
  }
  return new ProposalApplyHttpError(403, result.message ?? result.error_code ?? "Policy denied proposal apply");
}

function normalizeApplyError(error: unknown): unknown {
  if (error instanceof ProposalRiskLevelError) {
    return new ProposalApplyHttpError(422, {
      code: "invalid_proposal_risk_level",
      risk_value: error.riskValue,
      message: error.message,
    });
  }
  if (error instanceof ProposalApplyHttpError) return error;
  if (error instanceof MemoryAudienceError) {
    return new ProposalApplyHttpError(error.statusCode, { code: error.code, message: error.message, ...error.detail });
  }
  if (error instanceof MemoryOperatorEditRequiredError) {
    return new ProposalApplyHttpError(error.statusCode, { code: error.code, message: error.message });
  }
  if (
    error && typeof error === "object"
    && (error as { code?: unknown }).code === "23505"
    && (error as { constraint?: unknown }).constraint === "uq_memory_entries_active_persona"
  ) {
    return new ProposalApplyHttpError(409, {
      code: "active_persona_already_exists",
      message: "This Agent already has an active persona. Refresh and revise the active version instead.",
    });
  }
  return error;
}

function approvalToOut(row: ApprovalRow): ProposalApprovalOut {
  return {
    id: row.id,
    proposal_id: row.proposal_id,
    approval_type: row.approval_type,
    approver_user_id: row.approver_user_id,
    grant_id: row.grant_id,
    target_space_id: row.target_space_id,
    status: row.status,
    metadata_json: row.metadata_json,
    created_at: dateValue(row.created_at) ?? new Date(0).toISOString(),
    revoked_at: dateValue(row.revoked_at),
  };
}

function requiredTaintOwnerApprovers(payload: Record<string, unknown> | null): string[] {
  if (payload?.requires_approval_type !== "egress_content_owner") return [];
  const value = payload?.required_egress_approver_user_ids;
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((item): item is string => typeof item === "string" && item.length > 0))].sort();
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function dateValue(value: unknown): string | null {
  const date = dateFrom(value);
  return date ? date.toISOString() : null;
}

function dateFrom(value: unknown): Date | null {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if (typeof value === "string" && value.trim()) {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
  }
  return null;
}

/** Stable key of a Proposal's frozen report dependencies. */
function reportDependencyKey(proposalType: string, payloadJson: unknown): string {
  const deps = proposalReportDependenciesSync(proposalType, payloadJson);
  return deps ? JSON.stringify([deps.malformed, [...deps.artifactIds].sort()]) : "";
}

function isMemoryProposal(type:string):boolean {
  return type==='memory_create'||type==='memory_update'||type==='memory_archive';
}
