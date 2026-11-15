import {SPACE_OPERATION_SCHEMAS,type OperationActor,type RegisteredSystemActionDefinition,type SpaceOperationId} from '@rainver/protocol';
import type {OperationRegistration} from '../systemActions/operations/types.js';
import {hidden,markedRefusal} from '../systemActions/operations/errors.js';
import {HttpError,type SpaceUserIdentity} from '../routeUtils/common.js';
import {contentDecisionFromDb} from '../access/contentAccessQuery.js';
import {lockSpaceRole} from '../spaces/writers.js';
import {ContentAccessService} from './service.js';
import {ContentDemotionService} from './demotion.js';

type Input=Record<string,any>;
const CONTENT_IDS=Object.keys(SPACE_OPERATION_SCHEMAS).filter(id=>id.startsWith('content.')) as SpaceOperationId[];
const identity=(a:OperationActor):SpaceUserIdentity=>({spaceId:a.space_id,userId:a.on_behalf_of_user_id!});
const update=(i:Input)=>({visibility:i.visibility,access_level:i.access_level,project_id:i.project_id,grants:i.grants,...(i.demotion_confirmation_id?{demotion_confirmation_id:i.demotion_confirmation_id}:{})});

/**
 * Who may read an object, changed by its owner or a Space owner/admin (the
 * ContentAccessService rules, unchanged): narrowing needs the owner's current
 * exposure disclosure, Memory changes are a canonical applier version and
 * tainted widening goes to owner review. Receipts name identities only; the
 * policy and disclosure bodies are reread through their authorized GET readers.
 */
export function contentAccessRegistrations(defs:ReadonlyMap<string,RegisteredSystemActionDefinition>):OperationRegistration[]{
  return CONTENT_IDS.map(id=>({
    definition:defs.get(id)!,
    successStatus:id==='content.access.update'?200:201,
    async resolve(_db,raw,a){
      const i=raw as Input;
      return {authority:`content:${i.resource_type}:${i.resource_id}`,targets:{resource_type:i.resource_type,resource_id:i.resource_id},resourceType:i.resource_type,resourceId:i.resource_id};
    },
    async authorize(db,raw,a){
      const i=raw as Input;
      // The person's Space role is held until commit, so a demotion of the manager cannot interleave.
      try{await lockSpaceRole(db,a.space_id,a.on_behalf_of_user_id!);}catch{throw hidden();}
      const allowed=id==='content.demotion.disclose'
        ?await new ContentDemotionService(db).ownsResource(identity(a),i.resource_type,i.resource_id)
        :await new ContentAccessService(db).manages(identity(a),i.resource_type,i.resource_id);
      if(!allowed)throw hidden();
    },
    async authorizeResult(db,raw,a){
      const out=raw as {space_id:string;resource_type?:string;resource_id?:string;proposal_id?:string};
      if(out.space_id!==a.space_id)throw hidden();
      if(id==='content.publication.request'){
        if(await contentDecisionFromDb(db,{spaceId:a.space_id,userId:a.on_behalf_of_user_id!},'proposal',out.proposal_id!,{includeOversight:false})==='deny')throw hidden();
        return;
      }
      const allowed=id==='content.demotion.disclose'
        ?await new ContentDemotionService(db).ownsResource(identity(a),out.resource_type!,out.resource_id!)
        :await new ContentAccessService(db).manages(identity(a),out.resource_type!,out.resource_id!);
      if(!allowed)throw hidden();
    },
    // The service's 400/409/422 refusals were written for the person (including the
    // disclosure and taint codes the policy control acts on); nothing else is reflected.
    classifyError(error){return error instanceof HttpError?markedRefusal(error,'content_access'):undefined;},
    async execute(db,raw,a){
      const i=raw as Input,service=new ContentAccessService(db),who=identity(a);
      if(id==='content.access.update'){
        const policy=await service.updatePolicy(who,i.resource_type,i.resource_id,update(i));
        return {space_id:a.space_id,resource_type:policy.resource_type,resource_id:policy.resource_id};
      }
      if(id==='content.demotion.disclose'){
        const d=await service.discloseDemotion(who,i.resource_type,i.resource_id,i.target_visibility);
        return {space_id:a.space_id,resource_type:d.resource_type,resource_id:d.resource_id,confirmation_id:d.confirmation_id,target_visibility:d.target_visibility,expires_at:d.expires_at};
      }
      const out=await service.requestPublication(who,i.resource_type,i.resource_id,update(i));
      return {space_id:a.space_id,proposal_id:out.proposal_id,required_approver_user_ids:out.required_approver_user_ids};
    },
  }));
}
