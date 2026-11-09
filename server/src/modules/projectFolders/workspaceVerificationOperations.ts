import {verificationCommandArgv} from '../runs/verification/commandArgv.js';
import {WorkspaceVerificationGetInputSchema,WorkspaceVerificationConfigureInputSchema,type RegisteredSystemActionDefinition,type OperationActor} from '@rainver/protocol';
import type {Queryable} from '../routeUtils/common.js';
import {ProjectFolderExecutionConfigRepository} from '../projectFolderExecutionConfigs/repository.js';
import {PgRunRepository} from '../runs/repository.js';
import type {ExecutionWorkspaceRow} from './executionWorkspaces.js';
import {workspaceVerificationFolder} from './workspaceVerificationFolder.js';
import {authorizedWorkspaceChange} from './workspaceOperations.js';
import type {OperationRegistration} from '../systemActions/operations/types.js';
import {OperationBusinessError,hidden} from '../systemActions/operations/errors.js';

async function subject(db:Queryable,integrationId:string,actor:OperationActor,write=false){
 const merge=(await db.query<{id:string;change_set_id:string;revision:number;status:string;attempt_id:string;resolution_run_id:string|null;detail_json:Record<string,unknown>}>('SELECT id,change_set_id,revision,status,attempt_id,resolution_run_id,detail_json FROM task_merges WHERE id=$1 AND space_id=$2 AND workspace_id IS NOT NULL',[integrationId,actor.space_id])).rows[0];
 if(!merge)throw hidden();
 const change=await authorizedWorkspaceChange(db,merge.change_set_id,actor,write,true,!write,false,'verification');
 const workspace=(await db.query<ExecutionWorkspaceRow>('SELECT * FROM execution_workspaces WHERE id=$1 AND space_id=$2',[change.workspace_id,actor.space_id])).rows[0];
 const origin=await new PgRunRepository(db).getRun(actor.space_id,change.originating_run_id);
 if(!workspace||!origin)throw hidden();
 const folder=await workspaceVerificationFolder(db,workspace,origin);
 if(!folder)throw new OperationBusinessError('operation_conflict',409,'workspace_verification');
 const candidateVerification=Boolean(actor.run_id&&(merge.resolution_run_id===actor.run_id||merge.detail_json.reply_owner_run_id===actor.run_id&&merge.detail_json.inline_phase_state==='running')&&merge.status==='resolving'&&['verification_setup','verification'].includes(String(merge.detail_json.repair_kind)));
 const candidateSetup=candidateVerification&&merge.detail_json.repair_kind==='verification_setup';
 const currentOwner=Boolean(actor.run_id&&merge.detail_json.reply_owner_run_id===actor.run_id&&change.state==='integrating'&&['queued','rebasing','resolving','verifying'].includes(merge.status));
 if(write){
  if(!candidateVerification&&!currentOwner&&(change.state!=='blocked'||!['failed','conflict','verification_failed'].includes(merge.status)))throw new OperationBusinessError('operation_conflict',409,'workspace_verification');
  const current=(await db.query<{status:string}>('SELECT status FROM project_folders WHERE id=$1 AND space_id=$2 FOR UPDATE',[folder.project_folder_id,actor.space_id])).rows[0];
  if(current?.status!=='active')throw new OperationBusinessError('operation_conflict',409,'workspace_verification');
  await db.query('SELECT id FROM project_folder_execution_configs WHERE project_folder_id=$1 AND space_id=$2 FOR UPDATE',[folder.project_folder_id,actor.space_id]);
 }
 return {merge,change,workspace,folder,candidateSetup,origin};
}
async function view(db:Queryable,s:Awaited<ReturnType<typeof subject>>,actor:OperationActor){
 const conversation=s.origin.session_id?(await db.query<{room_id:string|null}>('SELECT room_id FROM sessions WHERE id=$1 AND space_id=$2',[s.origin.session_id,actor.space_id])).rows[0]:null;
 const config=await new ProjectFolderExecutionConfigRepository(db).getVerification({spaceId:actor.space_id,userId:actor.on_behalf_of_user_id!},s.change.project_id,s.folder.project_folder_id);
 return {integration_id:s.merge.id,change_set_id:s.change.id,project_id:s.change.project_id,folder_id:s.folder.project_folder_id,folder_name:s.folder.name,
  conversation_id:s.origin.session_id,room_id:conversation?.room_id??null,agent_id:s.origin.agent_id,source_commit:(await db.query<{source_commit:string}>('SELECT source_commit FROM task_merges WHERE id=$1',[s.merge.id])).rows[0]?.source_commit??null,config_version:config?.version??null,test_commands:config?.test_commands_json??[],build_commands:config?.build_commands_json??[],validation_recipe_id:config?.validation_recipe_id??null,
  integration_revision:s.merge.revision,integration_status:s.merge.status,can_retry:s.change.state==='blocked'&&s.workspace.state!=='blocked'&&s.workspace.state!=='retired'&&['failed','conflict','verification_failed'].includes(s.merge.status)};
}
export function workspaceVerificationRegistrations(definitions:ReadonlyMap<string,RegisteredSystemActionDefinition>):OperationRegistration[]{
 return (['workspace.integration.verification.get','workspace.integration.verification.configure'] as const).map(id=>{
  const write=id.endsWith('.configure');
  return {definition:definitions.get(id)!,...(write?{}:{readKind:'metadata' as const}),
   async resolve(db,raw,actor){const input=WorkspaceVerificationGetInputSchema.parse({integration_id:(raw as {integration_id:string}).integration_id});const s=await subject(db,input.integration_id,actor);return {authority:`workspace:${s.change.workspace_id}`,targets:{workspace_id:s.change.workspace_id,change_set_id:s.change.id,folder_id:s.folder.project_folder_id},resourceType:'project',resourceId:s.change.project_id};},
   async authorize(db,raw,actor){await subject(db,(raw as {integration_id:string}).integration_id,actor,write);},
   async authorizeResult(db,raw,actor){await subject(db,(raw as {integration_id:string}).integration_id,actor);},
   async execute(db,raw,actor){
    const s=await subject(db,(raw as {integration_id:string}).integration_id,actor,write);
    if(write){
     const input=WorkspaceVerificationConfigureInputSchema.parse(raw),before=await view(db,s,actor);
     if(input.expected_config_version!==before.config_version)throw new OperationBusinessError('operation_conflict',409,'workspace_verification');
     if(input.no_project_checks){
      if(!s.candidateSetup||input.test_commands.length||input.build_commands.length)throw new OperationBusinessError('operation_invalid_input',422,'workspace_verification');
      await db.query("UPDATE task_merges SET detail_json=detail_json||$2::jsonb WHERE id=$1 AND attempt_id=$3",[s.merge.id,JSON.stringify({agent_verification_basic:{attempt_id:s.merge.attempt_id,run_id:actor.run_id,note:input.note}}),s.merge.attempt_id]);
      return view(db,s,actor);
     }
     if([...input.test_commands,...input.build_commands].some(command=>!verificationCommandArgv(command)))throw new OperationBusinessError('operation_invalid_input',422,'workspace_verification');
     const configs=new ProjectFolderExecutionConfigRepository(db),identity={spaceId:actor.space_id,userId:actor.on_behalf_of_user_id!};
     const commands={test_commands_json:input.test_commands,build_commands_json:input.build_commands};
     if(before.config_version===null)await configs.create(identity,s.change.project_id,s.folder.project_folder_id,commands);
     else await configs.update(identity,s.change.project_id,s.folder.project_folder_id,commands);
    }
    return view(db,s,actor);
   },
   classifyError(error){if((error as {code?:string;constraint?:string}).code==='23505'&&(error as {constraint?:string}).constraint==='uq_project_folder_execution_configs_project_folder')return new OperationBusinessError('operation_conflict',409,'workspace_verification');return undefined;},
  } satisfies OperationRegistration;
 });
}
