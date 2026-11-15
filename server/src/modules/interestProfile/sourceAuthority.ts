import { HttpError, type Queryable } from '../routeUtils/common.js';
import { contentDecisionFromDb } from '../access/contentAccessQuery.js';
import { lockReadingMutations } from '../sources/readingMutationAccess.js';
import { sourceItemFullContentReadClause } from '../sources/sourceItemAccess.js';

export interface InterestSourceRef { item_id:string; channel_id:string; connection_id:string }
/** Complete discovery precedes every Source lock. Recommendations and history
 * share the existing Project/person/Space/root/grant order with Reading. */
export async function lockInterestSources(db:Queryable,space:string,user:string,refs:readonly InterestSourceRef[],subscribed:boolean):Promise<void> {
  await lockReadingMutations(db,{spaceId:space,userId:user},refs.map(r=>r.item_id),[],refs.map(r=>({object_type:'source_connection',object_id:r.connection_id})));
  const channels=[...new Set(refs.map(r=>r.channel_id))].sort();
  if(channels.length)await db.query(`SELECT id FROM source_channel_item_links WHERE space_id=$1 AND source_channel_id=ANY($2::varchar[]) ORDER BY id FOR SHARE`,[space,channels]);
  if(refs.length)await db.query(`SELECT id FROM source_item_annotations WHERE space_id=$1 AND source_item_id=ANY($2::varchar[]) ORDER BY id FOR SHARE`,[space,[...new Set(refs.map(r=>r.item_id))].sort()]);
  for(const r of refs) {
    const row=(await db.query(`SELECT i.id FROM source_items i
      JOIN source_channel_item_links l ON l.space_id=i.space_id AND l.source_item_id=i.id AND l.source_channel_id=$4 AND l.status='active'
      JOIN source_channels ch ON ch.space_id=l.space_id AND ch.id=l.source_channel_id AND ch.source_connection_id=$5 AND ch.status='active'
      JOIN source_connections c ON c.space_id=ch.space_id AND c.id=ch.source_connection_id AND c.deleted_at IS NULL AND c.status='active'
      WHERE i.space_id=$1 AND i.id=$2 AND i.deleted_at IS NULL
      AND ${sourceItemFullContentReadClause('i','$3')}
      AND ($6::boolean=false OR EXISTS(SELECT 1 FROM source_channel_user_subscriptions s WHERE s.space_id=i.space_id AND s.source_channel_id=ch.id AND s.user_id=$3 AND s.status='subscribed'))
      AND ($6::boolean=true OR (c.visibility='space_shared' AND i.visibility='space_shared'))`,[space,r.item_id,user,r.channel_id,r.connection_id,subscribed])).rows[0];
    if(!row || await contentDecisionFromDb(db,{spaceId:space,userId:user},'source_item',r.item_id,{includeOversight:false})!=='full')throw new HttpError(404,'Source authority unavailable');
  }
}
