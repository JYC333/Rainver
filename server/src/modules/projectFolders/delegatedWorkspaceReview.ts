import type {ExecutionWorkspaceRef} from '@rainver/protocol';
import type {Queryable} from '../routeUtils/common.js';

/**
 * The frozen basis of a read-only delegated review of its coordinator's
 * workspace (`execution_workspace_reviews`, ADR 0029). It is written once, at
 * the Run's first placement, and every replay of that Run reuses it verbatim:
 * a retry never re-places the review (no fork, no other version), even when the
 * coordinator moved on — the Host then refuses the stale basis instead.
 *
 * Expected and observed are kept apart. The server only ever states what it
 * expected; a review counts as done (`verified`) only once the Host, after
 * verifying the clean frozen version under its shared lease and starting the
 * review, reports reading exactly that commit. A Host refusal is `refused`.
 * The Run's `output_json.review_basis` mirrors this state for result readers.
 */
export type FrozenReview={run_id:string;workspace_id:string;generation:number;workspace_location_id:string;expected_commit:string;state:'pending'|'verified'|'refused'};

const REFUSAL=/^execution_workspace_review_[a-z_]{1,40}$/;

export async function frozenReview(db:Queryable,runId:string,spaceId:string):Promise<FrozenReview|null>{
 return (await db.query<FrozenReview>('SELECT run_id,workspace_id,generation,workspace_location_id,expected_commit,state FROM execution_workspace_reviews WHERE run_id=$1 AND space_id=$2',[runId,spaceId])).rows[0]??null;
}

/** First placement wins; a concurrent or later call returns the stored basis. */
export async function freezeReview(tx:Queryable,input:{runId:string;spaceId:string;workspaceId:string;generation:number;locationId:string;commit:string}):Promise<FrozenReview>{
 await tx.query(`INSERT INTO execution_workspace_reviews(run_id,space_id,workspace_id,generation,workspace_location_id,expected_commit) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT (run_id) DO NOTHING`,
  [input.runId,input.spaceId,input.workspaceId,input.generation,input.locationId,input.commit]);
 const frozen=(await frozenReview(tx,input.runId,input.spaceId))!;
 await mirror(tx,input.runId,input.spaceId,{mode:'coordinator_workspace',execution_workspace_id:frozen.workspace_id,generation:frozen.generation,
  workspace_location_id:frozen.workspace_location_id,expected_commit:frozen.expected_commit,state:frozen.state});
 return frozen;
}

/** The launch reference built only from the frozen basis. */
export function reviewReference(frozen:FrozenReview,extra:{target_ref?:string|null;baseline_mode?:'committed'|'snapshot'|null}):ExecutionWorkspaceRef{
 return {id:frozen.workspace_id,generation:frozen.generation,base_commit:frozen.expected_commit,review_commit:frozen.expected_commit,
  ...(extra.target_ref?{target_ref:extra.target_ref}:{}),...(extra.baseline_mode?{baseline_mode:extra.baseline_mode}:{})};
}

/**
 * What the Host reported reading (its read-only basis upload, sent only for a
 * review it started). Verified only when that HEAD is exactly the expected
 * commit; another HEAD is refused as a moved basis, never upgraded later. An
 * unreadable HEAD leaves it unverified (pending).
 */
export async function recordReviewObservation(tx:Queryable,runId:string,spaceId:string,observed:{head:string|null;tree:string|null}):Promise<void>{
 const row=(await tx.query<{state:string;expected_commit:string}>(`UPDATE execution_workspace_reviews SET
   state=CASE WHEN $3::text=expected_commit THEN 'verified' ELSE 'refused' END,
   refusal=CASE WHEN $3::text=expected_commit THEN NULL ELSE 'execution_workspace_review_basis_moved' END,
   observed_commit=$3,observed_tree=$4,observed_at=now()
  WHERE run_id=$1 AND space_id=$2 AND state='pending' AND $3::text IS NOT NULL RETURNING state,expected_commit`,[runId,spaceId,observed.head,observed.tree])).rows[0];
 if(row)await mirror(tx,runId,spaceId,{state:row.state,observed_commit:observed.head,...(row.state==='refused'?{refusal:'execution_workspace_review_basis_moved'}:{})});
}

/** The Host refused the launch (dirty or moved tree, missing worktree, no read-only namespace). */
export async function recordReviewRefusal(db:Queryable,runId:string,spaceId:string,error:string|null|undefined):Promise<boolean>{
 const code=(error??'').trim();
 if(!REFUSAL.test(code))return false;
 const row=(await db.query(`UPDATE execution_workspace_reviews SET state='refused',refusal=$3,observed_at=now() WHERE run_id=$1 AND space_id=$2 AND state='pending' RETURNING run_id`,[runId,spaceId,code])).rowCount;
 if(row)await mirror(db,runId,spaceId,{state:'refused',refusal:code});
 return Boolean(row);
}

async function mirror(db:Queryable,runId:string,spaceId:string,patch:Record<string,unknown>){
 await db.query(`UPDATE runs SET output_json=jsonb_set(CASE WHEN jsonb_typeof(output_json)='object' THEN output_json ELSE '{}'::jsonb END,'{review_basis}',
   COALESCE(CASE WHEN jsonb_typeof(output_json->'review_basis')='object' THEN output_json->'review_basis' END,'{}'::jsonb)||$3::jsonb,true),updated_at=now() WHERE id=$1 AND space_id=$2`,
  [runId,spaceId,JSON.stringify(patch)]);
}
