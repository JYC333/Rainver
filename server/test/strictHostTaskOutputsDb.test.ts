import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { useTestDatabase } from "./support/testDatabase.js";
import { resetTables } from "./support/resetTables.js";
import { buildModuleServer } from "./support/moduleServer.js";
import { loadConfig } from "../src/config.js";
import { runsModule } from "../src/modules/runs/index.js";
import { PgTaskRepository } from "../src/modules/tasks/repository.js";
import { PgHostRepository } from "../src/modules/hosts/repository.js";
import { PgRunToolIdentityRepository } from "../src/modules/runs/runToolIdentityRepository.js";
import { declareRunArtifact } from "../src/modules/projectWork/artifactDeclarations.js";
import { requireProjectTask } from "../src/modules/projectWork/taskActions.js";
import { settleTasksForRun } from "../src/modules/projectWork/settlement.js";
import { resolveAgentActorId } from "../src/db/actorResolver.js";
import { PgRunRepository } from "../src/modules/runs/repository.js";
import { assembleRunInputEnvelope } from "../src/modules/runs/runInputEnvelope.js";
import { workSkillOptionsForRun } from "../src/modules/runs/runWorkSurface.js";
import {
  seedAgentWithVersion,
  seedServerRuntimeProfile,
  seedSpaceOwnerProject,
} from "./support/domainSeeds.js";

/**
 * Real-Postgres coverage for a built-in strict-Host Task Run's outputs.
 *
 * The strict Host uploads `$RAINVER_OUTPUT_DIR` through the same
 * `recordOutputArtifacts` path a paired Host does; nothing on that path is
 * keyed on trust mode. These tests start from the real Task Run admission on
 * a server Location — so the Run is `sandboxed` and bound to the built-in
 * Host exactly as production makes it — and drive the built-in Host's upload
 * (no Host owner) through materialization and settlement.
 */

const SPACE = "71111111-1111-4111-8111-111111111111";
const OWNER = "7aaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const PROJECT = "7bbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const OTHER_PROJECT = "7bbbbbbb-bbbb-4bbb-8bbb-cccccccccccc";
const AGENT = "7ccccccc-cccc-4ccc-8ccc-cccccccccccc";
const VERSION = "7ddddddd-dddd-4ddd-8ddd-dddddddddddd";
const HOST = "7eeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const FOLDER = "7fffffff-ffff-4fff-8fff-ffffffffffff";
const LOCATION = "70000000-0000-4000-8000-000000000001";
const TASK = "70000000-0000-4000-8000-000000000002";

const db = useTestDatabase(import.meta.filename);
let app: FastifyInstance | undefined;

beforeAll(async () => {
  if (!db.available) return;
  app = buildModuleServer(loadConfig({ SERVER_DATABASE_URL: db.connectionUri }), [runsModule]);
});

afterAll(async () => {
  await app?.close();
});

