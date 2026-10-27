import {CustomSourceHandlerOutputSchema,SourcePolicyEnvelopeSchema} from '@rainver/protocol';
import type {ServerConfig} from '../../../config.js';
import {HttpError,withDbTransaction,type Pool} from '../../routeUtils/common.js';
import {CustomSourceMaterializationService} from '../customSources/customSourceMaterializer.js';
import {PgCustomSourceHandlerRepository} from '../customSources/customSourceHandlerRepository.js';
import {requireGoal,requireGoalSource,goalSourceFingerprint,type GoalRow} from './access.js';
import type {GoalExecutionResult} from './service.js';
import type {GoalBindingRow} from './worker.js';
/** The canonical Source materializer is the only item writer. The business
 * cursor commits with accepted material; no retry rewrites successful history. */
export async function materializeGoalBatch(db:Pool,config:ServerConfig,g:GoalRow,b:GoalBindingRow,token:string,runId:string,run:GoalExecutionResult,history=false){
 const identity={spaceId:g.space_id,userId:g.owner_user_id};const output=CustomSourceHandlerOutputSchema.parse(run.output);
 return withDbTransaction(db,async tx=>{
  const locked=await tx.query(`SELECT id FROM source_goal_bindings WHERE id=$1 AND lease_token=$2 AND lease_until>now() AND revision=$3 FOR UPDATE`,[b.id,token,b.revision]);if(!locked.rows[0])throw new HttpError(409,'Execution lease changed');
  const goal=await requireGoal(tx,identity,g.id,true);if(goal.status!=='running' || goal.active_version_id!==g.active_version_id)throw new Error('source_authority_revoked');
  const live=await requireGoalSource(tx,config,identity,goal,b.spec_json);if(b.fixture_json?.authority_sha256 && b.fixture_json.authority_sha256!==goalSourceFingerprint(live))throw new Error('source_authority_revoked');
  const known=await tx.query<{source_external_id:string;source_uri:string|null}>(`SELECT source_external_id,source_uri FROM source_items WHERE space_id=$1 AND connection_id=$2 AND (source_external_id=ANY($3::varchar[]) OR source_uri=ANY($4::text[]))`,[g.space_id,live.id,output.items.map(i=>i.external_id),output.items.map(i=>i.source_uri)]);
  const ids=new Set(known.rows.map(i=>i.source_external_id));const urls=new Set(known.rows.map(i=>i.source_uri));const fresh={...output,items:output.items.filter(i=>!ids.has(i.external_id)&&!urls.has(i.source_uri))};
  const settings=await new PgCustomSourceHandlerRepository(tx,config).getEffectiveSettings(identity);
  const result=await new CustomSourceMaterializationService(tx,config,settings.runner).materialize({run:{runId,spaceId:g.space_id,sourceConnectionId:live.id,handlerVersionId:g.active_version_id!,goal:{id:g.id,bindingId:b.id,bindingRevision:b.revision,implementationSha256:b.spec_json.implementation.kind==='isolated'?b.spec_json.implementation.sha256:null}},policyEnvelope:SourcePolicyEnvelopeSchema.parse(run.envelope),sandboxFilesRoot:run.filesRoot,rawOutputJson:fresh,recordHandlerRun:false,sourceKind:'source_goal'});
  if(result.status!=='succeeded')throw new Error('source_materialization_failed');
  const times=[b.cursor_json.watermark,b.cursor_json.pending_watermark,...output.items.map(i=>i.published_at)].filter((t):t is string=>typeof t==='string'&&Number.isFinite(Date.parse(t))).sort((a,b)=>Date.parse(a)-Date.parse(b));
  const {watermark:untrusted,pending_watermark:untrustedPending,...continuation}=run.cursor;
  const cursor=Number(run.cursor.remaining_count)>0 || run.cursor.unrecoverable_remainder===true?{...continuation,...(b.cursor_json.watermark?{watermark:b.cursor_json.watermark}:{}),pending_watermark:times.at(-1)??null}:{...continuation,...(times.length?{watermark:times.at(-1)}:{})};
  if(run.cursor.unrecoverable_remainder===true)await tx.query(`UPDATE source_goal_bindings SET gaps_json=gaps_json || $2::jsonb WHERE id=$1 AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(gaps_json) gap WHERE gap->>'reason'='source_recipe_truncated' AND gap->>'revision'=$3)`,[b.id,JSON.stringify([{from:{watermark:b.cursor_json.watermark??null},at:new Date().toISOString(),status:'unrecoverable',reason:'source_recipe_truncated',recoverable:false,revision:String(b.revision)}]),String(b.revision)]);
  if(!history)await tx.query(`UPDATE source_goal_bindings SET cursor_json=$3,status='active',failures=0,last_success_at=now(),retry_at=NULL,updated_at=now() WHERE id=$1 AND lease_token=$2`,[b.id,token,cursor]);
  return {...result,cursor:history?b.cursor_json:cursor};
 });
}
