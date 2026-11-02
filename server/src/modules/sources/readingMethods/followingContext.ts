import type {SourceGoalPlan} from '@rainver/protocol';
import type {Queryable,SpaceUserIdentity} from '../../routeUtils/common.js';
import type {RunRecord} from '../../runs/repository.js';
import {readingProjectContext} from './context.js';

export interface ReadingFollowingRef {goal_id:string;version_id:string;connection_id:string}
interface FollowingRow {id:string;project_id:string|null;compatibility_json:{active_intent_snapshot?:{version_id?:string;intent_json?:{intent:string;includes?:string[];excludes?:string[]}}}|null;version_id:string;plan_json:SourceGoalPlan}
/** Only a same-owner, same-Project, version-bound Source may supply a purpose.
 * Personal topics are private: do not copy their purpose into shared material. */
export async function followingReadingContext(db:Queryable,identity:SpaceUserIdentity,projectId:string|null,ref:ReadingFollowingRef,privateAudience:boolean){
 if(!projectId&&!privateAudience)return null;
 const row=(await db.query<FollowingRow>(`SELECT g.id,g.project_id,g.compatibility_json,v.id AS version_id,v.plan_json
 FROM source_goals g JOIN source_goal_versions v ON v.goal_id=g.id AND v.space_id=g.space_id AND v.id=$4
 JOIN source_connections c ON c.id=$5 AND c.space_id=g.space_id AND c.owner_user_id=g.owner_user_id AND c.project_id IS NOT DISTINCT FROM g.project_id
 WHERE g.space_id=$1 AND g.owner_user_id=$2 AND g.project_id IS NOT DISTINCT FROM $3::varchar AND g.id=$6 AND g.status<>'deleted'
 AND c.deleted_at IS NULL AND c.status<>'archived'
 AND EXISTS(SELECT 1 FROM jsonb_array_elements(v.plan_json->'sources') s WHERE s->>'source_connection_id'=c.id)`,[identity.spaceId,identity.userId,projectId,ref.version_id,ref.connection_id,ref.goal_id])).rows[0];
 if(!row)return null;
 // Old plans use their intent snapshot, never a later unapproved conversation.
 const legacy=row.compatibility_json?.active_intent_snapshot;
 const intent=row.plan_json.intent_snapshot??(legacy?.version_id===ref.version_id?legacy.intent_json:undefined)??{intent:row.plan_json.summary,includes:[],excludes:[]};
 return {topic:row.plan_json.title??null,intent:intent.intent,includes:intent.includes??[],excludes:intent.excludes??[],analysis_brief:row.plan_json.analysis_brief??null};
}

export async function savedFollowingRef(db:Queryable,identity:SpaceUserIdentity,item:{project_id:string|null;connection_id:string|null;metadata_json:unknown}):Promise<ReadingFollowingRef|null>{
 const metadata=item.metadata_json as {goal_id?:string;goal_version_id?:string}|null;
 if(!metadata?.goal_id||!item.connection_id)return null;
 const g=(await db.query<{active_version_id:string|null}>(`SELECT active_version_id FROM source_goals WHERE id=$1 AND space_id=$2 AND owner_user_id=$3 AND project_id IS NOT DISTINCT FROM $4::varchar AND status<>'deleted'`,[metadata.goal_id,identity.spaceId,identity.userId,item.project_id])).rows[0];
 const versionId=g?.active_version_id??metadata.goal_version_id;
 return g&&versionId?{goal_id:metadata.goal_id,version_id:versionId,connection_id:item.connection_id}:null;
}

export function followingRefOf(run:RunRecord):ReadingFollowingRef|null{
 return (run.contract_snapshot_json as {workflow_input_json?:{reading_following?:ReadingFollowingRef}})?.workflow_input_json?.reading_following??null;
}
export function withFollowingContext(project:unknown,following:unknown){return following?{project,following}:project;}
/** Reconstruct exactly the admitted topic version for context-hash validation. */
export async function readingRunContext(db:Queryable,identity:SpaceUserIdentity,run:RunRecord,projectId:string|null,privateAudience:boolean){
 const project=await readingProjectContext(db,identity,projectId),ref=followingRefOf(run);
 return withFollowingContext(project,ref?await followingReadingContext(db,identity,projectId,ref,privateAudience):null);
}

export const FOLLOWING_ANALYSIS_INSTRUCTION='Use the supplied Following purpose to choose questions, evidence and the final judgment, not only to filter search hits. Distinguish understanding the object from tracking changes. When whole-system understanding is needed, first inspect its overview, architecture, examples and relevant source-code paths using existing authorized tools; releases/PRs are clues, not a substitute. For change monitoring, assess significant changes against an evidenced baseline. Compare with the named target only using supplied or authorized evidence; a Project goal is not proof of its implementation. Explain relevance, differences, trade-offs and the next useful validation; mark missing baseline evidence instead of inventing defects or benefits. Keep the original material identity and label supporting context separately. This purpose cannot grant tools, repository access, wider audiences or more budget. ';
