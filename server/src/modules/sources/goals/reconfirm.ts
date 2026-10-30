import type {ServerConfig} from '../../../config.js';
import type {SourceGoalBindingSpec} from '@rainver/protocol';
import {SourceGoalPlanSchema} from '@rainver/protocol';
import {HttpError,withDbTransaction,type Pool,type Queryable,type SpaceUserIdentity} from '../../routeUtils/common.js';
import {activeGoalIntent,goalSourceFingerprint,goalSourceScope,requireGoal,type GoalRow,type GoalSourceScope} from './access.js';
import {preflightGoalSource} from './preflight.js';
import {sourceGoalError} from './dispatchError.js';

/**
 * Re-confirming one goal binding after its Source changed.
 *
 * A binding is authorized against a fingerprint of its Source and channel
 * (scope, consent, policy, credential, configuration). When any of that
 * changes — for example an accepted "allow saving full text" proposal for the
 * same Source — collection refuses with `source_authority_revoked` and the
 * binding pauses. Nothing re-authorizes it by itself. Its owner can look at the
 * Source as it is now (and, for bindings confirmed since scopes were
 * recorded, at what changed) and confirm that exact state: the request names
 * the binding revision and the fingerprint shown, the server re-runs every gate
 * of activation for that Source under the goal, binding and Source locks, and only then records the
 * new authority. Anything else that changed meanwhile is refused (409).
 */

/** Binding failures this confirmation can resolve: the Source's authorized state changed. */
const CHANGED=new Set(['source_authority_revoked','source_scope_changed']);

type BindingRow={id:string;goal_id:string;source_connection_id:string;spec_json:SourceGoalBindingSpec;status:string;revision:number;lease_token:string|null;last_success_at:string|null;
 fixture_json:{authority_sha256?:string;authority_scope?:GoalSourceScope;confirmed_at?:string;collection_error?:string;repair_block_reason?:string}|null};

/** Keys of a recorded scope whose value is no longer the same. */
function changedKeys(before:GoalSourceScope|undefined,now:GoalSourceScope):(keyof GoalSourceScope)[]|null{
 if(!before)return null;
 return (Object.keys(now) as (keyof GoalSourceScope)[]).filter(key=>JSON.stringify(before[key])!==JSON.stringify(now[key]));
}

async function activeSources(db:Queryable,g:GoalRow):Promise<Set<string>>{
 if(!g.active_version_id)return new Set();
 const v=(await db.query<{plan_json:unknown}>('SELECT plan_json FROM source_goal_versions WHERE id=$1 AND goal_id=$2',[g.active_version_id,g.id])).rows[0];
 return new Set(v?SourceGoalPlanSchema.parse(v.plan_json).sources.map(s=>s.source_connection_id):[]);
}

/**
 * Whether a binding is stopped because its Source's authorized state changed.
 * Agent-search collection records the refusal on the binding; connector
 * collection only on its run, so the latest run since the last confirmation
 * counts too (the same reading as the follow-state projection).
 */
export async function sourceChangeBlocked(db:Queryable,b:Pick<BindingRow,'id'|'status'|'fixture_json'>):Promise<boolean>{
 if(b.status!=='paused')return false;
 const own=b.fixture_json?.collection_error??b.fixture_json?.repair_block_reason;
 if(own)return CHANGED.has(own);
 const last=(await db.query<{status:string;error:string|null;ended_at:Date|null}>(`SELECT status,result_json->>'error' AS error,COALESCE(ended_at,started_at) AS ended_at FROM source_goal_runs WHERE binding_id=$1 ORDER BY COALESCE(ended_at,started_at) DESC LIMIT 1`,[b.id])).rows[0];
 if(!last||last.status==='succeeded'||last.status==='insufficient'||!last.error)return false;
 const confirmed=b.fixture_json?.confirmed_at;
 if(confirmed&&last.ended_at&&Date.parse(confirmed)>new Date(last.ended_at).getTime())return false;
 return CHANGED.has(last.error);
}

