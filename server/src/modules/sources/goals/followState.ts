import {goalCollectionReadableSql,goalItemReadableSql} from './itemVisibility.js';
import type {SourceGoalExecutionProgress,SourceGoalFollowState} from '@rainver/protocol';
import type {Queryable} from '../../routeUtils/common.js';
import {goalSourceRow,type GoalRow} from './access.js';
import type {SourceGoalBindingSpec} from '@rainver/protocol';
/** Errors that mean "an authorization or setup decision is needed", which must
 * never be shown as "no new items" or as an ordinary transient failure. */
const PERMISSION_ERRORS=new Set(['source_unavailable','source_authority_revoked','source_credential_decision_required','source_credential_policy_disabled','source_native_context_refused','source_search_path_confirmation_required','source_scope_changed','source_policy_disabled','source_permission_denied']);
/** A usage limit was reached: the owner raises it or waits; nobody's permission is missing. */
const BUDGET_ERRORS=new Set(['source_native_budget_exhausted','source_goal_exploration_budget_exhausted']);
/** Execution setup is incomplete or changed (Agent route, runtime safety): not a Source permission. */
const SETUP_ERRORS=new Set(['source_goal_execution_setup_required','source_native_safety_unavailable','source_native_route_changed']);
/** The Source's authorized state changed since the binding was confirmed (see reconfirm.ts). */
const CHANGED_ERRORS=new Set(['source_authority_revoked','source_scope_changed']);
type BindingRow={id:string;source_connection_id:string;spec_json:SourceGoalBindingSpec;status:string;failures:number;retry_at:string|null;last_success_at:string|null;fixture_json:{collection_error?:string;repair_block_reason?:string;authority_sha256?:string;confirmed_at?:string}|null};
type Attention='source_changed'|'access'|'budget'|'setup';
/** A failed check that ended before the binding was (re)confirmed is history, not its current state. */
const confirmedSince=(b:BindingRow,endedAt:string|Date|null)=>!!b.fixture_json?.confirmed_at&&!!endedAt&&Date.parse(b.fixture_json.confirmed_at)>new Date(endedAt).getTime();
type GoalWithFollow=GoalRow&{follow_json?:{last_error?:string|null}|null};
/** Read-only projection over canonical goal, binding, collection-audit, Run,
 * scheduler and membership rows. It is not a second state machine. */
/** `unavailable` are Source connections the viewer may no longer read; they
 * stay in the projection as needs_permission without exposing their content. */
