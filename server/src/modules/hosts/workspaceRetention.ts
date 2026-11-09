import type {Queryable} from '../routeUtils/common.js';
import type {WorkspaceRetention} from '@rainver/protocol';

/**
 * Retention of an isolated source workspace generation (ADR 0029 cleanup).
 *
 * Server merge facts decide whether a source is disposable: every batch closed
 * as integrated/no_changes, nothing running, owed, held or depended upon. The
 * Host then re-proves the exact tip against Git before it releases the branch.
 * Unmerged, blocked, kept-without-merging or private work is never released by
 * age; only its physical tree follows the existing idle rule.
 */
export const workspaceRetentionSettings={graceMs:10*60_000,localPreimageRetentionMs:7*24*60*60_000,runHistoryRetentionMs:30*24*60*60_000};
export function configureWorkspaceRetention(config:{workspaceReclaimGraceMinutes?:number;workspaceLocalPreimageRetentionDays?:number;workspaceRunHistoryRetentionDays?:number}){
 if(config.workspaceReclaimGraceMinutes!==undefined)workspaceRetentionSettings.graceMs=config.workspaceReclaimGraceMinutes*60_000;
 if(config.workspaceLocalPreimageRetentionDays!==undefined)workspaceRetentionSettings.localPreimageRetentionMs=config.workspaceLocalPreimageRetentionDays*24*60*60_000;
 if(config.workspaceRunHistoryRetentionDays!==undefined)workspaceRetentionSettings.runHistoryRetentionMs=config.workspaceRunHistoryRetentionDays*24*60*60_000;
}

export interface RetentionAssessment {
 state:'active'|'grace'|'reclaimable'|'retained'|'held';
 reason:string;
 reclaim_after:string|null;
 hold_until:string|null;
}
const ACTIVE_RUN=`('queued','running','cancelling','waiting_for_dependency','waiting_for_review')`;
const ACTIVE_MERGE=`('queued','rebasing','resolving','verifying','waiting_local_changes')`;

