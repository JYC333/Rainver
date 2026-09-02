import { randomUUID } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import type { SystemActionId } from "@rainver/protocol";
import { useTestDatabase } from "./support/testDatabase.js";
import { resetTables } from "./support/resetTables.js";
import { seedAgentWithVersion, seedSpaceMember } from "./support/domainSeeds.js";
import { loadConfig } from "../src/config.js";
import { PgProjectRepository } from "../src/modules/projects/repository.js";
import { PgTaskRepository } from "../src/modules/tasks/repository.js";
import { ProjectDefinitionProposalService } from "../src/modules/projects/projectDefinitionProposalService.js";
import { PgProposalApplyService } from "../src/modules/proposals/applyService.js";
import { registerProjectWorkSystemActionExecutors } from "../src/modules/projectWork/projectWorkSystemActionExecutors.js";
import type { SystemActionExecutor } from "../src/modules/systemActions/gateway.js";
import type { RunRecord } from "../src/modules/runs/repository.js";

// What a person's Room turn writes when they state a goal or ask for a plan,
// exercised the way the conversation reaches it — not the way the web form does.

const SPACE = "66666666-6666-4666-8666-666666666666";
const AGENT = "6bbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const AGENT_VERSION = "6ccccccc-cccc-4ccc-8ccc-cccccccccccc";
const OWNER = "6eeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
/** A Space member (not owner/admin) who owns a Project of their own. */
const MEMBER = "6ffffff0-ffff-4fff-8fff-ffffffffffff";

type ExecutorResult = { modelResult: Record<string, unknown>; summary: Record<string, unknown> };

const db = useTestDatabase(import.meta.filename);

beforeEach(async () => {
  if (!db.available) return;
  await resetTables(
    db.pool,
    ["proposals", "project_brief_versions", "tasks", "project_work_events", "actors", "jobs", "runs", "agent_versions", "agents", "space_objects", "projects", "space_memberships", "users", "spaces"],
    { cascade: true },
  );
  const now = new Date().toISOString();
  await db.pool.query(`INSERT INTO spaces (id, name, type, created_at, updated_at) VALUES ($1, 'Household', 'household', $2, $2)`, [SPACE, now]);
  await db.pool.query(`INSERT INTO users (id, display_name, status, created_at, updated_at) VALUES ($1, 'Owner', 'active', $2, $2)`, [OWNER, now]);
  await db.pool.query(
    `INSERT INTO space_memberships (id, space_id, user_id, role, status, created_at, updated_at) VALUES ($1, $2, $3, 'owner', 'active', $4, $4)`,
    [randomUUID(), SPACE, OWNER, now],
  );
  await seedSpaceMember(db.pool, { space: SPACE, user: MEMBER, role: "member", now });
  await seedAgentWithVersion(db.pool, { agent: AGENT, version: AGENT_VERSION, space: SPACE, owner: OWNER, now });
});

const identity = (userId = OWNER) => ({ spaceId: SPACE, userId });

/** A Run row for a proposal to hang off; the FK is real. */
async function seedConversationRun(): Promise<string> {
  const id = randomUUID();
  await db.pool.query(
    `INSERT INTO runs (id, space_id, agent_id, agent_version_id, run_type, trigger_origin, status, mode, owner_user_id, visibility, created_at, updated_at)
     VALUES ($1,$2,$3,$4,'agent','manual','succeeded','live',$5,'space_shared',now(),now())`,
    [id, SPACE, AGENT, AGENT_VERSION, OWNER],
  );
  return id;
}

async function configFor() {
  return loadConfig({ SERVER_DATABASE_URL: db.connectionUri, RAINVER_HOME: await mkdtemp(join(tmpdir(), "rainver-conversation-writes-")) });
}

