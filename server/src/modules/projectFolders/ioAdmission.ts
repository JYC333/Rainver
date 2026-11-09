import type {ServerConfig} from '../../config.js';
import type {Queryable} from '../routeUtils/common.js';
import {assertCurrentActor,sessionActor} from '../systemActions/operations/actor.js';
import {assertProjectWriter,assertProjectWriterForMutation,lockActiveProjectForMutation,canWriteProject} from '../projects/access.js';
import {PgProjectFolderRepository} from './repository.js';
import {PgProjectFileDraftRepository,lockProjectFileDraftQuota} from './draftRepository.js';
import {PgProjectFileRevisionStore} from './fileRevisionStore.js';
import {resolveLocationWithHost} from './workspaceLocations.js';
import {enforce} from '../policy/service.js';
import {loadActionRegistry} from '../policy/actionRegistry.js';
import {JobDeferredError} from '../jobs/handlerRegistry.js';
import {canonical} from '../systemActions/operations/repository.js';
import {FolderIoRefusal,type FolderIoFrozen,type FolderIoIntent,type FolderIoKind} from './ioIntentRepository.js';

export const folderIoKind=(operation:string):FolderIoKind=>({'project.folder.create':'create','project.folder.scan':'scan','project.folder.draft.save':'save_draft','project.folder.revision.restore':'restore_revision'} as Record<string,FolderIoKind>)[operation]!;
/** Read-only discovery. Project/Folder/Host/quota/source locks follow in the owner. */
export async function discoverFolderIo(db:Queryable,kind:FolderIoKind,input:Record<string,unknown>,space:string,user:string):Promise<{folder_id:string|null;location_id:string|null}>{
  const folder=typeof input.folder_id==='string'?input.folder_id:null;
  let location:string|null=null;
  if(kind==='save_draft')location=(await db.query<{workspace_location_id:string}>('SELECT workspace_location_id FROM project_file_drafts WHERE id=$1 AND space_id=$2 AND owner_user_id=$3 AND project_id=$4 AND project_folder_id=$5 AND expires_at>now()',[input.draft_id,space,user,input.project_id,folder])).rows[0]?.workspace_location_id??null;
  if(kind==='restore_revision')location=(await db.query<{workspace_location_id:string}>("SELECT workspace_location_id FROM project_file_revisions WHERE id=$1 AND space_id=$2 AND project_id=$3 AND project_folder_id=$4 AND status='available' AND expires_at>now()",[input.revision_id,space,input.project_id,folder])).rows[0]?.workspace_location_id??null;
  if(['save_draft','restore_revision'].includes(kind)&&!location)throw new FolderIoRefusal('operation_not_found');
  return{folder_id:folder,location_id:location};
}
export async function lockFolderIoAuthority(db:Queryable,config:ServerConfig,kind:FolderIoKind,input:Record<string,unknown>,space:string,user:string,expected:{folder_id:string|null;location_id:string|null}):Promise<FolderIoFrozen>{
  await assertCurrentActor(db,sessionActor({spaceId:space,userId:user}));
  await assertProjectWriter(db,space,String(input.project_id),user,{allowArchived:true});
  await lockActiveProjectForMutation(db,space,String(input.project_id));
  await assertProjectWriterForMutation(db,space,String(input.project_id),user);
  const current=await discoverFolderIo(db,kind,input,space,user);
  if(canonical(current)!==canonical(expected))throw new FolderIoRefusal('operation_conflict');
  const frozen:FolderIoFrozen={input};
  if(!current.folder_id)return frozen;
  await db.query('SELECT id FROM project_folders WHERE id=$1 AND space_id=$2 AND project_id=$3 FOR UPDATE',[current.folder_id,space,input.project_id]);
  frozen.folder=await new PgProjectFolderRepository(db,config).writableFolderForIo({spaceId:space,userId:user},String(input.project_id),current.folder_id);
  const located=(await db.query<{execution_host_id:string}>('SELECT execution_host_id FROM workspace_locations WHERE id=$1 AND space_id=$2 AND project_folder_id=$3',[current.location_id,space,current.folder_id])).rows[0];
  if(!located)throw new FolderIoRefusal('operation_not_found');
  await db.query('SELECT id FROM hosts WHERE id=$1 FOR SHARE',[located.execution_host_id]);
  await db.query('SELECT id FROM workspace_locations WHERE id=$1 AND space_id=$2 AND project_folder_id=$3 FOR SHARE',[current.location_id,space,current.folder_id]);
  frozen.location=await resolveLocationWithHost(db,space,current.folder_id,current.location_id!);
  if(frozen.location.execution_host_kind==='remote'&&frozen.location.host_owner_user_id!==user)throw new FolderIoRefusal('operation_not_found');
  await lockProjectFileDraftQuota(db,space,user);
  if(kind==='save_draft'){
    const draft=await new PgProjectFileDraftRepository(db).getById({id:String(input.draft_id),spaceId:space,ownerUserId:user,projectFolderId:current.folder_id});
    if(!draft)throw new FolderIoRefusal('operation_not_found');
    if(draft.version!==input.draft_version)throw new FolderIoRefusal('draft_version_conflict',{current_draft_id:draft.id,current_version:draft.version});
    frozen.draft=draft;
  }else{
    const revision=await new PgProjectFileRevisionStore(db).getAvailable(space,String(input.project_id),current.folder_id,String(input.revision_id));
    if(!revision)throw new FolderIoRefusal('operation_not_found');
    frozen.revision=revision;
    await db.query('SELECT id FROM project_file_revisions WHERE id=$1 AND space_id=$2 FOR SHARE',[revision.id,space]);
    frozen.existingDraft=(await db.query<{id:string;version:number}>("SELECT id,version FROM project_file_drafts WHERE space_id=$1 AND owner_user_id=$2 AND project_folder_id=$3 AND workspace_location_id=$4 AND relative_path=$5 AND target_kind='existing' AND expires_at>now() FOR UPDATE",[space,user,current.folder_id,current.location_id,revision.path])).rows[0]??null;
  }
  return frozen;
}
/** Recheck live execution authority without reopening a core command or its key. */
export async function authorizeFolderIoWorker(db:Queryable,config:ServerConfig,intent:FolderIoIntent,phase:'prepare'|'commit'):Promise<void>{
  const identity={spaceId:intent.space_id,userId:intent.user_id};
  await assertCurrentActor(db,sessionActor(identity));
  const project=(await db.query<{status:string}>('SELECT status FROM projects WHERE id=$1 AND space_id=$2 AND deleted_at IS NULL FOR UPDATE',[intent.project_id,intent.space_id])).rows[0];
  if(!project||!await canWriteProject(db,intent.space_id,intent.project_id,intent.user_id,{lockAuthority:true}))throw new FolderIoRefusal('operation_not_found');
  if(project.status!=='active')throw new FolderIoRefusal('operation_conflict');
  const frozen=intent.frozen_json;
  if(intent.folder_id){
    if(!(await db.query("SELECT id FROM project_folders WHERE id=$1 AND space_id=$2 AND project_id=$3 AND status='active' FOR UPDATE",[intent.folder_id,intent.space_id,intent.project_id])).rows.length)throw new FolderIoRefusal('operation_not_found');
    const folder=await new PgProjectFolderRepository(db,config).writableFolderForIo(identity,intent.project_id,intent.folder_id);
    if(folder.protected!==frozen.folder?.protected)throw new FolderIoRefusal('operation_conflict');
    await db.query('SELECT id FROM hosts WHERE id=$1 FOR SHARE',[frozen.location!.execution_host_id]);
    if(!(await db.query('SELECT id FROM workspace_locations WHERE id=$1 AND space_id=$2 AND project_folder_id=$3 FOR SHARE',[frozen.location!.id,intent.space_id,intent.folder_id])).rows.length)throw new FolderIoRefusal('operation_not_found');
    const location=await resolveLocationWithHost(db,intent.space_id,intent.folder_id,frozen.location!.id);
    if(location.execution_host_id!==frozen.location!.execution_host_id||location.execution_host_kind!==frozen.location!.execution_host_kind||location.root_path!==frozen.location!.root_path)throw new FolderIoRefusal('operation_conflict');
    if(location.execution_host_kind==='remote'){
      if(location.host_owner_user_id!==intent.user_id)throw new FolderIoRefusal('operation_not_found');
      if(phase==='prepare'&&!location.host_online)throw new JobDeferredError('Folder request is waiting for its Host',30000);
    }
    await lockProjectFileDraftQuota(db,intent.space_id,intent.user_id);
    if(intent.kind==='restore_revision'){
      const revision=await new PgProjectFileRevisionStore(db).getAvailable(intent.space_id,intent.project_id,intent.folder_id,frozen.revision!.id);
      if(!revision||revision.before_content!==frozen.revision!.before_content)throw new FolderIoRefusal('operation_not_found');
      await db.query('SELECT id FROM project_file_revisions WHERE id=$1 AND space_id=$2 FOR SHARE',[revision.id,intent.space_id]);
    }
    if(intent.kind==='save_draft'&&intent.status==='pending'){
      const draft=await new PgProjectFileDraftRepository(db).getById({id:frozen.draft!.id,spaceId:intent.space_id,ownerUserId:intent.user_id,projectFolderId:intent.folder_id});
      if(!draft||draft.version!==frozen.draft!.version||draft.content_sha256!==frozen.draft!.content_sha256)throw new FolderIoRefusal('draft_version_conflict',{current_draft_id:draft?.id??null,current_version:draft?.version??null});
    }
  }
  const policy=await enforce({...config,auditTransaction:db},await loadActionRegistry(),{
    action:intent.kind==='save_draft'?'project_folder.apply_patch':'project.folder.command',actor_type:'user',actor_id:intent.user_id,space_id:intent.space_id,
    resource_type:intent.kind==='save_draft'?'project_folder':'project',resource_id:intent.kind==='save_draft'?intent.folder_id!:intent.project_id,resource_space_id:intent.space_id,
    context:{trigger_origin:'manual',direct_user_write:true,file_operation:'write',project_id:intent.project_id,project_folder_id:intent.folder_id,relative_path:frozen.draft?.relative_path??frozen.revision?.path??null},
    metadata_json:{folder_io_intent_id:intent.id,folder_io_phase:phase},force_record:true,
  });
  if(policy.status!=='allow')throw new FolderIoRefusal(policy.status==='error'?'operation_audit_unavailable':'operation_not_found');
}
