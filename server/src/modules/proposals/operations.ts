import {UnknownProposalApplierError} from './applierRegistry.js';
import {HttpError} from '../routeUtils/common.js';
import {CodePatchDecisionRefusal} from '../projectFolders/codePatchDecisionErrors.js';
import type {OperationInput,OperationOutput,RegisteredSystemActionDefinition} from '@rainver/protocol';
import type {ServerConfig} from '../../config.js';
import type {OperationRegistration} from '../systemActions/operations/types.js';
import {OperationBusinessError,hidden,markedRefusal} from '../systemActions/operations/errors.js';
import {PgProposalApplyService,ProposalApplyHttpError} from './applyService.js';
import {isPersonActingDirectly} from '../systemActions/operations/personAdmission.js';
export function proposalApplyRefusal(error:ProposalApplyHttpError){
 const detail=error.detail;
 const message=detail&&typeof detail==='object'&&'message' in detail&&typeof detail.message==='string'?detail.message:error.message;
 return markedRefusal({statusCode:error.statusCode,message,responseBody:detail},'proposals');
}
async function proposalAuthority<T>(work:()=>Promise<T>):Promise<T>{
 try{return await work();}catch(error){
  if(error instanceof ProposalApplyHttpError){
   const refusal=proposalApplyRefusal(error);
   if(refusal)throw refusal;
  }
  throw error;
 }
}
type Input=OperationInput<'proposal.egress.approve'>;
type Output=OperationOutput<'proposal.egress.approve'>;
export function proposalConsentRegistration(config:ServerConfig,definitions:ReadonlyMap<string,RegisteredSystemActionDefinition>):OperationRegistration {
 const service=PgProposalApplyService.fromConfig(config);
 return {
  definition:definitions.get('proposal.egress.approve')!,
  async resolve(_db,raw,a){const i=raw as Input;return {authority:`space:${a.space_id}`,targets:i,resourceType:'proposal',resourceId:i.proposal_id};},
  async authorize(db,raw,a){const i=raw as Input;await proposalAuthority(()=>service.authorizeEgressConsentInTransaction(db,i.proposal_id,{spaceId:a.space_id,userId:a.on_behalf_of_user_id!},i.grant_id??null));},
  async authorizeResult(db,raw,a){
   const out=raw as Output;
   const row=(await db.query(`SELECT id FROM proposal_approvals WHERE id=$1 AND proposal_id=$2
    AND approver_user_id=$3 AND status='approved' AND revoked_at IS NULL FOR SHARE`,[out.id,out.proposal_id,a.on_behalf_of_user_id!])).rows[0];
   if(!row)throw hidden();
   await proposalAuthority(()=>service.authorizeEgressConsentInTransaction(db,out.proposal_id,{spaceId:a.space_id,userId:a.on_behalf_of_user_id!},out.grant_id??null));
  },
  async execute(db,raw,a){const i=raw as Input;return service.approveEgressGrantingUserInTransaction(db,i.proposal_id,{spaceId:a.space_id,userId:a.on_behalf_of_user_id!},i.grant_id??null);},
  classifyError(e){return e instanceof ProposalApplyHttpError?proposalApplyRefusal(e):undefined;},
 };
}

