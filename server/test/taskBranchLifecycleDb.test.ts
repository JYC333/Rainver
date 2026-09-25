import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import type { HostServerFrame } from "@rainver/protocol";
import { useTestDatabase } from "./support/testDatabase.js";
import { resetTables } from "./support/resetTables.js";
import { seedAgentWithVersion, seedSpaceOwnerProject } from "./support/domainSeeds.js";
import { loadConfig } from "../src/config.js";
import { HostConnectionRegistry } from "../src/modules/hosts/connectionRegistry.js";
import { registerTaskBranchJobHandlers, wakeTaskBranchJobs } from "../src/modules/hosts/taskBranchJobs.js";
import { TASK_BRANCH_DELETE_JOB, TASK_BUSY, TASK_RUN_SETTLE_JOB } from "../src/modules/hosts/taskBranchRequests.js";
import { PgTaskRunSettler } from "../src/modules/runs/taskRunSettlement.js";
import { JobHandlerRegistry } from "../src/modules/jobs/handlerRegistry.js";
import { PgJobQueueRepository } from "../src/modules/jobs/repository.js";
import { JobWorker } from "../src/modules/jobs/worker.js";
import { taskRunAhead } from "../src/modules/runs/agentRunHandler.js";
import { PgRunRepository } from "../src/modules/runs/repository.js";
import { PgTaskRepository } from "../src/modules/tasks/repository.js";

/**
 * ADR 0016 §11 on the control plane's side: a Task's execution Runs share its
 * worktree and branch, so they run one at a time; and a Task that ends
 * without being done leaves no branch on the Locations its Runs worked on —
 * durably, since the host may be offline when it ends.
 */
const SPACE = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OWNER = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const PROJECT = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const FOLDER = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const LOCATION = "11111111-1111-4111-8111-111111111111";
const MACHINE = "22222222-2222-4222-8222-222222222222";
const HOST = "33333333-3333-4333-8333-333333333333";
const TASK = "44444444-4444-4444-8444-444444444444";
const AGENT = "55555555-5555-4555-8555-555555555555";
const VERSION = "66666666-6666-4666-8666-666666666666";

const db = useTestDatabase(import.meta.filename);
const owner = { spaceId: SPACE, userId: OWNER };
let profileId = "";

beforeEach(async () => {
  if (!db.available) return;
  await resetTables(
    db.pool,
    ["jobs", "task_runs", "runs", "workspace_locations", "project_folders", "tasks", "agent_runtime_profiles", "agents", "agent_versions", "rooms", "projects", "hosts", "machines", "space_memberships", "users", "spaces"],
    { cascade: true },
  );
  const { now } = await seedSpaceOwnerProject(db.pool, { space: SPACE, owner: OWNER, project: PROJECT });
  await db.pool.query(
    `INSERT INTO project_folders (id, space_id, project_id, name, kind, status, protected, system_managed, created_at, updated_at)
     VALUES ($1, $2, $3, 'repo', 'code', 'active', false, false, $4, $4)`,
    [FOLDER, SPACE, PROJECT, now],
  );
  await db.pool.query(
    `INSERT INTO machines (id, owner_user_id, display_name, device_kind, created_at, updated_at)
     VALUES ($1, $2, 'Test machine', 'desktop', $3, $3)`,
    [MACHINE, OWNER, now],
  );
  await db.pool.query(
    `INSERT INTO hosts (id, owner_user_id, machine_id, name, kind, environment_kind, status, capabilities_json, created_at, updated_at)
     VALUES ($1, $2, $3, 'Test host', 'remote', 'linux_native', 'online', '{}'::jsonb, $4, $4)`,
    [HOST, OWNER, MACHINE, now],
  );
  await db.pool.query(
    `INSERT INTO workspace_locations (id, space_id, project_folder_id, execution_host_id, execution_host_kind,
       display_path, execution_ready, status, created_at, updated_at)
     VALUES ($1, $2, $3, $4, 'remote', '/workspace/repo', true, 'active', $5, $5)`,
    [LOCATION, SPACE, FOLDER, HOST, now],
  );
  await db.pool.query(
    `INSERT INTO tasks (id, space_id, project_id, project_folder_id, title, status, created_by_user_id, created_at, updated_at)
     VALUES ($1, $2, $3, $4, 'Fix the parser', 'ready', $5, $6, $6)`,
    [TASK, SPACE, PROJECT, FOLDER, OWNER, now],
  );
  await seedAgentWithVersion(db.pool, { agent: AGENT, version: VERSION, space: SPACE, owner: OWNER, now });
  const profile = await db.pool.query<{ id: string }>(
    `SELECT id FROM agent_runtime_profiles WHERE agent_id = $1 AND is_default = TRUE`,
    [AGENT],
  );
  profileId = profile.rows[0]!.id;
});

