import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { useTestDatabase } from "./support/testDatabase.js";
import { resetTables } from "./support/resetTables.js";
import { PgRunToolIdentityRepository } from "../src/modules/runs/runToolIdentityRepository.js";
import {
  applyRunArtifactDeclarations,
  declareRunArtifact,
  normalizeDeclaredPath,
} from "../src/modules/projectWork/artifactDeclarations.js";
import { projectTaskStatusFromRun } from "../src/modules/tasks/taskRunStatusProjection.js";
import { resolveAgentActorId } from "../src/db/actorResolver.js";
import { renderWorkSkill, workSkillContentHash } from "../src/modules/capabilities/workSkill.js";
import { dispatchToolAllowance } from "../src/modules/systemActions/scenarioToolAllowance.js";
import { buildRunToolGrants } from "../src/modules/systemActions/runToolGrants.js";
import {
  ACTION_RESULT_REPORTING_POLICY,
  DURABLE_ACTION_CLAIM_POLICY,
  IDENTIFIER_POLICY,
} from "../src/modules/systemActions/conversationPolicy.js";
import { requireProjectTask } from "../src/modules/projectWork/taskActions.js";
import { seedMainlineRoomsForAllProjects } from "./support/domainSeeds.js";

/**
 * Real-Postgres coverage for the surface a dispatched agent works through.
 *
 * Two things need a database rather than a stub. The tool identity is the
 * thing that must survive a server restart, which is only meaningful against
 * a real row. And an artifact declaration only earns its place if a declared
 * output actually closes its Task — that runs through settlement's own SQL,
 * `task_artifacts`, and `required_outputs_json` matching, none of which a fake
 * would exercise.
 */

const SPACE = "51111111-1111-4111-8111-111111111111";
const USER = "5aaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const PROJECT = "5bbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const AGENT = "5ccccccc-cccc-4ccc-8ccc-cccccccccccc";
const VERSION = "5ddddddd-dddd-4ddd-8ddd-dddddddddddd";

const db = useTestDatabase(import.meta.filename);

async function makeTask(taskId: string, requiredOutputs: string[] | null = null): Promise<void> {
  await db.pool!.query(
    `INSERT INTO tasks (
       id, space_id, project_id, title, status, required_outputs_json,
       created_by_user_id, owner_user_id, created_at, updated_at
     ) VALUES ($1, $2, $3, 'Write the report', 'in_progress', $4::jsonb, $5, $5, now(), now())`,
    [taskId, SPACE, PROJECT, JSON.stringify(requiredOutputs), USER],
  );
}

async function makeRun(runId: string, taskId: string, status = "running"): Promise<void> {
  await db.pool!.query(
    `INSERT INTO runs (
       id, space_id, agent_id, agent_version_id, project_id, trust_mode, run_type,
       trigger_origin, status, mode, owner_user_id, instructed_by_user_id, created_at, updated_at
     ) VALUES ($1, $2, $3, $4, $5, 'trusted_host', 'system', 'manual', $6, 'live', $7, $7, now(), now())`,
    [runId, SPACE, AGENT, VERSION, PROJECT, status, USER],
  );
  await db.pool!.query(
    `INSERT INTO task_runs (id, space_id, task_id, run_id, role, created_at)
     VALUES ($1, $2, $3, $4, 'primary', now())`,
    [randomUUID(), SPACE, taskId, runId],
  );
}

/** An uploaded output file, as the executing host records one. */
async function uploadArtifact(runId: string, name: string): Promise<string> {
  const id = randomUUID();
  await db.pool!.query(
    `INSERT INTO artifacts (
       id, space_id, run_id, artifact_type, title, content, mime_type,
       exportable, export_formats_json, preview, created_at, updated_at,
       metadata_json, visibility, owner_user_id, trust_level, project_id
     ) VALUES ($1, $2, $3, 'remote_output', $4, 'body', 'text/plain',
       true, '["text/plain"]'::jsonb, false, now(), now(),
       '{}'::jsonb, 'space_shared', $5, 'unknown', $6)`,
    [id, SPACE, runId, name, USER, PROJECT],
  );
  return id;
}

async function contextFor(runId: string): Promise<{
  spaceId: string; actorId: string; agentId: string; runId: string;
  instructedByUserId: string; idempotencyKey: string;
}> {
  return {
    spaceId: SPACE,
    actorId: await resolveAgentActorId(db.pool!, SPACE, AGENT),
    agentId: AGENT,
    runId,
    instructedByUserId: USER,
    idempotencyKey: `${runId}:1:call-1`,
  };
}

