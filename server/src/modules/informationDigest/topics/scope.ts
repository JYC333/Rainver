import {goalPresentationTitleSql} from '../../sources/index.js';
import type {ThemeGoal} from './types.js';
import type {SourceGoalPlan} from '@rainver/protocol';
import type {Queryable} from '../../routeUtils/common.js';
import {projectBriefingScope} from '../briefing/projectScope.js';
import {hydrateCandidates,liveScopeMembers,readableCollecting,collectingKey,type CandidateSignal} from '../briefing/candidates.js';
import {contextSourceKey,sha256,type BriefingScopeAdapter,type BriefingContextEntry} from '../briefing/contract.js';
import {sharedOriginalVersions} from '../../sources/index.js';
import {freezeReadingMethod} from '../../prompts/index.js';
import {HttpError} from '../../routeUtils/common.js';
export const TOPIC_METHOD='reading.following_synthesis';
export const topicKey=(id:string)=>`following:${id}`;
export const goalOfKey=(key:string)=>key.startsWith('following:')?key.slice(10):null;
/** One Following is a real scope of the existing manifest/authorization kernel.
 * No private annotation or report is admitted as source evidence. */
export function topicScope(spaceId:string,projectId:string,goalId:string,frozenVersion?:string,frozenContext?:BriefingContextEntry[]):BriefingScopeAdapter{
 const base=projectBriefingScope(spaceId,projectId);
 const goal=async(db:Queryable)=>(await db.query<ThemeGoal>(`SELECT * FROM source_goals WHERE space_id=$1 AND project_id=$2 AND id=$3 AND status<>'deleted'`,[spaceId,projectId,goalId])).rows[0];
 const signals=async(db:Queryable,cutoff:string,terminalOnly=true):Promise<CandidateSignal[]>=> (await db.query<CandidateSignal>(`SELECT gi.source_item_id,'following' AS lens_kind,${goalPresentationTitleSql("g", "COALESCE($6::varchar, g.active_version_id, g.current_version_id)")} AS lens_label,gi.selection_reason AS signal,gi.associated_at::text AS activity_at,NULL::text AS change_at,'goal_item' AS analysis_kind,gi.id AS analysis_id,gi.source_connection_id AS connection_id FROM source_goal_items gi JOIN source_goals g ON g.id=gi.goal_id AND g.space_id=gi.space_id WHERE gi.space_id=$1 AND gi.goal_id=$2 AND g.project_id=$3 AND g.status<>'deleted' AND gi.selection_status<>'not_selected' AND ($5::boolean=false OR EXISTS(SELECT 1 FROM source_goal_runs done WHERE done.id=gi.last_goal_run_id AND done.space_id=gi.space_id AND done.status IN ('succeeded','insufficient'))) AND gi.associated_at<=$4 ORDER BY gi.associated_at,gi.id`,[spaceId,goalId,projectId,cutoff,terminalOnly,frozenVersion??null])).rows;
 return {...base,scope:{...base.scope,key:topicKey(goalId)},retainedEgress:true,
  async canRead(db,user){return !!await goal(db)&&await base.canRead(db,user);},
  async canGenerate(db,user){const g=await goal(db),a=g?.compatibility_json?.theme_analysis;return !!g&&g.status==='running'&&g.owner_user_id===user&&a?.enabled===true&&a.version_id===g.active_version_id&&(!frozenVersion||g.active_version_id===frozenVersion)&&await base.canGenerate(db,user);},
  async candidates(db,window){
   const audience=await base.audience(db),offered=await hydrateCandidates(db,spaceId,audience,await signals(db,window.cutoff));
   const collecting=await readableCollecting(db,spaceId,audience,offered.rows.flatMap(r=>r.signals.map(s=>s.dep)));
   const shareable=offered.rows.filter(r=>r.signals.every(s=>collecting.has(collectingKey(s.dep))));
   const originals=await sharedOriginalVersions(db,spaceId,audience,{itemIds:shareable.map(r=>r.source_item_id),cutoff:window.cutoff,includeText:false});const byId=new Map(originals.map(r=>[r.item_id,r]));
   return {...offered,not_shared_ids:[...offered.not_shared_ids,...offered.rows.filter(r=>!shareable.includes(r)).map(r=>r.source_item_id)],rows:shareable.map(row=>{const original=byId.get(row.source_item_id);return {...row,summary:null,excerpt:null,annotation:null,unverified:false,signals:row.signals.map(s=>({...s,text:null})),...(original?{original:{...original,text:original.plain_text,uri:original.source_uri},content_revision:`${original.content_hash}:${original.snapshot_id}`}:{})};})};
  },
  async loadOriginals(db,rows){
   const originals=await sharedOriginalVersions(db,spaceId,await base.audience(db),{snapshotIds:rows.flatMap(r=>r.original?[r.original.snapshot_id]:[])});const byId=new Map(originals.map(o=>[o.snapshot_id,o]));
   for(const r of rows)if(r.original){const o=byId.get(r.original.snapshot_id);if(!o||o.content_hash!==r.original.content_hash)throw new HttpError(403,'Retained original unavailable');r.original.text=o.plain_text;}
  },
  async scopeMembers(db,ids,cutoff){return liveScopeMembers(db,spaceId,(await signals(db,cutoff,false)).filter(s=>ids.includes(s.source_item_id)));},
  async context(db){
   if(frozenContext)return structuredClone(frozenContext);
   const g=await goal(db);if(!g?.active_version_id)throw new HttpError(409,'Following has no active purpose');
   const v=(await db.query<{plan_json:SourceGoalPlan}>('SELECT plan_json FROM source_goal_versions WHERE space_id=$1 AND goal_id=$2 AND id=$3',[spaceId,goalId,g.active_version_id])).rows[0];
   const method=await freezeReadingMethod(db,{spaceId,userId:g.owner_user_id,projectId},{goal_id:goalId,version_id:g.active_version_id},TOPIC_METHOD);
   if(!method.frozen.content_hash||!method.text||method.text.length>4000)throw new HttpError(409,'Initialize an approved theme strategy of at most 4000 characters',{code:'theme_method_invalid'});
   const purpose=JSON.stringify({intent:v?.plan_json?.intent_snapshot?.intent??g.intent_json.intent,analysis_brief:v?.plan_json?.analysis_brief??null});
   return [...await base.context(db),{kind:'following_purpose' as const,label:'Confirmed Following purpose',text:purpose,source:{type:'goal_version' as const,id:g.active_version_id,revision:sha256(v?.plan_json)}},{kind:'following_method' as const,label:'Approved theme synthesis strategy',text:method.text,source:{type:'prompt_version' as const,id:method.frozen.version_id,revision:method.frozen.content_hash!,provenance:{...method.frozen}}}];
  },
  async contextState(db,sources){
   const ordinary=sources.filter(s=>!['goal_version','prompt_version'].includes(s.type));const state=await base.contextState(db,ordinary),g=await goal(db);
   for(const s of sources){if(s.type==='goal_version'){
    const v=(await db.query<{plan_json:SourceGoalPlan}>('SELECT plan_json FROM source_goal_versions WHERE space_id=$1 AND goal_id=$2 AND id=$3',[spaceId,goalId,s.id])).rows[0];
    if(g&&v&&sha256(v.plan_json)===s.revision)state.allowed.add(contextSourceKey(s));if(g?.active_version_id!==s.id)state.outdated=true;
   }else if(s.type==='prompt_version'){
    const v=(await db.query('SELECT v.content_hash FROM evolvable_asset_versions v JOIN evolvable_assets a ON a.id=v.asset_id WHERE v.id=$1 AND a.asset_key=$2 AND a.status=\'active\'',[s.id,TOPIC_METHOD])).rows[0];if(g&&v?.content_hash===s.revision)state.allowed.add(contextSourceKey(s));
   }}return state;
  },
 };
}
