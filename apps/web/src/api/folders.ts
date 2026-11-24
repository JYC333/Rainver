import { sessionEpoch } from '../lib/sessionResidue'
import type {
  FileContent,
  FileNode,
  GitStatus,
  Page,
  ProjectFileDraft,
  ProjectFileDraftQuota,
  ProjectFileDraftSave,
  ProjectFileRevision,
  ProjectFolder,
  ProjectFolderCreateBody,
  WorkspaceLocation,
} from '../types/api'
import { noteObjectCall, callOperation, commandReceipt } from './operations'
import { pollRead, READ_PENDING } from './pollRead'
import type { RequestOptions } from './transport'
import { ApiRequestError, _spaceId, get } from './transport'
import type { OperationInput } from '@rainver/protocol'

// ── Project Folders ──────────────────────────────────────────────────────
function folderRefusalMetadata(error:unknown):Record<string,unknown>|null{
  if(!(error instanceof ApiRequestError))return null;
  const failure=error.payload?.error as {metadata?:Record<string,unknown>}|undefined;
  return failure?.metadata??null;
}

async function hydrateDraftConflict(error:unknown,projectId:string,folderId:string,spaceId:string,signal?:AbortSignal):Promise<void>{
  const metadata=folderRefusalMetadata(error);
  if(metadata?.code!=='draft_version_conflict')return;
  if(metadata.current_draft_id===null){Object.assign(error as object,{currentDraft:null});return;}
  if(typeof metadata.current_draft_id!=='string')return;
  try{
    const current=await get<ProjectFileDraft>(`/projects/${encodeURIComponent(projectId)}/folders/${encodeURIComponent(folderId)}/file/drafts/${encodeURIComponent(metadata.current_draft_id)}`,{spaceId,signal});
    Object.assign(error as object,{currentDraft:current});
  }catch{/* Retain the canonical refusal if current authority or the supplementary read fails. */}
}

async function readPrivateFolderDraft(receipt:{id:string;space_id:string;project_id:string;folder_id:string},version:number):Promise<ProjectFileDraft>{
  const current=await get<ProjectFileDraft>(`/projects/${encodeURIComponent(receipt.project_id)}/folders/${encodeURIComponent(receipt.folder_id)}/file/drafts/${encodeURIComponent(receipt.id)}`,{spaceId:receipt.space_id});
  if(current.version!==version){const error=new ApiRequestError('The draft changed in another tab',409,'operation_conflict',{error:{code:'operation_conflict',metadata:{code:'draft_version_conflict',current_draft_id:current.id,current_version:current.version}}});throw Object.assign(error,{currentDraft:current});}
  return current;
}

/** Read-only polling of one durable Folder request. Never resubmits its command. */
async function waitForFolderIo(receipt:import('@rainver/protocol').OperationOutput<'project.folder.scan'>,epoch:number):Promise<import('@rainver/protocol').ProjectFolderIoStatus>{
  return pollRead({
    epoch, intervalMs: 250, timeoutMs: 150_000,
    sessionChanged: 'The session changed while the Folder request was running',
    timedOut: () => new ApiRequestError('The Folder request is still running; check the Job Queue',503,'operation_temporarily_unavailable',{
      error:{code:'operation_temporarily_unavailable',metadata:{intent_id:receipt.id,job_id:receipt.job_id}},
    }),
  }, signal => get<import('@rainver/protocol').ProjectFolderIoStatus>(
    `/projects/${encodeURIComponent(receipt.project_id)}/folder-io/${encodeURIComponent(receipt.id)}`, {spaceId:receipt.space_id,signal},
  ), async (current, signal) => {
    if(current.status==='succeeded')return current;
    if(current.status==='failed'||current.status==='needs_attention'){
      const code=current.error?.code??'folder_io_requires_attention';
      const invalid=['draft_quota_exceeded','draft_revision_too_large','mixed_line_endings_confirmation_required'].includes(code);
      const message=code==='mixed_line_endings_confirmation_required'?'Saving this draft requires confirmation to normalize mixed line endings':current.status==='needs_attention'?'The Folder request needs attention; open the Job Queue before trying another change':'The Folder request could not complete';
      const error=new ApiRequestError(message,invalid?422:409,invalid?'operation_invalid_input':'operation_conflict',{error:{code:invalid?'operation_invalid_input':'operation_conflict',metadata:{code,...current.error?.metadata,intent_id:receipt.id,job_id:receipt.job_id,io_status:current.status}}});
      if(receipt.folder_id)await hydrateDraftConflict(error,receipt.project_id,receipt.folder_id,receipt.space_id,signal);
      throw error;
    }
    return READ_PENDING
  })
}

