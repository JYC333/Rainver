import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { useTestDatabase } from "./support/testDatabase.js";
import { resetTables } from "./support/resetTables.js";
import { PgProjectRepository } from "../src/modules/projects/repository.js";
import { InquiryThreadService } from "../src/modules/inquiry/threadService.js";
import { InquiryIterationService } from "../src/modules/inquiry/iterationService.js";
import { InquiryAdviceService, INQUIRY_NEXT_STEP_ADVICE_PROMPT_KEY } from "../src/modules/inquiry/adviceService.js";
import { EvolvableAssetRepository } from "../src/modules/evolution/assetRepository.js";
import { adviceJobMayPersist, queueAdviceForFocusedThread, runInquiryAdviceJob } from "../src/modules/inquiry/adviceJob.js";
import { PgJobQueueRepository } from "../src/modules/jobs/repository.js";
import type { ServerConfig } from "../src/config.js";

// Real-Postgres coverage for model-generated next-step advice. The provider
// call itself is injected, so these assert the durable contract around it:
// what is stored, when it goes stale, and that advice never becomes a write.

const SPACE = "22222222-2222-4222-8222-222222222222";
const OWNER = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";


const db = useTestDatabase(import.meta.filename);

let PROJECT: string;
let THREAD: string;

const identity = () => ({ spaceId: SPACE, userId: OWNER });
const config = { databaseUrl: "postgres://unused" } as ServerConfig;

function serviceReturning(output: Record<string, unknown>): InquiryAdviceService {
  return new InquiryAdviceService(db.pool, config, async () => output);
}

async function registerPromptAsset(): Promise<void> {
  const repo = new EvolvableAssetRepository(db.pool);
  const asset = await repo.createAsset(identity(), {
    asset_type: "prompt_template",
    asset_key: INQUIRY_NEXT_STEP_ADVICE_PROMPT_KEY,
    display_name: INQUIRY_NEXT_STEP_ADVICE_PROMPT_KEY,
    metadata_json: { prompt_type: "workflow" },
  });
  const version = await repo.createVersion(identity(), asset.id as string, {
    scope_type: "space",
    content_json: {
      schema_version: "prompt_asset.v1",
      prompt_type: "workflow",
      template: "Advise on {thread_kind}: {thread_statement} ({thread_position})\nnext={current_next_focus} running={search_running} pending={pending_candidate_count}\n{recent_iterations}\n{evidence_summary}",
    },
  });
  const now = new Date().toISOString();
  await db.pool.query(
    `UPDATE evolvable_asset_versions SET status='approved', updated_at=$3 WHERE asset_id=$1 AND id=$2`,
    [asset.id, version.id, now],
  );
  await db.pool.query(
    `INSERT INTO prompt_deployment_refs (id, space_id, asset_id, scope_type, scope_id, label, version_id, status, created_at, updated_at)
     VALUES ($1,$2,$3,'space',$2,'production',$4,'active',$5,$5)`,
    [randomUUID(), SPACE, asset.id, version.id, now],
  );
}

async function registerProvider(): Promise<void> {
  const providerId = randomUUID();
  const now = new Date().toISOString();
  await db.pool.query(
    `INSERT INTO model_providers (id, space_id, name, provider_type, default_model, enabled, capabilities_json, config_json, created_at, updated_at)
     VALUES ($1, $2, 'Test Provider', 'anthropic', 'claude-test', true, '{}'::jsonb, '{}'::jsonb, $3, $3)`,
    [providerId, SPACE, now],
  );
  await db.pool.query(
    `INSERT INTO model_provider_space_grants (id, provider_id, space_id, enabled, is_default, created_at, updated_at)
     VALUES ($1, $2, $3, true, true, $4, $4)`,
    [randomUUID(), providerId, SPACE, now],
  );
}

