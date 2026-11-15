import {adoptionPaths,findHistoricalAdoption,validCommit} from './workspaceAdoptionProof.js';
import {withQueryableTransaction,type Queryable} from '../routeUtils/common.js';
import {hostLocationGit} from '../projectFolders/workspaceCommitSubmission.js';
import type {ExecutionWorkspaceRow} from '../projectFolders/executionWorkspaces.js';
import {assertProjectWriterForMutation} from '../projects/access.js';
import type {HostConnectionRegistry} from './connectionRegistry.js';
import {recordNativeChildAdoption} from './workspaceNativeAdoption.js';

const ACTIVE="('queued','running','cancelling','waiting_for_dependency','waiting_for_review')";
/** Saved child adoption, through either a published parent version or a saved
 * parent checkpoint. The latter needs reclaim:6: cleanup pins that exact
 * checkpoint before it removes the child's branch. No publication is inferred.
 */
export async function reconcilePublishedWorkspaceChild(db:Queryable,w:ExecutionWorkspaceRow,userId:string,hosts:HostConnectionRegistry,workspaceRoot?:string){
 if(w.owner_kind!=='delegation'||!w.parent_workspace_id||w.state!=='ready')return false;
 // Controlled publication already proved the exact landing. Backfill that
 // receipt before considering the stricter external/manual Git fallback.
 const native=await withQueryableTransaction(db,async tx=>{
  await assertProjectWriterForMutation(tx,w.space_id,w.project_id,userId);
  await tx.query('SELECT id FROM execution_workspaces WHERE id=ANY($1::varchar[]) ORDER BY id FOR UPDATE',[[w.id,w.parent_workspace_id]]);
  return recordNativeChildAdoption(tx,w.id);
 });
 if(native)return true;
 const candidates=(await db.query<{id:string;revision:number;base_commit:string;source_commit:string;originating_run_id:string;parent_change:string;published:string;parent_generation:number;parent_target:string|null;checkpoint:boolean}>(`SELECT c.id,c.revision,c.base_commit,c.source_commit,c.originating_run_id,p.id AS parent_change,
  evidence.commit AS published,parent.generation AS parent_generation,evidence.target AS parent_target,evidence.checkpoint
  FROM workspace_change_sets c
  JOIN execution_workspaces parent ON parent.id=$2 AND parent.space_id=c.space_id
   AND parent.project_id=$3 AND parent.execution_host_id=$4 AND parent.workspace_location_id=$5
  JOIN workspace_change_sets p ON p.workspace_id=parent.id AND p.generation=parent.generation
  JOIN LATERAL (
   SELECT m.merged_commit AS commit,false AS checkpoint,m.completed_at AS at,m.target_ref AS target FROM task_merges m
    WHERE m.change_set_id=p.id AND m.space_id=c.space_id AND m.status='merged' AND p.state='integrated' AND parent.parent_workspace_id IS NULL
   UNION ALL
   SELECT b.checkpoint_commit,true,b.created_at,parent.target_ref FROM execution_workspace_runs b JOIN hosts h ON h.id=parent.execution_host_id
    WHERE b.change_set_id=p.id AND b.checkpoint_state='saved' AND p.state IN ('open','ready','integrated','no_changes')
     AND COALESCE((h.capabilities_json->'execution_workspaces'->>'reclaim')::int,0)>=6
     AND parent.state<>'blocked' AND COALESCE(parent.retention_json->>'state','') NOT IN ('reclaimed','reclaiming')
  ) evidence ON evidence.commit IS NOT NULL
  WHERE c.workspace_id=$1 AND (c.verification_json->>'slot_use_id') IS NOT DISTINCT FROM (SELECT retention_json->>'slot_use_id' FROM execution_workspaces WHERE id=$1) AND c.space_id=$6 AND c.generation=$8 AND (c.state='open' OR c.state IN ('integrated','no_changes') AND NOT (c.verification_json ? 'adoption_source') AND (c.state='integrated' OR c.source_commit=c.base_commit OR c.verification_json->>'adoption_proof'='published_parent_paths')) AND c.source_commit=$7
   AND COALESCE(c.verification_json->'native_progress'->>'status','')<>'pending'
   AND c.base_commit IS NOT NULL
   AND NOT EXISTS(SELECT 1 FROM execution_workspace_runs b JOIN runs r ON r.id=b.run_id AND r.space_id=b.space_id
    WHERE b.workspace_id=c.workspace_id AND (b.checkpoint_state<>'saved' OR r.status IN ${ACTIVE}))
   AND NOT EXISTS(SELECT 1 FROM workspace_change_sets other WHERE other.workspace_id=c.workspace_id AND other.state IN ('ready','integrating','blocked'))
  ORDER BY evidence.checkpoint,evidence.at DESC,c.sequence DESC LIMIT 50`,[w.id,w.parent_workspace_id,w.project_id,w.execution_host_id,w.workspace_location_id,w.space_id,w.head_commit,w.generation])).rows;
 if(!candidates.length)return false;
 const git=await hostLocationGit(db,w,candidates[0]!.originating_run_id,hosts,workspaceRoot,userId);
 for(const candidate of candidates){
  if(![candidate.base_commit,candidate.source_commit,candidate.published].every(validCommit))continue;
  const empty=candidate.base_commit===candidate.source_commit;
  // Empty child work still owns its inherited private baseline. It is safe to
  // release only when the adopting owner retains that exact baseline in its
  // history; a matching empty diff alone would prove nothing about recovery.
  if(empty){
   if(await git(['merge-base','--is-ancestor',candidate.source_commit,candidate.published])===null)continue;
  }else{
   const paths=await adoptionPaths(git,candidate.base_commit,candidate.source_commit);
   if(!paths||await git(['--literal-pathspecs','diff','--quiet','--no-ext-diff','--no-textconv',candidate.source_commit,candidate.published,'--',...paths])===null)continue;
  }
  const changed=await withQueryableTransaction(db,async tx=>{
   await assertProjectWriterForMutation(tx,w.space_id,w.project_id,userId);
   const locked=(await tx.query<ExecutionWorkspaceRow>('SELECT * FROM execution_workspaces WHERE id=ANY($1::varchar[]) ORDER BY id FOR UPDATE',[[w.id,w.parent_workspace_id]])).rows;
   const current=locked.find(x=>x.id===w.id),parent=locked.find(x=>x.id===w.parent_workspace_id);
   if(!current||current.state!=='ready'||current.generation!==w.generation||current.revision!==w.revision||current.head_commit!==candidate.source_commit||current.parent_workspace_id!==w.parent_workspace_id
    ||!parent||parent.generation!==candidate.parent_generation||parent.space_id!==w.space_id||parent.project_id!==w.project_id||parent.execution_host_id!==w.execution_host_id||parent.workspace_location_id!==w.workspace_location_id)return false;
   if(candidate.checkpoint&&(parent.state==='blocked'||['reclaimed','reclaiming'].includes(String((parent as ExecutionWorkspaceRow&{retention_json?:Record<string,unknown>}).retention_json?.state))))return false;
   const evidence=candidate.checkpoint?{adoption_proof:'parent_checkpoint_paths',adoption_base:candidate.base_commit,adoption_source:candidate.source_commit,adoption_generation:w.generation,adoption_checkpoint:{workspace_id:parent.id,generation:parent.generation,commit:candidate.published,base_commit:candidate.base_commit,source_commit:candidate.source_commit,child_generation:w.generation}}:
    {adoption_proof:'published_parent_paths',already_present_at:candidate.published,adoption_base:candidate.base_commit,adoption_source:candidate.source_commit,adoption_generation:w.generation,adoption_target_ref:candidate.parent_target};
   const changed=Boolean((await tx.query(`UPDATE workspace_change_sets c SET state=CASE WHEN c.state='integrated' THEN c.state ELSE 'no_changes' END,revision=revision+1,
    verification_json=verification_json||$5::jsonb,updated_at=now()
    WHERE COALESCE(c.verification_json->'native_progress'->>'status','')<>'pending' AND c.id=$1 AND c.state IN ('open','integrated','no_changes') AND c.revision=$2 AND c.base_commit=$3 AND c.source_commit=$4
     AND EXISTS(SELECT 1 FROM workspace_change_sets p WHERE p.id=$6 AND p.workspace_id=$7 AND p.generation=$9 AND
      CASE WHEN $10::boolean THEN p.state IN ('open','ready','integrated','no_changes') AND EXISTS(SELECT 1 FROM execution_workspace_runs b WHERE b.change_set_id=p.id AND b.checkpoint_state='saved' AND b.checkpoint_commit=$8)
      ELSE p.state='integrated' AND EXISTS(SELECT 1 FROM task_merges m WHERE m.change_set_id=p.id AND m.status='merged' AND m.merged_commit=$8 AND m.target_ref=$11) END)
     AND NOT EXISTS(SELECT 1 FROM execution_workspace_runs b JOIN runs r ON r.id=b.run_id AND r.space_id=b.space_id
      WHERE b.workspace_id=c.workspace_id AND (b.checkpoint_state<>'saved' OR r.status IN ${ACTIVE}))
     AND NOT EXISTS(SELECT 1 FROM workspace_change_sets other WHERE other.workspace_id=c.workspace_id AND other.state IN ('ready','integrating','blocked'))
     RETURNING c.id`,[candidate.id,candidate.revision,candidate.base_commit,candidate.source_commit,JSON.stringify({adopted_by_change_id:candidate.parent_change,...evidence}),candidate.parent_change,w.parent_workspace_id,candidate.published,candidate.parent_generation,candidate.checkpoint,candidate.parent_target])).rowCount);
   if(changed)await tx.query(`UPDATE workspace_change_sets SET verification_json=CASE WHEN jsonb_typeof(verification_json->'adopted_child_change_ids')='array'
    THEN jsonb_set(verification_json,'{adopted_child_change_ids}',(verification_json->'adopted_child_change_ids')||to_jsonb($2::text)) ELSE verification_json END WHERE id=$1`,[candidate.parent_change,candidate.id]);
   return changed;
  });
  if(changed)return true;
 }
 return false;
}

