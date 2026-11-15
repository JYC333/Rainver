import {randomUUID} from 'node:crypto';
import {withQueryableTransaction,type Queryable} from '../routeUtils/common.js';
import type {ExecutionWorkspaceRow} from '../projectFolders/executionWorkspaces.js';

/** Canonical acknowledgement of the Host's journaled idle snapshot. A later
 * writer or cleanup owns its own version; never attribute that work to this
 * older capture. The original batch's provenance remains intact. */
export async function recordIdleWorkspaceCapture(db:Queryable,w:ExecutionWorkspaceRow,key:string,operationId:string,expected:string,captured:string,kind:'captured'|'observed'='captured'){
  return withQueryableTransaction(db,async tx=>{
   const current=(await tx.query<ExecutionWorkspaceRow&{cleanup_json:Record<string,{operation_id:string}>}>('SELECT * FROM execution_workspaces WHERE id=$1 FOR UPDATE',[w.id])).rows[0];
   if(!current||current.generation!==w.generation||current.cleanup_json?.[key]?.operation_id!==operationId)return false;
   if(captured===expected)return false;
   if(current.head_commit===captured)return (current as ExecutionWorkspaceRow&{retention_json?:{idle_capture_operation?:string}}).retention_json?.idle_capture_operation===operationId;
   if(current.head_commit!==expected)return false;
   if((await tx.query("SELECT 1 FROM execution_workspace_runs b JOIN runs r ON r.id=b.run_id WHERE b.workspace_id=$1 AND (b.checkpoint_state<>'saved' OR r.status IN ('queued','running','cancelling','waiting_for_dependency','waiting_for_review')) LIMIT 1",[w.id])).rowCount)return false;
   const previous=(await tx.query<{originating_run_id:string;root_run_id:string;sequence:number}>('SELECT originating_run_id,root_run_id,sequence FROM workspace_change_sets WHERE workspace_id=$1 ORDER BY sequence DESC LIMIT 1',[w.id])).rows[0];
   if(!previous)return false;
   const open=(await tx.query<{id:string;generation:number;source_commit:string}>("SELECT id,generation,source_commit FROM workspace_change_sets WHERE workspace_id=$1 AND state='open' FOR UPDATE",[w.id])).rows[0];
   if(open&&(open.generation!==w.generation||open.source_commit!==expected))return false;
   if(open)await tx.query(`UPDATE workspace_change_sets SET source_commit=$2,revision=revision+1,verification_json=verification_json||$3::jsonb,updated_at=now() WHERE id=$1`,[open.id,captured,JSON.stringify({idle_capture:{previous_commit:expected,operation_id:operationId,kind}})]);
   else await tx.query(`INSERT INTO workspace_change_sets(id,workspace_id,space_id,generation,sequence,originating_run_id,root_run_id,state,base_commit,source_commit,verification_json)
    VALUES($1,$2,$3,$4,$5,$6,$7,'open',$8,$9,$10::jsonb)`,[randomUUID(),w.id,w.space_id,w.generation,previous.sequence+1,previous.originating_run_id,previous.root_run_id,expected,captured,JSON.stringify({idle_capture:{previous_commit:expected,operation_id:operationId,kind},adopted_child_change_ids:[]})]);
   await tx.query(`UPDATE execution_workspaces SET head_commit=$2,revision=revision+1,retention_json=retention_json||jsonb_build_object('content_changed_at',now(),'idle_capture_operation',$3::text),updated_at=now() WHERE id=$1`,[w.id,captured,operationId]);
   return true;
  });
}
