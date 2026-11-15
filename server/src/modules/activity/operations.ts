import type {OperationInput,RegisteredSystemActionDefinition} from '@rainver/protocol';
import {contentDecisionFromDb} from '../access/contentAccessQuery.js';
import {projectReadersMissingActivity} from './activityMemoryProposal.js';
import {HttpError} from '../routeUtils/common.js';
import {lockSourceRetrievalRelease} from '../sources/retrievalReleaseLocks.js';
import {hidden,markedRefusal} from '../systemActions/operations/errors.js';
import type {OperationRegistration} from '../systemActions/operations/types.js';
import {PgActivityRepository} from './repository.js';
type Input=OperationInput<'activity.review'>;
export function activityStatusRegistrations(defs:ReadonlyMap<string,RegisteredSystemActionDefinition>):OperationRegistration[]{
 return (['activity.review','activity.archive','activity.consolidate'] as const).map(id=>({
  definition:defs.get(id)!,
  async resolve(_db,raw,a){const input=raw as Input;return {authority:`activity:${a.space_id}:${input.activity_id}`,targets:input,resourceType:'space',resourceId:a.space_id};},
  async authorize(db,raw,a){
   const input=raw as Input,ref={object_type:'activity' as const,object_id:input.activity_id};
   const proposals=async()=>id==='activity.consolidate'?(await db.query<{id:string}>("SELECT id FROM proposals WHERE space_id=$1 AND payload_json->>'source_activity_id'=$2 ORDER BY id",[a.space_id,input.activity_id])).rows.map(row=>row.id):[];
   const before=await proposals();
   await lockSourceRetrievalRelease(db,a.space_id,a.on_behalf_of_user_id!,[ref,...before.map(object_id=>({object_type:'proposal' as const,object_id}))],[],undefined,[],[],[ref]);
   if(JSON.stringify(before)!==JSON.stringify(await proposals()))throw new HttpError(409,'Activity proposal lineage changed; read again');
   const current=await new PgActivityRepository(db).get({spaceId:a.space_id,userId:a.on_behalf_of_user_id!},input.activity_id,{forChange:true});
   if(!current)throw hidden();
   if(id==='activity.consolidate'){
    if(current.effective_access_level!=='full'||(current.owner_user_id??current.user_id)!==a.on_behalf_of_user_id)throw hidden();
    if(await projectReadersMissingActivity(db,a.space_id,current)>0)throw new HttpError(409,'Share this Activity with its Project before turning it into Project Memory',{code:'activity_share_required'});
   }
  },
  async authorizeResult(db,raw,a){
   if(id==='activity.consolidate'){
    for(const proposal of raw as {id:string;space_id:string}[]){
     if(proposal.space_id!==a.space_id||await contentDecisionFromDb(db,{spaceId:a.space_id,userId:a.on_behalf_of_user_id!},'proposal',proposal.id,{includeOversight:false})!=='full')throw hidden();
    }
    return;
   }
   const out=raw as OperationInput<'activity.review'>&{id:string;space_id:string;content:string;metadata_json:Record<string,unknown>};
   if(out.space_id!==a.space_id)throw hidden();
   const current=await new PgActivityRepository(db).get({spaceId:a.space_id,userId:a.on_behalf_of_user_id!},out.id,{forChange:true});
   if(!current||current.effective_access_level==='summary'&&(out.content!==''||Object.keys(out.metadata_json).length>0))throw hidden();
  },
  async execute(db,raw,a){if(id==='activity.consolidate')return new PgActivityRepository(db).consolidate({spaceId:a.space_id,userId:a.on_behalf_of_user_id!},(raw as Input).activity_id);return new PgActivityRepository(db).setStatus({spaceId:a.space_id,userId:a.on_behalf_of_user_id!},(raw as Input).activity_id,id==='activity.review'?'processed':'archived');},
  classifyError:error=>error instanceof HttpError?markedRefusal(error,'activity'):undefined,
 }));
}
