import {z} from 'zod';
import type {ProjectReadingHistory} from '@rainver/protocol';
import {canReadProject} from '../../projects/access.js';
import {HttpError,type Queryable,type SpaceUserIdentity} from '../../routeUtils/common.js';
import {assertEditionDate} from './day.js';

const Cursor=z.object({at:z.string().datetime({offset:true}),key:z.string().max(100)}).strict();
/** One discoverable archive for daily revisions and unattached topic analyses.
 * Cursor pagination does not expire after twenty revisions. Only non-content
 * metadata is listed; opening any entry repeats its owning content gates. */
export async function readReadingHistory(db:Queryable,identity:SpaceUserIdentity,projectId:string,input:{date?:string;cursor?:string}):Promise<ProjectReadingHistory>{
 if(!await canReadProject(db,identity.spaceId,projectId,identity.userId))throw new HttpError(404,'Project Reading not found');
 if(input.date)assertEditionDate(input.date);
 let cursor:z.infer<typeof Cursor>|null=null;
 if(input.cursor){try{cursor=Cursor.parse(JSON.parse(Buffer.from(input.cursor,'base64url').toString('utf8')));}catch{throw new HttpError(422,'Invalid reading history cursor');}}
 const rows=(await db.query<ProjectReadingHistory['items'][number]&{key:string}>(`WITH history AS (
  SELECT id,'edition' AS kind,edition_date::text AS date,created_at,day_revision AS revision,'composition:'||id AS key FROM project_reading_compositions WHERE space_id=$1 AND project_id=$2
  UNION ALL SELECT b.id,'theme_analysis',(SELECT min(r.execution_json->'edition'->>'date') FROM project_reading_rounds r WHERE r.briefing_id=b.id AND r.space_id=b.space_id),b.created_at,b.version,'theme:'||b.id FROM information_briefings b WHERE b.space_id=$1 AND b.project_id=$2 AND b.scope_key LIKE 'following:%' AND b.status='ready' AND b.outcome='briefing' AND NOT EXISTS (SELECT 1 FROM project_reading_compositions c WHERE c.space_id=b.space_id AND c.project_id=b.project_id AND c.sections_json @> jsonb_build_array(jsonb_build_object('briefing_id',b.id)))
 ) SELECT id,kind,date,to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at,revision,key FROM history
 WHERE ($3::date IS NULL OR date=$3::text) AND ($4::timestamptz IS NULL OR (created_at,key)<($4::timestamptz,$5::text)) ORDER BY created_at DESC,key DESC LIMIT 21`,[identity.spaceId,projectId,input.date??null,cursor?.at??null,cursor?.key??null])).rows;
 const page=rows.slice(0,20),last=page.at(-1);
 return {items:page.map(({key,...r})=>({...r,created_at:new Date(r.created_at).toISOString()})),next_cursor:rows.length>20&&last?Buffer.from(JSON.stringify({at:last.created_at,key:last.key})).toString('base64url'):null};
}
