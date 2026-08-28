import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { useTestDatabase } from "./support/testDatabase.js";
import { resetTables } from "./support/resetTables.js";
import { projectTaskStatusFromRun } from "../src/modules/tasks/taskRunStatusProjection.js";
import { PgTaskRepository } from "../src/modules/tasks/repository.js";

/**
 * Real-Postgres coverage for Run settlement.
 *
 * The decision table itself is unit-tested in `projectWorkContracts.test.ts`.
 * What needs a database is the selection around it: which Task is settleable,
 * which Run counts as the current one, and that the events and the Loop fold
 * land in the same transaction as the status.
 */

const SPACE = "31111111-1111-4111-8111-111111111111";
const USER = "3aaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const PROJECT = "3bbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const AGENT = "3ccccccc-cccc-4ccc-8ccc-cccccccccccc";
const VERSION = "3ddddddd-dddd-4ddd-8ddd-dddddddddddd";

const db = useTestDatabase(import.meta.filename);

async function makeTask(taskId: string, extra: { requiredOutputs?: unknown } = {}): Promise<void> {
  await db.pool!.query(
    `INSERT INTO tasks (
       id, space_id, project_id, title, status, required_outputs_json,
       created_by_user_id, owner_user_id, created_at, updated_at
     ) VALUES ($1, $2, $3, 'Work item', 'in_progress', $4::jsonb, $5, $5, now(), now())`,
    [taskId, SPACE, PROJECT, JSON.stringify(extra.requiredOutputs ?? null), USER],
  );
}

/**
 * Settlement only counts a Run once finalization has recorded it — that is
 * when the evaluation exists and the Supervisor has decided retry-or-hold.
 * Tests that mean "this Run is really over" say so explicitly.
 */
async function finalize(runId: string): Promise<void> {
  await db.pool!.query(
    `INSERT INTO run_finalizations (
       id, space_id, run_id, attempt_number, finalizer_version, status, finalized_at, created_at
     ) VALUES ($1, $2, $3, 1, 'test', 'completed', now(), now())`,
    [randomUUID(), SPACE, runId],
  );
}

