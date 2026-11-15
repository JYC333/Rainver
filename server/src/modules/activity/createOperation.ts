import type {OperationInput,RegisteredSystemActionDefinition} from '@rainver/protocol';
import {applyContentCreationContext,resolveContentCreationContext} from '../access/creationContext.js';
import {contentDecisionFromDb} from '../access/contentAccessQuery.js';
import {assertProjectWriterForMutation} from '../projects/access.js';
import {projectFolderReadAccessSql} from '../projectFolders/access.js';
import {PgConversationExecutionContextRepository} from '../sessions/executionContextRepository.js';
import {HttpError,type Queryable} from '../routeUtils/common.js';
import {lockSourceRetrievalRelease} from '../sources/retrievalReleaseLocks.js';
import {hidden,markedRefusal,OperationError} from '../systemActions/operations/errors.js';
import type {OperationRegistration} from '../systemActions/operations/types.js';
import {PgActivityRepository} from './repository.js';
type Input=OperationInput<'activity.create'>;
async function sessionScope(db:Queryable,space:string,i:Input){return i.source_session_id?(await db.query<{id:string;project_id:string|null;project_folder_id:string|null;room_id:string|null}>('SELECT id,project_id,project_folder_id,room_id FROM sessions WHERE space_id=$1 AND id=$2',[space,i.source_session_id])).rows[0]??null:null;}
async function runScope(db:Queryable,space:string,i:Input){return i.source_run_id?(await db.query<{room_id:string|null;project_id:string|null;run_group_id:string|null;session_id:string|null;project_folder_id:string|null}>(`SELECT room.id AS room_id,room.project_id,run.run_group_id,run.session_id,session.project_folder_id FROM runs run LEFT JOIN agent_run_groups grp ON grp.id=run.run_group_id AND grp.space_id=run.space_id LEFT JOIN sessions session ON session.id=run.session_id AND session.space_id=run.space_id LEFT JOIN rooms room ON room.space_id=run.space_id AND room.id=COALESCE(grp.room_id,session.room_id) WHERE run.space_id=$1 AND run.id=$2`,[space,i.source_run_id])).rows[0]??null:null;}
export function activityCreateRegistration(defs:ReadonlyMap<string,RegisteredSystemActionDefinition>):OperationRegistration{
 return {
  definition:defs.get('activity.create')!,userContentCreation:true,
  normalizeInput(raw){const i=raw as Input;if(i.project_id)return i;const normalized={...i};delete normalized.project_folder_id;return normalized;},
  async resolve(_db,raw,a){return {authority:`activity-create:${a.space_id}:${a.on_behalf_of_user_id}`,targets:{project_id:(raw as Input).project_id??null},resourceType:'space',resourceId:a.space_id};},
  async authorize(db,raw,a){
   const i=raw as Input,session=await sessionScope(db,a.space_id,i),run=await runScope(db,a.space_id,i);
   const refs=[...(i.agent_id?[{object_type:'agent' as const,object_id:i.agent_id}]:[]),...(i.source_run_id?[{object_type:'run' as const,object_id:i.source_run_id}]:[]),...(i.source_task_id?[{object_type:'task' as const,object_id:i.source_task_id}]:[])];
   const projects=[...new Set([i.project_id,session?.project_id,run?.project_id].filter((id):id is string=>!!id))];
   const folders=[...new Set([i.project_folder_id,session?.project_folder_id,run?.project_folder_id].filter((id):id is string=>!!id))];
   await lockSourceRetrievalRelease(db,a.space_id,a.on_behalf_of_user_id!,refs,projects,async()=>{
    for(const room of [...new Set([run?.room_id,session?.room_id].filter((id):id is string=>!!id))].sort()){
     await db.query('SELECT id FROM rooms WHERE space_id=$1 AND id=$2 FOR SHARE',[a.space_id,room]);
     await db.query('SELECT user_id FROM room_user_members WHERE space_id=$1 AND room_id=$2 ORDER BY user_id FOR SHARE',[a.space_id,room]);
    }
   },folders,[],[],i.project_id?[i.project_id]:[]);
   if(run?.run_group_id)await db.query('SELECT id FROM agent_run_groups WHERE space_id=$1 AND id=$2 FOR SHARE',[a.space_id,run.run_group_id]);
   for(const sessionId of [...new Set([i.source_session_id,run?.session_id].filter((id):id is string=>!!id))].sort())await db.query('SELECT id FROM sessions WHERE space_id=$1 AND id=$2 FOR SHARE',[a.space_id,sessionId]);
   if(JSON.stringify(session)!==JSON.stringify(await sessionScope(db,a.space_id,i))||JSON.stringify(run)!==JSON.stringify(await runScope(db,a.space_id,i)))throw new OperationError('operation_conflict',409);
   const creation=await resolveContentCreationContext(db,{userId:a.on_behalf_of_user_id!,requestSpaceId:a.space_id,projectId:i.project_id});
   if(creation.spaceId!==a.space_id)throw new OperationError('operation_conflict',409);
   if(i.project_id)await assertProjectWriterForMutation(db,a.space_id,i.project_id,a.on_behalf_of_user_id!);
   const person={spaceId:a.space_id,userId:a.on_behalf_of_user_id!};
   for(const ref of refs)if(await contentDecisionFromDb(db,person,ref.object_type,ref.object_id,{includeOversight:false})!=='full')throw hidden();
   if(i.source_session_id&&!await new PgConversationExecutionContextRepository(db as never).getVisibleSession(person,i.source_session_id))throw hidden();
   if(i.project_folder_id&&!(await db.query(`SELECT 1 FROM project_folders f WHERE f.space_id=$1 AND f.id=$2 AND ${projectFolderReadAccessSql({spaceExpr:'f.space_id',projectFolderExpr:'f.id',userExpr:'$3'})}`,[a.space_id,i.project_folder_id,person.userId])).rows.length)throw hidden();
  },
  async authorizeResult(db,raw,a){const out=raw as {space_id:string;id:string};if(out.space_id!==a.space_id||await contentDecisionFromDb(db,{spaceId:a.space_id,userId:a.on_behalf_of_user_id!},'activity',out.id,{includeOversight:false})!=='full')throw hidden();},
  async execute(db,raw,a){const i=raw as Input,creation=await resolveContentCreationContext(db,{userId:a.on_behalf_of_user_id!,requestSpaceId:a.space_id,projectId:i.project_id});return new PgActivityRepository(db).create({spaceId:a.space_id,userId:a.on_behalf_of_user_id!},applyContentCreationContext(i,creation));},
  classifyError:error=>error instanceof HttpError?markedRefusal(error,'activity'):undefined,
 };
}