export function proposalRejectionRegistration(config:ServerConfig,definitions:ReadonlyMap<string,RegisteredSystemActionDefinition>):OperationRegistration {
 const service=PgProposalApplyService.fromConfig(config);
 return {
  definition:definitions.get('proposal.reject')!,policyAuditRecovery:true,
  async resolve(_db,raw,a){const i=raw as OperationInput<'proposal.reject'>;return {authority:`space:${a.space_id}`,targets:i,resourceType:'proposal',resourceId:i.proposal_id};},
  async authorize(db,raw,a){await proposalAuthority(()=>service.authorizeRejectOperationInTransaction(db,(raw as OperationInput<'proposal.reject'>).proposal_id,{spaceId:a.space_id,userId:a.on_behalf_of_user_id!}));},
  async authorizeResult(db,raw,a){await proposalAuthority(()=>service.authorizeRejectOperationInTransaction(db,(raw as OperationOutput<'proposal.reject'>).id,{spaceId:a.space_id,userId:a.on_behalf_of_user_id!},true));},
  async execute(db,raw,a){const result=await service.rejectOperationInTransaction(db,(raw as OperationInput<'proposal.reject'>).proposal_id,{spaceId:a.space_id,userId:a.on_behalf_of_user_id!},isPersonActingDirectly(a));if(!result)throw hidden();return result.outcome;},
  async afterCommit(raw){await service.afterRejectOperationCommit(raw as OperationOutput<'proposal.reject'>);},
  classifyError(e){return e instanceof ProposalApplyHttpError?proposalApplyRefusal(e):undefined;},
 };
}

export function proposalApplyRegistrations(config:ServerConfig,definitions:ReadonlyMap<string,RegisteredSystemActionDefinition>,service=PgProposalApplyService.fromConfig(config)):OperationRegistration[] {
 return (['proposal.accept','proposal.rollback'] as const).map(id=>({
  definition:definitions.get(id)!,policyAuditRecovery:true,
  proposalDecisionOwner:{roots:async (_db,raw)=>[(raw as {proposal_id:string}).proposal_id],prepare:(db,roots,a)=>service.prepareReportDependenciesInTransaction(db,roots,{spaceId:a.space_id,userId:a.on_behalf_of_user_id!})},
  async resolve(_db,raw,a){const i=raw as {proposal_id:string};return {authority:`space:${a.space_id}`,targets:i,resourceType:'proposal',resourceId:i.proposal_id};},
  async authorize(db,raw,a){const i=raw as {proposal_id:string};const identity={spaceId:a.space_id,userId:a.on_behalf_of_user_id!};await proposalAuthority(()=>id==='proposal.accept'?service.authorizeAcceptOperationInTransaction(db,i.proposal_id,identity):service.authorizeRollbackOperationInTransaction(db,i.proposal_id,identity));},
  async authorizeResult(db,raw,a){const identity={spaceId:a.space_id,userId:a.on_behalf_of_user_id!};if(id==='proposal.accept')await proposalAuthority(()=>service.authorizeAcceptOperationInTransaction(db,(raw as OperationOutput<'proposal.accept'>).proposal.id,identity,true,{resultType:(raw as OperationOutput<'proposal.accept'>).result_type}));else await proposalAuthority(()=>service.authorizeRollbackOperationInTransaction(db,(raw as OperationOutput<'proposal.rollback'>).proposal_id,identity,true));},
  async execute(db,raw,a){const i=raw as OperationInput<'proposal.accept'>;const identity={spaceId:a.space_id,userId:a.on_behalf_of_user_id!};const result=id==='proposal.accept'?await service.acceptOperationInTransaction(db,i.proposal_id,identity,{confirmIncompletePatch:i.confirm_incomplete_patch===true||i.confirm_incomplete_patch==='true',ownerCardDecision:isPersonActingDirectly(a)}):await service.rollbackInTransaction(db,i.proposal_id,identity);if(!result)throw hidden();return result;},
  successStatus:out=>id==='proposal.accept'?(out as OperationOutput<'proposal.accept'>).result_type==='code_patch_pending'?202:200:['pending','applying','compensating'].includes((out as OperationOutput<'proposal.rollback'>).status)?202:200,
  classifyError(e){
   if(e instanceof ProposalApplyHttpError)return proposalApplyRefusal(e);
   if(e instanceof CodePatchDecisionRefusal)return markedRefusal(e,'proposals');
   if(e instanceof UnknownProposalApplierError||e instanceof HttpError&&[400,422].includes(e.statusCode))return new OperationBusinessError('operation_invalid_input',422,'proposals');
   if(e instanceof HttpError&&e.statusCode===409)return new OperationBusinessError('operation_conflict',409,'proposals');
   return undefined;
  },
 }));
}