/** One snapshot of durable facts; call inside the transaction that acts on it. */
export async function assessWorkspaceRetention(db:Queryable,workspaceId:string):Promise<RetentionAssessment>{
 const f=(await db.query<{owner_state:string;generation:number;head_commit:string|null;baseline_mode:string|null;quarantined:boolean;target_moved_since_refusal:boolean;retention_json:Record<string,unknown>;run_active:boolean;checkpoint_owed:boolean;checkpoint_blocked:boolean;change_pending:boolean;unpublished:boolean;blocked_change:boolean;kept:boolean;integration_active:boolean;child_dependency:boolean;dependent_cleanup:boolean;merged:boolean;last_activity:string|null;now:string}>(`SELECT w.state AS owner_state,w.generation,w.retention_json,w.head_commit,w.baseline_mode,now()::text AS now,
  COALESCE((w.inventory_json->>'quarantined_whole')::int,0)>0 AS quarantined,
  -- A refused proof is retried only once the Location's target moved through a later integration.
  EXISTS(SELECT 1 FROM task_merges m WHERE m.workspace_location_id=w.workspace_location_id AND m.status IN ('merged','no_changes')
   AND m.completed_at>COALESCE((w.retention_json->>'proof_refused_at')::timestamptz,'infinity')) AS target_moved_since_refusal,
  EXISTS(SELECT 1 FROM execution_workspace_runs b JOIN runs r ON r.id=b.run_id AND r.space_id=b.space_id WHERE b.workspace_id=w.id AND r.status IN ${ACTIVE_RUN}) AS run_active,
  EXISTS(SELECT 1 FROM execution_workspace_runs b JOIN workspace_change_sets c ON c.id=b.change_set_id WHERE b.workspace_id=w.id AND b.checkpoint_state='pending' AND c.state<>'abandoned') AS checkpoint_owed,
  EXISTS(SELECT 1 FROM execution_workspace_runs b JOIN workspace_change_sets c ON c.id=b.change_set_id WHERE b.workspace_id=w.id AND b.checkpoint_state='blocked' AND c.state<>'abandoned') AS checkpoint_blocked,
  EXISTS(SELECT 1 FROM workspace_change_sets c WHERE c.workspace_id=w.id AND (c.state IN ('ready','integrating') OR c.state='open' AND c.verification_json->'native_progress'->>'status'='pending')) AS change_pending,
  EXISTS(SELECT 1 FROM workspace_change_sets c WHERE c.workspace_id=w.id AND c.state='open' AND (c.source_commit IS DISTINCT FROM c.base_commit AND c.source_commit IS NOT NULL OR c.verification_json ? 'submitted_commit')) AS unpublished,
  EXISTS(SELECT 1 FROM workspace_change_sets c WHERE c.workspace_id=w.id AND c.state='blocked') AS blocked_change,
  EXISTS(SELECT 1 FROM workspace_change_sets c WHERE c.workspace_id=w.id AND c.state='abandoned' AND (c.source_commit IS DISTINCT FROM c.base_commit AND c.source_commit IS NOT NULL OR c.verification_json->>'pending_checkpoint_retained'='true' OR c.verification_json->>'blocked_bindings_retained'='true' AND EXISTS(SELECT 1 FROM execution_workspace_runs b WHERE b.change_set_id=c.id AND b.checkpoint_state='blocked'))) AS kept,
  EXISTS(SELECT 1 FROM task_merges m WHERE m.workspace_id=w.id AND m.status IN ${ACTIVE_MERGE}) AS integration_active,
  EXISTS(SELECT 1 FROM execution_workspaces child WHERE child.parent_workspace_id=w.id AND (
    EXISTS(SELECT 1 FROM workspace_change_sets c WHERE c.workspace_id=child.id AND c.state IN ('open','ready','integrating','blocked'))
    OR EXISTS(SELECT 1 FROM execution_workspace_runs b JOIN runs r ON r.id=b.run_id AND r.space_id=b.space_id WHERE b.workspace_id=child.id AND r.status IN ${ACTIVE_RUN})
    -- A child proves its own release against this branch: it goes first.
    OR child.head_commit IS NOT NULL AND COALESCE(child.retention_json->>'state','')<>'reclaimed')) AS child_dependency,
  EXISTS(SELECT 1 FROM jsonb_each(w.cleanup_json) res WHERE res.key NOT LIKE 'source-g%' AND COALESCE(res.value->>'kind','') NOT IN ('local_preimages','run_history','ref_pages') AND res.value->>'state'<>'cleaned') AS dependent_cleanup,
  EXISTS(SELECT 1 FROM task_merges m WHERE m.workspace_id=w.id AND m.status='merged') AS merged,
  GREATEST((SELECT MAX(COALESCE(r.ended_at,r.updated_at)) FROM execution_workspace_runs b JOIN runs r ON r.id=b.run_id AND r.space_id=b.space_id WHERE b.workspace_id=w.id),
   (SELECT MAX(c.updated_at) FROM workspace_change_sets c WHERE c.workspace_id=w.id))::text AS last_activity
  FROM execution_workspaces w WHERE w.id=$1`,[workspaceId])).rows[0];
 if(!f)return {state:'retained',reason:'workspace_missing',reclaim_after:null,hold_until:null};
 const hold=typeof f.retention_json.hold_until==='string'?f.retention_json.hold_until:null;
 const result=(state:RetentionAssessment['state'],reason:string,after:string|null=null):RetentionAssessment=>({state,reason,reclaim_after:after,hold_until:hold});
 if(f.owner_state==='blocked')return result('retained','safety_review');
 if(f.run_active)return result('active','run_active');
 if(f.checkpoint_owed)return result('active','checkpoint_pending');
 if(f.integration_active||f.change_pending)return result('active','integration_pending');
 if(f.dependent_cleanup)return result('active','dependent_cleanup');
 if(f.child_dependency)return result('retained','child_workspace_dependency');
 if(f.blocked_change||f.checkpoint_blocked)return result('retained','blocked_changes');
 if(f.unpublished)return result('retained','unpublished_changes');
 if(f.kept)return result('retained','kept_without_merging');
 // A snapshot baseline holds the person's uncommitted source edits: the
 // branch may be their only committed copy, whatever its merge facts say.
 if(f.baseline_mode==='snapshot')return result('retained','private_baseline');
 // Quarantined whole trees are unsaved work; nothing is released beside them.
 if(f.quarantined)return result('retained','quarantined');
 // The Host's Git proof already refused this exact tip: keep it until the tip
 // changes or the target moves through a later integration (or a person asks).
 if(f.head_commit&&f.retention_json.proof_refused_tip===f.head_commit&&!f.target_moved_since_refusal)return result('retained',typeof f.retention_json.proof_refused_reason==='string'?f.retention_json.proof_refused_reason:'unmerged_source');
 const now=Date.parse(f.now);
 if(hold&&Date.parse(hold)>now)return result('held','held_by_user',hold);
 const requested=typeof f.retention_json.reclaim_requested_at==='string'?Date.parse(f.retention_json.reclaim_requested_at):NaN;
 const last=f.last_activity?Date.parse(f.last_activity):NaN;
 const after=Number.isFinite(last)?last+workspaceRetentionSettings.graceMs:now;
 const reason=f.merged?'merged':'no_changes';
 if(after>now&&!(Number.isFinite(requested)&&requested>=last))return result('grace',reason,new Date(after).toISOString());
 return result('reclaimable',reason);
}

