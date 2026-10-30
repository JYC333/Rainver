import {agentReadingPolicy} from '../materialProcessing/policy.js';
import {SourceMaterialSubmissionSchema} from '@rainver/protocol';
import type {SourceConnectionRow} from '../sourceRepositoryRows.js';
import {CustomSourceHandlerOutputSchema} from '@rainver/protocol';
import type {ServerConfig} from '../../../config.js';
import type {Queryable} from '../../routeUtils/common.js';
import {normalizeSourceConnectionReadGovernance} from '../sourceConsent.js';
import {applyCustomSourceRetentionPolicy} from '../customSources/customSourceMaterializer.js';
import {goalResponseDiagnostic} from './diagnostics.js';
/** Raw response calibration needs original-archive permission. Its lifetime is
 * bounded by the existing custom Source retention setting, never an exception
 * to connection/envelope policy. All copies carry the same expiry. */
export async function retainGoalSample(db:Queryable,config:ServerConfig,connectionId:string,sample:Record<string,unknown>,forceRemove=false):Promise<Record<string,unknown>>{
 const c=(await db.query<SourceConnectionRow>('SELECT * FROM source_connections WHERE id=$1',[connectionId])).rows[0];
 const policy=c?normalizeSourceConnectionReadGovernance(c).policy.retention_policy:'metadata_only';
 const envelopeRetention=typeof sample.retention_policy==='string'?sample.retention_policy:policy;
 const allowed=!forceRemove && config.customSourceArtifactRetentionEnabled && c?.capture_policy==='archive_original' && ['full_snapshot','archived'].includes(policy) && ['full_snapshot','archived'].includes(envelopeRetention) && sample.capture_policy==='archive_original';
 const expires=typeof sample.sample_expires_at==='string'?sample.sample_expires_at:new Date(Date.now()+config.customSourceArtifactRetentionDays*86400000).toISOString();
 const keep=allowed && Number.isFinite(Date.parse(expires)) && Date.parse(expires)>Date.now();
 const ranks=['metadata_only','summary_only','full_text','full_snapshot','archived'];
 const outputRetention=!forceRemove && config.customSourceArtifactRetentionEnabled && Date.parse(expires)>Date.now()?ranks[Math.max(0,Math.min(ranks.indexOf(policy),ranks.indexOf(envelopeRetention),c?.capture_policy==='archive_original'?4:c?.capture_policy==='extract_text'?2:0))]:'metadata_only';
 const {fixture,previous,failure,output,...rest}=sample;
 const parsed=CustomSourceHandlerOutputSchema.safeParse(output);
 const responses=(fixture as {responses?:import('@rainver/protocol').SourceResponse[]}|undefined)?.responses;
 const bounded=Buffer.byteLength(JSON.stringify(fixture??null))<=1500000;
 return {...rest,sample_expires_at:expires,...(parsed.success?{output:keep?applyCustomSourceRetentionPolicy(parsed.data,envelopeRetention):{...applyCustomSourceRetentionPolicy(parsed.data,outputRetention),cursor:null,diagnostics:{warnings:[]}}} : {}),...(keep && bounded && fixture?{fixture}:{}),...(responses?{responses:responses.map(goalResponseDiagnostic)}:{}),...(previous&&typeof previous==='object'?{previous:await retainGoalSample(db,config,connectionId,previous as Record<string,unknown>,forceRemove)}:{}),...(failure&&typeof failure==='object'?{failure:await retainGoalSample(db,config,connectionId,failure as Record<string,unknown>,forceRemove)}:{})};
}
/** Called by existing Source artifact maintenance as well as before sample use.
 * A policy downgrade, expiry or goal deletion scrubs every stored duplicate. */
