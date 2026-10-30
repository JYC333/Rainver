import type {Queryable} from '../../routeUtils/common.js';
/** Same five-minute clock tolerance as native source-stated timestamps. This
 * validates business time only; raw source dates remain in the stored item. */
export function validBusinessTime(value:unknown,now=Date.now()):value is string{
 if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2}))?$/.test(value))return false;
 const [year,month,day]=value.slice(0,10).split('-').map(Number);const days=new Date(`${value.slice(0,7)}-01T00:00:00Z`);days.setUTCMonth(days.getUTCMonth()+1);days.setUTCDate(0);
 const time=Date.parse(value);return year>0&&month>=1&&month<=12&&day>=1&&day<=days.getUTCDate()&&Number.isFinite(time)&&time<=now+300_000;
}
export function safeBusinessCursor(cursor:Record<string,unknown>){
 const result={...cursor};for(const key of ['watermark','pending_watermark','last_published_at','last_collected_at'])if(result[key]!=null&&!validBusinessTime(result[key]))delete result[key];
 if(result.__goal_window&&typeof result.__goal_window==='object'){const window={...(result.__goal_window as Record<string,unknown>)};for(const key of ['since','until'])if(window[key]!=null&&!validBusinessTime(window[key]))delete window[key];result.__goal_window=window;}
 return result;
}
/** Recover an old poisoned cursor under the current worker lease. Prior
 * committed audit cursors are authoritative; absent one, the earliest valid
 * committed member bounds a conservative replay. Retired continuation and the
 * invalid dates remain in a coverage gap, never erased or claimed complete. */
export async function recoverGoalWatermark(db:Queryable,goalId:string,b:{id:string;revision:number;cursor_json:Record<string,unknown>;gaps_json:unknown[];spec_json:{supports_history:boolean}},token:string){
 const old=b.cursor_json;const safe=safeBusinessCursor(old);
 if(['watermark','pending_watermark','last_published_at','last_collected_at'].every(k=>safe[k]===old[k]))return old;
 const prior=await db.query<{cursor:Record<string,unknown>|null}>(`SELECT result_json->'cursor' AS cursor FROM source_goal_runs WHERE binding_id=$1 AND status IN ('succeeded','insufficient') ORDER BY ended_at DESC NULLS LAST,started_at DESC LIMIT 200`,[b.id]);
 const restored=prior.rows.map(r=>r.cursor?.watermark).find(x=>validBusinessTime(x))??(await db.query<{at:string|Date|null}>(`SELECT min(i.occurred_at) AS at FROM source_goal_items gi JOIN source_items i ON i.id=gi.source_item_id AND i.space_id=gi.space_id WHERE gi.goal_id=$1 AND gi.binding_id=$2 AND i.occurred_at<=now()+interval '5 minutes'`,[goalId,b.id])).rows[0]?.at;
 const restoredAt=restored instanceof Date?restored.toISOString():restored;
 const cursor:Record<string,unknown>={...(validBusinessTime(restoredAt)?{watermark:restoredAt}:{}),...(old.baseline_window?{baseline_window:old.baseline_window}:{}),...(old.baseline_pages?{baseline_pages:old.baseline_pages}:{})};
 const gap={from:{...(validBusinessTime(restoredAt)?{watermark:restoredAt}:{})},at:new Date().toISOString(),reason:'source_watermark_recovered',status:b.spec_json.supports_history?'incomplete':'unrecoverable',recoverable:b.spec_json.supports_history,retired_cursor:old};
 const updated=await db.query<{id:string;gaps_json:unknown[]}>(`UPDATE source_goal_bindings SET cursor_json=$4,gaps_json=gaps_json||$5::jsonb WHERE id=$1 AND lease_token=$2 AND revision=$3 RETURNING id,gaps_json`,[b.id,token,b.revision,cursor,JSON.stringify([gap])]);
 if(!updated.rows[0])throw new Error('source_authority_revoked');b.cursor_json=cursor;b.gaps_json=updated.rows[0].gaps_json;return cursor;
}
