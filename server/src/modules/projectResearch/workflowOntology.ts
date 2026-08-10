import { randomUUID } from "node:crypto";
import { buildSpaceObjectInsert } from "../../db/spaceObjectWriter";
import { contentReadSql } from "../access/contentAccessSql";
import { HttpError, withQueryableTransaction, type Queryable } from "../routeUtils/common";
import { assertLinkTypeAllowed } from "../ontology/validation";

export interface ResearchWorkflowRow {
  id: string;
  project_id: string;
  current_stage: string | null;
  status: string;
  state_json: unknown;
  primary_thread_id: string | null;
  started_by_user_id: string | null;
  started_run_id: string | null;
  created_at: unknown;
  updated_at: unknown;
  [key: string]: unknown;
}

/**
 * Canonical Workflow projection. `primary_thread_id` remains an API/read-model
 * field, but its authority is the active `about` edge rather than a duplicate
 * extension-table column.
 */
export function researchWorkflowProjection(options: {
  workflowAlias?: string;
  objectAlias?: string;
  viewerPlaceholder?: string;
} = {}): { from: string; columns: string; visibilityPredicate: string } {
  const workflow = options.workflowAlias ?? "w";
  const object = options.objectAlias ?? "workflow_object";
  const threadVisibility = options.viewerPlaceholder
    ? `AND ${contentReadSql("space_object", "thread_object", options.viewerPlaceholder)}`
    : "";
  return {
    from: `project_research_workflows ${workflow}
      JOIN space_objects ${object}
        ON ${object}.id=${workflow}.object_id AND ${object}.space_id=${workflow}.space_id
      LEFT JOIN LATERAL (
        SELECT relation.to_object_id AS primary_thread_id
          FROM object_relations relation
          JOIN inquiry_threads thread
            ON thread.object_id=relation.to_object_id AND thread.space_id=relation.space_id
           AND thread.project_id=${workflow}.project_id
          JOIN space_objects thread_object
            ON thread_object.id=thread.object_id AND thread_object.space_id=thread.space_id
         WHERE relation.space_id=${workflow}.space_id
           AND relation.from_object_id=${workflow}.object_id
           AND relation.link_type='about' AND relation.status='active'
           AND relation.metadata_json->>'relation_role'='primary_inquiry_thread'
           ${threadVisibility}
         ORDER BY relation.created_at DESC,relation.id
         LIMIT 1
      ) pin ON true`,
    columns: `${workflow}.object_id AS id,${workflow}.project_id,${workflow}.current_stage,
      ${workflow}.status,${workflow}.state_json,pin.primary_thread_id,
      ${workflow}.started_by_user_id,${workflow}.started_run_id,
      ${object}.created_at,${object}.updated_at`,
    visibilityPredicate: options.viewerPlaceholder
      ? contentReadSql("space_object", object, options.viewerPlaceholder)
      : "TRUE",
  };
}

export async function createResearchWorkflow(
  db: Queryable,
  input: {
    id: string;
    spaceId: string;
    projectId: string;
    title: string;
    status: string;
    currentStage?: string | null;
    state: unknown;
    startedByUserId: string;
    startedRunId?: string | null;
    primaryThreadId?: string | null;
    now: string;
  },
): Promise<void> {
  await withQueryableTransaction(db, async (transaction) => {
    const object = buildSpaceObjectInsert({
      id: input.id,
      spaceId: input.spaceId,
      objectType: "research_workflow",
      title: input.title,
      ownerUserId: input.startedByUserId,
      primaryProjectId: input.projectId,
      createdByUserId: input.startedByUserId,
      createdAt: input.now,
    });
    const offset = object.params.length;
    const extensionParams = [
      input.projectId, input.currentStage ?? null, input.status,
      JSON.stringify(input.state ?? {}), input.startedByUserId, input.startedRunId ?? null,
    ];
    await transaction.query(
      `WITH object AS (${object.sql} RETURNING id,space_id)
       INSERT INTO project_research_workflows (
         object_id,space_id,project_id,current_stage,status,state_json,started_by_user_id,started_run_id
       ) SELECT object.id,object.space_id,$${offset + 1},$${offset + 2},$${offset + 3},
                $${offset + 4}::jsonb,$${offset + 5},$${offset + 6}
           FROM object`,
      [...object.params, ...extensionParams],
    );
    if (input.primaryThreadId) {
      await setResearchWorkflowThread(transaction, {
        spaceId: input.spaceId,
        projectId: input.projectId,
        workflowId: input.id,
        threadId: input.primaryThreadId,
        userId: input.startedByUserId,
        now: input.now,
      });
    }
  });
}