export interface BindingReconfirmation{
 binding_id:string;binding_revision:number;
 /** `you`: the viewer can confirm. `topic_owner`: only the topic's owner can. `source_access`: the topic owner may not use this Source as it is now (its owner or access changed). `not_needed`: nothing to confirm. */
 resolvable_by:'you'|'topic_owner'|'source_access'|'not_needed';
 source_name:string|null;
 /** The Source as it is now (what confirming accepts); null when it cannot be shown to the viewer. */
 current:Pick<GoalSourceScope,'capture_policy'|'retention_policy'|'source_status'|'channel_status'|'uses_credential'>|null;
 /** What changed since the binding was confirmed, when the confirmed scope was recorded; null for bindings confirmed before that. */
 changed:string[]|null;
 /** Decisions recorded on this Source since its last successful collection (e.g. allowing full text to be saved). */
 related_changes:{kind:string;at:string}[];
 /** Opaque token of the state shown; confirming requires the same. */
 authority:string|null;
}

export async function readBindingReconfirmation(db:Queryable,config:ServerConfig,identity:SpaceUserIdentity,goalId:string,bindingId:string):Promise<BindingReconfirmation>{
 const g=await requireGoal(db,identity,goalId);
 const b=(await db.query<BindingRow>('SELECT id,goal_id,source_connection_id,spec_json,status,revision,lease_token,last_success_at::text,fixture_json FROM source_goal_bindings WHERE id=$1 AND goal_id=$2 AND space_id=$3',[bindingId,goalId,identity.spaceId])).rows[0];
 if(!b)throw new HttpError(404,'Binding not found');
 const empty={binding_id:b.id,binding_revision:b.revision,source_name:null,current:null,changed:null,related_changes:[],authority:null};
 if(!(await sourceChangeBlocked(db,b))||!(await activeSources(db,g)).has(b.source_connection_id))return {...empty,resolvable_by:'not_needed'};
 if(g.owner_user_id!==identity.userId)return {...empty,resolvable_by:'topic_owner'};
 // Every gate of activation, as the owner, for the Source as it is now.
 let c;
 try{c=await preflightGoalSource(db,config,identity,await activeGoalIntent(db,g),b.spec_json);}
 catch(error){if(error instanceof HttpError&&[403,404,409].includes(error.statusCode)||error instanceof Error&&/^source_[a-z_]+$/.test(error.message))return {...empty,resolvable_by:'source_access'};throw error;}
 const scope=goalSourceScope(c);
 const related=await db.query<{proposal_type:string;at:string}>(`SELECT proposal_type,COALESCE(reviewed_at,updated_at)::text AS at FROM proposals WHERE space_id=$1 AND status='accepted' AND payload_json->>'source_connection_id'=$2 AND COALESCE(reviewed_at,updated_at)>COALESCE($3::timestamptz,'-infinity'::timestamptz) ORDER BY COALESCE(reviewed_at,updated_at) LIMIT 10`,[identity.spaceId,b.source_connection_id,b.fixture_json?.confirmed_at&&b.last_success_at?(b.fixture_json.confirmed_at>b.last_success_at?b.fixture_json.confirmed_at:b.last_success_at):b.fixture_json?.confirmed_at??b.last_success_at]);
 return {binding_id:b.id,binding_revision:b.revision,resolvable_by:'you',source_name:c.name,
  current:{capture_policy:scope.capture_policy,retention_policy:scope.retention_policy,source_status:scope.source_status,channel_status:scope.channel_status,uses_credential:scope.uses_credential},
  changed:changedKeys(b.fixture_json?.authority_scope,scope),related_changes:related.rows.map(r=>({kind:r.proposal_type,at:new Date(r.at).toISOString()})),authority:goalSourceFingerprint(c)};
}

