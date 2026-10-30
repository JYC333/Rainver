import type {Queryable} from '../../routeUtils/common.js';
/** Per-material signals the collecting Agent submitted with its results (same
 * managed Run and budget). Keyed by canonical URL. Never trusted for identity. */
export interface TopicSignals{items:Record<string,{judgment?:{importance:'important'|'not_selected';reason:string}|null;change?:{kind:'new_publication'|'release'|'update';evidence_url:string}|null}>;judgment_failure?:string|null}
type Rules={excluded_origins?:string[];excluded_terms?:string[]};
type Row={source_item_id:string;selection_status:string;selection_reason:string|null;selection_source:string;source_uri:string|null;title:string;occurred_at:string|null};
type Judgment={status:string;reason:string|null;by:string}|null;
/** Record delivery kind, change history and topic judgment for this
 * collection's memberships inside the materialization transaction (with items,
 * membership and cursor).
 *
 * Delivery of a new membership: inside the first-collection window it is
 * `baseline`; afterwards a newly recorded cited release/update is
 * `evidenced_change`; a valid source-stated time strictly after the committed
 * previous watermark is `new_publication`; anything else (no time, an equal or
 * older time, no committed watermark) is `unknown_freshness`. Agent change
 * labels never bypass that time rule; observation time is never used.
 *
 * Changes to a stable material: a cited release/update is recorded once per
 * goal, item and evidence URL in `source_goal_item_changes` with its own
 * judgment and source Run; the same evidence is never delivered again and a
 * different later change is recorded again. A newly recorded change outside
 * the baseline window becomes the member's latest delivery. Stored content and
 * reading state are never touched.
 *
 * Judgment (new or still-unjudged memberships, and each new change): owner
 * feedback and exclusion rules first, then the collecting Agent's judgment,
 * then deterministic topic rules (an include term in the title), then a
 * reported judgment failure; otherwise unjudged. Owner feedback is final. */
