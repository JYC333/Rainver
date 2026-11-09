import {runOutputResult} from './orchestrationResults.js';
import {LaunchWorkspaceSchema} from '@rainver/protocol';
import {randomUUID} from 'node:crypto';
import {isolatedWorkspaceContract,workspaceReference,type ExecutionWorkspaceRow} from '../projectFolders/executionWorkspaces.js';
import {workspaceLocationFrame} from '../hosts/workspaceLocation.js';
import {sharedHostConnectionRegistry} from '../hosts/connectionRegistry.js';
import {workspaceRetentionSettings} from '../hosts/workspaceRetention.js';
import { RUN_OUTPUT_LINK_PREFIX, PREVIEW_MAX_BYTES, rasterImageMime, type RunFilePreview } from '@rainver/protocol';
import { isAbsolute, relative } from 'node:path';
import type { ServerConfig } from '../../config.js';
import { HttpError, type Queryable, type SpaceUserIdentity } from '../routeUtils/common.js';
import { PgRunRepository } from './repository.js';
import { bodyWithheld } from '../access/contentAccessTypes.js';
import { PgArtifactRepository } from '../artifacts/repository.js';
import { PgProjectFolderRepository } from '../projectFolders/repository.js';
import { resolveActiveLocationWithHost, locationAbsoluteRoot } from '../projectFolders/workspaceLocations.js';

