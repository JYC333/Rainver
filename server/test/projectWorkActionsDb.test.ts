import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { POLICY_ACTION_REGISTRY, SYSTEM_ACTION_REGISTRY } from "@rainver/protocol";
import { useTestDatabase } from "./support/testDatabase.js";
import { resetTables } from "./support/resetTables.js";
import { engineCheck } from "../src/modules/policy/decisionCore.js";
import { enforceDeclaredResourcePolicy } from "../src/modules/systemActions/systemActionDispatcher.js";
import { registerProjectWorkSystemActionExecutors } from "../src/modules/projectWork/projectWorkSystemActionExecutors.js";
import type { SystemActionExecutor } from "../src/modules/systemActions/gateway.js";
import type { SystemActionId } from "@rainver/protocol";
import { loadSystemActionRegistry } from "../src/modules/systemActions/registry.js";
import type { RunRecord } from "../src/modules/runs/repository.js";
import { ROOM_CONVERSATION_TOOL_ALLOWANCE } from "../src/modules/systemActions/scenarioToolAllowance.js";
import { resolveAgentActorId } from "../src/db/actorResolver.js";
import {
  advanceTaskStage,
  handoffTask,
  linkTaskEntities,
  reportOnTask,
  requestTaskReview,
} from "../src/modules/projectWork/taskActions.js";
import { HttpError } from "../src/modules/routeUtils/common.js";
import { PgTaskRepository } from "../src/modules/tasks/repository.js";

/**
 * The Agent's Project write surface.
 *
 * Two things need proving: that a person asking in a conversation and an
 * unattended wake-up are gated differently through one action definition, and
 * that each verb writes both its row and its event.
 */

const SPACE = "51111111-1111-4111-8111-111111111111";
const OWNER = "5aaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OUTSIDER = "5bbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const PROJECT = "5ccccccc-cccc-4ccc-8ccc-cccccccccccc";
const OTHER_PROJECT = "5fffffff-ffff-4fff-8fff-ffffffffffff";
const AGENT = "5ddddddd-dddd-4ddd-8ddd-dddddddddddd";
const OTHER_AGENT = "5eeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const ASSISTANT = "59999999-9999-4999-8999-999999999999";
const VERSION = "58888888-8888-4888-8888-888888888888";

const db = useTestDatabase(import.meta.filename);
const registry = new Map(POLICY_ACTION_REGISTRY.map((entry) => [entry.action, entry]));

async function makeTask(id: string, projectId: string | null = PROJECT, status = "in_progress"): Promise<void> {
  await db.pool!.query(
    `INSERT INTO tasks (id, space_id, project_id, title, status, created_by_user_id, owner_user_id, visibility, created_at, updated_at)
     VALUES ($1, $2, $3, 'Work item', $4, $5, $5, 'space_shared', now(), now())`,
    [id, SPACE, projectId, status, OWNER],
  );
}

/** An Experiment is a `space_objects` subtype, so it needs both rows. */
async function makeExperiment(objectId: string): Promise<void> {
  await db.pool!.query(
    `INSERT INTO space_objects (
       id, space_id, object_type, title, visibility, access_level, owner_user_id,
       primary_project_id, created_by_user_id, created_at, updated_at
     ) VALUES ($1, $2, 'experiment', 'Depth repair', 'space_shared', 'full', $3, $4, $3, now(), now())`,
    [objectId, SPACE, OWNER, PROJECT],
  );
  await db.pool!.query(
    `INSERT INTO experiment_definitions (object_id, space_id, project_id, status)
     VALUES ($1, $2, $3, 'draft')`,
    [objectId, SPACE, PROJECT],
  );
}

async function agentContext() {
  return {
    spaceId: SPACE,
    actorId: await resolveAgentActorId(db.pool!, SPACE, AGENT),
    agentId: AGENT,
    runId: randomUUID(),
    instructedByUserId: OWNER,
    idempotencyKey: randomUUID(),
  };
}

async function events(taskId: string): Promise<{ kind: string; data: Record<string, unknown> }[]> {
  const result = await db.pool!.query<{ event_kind: string; data_json: Record<string, unknown> }>(
    `SELECT event_kind, data_json FROM project_work_events
      WHERE space_id = $1 AND subject_id = $2 ORDER BY created_at, id`,
    [SPACE, taskId],
  );
  return result.rows.map((row) => ({ kind: row.event_kind, data: row.data_json }));
}

