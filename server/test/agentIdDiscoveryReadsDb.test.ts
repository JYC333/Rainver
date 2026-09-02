import { randomUUID } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import type { SystemActionId } from "@rainver/protocol";
import { useTestDatabase } from "./support/testDatabase.js";
import { resetTables } from "./support/resetTables.js";
import { seedAgentWithVersion } from "./support/domainSeeds.js";
import { loadConfig } from "../src/config.js";
import { PgProjectRepository } from "../src/modules/projects/repository.js";
import { InquiryThreadService } from "../src/modules/inquiry/threadService.js";
import { registerInquirySystemActionExecutors } from "../src/modules/inquiry/inquirySystemActionExecutors.js";
import { registerProjectResearchSystemActionExecutors } from "../src/modules/projectResearch/projectResearchSystemActionExecutors.js";
import type { SystemActionExecutor } from "../src/modules/systemActions/gateway.js";
import type { RunRecord } from "../src/modules/runs/repository.js";

// An object's id reaches an Agent by being read from a tool result, never by
// being composed from a title: `inquiry.list_threads` and
// `research.list_operations` are those reads, and the actions they feed answer
// an invented id with the real ones. (`task.list` is covered in
// projectWorkActionsDb.test.ts, `proposal.list_pending` in roomsDb.test.ts,
// each beside the actions they feed.)

const SPACE = "55555555-5555-4555-8555-555555555555";
// A real Agent row: the Project's account attributes an advancement to the
// Agent that made it, so the actor FK needs an Agent that exists.
const AGENT = "5bbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const AGENT_VERSION = "5ccccccc-cccc-4ccc-8ccc-cccccccccccc";
const OWNER = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";

type ExecutorResult = { modelResult: Record<string, unknown>; summary: Record<string, unknown> };

const db = useTestDatabase(import.meta.filename);

beforeEach(async () => {
  if (!db.available) return;
  await resetTables(
    db.pool,
    ["inquiry_thread_advice", "project_work_events", "actors", "jobs", "agent_versions", "agents", "project_operation_links", "project_operation_steps", "project_operations", "inquiry_question_states", "inquiry_threads", "space_objects", "projects", "space_memberships", "users", "spaces"],
    { cascade: true },
  );
  const now = new Date().toISOString();
  await db.pool.query(`INSERT INTO spaces (id, name, type, created_at, updated_at) VALUES ($1, 'Household', 'household', $2, $2)`, [SPACE, now]);
  await db.pool.query(`INSERT INTO users (id, display_name, status, created_at, updated_at) VALUES ($1, 'Owner', 'active', $2, $2)`, [OWNER, now]);
  await db.pool.query(
    `INSERT INTO space_memberships (id, space_id, user_id, role, status, created_at, updated_at) VALUES ($1, $2, $3, 'owner', 'active', $4, $4)`,
    [randomUUID(), SPACE, OWNER, now],
  );
  await seedAgentWithVersion(db.pool, { agent: AGENT, version: AGENT_VERSION, space: SPACE, owner: OWNER, now });
});

const identity = () => ({ spaceId: SPACE, userId: OWNER });

async function executorsFor(projectId: string): Promise<Map<SystemActionId, SystemActionExecutor>> {
  const config = loadConfig({ SERVER_DATABASE_URL: db.connectionUri, RAINVER_HOME: await mkdtemp(join(tmpdir(), "rainver-list-threads-")) });
  const run = {
    id: randomUUID(), space_id: SPACE, agent_id: AGENT, project_id: projectId, run_group_id: null,
    instructed_by_user_id: OWNER, trigger_origin: "manual", status: "running", visibility: "space_shared",
  } as unknown as RunRecord;
  const executors = new Map<SystemActionId, SystemActionExecutor>();
  registerInquirySystemActionExecutors(executors, config, run);
  registerProjectResearchSystemActionExecutors(executors, config, run);
  return executors;
}

