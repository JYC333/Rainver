import {HttpError,type Queryable,type SpaceUserIdentity} from '../routeUtils/common.js';
import {assertProjectReadable,assertProjectWriterForMutation} from '../projects/access.js';
import {lockReadingMutations} from '../sources/readingMutationAccess.js';
import {digestPeriod,digestTimezone,isCompleteDigestDay} from './digestPeriod.js';
import {PgInformationDigestRepository} from './repository.js';
import {assertDate} from './service.js';
import {PgInterestProfileRepository} from '../interestProfile/repository.js';
import {InterestProfileService} from '../interestProfile/service.js';
import {sha256} from './briefing/contract.js';

export interface BackfillTarget {space_id:string;date:string;project_id?:string}
/** The native digest reads deterministic Source/profile facts, never an LLM.
 * Discover all fact-layer inputs too; the requested day's ranking alone is
 * not the complete effect closure of personal backfill. */
export async function lockDigestBackfill(db:Queryable,identity:SpaceUserIdentity,target:BackfillTarget){
  const {spaceId:space,userId:user}=identity;
  if(target.space_id!==space)throw new HttpError(404,'Digest not found');
  try{assertDate(target.date);}catch{throw new HttpError(422,'Invalid digest date',{code:'digest_invalid_date'});}
  const discover=async()=>{
    const ids=(await db.query<{id:string}>(target.project_id?`SELECT DISTINCT i.id FROM source_items i WHERE i.space_id=$1 AND (
      i.id IN (SELECT COALESCE(c.source_item_id,s.source_item_id) FROM project_corpus_items c LEFT JOIN project_corpus_item_sources s ON s.space_id=c.space_id AND s.corpus_item_id=c.id WHERE c.space_id=$1 AND c.project_id=$2)
      OR i.id IN (SELECT source_item_id FROM project_source_item_links WHERE space_id=$1 AND project_id=$2)) ORDER BY i.id`:
      `SELECT DISTINCT i.id FROM source_items i WHERE i.space_id=$1 AND (i.owner_user_id=$2 OR EXISTS (
        SELECT 1 FROM source_channel_item_links l JOIN source_channel_user_subscriptions s ON s.space_id=l.space_id AND s.source_channel_id=l.source_channel_id
        WHERE l.space_id=i.space_id AND l.source_item_id=i.id AND s.user_id=$2 AND s.status='subscribed')) ORDER BY i.id`,[space,target.project_id??user])).rows.map(r=>r.id);
    const rows=async(table:string,predicate='id=ANY($2::varchar[])',values:unknown[]=[space,ids])=>(await db.query(`SELECT * FROM ${table} WHERE space_id=$1 AND ${predicate} ORDER BY id`,values)).rows;
    const items=await rows('source_items');
    const annotations=await rows('source_item_annotations','source_item_id=ANY($2::varchar[])');
    const channels=await rows('source_channel_item_links','source_item_id=ANY($2::varchar[])');
    const states=target.project_id?[]:await rows('source_item_user_states','source_item_id=ANY($2::varchar[]) AND user_id=$3',[space,ids,user]);
    const automations=await rows('automations',"status<>'archived' AND config_json->>'target_type'='information_digest' AND COALESCE(config_json->>'operation','daily')='daily' AND config_json->>'scope'=$2 AND (($2='personal' AND owner_user_id=$3) OR ($2='project' AND project_id=$3))",[space,target.project_id?'project':'personal',target.project_id??user]);
    const scope=target.project_id?{type:'project' as const,projectId:target.project_id}:{type:'personal' as const,userId:user};
    const timezone=await digestTimezone(db,space,scope);
    const period=digestPeriod(target.date,timezone),repo=new PgInformationDigestRepository(db);
    const candidates=target.project_id?await repo.projectCandidates(space,target.project_id,period):await repo.personalCandidates(space,user,period);
    const connections=await rows('source_connections','id=ANY($2::varchar[])',[space,[...new Set(items.map(r=>r.connection_id).filter(Boolean))].sort()]);
    const profile=target.project_id?{}:(await db.query('SELECT settings_json FROM interest_profiles WHERE space_id=$1 AND user_id=$2',[space,user])).rows[0]?.settings_json??{};
    const topics=target.project_id?[]:(await db.query('SELECT id,topic_key,label,domain_key,aliases_json,weight,status,origin FROM interest_topics WHERE space_id=$1 AND user_id=$2 ORDER BY id',[space,user])).rows;
    const operations=target.project_id?await rows('project_operations','project_id=$2',[space,target.project_id]):[];
    const monitoring=target.project_id?await rows('project_information_monitoring_versions','project_id=$2',[space,target.project_id]):[];
    const decisions=target.project_id?await rows('source_post_processing_item_decisions','source_item_id=ANY($2::varchar[])'):[];
    return {ids,items,annotations,channels,states,automations,timezone,candidates,connections,profile,topics,operations,monitoring,decisions};
  };
  const before=await discover();
  await lockReadingMutations(db,identity,before.ids,target.project_id?[target.project_id]:[]);
  if(target.project_id){await assertProjectReadable(db,space,target.project_id,user);await assertProjectWriterForMutation(db,space,target.project_id,user);}
  for(const [table,ids] of [['source_item_annotations',before.annotations.map(r=>r.id)],['source_channel_item_links',before.channels.map(r=>r.id)],['source_item_user_states',before.states.map(r=>r.id)],['automations',before.automations.map(r=>r.id)],['project_operations',before.operations.map(r=>r.id)],['project_information_monitoring_versions',before.monitoring.map(r=>r.id)],['source_post_processing_item_decisions',before.decisions.map(r=>r.id)]] as const){
    if(ids.length)await db.query(`SELECT id FROM ${table} WHERE space_id=$1 AND id=ANY($2::varchar[]) ORDER BY id FOR SHARE`,[space,ids]);
  }
  if(!target.project_id)await new InterestProfileService(db).mutate(space,user,async()=>{
    const profile=await new PgInterestProfileRepository(db).ensureProfile(space,user);
    await db.query('SELECT pg_advisory_xact_lock(hashtext($1))',[`interest_profile_fact_layer:${profile.id}`]);
    await db.query('SELECT id FROM interest_profiles WHERE space_id=$1 AND user_id=$2 ORDER BY id FOR SHARE',[space,user]);
    await db.query('SELECT id FROM interest_topics WHERE space_id=$1 AND user_id=$2 ORDER BY id FOR SHARE',[space,user]);
  });
  const hash=sha256(before);
  const recheck=async()=>{if(sha256(await discover())!==hash)throw new HttpError(409,'Digest inputs changed',{code:'digest_inputs_changed'});};
  await recheck();
  if(!isCompleteDigestDay(target.date,before.timezone))throw new HttpError(422,'Only a complete day can be backfilled',{code:'digest_day_not_complete'});
  return {hash,recheck};
}