/** Persist the visible assessment; reclaim facts and holds survive re-assessment. */
export async function recordRetention(db:Queryable,workspaceId:string,patch:Partial<WorkspaceRetention>&Record<string,unknown>){
 await db.query(`UPDATE execution_workspaces SET retention_json=retention_json||$2::jsonb||jsonb_build_object('assessed_at',now()) WHERE id=$1`,[workspaceId,JSON.stringify(patch)]);
}

/** Merge commits whose tree may equal the source tip (native publication writes a new commit). */
export async function reclaimProofCommits(db:Queryable,workspaceId:string,generation:number):Promise<string[]>{
 const rows=(await db.query<{commit:string}>(`SELECT DISTINCT x.commit FROM (
   SELECT merged_commit AS commit FROM task_merges WHERE workspace_id=$1 AND generation=$2 AND status='merged'
   UNION ALL SELECT task_commit FROM task_merges WHERE workspace_id=$1 AND generation=$2 AND status='merged'
   UNION ALL SELECT onto_commit FROM task_merges WHERE workspace_id=$1 AND generation=$2 AND status='no_changes'
   UNION ALL SELECT detail_json->>'already_present_at' FROM task_merges WHERE workspace_id=$1 AND generation=$2 AND status='no_changes'
  ) x WHERE x.commit ~ '^[0-9a-f]{40}([0-9a-f]{24})?$' LIMIT 50`,[workspaceId,generation])).rows;
 return rows.map(r=>r.commit);
}

/** Recorded bases of this generation's closed batches; the Host only uses ones it can verify. */
export async function reclaimBaseCommits(db:Queryable,workspaceId:string,generation:number):Promise<string[]>{
 const rows=(await db.query<{commit:string}>(`SELECT DISTINCT x.commit FROM (
   SELECT base_commit AS commit FROM workspace_change_sets WHERE workspace_id=$1 AND generation=$2 AND state IN ('integrated','no_changes','abandoned')
   UNION ALL SELECT base_commit FROM execution_workspaces WHERE id=$1 AND generation=$2
  ) x WHERE x.commit ~ '^[0-9a-f]{40}([0-9a-f]{24})?$' LIMIT 50`,[workspaceId,generation])).rows;
 return rows.map(r=>r.commit);
}
/** Bound of exact past-Run versions kept per released generation (newest first). */
export const RUN_HISTORY_LIMIT=1000;
/** Saved Run checkpoints of this generation, newest first, for the Run-history snapshot. */
export async function runHistoryCommits(db:Queryable,workspaceId:string,generation:number):Promise<string[]>{
 return (await db.query<{commit:string}>(`SELECT b.checkpoint_commit AS commit FROM execution_workspace_runs b JOIN workspace_change_sets c ON c.id=b.change_set_id
   WHERE b.workspace_id=$1 AND c.generation=$2 AND b.checkpoint_state='saved' AND b.checkpoint_commit ~ '^[0-9a-f]{40}([0-9a-f]{24})?$'
   GROUP BY b.checkpoint_commit ORDER BY MAX(b.created_at) DESC LIMIT ${RUN_HISTORY_LIMIT}`,[workspaceId,generation])).rows.map(r=>r.commit);
}

/**
 * `due_at`: a delayed release (preimages, Run history) sends this ref only once
 * it is due; never sent to the Host. `kept_epoch` (Run history): the newest
 * release epoch the Host reported keeping it; the Host refuses the deletion if
 * a newer release kept it since (`ref_renewed`).
 */
export interface RefRelease {ref:string;expected_commit?:string;prefix?:boolean;due_at?:string;kept_epoch?:number}
/** Hosts at this `execution_workspaces.reclaim` level journal ref operations (a reply proves the end), fence Run-history renewal and page history. */
export const RECLAIM_PROTOCOL=2;
export function hostReleasesRefs(level:number|null|undefined){return (level??0)>=RECLAIM_PROTOCOL;}
/**
 * Hosts at this level settle earlier ref operations (finished, or cancelled for
 * good) under the Task lease, keep dependent commits under independent keeper
 * refs first and restore the shared names in that same operation, and delete a
 * shared `sources` ref only for a fence-marked request. Level 3 settled without
 * keepers and is never asked to settle.
 */