async function insertRun(input: {
  status: string;
  runType?: string;
  sandbox?: string;
  taskId?: string;
  createdAt?: string;
}): Promise<string> {
  const id = randomUUID();
  const now = input.createdAt ?? new Date().toISOString();
  await db.pool.query(
    `INSERT INTO runs (
       id, space_id, agent_id, agent_version_id, run_type, trigger_origin, status, mode,
       runtime_profile_id, runtime_profile_selection_source, runtime_key, runtime_profile_snapshot_json,
       owner_user_id, visibility, created_at, updated_at, execution_kind,
       project_folder_id, workspace_location_id, required_sandbox_level, contract_snapshot_json
     ) VALUES ($1,$2,$3,$4,$5,'manual',$6,'live',$7,'default','claude_code','{}'::jsonb,
       $8,'space_shared',$9,$9,'agent',$10,$11,$12,$13::jsonb)`,
    [
      id, SPACE, AGENT, VERSION, input.runType ?? "agent", input.status, profileId, OWNER, now,
      FOLDER, LOCATION, input.sandbox ?? "worktree",
      JSON.stringify({ source: { kind: "task", id: input.taskId ?? TASK } }),
    ],
  );
  await db.pool.query(
    `INSERT INTO task_runs (id, space_id, task_id, run_id, role, created_at) VALUES ($1, $2, $3, $4, 'primary', $5)`,
    [randomUUID(), SPACE, input.taskId ?? TASK, id, now],
  );
  return id;
}

async function readRun(id: string) {
  return (await new PgRunRepository(db.pool).getRun(SPACE, id))!;
}

describe("a Task's execution Runs run one at a time", () => {
  it("holds a later execution Run while an earlier one is running or parked", async (ctx) => {
    if (!db.available) return ctx.skip();
    const earlier = await insertRun({ status: "running" });
    const later = await insertRun({ status: "queued" });
    await expect(taskRunAhead(db.pool, await readRun(later))).resolves.toBe(true);

    await db.pool.query(`UPDATE runs SET status = 'waiting_for_dependency' WHERE id = $1`, [earlier]);
    await expect(taskRunAhead(db.pool, await readRun(later))).resolves.toBe(true);

    await db.pool.query(`UPDATE runs SET status = 'succeeded' WHERE id = $1`, [earlier]);
    await expect(taskRunAhead(db.pool, await readRun(later))).resolves.toBe(false);
  });

  it("does not hold a Run for a planning or read-only Run, another Task's Run, or itself", async (ctx) => {
    if (!db.available) return ctx.skip();
    await insertRun({ status: "running", runType: "planning" });
    await insertRun({ status: "running", sandbox: "read_only" });
    const otherTask = await new PgTaskRepository(db.pool).createTask(owner, { project_id: PROJECT, title: "Other", visibility: "space_shared" });
    await insertRun({ status: "running", taskId: otherTask.id as string });
    const running = await insertRun({ status: "running" });
    const later = await insertRun({ status: "queued" });
    const readOnly = await insertRun({ status: "queued", sandbox: "read_only" });

    await expect(taskRunAhead(db.pool, await readRun(running))).resolves.toBe(false);
    await expect(taskRunAhead(db.pool, await readRun(readOnly))).resolves.toBe(false);
    await expect(taskRunAhead(db.pool, await readRun(later))).resolves.toBe(true);
  });
});

