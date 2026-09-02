import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { useTestDatabase } from "./support/testDatabase.js";
import { resetTables } from "./support/resetTables.js";
import { getProjectBoard, getTaskWorkView } from "../src/modules/projectWork/boardReadModel.js";
import { PgTaskRepository } from "../src/modules/tasks/repository.js";
import { recordStageChange } from "../src/modules/projectWork/loopState.js";
import { getProjectUpdates } from "../src/modules/projectWork/updatesReadModel.js";
import { undoProjectUpdate } from "../src/modules/projectWork/updateUndo.js";
import { InquiryThreadService } from "../src/modules/inquiry/threadService.js";
import { InquiryIterationService } from "../src/modules/inquiry/iterationService.js";
import { appendProjectWorkEvent } from "../src/modules/projectWork/eventWriter.js";
import { resolveUserActorId } from "../src/db/actorResolver.js";
import { HttpError, withDbTransaction } from "../src/modules/routeUtils/common.js";
import { assertProjectWriterForMutation, lockActiveProjectForMutation } from "../src/modules/projects/access.js";
import { seedMainlineRoomsForAllProjects } from "./support/domainSeeds.js";

/**
 * Real-Postgres coverage for the Board read model and the manual close gate.
 *
 * The read model exists so the Board and the write path answer "can this
 * close" identically; a test that stubbed either side would let them drift,
 * which is the failure it is meant to prevent.
 */

const SPACE = "41111111-1111-4111-8111-111111111111";
const OWNER = "4aaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OTHER = "4bbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const PROJECT = "4ccccccc-cccc-4ccc-8ccc-cccccccccccc";
const AGENT = "4ddddddd-dddd-4ddd-8ddd-dddddddddddd";
const VERSION = "4eeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";

const db = useTestDatabase(import.meta.filename);
const owner = { spaceId: SPACE, userId: OWNER };

async function makeTask(input: {
  id: string;
  title?: string;
  status?: string;
  requiredOutputs?: unknown;
  assignedUserId?: string | null;
  assignedAgentId?: string | null;
  createdByUserId?: string | null;
  visibility?: string;
}): Promise<void> {
  await db.pool!.query(
    `INSERT INTO tasks (
       id, space_id, project_id, title, status, required_outputs_json,
       assigned_user_id, assigned_agent_id, created_by_user_id, owner_user_id,
       visibility, created_at, updated_at
     ) VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9, $10, $11, now(), now())`,
    [
      input.id, SPACE, PROJECT, input.title ?? "Work item", input.status ?? "in_progress",
      JSON.stringify(input.requiredOutputs ?? null),
      input.assignedUserId ?? null, input.assignedAgentId ?? null,
      input.createdByUserId === undefined ? OWNER : input.createdByUserId,
      OWNER, input.visibility ?? "space_shared",
    ],
  );
}

async function makeRunWithEvaluation(taskId: string, recommendation: string | null): Promise<string> {
  const runId = randomUUID();
  await db.pool!.query(
    `INSERT INTO runs (
       id, space_id, agent_id, agent_version_id, project_id, trust_mode, run_type,
       trigger_origin, status, mode, owner_user_id, created_at, updated_at
     ) VALUES ($1, $2, $3, $4, $5, 'sandboxed', 'agent', 'manual', 'succeeded', 'live', $6, now(), now())`,
    [runId, SPACE, AGENT, VERSION, PROJECT, OWNER],
  );
  await db.pool!.query(
    `INSERT INTO task_runs (id, space_id, task_id, run_id, role, created_at)
     VALUES ($1, $2, $3, $4, 'primary', now())`,
    [randomUUID(), SPACE, taskId, runId],
  );
  if (recommendation !== null) {
    await db.pool!.query(
      `INSERT INTO task_evaluations (id, space_id, task_id, run_id, evaluator_type, recommendation, created_at)
       VALUES ($1, $2, $3, $4, 'system', $5, now())`,
      [randomUUID(), SPACE, taskId, runId, recommendation],
    );
  }
  return runId;
}

async function attachOutput(taskId: string, artifactType: string): Promise<void> {
  const artifactId = randomUUID();
  await db.pool!.query(
    `INSERT INTO artifacts (
       id, space_id, artifact_type, title, export_formats_json, owner_user_id,
       visibility, created_at, updated_at
     ) VALUES ($1, $2, $3, 'Result', '[]'::jsonb, $4, 'space_shared', now(), now())`,
    [artifactId, SPACE, artifactType, OWNER],
  );
  await db.pool!.query(
    `INSERT INTO task_artifacts (id, space_id, task_id, artifact_id, role, created_at)
     VALUES ($1, $2, $3, $4, 'output', now())`,
    [randomUUID(), SPACE, taskId, artifactId],
  );
}

