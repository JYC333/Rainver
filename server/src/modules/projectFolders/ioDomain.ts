import {createHash} from 'node:crypto';
import {mkdir,lstat,realpath,readdir} from 'node:fs/promises';
import {dirname,resolve} from 'node:path';
import {ensureGitRepository,isGitRepo,runLocationGit,writeFolderFile} from '@rainver/folder-read';
import {startGuardedConnectProxy} from '@rainver/outbound-guard';
import type {ServerConfig} from '../../config.js';
import type {Queryable} from '../routeUtils/common.js';
import {sharedHostConnectionRegistry} from '../hosts/connectionRegistry.js';
import {outboundGuard} from '../sources/outboundUrlSafety.js';
import {assertRemoteRepositoryUrl,CLONE_GIT_ALLOW_PROTOCOL} from './repositoryUrl.js';
import {PgProjectFolderRepository,lineEndingMode,revisionText,serializeDraftText,type ProjectFolderRow} from './repository.js';
import {PgWorkspaceLocationRepository,locationAbsoluteRoot,type ActiveLocationWithHost} from './workspaceLocations.js';
import {PgProjectFileRevisionStore} from './fileRevisionStore.js';
import {PgProjectFileDraftRepository,DraftQuotaError,DraftVersionConflictError,PROJECT_FILE_DRAFT_MAX_BYTES,PROJECT_FILE_DRAFT_MAX_TOTAL_BYTES,type ProjectFileDraftRow} from './draftRepository.js';
import {FolderIoRefusal,type FolderIoIntent} from './ioIntentRepository.js';

