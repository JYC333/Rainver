import type {Queryable} from '../routeUtils/common.js';
import {HttpError} from '../routeUtils/common.js';
import type {ProjectFileDraftRow} from './draftRepository.js';
import type {ProjectFolderRow} from './repository.js';
import type {ProjectFileRevisionOut} from './fileRevisionStore.js';
import type {ActiveLocationWithHost} from './workspaceLocations.js';
export type FolderIoKind='create'|'scan'|'save_draft'|'restore_revision';
export interface FrozenFileRevision extends ProjectFileRevisionOut{before_content:string|null}
export interface FolderIoFrozen{
  input:Record<string,unknown>;
  folder?:ProjectFolderRow;
  location?:ActiveLocationWithHost;
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
