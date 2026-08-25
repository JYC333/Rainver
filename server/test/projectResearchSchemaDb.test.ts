import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { useTestDatabase } from "./support/testDatabase";
import { seedSpaceOwnerProject } from "./support/domainSeeds";
import { resetTables } from "./support/resetTables";
import { insertResearchWorkflowFixture } from "./support/researchWorkflow";

// Real-Postgres coverage for the Academic Research schema foundation:
// workflows, checkpoints, scan outcomes, and report FK isolation.

const SPACE = "11111111-1111-4111-8111-111111111111";
const OWNER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const PROJECT = "55555555-5555-4555-8555-555555555555";


const db = useTestDatabase(__filename);

beforeEach(async () => {
  if (!db.available) return;
  await resetTables(
    db.pool,
    ["project_research_reports", "project_research_checkpoints", "project_research_workflows", "artifacts", "projects", "space_memberships", "users", "spaces"],
    { cascade: true },
  );
  await seedSpaceOwnerProject(db.pool, { space: SPACE, owner: OWNER, project: PROJECT });
});

async function insertWorkflow(): Promise<string> {
  const id = randomUUID();
  const now = new Date().toISOString();
  await insertResearchWorkflowFixture(db.pool, {
    id, spaceId: SPACE, projectId: PROJECT, startedByUserId: OWNER, now,
  });
  return id;
}

describe("project_research_* schema (real Postgres)", () => {
  it("stores immutable scan outcomes and rejects duplicate scan keys", async () => {
    if (!db.available) return;
    const workflowId = await insertWorkflow();
    const now = new Date().toISOString();
    const values = [randomUUID(), SPACE, PROJECT, workflowId, "scan:daily:1", now];
    await db.pool.query(
      `INSERT INTO research_scan_summaries (
         id,space_id,project_id,workflow_id,scan_key,scanned_at,new_item_count,relevant_count,maybe_count,excluded_count,created_at
       ) VALUES ($1,$2,$3,$4,$5,$6,7,2,1,4,$6)`,
      values,
    );
    await expect(db.pool.query(
      `INSERT INTO research_scan_summaries (
         id,space_id,project_id,workflow_id,scan_key,scanned_at,created_at
       ) VALUES ($1,$2,$3,$4,$5,$6,$6)`,
      [randomUUID(), SPACE, PROJECT, workflowId, "scan:daily:1", now],
    )).rejects.toThrow();
    await expect(db.pool.query(
      `INSERT INTO research_scan_summaries (
         id,space_id,project_id,workflow_id,scan_key,scanned_at,new_item_count,created_at
       ) VALUES ($1,$2,$3,$4,$5,$6,-1,$6)`,
      [randomUUID(), SPACE, PROJECT, workflowId, "scan:daily:2", now],
    )).rejects.toThrow();
  });

  it("rejects an invalid workflow status", async () => {
    if (!db.available) return;
    const now = new Date().toISOString();
    await expect(
      insertResearchWorkflowFixture(db.pool, {
        id: randomUUID(), spaceId: SPACE, projectId: PROJECT, startedByUserId: OWNER,
        status: "not_a_status", now,
      }),
    ).rejects.toThrow();
  });

  it("creates a checkpoint under a workflow and cascades on workflow delete", async () => {
    if (!db.available) return;
    const workflowId = await insertWorkflow();
    const checkpointId = randomUUID();
    const now = new Date().toISOString();
    await db.pool.query(
      `INSERT INTO project_research_checkpoints (
         id, space_id, project_id, workflow_id, stage_key, checkpoint_type, status, created_at, updated_at
       ) VALUES ($1,$2,$3,$4,'research_setup','other','pending',$5,$5)`,
      [checkpointId, SPACE, PROJECT, workflowId, now],
    );

    await db.pool.query(`DELETE FROM space_objects WHERE id = $1 AND space_id=$2`, [workflowId, SPACE]);
    const remaining = await db.pool.query(`SELECT id FROM project_research_checkpoints WHERE id = $1`, [checkpointId]);
    expect(remaining.rows).toHaveLength(0);
  });

  it("binds every report artifact reference to the report space", async () => {
    if (!db.available) return;
    for (const constraint of [
      "project_research_reports_archive_artifact_id_fkey",
      "project_research_reports_matrix_artifact_id_fkey",
      "project_research_reports_integrity_artifact_id_fkey",
    ]) {
      const columns = await db.pool.query<{ column_name: string }>(
        `SELECT column_name
           FROM information_schema.key_column_usage
          WHERE table_schema='public' AND table_name='project_research_reports' AND constraint_name=$1
          ORDER BY ordinal_position`,
        [constraint],
      );
      expect(columns.rows.map(row => row.column_name)).toEqual([
        constraint.includes("archive") ? "archive_artifact_id" : constraint.includes("matrix") ? "evidence_matrix_artifact_id" : "integrity_artifact_id",
        "space_id",
      ]);
    }
  });

});