beforeEach(async () => {
  if (!db.available) return;
  await resetTables(
    db.pool!,
    [
      "project_work_events", "task_loop_states", "task_entity_links", "tasks",
      "experiment_definitions", "space_objects",
      "actors", "runs", "agent_versions", "agents", "project_members", "projects", "users", "spaces",
    ],
    { cascade: true },
  );
  for (const [id, name] of [[OWNER, "Owner"], [OUTSIDER, "Outsider"]] as const) {
    await db.pool!.query(
      `INSERT INTO users (id, display_name, status, created_at, updated_at)
       VALUES ($1, $2, 'active', now(), now())`,
      [id, name],
    );
  }
  await db.pool!.query(
    `INSERT INTO spaces (id, name, type, created_by_user_id, created_at, updated_at)
     VALUES ($1, 'Action Space', 'household', $2, now(), now())`,
    [SPACE, OWNER],
  );
  for (const id of [OWNER, OUTSIDER]) {
    await db.pool!.query(
      `INSERT INTO space_memberships (id, space_id, user_id, role, status, created_at, updated_at)
       VALUES ($1, $2, $3, 'member', 'active', now(), now())`,
      [randomUUID(), SPACE, id],
    );
  }
  for (const [id, name] of [[PROJECT, "Action Project"], [OTHER_PROJECT, "Elsewhere"]] as const) {
    await db.pool!.query(
      `INSERT INTO projects (id, space_id, owner_user_id, name, status, primary_mode, created_at, updated_at)
       VALUES ($1, $2, $3, $4, 'active', 'delivery', now(), now())`,
      [id, SPACE, OWNER, name],
    );
  }
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
  // The Room manager, which can never be dispatched to run a Task.
  await db.pool!.query(
    `INSERT INTO agents (id, space_id, owner_user_id, name, status, agent_kind, visibility, created_at, updated_at)
     VALUES ($1, $2, NULL, 'Space Assistant', 'active', 'system_assistant', 'space_shared', now(), now())`,
    [ASSISTANT, SPACE],
  );
  // Bound to a different Project, so it is not available to this Task's.
  await db.pool!.query(
    `INSERT INTO agents (id, space_id, project_id, owner_user_id, name, status, agent_kind, visibility, created_at, updated_at)
     VALUES ($1, $2, $3, $4, 'Elsewhere specialist', 'active', 'standard', 'space_shared', now(), now())`,
    [OTHER_AGENT, SPACE, OTHER_PROJECT, OWNER],
  );
});

describe("origin gate", () => {
  // The whole Project-internal write class (ADR 0017 §2), not only Tasks:
  // removing the proposal gate from Inquiry did not widen who may act, it
  // moved the question from who wrote it to whether anybody asked.
  const gated = [
    "task.create",
    "task.stage.advance",
    "inquiry.thread.create",
    "inquiry.iteration.record",
    "inquiry.advice.adopt",
    "research.acquisition.start",
  ];
  const ungated = ["task.report", "task.handoff", "task.request_review"];

  it("allows a structural write a person asked for in the turn", () => {
    for (const action of gated) {
      const decision = engineCheck(registry, { action, space_id: SPACE, trigger_origin: "manual" });
      expect(decision.decision, action).toBe("allow");
    }
  });

  it("requires approval for the same write from an unattended run", () => {
    // The write is the same write; what differs is that nobody asked for it.
    for (const action of gated) {
      for (const origin of ["autonomous", "automation"]) {
        const decision = engineCheck(registry, { action, space_id: SPACE, trigger_origin: origin });
        expect(decision.decision, `${action}/${origin}`).toBe("require_approval");
        expect(decision.reason_code).toBe("unattended_project_write");
      }
    }
  });

  it("leaves the append-only and self-limiting verbs alone whatever the origin", () => {
    // A report only records, a handoff can only give work away, and a review
    // request can only stop work. Gating them would mean an Agent advancing
    // work unattended could not say what it had done.
    for (const action of ungated) {
      for (const origin of ["manual", "autonomous", "automation"]) {
        expect(engineCheck(registry, { action, space_id: SPACE, trigger_origin: origin }).decision, `${action}/${origin}`)
          .toBe("allow");
      }
    }
  });
});

