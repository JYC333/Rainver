import {assertProjectWriterForMutation} from '../projects/access.js';
import {PgRunRepository} from '../runs/repository.js';
import {bodyWithheld} from '../access/contentAccessTypes.js';
import {isWireRelativePath,looksSecretLikePath} from '@rainver/folder-read';
import {withQueryableTransaction,type Queryable} from '../routeUtils/common.js';
import type {ExecutionWorkspaceRow} from './executionWorkspaces.js';
import type {RunRecord} from '../runs/repository.js';
import {workspaceLocationFrame} from '../hosts/workspaceLocation.js';
import type {HostConnectionRegistry} from '../hosts/connectionRegistry.js';
import {JobDeferredError} from '../jobs/handlerRegistry.js';
import {workspaceHostFailureIsTemporary} from './workspacePolicy.js';

/** Intake an explicit single commit without importing a private branch's history.
 * Host reads happen before the short canonical freeze transaction. The normal
 * integration worker still owns candidate construction, verification and CAS. */
export async function freezeSubmittedWorkspaceCommit(db:Queryable,w:ExecutionWorkspaceRow,c:{id:string;base_commit:string|null;source_commit:string|null;verification_json:Record<string,unknown>},run:RunRecord,userId:string,hosts:HostConnectionRegistry,workspaceRoot?:string,beforeReplyRunId?:string){
 const submission=c.verification_json.submitted_commit as {source_commit?:string;user_id?:string;applied?:boolean;base_commit?:string}|undefined;
 if(!submission)return null;
 await assertProjectWriterForMutation(db,w.space_id,w.project_id,userId);
 const visible=await new PgRunRepository(db).getVisibleRun(w.space_id,userId,run.id);
 if(!visible||bodyWithheld(visible.effective_access_level))throw new Error('workspace_commit_scope_denied');
 if(submission.user_id!==userId||!submission.source_commit||!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(submission.source_commit))throw new Error('workspace_commit_invalid');
 if(submission.applied){
  if(c.source_commit!==submission.source_commit||c.base_commit!==submission.base_commit)throw new Error('workspace_commit_basis_changed');
  return {base_commit:c.base_commit!,source_commit:c.source_commit!};
 }
 if(!c.base_commit||c.base_commit!==c.source_commit)throw new Error('workspace_commit_requires_empty_change');
 if(w.parent_workspace_id||!w.target_ref)throw new Error('workspace_commit_requires_root_target');
 const {execution_workspace:_,...source}=await workspaceLocationFrame(db,w,{id:w.id,generation:w.generation},workspaceRoot,userId);
 async function attempt(argv:string[]){
  const result=await hosts.runHostCommand(w.execution_host_id,{run_id:run.id,workspace:source,command:['git',...argv],timeout_seconds:30});
  if(!result.ok&&workspaceHostFailureIsTemporary(result.error))throw new JobDeferredError(result.error!,30000);
  return result.ok&&result.exit_code===0&&!result.timed_out?result.stdout:null;
 }
 async function git(argv:string[]){
  const out=await attempt(argv);
  if(out===null)throw new Error('workspace_commit_unavailable');
  return out;
 }
 const parents=(await git(['rev-list','--parents','-n','1',submission.source_commit])).trim().split(/\s+/);
 if(parents.length!==2||parents[0]!==submission.source_commit)throw new Error('workspace_commit_requires_single_parent');
 const base=parents[1]!;
 // The parent must be published history, never a private dirty baseline.
 await git(['merge-base','--is-ancestor',base,w.target_ref]);
 const paths=(await git(['diff','--name-only','--no-ext-diff','--no-textconv','--no-renames','-z',base,submission.source_commit,'--'])).split('\0').filter(Boolean);
 if(paths.length>500||paths.some(p=>!isWireRelativePath(p)||p.length>4096||p.split('/').some(s=>s==='..'||s==='.git')||looksSecretLikePath(p)))throw new Error('workspace_commit_scope_denied');
 // The submission was registered as this batch's dependent before this job
 // ran, so no shared-source release can delete this ref from here on (see
 // hosts/workspaceSourceFence). Pin the exact object and prove it before the
 // submission takes effect below; an object Git already pruned is refused.
 await pinRegisteredSource(attempt,submission.source_commit);
 await withQueryableTransaction(db,async tx=>{
  await assertProjectWriterForMutation(tx,w.space_id,w.project_id,userId);
  const host=(await tx.query<{kind:string;owner_user_id:string|null}>('SELECT kind,owner_user_id FROM hosts WHERE id=$1 FOR SHARE',[w.execution_host_id])).rows[0];
  if(!host||host.kind==='remote'&&host.owner_user_id!==userId)throw new Error('workspace_commit_scope_denied');
  await tx.query('SELECT id FROM execution_workspaces WHERE id=$1 AND space_id=$2 FOR UPDATE',[w.id,w.space_id]);
  const current=(await tx.query<{base_commit:string;source_commit:string;verification_json:Record<string,unknown>}>('SELECT base_commit,source_commit,verification_json FROM workspace_change_sets WHERE id=$1 AND space_id=$2 FOR UPDATE',[c.id,w.space_id])).rows[0];
  const applied=current?.verification_json.submitted_commit as typeof submission;
  if(applied?.applied&&applied.source_commit===submission.source_commit&&current?.base_commit===base&&current.source_commit===submission.source_commit)return;
  const changed=await tx.query(`UPDATE workspace_change_sets c SET base_commit=$3,source_commit=$4,revision=revision+1,
   verification_json=jsonb_set(verification_json,'{submitted_commit}',(verification_json->'submitted_commit')||$5::jsonb),updated_at=now()
   WHERE c.id=$1 AND c.space_id=$2 AND c.state='ready' AND c.base_commit=c.source_commit
    AND c.verification_json->'submitted_commit'->>'source_commit'=$4
    AND NOT EXISTS(SELECT 1 FROM execution_workspace_runs b JOIN runs r ON r.id=b.run_id AND r.space_id=b.space_id
     WHERE b.change_set_id=c.id AND (b.checkpoint_state<>'saved' OR (r.id IS DISTINCT FROM $6 AND r.status IN ('queued','running','cancelling','waiting_for_review','waiting_for_dependency'))))`,
   [c.id,w.space_id,base,submission.source_commit,JSON.stringify({applied:true,base_commit:base}),beforeReplyRunId??null]);
  if(!changed.rowCount)throw new Error('workspace_commit_basis_changed');
 });
 return {base_commit:base,source_commit:submission.source_commit};
}

