import {contentDecisionFromDb} from '../access/contentAccessQuery.js';
import {createHash} from 'node:crypto';
import {canonical} from '../systemActions/operations/repository.js';
import {HttpError,type Queryable} from '../routeUtils/common.js';
import {contentReadSql,contentOwnerFilterSql} from '../access/contentAccessSql.js';
import {lockSourceRetrievalRelease} from '../sources/retrievalReleaseLocks.js';
import {sourceConnectionIdsFromMetadata,loadSourcePolicySnapshots,sourcePolicyAllowsRead,loadViewerSpaceRole,sourceEgressPoliciesForSnapshots} from '../retrieval/sourcePolicy.js';
import {providerEgressDestination,retrievalEgressAllowed} from '../retrieval/egress/egressPolicy.js';
import {readSpaceRetrievalSettings} from '../retrieval/settings.js';
import {enforceSourceDerivedImportTarget} from '../sources/sourceConsent.js';
import {recordDetailRead} from '../contentAccess/audit.js';
import {localDayUtcBounds,isLocalDayComplete,localDateNow,previousLocalDate} from '../scheduler/localDay.js';
import {PgDailyReportSettingsRepository,assertValidLocalDate,assertValidTimezone} from './repository.js';
import type {OperationInput} from '@rainver/protocol';
export class DailyReportRefusal extends HttpError {}
export type DailyReportInput=OperationInput<'daily_capture.run'>;
export type Capture={id:string;title:string|null;content:string|null;payload_json:Record<string,unknown>;updated_at:string};
type SourceRef={source_type:'source_item'|'source_snapshot'|'extracted_evidence';source_id:string};
async function reportLineage(db:Queryable,space:string,ids:string[]):Promise<SourceRef[]>{return ids.length?(await db.query<SourceRef>(`SELECT source_type,source_id FROM provenance_links WHERE space_id=$1 AND target_type='activity' AND target_id=ANY($2::varchar[]) AND source_type=ANY($3::varchar[]) ORDER BY source_type,source_id`,[space,ids,['source_item','source_snapshot','extracted_evidence']])).rows:[];}
export type DailyReportSnapshot={version:1;lineage:SourceRef[];spaceId:string;userId:string;localDate:string;triggerOrigin:'manual'|'automation';setting:Awaited<ReturnType<PgDailyReportSettingsRepository['getOrCreate']>>;captures:Capture[];input:DailyReportInput};
export const reportFingerprint=(s:DailyReportSnapshot)=>createHash('sha256').update(canonical({...s,setting:{...s.setting,last_report_date:null,next_run_at:null,created_at:null}})).digest('hex');
export async function captureRows(db:Queryable,space:string,user:string,setting:DailyReportSnapshot['setting'],date:string,ids?:string[]){
 const bounds=localDayUtcBounds(date,setting.timezone);
 return (await db.query<Capture>(`SELECT id,title,content,payload_json,updated_at::text AS updated_at FROM activity_records ar WHERE ar.space_id=$1 AND ${contentReadSql('activity','ar','$2')} AND ${contentOwnerFilterSql('activity','ar','$2')} AND ar.activity_type=ANY($3::text[]) AND ar.status<>'archived' AND ar.occurred_at >=$4 AND ar.occurred_at <$5 ${ids?'AND ar.id=ANY($6::varchar[])':''} ORDER BY ar.occurred_at,ar.id`,[space,user,setting.include_source_types_json,bounds.startUtcIso,bounds.endUtcIso,...(ids?[ids]:[])])).rows;
}
export async function prepareDailyReport(db:Queryable,spaceId:string,userId:string,input:DailyReportInput,triggerOrigin:'manual'|'automation'='manual'){
 const setting=await new PgDailyReportSettingsRepository(db).getOrCreate(spaceId,userId);
 let localDate:string;
 try{assertValidTimezone(setting.timezone);localDate=input.local_date??previousLocalDate(localDateNow(setting.timezone));assertValidLocalDate(localDate);}
 catch(error){if(error instanceof HttpError)throw new DailyReportRefusal(error.statusCode,error.message,error.responseBody);throw error;}
 const calendar=new Date(localDate+'T00:00:00.000Z');
 if(Number.isNaN(calendar.getTime())||calendar.toISOString().slice(0,10)!==localDate)throw new DailyReportRefusal(422,'local_date must be a valid calendar date');
 if(!isLocalDayComplete(localDate,setting.timezone))throw new DailyReportRefusal(422,'Only a complete day can be reported',{code:'report_day_not_complete'});
 if(triggerOrigin==='automation'&&!setting.enabled)throw new DailyReportRefusal(403,'Daily report setting disabled');
 const captures=await captureRows(db,spaceId,userId,setting,localDate);
 const snapshot:DailyReportSnapshot={version:1,spaceId,userId,setting,localDate,triggerOrigin,input,captures,lineage:await reportLineage(db,spaceId,captures.map(c=>c.id))};
 await authorizeDailyReport(db,snapshot);return snapshot;
}
/** Discover the frozen inputs' complete provenance before taking global locks.
 * Only these inputs belong to this request; later captures belong to another report. */