describe("registry wiring", () => {
  it("registers all five on the Room conversation surface", () => {
    for (const id of ["task.create", "task.report", "task.handoff", "task.advance_stage", "task.request_review"]) {
      expect(ROOM_CONVERSATION_TOOL_ALLOWANCE, id).toContain(id);
    }
  });

  it("keeps every action's policy action registered", () => {
    // The gateway resolves the policy action by name; an unregistered one
    // fails closed at dispatch rather than at boot.
    for (const definition of SYSTEM_ACTION_REGISTRY.filter((entry) => entry.id.startsWith("task."))) {
      expect(registry.has(definition.policy_action), definition.id).toBe(true);
    }
  });
});

describe("task.report", () => {
  it("appends a readable account and nothing else", async (ctx) => {
    if (!db.available) return ctx.skip();
    const task = randomUUID();
    await makeTask(task);
    const context = await agentContext();

    await reportOnTask(db.pool!, context, { task_id: task, summary: "Ran the sweep; 3 of 40 failed", outcome: "progress" });

    expect(await events(task)).toEqual([{
      kind: "task.reported",
      data: expect.objectContaining({ summary: "Ran the sweep; 3 of 40 failed", outcome: "progress" }),
    }]);
    const status = await db.pool!.query<{ status: string }>(`SELECT status FROM tasks WHERE id = $1`, [task]);
    expect(status.rows[0]?.status).toBe("in_progress");
  });

  it("refuses a Task outside any Project", async (ctx) => {
    if (!db.available) return ctx.skip();
    const task = randomUUID();
    await makeTask(task, null);
    await expect(reportOnTask(db.pool!, await agentContext(), { task_id: task, summary: "x" }))
      .rejects.toBeInstanceOf(HttpError);
  });

  it("records one advancement however often the call is redispatched", async (ctx) => {
    if (!db.available) return ctx.skip();
    const task = randomUUID();
    await makeTask(task);
    const context = await agentContext();
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await reportOnTask(db.pool!, context, { task_id: task, summary: "same call" });
    }
    expect(await events(task)).toHaveLength(1);
  });
});

describe("task.handoff", () => {
  it("moves the claim and records who it went to", async (ctx) => {
    if (!db.available) return ctx.skip();
    const task = randomUUID();
    await makeTask(task);

    await handoffTask(db.pool!, await agentContext(), {
      task_id: task,
      to: { kind: "user", id: OWNER },
      note: "needs your call on the baseline",
    });

    const row = await db.pool!.query<{ claimed_by_user_id: string | null }>(
      `SELECT claimed_by_user_id FROM tasks WHERE id = $1`, [task]);
    expect(row.rows[0]?.claimed_by_user_id).toBe(OWNER);
    expect((await events(task))[0]).toMatchObject({
      kind: "task.responsibility_changed",
      data: expect.objectContaining({ via: "agent", released: false }),
    });
  });

  it("releases the Task back to its assignment chain", async (ctx) => {
    if (!db.available) return ctx.skip();
    const task = randomUUID();
    await makeTask(task);
    await db.pool!.query(`UPDATE tasks SET claimed_by_agent_id = $2 WHERE id = $1`, [task, AGENT]);

    await handoffTask(db.pool!, await agentContext(), { task_id: task, to: null });

    const row = await db.pool!.query<{ claimed_by_agent_id: string | null; claimed_by_user_id: string | null }>(
      `SELECT claimed_by_agent_id, claimed_by_user_id FROM tasks WHERE id = $1`, [task]);
    expect(row.rows[0]).toEqual({ claimed_by_agent_id: null, claimed_by_user_id: null });
  });

  it("refuses to hand work to someone who cannot see the Project", async (ctx) => {
    if (!db.available) return ctx.skip();
    // An Agent that could hand a Task to anyone in the Space would be a way to
    // disclose it.
    const task = randomUUID();
    await makeTask(task);
    await expect(handoffTask(db.pool!, await agentContext(), { task_id: task, to: { kind: "user", id: OUTSIDER } }))
      .rejects.toMatchObject({ statusCode: 422 });
  });

  it("refuses an Agent bound to a different Project", async (ctx) => {
    if (!db.available) return ctx.skip();
    const task = randomUUID();
    await makeTask(task);
    await expect(handoffTask(db.pool!, await agentContext(), { task_id: task, to: { kind: "agent", id: OTHER_AGENT } }))
      .rejects.toMatchObject({ statusCode: 422 });
  });
});

