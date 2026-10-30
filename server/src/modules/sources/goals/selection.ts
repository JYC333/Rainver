import {validBusinessTime,safeBusinessCursor} from './watermark.js';
import type {CustomSourceHandlerOutput} from '@rainver/protocol';
import type {Pool} from '../../routeUtils/common.js';
/** Server-owned selection: do not advance an upstream page past unprocessed rows.
 * Re-reading a bounded page and excluding successful IDs handles feeds without
 * pagination, either order, and equal timestamps without a timestamp-only cursor.
 * Unprocessed rows are new items and items already stored for this connection
 * that this goal has not yet recorded as members; they share one bounded batch
 * in source order. Stored items already in this goal are refresh-only and never
 * consume the batch. The page (and watermark) is consumed only when nothing is
 * left unprocessed; otherwise the cursor stays pending for the next check.
 * Stored content and reading history are never rewritten here. */
export async function selectGoalPage(db:Pool,spaceId:string,connectionId:string,items:CustomSourceHandlerOutput['items'],cursor:Record<string,unknown>,next:Record<string,unknown>,limit:number,goalId?:string){
 cursor=safeBusinessCursor(cursor);next=safeBusinessCursor(next);
 const incremental=cursor.__goal_history===false;
 const known=incremental?await db.query<{id:string;source_external_id:string;source_uri:string;deleted:boolean}>(`SELECT id,source_external_id,source_uri,deleted_at IS NOT NULL AS deleted FROM source_items WHERE space_id=$1 AND connection_id=$2 AND (source_external_id=ANY($3::varchar[]) OR source_uri=ANY($4::text[]))`,[spaceId,connectionId,items.map(i=>i.external_id),items.map(i=>i.source_uri)]):{rows:[]};
 const live=known.rows.filter(r=>!r.deleted);
 const members=goalId&&live.length?new Set((await db.query<{source_item_id:string}>(`SELECT source_item_id FROM source_goal_items WHERE goal_id=$1 AND space_id=$2 AND source_item_id=ANY($3::varchar[])`,[goalId,spaceId,live.map(r=>r.id)])).rows.map(r=>r.source_item_id)):new Set<string>();
 const matches=(i:CustomSourceHandlerOutput['items'][number])=>known.rows.filter(r=>r.source_external_id===i.external_id||r.source_uri===i.source_uri);
 // A deleted (tombstone) row still suppresses re-materialization so it is never
 // resurrected, but it is not membership work: it takes no batch, keeps no page
 // pending and contributes no watermark. Only live stored rows can join a goal.
 const work:{item:CustomSourceHandlerOutput['items'][number];storedIds:string[]}[]=[];const refresh:string[]=[];
 for(const i of items){const rows=matches(i);if(!rows.length){work.push({item:i,storedIds:[]});continue;}if(!goalId)continue;const ids=rows.filter(r=>!r.deleted).map(r=>r.id);if(!ids.length)continue;const missing=ids.filter(id=>!members.has(id));if(missing.length)work.push({item:i,storedIds:missing});else refresh.push(...ids);}
 const batch=work.slice(0,limit),remaining=work.length-batch.length;
 const selected=batch.filter(w=>!w.storedIds.length).map(w=>w.item);
 const memberItemIds=[...new Set([...batch.flatMap(w=>w.storedIds),...refresh])];
 const accepted=[cursor.watermark,cursor.pending_watermark,...batch.map(w=>w.item.published_at)].filter((x):x is string=>validBusinessTime(x)).sort((a,b)=>Date.parse(a)-Date.parse(b)).at(-1)??null;
 return {items:selected,memberItemIds,cursor:remaining?{...cursor,pending_watermark:accepted,remaining_count:remaining,coverage:'pending_page'}:{...next,watermark:accepted,remaining_count:0,coverage:next.unrecoverable_remainder===true?'recipe_truncated':'page_consumed'}};
}

/** Validate the complete bounded response before selecting; cap is a commit batch,
 * not a parser fault. Never hide invalid identities or duplicates past the cap. */