describe("the order two execution Runs of one Task agree on", () => {
  async function agentRunJob(runId: string) {
    await db.pool.query(
      `INSERT INTO jobs (id, space_id, user_id, job_type, status, priority, payload_json, attempts, max_attempts, scheduled_at, created_at, updated_at)
       VALUES ($1, $2, $3, 'agent_run', 'pending', 0, $4::jsonb, 0, 3, now(), now(), now())`,
      [randomUUID(), SPACE, OWNER, JSON.stringify({ run_id: runId })],
    );
  }

  it("lets the Run admitted first go, and holds the later one, when both are queued", async (ctx) => {
    if (!db.available) return ctx.skip();
    const first = await insertRun({ status: "queued", createdAt: "2026-09-24T10:00:00.000Z" });
    const second = await insertRun({ status: "queued", createdAt: "2026-09-24T10:00:01.000Z" });
    await agentRunJob(first);
    await agentRunJob(second);
    await expect(taskRunAhead(db.pool, await readRun(first))).resolves.toBe(false);
    await expect(taskRunAhead(db.pool, await readRun(second))).resolves.toBe(true);
  });

  it("puts a Run that already started, resuming from a pause, ahead of an older one that never started", async (ctx) => {
    if (!db.available) return ctx.skip();
    const older = await insertRun({ status: "queued", createdAt: "2026-09-24T10:00:00.000Z" });
    const resumed = await insertRun({ status: "queued", createdAt: "2026-09-24T10:00:01.000Z" });
    await db.pool.query(`UPDATE runs SET started_at = now() WHERE id = $1`, [resumed]);
    await agentRunJob(older);
    await agentRunJob(resumed);
    await expect(taskRunAhead(db.pool, await readRun(resumed))).resolves.toBe(false);
    await expect(taskRunAhead(db.pool, await readRun(older))).resolves.toBe(true);
  });

  it("does not wait on a queued Run nobody dispatched, or on a failed Run a supervisor holds for review", async (ctx) => {
    if (!db.available) return ctx.skip();
    await insertRun({ status: "queued", createdAt: "2026-09-24T10:00:00.000Z" });
    const held = await insertRun({ status: "waiting_for_review", createdAt: "2026-09-24T10:00:00.500Z" });
    await db.pool.query(`UPDATE runs SET error_json = '{"supervisor_review": true}'::jsonb WHERE id = $1`, [held]);
    const later = await insertRun({ status: "queued", createdAt: "2026-09-24T10:00:01.000Z" });
    await expect(taskRunAhead(db.pool, await readRun(later))).resolves.toBe(false);

    // A Run parked on its own authorization request has not ended.
    await db.pool.query(`UPDATE runs SET error_json = NULL WHERE id = $1`, [held]);
    await expect(taskRunAhead(db.pool, await readRun(later))).resolves.toBe(true);
  });

  it("waits while an earlier Run's settle is still owed to its host", async (ctx) => {
    if (!db.available) return ctx.skip();
    const later = await insertRun({ status: "queued" });
    await db.pool.query(
      `INSERT INTO jobs (id, space_id, user_id, job_type, status, priority, payload_json, attempts, max_attempts, scheduled_at, created_at, updated_at)
       VALUES ($1, $2, $3, $4, 'pending', 0, $5::jsonb, 0, 3, now(), now(), now())`,
      [randomUUID(), SPACE, OWNER, TASK_RUN_SETTLE_JOB, JSON.stringify({ task_id: TASK, workspace_location_id: LOCATION })],
    );
    await expect(taskRunAhead(db.pool, await readRun(later))).resolves.toBe(true);
  });
});

describe("a settle its host did not answer", () => {
  const workspace = { kind: "location" as const, workspace_location_id: LOCATION, worktree: { task_id: TASK } };

  it("is retried by a job that waits for the Run's publication and records the answer on the Run", async (ctx) => {
    if (!db.available) return ctx.skip();
    const runId = await insertRun({ status: "running" });
    const offline = new HostConnectionRegistry();
    const settled = await new PgTaskRunSettler(db.pool, offline).settle({
      run: { id: runId, space_id: SPACE, agent_id: AGENT, instructed_by_user_id: OWNER },
      taskId: TASK,
      hostId: HOST,
      workspace,
      outcome: "succeeded",
      summary: "Done. token=sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789",
    });
    expect(settled).toEqual({ branch: null, commit: null, error: "host_offline", retrying: true });
    const job = (await db.pool.query<{ payload_json: { frame: { message: string } } }>(
      `SELECT payload_json FROM jobs WHERE job_type = $1`, [TASK_RUN_SETTLE_JOB],
    )).rows[0]!;
    expect(job.payload_json.frame.message).toContain("Fix the parser");
    expect(job.payload_json.frame.message).not.toContain("sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789");
    await db.pool.query(`UPDATE jobs SET scheduled_at = now() - interval '1 second' WHERE job_type = $1`, [TASK_RUN_SETTLE_JOB]);

    const hosts = new HostConnectionRegistry();
    hosts.registerConnection(HOST, {
      send(frame) {
        if (frame.type !== "task_run_settle") return;
        queueMicrotask(() => hosts.receiveTaskBranchResult(HOST, "task_run_settle_result", frame.request_id, {
          ok: true, branch: `rainver/task-${TASK}`, commit: "c".repeat(40), error: null,
        }));
      },
      close() {},
    });
    const registry = new JobHandlerRegistry();
    registerTaskBranchJobHandlers(registry, loadConfig({ SERVER_DATABASE_URL: db.connectionUri, SERVER_INTERNAL_TOKEN: "test" }), hosts);
    const worker = new JobWorker(new PgJobQueueRepository(db.pool), registry, "test-worker", [TASK_RUN_SETTLE_JOB]);
    await expect(worker.processOne()).resolves.toMatchObject({ status: "deferred" });

    await db.pool.query(
      `UPDATE runs SET status = 'succeeded', output_json = '{"schema_version":"run_output.v1","result":{"task_branch":{"branch":null,"commit":null,"error":"host_offline"}}}'::jsonb WHERE id = $1`,
      [runId],
    );
    await db.pool.query(`UPDATE jobs SET scheduled_at = now() - interval '1 second' WHERE job_type = $1`, [TASK_RUN_SETTLE_JOB]);
    await expect(worker.processOne()).resolves.toMatchObject({ status: "completed" });
    const run = await db.pool.query<{ output_json: { result: { task_branch: unknown } } }>(`SELECT output_json FROM runs WHERE id = $1`, [runId]);
    expect(run.rows[0]!.output_json.result.task_branch).toEqual({ branch: `rainver/task-${TASK}`, commit: "c".repeat(40), error: null });
  });
});

