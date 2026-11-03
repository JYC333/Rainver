import {SourceGoalPlanSchema} from '@rainver/protocol';

/** Presentation follows the executable version; a candidate never renames a live topic. */
export function goalPresentation(
 goal:{active_version_id:string|null;current_version_id:string|null},
 versions:readonly {id:string;plan_json:unknown}[],
){
 const id=goal.active_version_id??goal.current_version_id;
 if(!id)return {version_id:null,title:null,summary:null};
 const version=versions.find(v=>v.id===id);
 if(!version)throw new Error('Source goal presentation version missing');
 const plan=SourceGoalPlanSchema.parse(version.plan_json);
 return {version_id:id,title:plan.title,summary:plan.summary};
}

/** SQL counterpart for cross-domain read models. Aliases/expressions are code-owned.
 * An active version wins over a draft; a frozen caller may supply its exact version.
 * Raw intent and compatibility metadata are never presentation titles. */
export function goalPresentationTitleSql(goal: string, version = `COALESCE(${goal}.active_version_id, ${goal}.current_version_id)`): string {
 return `COALESCE((SELECT NULLIF(btrim(presentation_version.plan_json->>'title'), '')
   FROM source_goal_versions presentation_version
   WHERE presentation_version.space_id=${goal}.space_id AND presentation_version.goal_id=${goal}.id
     AND presentation_version.id=${version}), 'Following')`;
}
