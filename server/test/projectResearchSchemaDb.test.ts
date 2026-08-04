import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { getTestPostgres, type TestPostgresDatabase } from "./support/sharedPostgres";
import { migrate } from "../src/db/migrator";

// Real-Postgres coverage for the Academic Research schema foundation:
// workflows, checkpoints, scan outcomes, and report FK isolation.

const MIGRATIONS_DIR = join(process.cwd(), "migrations");
const SPACE = "11111111-1111-4111-8111-111111111111";
const OWNER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const PROJECT = "55555555-5555-4555-8555-555555555555";

let container: TestPostgresDatabase | undefined;
let pool: Pool | undefined;
let available = false;

beforeAll(async () => {
  try {
    container = await getTestPostgres(__filename);
    pool = new Pool({ connectionString: container.getConnectionUri(), max: 3 });
    await migrate(pool, MIGRATIONS_DIR);
    available = true;
  } catch (err) {
    console.warn(`[project-research-schema-db] skipped — Docker/Postgres unavailable: ${err instanceof Error ? err.message : String(err)}`);
  }
}, 180_000);

afterAll(async () => {
  await pool?.end();
  await container?.stop();
});

beforeEach(async () => {
  if (!available || !pool) return;
  await pool.query(
    `TRUNCATE project_research_reports, project_research_checkpoints, project_research_workflows,
       artifacts, projects, space_memberships, users, spaces CASCADE`,
  );
  const now = new Date().toISOString();
  await pool.query(`INSERT INTO spaces (id, name, type, created_at, updated_at) VALUES ($1,'Main','personal',$2,$2)`, [SPACE, now]);
  await pool.query(`INSERT INTO users (id, display_name, status, created_at, updated_at) VALUES ($1,$1,'active',$2,$2)`, [OWNER, now]);
  await pool.query(
    `INSERT INTO space_memberships (id, space_id, user_id, role, status, created_at, updated_at)
     VALUES ($1,$2,$3,'owner','active',$4,$4)`,
    [randomUUID(), SPACE, OWNER, now],
  );
  await pool.query(
    `INSERT INTO projects (id, space_id, owner_user_id, name, status, created_at, updated_at)
     VALUES ($1,$2,$3,'Research','active',$4,$4)`,
    [PROJECT, SPACE, OWNER, now],
  );
});

async function insertWorkflow(): Promise<string> {
  const id = randomUUID();
  const now = new Date().toISOString();
  await pool!.query(
    `INSERT INTO project_research_workflows (
       id, space_id, project_id, workflow_type, status, mode, created_at, updated_at
     ) VALUES ($1,$2,$3,'literature_review','active','manual',$4,$4)`,
    [id, SPACE, PROJECT, now],
  );
  return id;
}

describe("project_research_* schema (real Postgres)", () => {
  it("stores immutable scan outcomes and rejects duplicate scan keys", async () => {
    if (!available) return;
    const workflowId = await insertWorkflow();
    const now = new Date().toISOString();
    const values = [randomUUID(), SPACE, PROJECT, workflowId, "scan:daily:1", now];
    await pool!.query(
      `INSERT INTO research_scan_summaries (
         id,space_id,project_id,workflow_id,scan_key,scanned_at,new_item_count,relevant_count,maybe_count,excluded_count,created_at
       ) VALUES ($1,$2,$3,$4,$5,$6,7,2,1,4,$6)`,
      values,
    );
    await expect(pool!.query(
      `INSERT INTO research_scan_summaries (
         id,space_id,project_id,workflow_id,scan_key,scanned_at,created_at
       ) VALUES ($1,$2,$3,$4,$5,$6,$6)`,
      [randomUUID(), SPACE, PROJECT, workflowId, "scan:daily:1", now],
    )).rejects.toThrow();
    await expect(pool!.query(
      `INSERT INTO research_scan_summaries (
         id,space_id,project_id,workflow_id,scan_key,scanned_at,new_item_count,created_at
       ) VALUES ($1,$2,$3,$4,$5,$6,-1,$6)`,
      [randomUUID(), SPACE, PROJECT, workflowId, "scan:daily:2", now],
    )).rejects.toThrow();
  });

  it("rejects an invalid workflow status", async () => {
    if (!available) return;
    const now = new Date().toISOString();
    await expect(
      pool!.query(
        `INSERT INTO project_research_workflows (
           id, space_id, project_id, workflow_type, status, mode, created_at, updated_at
         ) VALUES ($1,$2,$3,'literature_review','not_a_status','manual',$4,$4)`,
        [randomUUID(), SPACE, PROJECT, now],
      ),
    ).rejects.toThrow();
  });

  it("creates a checkpoint under a workflow and cascades on workflow delete", async () => {
    if (!available) return;
    const workflowId = await insertWorkflow();
    const checkpointId = randomUUID();
    const now = new Date().toISOString();
    await pool!.query(
      `INSERT INTO project_research_checkpoints (
         id, space_id, project_id, workflow_id, stage_key, checkpoint_type, status, created_at, updated_at
       ) VALUES ($1,$2,$3,$4,'research_setup','other','pending',$5,$5)`,
      [checkpointId, SPACE, PROJECT, workflowId, now],
    );

    await pool!.query(`DELETE FROM project_research_workflows WHERE id = $1`, [workflowId]);
    const remaining = await pool!.query(`SELECT id FROM project_research_checkpoints WHERE id = $1`, [checkpointId]);
    expect(remaining.rows).toHaveLength(0);
  });

  it("binds every report artifact reference to the report space", async () => {
    if (!available) return;
    for (const constraint of [
      "project_research_reports_archive_artifact_id_fkey",
      "project_research_reports_matrix_artifact_id_fkey",
      "project_research_reports_integrity_artifact_id_fkey",
    ]) {
      const columns = await pool!.query<{ column_name: string }>(
        `SELECT column_name
           FROM information_schema.key_column_usage
          WHERE table_schema='public' AND table_name='project_research_reports' AND constraint_name=$1
          ORDER BY ordinal_position`,
        [constraint],
      );
      expect(columns.rows.map(row => row.column_name)).toEqual([
        constraint.includes("archive") ? "archive_artifact_id" : constraint.includes("matrix") ? "literature_matrix_artifact_id" : "integrity_artifact_id",
        "space_id",
      ]);
    }
  });

});