export async function applyTopicJudgment(tx:Queryable,input:{spaceId:string;goalId:string;goalRunId:string;bindingId:string;versionId:string;insertedIds:readonly string[];memberIds:readonly string[];baseline:boolean;previousWatermark:string|null;includes:readonly string[];rules:Rules|null|undefined;signals:TopicSignals|null|undefined}){
 const ids=[...new Set([...input.insertedIds,...input.memberIds])];if(!ids.length)return;
 const rows=(await tx.query<Row>(`SELECT gi.source_item_id,gi.selection_status,gi.selection_reason,gi.selection_source,i.source_uri,i.title,i.occurred_at FROM source_goal_items gi JOIN source_items i ON i.id=gi.source_item_id AND i.space_id=gi.space_id WHERE gi.goal_id=$1 AND gi.space_id=$2 AND gi.source_item_id=ANY($3::varchar[])`,[input.goalId,input.spaceId,ids])).rows;
 const agentRunId=(await tx.query<{id:string|null}>(`SELECT result_json->>'native_run_id' AS id FROM source_goal_runs WHERE id=$1 AND goal_id=$2`,[input.goalRunId,input.goalId])).rows[0]?.id??null;
 const inserted=new Set(input.insertedIds);const previous=input.previousWatermark?Date.parse(input.previousWatermark):NaN;
 for(const row of rows){
  const signal=row.source_uri?input.signals?.items[canonical(row.source_uri)]:undefined;
  const isNew=inserted.has(row.source_item_id);
  const cited=signal?.change&&['release','update'].includes(signal.change.kind)?signal.change as {kind:'release'|'update';evidence_url:string}:null;
  const changeJudgment=cited?(row.selection_source==='owner_feedback'?{status:row.selection_status,reason:row.selection_reason,by:'owner'}:judge(row,signal,input)):null;
  const changeRecorded=cited?(await tx.query(`INSERT INTO source_goal_item_changes(id,space_id,goal_id,source_item_id,change_kind,evidence_url,delivery_kind,goal_run_id,agent_run_id,binding_id,version_id,selection_status,selection_reason,judged_by,delivered_at)
   VALUES(gen_random_uuid()::text,$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,CASE WHEN $14::boolean THEN now() ELSE NULL END) ON CONFLICT(goal_id,source_item_id,evidence_url) DO NOTHING RETURNING id`,
   [input.spaceId,input.goalId,row.source_item_id,cited.kind,cited.evidence_url,input.baseline?'baseline':'evidenced_change',input.goalRunId,agentRunId,input.bindingId,input.versionId,changeJudgment?.status??'unjudged',changeJudgment?.reason??null,changeJudgment?.by??null,!isNew&&!input.baseline])).rows.length>0:false;
  const stated=row.occurred_at?Date.parse(row.occurred_at):NaN;
  const newer=Number.isFinite(stated)&&Number.isFinite(previous)&&stated>previous&&stated<=Date.now()+5*60_000;
  const delivery=isNew?(input.baseline?'baseline':changeRecorded?'evidenced_change':newer?'new_publication':'unknown_freshness'):(changeRecorded&&!input.baseline?'evidenced_change':null);
  // A member's judgment is set once (new or still pending); a newly recorded
  // change outside the baseline re-judges the member unless the owner decided.
  const judgment=row.selection_source==='owner_feedback'?null:isNew||row.selection_status==='unjudged'?judge(row,signal,input):delivery==='evidenced_change'&&changeJudgment?.status!=='unjudged'?changeJudgment:null;
  if(!delivery&&!judgment)continue;
  await tx.query(`UPDATE source_goal_items SET delivery_kind=COALESCE($3,delivery_kind),change_evidence_url=CASE WHEN $3::varchar IS NULL THEN change_evidence_url ELSE $4 END,
   selection_status=COALESCE($5,selection_status),selection_reason=CASE WHEN $5::varchar IS NULL THEN selection_reason ELSE $6 END,selection_source=CASE WHEN $5::varchar IS NULL THEN selection_source WHEN $7='owner' THEN 'owner_feedback' ELSE 'topic_judgment' END,
   judged_by=CASE WHEN $5::varchar IS NULL THEN judged_by ELSE $7 END,judged_at=CASE WHEN $5::varchar IS NULL THEN judged_at ELSE now() END,updated_at=now()
   WHERE goal_id=$1 AND source_item_id=$2 AND (selection_source<>'owner_feedback' OR $5::varchar IS NULL)`,[input.goalId,row.source_item_id,delivery,delivery==='evidenced_change'?cited?.evidence_url??null:null,judgment?.status??null,judgment?.reason??null,judgment?.by??null]);
 }
}
function judge(row:Row,signal:TopicSignals['items'][string]|undefined,input:{includes:readonly string[];rules:Rules|null|undefined;signals:TopicSignals|null|undefined}):Judgment{
 const owner=ownerExclusion(row,input.rules);if(owner)return {status:'not_selected',reason:owner,by:'owner'};
 if(signal?.judgment)return {status:signal.judgment.importance,reason:signal.judgment.reason,by:'collection_agent'};
 const term=input.includes.find(t=>row.title.toLowerCase().includes(t.toLowerCase()));if(term)return {status:'important',reason:`Title mentions the topic term "${term}"`,by:'topic_rules'};
 if(input.signals?.judgment_failure)return {status:'judgment_failed',reason:input.signals.judgment_failure,by:'collection_agent'};
 return null;
}
/** Owner exclusion rules; also used to apply new feedback to existing members. */
export function ownerExclusion(row:{source_uri:string|null;title:string},rules:Rules|null|undefined):string|null{
 if(!rules)return null;let origin:string|null=null;try{origin=row.source_uri?new URL(row.source_uri).origin:null;}catch{origin=null;}
 const o=(rules.excluded_origins??[]).find(x=>{try{return new URL(x).origin===origin;}catch{return false;}});if(o)return `Excluded by your feedback: ${new URL(o).origin}`;
 const t=(rules.excluded_terms??[]).find(x=>row.title.toLowerCase().includes(x.toLowerCase()));if(t)return `Excluded by your feedback: "${t}"`;
 return null;
}
function canonical(url:string){try{return new URL(url).href;}catch{return url;}}