/**
 * Pin a commit a durable dependent already registered (a submitted commit, a
 * native request's explicit commit) as `refs/rainver/sources/<c>` on the Host,
 * CAS on absence, and prove the exact object is there before it is used.
 * Registration passed the source-release fence, which admits it only when no
 * deletion of that ref is unended (claimed, unconfirmed or unsettled) on the
 * Host, so no earlier deletion can remove this pin afterwards; later releases
 * see the dependent and keep it. A pruned object is refused.
 */
export async function pinRegisteredSource(attempt:(argv:string[])=>Promise<string|null>,commit:string){
 const pin=`refs/rainver/sources/${commit}`;
 if(await attempt(['update-ref','-m','rainver: retain submitted workspace commit',pin,commit,''])!==null)return;
 const current=await attempt(['rev-parse','--verify','--quiet',`${pin}^{commit}`]);
 if(current?.trim()!==commit)throw new Error('workspace_commit_unavailable');
}

/** Host git runner for a workspace's Location (no worktree), as the submission freeze uses it. */
export async function hostLocationGit(db:Queryable,w:ExecutionWorkspaceRow,runId:string,hosts:HostConnectionRegistry,workspaceRoot?:string,userId?:string){
 const {execution_workspace:_,...source}=await workspaceLocationFrame(db,w,{id:w.id,generation:w.generation},workspaceRoot,userId);
 return async(argv:string[])=>{
  const result=await hosts.runHostCommand(w.execution_host_id,{run_id:runId,workspace:source,command:['git',...argv],timeout_seconds:30});
  if(!result.ok&&workspaceHostFailureIsTemporary(result.error))throw new JobDeferredError(result.error!,30000);
  return result.ok&&result.exit_code===0&&!result.timed_out?result.stdout:null;
 };
}
