import type {CustomSourceHandlerOutput} from '@rainver/protocol';
import type {Pool} from '../../routeUtils/common.js';
/** Server-owned selection: do not advance an upstream page past unpersisted rows.
 * Re-reading a bounded page and excluding successful IDs handles feeds without
 * pagination, either order, and equal timestamps without a timestamp-only cursor. */
export async function selectGoalPage(db:Pool,spaceId:string,connectionId:string,items:CustomSourceHandlerOutput['items'],cursor:Record<string,unknown>,next:Record<string,unknown>,limit:number){
 const incremental=cursor.__goal_history===false;
 const known=incremental?await db.query<{source_external_id:string;source_uri:string}>(`SELECT source_external_id,source_uri FROM source_items WHERE space_id=$1 AND connection_id=$2 AND (source_external_id=ANY($3::varchar[]) OR source_uri=ANY($4::text[]))`,[spaceId,connectionId,items.map(i=>i.external_id),items.map(i=>i.source_uri)]):{rows:[]};
 const ids=new Set(known.rows.map(r=>r.source_external_id)),urls=new Set(known.rows.map(r=>r.source_uri));
 const candidates=items.filter(i=>!ids.has(i.external_id)&&!urls.has(i.source_uri));
 const selected=candidates.slice(0,limit),remaining=candidates.length-selected.length;
 const accepted=[cursor.watermark,cursor.pending_watermark,...selected.map(i=>i.published_at)].filter((x):x is string=>typeof x==='string'&&Number.isFinite(Date.parse(x))).sort((a,b)=>Date.parse(a)-Date.parse(b)).at(-1)??null;
 return {items:selected,cursor:remaining?{...cursor,pending_watermark:accepted,remaining_count:remaining,coverage:'pending_page'}:{...next,watermark:accepted,remaining_count:0,coverage:next.unrecoverable_remainder===true?'recipe_truncated':'page_consumed'}};
}

/** Validate the complete bounded response before selecting; cap is a commit batch,
 * not a parser fault. Never hide invalid identities or duplicates past the cap. */
export async function selectGoalResult(db:Pool,g:import('./access.js').GoalRow,spec:import('@rainver/protocol').SourceGoalBindingSpec,cursor:Record<string,unknown>,run:import('./service.js').GoalExecutionResult){
 const {validateGoalSample}=await import('./validation.js');
 const valid=validateGoalSample(run.output,{budget:g.budget_json,...g.intent_json,allowEmpty:true});
 if(!valid.ok)throw new Error('source_parser_validation_failed');
 const parsed=(await import('@rainver/protocol')).CustomSourceHandlerOutputSchema.parse(valid.output);
 const observed=parsed.items.length;const excluded=g.execution_filters?.excluded_origins??[];if(excluded.length)parsed.items=parsed.items.filter(i=>!excluded.some(origin=>new URL(origin).origin===new URL(i.source_uri).origin));
 const page:{items:typeof parsed.items;cursor:Record<string,unknown>}=await selectGoalPage(db,g.space_id,spec.source_connection_id,parsed.items,cursor,run.cursor,Math.min(g.budget_json.items_per_source,(run.envelope as {limits?:{max_items?:number}}).limits?.max_items??g.budget_json.items_per_source));
 if(cursor.__goal_history===true && Number(page.cursor.remaining_count)>0)page.cursor.history_window={...(run.cursor.history_window as object??{}),exhausted:false};
 return {...run,output:{...parsed,items:page.items,cursor:page.cursor},cursor:page.cursor,selection:{observed_count:observed+valid.filtered_count,filtered_count:valid.filtered_count+observed-parsed.items.length,selected_count:page.items.length,remaining_count:Number(page.cursor.remaining_count??0)}};
}

export const GOAL_GAPS_RESET_SQL = `gaps_json=(SELECT COALESCE(jsonb_agg((gap-'cursor') || jsonb_build_object('from',jsonb_strip_nulls(jsonb_build_object('watermark',gap->'from'->'watermark')))), '[]'::jsonb) FROM jsonb_array_elements(gaps_json) gap) || CASE WHEN COALESCE((cursor_json->>'remaining_count')::int,0)>0 THEN jsonb_build_array(jsonb_build_object('from',jsonb_strip_nulls(jsonb_build_object('watermark',cursor_json->'watermark')),'at',now(),'reason','implementation_cursor_reset','recoverable',COALESCE((spec_json->>'supports_history')::boolean,false),'status',CASE WHEN COALESCE((spec_json->>'supports_history')::boolean,false) THEN 'incomplete' ELSE 'unrecoverable' END)) ELSE '[]'::jsonb END`;
export const GOAL_CURSOR_RESET_SQL = `cursor_json=jsonb_strip_nulls(jsonb_build_object('watermark',cursor_json->'watermark')),${GOAL_GAPS_RESET_SQL}`;