export async function cleanGoalSamples(db:Queryable,config:ServerConfig,goalId?:string,forceRemove=false){
 const bindings=await db.query<{id:string;source_connection_id:string;fixture_json:Record<string,unknown>;status:string}>(`SELECT b.id,b.source_connection_id,b.fixture_json,g.status FROM source_goal_bindings b JOIN source_goals g ON g.id=b.goal_id WHERE ($1::varchar IS NULL OR g.id=$1)`,[goalId??null]);
 for(const b of bindings.rows){const next=await retainGoalSample(db,config,b.source_connection_id,b.fixture_json??{},forceRemove||b.status==='deleted');if(JSON.stringify(next)!==JSON.stringify(b.fixture_json))await db.query('UPDATE source_goal_bindings SET fixture_json=$2 WHERE id=$1 AND fixture_json=$3::jsonb AND fixture_json IS DISTINCT FROM $2::jsonb',[b.id,next,b.fixture_json]);}
 const previews=await db.query<{id:string;result_json:{contributions?:Record<string,unknown>[]};status:string}>(`SELECT p.id,p.result_json,g.status FROM source_goal_previews p JOIN source_goals g ON g.id=p.goal_id WHERE ($1::varchar IS NULL OR g.id=$1)`,[goalId??null]);
 for(const p of previews.rows){const next={...p.result_json,contributions:await Promise.all((p.result_json.contributions??[]).map((c:Record<string,unknown>)=>retainGoalSample(db,config,String(c.source_connection_id),c,forceRemove||p.status==='deleted')))};if(JSON.stringify(next)!==JSON.stringify(p.result_json))await db.query('UPDATE source_goal_previews SET result_json=$2 WHERE id=$1 AND result_json=$3::jsonb AND result_json IS DISTINCT FROM $2::jsonb',[p.id,next,p.result_json]);}
 // Collection submissions are transport/recovery inputs, not an unlimited body archive.
 const collections=await db.query<{id:string;status:string;goal_status:string;result_json:Record<string,unknown>;capture_policy:SourceConnectionRow['capture_policy'];policy_json:SourceConnectionRow['policy_json']}>(`SELECT r.id,r.status,g.status AS goal_status,r.result_json,c.capture_policy,c.policy_json FROM source_goal_runs r JOIN source_goals g ON g.id=r.goal_id AND g.space_id=r.space_id JOIN source_connections c ON c.id=r.result_json->'spec'->>'source_connection_id' AND c.space_id=r.space_id WHERE ($1::varchar IS NULL OR g.id=$1) AND (r.result_json ? 'search_submission' OR r.result_json ? 'accepted_output')`,[goalId??null]);
 for(const row of collections.rows){
  const policy=agentReadingPolicy(row);const next={...row.result_json};const erase=forceRemove||row.goal_status==='deleted';
  if(!['queued','accepted','materializing'].includes(row.status)){delete next.search_submission;delete next.accepted_output;}
  else {
   const submission=SourceMaterialSubmissionSchema.safeParse(next.search_submission);
   if(submission.success)next.search_submission={...submission.data,items:submission.data.items.map(item=>({...item,summary:!erase&&policy.summary?item.summary:null,content:!erase&&policy.content?item.content:null}))};
   const output=CustomSourceHandlerOutputSchema.safeParse(next.accepted_output);
   if(output.success){const retained=applyCustomSourceRetentionPolicy(output.data,erase?'metadata_only':policy.retention);next.accepted_output=retained;}
  }
  if(JSON.stringify(next)!==JSON.stringify(row.result_json))await db.query('UPDATE source_goal_runs SET result_json=$2 WHERE id=$1 AND result_json=$3::jsonb',[row.id,next,row.result_json]);
 }
 const repairs=await db.query<{id:string;validation_json:{live_sample?:Record<string,unknown>};source_connection_id:string;status:string}>(`SELECT r.id,r.validation_json,b.source_connection_id,g.status FROM source_goal_repairs r JOIN source_goal_bindings b ON b.id=r.binding_id JOIN source_goals g ON g.id=b.goal_id WHERE ($1::varchar IS NULL OR g.id=$1)`,[goalId??null]);
 for(const r of repairs.rows){if(!r.validation_json?.live_sample)continue;const next={...r.validation_json,live_sample:await retainGoalSample(db,config,r.source_connection_id,r.validation_json.live_sample,forceRemove||r.status==='deleted')};if(JSON.stringify(next)!==JSON.stringify(r.validation_json))await db.query('UPDATE source_goal_repairs SET validation_json=$2 WHERE id=$1 AND validation_json=$3::jsonb AND validation_json IS DISTINCT FROM $2::jsonb',[r.id,next,r.validation_json]);}
}
