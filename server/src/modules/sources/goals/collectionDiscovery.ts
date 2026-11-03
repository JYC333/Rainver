import {SourceCollectionDiscoverySchema,type SourceCollectionDiscovery} from '@rainver/protocol';
import {HttpError,type Queryable,type SpaceUserIdentity} from '../../routeUtils/common.js';
import {sourceItemFullContentReadClause} from '../sourceItemAccess.js';

const RECENT_ITEMS=30;
const RECENT_URL_CHARS=12000;
export interface CollectionDiscoveryContext {
 recent_items:{item_id:string;url:string}[];
 recent_items_truncated:boolean;
 previous_coverage:{truncated:boolean;directions:Pick<SourceCollectionDiscovery['angles'][number],'direction'|'outcome'>[];remaining_gaps:string[];stop_reason:SourceCollectionDiscovery['stop_reason']}|null;
}
/** Only link metadata from this goal's collecting Source, never bodies or private
 * reading state. A canonical item stored in another Source is deliberately not
 * copied: that Source has independent audience and egress authority. */
export async function collectionDiscoveryContext(db:Queryable,identity:SpaceUserIdentity,goalId:string,versionId:string,connectionId:string):Promise<CollectionDiscoveryContext>{
 const rows=(await db.query<{item_id:string;url:string}>(`SELECT i.id AS item_id,i.source_uri AS url
 FROM source_goal_items m JOIN source_items i ON i.id=m.source_item_id AND i.space_id=m.space_id
 WHERE m.space_id=$1 AND m.goal_id=$2 AND m.source_connection_id=$3 AND i.connection_id=$3
 AND i.deleted_at IS NULL AND i.source_uri IS NOT NULL AND ${sourceItemFullContentReadClause('i','$4')}
 ORDER BY m.updated_at DESC,m.id DESC LIMIT $5`,[identity.spaceId,goalId,connectionId,identity.userId,RECENT_ITEMS+1])).rows;
 const previous=(await db.query<{coverage:{discovery?:unknown;truncated?:boolean}|null}>(`SELECT result_json->'coverage' AS coverage FROM source_goal_runs
 WHERE space_id=$1 AND goal_id=$2 AND version_id=$3 AND status IN ('succeeded','failed')
 AND result_json->'spec'->>'source_connection_id'=$4 ORDER BY started_at DESC,id DESC LIMIT 1`,[identity.spaceId,goalId,versionId,connectionId])).rows[0];
 const parsed=SourceCollectionDiscoverySchema.safeParse(previous?.coverage?.discovery);
 const recent:typeof rows=[];let chars=0;
 for(const row of rows){if(recent.length===RECENT_ITEMS||chars+row.url.length>RECENT_URL_CHARS)break;recent.push(row);chars+=row.url.length;}
 return {recent_items:recent,recent_items_truncated:rows.length>recent.length,previous_coverage:parsed.success?{truncated:previous?.coverage?.truncated===true,directions:parsed.data.angles.map(({direction,outcome})=>({direction,outcome})),remaining_gaps:parsed.data.remaining_gaps,stop_reason:parsed.data.stop_reason}:null};
}
/** Frozen links are checked again, not replaced by whatever history is newest.
 * The parent collection gate rechecks this Source's exact scope and destination. */
export async function assertCollectionDiscoveryContext(db:Queryable,identity:SpaceUserIdentity,goalId:string,connectionId:string,context:CollectionDiscoveryContext){
 if(!context||!Array.isArray(context.recent_items)||context.recent_items.length>RECENT_ITEMS)throw new HttpError(403,'source_native_context_refused');
 if(!context.recent_items.length)return;
 const rows=(await db.query<{item_id:string;url:string}>(`SELECT i.id AS item_id,i.source_uri AS url
 FROM source_goal_items m JOIN source_items i ON i.id=m.source_item_id AND i.space_id=m.space_id
 WHERE m.space_id=$1 AND m.goal_id=$2 AND m.source_connection_id=$3 AND i.connection_id=$3
 AND i.deleted_at IS NULL AND i.id=ANY($5::varchar[]) AND ${sourceItemFullContentReadClause('i','$4')}`,
 [identity.spaceId,goalId,connectionId,identity.userId,context.recent_items.map(i=>i.item_id)])).rows;
 const urls=new Map(rows.map(r=>[r.item_id,r.url]));
 if(context.recent_items.some(i=>urls.get(i.item_id)!==i.url))throw new HttpError(403,'source_authority_revoked');
}