const SETTLED_GUARDS=`COALESCE(c.verification_json->'native_progress'->>'status','')<>'pending'
   AND NOT EXISTS(SELECT 1 FROM execution_workspace_runs b JOIN runs r ON r.id=b.run_id AND r.space_id=b.space_id
    WHERE b.workspace_id=c.workspace_id AND (b.checkpoint_state<>'saved' OR r.status IN ${ACTIVE}))
   AND NOT EXISTS(SELECT 1 FROM workspace_change_sets other WHERE other.workspace_id=c.workspace_id AND other.state IN ('ready','integrating','blocked'))
   AND NOT EXISTS(SELECT 1 FROM task_merges m WHERE m.change_set_id=c.id)`;
const PROOF_RECHECK_MS=6*60*60_000;

/**
 * Close settled work that is already in the target without a Rainver
 * publication (block 2 of hosts.md, "Adoption and record reconciliation"):
 *
 * - an open batch whose every binding is saved and whose saved source equals
 *   its base (or has nothing saved) closes as `no_changes` (`empty_saved_delta`);
 * - an open batch with a saved difference closes only when every path its
 *   recorded delta changes (modes and deletions included) is identical in the
 *   current target or a bounded historical target version (`target_paths_match`),
 *   or the source is itself target history. Branch absence and titles prove nothing.
 *
 * Active Runs, pending checkpoints/native requests, integrations, blocked or
 * quarantined owners and owners without a target are never touched. Git reads
 * run outside the transaction; the freeze is rechecked under the row lock.
 * A refused proof is not retried until the target tip or the source changes
 * (or six hours pass). Retention, private-baseline protection, grace and the
 * Host's own release proof then govern cleanup exactly as for a publication.
 */