describe("a settle owed to a host that is gone for good", () => {
  it("gives up as location_unavailable instead of holding the Task", async (ctx) => {
    if (!db.available) return ctx.skip();
    const runId = await insertRun({ status: "succeeded" });
    await db.pool.query(
      `UPDATE runs SET output_json = '{"schema_version":"run_output.v1","result":{}}'::jsonb WHERE id = $1`,
      [runId],
    );
    await db.pool.query(`UPDATE hosts SET status = 'revoked' WHERE id = $1`, [HOST]);
    await db.pool.query(
      `INSERT INTO jobs (id, space_id, user_id, job_type, status, priority, payload_json, attempts, max_attempts, scheduled_at, created_at, updated_at)
       VALUES ($1, $2, $3, $4, 'pending', 0, $5::jsonb, 0, 3, now() - interval '1 second', now(), now())`,
      [randomUUID(), SPACE, OWNER, TASK_RUN_SETTLE_JOB, JSON.stringify({
        run_id: runId, task_id: TASK, workspace_location_id: LOCATION, host_id: HOST,
        frame: {
          workspace: { kind: "location", workspace_location_id: LOCATION, worktree: { task_id: TASK } },
          run_id: runId, author: { name: "A", email: "a@b" }, message: "m",
        },
      })],
    );
    const registry = new JobHandlerRegistry();
    registerTaskBranchJobHandlers(registry, loadConfig({ SERVER_DATABASE_URL: db.connectionUri, SERVER_INTERNAL_TOKEN: "test" }), new HostConnectionRegistry());
    const worker = new JobWorker(new PgJobQueueRepository(db.pool), registry, "test-worker", [TASK_RUN_SETTLE_JOB]);
    await expect(worker.processOne()).resolves.toMatchObject({ status: "completed" });
    const run = await db.pool.query<{ output_json: { result: { task_branch: unknown } } }>(`SELECT output_json FROM runs WHERE id = $1`, [runId]);
    expect(run.rows[0]!.output_json.result.task_branch).toEqual({ branch: null, commit: null, error: "location_unavailable" });
  });
});

