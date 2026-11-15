import {personalReceiptSpace} from '../access/personalSpace.js';
import {contentDecisionFromDb} from '../access/contentAccessQuery.js';
import {resolveContentCreationContext} from '../access/creationContext.js';
import {holdProjects,lockActiveProjectForMutation,lockProjectAudience} from '../projects/access.js';
import {lockSourceRetrievalRelease,sourceRetrievalReleaseProjects} from '../sources/retrievalReleaseLocks.js';
import {HttpError,type Queryable} from '../routeUtils/common.js';
import {canonical} from '../systemActions/operations/repository.js';
type Ref=Parameters<typeof lockSourceRetrievalRelease>[3][number];
export interface FilingTarget {userId:string;activityId:string;targetProjectId:string}
async function discover(db:Queryable,i:FilingTarget){
 const personal=await personalReceiptSpace(db,i.userId);
 const source=(await db.query<{space_id:string;owner_user_id:string;project_id:string|null;filed: {space_id:string;object_id:string}|null}>(`SELECT space_id,owner_user_id,project_id,payload_json->'filed_into' AS filed FROM activity_records WHERE id=$1 AND space_id=$2 AND discarded_at IS NULL`,[i.activityId,personal])).rows[0];
 if(!source||source.owner_user_id!==i.userId)throw new HttpError(404,'Capture not found');
 const target=(await db.query<{space_id:string}>('SELECT space_id FROM projects WHERE id=$1 AND deleted_at IS NULL',[i.targetProjectId])).rows[0];
 if(!target)throw new HttpError(404,'Project not found');
 const groups=new Map<string,{refs:Ref[];exclusive:Ref[];written:string[]}>();
 const group=(space:string)=>{let g=groups.get(space);if(!g){g={refs:[],exclusive:[],written:[]};groups.set(space,g);}return g;};
 const from=group(personal);from.refs.push({object_type:'activity',object_id:i.activityId});from.exclusive.push(...from.refs);
 group(target.space_id).written.push(i.targetProjectId);
 if(source.filed)group(source.filed.space_id).refs.push({object_type:'space_object',object_id:source.filed.object_id});
 const scopes=[];
 for(const [space,g] of [...groups].sort(([a],[b])=>a.localeCompare(b)))scopes.push({space,...g,projects:await sourceRetrievalReleaseProjects(db,space,g.refs,g.written)});
 return {personal,source,target,scopes};
}
/** Same admission for direct service and core: Project audiences, person,
 * memberships, roots/grants, rediscovery, then canonical read/write gates. */
export async function admitFiling(db:Queryable,i:FilingTarget):Promise<string>{
 const before=await discover(db,i);
 const projects=before.scopes.flatMap(s=>s.projects.map(id=>({space:s.space,id,write:s.written.includes(id)}))).sort((a,b)=>(a.space+':'+a.id).localeCompare(b.space+':'+b.id));
 for(const p of projects){if(p.write)await lockActiveProjectForMutation(db,p.space,p.id);await lockProjectAudience(db,p.space,p.id);}
 const close=holdProjects(db,projects.map(p=>p.id));
 try{
  if(canonical(await discover(db,i))!==canonical(before))throw new HttpError(409,'Filing scope changed');
  for(const s of before.scopes)await lockSourceRetrievalRelease(db,s.space,i.userId,s.refs,s.projects,undefined,[],[],s.exclusive,s.written);
  if(canonical(await discover(db,i))!==canonical(before))throw new HttpError(409,'Filing scope changed');
  if(await contentDecisionFromDb(db,{spaceId:before.personal,userId:i.userId},'activity',i.activityId,{includeOversight:false})!=='full')throw new HttpError(404,'Capture not found');
  await resolveContentCreationContext(db,{userId:i.userId,requestSpaceId:before.target.space_id,projectId:i.targetProjectId});
  return before.personal;
 }catch(error){if(error instanceof HttpError&&error.statusCode===403)throw new HttpError(404,'Filing target not found');throw error;}finally{close();}
}