describe("the reads an Agent gets ids from (real Postgres)", () => {
  it("lists the Project's active Threads with the ids a later action must carry", async () => {
    if (!db.available) return;
    const project = await new PgProjectRepository(db.pool).create(identity(), { name: "Agent memory" });
    const threads = new InquiryThreadService(db.pool);
    const question = await threads.createThread(identity(), project.id as string, { kind: "question", statement: "How should agent memory be classified?" });
    const hypothesis = await threads.createThread(identity(), project.id as string, { kind: "hypothesis", statement: "Episodic/semantic is the useful split" });

    const executors = await executorsFor(project.id as string);
    const list = executors.get("inquiry.list_threads" as SystemActionId)!;
    const all = await list({}, { idempotency_key: "call-1" } as never) as ExecutorResult;
    expect((all.modelResult as { threads: unknown[] }).threads).toEqual(expect.arrayContaining([
      { thread_id: question.id, kind: "question", statement: "How should agent memory be classified?", attention_state: expect.any(String), next_step: null },
      { thread_id: hypothesis.id, kind: "hypothesis", statement: "Episodic/semantic is the useful split", attention_state: expect.any(String), next_step: null },
    ]));
    expect(all.summary).toMatchObject({ tool_name: "inquiry.list_threads", ok: true, count: 2 });

    const questionsOnly = await list({ kind: "question" }, { idempotency_key: "call-2" } as never) as ExecutorResult;
    expect((questionsOnly.modelResult as { threads: Array<{ thread_id: string }> }).threads.map((t) => t.thread_id)).toEqual([question.id]);
  });

  it("adopts the recorded next step on the user's word, the same write the Area's button makes", async () => {
    if (!db.available) return;
    // A finished search records its next step; without this the only way to
    // take it was to leave the conversation, open the Inquiry Area, find the
    // Thread and press Adopt.
    const project = await new PgProjectRepository(db.pool).create(identity(), { name: "Agent memory" });
    const thread = await new InquiryThreadService(db.pool).createThread(identity(), project.id as string, {
      kind: "question", statement: "How should agent memory be classified?",
    });
    await db.pool.query(
      `INSERT INTO inquiry_thread_advice (
         id, space_id, project_id, thread_id, recommended_focus_kind, rationale, cited_refs_json,
         thread_version, status, trigger_kind, generated_by_user_id, created_at, updated_at
       ) VALUES ($1,$2,$3,$4,'clarify_or_decompose','It bundles four axes.','[]'::jsonb,$5,'open','search_completed',$6,now(),now())`,
      [randomUUID(), SPACE, project.id, thread.id, thread.version, OWNER],
    );

    const executors = await executorsFor(project.id as string);
    // The read shows the step before it is adopted: without it the Agent
    // asked "what next?" could only guess a thread_id and be told 404.
    const listed = await executors.get("inquiry.list_threads" as SystemActionId)!({}, { idempotency_key: "call-6" } as never) as ExecutorResult;
    expect((listed.modelResult as { threads: Array<{ next_step: unknown }> }).threads[0]?.next_step)
      .toEqual({ focus: "clarify_or_decompose", rationale: "It bundles four axes." });
    const adopted = await executors.get("inquiry.adopt_next_step" as SystemActionId)!(
      { thread_id: thread.id }, { idempotency_key: "call-7" } as never,
    ) as ExecutorResult;
    expect(adopted.summary).toMatchObject({ ok: true, next_focus_kind: "clarify_or_decompose" });

    const row = await db.pool.query<{ next_focus_kind: string; attention_state: string; status: string }>(
      `SELECT thread.next_focus_kind, thread.attention_state, advice.status
         FROM inquiry_threads thread
         JOIN inquiry_thread_advice advice ON advice.thread_id = thread.object_id
        WHERE thread.object_id = $1`,
      [thread.id],
    );
    expect(row.rows[0]).toMatchObject({
      next_focus_kind: "clarify_or_decompose", attention_state: "focused", status: "adopted",
    });

    // Nothing to adopt is a plain answer, not a silent no-op.
    await expect(executors.get("inquiry.adopt_next_step" as SystemActionId)!(
      { thread_id: thread.id }, { idempotency_key: "call-8" } as never,
    )).rejects.toMatchObject({ statusCode: 404 });
  });

  it("answers an invented thread_id on research.start_acquisition with the ids that exist", async () => {
    if (!db.available) return;
    const project = await new PgProjectRepository(db.pool).create(identity(), { name: "Agent memory" });
    const question = await new InquiryThreadService(db.pool).createThread(identity(), project.id as string, { kind: "question", statement: "How should agent memory be classified?" });

    const start = (await executorsFor(project.id as string)).get("research.start_acquisition" as SystemActionId)!;
    await expect(start({ thread_id: "memory-classification" }, { idempotency_key: "call-3" } as never))
      .rejects.toThrow(`No active Question Thread has id 'memory-classification'. Use one of these ids exactly: ${question.id} — How should agent memory be classified?`);
  });

  it("lists the Project's live research Operations, and answers an invented operation_id with them", async () => {
    if (!db.available) return;
    const project = await new PgProjectRepository(db.pool).create(identity(), { name: "Agent memory" });
    const running = randomUUID();
    const finished = randomUUID();
    for (const [id, title, status] of [[running, "Acquisition: classification", "active"], [finished, "Earlier sweep", "completed"]]) {
      await db.pool.query(
        `INSERT INTO project_operations (id, space_id, project_id, kind, title, status, created_by_user_id, progress_json, version, created_at, updated_at)
         VALUES ($1, $2, $3, 'research', $4, $5, $6, '{}'::jsonb, 1, now(), now())`,
        [id, SPACE, project.id, title, status, OWNER],
      );
    }
    const executors = await executorsFor(project.id as string);

    const live = await executors.get("research.list_operations" as SystemActionId)!({}, { idempotency_key: "call-4" } as never) as ExecutorResult;
    expect((live.modelResult as { operations: Array<{ operation_id: string; status: string }> }).operations)
      .toEqual([{ operation_id: running, title: "Acquisition: classification", status: "active" }]);

    const all = await executors.get("research.list_operations" as SystemActionId)!({ include_terminal: true }, { idempotency_key: "call-5" } as never) as ExecutorResult;
    expect((all.modelResult as { operations: Array<{ operation_id: string }> }).operations.map((operation) => operation.operation_id).sort())
      .toEqual([running, finished].sort());

    await expect(executors.get("research.cancel_acquisition" as SystemActionId)!(
      { operation_id: "classification-run" },
      { idempotency_key: "call-6" } as never,
    )).rejects.toThrow(`No research Operation has id 'classification-run'. Use one of these ids exactly: ${running} — Acquisition: classification (active)`);
  });
});