beforeEach(async () => {
  if (!db.available) return;
  await resetTables(db.pool, [
    "run_artifact_declarations", "run_tool_identities", "project_work_events", "task_evaluations",
    "task_artifacts", "run_finalizations", "run_attempts", "task_runs", "tasks", "artifacts", "runs",
    "agent_runtime_profiles", "workspace_locations", "project_folders", "actors",
    "agent_versions", "agents", "projects", "hosts", "machines", "space_memberships", "users", "spaces",
  ], { cascade: true });
  const { now } = await seedSpaceOwnerProject(db.pool, { space: SPACE, owner: OWNER, project: PROJECT });
  await db.pool.query(
    `INSERT INTO projects (id, space_id, owner_user_id, name, status, created_at, updated_at)
     VALUES ($1, $2, $3, 'Other', 'active', $4, $4)`,
    [OTHER_PROJECT, SPACE, OWNER, now],
  );
  await seedAgentWithVersion(db.pool, {
    agent: AGENT, version: VERSION, space: SPACE, owner: OWNER, seedDefaultRuntimeProfile: false, now,
  });
  await db.pool.query(
    `INSERT INTO project_folders (id, space_id, project_id, name, kind, status, protected, system_managed, created_at, updated_at)
     VALUES ($1, $2, $3, 'repo', 'code', 'active', false, false, $4, $4)`,
    [FOLDER, SPACE, PROJECT, now],
  );
  // The built-in Host: `kind = 'server'`, no owner.
  await seedServerRuntimeProfile(db.pool, { agent: AGENT, space: SPACE, hostId: HOST, runtimeKey: "claude_code", now });
  await db.pool.query(
    `INSERT INTO workspace_locations (id, space_id, project_folder_id, execution_host_id, execution_host_kind,
       root_path, display_path, execution_ready, status, created_at, updated_at)
     VALUES ($1, $2, $3, $4, 'server', '/srv/repo', '/srv/repo', true, 'active', $5, $5)`,
    [LOCATION, SPACE, FOLDER, HOST, now],
  );
  await db.pool.query(
    `INSERT INTO tasks (id, space_id, project_id, project_folder_id, title, status, required_outputs_json,
       created_by_user_id, owner_user_id, created_at, updated_at)
     VALUES ($1, $2, $3, $4, 'Write the report', 'ready', '["report"]'::jsonb, $5, $5, $6, $6)`,
    [TASK, SPACE, PROJECT, FOLDER, OWNER, now],
  );
});

/** A Task Run admitted the way a person starts one, with one open attempt on the built-in Host. */
async function admitStrictRun(): Promise<{ runId: string; launchId: string }> {
  const run = await new PgTaskRepository(db.pool).createTaskRun({ spaceId: SPACE, userId: OWNER }, TASK, { agent_id: AGENT });
  const runId = String(run.id);
  const launchId = randomUUID();
  // What routing writes when it binds the requested Profile, then the launch.
  await db.pool.query(
    `UPDATE runs r SET status = 'running', started_at = now(),
            runtime_profile_id = p.id, runtime_key = p.runtime_key,
            runtime_profile_selection_source = COALESCE(r.runtime_profile_selection_source, 'default'),
            runtime_profile_snapshot_json = jsonb_build_object('id', p.id, 'runtime_key', p.runtime_key,
              'execution_host_id', p.execution_host_id)
       FROM agent_runtime_profiles p
      WHERE r.id = $1 AND p.id = r.requested_runtime_profile_id`,
    [runId],
  );
  // Admission opened attempt 1; the launch frame carries its nonce.
  const attempt = await db.pool.query(
    `UPDATE run_attempts SET status = 'running', launch_id = $2, started_at = now()
      WHERE run_id = $1 AND attempt_number = 1 RETURNING id`,
    [runId, launchId],
  );
  expect(attempt.rows).toHaveLength(1);
  return { runId, launchId };
}

async function declare(runId: string, path: string, artifactType: string): Promise<void> {
  await declareRunArtifact(db.pool, {
    spaceId: SPACE,
    actorId: await resolveAgentActorId(db.pool, SPACE, AGENT),
    agentId: AGENT,
    runId,
    instructedByUserId: OWNER,
    projectId: PROJECT,
    idempotencyKey: `${runId}:1:${path}`,
  }, { id: TASK, project_id: PROJECT }, { path, artifact_type: artifactType, role: "output" });
}

async function finishAccepted(runId: string): Promise<void> {
  await db.pool.query(
    `INSERT INTO run_finalizations (id, space_id, run_id, attempt_number, finalizer_version, status, finalized_at, created_at)
     VALUES ($1, $2, $3, 1, 'test', 'completed', now(), now())`,
    [randomUUID(), SPACE, runId],
  );
  await db.pool.query(
    `INSERT INTO task_evaluations (id, space_id, task_id, run_id, evaluator_type, recommendation, created_at)
     VALUES ($1, $2, $3, $4, 'system', 'accept', now())`,
    [randomUUID(), SPACE, TASK, runId],
  );
  await db.pool.query(`UPDATE runs SET status = 'succeeded' WHERE id = $1`, [runId]);
  await settleTasksForRun(db.pool, SPACE, runId);
}

