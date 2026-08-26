import { randomUUID } from "node:crypto";
import type { Queryable } from "../routeUtils/common.js";

/**
 * One domain-owned writer for the existing Project Research human gates.
 * Workflow Checkpoint Nodes do not own these rows until conditional skip/
 * branching exists and the whole gate path can move without dual authority.
 */
export async function upsertPendingResearchCheckpoint(
  db: Queryable,
  input: {
    spaceId: string;
    projectId: string;
    workflowId: string;
    operationId: string;
    checkpointType: string;
    machineResult: Record<string, unknown>;
  },
): Promise<string> {
  // A checkpoint is one decision point in one operation, so it exists at most
  // once per (workflow, type, operation) — in any status. Matching only
  // *pending* rows meant a reconcile tick firing after the user decided found
  // nothing and minted a second pending gate for work that was already
  // approved: the operation moved on to synthesis while the reviewer was left
  // with a fresh screening gate to approve again.
  const existing = await db.query<{ id: string; status: string }>(
    `SELECT id, status FROM project_research_checkpoints
      WHERE space_id=$1 AND project_id=$2 AND workflow_id=$3
        AND checkpoint_type=$4
        AND machine_result_json->>'operation_id'=$5
      ORDER BY created_at DESC LIMIT 1`,
    [input.spaceId, input.projectId, input.workflowId, input.checkpointType, input.operationId],
  );
  const now = new Date().toISOString();
  // A decided checkpoint keeps its decision and its machine result: the
  // reviewer judged that snapshot, so later ticks must not rewrite it.
  if (existing.rows[0] && existing.rows[0].status !== "pending") return existing.rows[0].id;
  if (existing.rows[0]) {
    await db.query(
      `UPDATE project_research_checkpoints
          SET machine_result_json=$2::jsonb, updated_at=$3
        WHERE id=$1 AND space_id=$4`,
      [existing.rows[0].id, JSON.stringify(input.machineResult), now, input.spaceId],
    );
    return existing.rows[0].id;
  }
  const id = randomUUID();
  await db.query(
    `INSERT INTO project_research_checkpoints (
       id,space_id,project_id,workflow_id,stage_key,checkpoint_type,status,
       machine_result_json,created_at,updated_at
     ) VALUES ($1,$2,$3,$4,$5,$6,'pending',$7::jsonb,$8,$8)`,
    [
      id,
      input.spaceId,
      input.projectId,
      input.workflowId,
      input.checkpointType === "idea_review" ? "idea_review" : "screening",
      input.checkpointType,
      JSON.stringify(input.machineResult),
      now,
    ],
  );
  return id;
}