/** Isolated Agent workspace progress: read-only projections. Commands stay in Operation Core. */
export const agentWorkspacesApi = {
  conversationChanges: (sessionId: string, page: { cursor?: string | null } = {}, options?: RequestOptions) =>
    get<import('@rainver/protocol').ConversationWorkspaceChanges>(`/sessions/${encodeURIComponent(sessionId)}/workspace-changes${page.cursor ? `?${new URLSearchParams({ cursor: page.cursor })}` : ''}`, options),
  /** One entry per conversation × repository: state, latest result and open problems. */
  groups: (projectId: string, params: { view: 'current' | 'history'; cursor?: string | null; limit?: number }, options?: RequestOptions) =>
    get<import('@rainver/protocol').AgentWorkspaceGroupPage>(`/projects/${encodeURIComponent(projectId)}/agent-workspace-groups?` + new URLSearchParams({
      view: params.view, limit: String(params.limit ?? 20), ...(params.cursor ? { cursor: params.cursor } : {}),
    }), options),
  /** Per-generation rows; `view=all` with `group` is one entry's execution history. */
  list: (projectId: string, params: { view: 'current' | 'history' | 'all'; group?: string; cursor?: string | null; limit?: number }, options?: RequestOptions) =>
    get<import('@rainver/protocol').AgentWorkspacePage>(`/projects/${encodeURIComponent(projectId)}/agent-workspaces?` + new URLSearchParams({
      view: params.view, limit: String(params.limit ?? 20), ...(params.group ? { group: params.group } : {}), ...(params.cursor ? { cursor: params.cursor } : {}),
    }), options),
  detail: (projectId: string, workspaceId: string, page: { cursor?: string | null } = {}, options?: RequestOptions) =>
    get<import('@rainver/protocol').AgentWorkspaceDetail>(`/projects/${encodeURIComponent(projectId)}/agent-workspaces/${encodeURIComponent(workspaceId)}${page.cursor ? `?${new URLSearchParams({ cursor: page.cursor })}` : ''}`, options),
}

