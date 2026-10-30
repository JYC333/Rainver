import {validBusinessTime,safeBusinessCursor} from './watermark.js';
import {preflightGoalSource} from './preflight.js';
import {associateGoalItems} from './goalItems.js';
import {applyTopicJudgment} from './topicJudgment.js';
import {BASELINE_MAX_PAGES,upstreamContinuation} from './selection.js';
import {trustedSearchMetadataOrigins} from './validation.js';
import {CustomSourceHandlerOutputSchema,SourcePolicyEnvelopeSchema} from '@rainver/protocol';
import type {ServerConfig} from '../../../config.js';
import {HttpError,withDbTransaction,type Pool} from '../../routeUtils/common.js';
import {CustomSourceMaterializationService} from '../customSources/customSourceMaterializer.js';
import {PgCustomSourceHandlerRepository} from '../customSources/customSourceHandlerRepository.js';
import {requireGoal,activeGoalIntent,requireGoalSource,goalSourceFingerprint,type GoalRow} from './access.js';
import type {GoalExecutionResult} from './service.js';
import type {GoalBindingRow} from './worker.js';
/** The canonical Source materializer is the only item writer. The business
 * cursor commits with accepted material; no retry rewrites successful history. */
export async function materializeGoalBatch(db:Pool,config:ServerConfig,g:GoalRow,b:GoalBindingRow,token:string,runId:string,run:GoalExecutionResult,history=false){
 const identity={spaceId:g.space_id,userId:g.owner_user_id};const output=CustomSourceHandlerOutputSchema.parse(run.output);
 return withDbTransaction(db,async tx=>{
  const locked=await tx.query(`SELECT id FROM source_goal_bindings WHERE id=$1 AND lease_token=$2 AND lease_until>now() AND revision=$3 FOR UPDATE`,[b.id,token,b.revision]);if(!locked.rows[0])throw new HttpError(409,'Execution lease changed');
  const goal=await requireGoal(tx,identity,g.id,true);if(goal.status!=='running' || goal.active_version_id!==g.active_version_id)throw new Error('source_authority_revoked');
  const live=b.spec_json.implementation.kind==='agent_search'?await preflightGoalSource(tx,config,identity,await activeGoalIntent(tx,goal),b.spec_json):await requireGoalSource(tx,config,identity,await activeGoalIntent(tx,goal),b.spec_json);if(b.fixture_json?.authority_sha256 && b.fixture_json.authority_sha256!==goalSourceFingerprint(live))throw new Error('source_authority_revoked');
  const known=await tx.query<{id:string;source_external_id:string;source_uri:string|null;content_state:string;excerpt:string|null}>(`SELECT id,source_external_id,source_uri,content_state,excerpt FROM source_items WHERE space_id=$1 AND connection_id=$2 AND (source_external_id=ANY($3::varchar[]) OR source_uri=ANY($4::text[]))`,[g.space_id,live.id,output.items.map(i=>i.external_id),output.items.map(i=>i.source_uri)]);
  const ids=new Set(known.rows.map(i=>i.source_external_id));const urls=new Set(known.rows.map(i=>i.source_uri));const fresh={...output,items:output.items.filter(i=>{
   if(!ids.has(i.external_id)&&!urls.has(i.source_uri))return true;
   // A saved link can later acquire readable content; never overwrite a body
   // already saved or let repeated link-only samples rewrite reading history.
   const existing=known.rows.find(row=>row.source_external_id===i.external_id||row.source_uri===i.source_uri);
   return b.spec_json.implementation.kind==='agent_search'&&existing?.content_state!=='content_saved'&&(!!i.reading_content||i.snapshots.length>0||!!i.excerpt&&!existing?.excerpt);
  })};
  const settings=await new PgCustomSourceHandlerRepository(tx,config).getEffectiveSettings(identity);
  const result=await new CustomSourceMaterializationService(tx,config,settings.runner).materialize({run:{runId,spaceId:g.space_id,sourceConnectionId:live.id,handlerVersionId:g.active_version_id!,goal:{...(b.spec_json.implementation.kind==='agent_search'?{resultProvenance:'agent_provided_unverified' as const}:{}),id:g.id,bindingId:b.id,bindingRevision:b.revision,implementationSha256:b.spec_json.implementation.kind==='isolated'?b.spec_json.implementation.sha256:null}},policyEnvelope:SourcePolicyEnvelopeSchema.parse(run.envelope),sandboxFilesRoot:run.filesRoot,rawOutputJson:fresh,recordHandlerRun:false,sourceKind:'source_goal',metadataOnlyOrigins:trustedSearchMetadataOrigins(live.connector_key,b.spec_json.implementation,fresh)});
  if(result.status!=='succeeded')throw new Error('source_materialization_failed');
  // Items already stored for this connection were not rewritten above but still
  // belong to this goal's result; record membership for both in this transaction.
  const keep=new Set(output.items.map(i=>i.external_id)),keepUris=new Set(output.items.map(i=>i.source_uri));
  const memberIds:string[]=[...new Set<string>([...result.itemIds,...(run.memberItemIds??[]),...known.rows.filter(r=>keep.has(r.source_external_id)||r.source_uri!=null&&keepUris.has(r.source_uri)).map(r=>r.id)])];const insertedIds=await associateGoalItems(tx,{spaceId:g.space_id,goalId:g.id,versionId:goal.active_version_id!,bindingId:b.id,connectionId:live.id,goalRunId:runId,itemIds:memberIds});
  // Topic delivery and judgment are recorded with the membership, items and
  // cursor in this transaction; the binding's pre-update state defines baseline.
  // The first-collection window stays open across bounded batches until its
  // page is consumed; it is persisted in the cursor with this batch, so a
  // failed batch keeps it open. Bindings without the flag predate it.
  const windowState=b.cursor_json.baseline_window;
  const baseline=history||(windowState==='open'||windowState===undefined&&!b.last_success_at);
  await applyTopicJudgment(tx,{spaceId:g.space_id,goalId:g.id,goalRunId:runId,bindingId:b.id,versionId:goal.active_version_id!,insertedIds,memberIds,baseline,previousWatermark:typeof b.cursor_json.watermark==='string'?b.cursor_json.watermark:null,includes:g.intent_json.includes??[],rules:(goal as {follow_json?:{rules?:{excluded_origins?:string[];excluded_terms?:string[]}}|null}).follow_json?.rules,signals:run.topicSignals});
  const newItems=insertedIds.length;
  // Members recorded from already-stored rows advance the watermark by their
  // persisted publication time, never by re-reading handler output.
  const memberTimes=run.memberItemIds?.length?(await tx.query<{occurred_at:string|null}>(`SELECT occurred_at FROM source_items WHERE space_id=$1 AND id=ANY($2::varchar[])`,[g.space_id,run.memberItemIds])).rows.map(r=>r.occurred_at?new Date(r.occurred_at).toISOString():null):[];
  const base=[b.cursor_json.watermark,b.cursor_json.pending_watermark,...output.items.map(i=>i.published_at)].filter((t):t is string=>validBusinessTime(t));
  const newest=base.reduce((m,t)=>Math.max(m,Date.parse(t)),-Infinity);
  const times=[...base,...memberTimes.filter((t):t is string=>validBusinessTime(t)&&Date.parse(t)>newest)].filter((t):t is string=>validBusinessTime(t)).sort((a,b)=>Date.parse(a)-Date.parse(b));
  const {watermark:untrusted,pending_watermark:untrustedPending,...continuation}=safeBusinessCursor(run.cursor);
  const pendingPage=Number(run.cursor.remaining_count)>0 || run.cursor.unrecoverable_remainder===true;
  // The first-collection window ends only when this response is fully
  // committed and the upstream reports no further page (explicit contract,
  // bounded); a batch boundary inside one response is not the window's end.
  const pagesDone=Number(b.cursor_json.baseline_pages??0)+(pendingPage?0:1);
  const moreUpstream=!pendingPage&&upstreamContinuation(run.cursor)==='more'&&pagesDone<BASELINE_MAX_PAGES;
  const baselineWindow=!history&&baseline&&(pendingPage||moreUpstream)?'open':'complete';
  const windowCursor=baselineWindow==='open'?{baseline_window:'open',baseline_pages:pagesDone}:{baseline_window:'complete'};
  const {baseline_pages:_pages,...rest}=continuation as Record<string,unknown>;
  const cursor=pendingPage?{...rest,...(validBusinessTime(b.cursor_json.watermark)?{watermark:b.cursor_json.watermark}:{}),pending_watermark:times.at(-1)??null,...windowCursor}:{...rest,...(times.length?{watermark:times.at(-1)}:{}),...windowCursor};
  if(run.cursor.unrecoverable_remainder===true)await tx.query(`UPDATE source_goal_bindings SET gaps_json=gaps_json || $2::jsonb WHERE id=$1 AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(gaps_json) gap WHERE gap->>'reason'='source_recipe_truncated' AND gap->>'revision'=$3)`,[b.id,JSON.stringify([{from:{watermark:b.cursor_json.watermark??null},at:new Date().toISOString(),status:'unrecoverable',reason:'source_recipe_truncated',recoverable:false,revision:String(b.revision)}]),String(b.revision)]);
  if(!history)await tx.query(`UPDATE source_goal_bindings SET cursor_json=$3,status='active',failures=0,fixture_json=COALESCE(fixture_json,'{}'::jsonb)-'collection_error',last_success_at=now(),retry_at=NULL,updated_at=now() WHERE id=$1 AND lease_token=$2`,[b.id,token,cursor]);
  return {...result,goal_items_new:newItems,cursor:history?b.cursor_json:cursor};
 });
}