export async function goalFollowState(db:Queryable,g:GoalWithFollow,explore:SourceGoalExecutionProgress|null,unavailable:ReadonlySet<string>=new Set(),viewerId=g.owner_user_id):Promise<SourceGoalFollowState>{
 const following=!!g.follow_json||g.status==='running'||!!g.active_version_id;
 const intent=g.status==='deleted'?'deleted':g.status==='paused'?'paused':following?'following':'unconfirmed';
 const bindings=(await db.query<BindingRow>(`SELECT b.id,b.source_connection_id,b.spec_json,b.status,b.failures,b.retry_at,b.last_success_at,b.fixture_json FROM source_goal_bindings b WHERE b.goal_id=$1 AND b.space_id=$2 AND ($3::varchar IS NULL OR EXISTS(SELECT 1 FROM source_goal_versions v CROSS JOIN LATERAL jsonb_array_elements(v.plan_json->'sources') s WHERE v.id=$3 AND s->>'source_connection_id'=b.source_connection_id)) ORDER BY b.id`,[g.id,g.space_id,g.active_version_id])).rows;
 // Each source's latest finished collection under the active version is its
 // "last check"; memberships it created first are its new items.
 const latest=new Map((await db.query<{binding_id:string;status:string;ended_at:string|null;error:string|null;created:number;changed:number}>(`SELECT DISTINCT ON (s.binding_id) s.binding_id,s.status,COALESCE(s.ended_at,s.started_at) AS ended_at,s.result_json->>'error' AS error,(SELECT count(*)::int FROM source_goal_items gi JOIN source_items item ON item.id=gi.source_item_id AND item.space_id=gi.space_id WHERE gi.goal_id=s.goal_id AND gi.first_goal_run_id=s.id AND ${goalItemReadableSql('item','$4')} AND NOT(gi.source_connection_id=ANY($5::varchar[]))) AS created,(SELECT count(*)::int FROM source_goal_item_changes c JOIN source_items item ON item.id=c.source_item_id AND item.space_id=c.space_id WHERE c.goal_id=s.goal_id AND c.goal_run_id=s.id AND c.delivered_at IS NOT NULL AND ${goalItemReadableSql('item','$4',true)} AND ${goalCollectionReadableSql('c','$4')} AND NOT(c.binding_id IN (SELECT id FROM source_goal_bindings WHERE source_connection_id=ANY($5::varchar[])))) AS changed FROM source_goal_runs s WHERE s.goal_id=$1 AND s.space_id=$2 AND s.binding_id IS NOT NULL AND s.version_id IS NOT DISTINCT FROM $3 AND s.status IN ('succeeded','insufficient','failed','interrupted') ORDER BY s.binding_id,COALESCE(s.ended_at,s.started_at) DESC`,[g.id,g.space_id,g.active_version_id,viewerId,[...unavailable]])).rows.map(r=>[r.binding_id,r] as const));
  const owner=viewerId===g.owner_user_id?'you' as const:'topic_owner' as const;
 /** What a stopped source waits for and who can resolve it; same projection for the list and the detail. */
 const attentionOf=async(b:BindingRow,error:string|null):Promise<{attention:Attention|null;resolvable_by:'you'|'topic_owner'|'source_owner'|null}>=>{
  if(!error)return {attention:null,resolvable_by:null};
  if(unavailable.has(b.source_connection_id))return {attention:'access',resolvable_by:'source_owner'};
  if(BUDGET_ERRORS.has(error))return {attention:'budget',resolvable_by:owner};
  if(SETUP_ERRORS.has(error))return {attention:'setup',resolvable_by:owner};
  if(CHANGED_ERRORS.has(error)&&b.status==='paused'){
   // Source changed (still the topic owner's Source, in its Project): the topic owner confirms the new state.
   // Otherwise its owner or access changed, which this topic cannot resolve.
   const row=await goalSourceRow(db,g.space_id,b.spec_json);
   // Only an active Source and channel can be confirmed (the confirmation runs activation's gates); archived or paused is access.
   // A Source changed back to its confirmed state stays confirmable too: the binding is still paused and only the owner resumes it.
   if(row&&row.status==='active'&&row.channel_status==='active'&&row.owner_user_id===g.owner_user_id&&row.project_id===g.project_id)return {attention:'source_changed',resolvable_by:owner};
   return {attention:'access',resolvable_by:'source_owner'};
  }
  if(PERMISSION_ERRORS.has(error))return {attention:'access',resolvable_by:owner};
  return {attention:null,resolvable_by:null};
 };
 const sources=await Promise.all(bindings.map(async b=>{const last=latest.get(b.id);const error=unavailable.has(b.source_connection_id)?'source_unavailable':b.fixture_json?.collection_error??b.fixture_json?.repair_block_reason??(last&&last.status!=='succeeded'&&last.status!=='insufficient'&&!confirmedSince(b,last.ended_at)?last.error:null)??null;
  const {attention,resolvable_by}=await attentionOf(b,error);
  const health=attention==='source_changed'||attention==='access'?'needs_permission':b.status==='collecting'?'collecting':b.status==='active'?'ok':b.status==='cooldown'?'backoff':['repair_required','repairing'].includes(b.status)?'failing':b.status==='paused'?(error?'failing':'stopped'):'failing';
  return {binding_id:b.id,source_connection_id:b.source_connection_id,status:b.status,health,error,failures:b.failures,last_success_at:b.last_success_at?new Date(b.last_success_at).toISOString():null,retry_at:b.retry_at?new Date(b.retry_at).toISOString():null,attention,resolvable_by} as SourceGoalFollowState['sources'][number];}));
 const health:SourceGoalFollowState['health']=!sources.length?'unknown':sources.some(s=>s.health==='needs_permission')?'needs_permission':sources.every(s=>['ok','collecting'].includes(s.health))?'ok':sources.some(s=>['ok','collecting'].includes(s.health))?'partial':'failing';
 const counts=(await db.query<{total:number;important:number;unjudged:number;not_selected:number;judgment_failed:number;baseline:number;new_publication:number;evidenced_change:number;unknown_freshness:number;changes:number}>(`SELECT count(*)::int total,count(*) FILTER(WHERE selection_status='important')::int important,count(*) FILTER(WHERE selection_status='unjudged')::int unjudged,count(*) FILTER(WHERE selection_status='not_selected')::int not_selected,count(*) FILTER(WHERE selection_status='judgment_failed')::int judgment_failed,count(*) FILTER(WHERE delivery_kind='baseline')::int baseline,count(*) FILTER(WHERE delivery_kind='new_publication')::int new_publication,count(*) FILTER(WHERE delivery_kind='evidenced_change')::int evidenced_change,count(*) FILTER(WHERE delivery_kind='unknown_freshness')::int unknown_freshness ,(SELECT count(*)::int FROM source_goal_item_changes c JOIN source_items changed_item ON changed_item.id=c.source_item_id AND changed_item.space_id=c.space_id WHERE c.goal_id=$1 AND c.space_id=$2 AND c.delivery_kind='evidenced_change' AND ${goalItemReadableSql('changed_item','$3',true)} AND ${goalCollectionReadableSql('c','$3')} AND NOT(c.binding_id IN (SELECT id FROM source_goal_bindings WHERE source_connection_id=ANY($4::varchar[])))) changes FROM source_goal_items gi JOIN source_items item ON item.id=gi.source_item_id AND item.space_id=gi.space_id WHERE gi.goal_id=$1 AND gi.space_id=$2 AND ${goalItemReadableSql('item','$3')} AND NOT(gi.source_connection_id=ANY($4::varchar[]))`,[g.id,g.space_id,viewerId,[...unavailable]])).rows[0];
 const checks=[...latest.values()].filter(r=>bindings.some(b=>b.id===r.binding_id));
 // Actual collection audits: queued waits for a worker or Agent slot (not
 // counted as execution time); running is executing or materializing.
 // A native audit stays 'queued' while its Agent Run executes, so the linked
 // Run's status decides; a queued Agent Run is still waiting for a slot.
 const flight=(await db.query<{queued:number;running:number}>(`SELECT count(*) FILTER(WHERE s.status='queued' AND (r.id IS NULL OR r.status='queued'))::int queued,count(*) FILTER(WHERE NOT(s.status='queued' AND (r.id IS NULL OR r.status='queued')))::int running FROM source_goal_runs s LEFT JOIN runs r ON r.id=s.result_json->>'native_run_id' AND r.space_id=s.space_id WHERE s.goal_id=$1 AND s.space_id=$2 AND s.binding_id IS NOT NULL AND s.status IN ('running','queued','accepted','materializing')`,[g.id,g.space_id])).rows[0];
 // Before a tick creates per-source audits, expose its durable queue state.
 if(flight.queued+flight.running===0){
  const pending=(await db.query<{queued:number;running:number}>(`SELECT count(*) FILTER(WHERE status='pending')::int queued,count(*) FILTER(WHERE status IN ('claimed','running'))::int running FROM jobs WHERE space_id=$1 AND job_type='source_goal_tick' AND payload_json->>'goal_id'=$2 AND status IN ('pending','claimed','running')`,[g.space_id,g.id])).rows[0];
  flight.queued=pending.queued;flight.running=pending.running;
 }
 const inFlight=flight.queued+flight.running;
 const created=checks.reduce((n,r)=>n+r.created,0);
 const changed=checks.reduce((n,r)=>n+(r.changed??0),0);
 const failed=checks.filter(r=>r.status==='failed'||r.status==='interrupted').length;
 const last_outcome:SourceGoalFollowState['results']['last_outcome']=!checks.length?'never':created+changed>0?(failed?'partial':'new_items'):failed===checks.length?'failed':failed?'partial':'no_new';
 const latestAt=checks.map(r=>r.ended_at?Date.parse(String(r.ended_at)):0).sort((x,y)=>y-x)[0]??null;
 const schedule=(await db.query<{next_run_at:string|null;status:string}>(`SELECT next_run_at,status FROM scheduler_tasks WHERE task_type='source_goal_tick' AND task_key=$1`,[g.id])).rows[0];
 const everSucceeded=sources.some(s=>s.last_success_at);
 const preparing=intent==='following'&&!g.active_version_id;
 // A usage limit or incomplete setup that no healthy source offsets blocks the topic, before or after its first check.
 const decisionBlocked=sources.some(s=>s.attention==='budget'||s.attention==='setup')&&!sources.some(s=>['ok','collecting'].includes(s.health));
 const blocked_reason=preparing?(g.follow_json?.last_error??(explore&&['failed','cancelled'].includes(explore.phase)?'source_goal_preparation_failed':explore?.phase==='needs_information'?'source_goal_needs_information':null)):health==='needs_permission'?sources.find(s=>s.health==='needs_permission')?.error??null:health==='failing'||decisionBlocked?sources.find(s=>s.attention==='budget'||s.attention==='setup')?.error??null:null;
 const phase:SourceGoalFollowState['phase']=intent==='deleted'||intent==='paused'?'stopped':intent==='unconfirmed'?'none'
  :preparing?(explore?.phase==='waiting_for_approval'?'waiting_for_permission':blocked_reason?'blocked':'preparing')
  :health==='needs_permission'?'waiting_for_permission':decisionBlocked?'blocked':inFlight>0?(everSucceeded?'checking':'first_collection'):!everSucceeded&&schedule?.status==='active'?'first_collection':health==='failing'?'blocked':'scheduled';
 const lastSuccess=sources.map(s=>s.last_success_at).filter((s):s is string=>!!s).sort().at(-1)??null;
 return {intent,collections:{queued:flight.queued,running:flight.running},pending_adjustment:!!g.active_version_id&&!!g.current_version_id&&g.current_version_id!==g.active_version_id,phase,blocked_reason,health,sources,
  results:{items_total:counts.total,important_total:counts.important,unjudged_total:counts.unjudged,not_selected_total:counts.not_selected,judgment_failed_total:counts.judgment_failed,baseline_total:counts.baseline,new_publication_total:counts.new_publication,evidenced_change_total:counts.evidenced_change,unknown_freshness_total:counts.unknown_freshness,changes_total:counts.changes,last_outcome,last_new_items:checks.length?created:null,last_new_changes:checks.length?changed:null,last_checked_at:latestAt===null?null:new Date(latestAt).toISOString(),last_success_at:lastSuccess,next_check_at:schedule?.status==='active'&&schedule.next_run_at?new Date(schedule.next_run_at).toISOString():null}};
}