describe("a strict-Host Task Run's collected outputs", () => {
  it("is a sandboxed Run bound to the built-in Host, with a work surface that delivers outputs", async (ctx) => {
    if (!db.available) return ctx.skip();
    const { runId } = await admitStrictRun();
    const row = await db.pool.query<{ trust_mode: string; workspace_location_id: string }>(
      `SELECT trust_mode, workspace_location_id FROM runs WHERE id = $1`, [runId],
    );
    expect(row.rows[0]).toEqual({ trust_mode: "sandboxed", workspace_location_id: LOCATION });
    // Granted tools are what makes the Host adapter build a work surface (the
    // `rainver` command); the delivery section follows `artifact.submit`.
    const run = (await new PgRunRepository(db.pool).getRun(SPACE, runId))!;
    expect(assembleRunInputEnvelope(run).tool_grants.length).toBeGreaterThan(0);
    expect(workSkillOptionsForRun(run)).toMatchObject({ conversation: false, deliverOutputs: true });
  });

  it("gives a declared upload its declared type, its Task link and the Run's provenance", async (ctx) => {
    if (!db.available) return ctx.skip();
    const { runId, launchId } = await admitStrictRun();
    await declare(runId, "./out/report.md", "report");

    // The built-in Host has no owner; the uploader passes null.
    const outcome = await new PgHostRepository(db.pool).recordOutputArtifacts(HOST, null, runId, {
      launch_id: launchId,
      files: [{ name: "out/report.md", content: "# Report" }, { name: "scratch.txt", content: "notes" }],
    });
    expect(outcome.ok).toBe(true);

    const artifacts = await db.pool.query<{
      title: string; artifact_type: string; run_id: string; owner_user_id: string; project_id: string;
      project_folder_id: string; visibility: string; metadata_json: Record<string, unknown>;
    }>(
      `SELECT title, artifact_type, run_id, owner_user_id, project_id, project_folder_id, visibility, metadata_json
         FROM artifacts WHERE run_id = $1 ORDER BY title`,
      [runId],
    );
    expect(artifacts.rows).toEqual([
      expect.objectContaining({
        title: "out/report.md", artifact_type: "report", run_id: runId, owner_user_id: OWNER,
        project_id: PROJECT, project_folder_id: FOLDER, visibility: "space_shared",
        metadata_json: expect.objectContaining({ launch_id: launchId, source_filename: "out/report.md" }),
      }),
      // Undeclared: kept, but untyped and linked to no Task.
      expect.objectContaining({ title: "scratch.txt", artifact_type: "remote_output" }),
    ]);
    const links = await db.pool.query<{ title: string; role: string; run_id: string }>(
      `SELECT a.title, ta.role, ta.run_id FROM task_artifacts ta JOIN artifacts a ON a.id = ta.artifact_id
        WHERE ta.task_id = $1`,
      [TASK],
    );
    expect(links.rows).toEqual([{ title: "out/report.md", role: "output", run_id: runId }]);

    await finishAccepted(runId);
    const task = await db.pool.query<{ status: string }>(`SELECT status FROM tasks WHERE id = $1`, [TASK]);
    expect(task.rows[0]!.status).toBe("done");
  });

  it("holds the Task and reports the gap when a declared output never arrived", async (ctx) => {
    if (!db.available) return ctx.skip();
    const { runId, launchId } = await admitStrictRun();
    await declare(runId, "report.md", "report");

    await new PgHostRepository(db.pool).recordOutputArtifacts(HOST, null, runId, {
      launch_id: launchId,
      files: [{ name: "other.md", content: "not the report" }],
    });
    await finishAccepted(runId);

    const task = await db.pool.query<{ status: string }>(`SELECT status FROM tasks WHERE id = $1`, [TASK]);
    expect(task.rows[0]!.status).toBe("waiting_for_review");
    const events = await db.pool.query<{ event_kind: string; data_json: Record<string, unknown> }>(
      `SELECT event_kind, data_json FROM project_work_events
        WHERE space_id = $1 AND subject_id = $2 AND event_kind IN ('task.reported', 'task.run_settled')
        ORDER BY created_at, event_kind`,
      [SPACE, TASK],
    );
    expect(events.rows).toEqual(expect.arrayContaining([
      expect.objectContaining({
        event_kind: "task.reported",
        data_json: expect.objectContaining({ outcome: "stuck", summary: expect.stringContaining("report.md") }),
      }),
      expect.objectContaining({
        event_kind: "task.run_settled",
        data_json: expect.objectContaining({ reason: "required_outputs_missing", missing_required_outputs: ["report"] }),
      }),
    ]));
  });

  it("refuses a declaration against a Task outside the Run's Project", async (ctx) => {
    if (!db.available) return ctx.skip();
    // `artifact.submit` resolves its Task through `requireProjectTask` with the
    // Run's Project; a Task of another Project is not found rather than linked.
    const foreign = randomUUID();
    await db.pool.query(
      `INSERT INTO tasks (id, space_id, project_id, title, status, created_by_user_id, owner_user_id, created_at, updated_at)
       VALUES ($1, $2, $3, 'Elsewhere', 'ready', $4, $4, now(), now())`,
      [foreign, SPACE, OTHER_PROJECT, OWNER],
    );
    await expect(requireProjectTask(db.pool, SPACE, foreign, OWNER, PROJECT)).rejects.toThrow();
  });

  it("lets the strict-Host Task Run declare its output, which the upload then materializes", async (ctx) => {
    if (!db.available) return ctx.skip();
    const { runId, launchId } = await admitStrictRun();
    const snapshot = await db.pool.query<{ permission_snapshot_json: { tool_grants: Array<{ action_id: string }> } }>(
      `SELECT permission_snapshot_json FROM runs WHERE id = $1`, [runId],
    );
    expect(snapshot.rows[0]!.permission_snapshot_json.tool_grants.map((grant) => grant.action_id))
      .toEqual(expect.arrayContaining(["task.list", "task.report", "artifact.submit"]));
    const token = await new PgRunToolIdentityRepository(db.pool).issue({ id: runId, space_id: SPACE }, 60_000, "hash");

    const response = await app!.inject({
      method: "POST",
      url: `/api/v1/runs/${runId}/tools/artifact.submit`,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      payload: { task_id: TASK, path: "report.md", artifact_type: "report" },
    });

    expect(response.json()).toMatchObject({ ok: true });
    const declarations = await db.pool.query(
      `SELECT task_id, path, artifact_type, role FROM run_artifact_declarations WHERE run_id = $1`, [runId],
    );
    expect(declarations.rows).toEqual([{ task_id: TASK, path: "report.md", artifact_type: "report", role: "output" }]);

    await new PgHostRepository(db.pool).recordOutputArtifacts(HOST, null, runId, {
      launch_id: launchId,
      files: [{ name: "report.md", content: "# Report" }],
    });
    const links = await db.pool.query<{ artifact_type: string; role: string; run_id: string }>(
      `SELECT a.artifact_type, ta.role, ta.run_id FROM task_artifacts ta JOIN artifacts a ON a.id = ta.artifact_id
        WHERE ta.task_id = $1`,
      [TASK],
    );
    expect(links.rows).toEqual([{ artifact_type: "report", role: "output", run_id: runId }]);
  });

  it("refuses an action outside the dispatch allowance", async (ctx) => {
    if (!db.available) return ctx.skip();
    const { runId } = await admitStrictRun();
    const token = await new PgRunToolIdentityRepository(db.pool).issue({ id: runId, space_id: SPACE }, 60_000, "hash");

    const response = await app!.inject({
      method: "POST",
      url: `/api/v1/runs/${runId}/tools/memory.remember`,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      payload: { content: "remember this", rationale: "because" },
    });

    expect(response.json()).toMatchObject({ ok: false, error_code: "system_action_not_granted" });
  });
});
