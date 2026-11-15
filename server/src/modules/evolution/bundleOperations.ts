import {proposalApplyRefusal} from '../proposals/operations.js';
import {getDbPool} from '../../db/pool.js';
import {PgProposalRepository} from '../proposals/repository.js';
import type {OperationInput,OperationOutput,RegisteredSystemActionDefinition} from '@rainver/protocol';
import type {ServerConfig} from '../../config.js';
import type {OperationRegistration} from '../systemActions/operations/types.js';
import {OperationBusinessError,hidden,markedRefusal} from '../systemActions/operations/errors.js';
import {canonical} from '../systemActions/operations/repository.js';
import {HttpError,type Queryable,type SpaceUserIdentity} from '../routeUtils/common.js';
import {PgProposalApplyService,ProposalApplyHttpError} from '../proposals/applyService.js';
import {EvolutionBundleRepository,type EvolutionBundleDecision} from './bundleRepository.js';
import {EvolutionAssetRefusal} from './assetRefusal.js';
type Input=OperationInput<'evolution.bundle.decide'>;
type Receipt=OperationOutput<'evolution.bundle.decide'>;
const ids=['evolution.bundle.decide','evolution.bundle.approve','evolution.bundle.reject','evolution.bundle.rollback'] as const;
async function roots(db:Queryable,space:string,bundle:string){
 return (await db.query<{id:string}>(`SELECT p.id FROM proposals p WHERE p.space_id=$1 AND
  (EXISTS(SELECT 1 FROM evolution_bundle_members m WHERE m.proposal_id=p.id AND m.bundle_id=$2)
   OR (p.proposal_type='evolution_bundle_rollback' AND p.payload_json->>'bundle_id'=$2 AND p.status IN ('pending','accepted'))) ORDER BY p.id`,[space,bundle])).rows.map(r=>r.id);
}
export function bundleDecisionRegistrations(config:ServerConfig,definitions:ReadonlyMap<string,RegisteredSystemActionDefinition>):OperationRegistration[]{
 const service=PgProposalApplyService.fromConfig(config);
 const repository=(db:Queryable)=>new EvolutionBundleRepository(db,config.databaseUrl??undefined);
 const decisions=(id:typeof ids[number],raw:unknown):EvolutionBundleDecision[]=>{
  if(id==='evolution.bundle.rollback')return [];
  if(id==='evolution.bundle.decide')return (raw as Input).decisions.map(d=>({proposalId:d.proposal_id,decision:d.decision,note:d.note}));
  return (raw as OperationInput<'evolution.bundle.approve'>).proposal_ids.map(proposalId=>({proposalId,decision:id==='evolution.bundle.approve'?'approve':'reject'}));
 };
 const authorize=async(db:Queryable,bundle:string,selected:EvolutionBundleDecision[],identity:SpaceUserIdentity)=>{
  const visible=await repository(db).get(identity,bundle);if(!visible)throw hidden();
  const members=(visible.members as {proposal_id:string}[]).map(m=>m.proposal_id);
  if(selected.some(d=>!members.includes(d.proposalId)))throw hidden();
  for(const decision of selected)await service.authorizeBundleOperationInTransaction(db,[decision.proposalId],identity,decision.decision);
  // Rollback is authorized by its own canonical rollback Proposal, not by
  // re-approving members (which may have different required owners).
  if(!selected.length)await service.authorizeBundleRollbackOperationInTransaction(db,bundle,identity);
 };
 return ids.map(id=>({
  definition:definitions.get(id)!,policyAuditRecovery:true,
  proposalDecisionOwner:{bundle:true,roots:async(db,raw,a)=>id==='evolution.bundle.rollback'?roots(db,a.space_id,(raw as Input).bundle_id):decisions(id,raw).map(d=>d.proposalId),prepare:(db,_ids,a,raw)=>service.prepareReportDependenciesInTransaction(db,decisions(id,raw).filter(d=>d.decision==='approve').map(d=>d.proposalId),{spaceId:a.space_id,userId:a.on_behalf_of_user_id!})},
  async resolve(_db,raw,a){return {authority:`space:${a.space_id}`,targets:raw,resourceType:'evolution_bundle',resourceId:(raw as Input).bundle_id};},
  async authorize(db,raw,a){await authorize(db,(raw as Input).bundle_id,decisions(id,raw),{spaceId:a.space_id,userId:a.on_behalf_of_user_id!});},
  async authorizeResult(db,raw,a){const r=raw as Receipt;await authorize(db,r.bundle_id,r.decisions.map(d=>({proposalId:d.proposal_id,decision:d.decision,note:d.note})),{spaceId:a.space_id,userId:a.on_behalf_of_user_id!});},
  async execute(db,raw,a){
   const i=raw as Input,identity={spaceId:a.space_id,userId:a.on_behalf_of_user_id!},selected=decisions(id,raw);
   const before=await roots(db,a.space_id,i.bundle_id);
   const result=id==='evolution.bundle.rollback'?await repository(db).requestRollback(identity,i.bundle_id,service):await repository(db).decide(identity,i.bundle_id,selected,service);
   const after=await roots(db,a.space_id,i.bundle_id);
   // Rollback may create a fresh canonical Proposal, but cannot change bundle membership.
   if(id!=='evolution.bundle.rollback'&&canonical(before)!==canonical(after))throw new HttpError(409,'Bundle membership changed');
   return {space_id:a.space_id,bundle_id:i.bundle_id,decision:result.decision??null,decisions:selected.map(d=>({proposal_id:d.proposalId,decision:d.decision,note:d.note??null}))};
  },
  successStatus:out=>['pending','applying','compensating'].includes((out as Receipt).decision?.status??'')?202:200,
  async afterCommit(raw,actor){
   for(const decision of (raw as Receipt).decisions.filter(d=>d.decision==='reject')){
    const out=await new PgProposalRepository(getDbPool(config.databaseUrl!)).getVisible(actor.space_id,actor.on_behalf_of_user_id!,decision.proposal_id);
    if(out)await service.afterRejectOperationCommit(out);
   }
  },
  classifyError(e){
   if(e instanceof ProposalApplyHttpError)return proposalApplyRefusal(e);
   if(e instanceof EvolutionAssetRefusal)return markedRefusal(e,'evolution');
   if(e instanceof HttpError&&[400,422,409].includes(e.statusCode))return new OperationBusinessError(e.statusCode===409?'operation_conflict':'operation_invalid_input',e.statusCode===409?409:422,'evolution');
   return undefined;
  },
 }));
}