export const REF_SETTLE_PROTOCOL=4;
export function hostSettlesRefs(level:number|null|undefined){return (level??0)>=REF_SETTLE_PROTOCOL;}
/** Release lists travel in pages of this size (the Host frame bound). */
export const REF_RELEASE_PAGE=200;
const COMMIT=/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
/**
 * Which refs a fully closed workspace may release. Owned refs come from the
 * Host inventory by name; shared content-addressed refs are released only when
 * no other open or retained batch/integration on the same Host references them.
 */
export async function refReleasePlan(db:Queryable,w:{id:string;generation:number;execution_host_id:string},ownedRefs:ReadonlyArray<{ref:string;commit:string}>){
 const owned=await ownedRefReleases(db,w,ownedRefs);
 const release:RefRelease[]=[...owned.release];let shared=0;
 const merges=(await db.query<{id:string;commits:string[]}>(`SELECT id,ARRAY[source_commit,task_commit,merged_commit] AS commits FROM task_merges WHERE workspace_id=$1 AND generation=$2 AND status IN ('merged','no_changes')`,[w.id,w.generation])).rows;
 for(const m of merges)release.push({ref:`refs/rainver/recovery/${m.id}`});
 const candidates=[...new Set(merges.flatMap(m=>m.commits).filter((c):c is string=>typeof c==='string'&&COMMIT.test(c)))];
 const sources:RefRelease[]=[];
 if(candidates.length){
  const free=await freeSourceCommits(db,{hostId:w.execution_host_id,workspaceId:w.id,generation:w.generation},candidates);
  for(const c of free)sources.push({ref:`refs/rainver/sources/${c}`,expected_commit:c});
  shared+=candidates.length-free.length;
 }
 // The whole list: callers send it in REF_RELEASE_PAGE pages and do not call
 // the release finished while a page remains. Shared `sources` refs are never
 // sent from this snapshot: they travel as release pages, each re-checked
 // against every dependent on the Host when claimed, and again after the Host
 // confirmed the deletion (a dependent that appeared meanwhile is re-pinned). `shared_retained` counts shared refs kept for
 // other dependents; owned refs left behind show in the Host's own inventory
 // after the release and are counted from there.
 return {release,sources,retained:owned.retained+shared,shared_retained:shared};
}
/**
 * The commits no dependent on the same Host still references (the dependent
 * commits are exactly what the fence trigger guards: migration 0020's
 * `workspace_*_dependent_commits`, including native submitted commits): an unfinished
 * integration of any workspace (other than this generation's own closed ones),
 * or an unfinished batch of any workspace (this one's abandoned batches were
 * already judged by its retention).
 */
export async function freeSourceCommits(db:Queryable,w:{hostId:string;workspaceId:string;generation:number},commits:readonly string[]):Promise<string[]>{
 const valid=[...new Set(commits.filter(c=>COMMIT.test(c)))];
 if(!valid.length)return [];
 return (await db.query<{commit:string}>(`SELECT c AS commit FROM unnest($1::text[]) c WHERE
   NOT EXISTS(SELECT 1 FROM task_merges o JOIN workspace_locations l ON l.id=o.workspace_location_id
    WHERE l.execution_host_id=$2 AND (o.workspace_id IS DISTINCT FROM $3 OR o.generation IS DISTINCT FROM $4) AND o.status NOT IN ('merged','no_changes') AND c=ANY(workspace_merge_dependent_commits(o.source_commit,o.task_commit,o.merged_commit)))
   AND NOT EXISTS(SELECT 1 FROM workspace_change_sets oc JOIN execution_workspaces ow ON ow.id=oc.workspace_id
    WHERE ow.execution_host_id=$2 AND oc.state NOT IN ('integrated','no_changes') AND (oc.workspace_id<>$3 OR oc.state<>'abandoned')
     AND c=ANY(workspace_source_dependent_commits(oc.source_commit,oc.base_commit,oc.verification_json)))`,[valid,w.hostId,w.workspaceId,w.generation])).rows.map(r=>r.commit);
}
/** The attributable part of one page of the workspace's owned refs (Host inventory, by name). */
export async function ownedRefReleases(db:Queryable,w:{id:string;generation:number},ownedRefs:ReadonlyArray<{ref:string;commit:string}>){
 const closed=new Set((await db.query<{commit:string}>(`SELECT unnest(ARRAY[source_commit,base_commit]) AS commit FROM workspace_change_sets WHERE workspace_id=$1 AND state IN ('integrated','no_changes','abandoned')`,[w.id])).rows.map(r=>r.commit).filter(Boolean));
 const release:RefRelease[]=[];let retained=0;
 for(const owned of ownedRefs){
  const parts=owned.ref.split('/');
  if(parts[2]==='recovery'&&parts[3]===w.id&&parts.length===5){
   // An idle sync's old tip: only a tip some closed batch recorded is attributable.
   if(closed.has(parts[4]!)&&owned.commit===parts[4])release.push({ref:owned.ref,expected_commit:owned.commit});else retained++;
  }else if(parts[2]==='native-preimages'&&parts[3]===w.id&&parts[4]===`g${w.generation}`)release.push({ref:owned.ref,expected_commit:owned.commit});
  else retained++;
 }
 return {release,retained};
}