export async function selectGoalResult(db:Pool,g:import('./access.js').GoalRow,spec:import('@rainver/protocol').SourceGoalBindingSpec,cursor:Record<string,unknown>,run:import('./service.js').GoalExecutionResult){
 const {validateGoalSample}=await import('./validation.js');
 const valid=validateGoalSample(run.output,{allowUndated:run.source_kind==='search',budget:g.budget_json,...g.intent_json,allowEmpty:true});
 if(!valid.ok)throw new Error('source_parser_validation_failed');
 const parsed=(await import('@rainver/protocol')).CustomSourceHandlerOutputSchema.parse(valid.output);
 const observed=parsed.items.length;const excluded=g.execution_filters?.excluded_origins??[];if(excluded.length)parsed.items=parsed.items.filter(i=>!excluded.some(origin=>new URL(origin).origin===new URL(i.source_uri).origin));
 const page:{items:typeof parsed.items;memberItemIds:string[];cursor:Record<string,unknown>}=await selectGoalPage(db,g.space_id,spec.source_connection_id,parsed.items,cursor,run.cursor,Math.min(g.budget_json.items_per_source,(run.envelope as {limits?:{max_items?:number}}).limits?.max_items??g.budget_json.items_per_source),g.id);
 if(cursor.__goal_history===true && Number(page.cursor.remaining_count)>0)page.cursor.history_window={...(run.cursor.history_window as object??{}),exhausted:false};
 return {...run,memberItemIds:page.memberItemIds,output:{...parsed,items:page.items,cursor:page.cursor},cursor:page.cursor,selection:{observed_count:observed+valid.filtered_count,filtered_count:valid.filtered_count+observed-parsed.items.length,selected_count:page.items.length,remaining_count:Number(page.cursor.remaining_count??0)}};
}

export const GOAL_GAPS_RESET_SQL = `gaps_json=(SELECT COALESCE(jsonb_agg((gap-'cursor') || jsonb_build_object('from',jsonb_strip_nulls(jsonb_build_object('watermark',gap->'from'->'watermark')))), '[]'::jsonb) FROM jsonb_array_elements(gaps_json) gap) || CASE WHEN COALESCE((cursor_json->>'remaining_count')::int,0)>0 THEN jsonb_build_array(jsonb_build_object('from',jsonb_strip_nulls(jsonb_build_object('watermark',cursor_json->'watermark')),'at',now(),'reason','implementation_cursor_reset','recoverable',COALESCE((spec_json->>'supports_history')::boolean,false),'status',CASE WHEN COALESCE((spec_json->>'supports_history')::boolean,false) THEN 'incomplete' ELSE 'unrecoverable' END)) ELSE '[]'::jsonb END`;
export const GOAL_CURSOR_RESET_SQL = `cursor_json=jsonb_strip_nulls(jsonb_build_object('watermark',cursor_json->'watermark','baseline_window',cursor_json->'baseline_window','baseline_pages',cursor_json->'baseline_pages')),${GOAL_GAPS_RESET_SQL}`;

/** Upper bound on upstream pages that belong to one first-collection window, so
 * a provider that always offers another page cannot keep baseline open forever.
 * Older backlog beyond it is judged by time and stays unknown freshness. */
export const BASELINE_MAX_PAGES=10;
/** Explicit upstream continuation reported by a source's cursor, using only the
 * contracts existing connectors emit: `cursor` (OpenAlex: next token or null),
 * `offset` (Semantic Scholar: next offset or null) and `more_results_available`
 * (Brave). Any other cursor shape is `unknown` and treated as a single page. */
export function upstreamContinuation(cursor:Record<string,unknown>):'more'|'done'|'unknown'{
 if('more_results_available' in cursor)return cursor.more_results_available===true?'more':'done';
 if('cursor' in cursor)return typeof cursor.cursor==='string'&&cursor.cursor.length>0?'more':'done';
 if('offset' in cursor)return typeof cursor.offset==='number'&&Number.isFinite(cursor.offset)?'more':'done';
 return 'unknown';
}
