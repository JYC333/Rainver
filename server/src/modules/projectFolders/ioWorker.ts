import {realpath} from 'node:fs/promises';
import {z} from 'zod';
import {FolderWriteError,type FileContent} from '@rainver/folder-read';
import type {ServerConfig} from '../../config.js';
import {getDbPool} from '../../db/pool.js';
import {tryWithDedicatedSessionAdvisoryLock} from '../../db/advisoryLock.js';
import {withQueryableTransaction,type Queryable} from '../routeUtils/common.js';
import {withPolicyAuditRecovery} from '../policy/auditWriter.js';
import {enforce} from '../policy/service.js';
import {loadActionRegistry} from '../policy/actionRegistry.js';
import {JobDeferredError,type JobHandlerRegistry,type JobEnvelopeForHandler} from '../jobs/handlerRegistry.js';
import {OperationError} from '../systemActions/operations/errors.js';
import {PgProjectFolderRepository,revisionText} from './repository.js';
import {locationAbsoluteRoot,resolveLocationWithHost} from './workspaceLocations.js';
import {authorizeFolderIoWorker} from './ioAdmission.js';
import {loadFolderIoIntent,FolderIoRefusal,type FolderIoIntent} from './ioIntentRepository.js';
import {prepareFolderImport,applyFolderImport,commitFolderImport,savedDraftBytes,assertSaveBaseline,writeFrozenDraft,commitSavedDraft,commitRestoredDraft,type FolderImportPlan} from './ioDomain.js';
import {PROJECT_FOLDER_IO_JOB} from './ioOperations.js';
import {ProjectFolderFileRefusal} from './operationErrors.js';
import {terminalFolderIoProjection} from './ioTerminalProjection.js';
type CurrentFile={exists:boolean;file:FileContent|null};
interface Effect{
  import?:FolderImportPlan;before?:CurrentFile;observed?:CurrentFile;desired?:{content:string;sha256:string};
  canonical_root?:string;write_started?:boolean;applied?:boolean;terminal_refusal?:boolean;compensated?:boolean;
  refusal_code?:string;error_metadata?:Record<string,unknown>;
}
const payload=z.object({intent_id:z.string().min(1).max(36)}).strict();
class FolderIoLeaseLost extends Error{}