/** Local-change preimages of this generation's publications, released after their bounded retention. */
export async function localPreimageReleases(db:Queryable,workspaceId:string,generation:number):Promise<RefRelease[]>{
 const rows=(await db.query<{commit:string}>(`SELECT DISTINCT unnest(ARRAY[task_commit,merged_commit]) AS commit FROM task_merges WHERE workspace_id=$1 AND generation=$2 AND status='merged'`,[workspaceId,generation])).rows;
 return rows.map(r=>r.commit).filter(c=>typeof c==='string'&&COMMIT.test(c)).map(c=>({ref:`refs/rainver/local-preimages/${c}`,prefix:true}));
}

/**
 * Attribute Location refs under refs/rainver/ to a known owner. Unattributable
 * refs are retained with an explicit reason; nothing here deletes a ref.
 */
export async function classifyLocationRefs(db:Queryable,hostId:string,refs:ReadonlyArray<{ref:string;commit:string}>){
 const workspaceIds=new Set<string>(),mergeIds=new Set<string>(),commits=new Set<string>();
 for(const {ref} of refs){
  const p=ref.split('/');
  if((p[2]==='recovery'||p[2]==='native-preimages'||p[2]==='run-history'||p[2]==='source-keepers')&&p.length>=5)workspaceIds.add(p[3]!);
  else if(p[2]==='recovery'&&p.length===4)mergeIds.add(p[3]!);
  else if((p[2]==='sources'||p[2]==='local-preimages')&&p.length===4)commits.add(p[3]!.replace(/-index$/,''));
 }
 const knownWorkspaces=new Set((await db.query<{id:string}>('SELECT id FROM execution_workspaces WHERE id=ANY($1::varchar[]) AND execution_host_id=$2',[[...workspaceIds],hostId])).rows.map(r=>r.id));
 const knownMerges=new Set((await db.query<{id:string}>('SELECT m.id FROM task_merges m JOIN workspace_locations l ON l.id=m.workspace_location_id WHERE m.id=ANY($1::varchar[]) AND l.execution_host_id=$2',[[...mergeIds],hostId])).rows.map(r=>r.id));
 const knownCommits=new Set((await db.query<{commit:string}>(`SELECT DISTINCT c AS commit FROM unnest($1::text[]) c WHERE EXISTS(SELECT 1 FROM task_merges m JOIN workspace_locations l ON l.id=m.workspace_location_id WHERE l.execution_host_id=$2 AND c=ANY(workspace_merge_dependent_commits(m.source_commit,m.task_commit,m.merged_commit)))
   OR EXISTS(SELECT 1 FROM workspace_change_sets c2 JOIN execution_workspaces w ON w.id=c2.workspace_id WHERE w.execution_host_id=$2 AND c=ANY(workspace_source_dependent_commits(c2.source_commit,c2.base_commit,c2.verification_json)))`,[[...commits],hostId])).rows.map(r=>r.commit));
 const unclaimed:Array<{ref:string;reason:string}>=[];
 for(const {ref} of refs){
  const p=ref.split('/');
  const owner=(p[2]==='recovery'||p[2]==='native-preimages'||p[2]==='run-history'||p[2]==='source-keepers')&&p.length>=5?knownWorkspaces.has(p[3]!)
   :p[2]==='recovery'&&p.length===4?knownMerges.has(p[3]!)
   :(p[2]==='sources'||p[2]==='local-preimages')&&p.length===4?knownCommits.has(p[3]!.replace(/-index$/,'')):false;
  if(!owner)unclaimed.push({ref,reason:'unknown_owner'});
 }
 return unclaimed;
}
