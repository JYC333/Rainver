import type {Queryable} from '../routeUtils/common.js';
import {HttpError} from '../routeUtils/common.js';
import type {ProjectFileDraftRow} from './draftRepository.js';
import type {ProjectFolderRow} from './repository.js';
import type {ProjectFileRevisionOut} from './fileRevisionStore.js';
import type {ActiveLocationWithHost} from './workspaceLocations.js';
import {terminalFolderIoProjection} from './ioTerminalProjection.js';
export const PROJECT_FOLDER_IO_JOB='project_folder_io';
export type FolderIoKind='create'|'scan'|'save_draft'|'restore_revision';
export interface FrozenFileRevision extends ProjectFileRevisionOut{before_content:string|null}
export interface FolderIoFrozen{
  input:Record<string,unknown>;
  folder?:ProjectFolderRow;
  location?:ActiveLocationWithHost;
  location_id?:string;
  draft?:ProjectFileDraftRow;
  revision?:FrozenFileRevision;
  existingDraft?:{id:string;version:number}|null;
}
export interface FolderIoIntent{
  id:string;space_id:string;project_id:string;user_id:string;folder_id:string|null;kind:FolderIoKind;
  scope_key:string;status:'pending'|'prepared'|'applied'|'succeeded'|'failed'|'needs_attention';job_id:string;
  frozen_json:FolderIoFrozen;effect_json:Record<string,unknown>;result_json:Record<string,unknown>|null;error_code:string|null;
}
export async function loadFolderIoIntent(db:Queryable,id:string,space:string,lock=false):Promise<FolderIoIntent>{
  const row=(await db.query<FolderIoIntent>('SELECT * FROM project_folder_io_intents WHERE id=$1 AND space_id=$2'+(lock?' FOR UPDATE':''),[id,space])).rows[0];
  if(!row)throw new HttpError(404,'Folder request not found');return row;
}
export class FolderIoRefusal extends Error{
  constructor(readonly code:string,readonly metadata:Record<string,unknown>={}){super(code);}
}

/** The caller holds the Project and Folder authority locks. Acknowledging the
 * terminal request only releases its scope fence and clears frozen file bytes. */
export async function closeFailedFolderSave(db:Queryable,input:{id:string;space:string;project:string;folder:string;user:string}):Promise<void>{
  const intent=(await db.query<FolderIoIntent>(`SELECT * FROM project_folder_io_intents
    WHERE id=$1 AND space_id=$2 AND project_id=$3 AND folder_id=$4 AND user_id=$5 AND kind='save_draft' FOR UPDATE`,
    [input.id,input.space,input.project,input.folder,input.user])).rows[0];
  if(!intent)throw new FolderIoRefusal('operation_not_found');
  if(intent.status==='failed'&&intent.error_code==='folder_save_closed')return;
  const idle=(await db.query<{held:boolean}>(`SELECT pg_try_advisory_xact_lock(hashtextextended($1,0)) AS held`,[`code-patch-folder:${input.folder}`])).rows[0]?.held;
  const unresolved=intent.status==='needs_attention'
    || (['pending','prepared','applied'].includes(intent.status) && (intent.effect_json.write_started===true||intent.effect_json.applied===true));
  if(!idle||!unresolved)throw new FolderIoRefusal('folder_io_busy');
  const finished=(await db.query(`SELECT 1 FROM jobs WHERE id=$1 AND space_id=$2 AND user_id=$3
    AND job_type=$4 AND payload_json->>'intent_id'=$5 AND status IN ('failed','cancelled','completed')`,
    [intent.job_id,input.space,input.user,PROJECT_FOLDER_IO_JOB,intent.id])).rows[0];
  if(!finished)throw new FolderIoRefusal('folder_io_busy');
  const terminal=terminalFolderIoProjection(intent,intent.effect_json);
  await db.query(`UPDATE project_folder_io_intents SET status='failed',error_code='folder_save_closed',
    frozen_json=$2::jsonb,effect_json=$3::jsonb,updated_at=now() WHERE id=$1`,[intent.id,JSON.stringify(terminal.frozen),JSON.stringify(terminal.effect)]);
}