async function makeRun(runId: string, taskId: string, status: string, createdAt: string, role = "primary"): Promise<void> {
  await db.pool!.query(
    `INSERT INTO runs (
       id, space_id, agent_id, agent_version_id, project_id, trust_mode, run_type,
       trigger_origin, status, mode, owner_user_id, created_at, updated_at
     ) VALUES ($1, $2, $3, $4, $5, 'sandboxed', 'agent', 'manual', $6, 'live', $7, $8, $8)`,
    [runId, SPACE, AGENT, VERSION, PROJECT, status, USER, createdAt],
  );
  await db.pool!.query(
    `INSERT INTO task_runs (id, space_id, task_id, run_id, role, created_at)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [randomUUID(), SPACE, taskId, runId, role, createdAt],
  );
}

async function evaluate(taskId: string, runId: string, recommendation: string): Promise<void> {
  await db.pool!.query(
    `INSERT INTO task_evaluations (
       id, space_id, task_id, run_id, evaluator_type, recommendation, created_at
     ) VALUES ($1, $2, $3, $4, 'system', $5, now())`,
    [randomUUID(), SPACE, taskId, runId, recommendation],
  );
}

async function taskRow(taskId: string): Promise<{ status: string; completed_at: string | null }> {
  const result = await db.pool!.query<{ status: string; completed_at: string | null }>(
    `SELECT status, completed_at FROM tasks WHERE id = $1`,
    [taskId],
  );
  return result.rows[0]!;
}

async function eventKinds(taskId: string): Promise<string[]> {
  const result = await db.pool!.query<{ event_kind: string }>(
    `SELECT event_kind FROM project_work_events
      WHERE space_id = $1 AND subject_id = $2 ORDER BY created_at, id`,
    [SPACE, taskId],
  );
  return result.rows.map((row) => row.event_kind);
}

beforeEach(async () => {
  if (!db.available) return;
  await resetTables(
    db.pool!,
    [
      "project_work_events", "task_loop_states", "task_evaluations", "task_artifacts", "run_finalizations",
      "task_runs", "tasks", "artifacts", "runs", "actors", "agent_versions", "agents",
      "projects", "users", "spaces",
    ],
    { cascade: true },
  );
  await db.pool!.query(
    `INSERT INTO users (id, display_name, status, created_at, updated_at)
     VALUES ($1, 'Owner', 'active', now(), now())`,
    [USER],
  );
  await db.pool!.query(
    `INSERT INTO spaces (id, name, type, created_by_user_id, created_at, updated_at)
     VALUES ($1, 'Settlement Space', 'household', $2, now(), now())`,
    [SPACE, USER],
  );
  await db.pool!.query(
    `INSERT INTO space_memberships (id, space_id, user_id, role, status, created_at, updated_at)
     VALUES ($1, $2, $3, 'owner', 'active', now(), now())`,
    [randomUUID(), SPACE, USER],
  );
  await db.pool!.query(
    `INSERT INTO projects (id, space_id, owner_user_id, name, status, created_at, updated_at)
     VALUES ($1, $2, $3, 'Settlement Project', 'active', now(), now())`,
    [PROJECT, SPACE, USER],
  );
  await db.pool!.query(
    `INSERT INTO agents (id, space_id, owner_user_id, name, status, agent_kind, visibility, created_at, updated_at)
     VALUES ($1, $2, $3, 'Worker', 'active', 'standard', 'private', now(), now())`,
    [AGENT, SPACE, USER],
  );
  await db.pool!.query(
    `INSERT INTO agent_versions (
       id, agent_id, space_id, version_label, model_config_json, runtime_config_json,
       context_policy_json, memory_policy_json, capabilities_json, tool_permissions_json,
       runtime_policy_json, created_at
     ) VALUES ($1, $2, $3, 'v1', '{}', '{}', '{}', '{}', '[]', '{}', '{}', now())`,
    [VERSION, AGENT, SPACE],
  );
  await db.pool!.query(`UPDATE agents SET current_version_id = $2 WHERE id = $1`, [AGENT, VERSION]);
});

describe("run settlement", () => {
  it("closes a Task whose evaluation accepted the result", async (ctx) => {
    if (!db.available) return ctx.skip();
    const task = randomUUID();
    const run = randomUUID();
    await makeTask(task);
    await makeRun(run, task, "succeeded", "2026-08-27T00:00:00.000Z");
    await evaluate(task, run, "accept");
    await finalize(run);

    await projectTaskStatusFromRun(db.pool!, SPACE, run);

    const row = await taskRow(task);
    expect(row.status).toBe("done");
    expect(row.completed_at).not.toBeNull();
    // Acceptance is recorded as its own fact, not inferred from the status.
    expect(await eventKinds(task)).toEqual([
      "task.run_settled", "task.accepted", "task.stage_changed",
    ]);
    const loop = await db.pool!.query<{ current_stage_key: string }>(
      `SELECT current_stage_key FROM task_loop_states WHERE task_id = $1`,
      [task],
    );
    expect(loop.rows[0]?.current_stage_key).toBe("conclude");
  });

  it("does not let one old failure block a Task forever", async (ctx) => {
    if (!db.available) return ctx.skip();
    // The previous projection took `bool_or(failure)` over every Run the Task
    // ever had, so a single failed attempt made the Task permanently
    // unclosable: every later success still saw the old failure and wrote
    // `blocked` again. Re-running a Task after a failure is the normal case,
    // which is why this went unnoticed as a permanent state rather than a
    // transient one.
    const task = randomUUID();
    const failed = randomUUID();
    const retried = randomUUID();
    await makeTask(task);
    await makeRun(failed, task, "failed", "2026-08-27T00:00:00.000Z");
    await finalize(failed);
    await projectTaskStatusFromRun(db.pool!, SPACE, failed);
    expect((await taskRow(task)).status).toBe("waiting_for_review");

    await db.pool!.query(`UPDATE tasks SET status = 'in_progress' WHERE id = $1`, [task]);
    await makeRun(retried, task, "succeeded", "2026-08-27T01:00:00.000Z");
    await evaluate(task, retried, "accept");
    await finalize(retried);
    await projectTaskStatusFromRun(db.pool!, SPACE, retried);

    expect((await taskRow(task)).status).toBe("done");
  });

  it("counts a retry started after the hold, and ignores the Run that caused it", async (ctx) => {
    if (!db.available) return ctx.skip();
    // A person re-running a Task from waiting_for_review is answering the
    // question. If the guard were by status, their retry's accept would be
    // discarded and the Task would wait forever.
    const task = randomUUID();
    const failed = randomUUID();
    const retried = randomUUID();
    await makeTask(task);
    await makeRun(failed, task, "failed", "2026-08-27T00:00:00.000Z");
    await finalize(failed);
    await projectTaskStatusFromRun(db.pool!, SPACE, failed);
    expect((await taskRow(task)).status).toBe("waiting_for_review");

    // No status reset this time: the Task stays parked while the retry runs.
    await makeRun(retried, task, "succeeded", "2026-08-27T01:00:00.000Z");
    await evaluate(task, retried, "accept");
    await finalize(retried);
    await projectTaskStatusFromRun(db.pool!, SPACE, retried);
    expect((await taskRow(task)).status).toBe("done");
  });

  it("does not close a Task under an Agent that just handed the decision back", async (ctx) => {
    if (!db.available) return ctx.skip();
    const task = randomUUID();
    const run = randomUUID();
    await makeTask(task);
    // The Run was in flight when the Agent asked for a decision …
    await makeRun(run, task, "succeeded", "2026-08-27T00:00:00.000Z");
    await db.pool!.query(`UPDATE tasks SET status = 'waiting_for_review' WHERE id = $1`, [task]);
    const actor = await db.pool!.query<{ id: string }>(
      `INSERT INTO actors (id, space_id, actor_type, agent_id, status, metadata_json, created_at, updated_at)
       VALUES ($1, $2, 'agent', $1, 'active', '{}'::jsonb, now(), now()) RETURNING id`,
      [AGENT, SPACE],
    );
    await db.pool!.query(
      `INSERT INTO project_work_events (
         id, space_id, project_id, event_kind, subject_type, subject_id, actor_id,
         occurred_at, data_json, created_at
       ) VALUES ($1, $2, $3, 'task.flow_changed', 'task', $4, $5, '2026-08-27T00:30:00.000Z',
                 '{"from":"in_progress","to":"waiting_for_review","via":"agent"}'::jsonb, now())`,
      [randomUUID(), SPACE, PROJECT, task, actor.rows[0]!.id],
    );
    // … and then finished with an accept. The person has not answered yet.
    await evaluate(task, run, "accept");
    await finalize(run);
    await projectTaskStatusFromRun(db.pool!, SPACE, run);
    expect((await taskRow(task)).status).toBe("waiting_for_review");
  });

  it("leaves a deliberately blocked Task alone", async (ctx) => {
    if (!db.available) return ctx.skip();
    // Runs never write `blocked`; they must not erase it either. A person
    // blocked this while the Run was in flight, and the Run finishing does
    // not lift whatever is holding the work up.
    const task = randomUUID();
    const run = randomUUID();
    await makeTask(task);
    await makeRun(run, task, "succeeded", "2026-08-27T00:00:00.000Z");
    await db.pool!.query(
      `UPDATE tasks SET status = 'blocked', blocked_reason = 'Waiting on the vendor' WHERE id = $1`, [task]);
    await evaluate(task, run, "accept");
    await finalize(run);
    await projectTaskStatusFromRun(db.pool!, SPACE, run);
    const row = await db.pool!.query<{ status: string; blocked_reason: string | null }>(
      `SELECT status, blocked_reason FROM tasks WHERE id = $1`, [task]);
    expect(row.rows[0]).toEqual({ status: "blocked", blocked_reason: "Waiting on the vendor" });
  });

  it("bubbles a Supervisor review hold up to the Task", async (ctx) => {
    if (!db.available) return ctx.skip();
    // `waiting_for_review` was absent from the terminal set, so a Run the
    // Supervisor had stopped retrying settled nothing at all and its Task sat
    // in `in_progress` with no sign a person was needed.
    const task = randomUUID();
    const run = randomUUID();
    await makeTask(task);
    await makeRun(run, task, "waiting_for_review", "2026-08-27T00:00:00.000Z");
    // A Supervisor hold is written inside finalization, so it is always
    // finalized by the time settlement sees it.
    await finalize(run);

    await projectTaskStatusFromRun(db.pool!, SPACE, run);

    expect((await taskRow(task)).status).toBe("waiting_for_review");
    // Nothing was produced, so the Loop stage is left where it was.
    const loop = await db.pool!.query(`SELECT 1 FROM task_loop_states WHERE task_id = $1`, [task]);
    expect(loop.rowCount).toBe(0);
  });

  it("waits while another Run of the same Task is still going", async (ctx) => {
    if (!db.available) return ctx.skip();
    const task = randomUUID();
    const finished = randomUUID();
    const running = randomUUID();
    await makeTask(task);
    await makeRun(finished, task, "succeeded", "2026-08-27T00:00:00.000Z");
    await makeRun(running, task, "running", "2026-08-27T01:00:00.000Z");
    await evaluate(task, finished, "accept");
    await finalize(finished);

    await projectTaskStatusFromRun(db.pool!, SPACE, finished);

    expect((await taskRow(task)).status).toBe("in_progress");
    expect(await eventKinds(task)).toEqual([]);
  });

  it("waits while a Run is still being recovered from a crash", async (ctx) => {
    if (!db.available) return ctx.skip();
    // `orphaned` is not a settled status: the Supervisor terminalises the
    // orphaned attempt and creates the next one, so settling on it would be
    // settling in the middle of a retry.
    const task = randomUUID();
    const orphaned = randomUUID();
    await makeTask(task);
    await makeRun(orphaned, task, "orphaned", "2026-08-27T00:00:00.000Z");

    await projectTaskStatusFromRun(db.pool!, SPACE, orphaned);

    expect((await taskRow(task)).status).toBe("in_progress");
  });

  it("holds an accepted result that is missing a declared output", async (ctx) => {
    if (!db.available) return ctx.skip();
    const task = randomUUID();
    const run = randomUUID();
    await makeTask(task, { requiredOutputs: ["report"] });
    await makeRun(run, task, "succeeded", "2026-08-27T00:00:00.000Z");
    await evaluate(task, run, "accept");
    await finalize(run);

    await projectTaskStatusFromRun(db.pool!, SPACE, run);
    expect((await taskRow(task)).status).toBe("waiting_for_review");

    const artifact = randomUUID();
    await db.pool!.query(
      `INSERT INTO artifacts (
         id, space_id, run_id, artifact_type, title, export_formats_json,
         owner_user_id, visibility, created_at, updated_at
       ) VALUES ($1, $2, $3, 'report', 'Result', '[]'::jsonb, $4, 'space_shared', now(), now())`,
      [artifact, SPACE, run, USER],
    );
    await db.pool!.query(
      `INSERT INTO task_artifacts (id, space_id, task_id, artifact_id, role, created_at)
       VALUES ($1, $2, $3, $4, 'output', now())`,
      [randomUUID(), SPACE, task, artifact],
    );
    await db.pool!.query(`UPDATE tasks SET status = 'in_progress' WHERE id = $1`, [task]);

    await projectTaskStatusFromRun(db.pool!, SPACE, run);
    expect((await taskRow(task)).status).toBe("done");
    // The second settlement had different facts, so it is a second event —
    // a key without the outcome swallowed it and left a status change with
    // nothing in the stream saying why.
    expect(await eventKinds(task)).toEqual([
      "task.run_settled", "task.stage_changed", "task.run_settled", "task.accepted", "task.stage_changed",
    ]);
  });

  it("records a settlement once however often it is replayed", async (ctx) => {
    if (!db.available) return ctx.skip();
    // Job retries and at-least-once delivery both re-enter with the same
    // facts. An advancement recorded twice is a Project that looks like it did
    // the work twice.
    const task = randomUUID();
    const run = randomUUID();
    await makeTask(task);
    await makeRun(run, task, "succeeded", "2026-08-27T00:00:00.000Z");
    await evaluate(task, run, "accept");
    await finalize(run);

    await projectTaskStatusFromRun(db.pool!, SPACE, run);
    await projectTaskStatusFromRun(db.pool!, SPACE, run);
    await projectTaskStatusFromRun(db.pool!, SPACE, run);

    expect(await eventKinds(task)).toEqual([
      "task.run_settled", "task.accepted", "task.stage_changed",
    ]);
  });

  it("leaves a Task that a person already finished alone", async (ctx) => {
    if (!db.available) return ctx.skip();
    const task = randomUUID();
    const run = randomUUID();
    await makeTask(task);
    await db.pool!.query(`UPDATE tasks SET status = 'done', completed_at = now() WHERE id = $1`, [task]);
    await makeRun(run, task, "failed", "2026-08-27T00:00:00.000Z");
    await finalize(run);

    await projectTaskStatusFromRun(db.pool!, SPACE, run);

    expect((await taskRow(task)).status).toBe("done");
    expect(await eventKinds(task)).toEqual([]);
  });

  it("does not settle a finished Run that has not been finalized", async (ctx) => {
    if (!db.available) return ctx.skip();
    // The terminal status is written before finalization, and finalization is
    // what writes the evaluation and lets the Supervisor decide. Settling at
    // the status write held every successful Run as evaluation_missing and
    // held failed Runs the Supervisor was about to retry. The finalization
    // reconciler is the trigger that runs settlement once the facts exist.
    const task = randomUUID();
    const run = randomUUID();
    await makeTask(task);
    await makeRun(run, task, "succeeded", "2026-08-27T00:00:00.000Z");
    await evaluate(task, run, "accept");

    await projectTaskStatusFromRun(db.pool!, SPACE, run);
    expect((await taskRow(task)).status).toBe("in_progress");
    expect(await eventKinds(task)).toEqual([]);

    await finalize(run);
    await projectTaskStatusFromRun(db.pool!, SPACE, run);
    expect((await taskRow(task)).status).toBe("done");
  });

  it("settles a cancelled Run without waiting for finalization", async (ctx) => {
    if (!db.available) return ctx.skip();
    // Cancellation is a person's decision; there is nothing to evaluate and
    // nothing for the Supervisor to retry.
    const task = randomUUID();
    const run = randomUUID();
    await makeTask(task);
    await makeRun(run, task, "cancelled", "2026-08-27T00:00:00.000Z");

    await projectTaskStatusFromRun(db.pool!, SPACE, run);
    expect((await taskRow(task)).status).toBe("waiting_for_review");
  });

  it("ignores a policy pause, which is not a settled Run", async (ctx) => {
    if (!db.available) return ctx.skip();
    // A Run paused for authorization is also waiting_for_review, but the same
    // attempt resumes after approval. It is not finalized, so settlement
    // leaves the Task alone — the work is still moving.
    const task = randomUUID();
    const run = randomUUID();
    await makeTask(task);
    await makeRun(run, task, "waiting_for_review", "2026-08-27T00:00:00.000Z");

    await projectTaskStatusFromRun(db.pool!, SPACE, run);
    expect((await taskRow(task)).status).toBe("in_progress");
  });

  it("does not let a planning Run close the Task it planned", async (ctx) => {
    if (!db.available) return ctx.skip();
    // "Ask Agent to plan" links a planning Run through task_runs. It does not
    // advance the work, and a successful plan closing its Task as done was
    // the most wrong answer the old projection could give.
    const task = randomUUID();
    const planning = randomUUID();
    await makeTask(task);
    await makeRun(planning, task, "succeeded", "2026-08-27T00:00:00.000Z", "planning");
    await evaluate(task, planning, "accept");
    await finalize(planning);

    await projectTaskStatusFromRun(db.pool!, SPACE, planning);
    expect((await taskRow(task)).status).toBe("in_progress");
    expect(await eventKinds(task)).toEqual([]);
  });

  it("lets a person run a Task again after it stopped for review", async (ctx) => {
    if (!db.available) return ctx.skip();
    // Re-running is one of the decisions waiting_for_review exists to ask for.
    // The queue-settling status set must not double as the dispatch refusal
    // set, or the review hold becomes a dead end.
    const task = randomUUID();
    await makeTask(task);
    await db.pool!.query(`UPDATE tasks SET status = 'waiting_for_review' WHERE id = $1`, [task]);

    const repository = new PgTaskRepository(db.pool!);
    const created = await repository.createTaskRun({ spaceId: SPACE, userId: USER }, task, { agent_id: AGENT });
    expect(created).toBeTruthy();
    expect((await taskRow(task)).status).toBe("in_progress");
  });

  it("never writes blocked from a Run outcome", async (ctx) => {
    if (!db.available) return ctx.skip();
    // blocked now means held up by something else and is only ever set
    // deliberately. Every Run outcome that used to write it goes to a person
    // instead.
    const task = randomUUID();
    await makeTask(task);
    for (const [status, at] of [["failed", "00"], ["cancelled", "01"], ["degraded", "02"]] as const) {
      const run = randomUUID();
      await makeRun(run, task, status, `2026-08-27T${at}:00:00.000Z`);
      await finalize(run);
      await projectTaskStatusFromRun(db.pool!, SPACE, run);
      expect((await taskRow(task)).status, status).toBe("waiting_for_review");
      await db.pool!.query(`UPDATE tasks SET status = 'in_progress' WHERE id = $1`, [task]);
    }
  });
});
