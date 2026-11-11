import type {OperationActor,WorkspacePublicationPlanInput} from '@rainver/protocol';
import type {Queryable} from '../routeUtils/common.js';
import {OperationBusinessError} from '../systemActions/operations/errors.js';

/** The frozen publication plan of one integration (hosts.md, "Controlled Git publication"). */
export interface PublicationPlan {strategy:'rebase'|'squash'|'fast_forward'|'merge';target_ref:string|null}
/** A new integration's plan when none is requested: replay the batch's own commits onto the workspace target. */
export const DEFAULT_PUBLICATION_PLAN:Readonly<PublicationPlan>=Object.freeze({strategy:'rebase',target_ref:null});
const conflict=()=>new OperationBusinessError('operation_conflict',409,'workspaces');

/** A 409 naming the publication refusal so callers can distinguish it from a stale revision. */
export const publicationConflict=(code:string)=>{const e=new OperationBusinessError('operation_conflict',409,'workspaces'),body=e.body.bind(e);e.body=id=>{const r=body(id);r.error.metadata={code};return r;};return e;};
/** Frozen identity of an integration's publication; every rewrite of its detail keeps these top-level keys (never searched for in older details). */
export const FROZEN_PUBLICATION_KEYS=['publication_plan','publication','replayed_from'] as const;
export function frozenPublicationDetail(detail:Record<string,unknown>|undefined|null):Record<string,unknown>{
 return Object.fromEntries(FROZEN_PUBLICATION_KEYS.filter(k=>detail?.[k]!==undefined).map(k=>[k,detail![k]]));
}
/** Chain publication must preserve the recorded commits on every integration path. */
export const requiresNativePublication=(plan:PublicationPlan|null)=>Boolean(plan&&plan.strategy!=='squash');

/** A recorded plan, or null for a squash into the workspace target admitted
 * without a plan (legacy native integrations and non-native Host integrations). */
export function frozenPublicationPlan(detail:Record<string,unknown>|undefined|null):PublicationPlan|null{
 const plan=detail?.publication_plan as Partial<PublicationPlan>|undefined;
 if(!plan||!['rebase','squash','fast_forward','merge'].includes(String(plan.strategy)))return null;
 return {strategy:plan.strategy!,target_ref:typeof plan.target_ref==='string'?plan.target_ref:null};
}

type PreviousIntegration={detail_json:Record<string,unknown>;status:string};
/**
 * A frozen fast-forward/merge plan may be explicitly switched to rebase or
 * squash (same target) once its integration failed while the Host held no
 * chain for it: no chain tip was ever recorded, because the chain was refused
 * (for example its base is a private baseline, not target history) or never
 * checked. A recorded chain stays bound to its plan; the Host journal refuses a changed strategy.
 */
export function chainPlanMaySwitch(previous:PreviousIntegration|undefined):boolean{
 const frozen=frozenPublicationPlan(previous?.detail_json);
 if(!previous||previous.status!=='failed'||(frozen?.strategy!=='fast_forward'&&frozen?.strategy!=='merge'))return false;
 return typeof (previous.detail_json.publication as {chain_tip?:unknown}|undefined)?.chain_tip!=='string';
}
/** True when an admitted plan replaces the frozen fast-forward/merge plan. */
export function isPlanSwitch(previous:PreviousIntegration|undefined,admitted:PublicationPlan|null):boolean{
 const frozen=frozenPublicationPlan(previous?.detail_json);
 return Boolean(admitted&&(frozen?.strategy==='fast_forward'||frozen?.strategy==='merge')&&admitted.strategy!==frozen.strategy);
}
/** The frozen keys after an admitted switch: the new plan, recording the replaced
 * chain plan and its last error; the integration carries no chain identity any more. */
export function switchedPlanDetail(detail:Record<string,unknown>,admitted:PublicationPlan,by:{user_id:string;run_id:string|null}):Record<string,unknown>{
 const frozen=frozenPublicationPlan(detail)!;
 return {publication_plan:{strategy:admitted.strategy,target_ref:frozen.target_ref,requested_by_user_id:by.user_id,requested_by_run_id:by.run_id,
  replaced_plan:{strategy:frozen.strategy,error:typeof detail.error==='string'?detail.error:null}}};
}

/** Squash only on the person's own request: the person acting directly, or an
 * Agent quoting the current turn's message (provenance-checked, never inferred).
 * The closure check is loaded lazily: its run-context graph imports modules
 * (workspaceBranchAlign) that read `publicationConflict` at load time. */
async function assertSquashRequested(db:Queryable,actor:OperationActor,quote:string|undefined){
 if(!actor.run_id&&actor.principal.kind==='user')return;
 if(quote&&await (await import('./workspaceClosureRequest.js')).workspaceClosureRequest(db,actor,quote))return;
 throw publicationConflict('workspace_squash_requires_person_request');
}

/**
 * Admission of a requested plan at prepare. The plan is frozen with the
 * integration: a later request may repeat it but never change strategy or
 * target, except a switch to rebase or squash of a failed chain the Host never
 * held (`chainPlanMaySwitch`; it keeps the frozen target). Without a request a
 * new integration rebases; squash needs the person's explicit request. An
 * explicit target is a root-workspace branch (delegated work publishes into its
 * parent). The Host re-validates the branch, its existence and the chain.
 */
export async function admitPublicationPlan(db:Queryable,c:{workspace_id:string},requested:WorkspacePublicationPlanInput|undefined,previous:PreviousIntegration|undefined,actor:OperationActor):Promise<PublicationPlan|null>{
 const frozen=frozenPublicationPlan(previous?.detail_json);
 if(!requested)return previous?frozen:{...DEFAULT_PUBLICATION_PLAN};
 const plan:PublicationPlan={strategy:requested.strategy,target_ref:requested.target_branch?`refs/heads/${requested.target_branch}`:null};
 const w=(await db.query<{parent_workspace_id:string|null;target_ref:string|null}>(`SELECT parent_workspace_id,target_ref
  FROM execution_workspaces WHERE id=$1`,[c.workspace_id])).rows[0];
 if(!w)throw conflict();
 if(plan.target_ref===w.target_ref)plan.target_ref=null;
 if(plan.target_ref&&w.parent_workspace_id)throw new OperationBusinessError('operation_invalid_input',422,'workspaces');
 if(previous){
  if((frozen?.strategy??'squash')===plan.strategy&&(frozen?.target_ref??null)===plan.target_ref)return frozen;
  const sameTarget=!requested.target_branch||plan.target_ref===(frozen?.target_ref??null);
  if(!sameTarget||(plan.strategy!=='rebase'&&plan.strategy!=='squash')||!chainPlanMaySwitch(previous))throw conflict();
  if(plan.strategy==='squash')await assertSquashRequested(db,actor,requested.user_request_quote);
  return {strategy:plan.strategy,target_ref:frozen!.target_ref};
 }
 if(plan.strategy==='squash')await assertSquashRequested(db,actor,requested.user_request_quote);
 return plan;
}