describe("task.advance_stage", () => {
  it("moves the Loop and records the move as the Agent", async (ctx) => {
    if (!db.available) return ctx.skip();
    const task = randomUUID();
    await makeTask(task);

    await advanceTaskStage(db.pool!, await agentContext(), {
      task_id: task, to_stage: "verify", reason: "the run produced a result",
    });

    const loop = await db.pool!.query<{ current_stage_key: string }>(
      `SELECT current_stage_key FROM task_loop_states WHERE task_id = $1`, [task]);
    expect(loop.rows[0]?.current_stage_key).toBe("verify");
    expect((await events(task))[0]).toMatchObject({
      kind: "task.stage_changed",
      data: expect.objectContaining({ via: "agent", to_stage: "verify" }),
    });
  });
});

describe("task.request_review", () => {
  it("stops the work and says why, in one transaction", async (ctx) => {
    if (!db.available) return ctx.skip();
    // Without a deliberate way to hand the decision back, the only signals a
    // person gets are failures.
    const task = randomUUID();
    await makeTask(task);

    await requestTaskReview(db.pool!, await agentContext(), {
      task_id: task,
      reason: "Experiment #12 contradicts the assumption the plan rests on",
      options: ["Return to the method", "Accept the new baseline"],
    });

    const row = await db.pool!.query<{ status: string }>(`SELECT status FROM tasks WHERE id = $1`, [task]);
    expect(row.rows[0]?.status).toBe("waiting_for_review");
    const recorded = await events(task);
    expect(recorded.map((event) => event.kind)).toEqual(["task.flow_changed", "task.reported"]);
    expect(recorded[1]?.data).toMatchObject({
      outcome: "stuck",
      options: ["Return to the method", "Accept the new baseline"],
    });
  });

  it("refuses a Task a person already finished", async (ctx) => {
    if (!db.available) return ctx.skip();
    const task = randomUUID();
    await makeTask(task, PROJECT, "done");
    await expect(requestTaskReview(db.pool!, await agentContext(), { task_id: task, reason: "x" }))
      .rejects.toMatchObject({ statusCode: 409 });
  });
});

describe("an Agent's reach is the instructing person's", () => {
  it("refuses every Task action when the person behind it is a viewer", async (ctx) => {
    if (!db.available) return ctx.skip();
    const task = randomUUID();
    await makeTask(task);
    await db.pool!.query(
      `INSERT INTO project_members (id, space_id, project_id, user_id, role, status, created_at, updated_at)
       VALUES ($1, $2, $3, $4, 'viewer', 'active', now(), now())`,
      [randomUUID(), SPACE, PROJECT, OUTSIDER],
    );
    const context = { ...(await agentContext()), instructedByUserId: OUTSIDER };

    // A viewer can read every shared Task and change none of them — through
    // an Agent exactly as directly.
    await expect(reportOnTask(db.pool!, context, { task_id: task, summary: "x", outcome: "progress" }))
      .rejects.toMatchObject({ statusCode: 403 });
    await expect(handoffTask(db.pool!, context, { task_id: task, to: null }))
      .rejects.toMatchObject({ statusCode: 403 });
    await expect(advanceTaskStage(db.pool!, context, { task_id: task, to_stage: "act", reason: "x" }))
      .rejects.toMatchObject({ statusCode: 403 });
    await expect(requestTaskReview(db.pool!, context, { task_id: task, reason: "x" }))
      .rejects.toMatchObject({ statusCode: 403 });
    expect(await events(task)).toEqual([]);
  });

  it("asks once: a second review request while the first is pending is refused", async (ctx) => {
    if (!db.available) return ctx.skip();
    const task = randomUUID();
    await makeTask(task);
    await requestTaskReview(db.pool!, await agentContext(), { task_id: task, reason: "which way?" });
    await expect(requestTaskReview(db.pool!, await agentContext(), { task_id: task, reason: "again?" }))
      .rejects.toMatchObject({ statusCode: 409 });
    // One flow event, one report — not two of each.
    const kinds = (await events(task)).map((event) => event.kind);
    expect(kinds.filter((kind) => kind === "task.flow_changed")).toHaveLength(1);
    expect(kinds.filter((kind) => kind === "task.reported")).toHaveLength(1);
  });

  it("cannot hand off work that is finished", async (ctx) => {
    if (!db.available) return ctx.skip();
    const task = randomUUID();
    await makeTask(task, PROJECT, "done");
    await expect(handoffTask(db.pool!, await agentContext(), { task_id: task, to: null }))
      .rejects.toMatchObject({ statusCode: 409 });
  });
});