describe("a Task that ends without being done loses its branch", () => {
  function fakeHost(reply: { ok: boolean; deleted: boolean; error: string | null } | null) {
    const registry = new HostConnectionRegistry();
    const sent: HostServerFrame[] = [];
    if (reply) {
      registry.registerConnection(HOST, {
        send(frame) {
          sent.push(frame);
          if (frame.type === "task_branch_delete") {
            queueMicrotask(() => registry.receiveTaskBranchResult(HOST, "task_branch_delete_result", frame.request_id, reply));
          }
        },
        close() {},
      });
    }
    return { registry, sent };
  }

  function worker(hosts: HostConnectionRegistry): JobWorker {
    const registry = new JobHandlerRegistry();
    registerTaskBranchJobHandlers(registry, loadConfig({ SERVER_DATABASE_URL: db.connectionUri, SERVER_INTERNAL_TOKEN: "test" }), hosts);
    return new JobWorker(new PgJobQueueRepository(db.pool), registry, "test-worker", [TASK_BRANCH_DELETE_JOB]);
  }

  async function deleteJobs() {
    return (await db.pool.query<{ id: string; status: string; attempts: number; scheduled_at: Date; payload_json: Record<string, unknown> }>(
      `SELECT id, status, attempts, scheduled_at, payload_json FROM jobs WHERE job_type = $1`,
      [TASK_BRANCH_DELETE_JOB],
    )).rows;
  }

  it("enqueues one delete per Location on cancel, and the host is asked to delete that Task's branch", async (ctx) => {
    if (!db.available) return ctx.skip();
    await insertRun({ status: "succeeded" });
    await insertRun({ status: "failed" });
    await new PgTaskRepository(db.pool).updateTask(owner, TASK, { status: "cancelled" });

    const jobs = await deleteJobs();
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.payload_json).toEqual({ task_id: TASK, workspace_location_id: LOCATION, host_id: HOST });

    const host = fakeHost({ ok: true, deleted: true, error: null });
    await expect(worker(host.registry).processOne()).resolves.toMatchObject({ status: "completed" });
    expect(host.sent).toEqual([expect.objectContaining({
      type: "task_branch_delete",
      workspace: { kind: "location", workspace_location_id: LOCATION, worktree: { task_id: TASK } },
    })]);
  });

  it("enqueues on delete too, and nothing for a Task whose Runs never touched a Location", async (ctx) => {
    if (!db.available) return ctx.skip();
    const tasks = new PgTaskRepository(db.pool);
    await tasks.updateTask(owner, TASK, { deleted_at: new Date().toISOString() });
    expect(await deleteJobs()).toEqual([]);

    const other = await tasks.createTask(owner, { project_id: PROJECT, title: "Other", visibility: "space_shared" });
    await insertRun({ status: "succeeded", taskId: other.id as string });
    await tasks.updateTask(owner, other.id as string, { deleted_at: new Date().toISOString() });
    expect((await deleteJobs()).map((job) => job.payload_json.task_id)).toEqual([other.id]);
  });

  it("waits for an offline host without spending an attempt, and runs when it reconnects", async (ctx) => {
    if (!db.available) return ctx.skip();
    await insertRun({ status: "succeeded" });
    await new PgTaskRepository(db.pool).updateTask(owner, TASK, { status: "cancelled" });

    await expect(worker(fakeHost(null).registry).processOne()).resolves.toMatchObject({ status: "deferred" });
    const [deferred] = await deleteJobs();
    expect(deferred).toMatchObject({ status: "pending", attempts: 0 });
    expect(deferred!.scheduled_at.getTime()).toBeGreaterThan(Date.now() + 60_000);

    await wakeTaskBranchJobs(db.pool, HOST);
    const [woken] = await deleteJobs();
    expect(woken!.scheduled_at.getTime()).toBeLessThanOrEqual(Date.now());
  });

  it("is not held by a queued Run nobody dispatched", async (ctx) => {
    if (!db.available) return ctx.skip();
    await insertRun({ status: "queued" });
    await new PgTaskRepository(db.pool).updateTask(owner, TASK, { status: "cancelled" });
    const host = fakeHost({ ok: true, deleted: true, error: null });
    await expect(worker(host.registry).processOne()).resolves.toMatchObject({ status: "completed" });
    expect(host.sent).toHaveLength(1);
  });

  it("waits, without spending an attempt, while the Task is busy on its host", async (ctx) => {
    if (!db.available) return ctx.skip();
    await insertRun({ status: "succeeded" });
    await new PgTaskRepository(db.pool).updateTask(owner, TASK, { status: "cancelled" });
    await expect(worker(fakeHost({ ok: false, deleted: false, error: TASK_BUSY }).registry).processOne())
      .resolves.toMatchObject({ status: "deferred" });
    expect((await deleteJobs())[0]).toMatchObject({ status: "pending", attempts: 0 });
  });

  it("waits while a Run of the Task has not ended, and skips a Task that was reopened", async (ctx) => {
    if (!db.available) return ctx.skip();
    const live = await insertRun({ status: "running" });
    const tasks = new PgTaskRepository(db.pool);
    await tasks.updateTask(owner, TASK, { status: "cancelled" });
    const host = fakeHost({ ok: true, deleted: true, error: null });

    await expect(worker(host.registry).processOne()).resolves.toMatchObject({ status: "deferred" });
    expect(host.sent).toEqual([]);

    await db.pool.query(`UPDATE runs SET status = 'cancelled' WHERE id = $1`, [live]);
    await tasks.updateTask(owner, TASK, { status: "ready" });
    await db.pool.query(`UPDATE jobs SET scheduled_at = now() - interval '1 second' WHERE job_type = $1`, [TASK_BRANCH_DELETE_JOB]);
    await expect(worker(host.registry).processOne()).resolves.toMatchObject({ status: "completed" });
    expect(host.sent).toEqual([]);
  });
});
