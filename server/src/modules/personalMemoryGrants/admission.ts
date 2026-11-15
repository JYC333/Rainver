import {lockPersonalReceiptSpace as admitGrantOwner} from '../access/personalSpace.js';
import {contentDecisionFromDb} from '../access/contentAccessQuery.js';
import {lockDemotionReleaseClosure} from '../contentAccess/demotionReleaseClosure.js';
import {HttpError,type Queryable} from '../routeUtils/common.js';
import {canonical} from '../systemActions/operations/repository.js';

export {lockPersonalReceiptSpace as admitGrantOwner} from '../access/personalSpace.js';
export async function admitGrantTarget(db:Queryable,userId:string,targetSpaceId:string,runId:string):Promise<void>{
 const discover=async()=>(await db.query<{id:string;agent_id:string|null;instructed_by_user_id:string|null}>(
  'SELECT id,agent_id,instructed_by_user_id FROM runs WHERE id=$1 AND space_id=$2',[runId,targetSpaceId])).rows[0];
 const before=await discover();
 if(!before||before.instructed_by_user_id!==userId)throw new HttpError(404,'Target run not found');
 await lockDemotionReleaseClosure(db,{spaceId:targetSpaceId,userId},{
  resource:{type:before.agent_id?'agent':'run',id:before.agent_id??runId},runIds:[runId],artifactIds:[],proposalIds:[],
 });
 if(canonical(before)!==canonical(await discover()))throw new HttpError(409,'Grant target changed');
 if(await contentDecisionFromDb(db,{spaceId:targetSpaceId,userId},'run',runId,{includeOversight:false})!=='full')throw new HttpError(404,'Target run not found');
 await admitGrantOwner(db,userId);
}