export interface FolderImportPlan{folderId:string;rootPath:string;registeredFrom:'managed'|'clone'|'scan';serverHostId:string;directoryStarted?:boolean;directoryCreated?:boolean;cloneStarted?:boolean;initialized?:boolean;canonicalRoot?:string}
export async function prepareFolderImport(db:Queryable,config:ServerConfig,intent:Pick<FolderIoIntent,'id'|'space_id'|'project_id'|'user_id'|'frozen_json'>):Promise<FolderImportPlan>{
  const input=intent.frozen_json.input,identity={spaceId:intent.space_id,userId:intent.user_id},name=String(input.name);
  if((await db.query("SELECT id FROM project_folders WHERE space_id=$1 AND project_id=$2 AND name=$3 AND status='active'",[intent.space_id,intent.project_id,name])).rows.length)throw new FolderIoRefusal('folder_name_conflict');
  let rootPath:string,registeredFrom:FolderImportPlan['registeredFrom'];
  if(input.root_path){
    rootPath=resolve(String(input.root_path));registeredFrom='scan';
    const candidates=await new PgProjectFolderRepository(db,config).scanCandidates(identity,intent.project_id);
    const info=await lstat(rootPath).catch(()=>null),canonical=await realpath(rootPath).catch(()=>null);
    if(!candidates.some(candidate=>candidate.path===rootPath)||!info?.isDirectory()||info.isSymbolicLink()||canonical!==rootPath)throw new FolderIoRefusal('folder_scan_target_changed');
  }else{
    rootPath=resolve(config.workspaceRoot,intent.space_id,`${name.replace(/[^a-zA-Z0-9._-]/g,'-').slice(0,80)||'folder'}-${intent.id}`);
    registeredFrom=input.repo_url?'clone':'managed';
    if(input.repo_url)assertRemoteRepositoryUrl(String(input.repo_url));
  }
  const host=(await db.query<{id:string}>("SELECT id FROM hosts WHERE kind='server'")).rows[0];if(!host)throw new Error('Server Host is missing');
  return{folderId:intent.id,rootPath,registeredFrom,serverHostId:host.id};
}
/** External import effects; progress is private and durable before every irreversible step. */
export async function applyFolderImport(config:ServerConfig,intent:FolderIoIntent,plan:FolderImportPlan,save:()=>Promise<void>,lease:()=>Promise<void>):Promise<void>{
  if(plan.registeredFrom==='scan'){
    const info=await lstat(plan.rootPath).catch(()=>null),canonical=await realpath(plan.rootPath).catch(()=>null);
    if(!info?.isDirectory()||info.isSymbolicLink()||canonical!==plan.rootPath)throw new FolderIoRefusal('folder_scan_target_changed');
    plan.initialized=true;plan.canonicalRoot=canonical;await save();return;
  }
  if(!plan.directoryCreated){
    if(plan.directoryStarted&&await lstat(plan.rootPath).catch(()=>null))throw new FolderIoRefusal('folder_creation_needs_attention');
    plan.directoryStarted=true;await save();await lease();
    await mkdir(dirname(plan.rootPath),{recursive:true});
    try{await mkdir(plan.rootPath);}catch(error){if((error as{code?:string}).code==='EEXIST')throw new FolderIoRefusal('folder_directory_conflict');throw error;}
    plan.directoryCreated=true;plan.canonicalRoot=await realpath(plan.rootPath);await save();
  }
  if(await realpath(plan.rootPath).catch(()=>null)!==plan.canonicalRoot)throw new FolderIoRefusal('folder_target_changed');
  if(plan.initialized)return;
  await lease();
  if(plan.registeredFrom==='managed'){
    if(!await ensureGitRepository(plan.rootPath))throw new FolderIoRefusal('folder_git_initialization_failed');
  }else if(plan.cloneStarted){
    // A lost clone acknowledgement may resume only a complete, unchanged checkout.
    const head=await runLocationGit(['rev-parse','HEAD'],plan.rootPath),status=await runLocationGit(['status','--porcelain'],plan.rootPath),origin=await runLocationGit(['config','--get','remote.origin.url'],plan.rootPath);
    if(!await isGitRepo(plan.rootPath)||head.code!==0||status.code!==0||status.stdout.trim()!==''||origin.stdout.trim()!==intent.frozen_json.input.repo_url)throw new FolderIoRefusal('folder_creation_needs_attention');
  }else{
    if((await readdir(plan.rootPath)).length)throw new FolderIoRefusal('folder_creation_needs_attention');
    plan.cloneStarted=true;await save();await lease();
    const repoUrl=String(intent.frozen_json.input.repo_url);assertRemoteRepositoryUrl(repoUrl);
    const proxy=await startGuardedConnectProxy(outboundGuard);
    try{
      const result=await runLocationGit(['-c',`http.proxy=${proxy.url}`,'-c','http.proxyAuthMethod=basic','-c','http.followRedirects=initial','clone','--',repoUrl,plan.rootPath],dirname(plan.rootPath),120000,{env:{GIT_ALLOW_PROTOCOL:CLONE_GIT_ALLOW_PROTOCOL,GIT_TERMINAL_PROMPT:'0',NO_PROXY:'',no_proxy:''}});
      if(result.code!==0)throw new FolderIoRefusal('folder_clone_failed');
    }finally{await proxy.close();}
  }
  plan.initialized=true;await save();
}
/** The canonical Folder/Location writer, called only by the final short transaction. */
export async function commitFolderImport(db:Queryable,intent:FolderIoIntent,plan:FolderImportPlan):Promise<Record<string,unknown>>{
  const input=intent.frozen_json.input;
  if((await db.query("SELECT id FROM project_folders WHERE space_id=$1 AND project_id=$2 AND name=$3 AND status='active'",[intent.space_id,intent.project_id,input.name])).rows.length)throw new FolderIoRefusal('folder_name_conflict');
  if(input.is_primary===true)await db.query('UPDATE project_folders SET is_primary=false,updated_at=now() WHERE space_id=$1 AND project_id=$2 AND is_primary=true',[intent.space_id,intent.project_id]);
  await db.query(`INSERT INTO project_folders(id,space_id,project_id,created_by_user_id,name,description,kind,is_primary,repo_url,default_branch,metadata_json,status,protected,system_managed,registered_from,created_at,updated_at)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,'active',false,$12,$13,now(),now())`,[plan.folderId,intent.space_id,intent.project_id,intent.user_id,input.name,input.description,input.kind,input.is_primary,input.repo_url,input.default_branch,JSON.stringify(input.metadata_json),plan.registeredFrom!=='scan',plan.registeredFrom]);
  await new PgWorkspaceLocationRepository(db).create({spaceId:intent.space_id,projectFolderId:plan.folderId,executionHostId:plan.serverHostId,executionHostKind:'server',rootPath:plan.rootPath});
  return{kind:'create',folder_id:plan.folderId};
}
export const fileHash=(content:string)=>createHash('sha256').update(content,'utf8').digest('hex');
export function savedDraftBytes(draft:ProjectFileDraftRow):{content:string;sha256:string}{const content=serializeDraftText(draft);return{content,sha256:fileHash(content)};}
export function assertSaveBaseline(intent:FolderIoIntent,current:{exists:boolean;file:import('@rainver/folder-read').FileContent|null}):void{
  const draft=intent.frozen_json.draft!;
  if(current.exists!==draft.base_exists||(draft.base_exists&&current.file?.sha256!==draft.base_sha256))throw new FolderIoRefusal('host_file_conflict');
  if((draft.line_ending_mode==='mixed'||lineEndingMode(draft.content)==='mixed'||current.file?.line_ending_mode==='mixed')&&intent.frozen_json.input.confirm_mixed_line_ending_normalization!==true)throw new FolderIoRefusal('mixed_line_endings_confirmation_required');
}
export async function writeFrozenDraft(config:ServerConfig,folder:ProjectFolderRow,location:ActiveLocationWithHost,path:string,desired:{content:string;sha256:string},before:{exists:boolean;file:import('@rainver/folder-read').FileContent|null}):Promise<void>{
  if(location.execution_host_kind==='remote'){
    const answer=await sharedHostConnectionRegistry.requestFolderWrite(location.execution_host_id,{workspace_location_id:location.id,path,content:desired.content,expected_exists:before.exists,expected_sha256:before.file?.sha256??null,protected:folder.protected,allow_encoding_conversion:before.file?.encoding==='utf16le'||before.file?.encoding==='utf16be'});
    if(!answer.ok)throw new FolderIoRefusal(['host_offline','host_timeout'].includes(answer.error)?'folder_write_unconfirmed':answer.error);
    if(!answer.exists||answer.sha256!==desired.sha256)throw new FolderIoRefusal('folder_write_unconfirmed');
  }else{
    const answer=await writeFolderFile(locationAbsoluteRoot(location,config.workspaceRoot),path,desired.content,{protectedFolder:folder.protected,expectedExists:before.exists,expectedSha256:before.file?.sha256??null,allowEncodingConversion:before.file?.encoding==='utf16le'||before.file?.encoding==='utf16be'});
    if(answer.sha256!==desired.sha256)throw new FolderIoRefusal('folder_write_unconfirmed');
  }
}
export async function commitSavedDraft(db:Queryable,intent:FolderIoIntent,before:{exists:boolean;file:import('@rainver/folder-read').FileContent|null},afterHash:string):Promise<Record<string,unknown>>{
  const frozen=intent.frozen_json,draft=frozen.draft!,folder=frozen.folder!;
  const revision=await new PgProjectFileRevisionStore(db).createInTransaction(db,{spaceId:intent.space_id,projectId:intent.project_id,projectFolderId:folder.id,workspaceLocationId:draft.workspace_location_id,path:draft.relative_path,beforeExists:before.exists,beforeContent:before.file?revisionText(before.file):null,afterExists:true,afterSha256:afterHash,userId:intent.user_id,retentionDays:folder.snapshot_retention_days,maxCount:folder.snapshot_max_count});
  const deleted=await new PgProjectFileDraftRepository(db).deleteExact(db,{id:draft.id,spaceId:intent.space_id,ownerUserId:intent.user_id,version:draft.version});
  return{kind:'save_draft',folder_id:folder.id,workspace_location_id:draft.workspace_location_id,path:draft.relative_path,revision,draft_deleted:deleted,newer_draft_retained:!deleted,after_sha256:afterHash};
}
export async function commitRestoredDraft(db:Queryable,intent:FolderIoIntent,current:{exists:boolean;file:import('@rainver/folder-read').FileContent|null}):Promise<Record<string,unknown>>{
  const frozen=intent.frozen_json,revision=frozen.revision!,content=revision.before_exists?revision.before_content??'':'';
  if(Buffer.byteLength(content,'utf8')>PROJECT_FILE_DRAFT_MAX_BYTES)throw new FolderIoRefusal('draft_revision_too_large');
  try{
    const draft=await new PgProjectFileDraftRepository(db).upsert({spaceId:intent.space_id,projectId:intent.project_id,projectFolderId:intent.folder_id!,workspaceLocationId:revision.workspace_location_id,ownerUserId:intent.user_id,mutation:{targetKind:current.exists?'existing':'new',expectedVersion:current.exists?frozen.existingDraft?.version??null:null,relativePath:revision.path,baseExists:current.exists,baseSha256:current.file?.sha256??null,content,contentSha256:fileHash(content),byteSize:Buffer.byteLength(content,'utf8'),sourceEncoding:'utf8',preserveBom:content.startsWith('\uFEFF'),lineEndingMode:lineEndingMode(content)}});
    return{kind:'restore_revision',draft_id:draft.id,workspace_location_id:draft.workspace_location_id,version:draft.version};
  }catch(error){
    if(error instanceof DraftVersionConflictError)throw new FolderIoRefusal('draft_version_conflict',{current_draft_id:error.current?.id??null,current_version:error.current?.version??null});
    if(error instanceof DraftQuotaError)throw new FolderIoRefusal('draft_quota_exceeded',{used_bytes:error.usedBytes,requested_bytes:error.requestedBytes,limit_bytes:PROJECT_FILE_DRAFT_MAX_TOTAL_BYTES});
    throw error;
  }
}
