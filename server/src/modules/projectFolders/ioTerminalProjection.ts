import type {FolderIoIntent} from './ioIntentRepository.js';
/** Terminal command history needs identity/hash receipts, never a second body store. */
export function terminalFolderIoProjection(intent:FolderIoIntent,effect:Record<string,unknown>){
  const source=intent.frozen_json,input=source.input;
  const before=effect.before as{exists?:boolean;file?:{sha256?:string}}|undefined;
  const desired=effect.desired as{sha256?:string}|undefined;
  return{
    frozen:{input:{project_id:intent.project_id,...(intent.folder_id?{folder_id:intent.folder_id}:{}),...(input.draft_id?{draft_id:input.draft_id,draft_version:input.draft_version}:{}),...(input.revision_id?{revision_id:input.revision_id}:{})},
      ...(source.location?{location:{id:source.location.id,execution_host_id:source.location.execution_host_id,execution_host_kind:source.location.execution_host_kind}}:{}),
      ...(source.draft?{draft:{id:source.draft.id,version:source.draft.version,content_sha256:source.draft.content_sha256}}:{}),
      ...(source.revision?{revision:{id:source.revision.id}}:{}),
    },
    effect:{...(before?{before_exists:before.exists,before_sha256:before.file?.sha256??null}:{}),...(desired?{after_sha256:desired.sha256}:{}),
      applied:effect.applied===true,compensated:effect.compensated===true,error_metadata:effect.error_metadata??{},
    },
  };
}