export async function reconcileWorkspaceAdoption(db:Queryable,w:ExecutionWorkspaceRow&{inventory_json?:Record<string,unknown>|null;retention_json?:Record<string,unknown>|null},userId:string,hosts:HostConnectionRegistry,workspaceRoot?:string){
 if(w.state==='blocked'||Number(w.inventory_json?.quarantined_whole??0)>0)return false;
 if(w.owner_kind==='task')return false;
 const EMPTY=`c.workspace_id=$1 AND c.state='open' AND (c.source_commit IS NULL OR c.source_commit=c.base_commit) AND NOT (c.verification_json ? 'submitted_commit')`;
 // Look before locking: most passes have nothing to close.
 const hasEmpty=Boolean((await db.query(`SELECT 1 FROM workspace_change_sets c WHERE ${EMPTY} LIMIT 1`,[w.id])).rowCount);
 const empty=!hasEmpty?0:await withQueryableTransaction(db,async tx=>{
  await tx.query('SELECT id FROM execution_workspaces WHERE id=$1 FOR UPDATE',[w.id]);
  return (await tx.query(`UPDATE workspace_change_sets c SET state='no_changes',revision=revision+1,verification_json=verification_json||'{"no_change_reason":"empty_saved_delta"}'::jsonb,updated_at=now()
   WHERE ${EMPTY}
    AND EXISTS(SELECT 1 FROM execution_workspace_runs b WHERE b.change_set_id=c.id)
    AND NOT EXISTS(SELECT 1 FROM execution_workspace_runs b WHERE b.change_set_id=c.id AND b.checkpoint_commit IS NOT NULL AND b.checkpoint_commit IS DISTINCT FROM c.base_commit)
    AND ${SETTLED_GUARDS} RETURNING c.id`,[w.id])).rowCount??0;
 });
 if(w.owner_kind!=='conversation'||!w.target_ref)return empty>0;
 const candidate=(await db.query<{id:string;revision:number;base_commit:string;source_commit:string;originating_run_id:string}>(`SELECT c.id,c.revision,c.base_commit,c.source_commit,c.originating_run_id FROM workspace_change_sets c
  WHERE c.workspace_id=$1 AND c.state='open' AND c.base_commit IS NOT NULL AND c.source_commit IS NOT NULL AND c.source_commit<>c.base_commit AND NOT (c.verification_json ? 'submitted_commit') AND ${SETTLED_GUARDS}
  ORDER BY c.sequence DESC LIMIT 1`,[w.id])).rows[0];
 if(!candidate||![candidate.base_commit,candidate.source_commit].every(c=>/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(c)))return empty>0;
 const git=await hostLocationGit(db,w,candidate.originating_run_id,hosts,workspaceRoot,userId);
 const tip=(await git(['rev-parse','--verify','--quiet',`${w.target_ref}^{commit}`]))?.trim();
 if(!tip||!/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(tip))return empty>0;
 const checked=w.retention_json?.adoption_check as {target?:string;source?:string;at?:string}|undefined;
 if(checked?.target===tip&&checked.source===candidate.source_commit&&Date.parse(checked.at??'')>Date.now()-PROOF_RECHECK_MS)return empty>0;
 const remember=()=>db.query(`UPDATE execution_workspaces SET retention_json=retention_json||jsonb_build_object('adoption_check',jsonb_build_object('target',$2::text,'source',$3::text,'at',now())) WHERE id=$1`,[w.id,tip,candidate.source_commit]).then(()=>empty>0);
 const paths=await adoptionPaths(git,candidate.base_commit,candidate.source_commit);
 if(!paths)return remember();
 const adoptedAt=await findHistoricalAdoption(git,candidate.base_commit,candidate.source_commit,tip,paths);
 if(!adoptedAt)return remember();
 return withQueryableTransaction(db,async tx=>{
  await assertProjectWriterForMutation(tx,w.space_id,w.project_id,userId);
  const current=(await tx.query<ExecutionWorkspaceRow>('SELECT * FROM execution_workspaces WHERE id=$1 AND space_id=$2 FOR UPDATE',[w.id,w.space_id])).rows[0];
  if(!current||current.state==='blocked'||current.generation!==w.generation||current.head_commit!==candidate.source_commit||current.target_ref!==w.target_ref)return empty>0;
  const changed=await tx.query(`UPDATE workspace_change_sets c SET state='no_changes',revision=revision+1,verification_json=verification_json||$4::jsonb,updated_at=now()
   WHERE c.id=$1 AND c.workspace_id=$5 AND c.state='open' AND c.revision=$2 AND c.source_commit=$3 AND ${SETTLED_GUARDS} RETURNING c.id`,
   [candidate.id,candidate.revision,candidate.source_commit,JSON.stringify({adoption_proof:'target_paths_match',already_present_at:adoptedAt,adoption_base:candidate.base_commit,adoption_source:candidate.source_commit,adoption_generation:w.generation,adoption_target_ref:w.target_ref,adoption_paths:paths.length}),w.id]);
  return Boolean(changed.rowCount)||empty>0;
 });
}