async function finalize(runId: string): Promise<void> {
  await db.pool!.query(
    `INSERT INTO run_finalizations (
       id, space_id, run_id, attempt_number, finalizer_version, status, finalized_at, created_at
     ) VALUES ($1, $2, $3, 1, 'test', 'completed', now(), now())`,
    [randomUUID(), SPACE, runId],
  );
  await db.pool!.query(
    `INSERT INTO task_evaluations (
       id, space_id, task_id, run_id, evaluator_type, recommendation, created_at
     ) SELECT $1::varchar, $2::varchar, tr.task_id, $3::varchar, 'system', 'accept', now()
         FROM task_runs tr WHERE tr.run_id = $3::varchar`,
    [randomUUID(), SPACE, runId],
  );
  await db.pool!.query(`UPDATE runs SET status = 'succeeded' WHERE id = $1`, [runId]);
}

beforeEach(async () => {
  if (!db.available) return;
  await resetTables(
    db.pool!,
    [
      "run_artifact_declarations", "run_tool_identities",
      "project_work_events", "task_loop_states", "task_evaluations", "task_artifacts",
      "run_finalizations", "task_runs", "tasks", "artifacts", "runs", "actors",
      "agent_versions", "agents", "projects", "users", "spaces",
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
     VALUES ($1, 'Work Surface Space', 'household', $2, now(), now())`,
    [SPACE, USER],
  );
  await db.pool!.query(
    `INSERT INTO space_memberships (id, space_id, user_id, role, status, created_at, updated_at)
     VALUES ($1, $2, $3, 'owner', 'active', now(), now())`,
    [randomUUID(), SPACE, USER],
  );
  await db.pool!.query(
    `INSERT INTO projects (id, space_id, owner_user_id, name, status, created_at, updated_at)
     VALUES ($1, $2, $3, 'Work Surface Project', 'active', now(), now())`,
    [PROJECT, SPACE, USER],
  );
  await seedMainlineRoomsForAllProjects(db.pool!);
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

describe("run tool identity", () => {
  it("resolves a live token for its own Run and refuses it for another", async (ctx) => {
    if (!db.available) return ctx.skip();
    const run = randomUUID();
    const other = randomUUID();
    const task = randomUUID();
    await makeTask(task);
    await makeRun(run, task);
    await makeRun(other, task);
    const identities = new PgRunToolIdentityRepository(db.pool!);

    const token = await identities.issue({ id: run, space_id: SPACE }, 60_000);

    expect(await identities.resolve(token, run)).toMatchObject({ run_id: run, space_id: SPACE });
    // A token issued for one Run must not be replayable against another's route.
    expect(await identities.resolve(token, other)).toBeNull();
  });

  it("stores only a digest, so the table cannot hand back a usable token", async (ctx) => {
    if (!db.available) return ctx.skip();
    const run = randomUUID();
    const task = randomUUID();
    await makeTask(task);
    await makeRun(run, task);

    const token = await new PgRunToolIdentityRepository(db.pool!)
      .issue({ id: run, space_id: SPACE }, 60_000);

    const stored = await db.pool!.query<{ token_digest: string }>(
      `SELECT token_digest FROM run_tool_identities WHERE run_id = $1`,
      [run],
    );
    expect(stored.rows[0]!.token_digest).not.toBe(token);
    expect(stored.rows[0]!.token_digest).toMatch(/^[0-9a-f]{64}$/);
  });

  it("stops resolving once revoked, and after it expires", async (ctx) => {
    if (!db.available) return ctx.skip();
    const run = randomUUID();
    const expired = randomUUID();
    const task = randomUUID();
    await makeTask(task);
    await makeRun(run, task);
    await makeRun(expired, task);
    const identities = new PgRunToolIdentityRepository(db.pool!);
    const token = await identities.issue({ id: run, space_id: SPACE }, 60_000);
    const staleToken = await identities.issue({ id: expired, space_id: SPACE }, 60_000);
    await db.pool!.query(
      `UPDATE run_tool_identities SET expires_at = now() - interval '1 minute' WHERE run_id = $1`,
      [expired],
    );

    await identities.revoke(run);

    expect(await identities.resolve(token, run)).toBeNull();
    expect(await identities.resolve(staleToken, expired)).toBeNull();
  });

  it("re-issues for a retried attempt and stops the previous token working", async (ctx) => {
    if (!db.available) return ctx.skip();
    const run = randomUUID();
    const task = randomUUID();
    await makeTask(task);
    await makeRun(run, task);
    const identities = new PgRunToolIdentityRepository(db.pool!);
    const first = await identities.issue({ id: run, space_id: SPACE }, 60_000);

    const second = await identities.issue({ id: run, space_id: SPACE }, 60_000);

    expect(second).not.toBe(first);
    expect(await identities.resolve(first, run)).toBeNull();
    expect(await identities.resolve(second, run)).toMatchObject({ run_id: run });
  });
});

describe("artifact declarations", () => {
  it("closes a Task whose declared output arrived with the declared type", async (ctx) => {
    if (!db.available) return ctx.skip();
    const task = randomUUID();
    const run = randomUUID();
    await makeTask(task, ["report"]);
    await makeRun(run, task);
    await declareRunArtifact(
      db.pool!,
      await contextFor(run),
      { id: task, project_id: PROJECT },
      { path: "./report.md", artifact_type: "report", role: "output" },
    );
    const artifactId = await uploadArtifact(run, "report.md");

    await applyRunArtifactDeclarations(db.pool!, { id: run, space_id: SPACE }, [
      { artifact_id: artifactId, name: "report.md" },
    ]);
    await finalize(run);
    await projectTaskStatusFromRun(db.pool!, SPACE, run);

    const artifact = await db.pool!.query<{ artifact_type: string }>(
      `SELECT artifact_type FROM artifacts WHERE id = $1`,
      [artifactId],
    );
    expect(artifact.rows[0]!.artifact_type).toBe("report");
    const link = await db.pool!.query<{ role: string; run_id: string }>(
      `SELECT role, run_id FROM task_artifacts WHERE task_id = $1 AND artifact_id = $2`,
      [task, artifactId],
    );
    expect(link.rows[0]).toMatchObject({ role: "output", run_id: run });
    const status = await db.pool!.query<{ status: string }>(
      `SELECT status FROM tasks WHERE id = $1`,
      [task],
    );
    expect(status.rows[0]!.status).toBe("done");
  });

  it("leaves the same Task waiting when nothing was declared", async (ctx) => {
    if (!db.available) return ctx.skip();
    // The gap this whole surface exists to close: an uploaded file typed
    // `remote_output` matches no declared required output, so a finished Run
    // parks its Task however well the work went.
    const task = randomUUID();
    const run = randomUUID();
    await makeTask(task, ["report"]);
    await makeRun(run, task);
    const artifactId = await uploadArtifact(run, "report.md");

    await applyRunArtifactDeclarations(db.pool!, { id: run, space_id: SPACE }, [
      { artifact_id: artifactId, name: "report.md" },
    ]);
    await finalize(run);
    await projectTaskStatusFromRun(db.pool!, SPACE, run);

    const status = await db.pool!.query<{ status: string }>(
      `SELECT status FROM tasks WHERE id = $1`,
      [task],
    );
    expect(status.rows[0]!.status).toBe("waiting_for_review");
  });

  it("does not close a Task when the declared type is not the required one", async (ctx) => {
    if (!db.available) return ctx.skip();
    const task = randomUUID();
    const run = randomUUID();
    await makeTask(task, ["report"]);
    await makeRun(run, task);
    await declareRunArtifact(
      db.pool!,
      await contextFor(run),
      { id: task, project_id: PROJECT },
      { path: "notes.md", artifact_type: "notes", role: "output" },
    );
    const artifactId = await uploadArtifact(run, "notes.md");

    await applyRunArtifactDeclarations(db.pool!, { id: run, space_id: SPACE }, [
      { artifact_id: artifactId, name: "notes.md" },
    ]);
    await finalize(run);
    await projectTaskStatusFromRun(db.pool!, SPACE, run);

    const status = await db.pool!.query<{ status: string }>(
      `SELECT status FROM tasks WHERE id = $1`,
      [task],
    );
    expect(status.rows[0]!.status).toBe("waiting_for_review");
  });

  it("reports a declaration whose file never arrived instead of dropping it", async (ctx) => {
    if (!db.available) return ctx.skip();
    const task = randomUUID();
    const run = randomUUID();
    await makeTask(task, ["report"]);
    await makeRun(run, task);
    await declareRunArtifact(
      db.pool!,
      await contextFor(run),
      { id: task, project_id: PROJECT },
      { path: "report.md", artifact_type: "report", role: "output" },
    );

    const result = await applyRunArtifactDeclarations(
      db.pool!,
      { id: run, space_id: SPACE },
      [{ artifact_id: await uploadArtifact(run, "other.md"), name: "other.md" }],
    );

    expect(result).toMatchObject({ applied: 0, missing: ["report.md"] });
    const events = await db.pool!.query<{ data_json: { summary: string; outcome: string } }>(
      `SELECT data_json FROM project_work_events
        WHERE space_id = $1 AND subject_id = $2 AND event_kind = 'task.reported'
        ORDER BY created_at DESC LIMIT 1`,
      [SPACE, task],
    );
    expect(events.rows[0]!.data_json.summary).toContain("report.md");
    expect(events.rows[0]!.data_json.outcome).toBe("stuck");
  });

  it("replaces an earlier declaration of the same path rather than duplicating it", async (ctx) => {
    if (!db.available) return ctx.skip();
    const task = randomUUID();
    const run = randomUUID();
    await makeTask(task, ["report"]);
    await makeRun(run, task);
    const context = await contextFor(run);
    await declareRunArtifact(db.pool!, context, { id: task, project_id: PROJECT },
      { path: "report.md", artifact_type: "draft-report", role: "draft" });

    await declareRunArtifact(db.pool!, { ...context, idempotencyKey: `${run}:1:call-2` },
      { id: task, project_id: PROJECT },
      { path: "report.md", artifact_type: "report", role: "output" });

    const rows = await db.pool!.query<{ artifact_type: string; role: string }>(
      `SELECT artifact_type, role FROM run_artifact_declarations WHERE run_id = $1`,
      [run],
    );
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0]).toMatchObject({ artifact_type: "report", role: "output" });
  });
});

describe("declaring against a Task the Run may not write", () => {
  it("refuses when the instructing person is not a member of the Project", async (ctx) => {
    if (!db.available) return ctx.skip();
    // The Agent's reach is the instructing person's. Without this check an
    // Agent in any Run could name a private Task's id and attach an artifact
    // to it, reading its Project back out of the failure.
    const task = randomUUID();
    const outsider = randomUUID();
    await makeTask(task, ["report"]);
    await db.pool!.query(
      `INSERT INTO users (id, display_name, status, created_at, updated_at)
       VALUES ($1, 'Outsider', 'active', now(), now())`,
      [outsider],
    );

    await expect(requireProjectTask(db.pool!, SPACE, task, outsider)).rejects.toThrow();
  });
});

describe("declared paths", () => {
  it("normalizes a declaration and its collected file to the same key", () => {
    expect(normalizeDeclaredPath("./out/report.md")).toBe("out/report.md");
    expect(normalizeDeclaredPath("out\\report.md")).toBe("out/report.md");
  });

  it("refuses a path that is not inside the output directory", () => {
    expect(() => normalizeDeclaredPath("/etc/passwd")).toThrow();
    expect(() => normalizeDeclaredPath("C:/Windows/system.ini")).toThrow();
    expect(() => normalizeDeclaredPath("../outside.md")).toThrow();
    expect(() => normalizeDeclaredPath("   ")).toThrow();
  });
});

describe("the dispatched Run's tool surface", () => {
  async function grantedActionIds(trustMode: "sandboxed" | "trusted_host"): Promise<string[]> {
    const allowance = dispatchToolAllowance(trustMode);
    const grants = await buildRunToolGrants([...allowance], { allowed_tools: [...allowance] });
    return grants.map((grant) => grant.action_id);
  }

  it("grants the Project write surface and no memory write", async () => {
    const granted = await grantedActionIds("trusted_host");

    expect(granted).toEqual(expect.arrayContaining(["task.report", "task.list", "artifact.submit"]));
    // A dispatched Run is not a conversation, so nobody is telling it anything
    // to remember.
    expect(granted).not.toContain("memory.remember");
    expect(granted).not.toContain("memory.revise");
    // The companion an Agent needs to reference a denial it actually hit.
    expect(granted).toContain("authorization.request");
  });

  it("withholds artifact.submit where no path applies a declaration", async () => {
    // A server-host Run's artifacts come through materialization, which does
    // not consume declarations yet. Offering the action there would tell an
    // agent its deliverable was recorded when nothing would act on it.
    const granted = await grantedActionIds("sandboxed");

    expect(granted).not.toContain("artifact.submit");
    expect(granted).toContain("task.report");
  });
});

describe("the Work Skill", () => {
  it("names the commands and the delivery rule an agent has to follow", () => {
    const skill = renderWorkSkill();

    for (const fragment of [
      "$RAINVER_CLI list",
      "$RAINVER_CLI describe",
      "$RAINVER_CLI call",
      "artifact.submit",
      "task.request_review",
      "$RAINVER_OUTPUT_DIR",
    ]) {
      expect(skill).toContain(fragment);
    }
  });

  it("carries the shared judgement rules verbatim rather than a second copy", () => {
    // The drift this arrangement exists to prevent: the managed loop assembles
    // these same constants, so an edit to one must not leave the other
    // instructing an agent differently.
    const skill = renderWorkSkill();

    expect(skill).toContain(IDENTIFIER_POLICY);
    expect(skill).toContain(DURABLE_ACTION_CLAIM_POLICY);
    expect(skill).toContain(ACTION_RESULT_REPORTING_POLICY);
  });

  it("hashes its own content, so a Run can name the text it was given", () => {
    expect(workSkillContentHash()).toBe(workSkillContentHash(renderWorkSkill()));
    expect(workSkillContentHash("other")).not.toBe(workSkillContentHash());
  });
});