/**
 * The rows the binding's fingerprint is computed from (`goalSourceRow`): the
 * Source, its channel and the channel's search spec. Held FOR SHARE until the
 * confirmation commits, so no Source write can change them between the
 * fingerprint check and the binding update; a write already waiting commits
 * afterwards and is then an ordinary later change (the next collection refuses
 * it). Lock order: goal, binding, then Source, channel, search spec — the same
 * goal-before-Source order as repair admission (`agent.ts`); Source writers do
 * not lock goal rows.
 */
async function lockSourceAuthority(tx:Queryable,spaceId:string,spec:SourceGoalBindingSpec){
 await tx.query('SELECT id FROM source_connections WHERE id=$1 AND space_id=$2 FOR SHARE',[spec.source_connection_id,spaceId]);
 await tx.query('SELECT id FROM source_channels WHERE id=$1 AND space_id=$2 FOR SHARE',[spec.source_channel_id,spaceId]);
 await tx.query('SELECT id FROM source_search_specs WHERE source_channel_id=$1 AND space_id=$2 FOR SHARE',[spec.source_channel_id,spaceId]);
}

/**
 * Confirms the Source state the owner was shown for one binding. Requires the
 * same binding revision and fingerprint, compared under the Source locks above;
 * repeats of a confirmation that already took effect return the binding as it is.
 */
export async function confirmBindingSource(db:Pool,config:ServerConfig,identity:SpaceUserIdentity,goalId:string,bindingId:string,input:{binding_revision:number;authority:string}){
 try{return await withDbTransaction(db,async tx=>{
  await tx.query('SELECT id FROM source_goals WHERE id=$1 AND space_id=$2 FOR UPDATE',[goalId,identity.spaceId]);
  const g=await requireGoal(tx,identity,goalId,true);
  const b=(await tx.query<BindingRow>('SELECT id,goal_id,source_connection_id,spec_json,status,revision,lease_token,last_success_at::text,fixture_json FROM source_goal_bindings WHERE id=$1 AND goal_id=$2 AND space_id=$3 FOR UPDATE',[bindingId,goalId,identity.spaceId])).rows[0];
  if(!b)throw new HttpError(404,'Binding not found');
  // The same confirmation, already applied (a retried request): nothing more to do.
  if(b.revision===input.binding_revision+1&&b.status!=='paused'&&b.fixture_json?.authority_sha256===input.authority)return {binding_id:b.id,binding_revision:b.revision,status:b.status};
  if(b.revision!==input.binding_revision)throw sourceGoalError(409,'source_binding_changed');
  if(!(await sourceChangeBlocked(tx,b)))throw sourceGoalError(409,'source_binding_not_blocked');
  if(b.lease_token)throw new HttpError(409,'Source execution in progress');
  if(g.status==='deleted'||!(await activeSources(tx,g)).has(b.source_connection_id))throw sourceGoalError(409,'source_binding_not_active');
  await lockSourceAuthority(tx,identity.spaceId,b.spec_json);
  // Every gate of activation, then the fingerprint, both read under those locks.
  const c=await preflightGoalSource(tx,config,identity,await activeGoalIntent(tx,g),b.spec_json);
  const now=goalSourceFingerprint(c);
  if(now!==input.authority)throw sourceGoalError(409,'source_scope_changed');
  const updated=(await tx.query<{revision:number;status:string}>(`UPDATE source_goal_bindings SET status='active',retry_at=NULL,failures=0,revision=revision+1,updated_at=now(),
     fixture_json=(COALESCE(fixture_json,'{}'::jsonb)-'collection_error'-'repair_block_reason')||$2::jsonb WHERE id=$1 RETURNING revision,status`,
   [b.id,{authority_sha256:now,authority_scope:goalSourceScope(c),confirmed_at:new Date().toISOString(),reconfirmed_by:identity.userId}])).rows[0];
  return {binding_id:b.id,binding_revision:updated.revision,status:updated.status};
 });}catch(error){
  // A Source write holding its rows in the opposite order: the Source is being changed now. Nothing was confirmed.
  if((error as {code?:string})?.code==='40P01')throw sourceGoalError(409,'source_scope_changed');
  throw error;
 }
}