describe("task_entity_links", () => {
  it("binds a Task to what it advances", async (ctx) => {
    if (!db.available) return ctx.skip();
    const task = randomUUID();
    const experiment = randomUUID();
    await makeTask(task);
    await makeExperiment(experiment);
    const context = await agentContext();

    await linkTaskEntities(db.pool!, context, task, [
      { entity_type: "experiment", entity_id: experiment, role: "executes" },
    ]);
    // The same link twice is one edge, not two.
    await linkTaskEntities(db.pool!, context, task, [
      { entity_type: "experiment", entity_id: experiment, role: "executes" },
    ]);

    const links = await db.pool!.query<{ entity_type: string; role: string }>(
      `SELECT entity_type, role FROM task_entity_links WHERE task_id = $1`, [task]);
    expect(links.rows).toEqual([{ entity_type: "experiment", role: "executes" }]);
  });

  it("refuses an id that exists but is a different kind of object", async (ctx) => {
    if (!db.available) return ctx.skip();
    const task = randomUUID();
    const experiment = randomUUID();
    await makeTask(task);
    await makeExperiment(experiment);

    // Every ontology subtype shares one table, so the id alone proves only
    // that something exists. Declaring it as the wrong kind would be accepted
    // and then rendered as that kind on the Work tab.
    await expect(linkTaskEntities(db.pool!, await agentContext(), task, [
      { entity_type: "decision_case", entity_id: experiment, role: "references" },
    ])).rejects.toMatchObject({ statusCode: 404 });

    const links = await db.pool!.query(
      `SELECT 1 FROM task_entity_links WHERE task_id = $1`, [task]);
    expect(links.rowCount).toBe(0);
  });

  it("refuses an entity type nothing registered", async (ctx) => {
    if (!db.available) return ctx.skip();
    const task = randomUUID();
    await makeTask(task);
    // A domain joins by registering, not by writing a new string here.
    await expect(linkTaskEntities(db.pool!, await agentContext(), task, [
      { entity_type: "unicorn", entity_id: randomUUID(), role: "executes" },
    ])).rejects.toMatchObject({ statusCode: 422 });
  });

  it("refuses an entity this Space does not contain", async (ctx) => {
    if (!db.available) return ctx.skip();
    // The row carries no FK on `entity_id`, so an unchecked id would assert a
    // binding to something that is not here — and the first consumer that
    // joins through it to resolve a title turns that into a cross-Space read.
    const task = randomUUID();
    await makeTask(task);
    await expect(linkTaskEntities(db.pool!, await agentContext(), task, [
      { entity_type: "experiment", entity_id: randomUUID(), role: "executes" },
    ])).rejects.toMatchObject({ statusCode: 404 });
  });
});

describe("task.create attribution", () => {
  it("credits the Agent that made the Task, not the person who asked", async (ctx) => {
    if (!db.available) return ctx.skip();
    // The Task is owned by the person — they asked, and it inherits their
    // access — but the timeline records who did what, and a Task the Agent
    // decomposed out of a request did not appear because the person typed it.
    // The event is keyed on the Task, so a second write cannot correct this
    // afterwards: the attribution has to be right the first time.
    const context = await agentContext();
    const created = await new PgTaskRepository(db.pool!).createTask(
      { spaceId: SPACE, userId: OWNER },
      { project_id: PROJECT, title: "Split out by the Agent" },
      db.pool!,
      context.actorId,
    );

    const attribution = await db.pool!.query<{ agent_id: string | null; user_id: string | null }>(
      `SELECT a.agent_id, a.user_id
         FROM project_work_events e
         JOIN actors a ON a.id = e.actor_id
        WHERE e.subject_id = $1 AND e.event_kind = 'task.created'`,
      [created.id],
    );
    expect(attribution.rows).toHaveLength(1);
    expect(attribution.rows[0]).toEqual({ agent_id: AGENT, user_id: null });

    const owner = await db.pool!.query<{ owner_user_id: string }>(
      `SELECT owner_user_id FROM tasks WHERE id = $1`, [created.id]);
    expect(owner.rows[0]?.owner_user_id).toBe(OWNER);
  });

  it("still credits the person on the ordinary create path", async (ctx) => {
    if (!db.available) return ctx.skip();
    const created = await new PgTaskRepository(db.pool!).createTask(
      { spaceId: SPACE, userId: OWNER },
      { project_id: PROJECT, title: "Typed by a person" },
    );
    const attribution = await db.pool!.query<{ user_id: string | null }>(
      `SELECT a.user_id FROM project_work_events e
         JOIN actors a ON a.id = e.actor_id
        WHERE e.subject_id = $1 AND e.event_kind = 'task.created'`,
      [created.id],
    );
    expect(attribution.rows[0]?.user_id).toBe(OWNER);
  });
});