describe("stating the Project's goal in conversation", () => {
  it("supersedes a pending draft when the goal is revised before anyone decided", async () => {
    if (!db.available) return;
    // "Set my goal to X" … "actually, make it Y". The second call used to hand
    // back the draft for X: the agent reported success, and Accept published X.
    const project = await new PgProjectRepository(db.pool).create(identity(), { name: "Memory layer" });
    const service = new ProjectDefinitionProposalService(db.pool);
    const firstRun = await seedConversationRun();
    const first = await service.proposeDefinition(identity(), project.id as string, { goal: "Ship a memory layer" }, { agentId: AGENT, runId: firstRun, idempotencyKey: "call-1" });
    const same = await service.proposeDefinition(identity(), project.id as string, { goal: "Ship a memory layer" }, { agentId: AGENT, runId: firstRun, idempotencyKey: "call-2" });
    expect(same.proposal.id).toBe(first.proposal.id);

    // A later turn (another run) with different wording; the same run
    // re-proposing is a retry and keeps its draft (`inquiryDirectWritesDb`).
    const revised = await service.proposeDefinition(identity(), project.id as string, { goal: "Ship a reliable memory layer by Q2" }, { agentId: AGENT, runId: await seedConversationRun(), idempotencyKey: "later-turn" });
    expect(revised.proposal.id).not.toBe(first.proposal.id);
    const statuses = await db.pool.query<{ id: string; status: string }>(
      `SELECT id, status FROM proposals WHERE id = ANY ($1::varchar[]) ORDER BY created_at`,
      [[first.proposal.id, revised.proposal.id]],
    );
    expect(statuses.rows.map((row) => row.status)).toEqual(["superseded", "pending"]);
  });

  it("lets the Project's owner accept it even when they are only a Space member", async () => {
    if (!db.available) return;
    // The proposal asks for an "owner" approver; that is the Project's owner,
    // which is what the applier itself checks. Comparing the Space role alone
    // showed this person the Accept button and then refused them.
    const project = await new PgProjectRepository(db.pool).create(identity(MEMBER), { name: "My own project" });
    const proposed = await new ProjectDefinitionProposalService(db.pool)
      .proposeDefinition(identity(MEMBER), project.id as string, { goal: "Finish the thesis" }, { agentId: AGENT });
    const accepted = await PgProposalApplyService.fromConfig(await configFor()).accept(proposed.proposal.id as string, identity(MEMBER));
    expect(accepted).not.toBeNull();
    const brief = await db.pool.query(`SELECT 1 FROM project_brief_versions WHERE project_id = $1 AND goal = 'Finish the thesis'`, [project.id]);
    expect(brief.rowCount).toBe(1);
  });
});

describe("asking for a plan in conversation", () => {
  it("records the timing the person gave, and reads it back for a recommendation", async () => {
    if (!db.available) return;
    const project = await new PgProjectRepository(db.pool).create(identity(), { name: "Memory layer" });
    const config = await configFor();
    const run = {
      id: randomUUID(), space_id: SPACE, agent_id: AGENT, project_id: project.id, run_group_id: null,
      instructed_by_user_id: OWNER, trigger_origin: "manual", session_id: randomUUID(),
    } as unknown as RunRecord;
    const executors = new Map<SystemActionId, SystemActionExecutor>();
    registerProjectWorkSystemActionExecutors(executors, config, run);

    const created = await executors.get("task.create" as SystemActionId)!(
      { title: "Draft the schema", priority: "high", due_at: "2026-09-12", start_after: "2026-09-08" },
      { idempotency_key: "call-1" } as never,
    ) as ExecutorResult;
    expect(created.summary).toMatchObject({ tool_name: "task.create", ok: true });

    const listed = await executors.get("task.list" as SystemActionId)!({}, { idempotency_key: "call-2" } as never) as ExecutorResult;
    const tasks = (listed.modelResult as { tasks: Array<Record<string, unknown>> }).tasks;
    expect(tasks).toHaveLength(1);
    // An id-only read left "what should I do next?" answerable only by
    // restating titles; the state a recommendation is grounded in comes back.
    expect(tasks[0]).toMatchObject({
      title: "Draft the schema",
      priority: "high",
      due_at: expect.stringContaining("2026-09-12"),
      start_after: expect.stringContaining("2026-09-08"),
      blocked_reason: null,
    });
  });

  it("keeps a Task-addressed action inside the Run's own Project, even for a Task the person can read", async () => {
    if (!db.available) return;
    // A Room is one Project's conversation; an id from a sibling Project the
    // same person owns is still not this conversation's to move. It answers
    // as not found, with the ids this Project actually has.
    const projects = new PgProjectRepository(db.pool);
    const mine = await projects.create(identity(), { name: "Mine" });
    const sibling = await projects.create(identity(), { name: "Sibling" });
    const config = await configFor();
    const run = {
      id: randomUUID(), space_id: SPACE, agent_id: AGENT, project_id: mine.id, run_group_id: null,
      instructed_by_user_id: OWNER, trigger_origin: "manual", session_id: randomUUID(),
    } as unknown as RunRecord;
    const executors = new Map<SystemActionId, SystemActionExecutor>();
    registerProjectWorkSystemActionExecutors(executors, config, run);
    const created = await executors.get("task.create" as SystemActionId)!(
      { title: "Mine to move" }, { idempotency_key: "call-1" } as never,
    ) as ExecutorResult;
    const siblingTask = await new PgTaskRepository(db.pool).createTask(identity(), { project_id: sibling.id, title: "Not yours to move" });

    await expect(executors.get("task.report" as SystemActionId)!(
      { task_id: siblingTask.id, summary: "reaching across" }, { idempotency_key: "call-2" } as never,
    )).rejects.toMatchObject({ statusCode: 404, message: expect.stringContaining(String(created.summary.task_id)) });
    await expect(executors.get("task.report" as SystemActionId)!(
      { task_id: created.summary.task_id, summary: "own Task" }, { idempotency_key: "call-3" } as never,
    )).resolves.toMatchObject({ summary: { ok: true } });
  });
});
