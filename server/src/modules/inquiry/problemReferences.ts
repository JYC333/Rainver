import { ProblemReferenceSchema } from "@rainver/protocol";
import { HttpError, type Queryable, type SpaceUserIdentity } from "../routeUtils/common.js";
import { contentReadSql, artifactReadSql, contentAccessLevelSql } from "../access/contentAccessSql.js";
import { contentResourceDefinition } from "../access/contentAccessRegistry.js";
/** One predicate for admission and per-viewer reads; references never grant access. */
export function referenceReadableSql(ref: string, user: string, space: string, project: string): string {
  const full = (type: "space_object" | "task" | "artifact", alias: string) => `(${type === "artifact" ? artifactReadSql(user, alias) : contentReadSql(type, alias, user)} AND ${contentAccessLevelSql({
    definition: contentResourceDefinition(type)!,
    alias,
    userExpr: user
  })}='full')`;
  return `(jsonb_typeof(${ref})='object' AND (
 ((${ref}->>'type') IN ('note','inquiry_thread') AND EXISTS(SELECT 1 FROM space_objects ref_object WHERE ref_object.id=${ref}->>'id' AND ref_object.space_id=${space} AND ref_object.object_type=${ref}->>'type' AND (ref_object.primary_project_id IS NULL OR ref_object.primary_project_id=${project}) AND ${full("space_object", "ref_object")}))
 OR (${ref}->>'type'='task' AND EXISTS(SELECT 1 FROM tasks ref_task WHERE ref_task.id=${ref}->>'id' AND ref_task.space_id=${space} AND ref_task.project_id=${project} AND ${full("task", "ref_task")}))
 OR (${ref}->>'type'='artifact' AND EXISTS(SELECT 1 FROM artifacts ref_artifact WHERE ref_artifact.id=${ref}->>'id' AND ref_artifact.space_id=${space} AND (ref_artifact.project_id=${project} OR (ref_artifact.project_id IS NULL AND EXISTS(SELECT 1 FROM task_artifacts ref_ta JOIN tasks ref_owner_task ON ref_owner_task.id=ref_ta.task_id AND ref_owner_task.space_id=ref_ta.space_id WHERE ref_ta.artifact_id=ref_artifact.id AND ref_ta.space_id=${space} AND ref_owner_task.project_id=${project} AND ref_owner_task.deleted_at IS NULL AND ${full("task","ref_owner_task")}))) AND ${full("artifact", "ref_artifact")})) ))`;
}
export function contextReadableSql(context: string, user: string, space: string, project: string): string {
  return `NOT EXISTS(SELECT 1 FROM jsonb_array_elements(${context}) context_ref WHERE NOT COALESCE(${referenceReadableSql("context_ref->'ref'", user, space, project)},false))`;
}
export async function assertProblemReferences(db: Queryable, identity: SpaceUserIdentity, projectId: string, refs: unknown[]): Promise<void> {
  if (!refs.length) return;
  if (refs.length > 40 || refs.some(ref => !ProblemReferenceSchema.safeParse(ref).success)) throw new HttpError(422, "References must be bounded typed domain references");
  const result = await db.query<{
    allowed: boolean;
  }>(`SELECT COALESCE(bool_and(${referenceReadableSql("ref", "$2", "$3", "$4")}),true) AS allowed FROM jsonb_array_elements($1::jsonb) ref`, [JSON.stringify(refs), identity.userId, identity.spaceId, projectId]);
  if (!result.rows[0]?.allowed) throw new HttpError(404, "Referenced content is unavailable");
}