export async function setResearchWorkflowThread(
  db: Queryable,
  input: {
    spaceId: string;
    projectId: string;
    workflowId: string;
    threadId: string;
    userId: string;
    now: string;
  },
): Promise<void> {
  const thread = await db.query<{ object_id: string }>(
    `SELECT object_id FROM inquiry_threads
      WHERE object_id=$1 AND space_id=$2 AND project_id=$3`,
    [input.threadId, input.spaceId, input.projectId],
  );
  if (!thread.rows[0]) throw new HttpError(422, "Inquiry Thread not found in this Project");
  const duplicate = await db.query<{ id: string }>(
    `SELECT workflow.object_id AS id
       FROM project_research_workflows workflow
       JOIN object_relations relation
         ON relation.space_id=workflow.space_id AND relation.from_object_id=workflow.object_id
        AND relation.link_type='about' AND relation.status='active'
        AND relation.metadata_json->>'relation_role'='primary_inquiry_thread'
      WHERE workflow.space_id=$1 AND workflow.project_id=$2
        AND workflow.status<>'archived' AND workflow.object_id<>$3
        AND relation.to_object_id=$4
      LIMIT 1`,
    [input.spaceId, input.projectId, input.workflowId, input.threadId],
  );
  if (duplicate.rows[0]) {
    throw new HttpError(409, "This Inquiry Thread already has a research workflow");
  }
  assertLinkTypeAllowed({
    linkType: "about",
    fromObjectType: "research_workflow",
    toObjectType: "inquiry_thread",
    via: "direct",
  });
  try {
    await db.query(
      `WITH archived AS (
         UPDATE object_relations SET status='archived',updated_at=$7
          WHERE space_id=$2 AND from_object_id=$3 AND link_type='about' AND status='active'
            AND metadata_json->>'relation_role'='primary_inquiry_thread'
            AND to_object_id<>$4
       ) INSERT INTO object_relations (
         id,space_id,from_object_id,to_object_id,link_type,status,metadata_json,created_by_user_id,created_at,updated_at
       ) VALUES ($1,$2,$3,$4,'about','active',$5::jsonb,$6,$7,$7)
       ON CONFLICT (space_id,from_object_id,to_object_id,link_type) WHERE status='active'
       DO UPDATE SET metadata_json=EXCLUDED.metadata_json,updated_at=EXCLUDED.updated_at`,
      [randomUUID(), input.spaceId, input.workflowId, input.threadId,
        JSON.stringify({ relation_role: "primary_inquiry_thread" }), input.userId, input.now],
    );
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new HttpError(409, "This Inquiry Thread already has a research workflow");
    }
    throw error;
  }
}

export async function pinnedResearchThreadId(
  db: Queryable,
  input: { spaceId: string; projectId: string; workflowId: string; viewerUserId?: string },
): Promise<string | null> {
  const projection = researchWorkflowProjection({ viewerPlaceholder: input.viewerUserId ? "$4" : undefined });
  const result = await db.query<{ primary_thread_id: string | null }>(
    `SELECT pin.primary_thread_id FROM ${projection.from}
      WHERE w.space_id=$1 AND w.project_id=$2 AND w.object_id=$3
        AND ${projection.visibilityPredicate}`,
    input.viewerUserId
      ? [input.spaceId, input.projectId, input.workflowId, input.viewerUserId]
      : [input.spaceId, input.projectId, input.workflowId],
  );
  return result.rows[0]?.primary_thread_id ?? null;
}

function isUniqueViolation(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error
    && (error as { code?: unknown }).code === "23505");
}