export const projectFoldersApi = {
  list:    (projectId: string, params: Record<string, string> = {}, options?: RequestOptions) =>
    get<Page<ProjectFolder>>(`/projects/${projectId}/folders?` + new URLSearchParams(params), options),
  listExecutionReady: async (projectId: string, params: Record<string, string> = {}) => {
    const page = await get<Page<ProjectFolder>>(`/projects/${projectId}/folders?` + new URLSearchParams(params))
    const ready = (await Promise.all(page.items.map(async folder => {
      const locations = await get<WorkspaceLocation[]>(`/projects/${projectId}/folders/${folder.id}/locations`)
      return locations.some(location => location.status === 'active' && location.execution_ready) ? folder : null
    }))).filter((folder): folder is ProjectFolder => folder !== null)
    return { ...page, items: ready, total: ready.length }
  },
  create:async(projectId:string,data:ProjectFolderCreateBody,key:string=crypto.randomUUID())=>{
    const epoch = sessionEpoch()
    const receipt=await noteObjectCall('project.folder.create',{...data,project_id:projectId},key),status=await waitForFolderIo(receipt, epoch);
    if(status.result?.kind!=='create')throw new Error('Folder creation receipt is unavailable');return get<ProjectFolder>(`/projects/${encodeURIComponent(receipt.project_id)}/folders/${encodeURIComponent(status.result.folder_id)}`,{spaceId:receipt.space_id});
  },
  scan:async(projectId:string,key:string=crypto.randomUUID())=>{
    const epoch = sessionEpoch()
    const receipt=await noteObjectCall('project.folder.scan',{project_id:projectId},key),status=await waitForFolderIo(receipt, epoch);if(status.result?.kind!=='scan')throw new Error('Folder scan receipt is unavailable');return {items:status.result.items};
  },
  get:     (projectId: string, folderId: string, options?: RequestOptions) =>
    get<ProjectFolder>(`/projects/${projectId}/folders/${folderId}`, options),
  locations: (projectId: string, folderId: string, options: RequestOptions = {}) =>
    get<WorkspaceLocation[]>(`/projects/${projectId}/folders/${folderId}/locations`, options),
  activateLocation: async (projectId:string,folderId:string,locationId:string,key:string=crypto.randomUUID())=>{
    const receipt=await noteObjectCall('project.folder.location.activate',{project_id:projectId,folder_id:folderId,location_id:locationId},key);
    const rows=await get<WorkspaceLocation[]>(`/projects/${encodeURIComponent(receipt.project_id)}/folders/${encodeURIComponent(receipt.folder_id)}/locations`,{spaceId:receipt.space_id}),row=rows.find(location=>location.id===receipt.id);
    if(!row)throw new Error('Workspace Location no longer available');return row;
  },
  update:async(projectId:string,folderId:string,data:Omit<OperationInput<'project.folder.update'>,'project_id'|'folder_id'>,key:string=crypto.randomUUID())=>{
    const receipt=await noteObjectCall('project.folder.update',{...data,project_id:projectId,folder_id:folderId},key);
    return get<ProjectFolder>(`/projects/${encodeURIComponent(receipt.project_id)}/folders/${encodeURIComponent(receipt.folder_id)}`,{spaceId:receipt.space_id});
  },
  archive:async(projectId:string,folderId:string,key:string=crypto.randomUUID())=>{
    await noteObjectCall('project.folder.archive',{project_id:projectId,folder_id:folderId},key);return null;
  },
  unregister: async(projectId:string,folderId:string,confirm=false,key:string=crypto.randomUUID())=>{
    await noteObjectCall('project.folder.unregister',{project_id:projectId,folder_id:folderId,confirm},key);return null;
  },
  tree:    (projectId: string, folderId: string, path = '.', offset = 0, options: RequestOptions = {}) =>
    get<FileNode>(`/projects/${projectId}/folders/${folderId}/tree?path=${encodeURIComponent(path)}&offset=${offset}`, options),
  file:    (projectId: string, folderId: string, path: string, options: RequestOptions & { convertUtf8?: boolean } = {}) =>
    get<FileContent>(`/projects/${projectId}/folders/${folderId}/file?path=${encodeURIComponent(path)}${options.convertUtf8 ? '&convert=utf8' : ''}`, options),
  draft:   (projectId: string, folderId: string, path: string) =>
    get<ProjectFileDraft | null>(`/projects/${projectId}/folders/${folderId}/file/draft?path=${encodeURIComponent(path)}`),
  upsertDraft:async(projectId:string,folderId:string,data:Omit<OperationInput<'project.folder.draft.upsert'>,'project_id'|'folder_id'>,key:string=crypto.randomUUID(),spaceId:string=_spaceId)=>{
    try{
      const result=await callOperation('project.folder.draft.upsert',{...data,project_id:projectId,folder_id:folderId},key,{spaceId});
      if(!('status' in result)||result.status!=='succeeded')throw new Error('Draft action did not complete');
      return readPrivateFolderDraft(result.data,result.data.version);
    }catch(error){if(!(error&&typeof error==='object'&&'currentDraft' in error))await hydrateDraftConflict(error,projectId,folderId,spaceId);throw error;}
  },
  rebaseDraft:(projectId:string,folderId:string,data:Omit<OperationInput<'project.folder.draft.upsert'>,'project_id'|'folder_id'|'expected_version'>&{expected_version:number},key:string=crypto.randomUUID()):Promise<ProjectFileDraft>=>
    projectFoldersApi.upsertDraft(projectId,folderId,data,key),
  discardDraft:async(projectId:string,folderId:string,draftId:string,draftVersion:number,key:string=crypto.randomUUID()):Promise<{discarded:true}>=>{
    const spaceId=_spaceId;
    try{const result=await callOperation('project.folder.draft.discard',{project_id:projectId,folder_id:folderId,draft_id:draftId,draft_version:draftVersion},key,{spaceId});if(!('status' in result)||result.status!=='succeeded')throw new Error('Draft discard did not complete');return {discarded:true};}
    catch(error){await hydrateDraftConflict(error,projectId,folderId,spaceId);throw error;}
  },
  closeFailedDraftSave:async(projectId:string,folderId:string,intentId:string,spaceId:string):Promise<void>=>{
    const result=await callOperation('project.folder.draft.close_save',{project_id:projectId,folder_id:folderId,intent_id:intentId},crypto.randomUUID(),{spaceId});
    if(!('status' in result)||result.status!=='succeeded')throw new Error('Closing the failed save did not complete');
  },
  saveDraft:async(projectId:string,folderId:string,draftId:string,draftVersion:number,confirmMixedLineEndingNormalization=false,key:string=crypto.randomUUID(),options:{spaceId?:string;retryIntentId?:string}={}):Promise<ProjectFileDraftSave>=>{
    const epoch = sessionEpoch()
    const receipt=await commandReceipt('project.folder.draft.save',{
      project_id:projectId,folder_id:folderId,draft_id:draftId,draft_version:draftVersion,
      confirm_mixed_line_ending_normalization:confirmMixedLineEndingNormalization,
      ...(options.retryIntentId?{retry_intent_id:options.retryIntentId}:{}),
    },key,{spaceId:options.spaceId});
    const status=await waitForFolderIo(receipt, epoch);
    if(status.result?.kind!=='save_draft')throw new Error('File save receipt is unavailable');
    const result=status.result,path=encodeURIComponent(result.path),location=encodeURIComponent(result.workspace_location_id),base=`/projects/${encodeURIComponent(receipt.project_id)}/folders/${encodeURIComponent(folderId)}`;
    const [file,currentDraft]=await Promise.all([get<FileContent>(`${base}/file?path=${path}&workspace_location_id=${location}`,{spaceId:receipt.space_id}),get<ProjectFileDraft|null>(`${base}/file/draft?path=${path}&workspace_location_id=${location}`,{spaceId:receipt.space_id})]);
    return {file,revision:result.revision,draft_deleted:result.draft_deleted,newer_draft_retained:currentDraft!==null,current_draft:currentDraft};
  },
  draftQuota: (projectId: string, folderId: string) =>
    get<ProjectFileDraftQuota>(`/projects/${projectId}/folders/${folderId}/drafts/quota`),
  fileRevisions: (projectId: string, folderId: string, path: string) =>
    get<ProjectFileRevision[]>(`/projects/${projectId}/folders/${folderId}/file/revisions?path=${encodeURIComponent(path)}`),
  restoreRevisionAsDraft:async(projectId:string,folderId:string,revisionId:string,key:string=crypto.randomUUID())=>{
    const epoch = sessionEpoch()
    const receipt=await noteObjectCall('project.folder.revision.restore',{project_id:projectId,folder_id:folderId,revision_id:revisionId},key),status=await waitForFolderIo(receipt, epoch);
    if(status.result?.kind!=='restore_revision')throw new Error('Revision restore receipt is unavailable');return readPrivateFolderDraft({id:status.result.draft_id,space_id:receipt.space_id,project_id:receipt.project_id,folder_id:folderId},status.result.version);
  },
  previewRevision: (projectId: string, folderId: string, revisionId: string) =>
    get<{ revision: ProjectFileRevision; content: string | null }>(`/projects/${projectId}/folders/${folderId}/file/revisions/${encodeURIComponent(revisionId)}/preview`),
  gitStatus: (projectId: string, folderId: string) =>
    get<GitStatus>(`/projects/${projectId}/folders/${folderId}/git/status`),
  gitDiff: (projectId: string, folderId: string, path?: string) =>
    get<{ diff: string; path: string | null; truncated: boolean; redacted: boolean }>(
      `/projects/${projectId}/folders/${folderId}/git/diff` + (path ? `?path=${encodeURIComponent(path)}` : ''),
    ),
}