export async function authorizeDailyReport(db:Queryable,s:DailyReportSnapshot,providerId?:string,model?:string|null){
 if(s.version!==1)throw new DailyReportRefusal(409,'Daily report version changed');
 const ids=s.captures.map(c=>c.id);
 const lineage=()=>reportLineage(db,s.spaceId,ids);
 const before=await lineage();
 if(canonical(before)!==canonical(s.lineage))throw new DailyReportRefusal(409,'Daily report provenance changed');
 const sourceIds=[...new Set(s.captures.flatMap(c=>sourceConnectionIdsFromMetadata(c.payload_json)))].sort();
 await db.query('SELECT pg_advisory_xact_lock(hashtext($1))',[`runtime-egress-settings:${s.spaceId}`]);
 await lockSourceRetrievalRelease(db,s.spaceId,s.userId,[...ids.map(object_id=>({object_type:'activity' as const,object_id})),...before.map(r=>({object_type:r.source_type,object_id:r.source_id})),...sourceIds.map(object_id=>({object_type:'source_connection' as const,object_id}))]);
 await db.query('SELECT id FROM settings WHERE id=$1 FOR SHARE',[s.setting.id]);
 if(ids.length)await db.query("SELECT id FROM provenance_links WHERE space_id=$1 AND target_type='activity' AND target_id=ANY($2::varchar[]) ORDER BY id FOR SHARE",[s.spaceId,ids]);
 if(canonical(before)!==canonical(await lineage()))throw new DailyReportRefusal(409,'Daily report provenance changed');
 const setting=await new PgDailyReportSettingsRepository(db).getById(s.spaceId,s.setting.id);
 if(!setting||setting.user_id!==s.userId||s.triggerOrigin==='automation'&&!setting.enabled)throw new DailyReportRefusal(403,'Daily report is no longer authorized');
 const current={...s,setting,captures:await captureRows(db,s.spaceId,s.userId,setting,s.localDate,ids)};
 if(reportFingerprint(current)!==reportFingerprint(s))throw new DailyReportRefusal(409,'Daily report inputs changed');
 // Resolve connection ids from the locked Source roots as well as capture metadata.
 const connections=(await db.query<{id:string}>(`SELECT DISTINCT connection_id AS id FROM (SELECT connection_id FROM source_items WHERE space_id=$1 AND id=ANY($2::varchar[]) UNION SELECT connection_id FROM source_snapshots WHERE space_id=$1 AND id=ANY($3::varchar[]) UNION SELECT COALESCE(si.connection_id,ss.connection_id) FROM extracted_evidence ee LEFT JOIN source_items si ON si.space_id=ee.space_id AND si.id=COALESCE(ee.source_item_id,ee.origin_source_item_id) LEFT JOIN source_snapshots ss ON ss.space_id=ee.space_id AND ss.id=ee.source_snapshot_id WHERE ee.space_id=$1 AND ee.id=ANY($4::varchar[])) refs WHERE connection_id IS NOT NULL`,[s.spaceId,before.filter(r=>r.source_type==='source_item').map(r=>r.source_id),before.filter(r=>r.source_type==='source_snapshot').map(r=>r.source_id),before.filter(r=>r.source_type==='extracted_evidence').map(r=>r.source_id)])).rows.map(r=>r.id);
 for(const ref of before)if(await contentDecisionFromDb(db,{spaceId:s.spaceId,userId:s.userId},ref.source_type,ref.source_id,{includeOversight:false})!=='full')throw new DailyReportRefusal(403,'Daily report source is no longer readable');
 const all=[...new Set([...sourceIds,...connections])].sort(),policies=await loadSourcePolicySnapshots(db,s.spaceId,all),role=await loadViewerSpaceRole(db,s.spaceId,s.userId);
 for(const id of all){const policy=policies.get(id);if(!policy||!sourcePolicyAllowsRead(policy,{viewerUserId:s.userId,viewerSpaceRole:role}))throw new DailyReportRefusal(403,'Source consent withdrawn');}
 const sourceRows=all.length?(await db.query<{policy_json:unknown}>('SELECT policy_json FROM source_connections WHERE space_id=$1 AND id=ANY($2::varchar[]) ORDER BY id',[s.spaceId,all])).rows:[];
 for(const r of sourceRows){enforceSourceDerivedImportTarget(r.policy_json,'source_artifact');if(s.input.create_memory_proposals??setting.create_memory_proposals)enforceSourceDerivedImportTarget(r.policy_json,'memory_proposal');if(s.input.create_experience_proposals??setting.create_experience_proposals)enforceSourceDerivedImportTarget(r.policy_json,'knowledge');}
 // Reports are person-private: the live audience is exactly the current owner.
 if(providerId){
  const provider=(await db.query<{space_id:string;provider_type:string;base_url:string|null;config_json:unknown;default_model:string|null}>('SELECT space_id,provider_type,base_url,config_json,default_model FROM model_providers WHERE id=$1 FOR SHARE',[providerId])).rows[0];
  if(!provider)throw new DailyReportRefusal(403,'Provider unavailable');
  const settings=await readSpaceRetrievalSettings(db,s.spaceId);
  if(!retrievalEgressAllowed({object_type:'activity',object_id:ids[0]??'',source_connection_ids:all},{destination:providerEgressDestination({...provider,model},s.spaceId),externalEgressEnabled:settings.externalEgressEnabled,sourcePolicies:sourceEgressPoliciesForSnapshots(policies)}))throw new DailyReportRefusal(403,'Daily report provider egress denied');
 }
 for(const id of ids)await recordDetailRead(db,{spaceId:s.spaceId,viewerUserId:s.userId,resourceType:'activity',resourceId:id});
 return current;
}
