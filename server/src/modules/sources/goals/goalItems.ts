import type {Queryable} from '../../routeUtils/common.js';
/** Record Goal ↔ SourceItem membership inside the materialization transaction.
 * Every identifier comes from the server-held goal, active version, leased
 * binding and collection audit; model output only decides which items exist.
 * Repeat collections keep the first collection and refresh the latest one.
 * Returns the SourceItems that became members of this goal in this call. */
export async function associateGoalItems(tx:Queryable,input:{spaceId:string;goalId:string;versionId:string;bindingId:string;connectionId:string;goalRunId:string;itemIds:readonly string[]}){
 const ids=[...new Set(input.itemIds)];if(!ids.length)return [] as string[];
 const agentRunId=(await tx.query<{id:string|null}>(`SELECT result_json->>'native_run_id' AS id FROM source_goal_runs WHERE id=$1 AND goal_id=$2 AND space_id=$3`,[input.goalRunId,input.goalId,input.spaceId])).rows[0]?.id??null;
 const rows=await tx.query(`INSERT INTO source_goal_items(id,space_id,goal_id,source_item_id,source_connection_id,binding_id,version_id,first_goal_run_id,last_goal_run_id,agent_run_id)
  SELECT gen_random_uuid()::text,$1::varchar,$2::varchar,item.id,$3::varchar,$4::varchar,$5::varchar,$6::varchar,$6::varchar,$7::varchar FROM source_items item WHERE item.space_id=$1::varchar AND item.id=ANY($8::varchar[]) AND item.deleted_at IS NULL
  ON CONFLICT(goal_id,source_item_id) DO UPDATE SET last_goal_run_id=EXCLUDED.last_goal_run_id,version_id=EXCLUDED.version_id,binding_id=EXCLUDED.binding_id,source_connection_id=EXCLUDED.source_connection_id,agent_run_id=COALESCE(EXCLUDED.agent_run_id,source_goal_items.agent_run_id),updated_at=now()
  RETURNING source_item_id,(xmax=0) AS inserted`,[input.spaceId,input.goalId,input.connectionId,input.bindingId,input.versionId,input.goalRunId,agentRunId,ids]);
 return rows.rows.filter(r=>r.inserted).map(r=>String(r.source_item_id));
}