describe("the origin gate at the dispatch path", () => {
  /**
   * The band the decision-table cases above cannot reach.
   *
   * `engineCheck` with a hand-built ctx proves the rule; it says nothing about
   * whether anything ever supplies `trigger_origin`. The first version of this
   * phase did not, so the gate was inert at every real dispatch while its unit
   * cases passed — the same shape of gap P1 and P2 each hit once.
   */
  async function enforceFor(runOverrides: Partial<RunRecord> & { trigger_origin: string }, actionId: string) {
    const registry = await loadSystemActionRegistry();
    const definition = [...registry.values()].find((entry) => entry.id === actionId)!;
    const run = {
      id: randomUUID(),
      space_id: SPACE,
      agent_id: AGENT,
      project_id: PROJECT,
      instructed_by_user_id: OWNER,
      status: "running",
      ...runOverrides,
    } as unknown as RunRecord;
    return enforceDeclaredResourcePolicy(
      db.connectionUri,
      definition,
      definition.policy_resource!,
      { project_id: PROJECT, task_id: randomUUID() },
      run,
    );
  }

  it("lets through a structural write a person asked for", async (ctx) => {
    if (!db.available) return ctx.skip();
    for (const actionId of ["task.create", "task.advance_stage"]) {
      const decision = await enforceFor({ trigger_origin: "manual" }, actionId);
      expect(decision.allowed, actionId).toBe(true);
    }
  });

  it("refuses the same write from an unattended run, through the real path", async (ctx) => {
    if (!db.available) return ctx.skip();
    for (const actionId of ["task.create", "task.advance_stage"]) {
      for (const origin of ["autonomous", "automation", "job", "system"]) {
        const decision = await enforceFor({ trigger_origin: origin }, actionId);
        expect(decision.allowed, `${actionId}/${origin}`).toBe(false);
      }
    }
  });

  it("does not let a delegated child launder its root's origin", async (ctx) => {
    if (!db.available) return ctx.skip();
    // A delegated child carries `delegation` whoever started the chain, so
    // reading its own origin would let an autonomous root hand a gated write
    // to a specialist and have it go through unasked.
    const root = randomUUID();
    await db.pool!.query(
      `INSERT INTO runs (
         id, space_id, agent_id, agent_version_id, project_id, trust_mode, run_type,
         trigger_origin, status, mode, owner_user_id, created_at, updated_at
       ) VALUES ($1, $2, $3, $6, $4, 'sandboxed', 'agent', 'autonomous', 'running', 'live', $5, now(), now())`,
      [root, SPACE, AGENT, PROJECT, OWNER, VERSION],
    );
    const decision = await enforceFor({ trigger_origin: "delegation", root_run_id: root }, "task.create");
    expect(decision.allowed).toBe(false);
  });

  it("still lets a delegated child of a person's turn through", async (ctx) => {
    if (!db.available) return ctx.skip();
    const root = randomUUID();
    await db.pool!.query(
      `INSERT INTO runs (
         id, space_id, agent_id, agent_version_id, project_id, trust_mode, run_type,
         trigger_origin, status, mode, owner_user_id, created_at, updated_at
       ) VALUES ($1, $2, $3, $6, $4, 'sandboxed', 'agent', 'manual', 'running', 'live', $5, now(), now())`,
      [root, SPACE, AGENT, PROJECT, OWNER, VERSION],
    );
    const decision = await enforceFor({ trigger_origin: "delegation", root_run_id: root }, "task.create");
    expect(decision.allowed).toBe(true);
  });

  it("lets a person's turn carry a proposal decision, and nothing else", async (ctx) => {
    if (!db.available) return ctx.skip();
    // The Agent carries the decision; it never authors one. A scheduled
    // wake-up or a delegation saying "accept it" is the Agent deciding.
    expect((await enforceFor({ trigger_origin: "manual" }, "proposal.decide")).allowed).toBe(true);
    for (const origin of ["autonomous", "automation", "delegation"]) {
      expect((await enforceFor({ trigger_origin: origin }, "proposal.decide")).allowed, origin).toBe(false);
    }
  });

  it("leaves the append-only and self-limiting verbs alone at any origin", async (ctx) => {
    if (!db.available) return ctx.skip();
    for (const actionId of ["task.report", "task.handoff", "task.request_review"]) {
      for (const origin of ["manual", "autonomous", "automation"]) {
        const decision = await enforceFor({ trigger_origin: origin }, actionId);
        expect(decision.allowed, `${actionId}/${origin}`).toBe(true);
      }
    }
  });
});

