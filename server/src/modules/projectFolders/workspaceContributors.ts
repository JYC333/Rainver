import {assertSqlIdentifier} from '../access/contentAccessSql.js';
import {runBodyReadableSql} from '../runs/runBodyReadSql.js';
import {HttpError,type Queryable} from '../routeUtils/common.js';

/**
 * Contributor provenance of a workspace batch (ADR 0029, "Delegated workspace
 * placement"). A batch's saved commit, timestamps and diff are not only its
 * originating Run's: every Run bound to the batch (a later turn of the same
 * conversation, or a serial delegated child continuing in the coordinator's
 * workspace) checkpoints into it, a Run that prepares or checkpoints through
 * the native operation is recorded in `contributor_run_ids`, and a parent
 * batch carries the content of every child batch it adopted
 * (`adopted_child_change_ids`).
 *
 * A reader sees, pages, diffs or publishes a batch only when the origin Run and
 * every such contributor are readable with an unwithheld body
 * (`runBodyReadableSql`). One unreadable contributor hides the whole batch
 * (fail-closed): its commit identity, activity time and content would
 * otherwise reveal that Run's work.
 */
/** Shared lineage for read authorization and publication taint assessment. UNION
 * terminates even malformed cyclic adoption records; legacy lineage is kept
 * conservative, matching the publication contract. */
export function workspaceContributorCtes(changeId:string,spaceId:string):string{
 return `WITH RECURSIVE lineage AS (
  SELECT id,workspace_id,space_id,originating_run_id,verification_json FROM workspace_change_sets WHERE id=${changeId} AND space_id=${spaceId}
  UNION
  SELECT child.id,child.workspace_id,child.space_id,child.originating_run_id,child.verification_json FROM lineage parent
   JOIN execution_workspaces w ON w.parent_workspace_id=parent.workspace_id AND w.space_id=parent.space_id
   JOIN workspace_change_sets child ON child.workspace_id=w.id AND child.space_id=parent.space_id AND child.state IN ('integrated','no_changes')
   WHERE COALESCE(jsonb_typeof(parent.verification_json->'adopted_child_change_ids'),'null')<>'array'
    OR (parent.verification_json->'adopted_child_change_ids') ? child.id
 ), contributor_ids AS (
  SELECT originating_run_id AS id,space_id FROM lineage
  UNION SELECT b.run_id,b.space_id FROM execution_workspace_runs b JOIN lineage c ON c.id=b.change_set_id AND c.space_id=b.space_id
  UNION SELECT v.id,c.space_id FROM lineage c CROSS JOIN LATERAL jsonb_array_elements_text(
   CASE WHEN jsonb_typeof(c.verification_json->'contributor_run_ids')='array' THEN c.verification_json->'contributor_run_ids' ELSE '[]'::jsonb END) v(id)
 )`;
}

export function workspaceContributorsReadableSql(changeAlias:string,userExpr:string):string{
 assertSqlIdentifier(changeAlias,'alias');
 return `(NOT EXISTS(${workspaceContributorCtes(`${changeAlias}.id`,`${changeAlias}.space_id`)}
  SELECT 1 FROM contributor_ids ci LEFT JOIN runs contributor ON contributor.id=ci.id AND contributor.space_id=ci.space_id
  WHERE contributor.id IS NULL OR NOT ${runBodyReadableSql('contributor',userExpr)}))`;
}

/** The same gate for one batch an operation is about to act on (get, diff, publish, close). */
export async function assertWorkspaceContributorsReadable(db:Queryable,spaceId:string,userId:string,changeId:string,hidden:()=>Error=()=>new HttpError(404,'Workspace change not found')){
 const ok=(await db.query(`SELECT 1 FROM workspace_change_sets c WHERE c.id=$1 AND c.space_id=$2 AND ${workspaceContributorsReadableSql('c','$3')}`,[changeId,spaceId,userId])).rowCount;
 if(!ok)throw hidden();
}

/** SQL fragment appending a Run to a batch's recorded contributors (`$n` is the Run id). */
export function appendContributorSql(runParam:string){
 return `jsonb_set(verification_json,'{contributor_run_ids}',(SELECT COALESCE(jsonb_agg(DISTINCT v),'[]'::jsonb) FROM jsonb_array_elements_text(
   (CASE WHEN jsonb_typeof(verification_json->'contributor_run_ids')='array' THEN verification_json->'contributor_run_ids' ELSE '[]'::jsonb END)||jsonb_build_array(${runParam}::text)) v),true)`;
}
