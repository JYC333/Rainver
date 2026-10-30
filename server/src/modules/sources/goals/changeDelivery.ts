import type {ReadingStateRequest} from '@rainver/protocol';
import {HttpError,type Queryable,type SpaceUserIdentity} from '../../routeUtils/common.js';
import {goalCollectionReadableSql,goalItemReadableSql,goalVisibleSql} from './itemVisibility.js';
/** Confirm exactly the change the person saw. Authorization and the write share
 * one statement snapshot; a late confirmation cannot acknowledge a newer ID. */
export async function changeReadingState(db:Queryable,identity:SpaceUserIdentity,itemId:string,change:ReadingStateRequest,projectId?:string){
 const result=await db.query(`INSERT INTO source_goal_change_user_states(space_id,change_id,user_id,read_status,dismissed)
  SELECT c.space_id,c.id,$4::varchar,COALESCE($6::varchar,'unread'),COALESCE($7::int,0)
  FROM source_goal_item_changes c JOIN source_goals g ON g.id=c.goal_id AND g.space_id=c.space_id
  JOIN source_items item ON item.id=c.source_item_id AND item.space_id=c.space_id
  WHERE c.id=$1 AND c.space_id=$2 AND c.source_item_id=$3 AND c.delivered_at IS NOT NULL
   AND ${goalVisibleSql('g','$4')} AND ${goalItemReadableSql('item','$4',true)} AND ${goalCollectionReadableSql('c','$4')} AND ($5::varchar IS NULL OR g.project_id=$5)
  ON CONFLICT(change_id,user_id) DO UPDATE SET read_status=COALESCE($6::varchar,source_goal_change_user_states.read_status),dismissed=COALESCE($7::int,source_goal_change_user_states.dismissed),updated_at=now() RETURNING change_id`,
 [change.topic_change_id,identity.spaceId,itemId,identity.userId,projectId??null,change.read_status??null,change.dismissed===undefined?null:Number(change.dismissed)]);
 if(!result.rows[0])throw new HttpError(404,'Topic change not found');
 return {updated:1};
}
