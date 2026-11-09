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