/** Never interpret a model-written path as authority to read a host file. */
export async function readRunFilePreview(db: Queryable, config: ServerConfig, identity: SpaceUserIdentity, runId: string, source: string): Promise<RunFilePreview> {
  const run = await new PgRunRepository(db).getVisibleRun(identity.spaceId, identity.userId, runId);
  if (!run || bodyWithheld(run.effective_access_level)) throw new HttpError(404, 'Preview unavailable');
  try {
    if (source.startsWith('file:')) {
      const url = new URL(source);
      if (url.hostname && url.hostname !== 'localhost') throw new Error('remote file');
      source = url.pathname;
    }
    source = decodeURIComponent(source);
  } catch { throw new HttpError(422, 'Invalid file reference'); }
  if (!source || source.length > 4096 || /[\x00-\x1f\\]/.test(source)) throw new HttpError(422, 'Invalid file reference');
  const lineMatch = source.match(/(?::(\d+)|#L(\d+))$/);
  const path = lineMatch ? source.slice(0, -lineMatch[0].length) : source;
  const line = lineMatch ? Number(lineMatch[1] ?? lineMatch[2]) : undefined;
  if (line !== undefined && (!Number.isSafeInteger(line) || line < 1)) throw new HttpError(422, 'Invalid line');
  if (path.startsWith(RUN_OUTPUT_LINK_PREFIX)) {
    const name = path.slice(RUN_OUTPUT_LINK_PREFIX.length);
    if (!name || name.split('/').some(part => !part || part === '.' || part === '..')) throw new HttpError(422, 'Invalid output name');
    const rows = await db.query<{ id: string }>(
      `SELECT id FROM artifacts WHERE space_id = $1 AND run_id = $2 AND artifact_type = 'remote_output'
         AND metadata_json->>'source_filename' = $3 ORDER BY created_at DESC, id DESC LIMIT 1`,
      [identity.spaceId, runId, name],
    );
    const artifact = rows.rows[0] ? await new PgArtifactRepository(db, config).getVisible(identity.spaceId, identity.userId, rows.rows[0].id, true) : null;
    if (!artifact || artifact.content === null) throw new HttpError(404, 'Preview unavailable or expired');
    if (artifact.metadata_json?.encoding === 'base64') {
      const bytes = Buffer.from(artifact.content, 'base64');
      const mime = rasterImageMime(bytes);
      if (!mime || bytes.length > PREVIEW_MAX_BYTES || bytes.toString('base64') !== artifact.content) throw new HttpError(415, 'Unsupported image');
      return { kind: 'image', name, mime_type: mime, content_base64: artifact.content };
    }
    if (Buffer.byteLength(artifact.content) > PREVIEW_MAX_BYTES) throw new HttpError(413, 'Preview too large');
    return { kind: 'text', name, content: artifact.content };
  }
  if(isolatedWorkspaceContract(run.contract_snapshot_json)){
    const frozen=LaunchWorkspaceSchema.safeParse(runOutputResult(run.output_json).execution_workspace_location);
    const primary=frozen.success&&frozen.data.kind==='location'&&frozen.data.execution_workspace?frozen.data:null;
    if(!isAbsolute(path)&&!primary)throw new HttpError(404,'Captured primary workspace is unavailable');
    const rows=(await db.query<ExecutionWorkspaceRow & {checkpoint_commit:string|null;checkpoint_state:string;host_kind:string;host_owner:string|null;retention_json:Record<string,unknown>|null}>(`SELECT w.*,b.checkpoint_commit,b.checkpoint_state,h.kind AS host_kind,h.owner_user_id AS host_owner
      FROM execution_workspace_runs b JOIN execution_workspaces w ON w.id=b.workspace_id JOIN hosts h ON h.id=w.execution_host_id
      WHERE b.run_id=$1 AND b.space_id=$2 ORDER BY w.created_at`,[runId,identity.spaceId])).rows;
    let pending=false,failed=false,expired:RunFilePreview|null=null;
    for(const w of rows){
      if(w.project_id!==run.project_id||w.host_kind==='remote'&&w.host_owner!==identity.userId)continue;
      if(!isAbsolute(path)&&(!primary||w.workspace_location_id!==primary.workspace_location_id||w.id!==primary.execution_workspace!.id||w.generation!==primary.execution_workspace!.generation))continue;
      if(w.checkpoint_state!=='saved'||!w.checkpoint_commit){pending=true;continue;}
      const response=await sharedHostConnectionRegistry.requestTaskBranch(w.execution_host_id,'execution_workspace_command',{
        workspace:await workspaceLocationFrame(db,w,workspaceReference(w),config.workspaceRoot),action:'read',path:!isAbsolute(path)&&primary?.execution_workspace?.cwd_subpath?`${primary.execution_workspace.cwd_subpath}/${path}`:path,
        expected_commit:w.checkpoint_commit,operation_id:randomUUID(),retain_branch:true});
      if(!response.ok||!response.file){
        // After a proven branch release the exact Run version is read through
        // its run-history ref until the history retention ends. Only the Host's
        // answer that this exact version is gone, after an explicit retention
        // end, means expired. A missing path in a present version, a refused
        // read, or a temporary/offline Host never counts as expiry.
        // A Host that could not read its object store (permissions, corruption)
        // answered nothing about the version: that is never expiry, here or for another row.
        if(response.error==='workspace_file_read_failed')failed=true;
        if(response.error==='workspace_file_version_unavailable'){
          const until=historyRetentionEnd(w.retention_json??{});
          if(until&&Date.parse(until)<=Date.now())expired={kind:'expired',name:path,expired_at:until};
        }
        continue;
      }
      const bytes=Buffer.from(response.file.content_base64,'base64');
      if(bytes.length>PREVIEW_MAX_BYTES||bytes.toString('base64')!==response.file.content_base64)throw new HttpError(413,'Preview too large');
      const mime=rasterImageMime(bytes);
      if(mime)return {kind:'image',name:response.file.path,mime_type:mime,content_base64:response.file.content_base64};
      if(bytes.includes(0))throw new HttpError(415,'Unsupported file encoding');
      try{return {kind:'text',name:response.file.path,content:new TextDecoder('utf-8',{fatal:true}).decode(bytes)};}
      catch{throw new HttpError(415,'Unsupported file encoding');}
    }
    if(failed&&!pending)throw new HttpError(503,'The workspace version could not be read on its Host');
    if(expired&&!pending)return expired;
    throw new HttpError(pending?409:404,pending?'Workspace checkpoint is pending':'Captured workspace file is unavailable');
  }
  // A legacy absolute path may only locate this Run's registered primary
  // Folder, on its original Location. /tmp and unrelated host paths never read.
  if (!run.project_folder_id || !run.project_id || !run.workspace_location_id) throw new HttpError(404, 'File is not in this Run’s workspace');
  const location = await resolveActiveLocationWithHost(db, identity.spaceId, run.project_folder_id);
  if (location.id !== run.workspace_location_id) throw new HttpError(409, 'The workspace moved; open Files & Code to select its current Location');
  const root = location.execution_host_kind === 'remote' ? location.display_path : locationAbsoluteRoot(location, config.workspaceRoot);
  if (!root) throw new HttpError(404, 'Workspace path unavailable');
  const rel = isAbsolute(path) ? relative(root, path) : path.replace(/^\.\//, '');
  if (!rel || rel === '..' || rel.startsWith('../') || isAbsolute(rel)) throw new HttpError(404, 'File is outside this Run’s workspace');
  const folders = new PgProjectFolderRepository(db, config);
  // Same policy, ACL, Host and no-symlink read as Files & Code, not a new reader.
  const image = /\.(?:png|jpe?g|gif|webp)$/i.test(rel);
  const file = await folders.getFile(identity, run.project_id, run.project_folder_id, rel, { workspaceLocationId: run.workspace_location_id, ...(image ? { includeOriginalBytes: true } : {}) });
  if (image) {
    const bytes = file.content_base64 ? Buffer.from(file.content_base64, 'base64') : null;
    const mime = bytes && rasterImageMime(bytes);
    if (!bytes || !mime || bytes.length > PREVIEW_MAX_BYTES) throw new HttpError(415, 'Image preview unavailable');
    return { kind: 'image', name: rel, mime_type: mime, content_base64: bytes.toString('base64') };
  }
  return { kind: 'workspace', project_id: run.project_id, folder_id: run.project_folder_id, path: rel, ...(line ? { line } : {}) };
}

/**
 * When a released generation's exact Run versions stop being kept: the recorded
 * history end, or (no history ref was needed: every version was target history)
 * the release time plus the history retention. Never released: no end.
 */
export function historyRetentionEnd(retention:Record<string,unknown>):string|null{
  if(typeof retention.history_until==='string')return retention.history_until;
  const released=typeof retention.reclaimed_at==='string'?Date.parse(retention.reclaimed_at):NaN;
  return Number.isFinite(released)?new Date(released+workspaceRetentionSettings.runHistoryRetentionMs).toISOString():null;
}