beforeEach(async () => {
  if (!db.available) return;
  await resetTables(
    db.pool!,
    [
      "project_work_events", "inquiry_thread_advice", "inquiry_iterations",
      "inquiry_question_states", "inquiry_hypothesis_states", "inquiry_threads", "space_objects",
      "task_loop_states", "task_evaluations", "task_artifacts",
      "task_runs", "tasks", "artifacts", "run_finalizations", "runs", "actors",
      "board_columns", "boards", "agent_versions", "agents", "project_members", "projects", "users", "spaces",
    ],
    { cascade: true },
  );
  for (const [id, name] of [[OWNER, "Owner"], [OTHER, "Teammate"]] as const) {
    await db.pool!.query(
      `INSERT INTO users (id, display_name, status, created_at, updated_at)
       VALUES ($1, $2, 'active', now(), now())`,
      [id, name],
    );
  }
  await db.pool!.query(
    `INSERT INTO spaces (id, name, type, created_by_user_id, created_at, updated_at)
     VALUES ($1, 'Board Space', 'household', $2, now(), now())`,
    [SPACE, OWNER],
  );
  for (const [id, role] of [[OWNER, "owner"], [OTHER, "member"]] as const) {
    await db.pool!.query(
      `INSERT INTO space_memberships (id, space_id, user_id, role, status, created_at, updated_at)
       VALUES ($1, $2, $3, $4, 'active', now(), now())`,
      [randomUUID(), SPACE, id, role],
    );
  }
  await db.pool!.query(
    `INSERT INTO projects (id, space_id, owner_user_id, name, status, created_at, updated_at)
     VALUES ($1, $2, $3, 'Board Project', 'active', now(), now())`,
    [PROJECT, SPACE, OWNER],
  );
  await seedMainlineRoomsForAllProjects(db.pool!);
  // Space membership does not grant Project access; the teammate is added to
  // the Project explicitly, which is what makes the visibility case below a
  // test of content visibility rather than of the Project gate.
  await db.pool!.query(
    `INSERT INTO project_members (id, space_id, project_id, user_id, role, status, created_at, updated_at)
     VALUES ($1, $2, $3, $4, 'member', 'active', now(), now())`,
    [randomUUID(), SPACE, PROJECT, OTHER],
  );
  await db.pool!.query(
    `INSERT INTO agents (id, space_id, owner_user_id, name, status, agent_kind, visibility, created_at, updated_at)
     VALUES ($1, $2, $3, 'Worker', 'active', 'standard', 'space_shared', now(), now())`,
    [AGENT, SPACE, OWNER],
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

describe("project board read model", () => {
  it("labels the Loop stage with the one wording every Project shares", async (ctx) => {
    if (!db.available) return ctx.skip();
    const task = randomUUID();
    await makeTask({ id: task });
    await db.pool!.query(
      `INSERT INTO task_loop_states (
         task_id, space_id, project_id, loop_instance_id, current_stage_key,
         stage_entered_at, revision, updated_at
       ) VALUES ($1, $2, $3, $4, 'verify', now(), 1, now())`,
      [task, SPACE, PROJECT, randomUUID()],
    );

    const board = await getProjectBoard(db.pool!, owner, PROJECT);
    const card = board.cards.find((item) => item.id === task);
    // The label is presentation, so it must not come from the client; and it
    // is the same in every Project — there is no per-Project mode (ADR 0019).
    expect(card?.loop_stage).toBe("verify");
    expect(card?.loop_stage_label).toBe("Verify");
  });

  it("says why each Task cannot close", async (ctx) => {
    if (!db.available) return ctx.skip();
    const noEvaluation = randomUUID();
    const notAccepted = randomUUID();
    const missingOutput = randomUUID();
    const ready = randomUUID();
    await makeTask({ id: noEvaluation, title: "No evaluation" });
    await makeTask({ id: notAccepted, title: "Not accepted" });
    await makeRunWithEvaluation(notAccepted, "retry");
    await makeTask({ id: missingOutput, title: "Missing output", requiredOutputs: ["report"] });
    await makeRunWithEvaluation(missingOutput, "accept");
    await makeTask({ id: ready, title: "Ready", requiredOutputs: ["report"] });
    await makeRunWithEvaluation(ready, "accept");
    await attachOutput(ready, "report");

    const board = await getProjectBoard(db.pool!, owner, PROJECT);
    const completionOf = (id: string) => board.cards.find((card) => card.id === id)?.completion;
    expect(completionOf(noEvaluation)).toEqual({ ok: false, missing: ["evaluation"] });
    expect(completionOf(notAccepted)).toEqual({ ok: false, missing: ["evaluation"] });
    expect(completionOf(missingOutput)).toEqual({ ok: false, missing: ["required_output:report"] });
    expect(completionOf(ready)).toEqual({ ok: true, missing: [] });
  });

  it("resolves who holds each card through the responsibility chain", async (ctx) => {
    if (!db.available) return ctx.skip();
    const mine = randomUUID();
    const agentHeld = randomUUID();
    const orphan = randomUUID();
    await makeTask({ id: mine, assignedUserId: OWNER });
    await makeTask({ id: agentHeld, assignedAgentId: AGENT, createdByUserId: OWNER });
    // Created by nobody and assigned to nobody: the Project owner is the floor.
    await makeTask({ id: orphan, createdByUserId: null, status: "waiting_for_review" });

    const board = await getProjectBoard(db.pool!, owner, PROJECT);
    const responsibleOf = (id: string) => board.cards.find((card) => card.id === id)?.responsible;
    expect(responsibleOf(mine)).toMatchObject({ kind: "user", id: OWNER, display_name: "Owner" });
    expect(responsibleOf(agentHeld)).toMatchObject({ kind: "agent", id: AGENT, display_name: "Worker" });
    expect(responsibleOf(orphan)).toMatchObject({ kind: "user", id: OWNER });
    expect(board.filters).toMatchObject({ all: 3, mine: 2, agent_held: 1, needs_me: 1 });
  });

  it("shows a member only the Tasks they may read", async (ctx) => {
    if (!db.available) return ctx.skip();
    const shared = randomUUID();
    const privateTask = randomUUID();
    await makeTask({ id: shared, title: "Shared" });
    await makeTask({ id: privateTask, title: "Private", visibility: "private" });

    const asOwner = await getProjectBoard(db.pool!, owner, PROJECT);
    const asMember = await getProjectBoard(db.pool!, { spaceId: SPACE, userId: OTHER }, PROJECT);
    expect(asOwner.cards.map((card) => card.title).sort()).toEqual(["Private", "Shared"]);
    expect(asMember.cards.map((card) => card.title)).toEqual(["Shared"]);
  });

  it("draws one Board's columns even when the Project has two", async (ctx) => {
    if (!db.available) return ctx.skip();
    // `boards` has no uniqueness on (space_id, project_id). Reading every
    // matching Board's columns produced duplicate lanes with every card drawn
    // twice, which reads as data corruption rather than as a second Board.
    for (const [order, name] of [[0, "First"], [1, "Second"]] as const) {
      const boardId = randomUUID();
      await db.pool!.query(
        `INSERT INTO boards (id, space_id, project_id, name, board_type, status, sort_order, created_at, updated_at)
         VALUES ($1, $2, $3, $4, 'project', 'active', $5, now(), now())`,
        [boardId, SPACE, PROJECT, name, order],
      );
      await db.pool!.query(
        `INSERT INTO board_columns (id, space_id, board_id, name, status_key, position, is_done_column, is_default_column, created_at, updated_at)
         VALUES ($1, $2, $3, $4, 'ready', 0, false, true, now(), now())`,
        [randomUUID(), SPACE, boardId, `${name} ready`],
      );
    }

    const board = await getProjectBoard(db.pool!, owner, PROJECT);
    expect(board.columns.map((column) => column.label)).toEqual(["First ready"]);
  });

  it("falls back to the default columns when the Project has no Board", async (ctx) => {
    if (!db.available) return ctx.skip();
    await makeTask({ id: randomUUID(), status: "waiting_for_review" });
    const board = await getProjectBoard(db.pool!, owner, PROJECT);
    // A Project with no Board row is the ordinary case, and an empty column
    // list would read as broken rather than as empty.
    expect(board.columns.map((column) => column.status_key))
      .toEqual(["inbox", "ready", "in_progress", "waiting_for_review", "done"]);
    expect(board.columns.find((column) => column.status_key === "waiting_for_review")?.count).toBe(1);
  });
});

describe("manual close gate", () => {
  it("refuses a close whose requirements are unmet, and records nothing", async (ctx) => {
    if (!db.available) return ctx.skip();
    const task = randomUUID();
    await makeTask({ id: task, requiredOutputs: ["report"] });
    const repository = new PgTaskRepository(db.pool!);

    await expect(repository.updateTask(owner, task, { status: "done" }))
      .rejects.toMatchObject({
        statusCode: 422,
        responseBody: {
          code: "completion_requirements_unmet",
          missing: ["evaluation", "required_output:report"],
        },
      });

    const after = await db.pool!.query<{ status: string }>(`SELECT status FROM tasks WHERE id = $1`, [task]);
    expect(after.rows[0]?.status).toBe("in_progress");
    const events = await db.pool!.query(
      `SELECT 1 FROM project_work_events WHERE subject_id = $1`,
      [task],
    );
    expect(events.rowCount).toBe(0);
  });

  it("closes on an acknowledged override and records what was skipped", async (ctx) => {
    if (!db.available) return ctx.skip();
    const task = randomUUID();
    await makeTask({ id: task, requiredOutputs: ["report"] });
    const repository = new PgTaskRepository(db.pool!);

    const updated = await repository.updateTask(owner, task, {
      status: "done",
      override_completion: { acknowledged: ["evaluation", "required_output:report"] },
    });
    expect(updated.status).toBe("done");
    expect(updated.completed_at).not.toBeNull();

    const events = await db.pool!.query<{ event_kind: string; data_json: Record<string, unknown> }>(
      `SELECT event_kind, data_json FROM project_work_events
        WHERE subject_id = $1 ORDER BY created_at, id`,
      [task],
    );
    expect(events.rows.map((row) => row.event_kind)).toEqual(["task.flow_changed", "task.accepted"]);
    // The record has to say the Task was closed early, not that it met its bar.
    expect(events.rows[1]?.data_json).toMatchObject({
      decided_by: "user",
      basis: "override",
      overridden: ["evaluation", "required_output:report"],
    });
  });

  it("closes without an override once the requirements are met", async (ctx) => {
    if (!db.available) return ctx.skip();
    const task = randomUUID();
    await makeTask({ id: task, requiredOutputs: ["report"] });
    await makeRunWithEvaluation(task, "accept");
    await attachOutput(task, "report");
    const repository = new PgTaskRepository(db.pool!);

    const updated = await repository.updateTask(owner, task, { status: "done" });
    expect(updated.status).toBe("done");
    const events = await db.pool!.query<{ data_json: Record<string, unknown> }>(
      `SELECT data_json FROM project_work_events
        WHERE subject_id = $1 AND event_kind = 'task.accepted'`,
      [task],
    );
    expect(events.rows[0]?.data_json).toMatchObject({ basis: "requirements_met", overridden: [] });
  });

  it("records an ordinary flow move without an acceptance", async (ctx) => {
    if (!db.available) return ctx.skip();
    const task = randomUUID();
    await makeTask({ id: task, status: "ready" });
    const repository = new PgTaskRepository(db.pool!);
    await repository.updateTask(owner, task, { status: "in_progress" });

    const events = await db.pool!.query<{ event_kind: string; data_json: Record<string, unknown> }>(
      `SELECT event_kind, data_json FROM project_work_events WHERE subject_id = $1`,
      [task],
    );
    expect(events.rows.map((row) => row.event_kind)).toEqual(["task.flow_changed"]);
    expect(events.rows[0]?.data_json).toMatchObject({ from: "ready", to: "in_progress", via: "user" });
  });
});

describe("task work view", () => {
  it("returns every stage with its label, and the current one", async (ctx) => {
    if (!db.available) return ctx.skip();
    const task = randomUUID();
    await makeTask({ id: task });
    await db.pool!.query(
      `INSERT INTO task_loop_states (
         task_id, space_id, project_id, loop_instance_id, current_stage_key,
         stage_entered_at, revision, updated_at
       ) VALUES ($1, $2, $3, $4, 'act', now(), 1, now())`,
      [task, SPACE, PROJECT, randomUUID()],
    );

    const view = await getTaskWorkView(db.pool!, owner, task);
    expect(view.stages.map((stage) => stage.label))
      .toEqual(["Frame", "Plan", "Act", "Verify", "Conclude"]);
    expect(view.loop?.current_stage_key).toBe("act");
  });

  it("refuses a Task the reader cannot see", async (ctx) => {
    if (!db.available) return ctx.skip();
    const task = randomUUID();
    await makeTask({ id: task, visibility: "private" });
    await expect(getTaskWorkView(db.pool!, { spaceId: SPACE, userId: OTHER }, task))
      .rejects.toBeInstanceOf(HttpError);
  });
});

describe("stage control", () => {
  it("records one transition and bumps the fold's revision", async (ctx) => {
    if (!db.available) return ctx.skip();
    const task = randomUUID();
    await makeTask({ id: task });
    const actorId = await resolveUserActorId(db.pool!, SPACE, OWNER);
    const context = { spaceId: SPACE, projectId: PROJECT, taskId: task, actorId };

    await recordStageChange(db.pool!, { ...context, toStage: "plan", reason: "scoped it" });
    const first = await getTaskWorkView(db.pool!, owner, task);
    expect(first.loop).toMatchObject({ current_stage_key: "plan", revision: 1 });

    await recordStageChange(db.pool!, { ...context, toStage: "verify", reason: "results are in" });
    const second = await getTaskWorkView(db.pool!, owner, task);
    expect(second.loop).toMatchObject({ current_stage_key: "verify", revision: 2 });

    const events = await db.pool!.query<{ data_json: Record<string, unknown> }>(
      `SELECT data_json FROM project_work_events
        WHERE subject_id = $1 AND event_kind = 'task.stage_changed'
        ORDER BY created_at, id`,
      [task],
    );
    expect(events.rowCount).toBe(2);
    // Entering the Loop is an advance whatever stage it starts at; the jump
    // from plan past act is recorded as a skip rather than refused, because a
    // Task that did not need that stage should not pretend it did.
    expect(events.rows[0]?.data_json).toMatchObject({ to_stage: "plan", transition_kind: "advance" });
    expect(events.rows[1]?.data_json).toMatchObject({ to_stage: "verify", transition_kind: "skip" });
  });

  it("does not re-record a move to the stage it is already in", async (ctx) => {
    if (!db.available) return ctx.skip();
    const task = randomUUID();
    await makeTask({ id: task });
    const actorId = await resolveUserActorId(db.pool!, SPACE, OWNER);
    const context = { spaceId: SPACE, projectId: PROJECT, taskId: task, actorId, toStage: "act" as const };
    await recordStageChange(db.pool!, { ...context, reason: "started" });
    await recordStageChange(db.pool!, { ...context, reason: "started again" });

    const events = await db.pool!.query(
      `SELECT 1 FROM project_work_events WHERE subject_id = $1 AND event_kind = 'task.stage_changed'`,
      [task],
    );
    expect(events.rowCount).toBe(1);
  });
});

describe("task creation", () => {
  it("records the Task and its creation event together", async (ctx) => {
    if (!db.available) return ctx.skip();
    const repository = new PgTaskRepository(db.pool!);
    const created = await repository.createTask(owner, { project_id: PROJECT, title: "New work" });

    const events = await db.pool!.query<{ event_kind: string; data_json: Record<string, unknown> }>(
      `SELECT event_kind, data_json FROM project_work_events WHERE subject_id = $1`,
      [created.id],
    );
    expect(events.rows.map((row) => row.event_kind)).toEqual(["task.created"]);
    expect(events.rows[0]?.data_json).toMatchObject({ title: "New work", status: "inbox" });
  });

  it("writes no event for a Task outside any Project", async (ctx) => {
    if (!db.available) return ctx.skip();
    const repository = new PgTaskRepository(db.pool!);
    const created = await repository.createTask(owner, { title: "Space-only work" });
    // There is no Project stream to write to, and inventing one would put
    // Space work into a Project that never held it.
    const events = await db.pool!.query(
      `SELECT 1 FROM project_work_events WHERE subject_id = $1`,
      [created.id],
    );
    expect(events.rowCount).toBe(0);
  });
});

describe("close gate cannot be dodged", () => {
  it("reads the stored declaration, not one cleared in the same request", async (ctx) => {
    if (!db.available) return ctx.skip();
    const task = randomUUID();
    await makeTask({ id: task, requiredOutputs: ["report"] });
    await makeRunWithEvaluation(task, "accept");
    const repository = new PgTaskRepository(db.pool!);

    // Clearing the declaration while closing would otherwise pass the gate and
    // record `requirements_met` for a Task that met nothing.
    await expect(repository.updateTask(owner, task, {
      status: "done",
      required_outputs_json: null,
    })).rejects.toMatchObject({
      statusCode: 422,
      responseBody: { missing: ["required_output:report"] },
    });
  });
});

describe("blocked cards", () => {
  it("keeps a blocked Task on the Board, in the lane its work sits in", async (ctx) => {
    if (!db.available) return ctx.skip();
    const task = randomUUID();
    await makeTask({ id: task, status: "blocked" });
    const board = await getProjectBoard(db.pool!, owner, PROJECT);
    const card = board.cards.find((item) => item.id === task);
    // `blocked` is an overlay rather than a column, so a card that kept its own
    // status but had no lane would be counted and then drawn nowhere.
    expect(card?.status).toBe("blocked");
    expect(card?.column_key).toBe("in_progress");
    expect(board.columns.find((column) => column.status_key === "in_progress")?.count).toBe(1);
  });
});

describe("cross-Project task lists", () => {
  it("returns rows at all, with the Project join in place", async (ctx) => {
    if (!db.available) return ctx.skip();
    // `listTasks` had no test anywhere, which is how an ambiguous-column error
    // from joining `projects` reached a green suite: `tasks` and `projects`
    // share `id`, `status`, `description`, `owner_user_id` and the timestamps.
    await makeTask({ id: randomUUID(), title: "Listed" });
    const repository = new PgTaskRepository(db.pool!);
    const page = await repository.listTasks(owner, {
      boardId: null, projectFolderId: null, projectId: null, status: null,
      assignedToMe: false, q: null, limit: 50, offset: 0,
    });
    expect(page.items.map((task) => task.title)).toContain("Listed");
  });

  it("scopes both list surfaces to the responsible person, not to anyone who touched it", async (ctx) => {
    if (!db.available) return ctx.skip();
    const mine = randomUUID();
    const handedToAnAgent = randomUUID();
    await makeTask({ id: mine, title: "Mine", assignedUserId: OWNER });
    // Created by me, then claimed by an Agent: the chain stops at the claim, so
    // it is the Agent's. The predicate this replaced counted it as still mine.
    await makeTask({ id: handedToAnAgent, title: "The Agent has it", createdByUserId: OWNER });
    await db.pool!.query(`UPDATE tasks SET claimed_by_agent_id = $2 WHERE id = $1`, [handedToAnAgent, AGENT]);

    const repository = new PgTaskRepository(db.pool!);
    const listed = await repository.listTasks(owner, {
      boardId: null, projectFolderId: null, projectId: null, status: null,
      assignedToMe: true, q: null, limit: 50, offset: 0,
    });
    const mineAcrossProjects = await repository.listMyTasks(owner, { status: null, limit: 50, offset: 0 });

    for (const [surface, titles] of [
      ["assigned_to_me", listed.items.map((task) => task.title)],
      ["me/tasks", mineAcrossProjects.items.map((task) => (task as { title: string }).title)],
    ] as const) {
      expect(titles, surface).toContain("Mine");
      expect(titles, surface).not.toContain("The Agent has it");
    }
  });
});

describe("who may change a Task", () => {
  it("lets a viewer read the Board and refuses every write", async (ctx) => {
    if (!db.available) return ctx.skip();
    const task = randomUUID();
    await makeTask({ id: task, status: "in_progress" });
    await db.pool!.query(
      `UPDATE project_members SET role = 'viewer' WHERE project_id = $1 AND user_id = $2`,
      [PROJECT, OTHER],
    );
    const viewer = { spaceId: SPACE, userId: OTHER };
    const repo = new PgTaskRepository(db.pool!);

    // Reading is fine — that is what a viewer is for.
    const board = await getProjectBoard(db.pool!, viewer, PROJECT);
    expect(board.cards.map((card) => card.id)).toContain(task);

    // Reading is not licence to change. Before this a viewer could drag any
    // shared Task to Done, acknowledge the override, or move its Loop stage:
    // the first thing a second household member would hit.
    await expect(repo.updateTask(viewer, task, { status: "ready" }))
      .rejects.toMatchObject({ statusCode: 403 });
    await expect(repo.updateTask(viewer, task, { title: "Renamed by a viewer" }))
      .rejects.toMatchObject({ statusCode: 403 });
    await expect(repo.updateTask(viewer, task, { claimed_by_user_id: OTHER }))
      .rejects.toMatchObject({ statusCode: 403 });
    const untouched = await db.pool!.query<{ status: string; title: string }>(
      `SELECT status, title FROM tasks WHERE id = $1`, [task]);
    expect(untouched.rows[0]).toEqual({ status: "in_progress", title: "Work item" });
  });

  it("records one acceptance when two people close the same Task at once", async (ctx) => {
    if (!db.available) return ctx.skip();
    const task = randomUUID();
    await makeTask({ id: task, status: "in_progress" });
    // Ready to close on its merits, so the gate is not what separates the two.
    await makeRunWithEvaluation(task, "accept");
    const repo = new PgTaskRepository(db.pool!);

    // Both read `in_progress` and both pass the gate if the read happens
    // outside the transaction; under the lock the second reads `done` and
    // has nothing to record.
    const results = await Promise.allSettled([
      repo.updateTask(owner, task, { status: "done" }),
      repo.updateTask({ spaceId: SPACE, userId: OTHER }, task, { status: "done" }),
    ]);
    const failures = results.filter((r): r is PromiseRejectedResult => r.status === "rejected")
      .map((r) => String(r.reason));
    expect(failures).toEqual([]);

    const accepted = await db.pool!.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM project_work_events
        WHERE subject_id = $1 AND event_kind = 'task.accepted'`, [task]);
    expect(accepted.rows[0]!.count).toBe("1");
    const flows = await db.pool!.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM project_work_events
        WHERE subject_id = $1 AND event_kind = 'task.flow_changed'`, [task]);
    expect(flows.rows[0]!.count).toBe("1");
  });
});

describe("closing twice on purpose", () => {
  it("records each deliberate close, even within one second", async (ctx) => {
    if (!db.available) return ctx.skip();
    // The idempotency key is built from the row the writer read. It has to
    // keep millisecond precision: a key from `String(Date)` is per-second,
    // and a close, reopen and close inside one second lost the second
    // acceptance silently.
    const task = randomUUID();
    await makeTask({ id: task, status: "in_progress" });
    await makeRunWithEvaluation(task, "accept");
    const repo = new PgTaskRepository(db.pool!);
    await repo.updateTask(owner, task, { status: "done" });
    await repo.updateTask(owner, task, { status: "in_progress" });
    await repo.updateTask(owner, task, { status: "done" });
    const accepted = await db.pool!.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM project_work_events
        WHERE subject_id = $1 AND event_kind = 'task.accepted'`, [task]);
    expect(accepted.rows[0]!.count).toBe("2");
  });
});

describe("loop rail honesty", () => {
  it("reports only the stages a Task has actually been in", async (ctx) => {
    if (!db.available) return ctx.skip();
    const task = randomUUID();
    await makeTask({ id: task });

    // Nothing has moved yet: no stage has been visited, so the rail must not
    // present any as done.
    await expect(getTaskWorkView(db.pool!, owner, task))
      .resolves.toMatchObject({ visited_stage_keys: [] });

    // A Task that settles straight to `verify` never framed, planned or acted.
    await recordStageChange(db.pool!, {
      spaceId: SPACE, projectId: PROJECT, taskId: task, toStage: "verify",
      actorId: await resolveUserActorId(db.pool!, SPACE, OWNER), reason: "run settled",
    });
    const afterJump = await getTaskWorkView(db.pool!, owner, task);
    expect(afterJump.visited_stage_keys).toEqual(["verify"]);

    await recordStageChange(db.pool!, {
      spaceId: SPACE, projectId: PROJECT, taskId: task, toStage: "plan",
      actorId: await resolveUserActorId(db.pool!, SPACE, OWNER), reason: "method was wrong",
    });
    // Reported in stage order, not visit order — the rail draws it in order.
    const afterRegress = await getTaskWorkView(db.pool!, owner, task);
    expect(afterRegress.visited_stage_keys).toEqual(["plan", "verify"]);
  });
});

describe("responsibility handback", () => {
  it("hands an Agent-held Task back to a person the moment it needs a decision", async (ctx) => {
    if (!db.available) return ctx.skip();
    const running = randomUUID();
    const waiting = randomUUID();
    const blocked = randomUUID();
    // Same claim on all three; only the status differs.
    await makeTask({ id: running, title: "Being worked on", status: "in_progress", assignedAgentId: AGENT });
    await makeTask({ id: waiting, title: "Needs a decision", status: "waiting_for_review", assignedAgentId: AGENT });
    await makeTask({ id: blocked, title: "Held up", status: "blocked", assignedAgentId: AGENT });
    await db.pool!.query(
      `UPDATE tasks SET claimed_by_agent_id = $2 WHERE id = ANY ($1::varchar[])`,
      [[running, waiting, blocked], AGENT],
    );

    const board = await getProjectBoard(db.pool!, owner, PROJECT);
    const cardFor = (id: string) => board.cards.find((card) => card.id === id)!;

    // While the Agent is working, nobody is interrupted.
    expect(cardFor(running).responsible.kind).toBe("agent");

    // The two states that mean a person has to act must name one. A state
    // requiring a decision with no person responsible is a Task that waits
    // forever: the attention adapter, the Board's "needs me" filter and the
    // cross-Project list all key on this being a person.
    expect(cardFor(waiting).responsible.kind).toBe("user");
    expect(cardFor(waiting).responsible.id).toBe(OWNER);
    expect(cardFor(blocked).responsible.kind).toBe("user");
    expect(board.filters.needs_me).toBe(2);

    // Exactly one of the two is ever set, so no surface has to break a tie.
    for (const card of board.cards) {
      expect(card.responsible.kind === "agent" || card.responsible.kind === "user"
        || card.responsible.kind === null).toBe(true);
    }
  });

  it("keeps the claim, because who did the work and who must decide are different questions", async (ctx) => {
    if (!db.available) return ctx.skip();
    const task = randomUUID();
    await makeTask({ id: task, status: "waiting_for_review", assignedAgentId: AGENT });
    await db.pool!.query(`UPDATE tasks SET claimed_by_agent_id = $2 WHERE id = $1`, [task, AGENT]);

    const row = await db.pool!.query<{ claimed_by_agent_id: string | null }>(
      `SELECT claimed_by_agent_id FROM tasks WHERE id = $1`,
      [task],
    );
    // Overwriting the claim to answer "who decides" would lose the only record
    // of which Agent to hand the work back to.
    expect(row.rows[0]!.claimed_by_agent_id).toBe(AGENT);
  });
});

describe("project updates", () => {
  it("shows reports newest first, and hides ones about Tasks the reader cannot see", async (ctx) => {
    if (!db.available) return ctx.skip();
    const visible = randomUUID();
    const hidden = randomUUID();
    await makeTask({ id: visible, title: "Shared work" });
    await makeTask({ id: hidden, title: "Private work", visibility: "private" });
    const actorId = await resolveUserActorId(db.pool!, SPACE, OWNER);
    for (const [taskId, summary] of [[visible, "did the shared thing"], [hidden, "did the private thing"]] as const) {
      await appendProjectWorkEvent(db.pool!, {
        spaceId: SPACE, projectId: PROJECT, eventKind: "task.reported",
        subjectType: "task", subjectId: taskId, actorId,
        data: { summary, outcome: "progress" },
      });
    }
    await appendProjectWorkEvent(db.pool!, {
      spaceId: SPACE, projectId: PROJECT, eventKind: "project.reported",
      subjectType: "project", subjectId: PROJECT, actorId,
      data: { summary: "the whole project is on track" },
    });

    const asOwner = await getProjectUpdates(db.pool!, owner, PROJECT, null);
    expect(asOwner.items.map((item) => item.summary)).toContain("did the private thing");

    // An update naming a Task the reader cannot see would leak its title, which
    // is the part worth reading.
    const asMember = await getProjectUpdates(db.pool!, { spaceId: SPACE, userId: OTHER }, PROJECT, null);
    const summaries = asMember.items.map((item) => item.summary);
    expect(summaries).toContain("did the shared thing");
    expect(summaries).toContain("the whole project is on track");
    expect(summaries).not.toContain("did the private thing");
  });

  it("walks every page exactly once", async (ctx) => {
    if (!db.available) return ctx.skip();
    const actorId = await resolveUserActorId(db.pool!, SPACE, OWNER);
    // More than one page, with ids deliberately unrelated to the ordering —
    // which is what `randomUUID()` gives us, and what broke a cursor keyed on
    // the id alone: half of each page came back and the rest became
    // unreachable.
    const total = 34;
    for (let index = 0; index < total; index += 1) {
      await appendProjectWorkEvent(db.pool!, {
        spaceId: SPACE, projectId: PROJECT, eventKind: "project.reported",
        subjectType: "project", subjectId: PROJECT, actorId,
        // Deliberately tied around the page boundary. Settlement appends two
        // events per call, each stamping its own `new Date()` and often
        // landing in the same millisecond, so the id half of the composite key
        // is not a theoretical case — and a time-only cursor would pass a test
        // that spaced every row apart.
        occurredAt: new Date(Date.UTC(2026, 0, 1, 0, 0, Math.min(index, total - 6))).toISOString(),
        data: { summary: `update ${index}` },
      });
    }

    const seen: string[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 5; page += 1) {
      const result: Awaited<ReturnType<typeof getProjectUpdates>> =
        await getProjectUpdates(db.pool!, owner, PROJECT, cursor);
      seen.push(...result.items.map((item) => item.summary));
      cursor = result.next_cursor;
      if (!cursor) break;
    }
    expect(cursor).toBeNull();
    expect(seen).toHaveLength(total);
    expect(new Set(seen).size).toBe(total);
    expect(seen[seen.length - 1]).toBe("update 0");
    // The tied rows straddle the boundary; none may be repeated or lost.
    for (let index = total - 6; index < total; index += 1) {
      expect(seen).toContain(`update ${index}`);
    }
  });

  it("refuses a cursor it did not issue rather than silently restarting", async (ctx) => {
    if (!db.available) return ctx.skip();
    // Restarting would make "load more" loop over page one forever, which
    // reads as data rather than as a bug.
    await expect(getProjectUpdates(db.pool!, owner, PROJECT, "not-a-cursor"))
      .rejects.toMatchObject({ statusCode: 422 });
  });

  it("tells a reader whether they may add to the account", async (ctx) => {
    if (!db.available) return ctx.skip();
    // Reading the account and adding to it are different permissions, and the
    // surface has to be told which it has — otherwise a viewer is offered a
    // composer that always refuses.
    await expect(getProjectUpdates(db.pool!, owner, PROJECT, null))
      .resolves.toMatchObject({ viewer_can_write: true });
    await db.pool!.query(
      `UPDATE project_members SET role = 'viewer' WHERE project_id = $1 AND user_id = $2`,
      [PROJECT, OTHER],
    );
    await expect(getProjectUpdates(db.pool!, { spaceId: SPACE, userId: OTHER }, PROJECT, null))
      .resolves.toMatchObject({ viewer_can_write: false });
  });

  it("appends a person's update through the writer gate, not the read gate", async (ctx) => {
    if (!db.available) return ctx.skip();
    // The route is the only producer of `project.reported`. Every other test
    // here stages events by calling the writer directly, so the lock, the
    // writer check and the actor resolution have never actually run.
    const post = async (userId: string): Promise<void> => {
      await withDbTransaction(db.pool!, async (client) => {
        await lockActiveProjectForMutation(client, SPACE, PROJECT);
        await assertProjectWriterForMutation(client, SPACE, PROJECT, userId);
        const actorId = await resolveUserActorId(client, SPACE, userId);
        await appendProjectWorkEvent(client, {
          spaceId: SPACE, projectId: PROJECT, eventKind: "project.reported",
          subjectType: "project", subjectId: PROJECT, actorId,
          data: { summary: "Standing up the pilot", via: "user" },
        });
      });
    };

    await post(OWNER);
    const listed = await getProjectUpdates(db.pool!, owner, PROJECT, null);
    expect(listed.items[0]?.summary).toBe("Standing up the pilot");

    // Reading the account and adding to it are different permissions.
    await db.pool!.query(
      `UPDATE project_members SET role = 'viewer' WHERE project_id = $1 AND user_id = $2`,
      [PROJECT, OTHER],
    );
    await expect(post(OTHER)).rejects.toMatchObject({ statusCode: 403 });
    await expect(getProjectUpdates(db.pool!, { spaceId: SPACE, userId: OTHER }, PROJECT, null))
      .resolves.toMatchObject({ viewer_can_write: false });
  });

  it("shows a Task closing, which nothing writes a report for", async (ctx) => {
    if (!db.available) return ctx.skip();
    const task = randomUUID();
    await makeTask({ id: task, title: "Draft the protocol", status: "done" });
    const actorId = await resolveUserActorId(db.pool!, SPACE, OWNER);
    await appendProjectWorkEvent(db.pool!, {
      spaceId: SPACE, projectId: PROJECT, eventKind: "task.accepted",
      subjectType: "task", subjectId: task, actorId, data: { reason: "evaluation_accept" },
    });

    // Close-out has no `task.reported` producer — the readable account belongs
    // to whoever wrote one — so the acceptance is rendered as itself rather
    // than dropped from the only surface that answers "what happened lately".
    const listed = await getProjectUpdates(db.pool!, owner, PROJECT, null);
    const closed = listed.items.find((item) => item.event_kind === "task.accepted");
    expect(closed?.subject).toMatchObject({ type: "task", title: "Draft the protocol" });
    expect(closed?.summary).toBe("Accepted");
    expect(closed?.outcome).toBe("accepted");
  });

  it("refuses a Project the reader is not in", async (ctx) => {
    if (!db.available) return ctx.skip();
    await expect(getProjectUpdates(db.pool!, { spaceId: SPACE, userId: randomUUID() }, PROJECT, null))
      .rejects.toBeInstanceOf(HttpError);
  });
});

describe("inquiry advancement in the Project's account", () => {
  // ADR 0017 §4: an Agent creates, archives and concludes without asking, so
  // this is where the person sees it and puts it back. Before this, an Agent
  // advancing a Thread left nothing on any Project surface at all.
  const threads = () => new InquiryThreadService(db.pool!);
  const iterations = () => new InquiryIterationService(db.pool!);
  const run = { runId: "44444444-4444-4444-8444-444444444444", agentId: AGENT };

  it("records a Thread an Agent created, attributes it to the Agent, and undoes it by archiving", async (ctx) => {
    if (!db.available) return ctx.skip();
    const thread = await threads().createThread(owner, PROJECT, {
      kind: "question", statement: "How should agent memory be classified?",
    }, run);

    const listed = await getProjectUpdates(db.pool!, owner, PROJECT, null);
    const created = listed.items.find((item) => item.event_kind === "thread.created");
    expect(created).toMatchObject({
      summary: "Question opened",
      subject: { type: "inquiry_thread", id: thread.id, title: "How should agent memory be classified?" },
      undo: { action: "archive_thread", target_id: thread.id },
      undone_by_event_id: null,
    });
    // The Agent did it, not the person who instructed the turn: a feed that
    // cannot say who acted fails at the first question it is read for.
    expect(created!.actor).toMatchObject({ kind: "agent", id: AGENT });

    await undoProjectUpdate(db.pool!, owner, PROJECT, created!.id);
    const after = await getProjectUpdates(db.pool!, owner, PROJECT, null);
    expect(after.items.find((item) => item.id === created!.id)).toMatchObject({
      undo: null,
      undone_by_event_id: expect.any(String),
    });
    expect(after.items.some((item) => item.event_kind === "thread.archived")).toBe(true);
    const row = await db.pool!.query<{ lifecycle_status: string }>(
      `SELECT lifecycle_status FROM inquiry_threads WHERE object_id = $1`, [thread.id],
    );
    expect(row.rows[0]!.lifecycle_status).toBe("archived");

    // A reversal is its own row; undoing it again is done from that row.
    await expect(undoProjectUpdate(db.pool!, owner, PROJECT, created!.id))
      .rejects.toMatchObject({ statusCode: 409 });
  });

  it("says nothing about a Thread the reader cannot see", async (ctx) => {
    if (!db.available) return ctx.skip();
    // The same rule Tasks already had: an update naming a Thread would leak
    // its statement, which is the part worth reading. This is the most
    // security-relevant of the new joins.
    await threads().createThread(owner, PROJECT, { kind: "question", statement: "Shared question" });
    const hidden = await threads().createThread(owner, PROJECT, {
      kind: "question", statement: "Private question",
    });
    await db.pool!.query(
      `UPDATE space_objects SET visibility = 'private', owner_user_id = $2 WHERE id = $1`,
      [hidden.id, OWNER],
    );

    const asOther = await getProjectUpdates(db.pool!, { spaceId: SPACE, userId: OTHER }, PROJECT, null);
    const statements = asOther.items.map((item) => item.subject?.title);
    expect(statements).toContain("Shared question");
    expect(statements).not.toContain("Private question");
    expect(asOther.items.every((item) => item.subject?.id !== hidden.id)).toBe(true);
    // The owner still sees both.
    const asOwner = await getProjectUpdates(db.pool!, owner, PROJECT, null);
    expect(asOwner.items.map((item) => item.subject?.title)).toContain("Private question");
  });

  it("counts one reversal per update however many events name it", async (ctx) => {
    if (!db.available) return ctx.skip();
    // A duplicated row consumes a slot of the page budget, breaks the keyset
    // cursor and makes the fold's adjacency scan see the same row twice, so
    // the correlated lookup must yield at most one.
    const thread = await threads().createThread(owner, PROJECT, {
      kind: "question", statement: "Reversed once",
    });
    const listed = await getProjectUpdates(db.pool!, owner, PROJECT, null);
    const created = listed.items.find((item) => item.event_kind === "thread.created")!;
    const actorId = await resolveUserActorId(db.pool!, SPACE, OWNER);
    for (const suffix of ["a", "b"]) {
      await appendProjectWorkEvent(db.pool!, {
        spaceId: SPACE, projectId: PROJECT, eventKind: "thread.archived",
        subjectType: "inquiry_thread", subjectId: String(thread.id), actorId,
        idempotencyKey: `dup:${suffix}`,
        data: { statement: "Reversed once", undo_of_event_id: created.id },
      });
    }

    const after = await getProjectUpdates(db.pool!, owner, PROJECT, null);
    expect(after.items.filter((item) => item.id === created.id)).toHaveLength(1);
  });

  it("folds one turn's decomposition into a single update whose members keep their own undo", async (ctx) => {
    if (!db.available) return ctx.skip();
    for (const statement of ["Axis: short vs long term", "Axis: episodic vs semantic", "Axis: per user vs per task"]) {
      await threads().createThread(owner, PROJECT, { kind: "question", statement }, run);
    }

    const listed = await getProjectUpdates(db.pool!, owner, PROJECT, null);
    const fold = listed.items.find((item) => item.event_kind === "thread.created");
    // One decomposition is one thing that happened. Three rows of it is the
    // per-item ceremony ADR 0017 removed from the approval queue, arriving
    // again in the feed.
    expect(fold).toMatchObject({ summary: "Opened 3 questions", subject: null, undo: null });
    expect(fold!.members).toHaveLength(3);
    expect(fold!.members!.every((member) => member.undo?.action === "archive_thread")).toBe(true);
    // The container is not its own first member: sharing an id renders the
    // same key twice once expanded, and inheriting the head's reversal would
    // read as "undone" for the whole batch.
    expect(fold!.members!.map((member) => member.id)).not.toContain(fold!.id);
    expect(fold!.undone_by_event_id).toBeNull();
    expect(listed.items.filter((item) => item.event_kind === "thread.created")).toHaveLength(1);
  });

  it("gives each half of an interrupted batch its own identity", async (ctx) => {
    if (!db.available) return ctx.skip();
    // Folding groups adjacent rows only, so one run's batch interrupted by
    // another event — or split across a page — becomes two folds. Keying them
    // on the batch would give both the same id, which in the browser is one
    // React key and one expanded state for two different groups.
    await threads().createThread(owner, PROJECT, { kind: "question", statement: "Batch A1" }, run);
    await threads().createThread(owner, PROJECT, { kind: "question", statement: "Batch A2" }, run);
    await threads().createThread(owner, PROJECT, { kind: "question", statement: "Someone else's question" });
    await threads().createThread(owner, PROJECT, { kind: "question", statement: "Batch A3" }, run);
    await threads().createThread(owner, PROJECT, { kind: "question", statement: "Batch A4" }, run);

    const listed = await getProjectUpdates(db.pool!, owner, PROJECT, null);
    const folds = listed.items.filter((item) => item.members);
    expect(folds).toHaveLength(2);
    expect(folds[0]!.id).not.toBe(folds[1]!.id);
    expect(new Set(listed.items.map((item) => item.id)).size).toBe(listed.items.length);
  });

  it("records a conclusion and reverts it to the position it replaced", async (ctx) => {
    if (!db.available) return ctx.skip();
    const thread = await threads().createThread(owner, PROJECT, {
      kind: "question", statement: "Does layering help?",
    });
    await iterations().recordIteration(owner, PROJECT, String(thread.id), {
      change_summary: "Partly answered", answer_state: "partial", current_answer_summary: "Layering helps recall",
    }, run);

    const listed = await getProjectUpdates(db.pool!, owner, PROJECT, null);
    const concluded = listed.items.find((item) => item.event_kind === "thread.concluded");
    expect(concluded).toMatchObject({
      summary: "Partly answered",
      undo: { action: "revert_iteration", target_id: thread.id },
    });

    await undoProjectUpdate(db.pool!, owner, PROJECT, concluded!.id);
    // Reverting records the previous position again rather than deleting the
    // Iteration: the Thread's history says it went one way and came back.
    const state = await db.pool!.query<{ answer_state: string }>(
      `SELECT answer_state FROM inquiry_question_states WHERE thread_id = $1`, [thread.id],
    );
    expect(state.rows[0]!.answer_state).toBe("open");
    const iterationRows = await db.pool!.query(`SELECT id FROM inquiry_iterations WHERE thread_id = $1`, [thread.id]);
    expect(iterationRows.rows).toHaveLength(2);
  });

  it("refuses to undo an update that records something already settled", async (ctx) => {
    if (!db.available) return ctx.skip();
    const task = randomUUID();
    await makeTask({ id: task, title: "Settled" });
    const actorId = await resolveUserActorId(db.pool!, SPACE, OWNER);
    const event = await appendProjectWorkEvent(db.pool!, {
      spaceId: SPACE, projectId: PROJECT, eventKind: "task.reported",
      subjectType: "task", subjectId: task, actorId, data: { summary: "reported", outcome: "progress" },
    });
    await expect(undoProjectUpdate(db.pool!, owner, PROJECT, event.id))
      .rejects.toMatchObject({ statusCode: 409 });
  });
});