beforeEach(async () => {
  if (!db.available) return;
  await resetTables(
    db.pool,
    ["inquiry_thread_advice", "jobs", "prompt_deployment_refs", "evolvable_asset_versions", "evolvable_assets", "model_provider_space_grants", "model_providers", "inquiry_evidence_signals", "inquiry_iterations", "inquiry_thread_statement_revisions", "inquiry_question_states", "inquiry_hypothesis_states", "inquiry_threads", "inquiry_project_settings", "projects", "space_memberships", "users", "spaces"],
    { cascade: true },
  );
  const now = new Date().toISOString();
  await db.pool.query(`INSERT INTO spaces (id, name, type, created_at, updated_at) VALUES ($1, 'Household', 'household', $2, $2)`, [SPACE, now]);
  await db.pool.query(
    `INSERT INTO users (id, display_name, status, created_at, updated_at) VALUES ($1, 'Owner', 'active', $2, $2)`,
    [OWNER, now],
  );
  await db.pool.query(
    `INSERT INTO space_memberships (id, space_id, user_id, role, status, created_at, updated_at) VALUES ($1, $2, $3, 'owner', 'active', $4, $4)`,
    [randomUUID(), SPACE, OWNER, now],
  );
  const project = await new PgProjectRepository(db.pool).create(identity(), { name: "Advice Project" });
  PROJECT = project.id as string;
  const thread = await new InquiryThreadService(db.pool).createThread(identity(), PROJECT, {
    kind: "question",
    statement: "Does caching reduce p95 latency?",
  });
  THREAD = thread.id as string;
  await registerPromptAsset();
  await registerProvider();
});

