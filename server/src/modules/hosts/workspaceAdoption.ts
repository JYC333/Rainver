import {isWireRelativePath,looksSecretLikePath} from '@rainver/folder-read';
import {withQueryableTransaction,type Queryable} from '../routeUtils/common.js';
import {hostLocationGit} from '../projectFolders/workspaceCommitSubmission.js';
import type {ExecutionWorkspaceRow} from '../projectFolders/executionWorkspaces.js';
import {assertProjectWriterForMutation} from '../projects/access.js';
import type {HostConnectionRegistry} from './connectionRegistry.js';

const ACTIVE="('queued','running','cancelling','waiting_for_dependency','waiting_for_review')";
/** A native parent may cherry-pick a child's checkpoint instead of publishing
 * the child through the integration worker. Close only an exact saved delta
 * found in an actual publication of that parent; completion alone proves none.
 * Git reads run outside the transaction; the freeze is rechecked under locks.
 * Cleanup, holds, private baselines and Host release proofs remain unchanged.
 */
export async function reconcilePublishedWorkspaceChild(db:Queryable,w:ExecutionWorkspaceRow,userId:string,hosts:HostConnectionRegistry,workspaceRoot?:string){
 if(w.owner_kind!=='delegation'||!w.parent_workspace_id||w.state!=='ready')return false;
 const candidate=(await db.query<{id:string;revision:number;base_commit:string;source_commit:string;originating_run_id:string;parent_change:string;published:string}>(`SELECT c.id,c.revision,c.base_commit,c.source_commit,c.originating_run_id,p.id AS parent_change,m.merged_commit AS published
  FROM workspace_change_sets c
  JOIN execution_workspaces parent ON parent.id=$2 AND parent.space_id=c.space_id
   AND parent.project_id=$3 AND parent.execution_host_id=$4 AND parent.workspace_location_id=$5
  JOIN workspace_change_sets p ON p.workspace_id=parent.id AND p.state='integrated'
  JOIN task_merges m ON m.change_set_id=p.id AND m.space_id=c.space_id AND m.status='merged'
  WHERE c.workspace_id=$1 AND c.space_id=$6 AND c.state='open' AND c.source_commit=$7
   AND COALESCE(c.verification_json->'native_progress'->>'status','')<>'pending'
   AND c.base_commit IS NOT NULL AND c.source_commit IS DISTINCT FROM c.base_commit
   AND m.merged_commit IS NOT NULL
   AND NOT EXISTS(SELECT 1 FROM execution_workspace_runs b JOIN runs r ON r.id=b.run_id AND r.space_id=b.space_id
    WHERE b.workspace_id=c.workspace_id AND (b.checkpoint_state<>'saved' OR r.status IN ${ACTIVE}))
   AND NOT EXISTS(SELECT 1 FROM workspace_change_sets other WHERE other.workspace_id=c.workspace_id AND other.state IN ('ready','integrating','blocked'))
  ORDER BY m.completed_at DESC,c.sequence DESC LIMIT 1`,[w.id,w.parent_workspace_id,w.project_id,w.execution_host_id,w.workspace_location_id,w.space_id,w.head_commit])).rows[0];
 if(!candidate||![candidate.base_commit,candidate.source_commit,candidate.published].every(c=>/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(c)))return false;
 const git=await hostLocationGit(db,w,candidate.originating_run_id,hosts,workspaceRoot,userId);
 if(await git(['merge-base','--is-ancestor',candidate.base_commit,candidate.source_commit])===null)return false;
 const pathsRaw=await git(['--literal-pathspecs','diff','--name-only','--no-ext-diff','--no-textconv','--no-renames','-z',candidate.base_commit,candidate.source_commit,'--']);
 if(pathsRaw===null||!pathsRaw.endsWith('\0')||Buffer.byteLength(pathsRaw)>128*1024)return false;
 const paths=pathsRaw.split('\0').filter(Boolean);
 if(!paths.length||paths.length>500||paths.some(p=>p.length>4096||!isWireRelativePath(p)||p.split('/').some(s=>s==='..'||s==='.git')||looksSecretLikePath(p)))return false;
 // Comparing whole paths includes modes and deletions, and cannot drop a hunk
 // as patch-text heuristics can. Later edits on these paths stay conservative.
 if(await git(['--literal-pathspecs','diff','--quiet','--no-ext-diff','--no-textconv',candidate.source_commit,candidate.published,'--',...paths])===null)return false;
 return withQueryableTransaction(db,async tx=>{
  await assertProjectWriterForMutation(tx,w.space_id,w.project_id,userId);
  const current=(await tx.query<ExecutionWorkspaceRow>('SELECT * FROM execution_workspaces WHERE id=$1 AND space_id=$2 FOR UPDATE',[w.id,w.space_id])).rows[0];
  if(!current||current.state!=='ready'||current.revision!==w.revision||current.head_commit!==candidate.source_commit||current.parent_workspace_id!==w.parent_workspace_id)return false;
  const changed=await tx.query(`UPDATE workspace_change_sets c SET state='no_changes',revision=revision+1,
   verification_json=verification_json||$5::jsonb,updated_at=now()
   WHERE COALESCE(c.verification_json->'native_progress'->>'status','')<>'pending' AND c.id=$1 AND c.state='open' AND c.revision=$2 AND c.base_commit=$3 AND c.source_commit=$4
    AND EXISTS(SELECT 1 FROM workspace_change_sets p JOIN task_merges m ON m.change_set_id=p.id
     WHERE p.id=$6 AND p.workspace_id=$7 AND p.state='integrated' AND m.status='merged' AND m.merged_commit=$8)
    AND NOT EXISTS(SELECT 1 FROM execution_workspace_runs b JOIN runs r ON r.id=b.run_id AND r.space_id=b.space_id
     WHERE b.workspace_id=c.workspace_id AND (b.checkpoint_state<>'saved' OR r.status IN ${ACTIVE}))
    AND NOT EXISTS(SELECT 1 FROM workspace_change_sets other WHERE other.workspace_id=c.workspace_id AND other.state IN ('ready','integrating','blocked'))
    RETURNING c.id`,[candidate.id,candidate.revision,candidate.base_commit,candidate.source_commit,JSON.stringify({adopted_by_change_id:candidate.parent_change,already_present_at:candidate.published,adoption_proof:'published_parent_paths'}),candidate.parent_change,w.parent_workspace_id,candidate.published]);
  return Boolean(changed.rowCount);
 });
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
 *   current target tip (`target_paths_match`) — the exact content evidence that
 *   survives an external merge, squash or history rewrite. Branch absence,
 *   titles or commit ancestry alone never close anything.
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
 if(await git(['merge-base','--is-ancestor',candidate.base_commit,candidate.source_commit])===null)return remember();
 const pathsRaw=await git(['--literal-pathspecs','diff','--name-only','--no-ext-diff','--no-textconv','--no-renames','-z',candidate.base_commit,candidate.source_commit,'--']);
 if(pathsRaw===null||Buffer.byteLength(pathsRaw)>128*1024)return remember();
 const paths=pathsRaw.split('\0').filter(Boolean);
 if(!paths.length||paths.length>500||paths.some(p=>p.length>4096||!isWireRelativePath(p)||p.split('/').some(s=>s==='..'||s==='.git')||looksSecretLikePath(p)))return remember();
 if(await git(['--literal-pathspecs','diff','--quiet','--no-ext-diff','--no-textconv',candidate.source_commit,tip,'--',...paths])===null)return remember();
 return withQueryableTransaction(db,async tx=>{
  await assertProjectWriterForMutation(tx,w.space_id,w.project_id,userId);
  const current=(await tx.query<ExecutionWorkspaceRow>('SELECT * FROM execution_workspaces WHERE id=$1 AND space_id=$2 FOR UPDATE',[w.id,w.space_id])).rows[0];
  if(!current||current.state==='blocked'||current.target_ref!==w.target_ref)return empty>0;
  const changed=await tx.query(`UPDATE workspace_change_sets c SET state='no_changes',revision=revision+1,verification_json=verification_json||$4::jsonb,updated_at=now()
   WHERE c.id=$1 AND c.workspace_id=$5 AND c.state='open' AND c.revision=$2 AND c.source_commit=$3 AND ${SETTLED_GUARDS} RETURNING c.id`,
   [candidate.id,candidate.revision,candidate.source_commit,JSON.stringify({adoption_proof:'target_paths_match',already_present_at:tip,adoption_target_ref:w.target_ref,adoption_paths:paths.length}),w.id]);
  return Boolean(changed.rowCount)||empty>0;
 });
}