export function registerProjectFolderIoHandler(registry:JobHandlerRegistry,config:ServerConfig):void{
  registry.register(PROJECT_FOLDER_IO_JOB,async job=>{
    try{
      const {intent_id}=payload.parse(job.payload);
      return await executeProjectFolderIo(config,intent_id,job);
    }catch(error){
      if(error instanceof JobDeferredError)throw error;
      // Queue errors/events are user-readable. Paths, credentials, bodies and
      // database exception details remain outside that transport.
      throw new Error('Folder IO attempt did not complete; inspect its private request status');
    }
  });
}
export async function executeProjectFolderIo(config:ServerConfig,id:string,job:JobEnvelopeForHandler):Promise<Record<string,unknown>>{
  if(!config.databaseUrl)throw new Error('Folder IO requires a database');
  const pool=getDbPool(config.databaseUrl),locked=await tryWithDedicatedSessionAdvisoryLock(pool,`folder-io-intent:${id}`,async()=>{
    let intent=await loadFolderIoIntent(pool,id,job.space_id);
    if(intent.job_id!==job.job_id||intent.user_id!==job.user_id)throw new FolderIoLeaseLost('Folder request does not own this Job');
    if(intent.status==='succeeded')return{intent_id:id,status:'succeeded'};
    if(intent.status==='failed')return{intent_id:id,status:'failed'};
    const gate=await tryWithDedicatedSessionAdvisoryLock(pool,`code-patch-folder:${intent.folder_id??intent.id}`,async()=>{
      const effect=intent.effect_json as Effect,repo=new PgProjectFolderRepository(pool,config),frozen=intent.frozen_json;
      const identity={spaceId:intent.space_id,userId:intent.user_id};
      const assertLease=async(db:Queryable=pool,lock=false)=>{
        if(!(await db.query("SELECT id FROM jobs WHERE id=$1 AND space_id=$2 AND user_id=$3 AND claimed_by=$4 AND status='running'"+(lock?' FOR SHARE':''),[job.job_id,job.space_id,job.user_id,job.worker_id])).rows.length)throw new FolderIoLeaseLost('Folder Job no longer owns execution');
      };
      const save=async(status:FolderIoIntent['status']=intent.status)=>{
        const result=await pool.query("UPDATE project_folder_io_intents i SET effect_json=$3::jsonb,status=$4,updated_at=now() WHERE i.id=$1 AND i.space_id=$2 AND i.job_id=$5 AND EXISTS(SELECT 1 FROM jobs j WHERE j.id=$5 AND j.claimed_by=$6 AND j.status='running')",[id,intent.space_id,JSON.stringify(effect),status,job.job_id,job.worker_id]);
        if(!result.rowCount)throw new FolderIoLeaseLost('Folder progress no longer owns its Job');intent.status=status;
      };
      const owner=async<T>(phase:'prepare'|'commit',work:(db:Queryable)=>Promise<T>)=>withPolicyAuditRecovery(config.databaseUrl,()=>withQueryableTransaction(pool,async db=>{
        await assertLease(db,true);
        intent=await loadFolderIoIntent(db,id,job.space_id);
        // Match admission: Project/Folder/source closure precedes the intent row.
        await authorizeFolderIoWorker(db,config,intent,phase);
        intent=await loadFolderIoIntent(db,id,job.space_id,true);
        return work(db);
      }));
      const terminal=async(code:string,needsAttention:boolean,metadata:Record<string,unknown>={})=>{
        effect.error_metadata=metadata;effect.refusal_code=code;
        await withPolicyAuditRecovery(config.databaseUrl,()=>withQueryableTransaction(pool,async db=>{
          await assertLease(db,true);
          const audit=await enforce({...config,auditTransaction:db},await loadActionRegistry(),{action:intent.kind==='save_draft'?'project_folder.apply_patch':'project.folder.command',actor_type:'user',actor_id:intent.user_id,space_id:intent.space_id,resource_type:intent.kind==='save_draft'?'project_folder':'project',resource_id:intent.kind==='save_draft'?intent.folder_id!:intent.project_id,resource_space_id:intent.space_id,context:{trigger_origin:'manual',direct_user_write:true,file_operation:'write'},metadata_json:{folder_io_intent_id:id,folder_io_phase:'failed',folder_io_error:code},force_record:true});
          if(audit.status==='error')throw new FolderIoRefusal('operation_audit_unavailable');
          const terminal=needsAttention?{frozen:intent.frozen_json,effect}:terminalFolderIoProjection(intent,effect as Record<string,unknown>);
          await db.query("UPDATE project_folder_io_intents SET status=$3,error_code=$4,effect_json=$5::jsonb,frozen_json=$6::jsonb,updated_at=now() WHERE id=$1 AND space_id=$2",[id,intent.space_id,needsAttention?'needs_attention':'failed',code,JSON.stringify(terminal.effect),JSON.stringify(terminal.frozen)]);
        }));
        return{intent_id:id,status:needsAttention?'needs_attention':'failed'};
      };
      const compensate=async()=>{
        if(effect.compensated||!effect.applied)return;
        const location=await resolveLocationWithHost(pool,intent.space_id,intent.folder_id!,frozen.location!.id);
        const folder=(await pool.query<{protected:boolean}>('SELECT protected FROM project_folders WHERE id=$1 AND space_id=$2 AND project_id=$3',[intent.folder_id,intent.space_id,intent.project_id])).rows[0];
        if(!folder||folder.protected!==frozen.folder!.protected||location.root_path!==frozen.location!.root_path||location.execution_host_id!==frozen.location!.execution_host_id||location.execution_host_kind==='remote'&&location.host_owner_user_id!==intent.user_id)throw new FolderIoRefusal('folder_file_needs_attention');
        if(location.execution_host_kind==='server'&&await realpath(locationAbsoluteRoot(location,config.workspaceRoot)).catch(()=>null)!==effect.canonical_root)throw new FolderIoRefusal('folder_file_needs_attention');
        const beforeFile=effect.before!.file;
        await repo.restorePhysicalFile(frozen.folder!,intent.user_id,location,frozen.draft!.relative_path,beforeFile?revisionText(beforeFile):null,true,effect.desired!.sha256,beforeFile?.encoding==='utf16le'||beforeFile?.encoding==='utf16be'?beforeFile.encoding:'utf8');
        effect.compensated=true;await save('prepared');
      };
      try{
        if(effect.terminal_refusal){
          try{await compensate();}catch(error){if(error instanceof JobDeferredError)throw error;return terminal(effect.refusal_code??'folder_file_needs_attention',true,effect.error_metadata);}
          return terminal(effect.refusal_code??'operation_conflict',false,effect.error_metadata);
        }
        await owner('prepare',async()=>{});
        await assertLease();
        const location=frozen.location?await resolveLocationWithHost(pool,intent.space_id,intent.folder_id!,frozen.location.id):null;
        if(location&&(location.root_path!==frozen.location!.root_path||location.execution_host_id!==frozen.location!.execution_host_id))throw new FolderIoRefusal('operation_conflict');
        if(intent.kind==='create'){
          if(!effect.import){effect.import=await prepareFolderImport(pool,config,intent);await save('prepared');}
          await applyFolderImport(config,intent,effect.import,()=>save('prepared'),()=>assertLease());
        }else if(intent.kind==='save_draft'){
          if(frozen.location!.execution_host_kind==='server'){
            const root=await realpath(locationAbsoluteRoot(frozen.location!,config.workspaceRoot)).catch(()=>null);
            if(!root||effect.canonical_root&&effect.canonical_root!==root)throw new FolderIoRefusal('folder_file_needs_attention');
            effect.canonical_root=root;
          }
          if(!effect.before){
            const before=await repo.readCurrentFileForDraft(frozen.folder!,intent.user_id,location!,frozen.draft!.relative_path);
            assertSaveBaseline(intent,before);effect.before=before;effect.desired=savedDraftBytes(frozen.draft!);await save('prepared');
          }
          if(!effect.applied){
            const current=await repo.readCurrentFileForDraft(frozen.folder!,intent.user_id,location!,frozen.draft!.relative_path);
            if(current.exists&&current.file?.sha256===effect.desired!.sha256){effect.applied=true;await save('applied');}
            else if(current.exists===effect.before.exists&&current.file?.sha256===effect.before.file?.sha256){
              effect.write_started=true;await save('prepared');await assertLease();
              await writeFrozenDraft(config,frozen.folder!,location!,frozen.draft!.relative_path,effect.desired!,effect.before);
              effect.applied=true;await save('applied');
            }else throw new FolderIoRefusal(effect.write_started?'folder_file_needs_attention':'host_file_conflict');
          }
        }else if(intent.kind==='restore_revision'){
          effect.observed=await repo.readCurrentFileForDraft(frozen.folder!,intent.user_id,location!,frozen.revision!.path);await save('prepared');
        }
        const scan=intent.kind==='scan'?await repo.scanCandidates(identity,intent.project_id):null;
        // Every effect has finished before the final transaction begins.
        await owner('commit',async db=>{
          const result=intent.kind==='create'?await commitFolderImport(db,intent,effect.import!):intent.kind==='save_draft'?await commitSavedDraft(db,intent,effect.before!,effect.desired!.sha256):intent.kind==='restore_revision'?await commitRestoredDraft(db,intent,effect.observed!):{kind:'scan',items:scan!};
          const terminal=terminalFolderIoProjection(intent,effect as Record<string,unknown>);
          await db.query("UPDATE project_folder_io_intents SET status='succeeded',result_json=$3::jsonb,effect_json=$4::jsonb,frozen_json=$5::jsonb,error_code=NULL,updated_at=now() WHERE id=$1 AND space_id=$2",[id,intent.space_id,JSON.stringify(result),JSON.stringify(terminal.effect),JSON.stringify(terminal.frozen)]);
        });
        return{intent_id:id,status:'succeeded'};
      }catch(error){
        if(error instanceof JobDeferredError)throw error;
        if(error instanceof ProjectFolderFileRefusal&&['host_offline','host_timeout'].includes(error.safeCode))throw new JobDeferredError('Folder read is waiting for its Host',30000);
        if(error instanceof FolderIoLeaseLost){
          const attention=Boolean(effect.write_started||effect.import?.directoryStarted),projection=attention?{frozen,effect}:terminalFolderIoProjection(intent,effect as Record<string,unknown>);
          await pool.query("UPDATE project_folder_io_intents SET status=$3,error_code='folder_job_cancelled',effect_json=$4::jsonb,frozen_json=$6::jsonb,updated_at=now() WHERE id=$1 AND space_id=$2 AND status<>'succeeded' AND job_id=$5 AND EXISTS(SELECT 1 FROM jobs WHERE id=$5 AND status='cancelled')",[id,intent.space_id,attention?'needs_attention':'failed',JSON.stringify(projection.effect),job.job_id,JSON.stringify(projection.frozen)]);
          throw error;
        }
        if(error instanceof FolderIoRefusal&&error.code==='folder_write_unconfirmed')throw new JobDeferredError('Folder write acknowledgement is pending; inspect the same frozen effect on redelivery',30000);
        if(error instanceof FolderIoRefusal&&error.code==='operation_audit_unavailable'||error instanceof ProjectFolderFileRefusal&&error.safeCode==='operation_audit_unavailable')throw error;
        const known=error instanceof FolderIoRefusal||error instanceof OperationError||error instanceof ProjectFolderFileRefusal||error instanceof FolderWriteError&&error.code!=='write_failed';
        if(!known){
          if(job.attempts>=job.max_attempts)await terminal('operation_internal_error',Boolean(effect.write_started||effect.import?.directoryStarted));
          throw error;
        }
        const code=error instanceof FolderIoRefusal?error.code:error instanceof OperationError?error.code:error instanceof ProjectFolderFileRefusal?error.safeCode:(error as FolderWriteError).code;
        if(effect.applied){
          effect.terminal_refusal=true;effect.refusal_code=code;await save('applied');
          try{await compensate();}catch{return terminal(code,true);}
        }
        return terminal(code,code.includes('needs_attention')||Boolean(effect.write_started&&!effect.compensated||effect.import?.directoryStarted),error instanceof FolderIoRefusal?error.metadata:{});
      }
    });
    if(!gate.acquired)throw new JobDeferredError('Folder effect is busy',1000);return gate.value;
  });
  if(!locked.acquired)throw new JobDeferredError('Folder request is already running',1000);return locked.value;
}