describe("Inquiry next-step advice (real Postgres)", () => {
  it("stores a recommendation without touching the Thread's own Next Focus", async () => {
    if (!db.available) return;
    const service = serviceReturning({
      recommended_focus_kind: "synthesize",
      rationale: "Thirty-four supporting items are in hand and no contradiction has appeared in two scans.",
      cited_refs: ["signal-1"],
    });

    const advice = await service.generateAdvice(identity(), PROJECT, THREAD, "user_request");
    expect(advice.recommended_focus_kind).toBe("synthesize");
    expect(advice.status).toBe("open");
    expect(advice.stale).toBe(false);

    // The Thread itself must be untouched: adopting advice goes through the
    // work-state command, which is the only Next Focus write authority.
    const thread = await new InquiryThreadService(db.pool).getThread(identity(), PROJECT, THREAD);
    expect(thread.next_focus_kind).toBeNull();
    expect(thread.version).toBe(1);
  });

  it("rejects a recommendation the domain does not define", async () => {
    if (!db.available) return;
    const service = serviceReturning({
      recommended_focus_kind: "go_and_think_harder",
      rationale: "Anything",
      cited_refs: [],
    });
    await expect(service.generateAdvice(identity(), PROJECT, THREAD, "user_request"))
      .rejects.toMatchObject({ statusCode: 502 });
    expect(await service.getAdvice(identity(), PROJECT, THREAD)).toBeNull();
  });

  it("becomes stale once the Thread moves past the revision it reasoned about", async () => {
    if (!db.available) return;
    const service = serviceReturning({
      recommended_focus_kind: "read_evidence",
      rationale: "Two contradicting papers arrived and have not been judged.",
      cited_refs: [],
    });
    await service.generateAdvice(identity(), PROJECT, THREAD, "candidate_created");
    expect((await service.getAdvice(identity(), PROJECT, THREAD))?.stale).toBe(false);

    await new InquiryIterationService(db.pool).recordIteration(identity(), PROJECT, THREAD, {
      change_summary: "Read both papers; the contradiction is about a different workload.",
      answer_state: "partial",
      current_answer_summary: "Helps for read-heavy workloads.",
    });

    const after = await service.getAdvice(identity(), PROJECT, THREAD);
    expect(after?.stale).toBe(true);
    expect(after?.recommended_focus_kind).toBe("read_evidence");
  });

  it("keeps one current recommendation per Thread rather than a queue", async () => {
    if (!db.available) return;
    await serviceReturning({ recommended_focus_kind: "search_acquisition", rationale: "No evidence yet.", cited_refs: [] })
      .generateAdvice(identity(), PROJECT, THREAD, "user_request");
    await serviceReturning({ recommended_focus_kind: "synthesize", rationale: "Evidence has since arrived.", cited_refs: [] })
      .generateAdvice(identity(), PROJECT, THREAD, "search_completed");

    const rows = await db.pool.query("SELECT recommended_focus_kind, trigger_kind FROM inquiry_thread_advice WHERE thread_id = $1", [THREAD]);
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0]).toMatchObject({ recommended_focus_kind: "synthesize", trigger_kind: "search_completed" });
  });

  it("dismissal retires the suggestion, and regenerating reopens it", async () => {
    if (!db.available) return;
    const service = serviceReturning({ recommended_focus_kind: "clarify_or_decompose", rationale: "Blocked upstream.", cited_refs: [] });
    await service.generateAdvice(identity(), PROJECT, THREAD, "user_request");

    expect((await service.dismissAdvice(identity(), PROJECT, THREAD)).status).toBe("dismissed");
    expect((await service.getAdvice(identity(), PROJECT, THREAD))?.status).toBe("dismissed");

    await service.generateAdvice(identity(), PROJECT, THREAD, "user_request");
    expect((await service.getAdvice(identity(), PROJECT, THREAD))?.status).toBe("open");
  });

  it("refuses to advise a Thread that is no longer active", async () => {
    if (!db.available) return;
    await new InquiryIterationService(db.pool).transitionLifecycle(identity(), PROJECT, THREAD, {
      lifecycle_status: "resolved",
      reason: "Answered",
    });
    const service = serviceReturning({ recommended_focus_kind: "promote_knowledge", rationale: "Settled.", cited_refs: [] });
    await expect(service.generateAdvice(identity(), PROJECT, THREAD, "user_request"))
      .rejects.toMatchObject({ statusCode: 422 });
  });

  it("queues automatic advice only for Threads the project has actually focused", async () => {
    if (!db.available) return;
    const jobCount = async () => Number((await db.pool.query(
      "SELECT COUNT(*)::text AS total FROM jobs WHERE job_type = 'inquiry_next_step_advice' AND status IN ('pending','claimed','running')",
    )).rows[0].total);

    // Backlog by default — automatic spend stays bounded by the Focus WIP limit.
    await queueAdviceForFocusedThread(db.pool, {
      spaceId: SPACE, userId: OWNER, projectId: PROJECT, threadId: THREAD, triggerKind: "iteration_recorded",
    });
    expect(await jobCount()).toBe(0);

    await new InquiryIterationService(db.pool).updateWork(identity(), PROJECT, THREAD, {
      attention_state: "focused",
      next_focus_kind: "search_acquisition",
    });
    await queueAdviceForFocusedThread(db.pool, {
      spaceId: SPACE, userId: OWNER, projectId: PROJECT, threadId: THREAD, triggerKind: "iteration_recorded",
    });
    expect(await jobCount()).toBe(1);

    // A burst of triggers on the same Thread must not buy several provider
    // calls whose results only overwrite each other.
    await queueAdviceForFocusedThread(db.pool, {
      spaceId: SPACE, userId: OWNER, projectId: PROJECT, threadId: THREAD, triggerKind: "candidate_created",
    });
    expect(await jobCount()).toBe(1);
  });

  it("retires open advice as soon as replacement analysis is requested", async () => {
    if (!db.available) return;
    const service = serviceReturning({
      recommended_focus_kind: "search_acquisition",
      rationale: "No evidence has arrived yet.",
      cited_refs: [],
    });
    await service.generateAdvice(identity(), PROJECT, THREAD, "user_request");

    // An unfocused Thread does not spend on automatic analysis, but the event
    // still makes its old recommendation unsafe to keep presenting.
    await queueAdviceForFocusedThread(db.pool, {
      spaceId: SPACE, userId: OWNER, projectId: PROJECT, threadId: THREAD, triggerKind: "candidate_created",
    });
    expect((await service.getAdvice(identity(), PROJECT, THREAD))?.status).toBe("dismissed");
    expect((await db.pool.query(
      "SELECT id FROM jobs WHERE job_type = 'inquiry_next_step_advice'",
    )).rows).toHaveLength(0);

    await new InquiryIterationService(db.pool).updateWork(identity(), PROJECT, THREAD, {
      attention_state: "focused",
      next_focus_kind: "read_evidence",
    });
    await service.generateAdvice(identity(), PROJECT, THREAD, "user_request");
    await queueAdviceForFocusedThread(db.pool, {
      spaceId: SPACE, userId: OWNER, projectId: PROJECT, threadId: THREAD, triggerKind: "candidate_created",
    });
    expect((await service.getAdvice(identity(), PROJECT, THREAD))?.status).toBe("dismissed");
    expect((await db.pool.query(
      "SELECT id FROM jobs WHERE job_type = 'inquiry_next_step_advice'",
    )).rows).toHaveLength(1);
  });

  it("does not rewrite advice that was already adopted or dismissed", async () => {
    if (!db.available) return;
    const service = serviceReturning({
      recommended_focus_kind: "search_acquisition",
      rationale: "No evidence has arrived yet.",
      cited_refs: [],
    });
    await service.generateAdvice(identity(), PROJECT, THREAD, "user_request");
    // Through the one adoption path there is: the Thread takes the focus and
    // the advice closes together.
    await service.adoptAdvice(identity(), PROJECT, THREAD);
    const adoptedAt = (await service.getAdvice(identity(), PROJECT, THREAD))!.updated_at;

    await queueAdviceForFocusedThread(db.pool, {
      spaceId: SPACE, userId: null, projectId: PROJECT, threadId: THREAD, triggerKind: "search_completed",
    });
    const adopted = await service.getAdvice(identity(), PROJECT, THREAD);
    expect(adopted?.status).toBe("adopted");
    expect(adopted?.updated_at).toBe(adoptedAt);

    await service.generateAdvice(identity(), PROJECT, THREAD, "user_request");
    await service.dismissAdvice(identity(), PROJECT, THREAD);
    const dismissedAt = (await service.getAdvice(identity(), PROJECT, THREAD))!.updated_at;
    await queueAdviceForFocusedThread(db.pool, {
      spaceId: SPACE, userId: null, projectId: PROJECT, threadId: THREAD, triggerKind: "search_completed",
    });
    const dismissed = await service.getAdvice(identity(), PROJECT, THREAD);
    expect(dismissed?.status).toBe("dismissed");
    expect(dismissed?.updated_at).toBe(dismissedAt);
  });

  it("fences an in-flight automatic generation and queues one fresh successor", async () => {
    if (!db.available) return;
    const current = serviceReturning({
      recommended_focus_kind: "read_evidence",
      rationale: "Review the evidence already available.",
      cited_refs: [],
    });
    await current.generateAdvice(identity(), PROJECT, THREAD, "user_request");
    await new InquiryIterationService(db.pool).updateWork(identity(), PROJECT, THREAD, {
      attention_state: "focused",
      next_focus_kind: "read_evidence",
    });

    const job = await new PgJobQueueRepository(db.pool).enqueue({
      job_type: "inquiry_next_step_advice",
      space_id: SPACE,
      user_id: OWNER,
      payload: { project_id: PROJECT, thread_id: THREAD, trigger_kind: "iteration_recorded" },
    });
    await db.pool.query(
      `UPDATE jobs SET status='running', started_at=$2, updated_at=$2 WHERE id=$1`,
      [job.id, new Date().toISOString()],
    );

    let releaseProvider!: () => void;
    let providerStarted!: () => void;
    const started = new Promise<void>((resolve) => { providerStarted = resolve; });
    const release = new Promise<void>((resolve) => { releaseProvider = resolve; });
    const late = new InquiryAdviceService(db.pool, config, async () => {
      providerStarted();
      await release;
      return {
        recommended_focus_kind: "search_acquisition",
        rationale: "This was computed from the older context.",
        cited_refs: [],
      };
    });
    const generation = late.generateAdvice(identity(), PROJECT, THREAD, "iteration_recorded", {
      beforePersist: (tx) => adviceJobMayPersist(tx, job.id),
    });
    await started;

    await queueAdviceForFocusedThread(db.pool, {
      spaceId: SPACE,
      userId: OWNER,
      projectId: PROJECT,
      threadId: THREAD,
      triggerKind: "candidate_created",
    });
    releaseProvider();

    expect(await generation).toBeNull();
    expect((await current.getAdvice(identity(), PROJECT, THREAD))?.status).toBe("dismissed");
    const jobs = await db.pool.query<{ status: string; superseded: boolean }>(
      `SELECT status, payload_json ? 'advice_superseded_at' AS superseded
         FROM jobs WHERE job_type='inquiry_next_step_advice' ORDER BY created_at`,
    );
    expect(jobs.rows).toEqual([
      { status: "running", superseded: true },
      { status: "pending", superseded: false },
    ]);
  });

  it("keeps job-before-advice lock order when generation and invalidation overlap", async () => {
    if (!db.available) return;
    const current = serviceReturning({
      recommended_focus_kind: "read_evidence",
      rationale: "Current recommendation.",
      cited_refs: [],
    });
    await current.generateAdvice(identity(), PROJECT, THREAD, "user_request");
    await new InquiryIterationService(db.pool).updateWork(identity(), PROJECT, THREAD, {
      attention_state: "focused",
      next_focus_kind: "read_evidence",
    });
    const job = await new PgJobQueueRepository(db.pool).enqueue({
      job_type: "inquiry_next_step_advice",
      space_id: SPACE,
      user_id: OWNER,
      payload: { project_id: PROJECT, thread_id: THREAD, trigger_kind: "iteration_recorded" },
    });
    await db.pool.query("UPDATE jobs SET status='running' WHERE id=$1", [job.id]);

    let guardLocked!: () => void;
    let releaseGuard!: () => void;
    const locked = new Promise<void>((resolve) => { guardLocked = resolve; });
    const release = new Promise<void>((resolve) => { releaseGuard = resolve; });
    const generation = serviceReturning({
      recommended_focus_kind: "synthesize",
      rationale: "Generation that reached persistence first.",
      cited_refs: [],
    }).generateAdvice(identity(), PROJECT, THREAD, "iteration_recorded", {
      beforePersist: async (tx) => {
        const mayPersist = await adviceJobMayPersist(tx, job.id);
        guardLocked();
        await release;
        return mayPersist;
      },
    });
    await locked;
    const invalidation = queueAdviceForFocusedThread(db.pool, {
      spaceId: SPACE,
      userId: OWNER,
      projectId: PROJECT,
      threadId: THREAD,
      triggerKind: "candidate_created",
    });
    await new Promise((resolve) => setTimeout(resolve, 25));
    releaseGuard();

    await expect(generation).resolves.not.toBeNull();
    await expect(invalidation).resolves.toBeUndefined();
    expect((await current.getAdvice(identity(), PROJECT, THREAD))?.status).toBe("dismissed");
  });

  it("leaves exactly one current job when a worker claim races invalidation", async () => {
    if (!db.available) return;
    await new InquiryIterationService(db.pool).updateWork(identity(), PROJECT, THREAD, {
      attention_state: "focused",
      next_focus_kind: "read_evidence",
    });
    await queueAdviceForFocusedThread(db.pool, {
      spaceId: SPACE, userId: OWNER, projectId: PROJECT, threadId: THREAD, triggerKind: "iteration_recorded",
    });

    await Promise.all([
      queueAdviceForFocusedThread(db.pool, {
        spaceId: SPACE, userId: OWNER, projectId: PROJECT, threadId: THREAD, triggerKind: "candidate_created",
      }),
      new PgJobQueueRepository(db.pool).claimNext("race-worker", ["inquiry_next_step_advice"]),
    ]);

    const active = await db.pool.query<{ status: string; superseded: boolean }>(
      `SELECT status, payload_json ? 'advice_superseded_at' AS superseded
         FROM jobs
        WHERE job_type='inquiry_next_step_advice' AND status IN ('pending','claimed','running')`,
    );
    expect(active.rows.filter((row) => !row.superseded)).toHaveLength(1);
    expect(active.rows.filter((row) => row.superseded).every((row) => row.status === "claimed")).toBe(true);
  });

  it("cancels pending advice when the latest trigger has no actor or the Thread is unfocused", async () => {
    if (!db.available) return;
    await new InquiryIterationService(db.pool).updateWork(identity(), PROJECT, THREAD, {
      attention_state: "focused",
      next_focus_kind: "search_acquisition",
    });
    await queueAdviceForFocusedThread(db.pool, {
      spaceId: SPACE, userId: OWNER, projectId: PROJECT, threadId: THREAD, triggerKind: "iteration_recorded",
    });
    await queueAdviceForFocusedThread(db.pool, {
      spaceId: SPACE, userId: null, projectId: PROJECT, threadId: THREAD, triggerKind: "search_completed",
    });
    const jobs = await db.pool.query<{ status: string }>(
      "SELECT status FROM jobs WHERE job_type = 'inquiry_next_step_advice'",
    );
    expect(jobs.rows).toEqual([{ status: "cancelled" }]);

    await queueAdviceForFocusedThread(db.pool, {
      spaceId: SPACE, userId: OWNER, projectId: PROJECT, threadId: THREAD, triggerKind: "iteration_recorded",
    });
    await new InquiryIterationService(db.pool).updateWork(identity(), PROJECT, THREAD, {
      attention_state: "backlog",
    });
    await queueAdviceForFocusedThread(db.pool, {
      spaceId: SPACE, userId: OWNER, projectId: PROJECT, threadId: THREAD, triggerKind: "search_completed",
    });
    const afterUnfocus = await db.pool.query<{ status: string }>(
      "SELECT status FROM jobs WHERE job_type = 'inquiry_next_step_advice' ORDER BY created_at",
    );
    expect(afterUnfocus.rows).toEqual([{ status: "cancelled" }, { status: "cancelled" }]);
  });

  it("skips a superseded retry before invoking the provider", async () => {
    if (!db.available) return;
    let providerCalls = 0;
    const service = new InquiryAdviceService(db.pool, config, async () => {
      providerCalls += 1;
      return { recommended_focus_kind: "read_evidence", rationale: "Old", cited_refs: [] };
    });
    const job = await new PgJobQueueRepository(db.pool).enqueue({
      job_type: "inquiry_next_step_advice",
      space_id: SPACE,
      user_id: OWNER,
      payload: {
        project_id: PROJECT,
        thread_id: THREAD,
        trigger_kind: "candidate_created",
        advice_superseded_at: new Date().toISOString(),
      },
    });
    await db.pool.query("UPDATE jobs SET status='running' WHERE id=$1", [job.id]);

    const result = await runInquiryAdviceJob(db.pool, service, {
      job_id: job.id,
      space_id: SPACE,
      user_id: OWNER,
      payload: job.payload_json,
    });
    expect(result).toEqual({ thread_id: THREAD, superseded: true });
    expect(providerCalls).toBe(0);
  });


  it("advice generated while the Thread changes underneath does not claim to be current", async () => {
    if (!db.available) return;
    // The provider call is where real latency lives; a concurrent Iteration
    // during it means the advice reasoned about a superseded revision.
    const service = new InquiryAdviceService(db.pool, config, async () => {
      await new InquiryIterationService(db.pool).recordIteration(identity(), PROJECT, THREAD, {
        change_summary: "Someone else moved this Thread on while advice was being generated.",
        answer_state: "partial",
        current_answer_summary: "Changed.",
      });
      return { recommended_focus_kind: "synthesize", rationale: "Based on the older state.", cited_refs: [] };
    });
    const returned = await service.generateAdvice(identity(), PROJECT, THREAD, "user_request");
    const reread = await service.getAdvice(identity(), PROJECT, THREAD);
    expect(reread?.stale).toBe(true);
    expect(returned.stale).toBe(true);
  });

  it("recording an Iteration on a focused Thread queues advice without blocking on a provider", async () => {
    if (!db.available) return;
    await new InquiryIterationService(db.pool).updateWork(identity(), PROJECT, THREAD, {
      attention_state: "focused",
      next_focus_kind: "read_evidence",
    });
    await new InquiryIterationService(db.pool).recordIteration(identity(), PROJECT, THREAD, {
      change_summary: "Skimmed the first ten results.",
      answer_state: "partial",
      current_answer_summary: "Looks promising for read-heavy workloads.",
    });

    const jobs = await db.pool.query<{ payload_json: Record<string, unknown> }>(
      "SELECT payload_json FROM jobs WHERE job_type = 'inquiry_next_step_advice'",
    );
    expect(jobs.rows).toHaveLength(1);
    expect(jobs.rows[0]!.payload_json).toMatchObject({
      project_id: PROJECT,
      thread_id: THREAD,
      trigger_kind: "iteration_recorded",
    });
  });
});