describe("the executor band", () => {
  /**
   * Between the policy adapter and the domain functions.
   *
   * The cases above prove the rule and the domain writes; the executors are
   * where the Project scope, the actor, and the idempotency key are actually
   * composed, and every P3 blocker but one lived exactly here.
   */
  function executorsFor(overrides: Record<string, unknown> = {}) {
    const executors = new Map<SystemActionId, SystemActionExecutor>();
    const run = {
      id: randomUUID(),
      space_id: SPACE,
      agent_id: AGENT,
      agent_version_id: VERSION,
      project_id: PROJECT,
      instructed_by_user_id: OWNER,
      trigger_origin: "manual",
      status: "running",
      ...overrides,
    } as never;
    registerProjectWorkSystemActionExecutors(
      executors,
      { databaseUrl: db.connectionUri } as never,
      run,
    );
    return { executors, run };
  }

  const dispatch = (key: string) => ({
    actor: { type: "agent" as const, id: AGENT },
    visibility: "agent_tool" as const,
    idempotency_key: key,
  } as never);

  it("lists this Project's Tasks with the ids a later action must carry", async (ctx) => {
    if (!db.available) return ctx.skip();
    const mine = randomUUID();
    const elsewhere = randomUUID();
    const done = randomUUID();
    await makeTask(mine);
    await makeTask(elsewhere, OTHER_PROJECT);
    await makeTask(done, PROJECT, "done");
    const { executors } = executorsFor();

    const all = await executors.get("task.list" as SystemActionId)!({}, dispatch(randomUUID())) as { modelResult: Record<string, unknown>; summary: Record<string, unknown> };
    const listed = (all.modelResult as { tasks: Array<{ task_id: string; status: string }> }).tasks;
    expect(listed.map((task) => task.task_id).sort()).toEqual([mine, done].sort());
    expect(listed[0]).toMatchObject({ title: "Work item", status: expect.any(String) });

    const open = await executors.get("task.list" as SystemActionId)!({ status: "in_progress" }, dispatch(randomUUID())) as { modelResult: Record<string, unknown>; summary: Record<string, unknown> };
    expect((open.modelResult as { tasks: Array<{ task_id: string }> }).tasks.map((task) => task.task_id)).toEqual([mine]);
  });

  it("answers an invented task_id with the ids that exist", async (ctx) => {
    if (!db.available) return ctx.skip();
    // The failure a composed id used to produce said only "Task not found",
    // which left the model no way to correct itself.
    const real = randomUUID();
    await makeTask(real);
    const { executors } = executorsFor();
    await expect(executors.get("task.report" as SystemActionId)!(
      { task_id: "memory-chapter", summary: "done" },
      dispatch(randomUUID()),
    )).rejects.toMatchObject({
      statusCode: 404,
      message: `No Task in this Project has id 'memory-chapter'. Use one of these ids exactly: ${real} — Work item`,
    });
  });

  it("creates the Task in the Run's own Project", async (ctx) => {
    if (!db.available) return ctx.skip();
    const { executors } = executorsFor();
    await executors.get("task.create" as SystemActionId)!(
      { title: "Split out by the Agent" },
      dispatch(randomUUID()),
    );
    const row = await db.pool!.query<{ project_id: string }>(
      `SELECT project_id FROM tasks WHERE title = 'Split out by the Agent'`);
    expect(row.rows[0]?.project_id).toBe(PROJECT);
  });

  it("refuses a Project the model named that is not the Run's", async (ctx) => {
    if (!db.available) return ctx.skip();
    // Taking the Project from the input let an Agent write into one the person
    // it acts for is not a member of.
    const { executors } = executorsFor();
    await expect(executors.get("task.create" as SystemActionId)!(
      { project_id: OTHER_PROJECT, title: "Elsewhere" },
      dispatch(randomUUID()),
    )).rejects.toMatchObject({ statusCode: 422 });
  });

  it("refuses to create a Task from a Run with no Project", async (ctx) => {
    if (!db.available) return ctx.skip();
    const { executors } = executorsFor({ project_id: null });
    await expect(executors.get("task.create" as SystemActionId)!(
      { title: "Unscoped" },
      dispatch(randomUUID()),
    )).rejects.toMatchObject({ statusCode: 422 });
  });

  it("refuses when the person it acts for is not a Project writer", async (ctx) => {
    if (!db.available) return ctx.skip();
    // Authority is the instructing person's, re-checked under the aggregate
    // lock rather than assumed from the Run having a Project.
    const { executors } = executorsFor({ instructed_by_user_id: OUTSIDER });
    await expect(executors.get("task.create" as SystemActionId)!(
      { title: "Not mine to make" },
      dispatch(randomUUID()),
    )).rejects.toBeInstanceOf(HttpError);
  });

  it("refuses to touch a Task the person it acts for cannot see", async (ctx) => {
    if (!db.available) return ctx.skip();
    const task = randomUUID();
    await db.pool!.query(
      `INSERT INTO tasks (id, space_id, project_id, title, status, created_by_user_id, owner_user_id, visibility, created_at, updated_at)
       VALUES ($1, $2, $3, 'Private work', 'in_progress', $4, $4, 'private', now(), now())`,
      [task, SPACE, PROJECT, OWNER],
    );
    // An Agent's reach is the instructing person's, never wider: without the
    // read predicate any Room's Agent could name a private Task's id.
    const { executors } = executorsFor({ instructed_by_user_id: OUTSIDER });
    await expect(executors.get("task.report" as SystemActionId)!(
      { task_id: task, summary: "peeking" },
      dispatch(randomUUID()),
    )).rejects.toMatchObject({ statusCode: 404 });
  });

  it("keys events per attempt, so a Supervisor retry is not swallowed", async (ctx) => {
    if (!db.available) return ctx.skip();
    // A retry re-executes the same run id in a fresh process whose tool-call
    // counter restarts at 1. Keyed on the Run alone, attempt 2's first report
    // resolved to attempt 1's event and answered ok.
    const taskA = randomUUID();
    const taskB = randomUUID();
    await makeTask(taskA);
    await makeTask(taskB);
    const { executors, run } = executorsFor();
    const runId = (run as { id: string }).id;
    await db.pool!.query(
      `INSERT INTO runs (
         id, space_id, agent_id, agent_version_id, project_id, trust_mode, run_type,
         trigger_origin, status, mode, owner_user_id, created_at, updated_at
       ) VALUES ($1, $2, $3, $4, $5, 'sandboxed', 'agent', 'manual', 'running', 'live', $6, now(), now())`,
      [runId, SPACE, AGENT, VERSION, PROJECT, OWNER],
    );
    const attempt = async (n: number, taskId: string) => {
      await db.pool!.query(
        `INSERT INTO run_attempts (id, space_id, run_id, attempt_number, status, created_at, updated_at)
         VALUES ($1, $2, $3, $4, 'running', now(), now())`,
        [randomUUID(), SPACE, runId, n],
      );
      // The same JSON-RPC call id each attempt, which is what a restarted
      // counter produces.
      await executors.get("task.report" as SystemActionId)!(
        { task_id: taskId, summary: `attempt ${n}` },
        dispatch("1"),
      );
    };
    await attempt(1, taskA);
    await attempt(2, taskB);

    expect(await events(taskA)).toHaveLength(1);
    expect(await events(taskB)).toHaveLength(1);
  });
});
