import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { getTestPostgres, type TestPostgresDatabase } from "./support/sharedPostgres";
import { migrate } from "../src/db/migrator";
import { PgProjectRepository } from "../src/modules/projects/repository";
import { InquiryThreadService } from "../src/modules/inquiry/threadService";
import { InquiryIterationService } from "../src/modules/inquiry/iterationService";
import { InquiryAdviceService, INQUIRY_NEXT_STEP_ADVICE_PROMPT_KEY } from "../src/modules/inquiry/adviceService";
import { EvolvableAssetRepository } from "../src/modules/evolution/assetRepository";
import { queueAdviceForFocusedThread } from "../src/modules/inquiry/adviceJob";
import type { ServerConfig } from "../src/config";

// Real-Postgres coverage for model-generated next-step advice. The provider
// call itself is injected, so these assert the durable contract around it:
// what is stored, when it goes stale, and that advice never becomes a write.

const MIGRATIONS_DIR = join(process.cwd(), "migrations");
const SPACE = "22222222-2222-4222-8222-222222222222";
const OWNER = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

let container: TestPostgresDatabase | undefined;
let pool: Pool | undefined;
let available = false;

beforeAll(async () => {
  try {
    container = await getTestPostgres(__filename);
    pool = new Pool({ connectionString: container.getConnectionUri(), max: 3 });
    await migrate(pool, MIGRATIONS_DIR);
    available = true;
  } catch (error) {
    console.warn(`[inquiry-advice-db] skipped — Docker/Postgres unavailable: ${error instanceof Error ? error.message : String(error)}`);
  }
}, 180_000);

afterAll(async () => {
  await pool?.end();
  await container?.stop();
});

let PROJECT: string;
let THREAD: string;

const identity = () => ({ spaceId: SPACE, userId: OWNER });
const config = { databaseUrl: "postgres://unused" } as ServerConfig;

function serviceReturning(output: Record<string, unknown>): InquiryAdviceService {
  return new InquiryAdviceService(pool!, config, async () => output);
}

async function registerPromptAsset(): Promise<void> {
  const repo = new EvolvableAssetRepository(pool!);
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
  await pool!.query(
    `UPDATE evolvable_asset_versions SET status='approved', updated_at=$3 WHERE asset_id=$1 AND id=$2`,
    [asset.id, version.id, now],
  );
  await pool!.query(
    `INSERT INTO prompt_deployment_refs (id, space_id, asset_id, scope_type, scope_id, label, version_id, status, created_at, updated_at)
     VALUES ($1,$2,$3,'space',$2,'production',$4,'active',$5,$5)`,
    [randomUUID(), SPACE, asset.id, version.id, now],
  );
}

async function registerProvider(): Promise<void> {
  const providerId = randomUUID();
  const now = new Date().toISOString();
  await pool!.query(
    `INSERT INTO model_providers (id, space_id, name, provider_type, default_model, enabled, capabilities_json, config_json, created_at, updated_at)
     VALUES ($1, $2, 'Test Provider', 'anthropic', 'claude-test', true, '{}'::jsonb, '{}'::jsonb, $3, $3)`,
    [providerId, SPACE, now],
  );
  await pool!.query(
    `INSERT INTO model_provider_space_grants (id, provider_id, space_id, enabled, is_default, created_at, updated_at)
     VALUES ($1, $2, $3, true, true, $4, $4)`,
    [randomUUID(), providerId, SPACE, now],
  );
}

beforeEach(async () => {
  if (!available || !pool) return;
  await pool.query(
    "TRUNCATE inquiry_thread_advice, jobs, prompt_deployment_refs, evolvable_asset_versions, evolvable_assets, model_provider_space_grants, model_providers, inquiry_evidence_signals, inquiry_iterations, inquiry_thread_statement_revisions, inquiry_question_states, inquiry_hypothesis_states, inquiry_threads, inquiry_project_settings, projects, space_memberships, users, spaces CASCADE",
  );
  const now = new Date().toISOString();
  await pool.query(`INSERT INTO spaces (id, name, type, created_at, updated_at) VALUES ($1, 'Household', 'household', $2, $2)`, [SPACE, now]);
  await pool.query(
    `INSERT INTO users (id, display_name, status, created_at, updated_at) VALUES ($1, 'Owner', 'active', $2, $2)`,
    [OWNER, now],
  );
  await pool.query(
    `INSERT INTO space_memberships (id, space_id, user_id, role, status, created_at, updated_at) VALUES ($1, $2, $3, 'owner', 'active', $4, $4)`,
    [randomUUID(), SPACE, OWNER, now],
  );
  const project = await new PgProjectRepository(pool).create(identity(), { name: "Advice Project" });
  PROJECT = project.id as string;
  const thread = await new InquiryThreadService(pool).createThread(identity(), PROJECT, {
    kind: "question",
    statement: "Does caching reduce p95 latency?",
  });
  THREAD = thread.id as string;
  await registerPromptAsset();
  await registerProvider();
});

describe("Inquiry next-step advice (real Postgres)", () => {
  it("stores a recommendation without touching the Thread's own Next Focus", async () => {
    if (!available || !pool) return;
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
    const thread = await new InquiryThreadService(pool).getThread(identity(), PROJECT, THREAD);
    expect(thread.next_focus_kind).toBeNull();
    expect(thread.version).toBe(1);
  });

  it("rejects a recommendation the domain does not define", async () => {
    if (!available || !pool) return;
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
    if (!available || !pool) return;
    const service = serviceReturning({
      recommended_focus_kind: "read_evidence",
      rationale: "Two contradicting papers arrived and have not been judged.",
      cited_refs: [],
    });
    await service.generateAdvice(identity(), PROJECT, THREAD, "candidate_created");
    expect((await service.getAdvice(identity(), PROJECT, THREAD))?.stale).toBe(false);

    await new InquiryIterationService(pool).recordIteration(identity(), PROJECT, THREAD, {
      change_summary: "Read both papers; the contradiction is about a different workload.",
      answer_state: "partial",
      current_answer_summary: "Helps for read-heavy workloads.",
    });

    const after = await service.getAdvice(identity(), PROJECT, THREAD);
    expect(after?.stale).toBe(true);
    expect(after?.recommended_focus_kind).toBe("read_evidence");
  });

  it("keeps one current recommendation per Thread rather than a queue", async () => {
    if (!available || !pool) return;
    await serviceReturning({ recommended_focus_kind: "search_acquisition", rationale: "No evidence yet.", cited_refs: [] })
      .generateAdvice(identity(), PROJECT, THREAD, "user_request");
    await serviceReturning({ recommended_focus_kind: "synthesize", rationale: "Evidence has since arrived.", cited_refs: [] })
      .generateAdvice(identity(), PROJECT, THREAD, "search_completed");

    const rows = await pool.query("SELECT recommended_focus_kind, trigger_kind FROM inquiry_thread_advice WHERE thread_id = $1", [THREAD]);
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0]).toMatchObject({ recommended_focus_kind: "synthesize", trigger_kind: "search_completed" });
  });

  it("dismissal retires the suggestion, and regenerating reopens it", async () => {
    if (!available || !pool) return;
    const service = serviceReturning({ recommended_focus_kind: "pause", rationale: "Blocked upstream.", cited_refs: [] });
    await service.generateAdvice(identity(), PROJECT, THREAD, "user_request");

    expect((await service.dismissAdvice(identity(), PROJECT, THREAD)).status).toBe("dismissed");
    expect((await service.getAdvice(identity(), PROJECT, THREAD))?.status).toBe("dismissed");

    await service.generateAdvice(identity(), PROJECT, THREAD, "user_request");
    expect((await service.getAdvice(identity(), PROJECT, THREAD))?.status).toBe("open");
  });

  it("refuses to advise a Thread that is no longer active", async () => {
    if (!available || !pool) return;
    await new InquiryIterationService(pool).transitionLifecycle(identity(), PROJECT, THREAD, {
      lifecycle_status: "resolved",
      reason: "Answered",
    });
    const service = serviceReturning({ recommended_focus_kind: "promote_knowledge", rationale: "Settled.", cited_refs: [] });
    await expect(service.generateAdvice(identity(), PROJECT, THREAD, "user_request"))
      .rejects.toMatchObject({ statusCode: 422 });
  });

  it("queues automatic advice only for Threads the project has actually focused", async () => {
    if (!available || !pool) return;
    const jobCount = async () => Number((await pool!.query(
      "SELECT COUNT(*)::text AS total FROM jobs WHERE job_type = 'inquiry_next_step_advice'",
    )).rows[0].total);

    // Backlog by default — automatic spend stays bounded by the Focus WIP limit.
    await queueAdviceForFocusedThread(pool, {
      spaceId: SPACE, userId: OWNER, projectId: PROJECT, threadId: THREAD, triggerKind: "iteration_recorded",
    });
    expect(await jobCount()).toBe(0);

    await new InquiryIterationService(pool).updateWork(identity(), PROJECT, THREAD, {
      attention_state: "focused",
      next_focus_kind: "search_acquisition",
    });
    await queueAdviceForFocusedThread(pool, {
      spaceId: SPACE, userId: OWNER, projectId: PROJECT, threadId: THREAD, triggerKind: "iteration_recorded",
    });
    expect(await jobCount()).toBe(1);

    // A burst of triggers on the same Thread must not buy several provider
    // calls whose results only overwrite each other.
    await queueAdviceForFocusedThread(pool, {
      spaceId: SPACE, userId: OWNER, projectId: PROJECT, threadId: THREAD, triggerKind: "candidate_created",
    });
    expect(await jobCount()).toBe(1);
  });

  it("queues nothing when the triggering path has no acting user", async () => {
    if (!available || !pool) return;
    await new InquiryIterationService(pool).updateWork(identity(), PROJECT, THREAD, {
      attention_state: "focused",
      next_focus_kind: "search_acquisition",
    });
    await queueAdviceForFocusedThread(pool, {
      spaceId: SPACE, userId: null, projectId: PROJECT, threadId: THREAD, triggerKind: "search_completed",
    });
    const jobs = await pool.query("SELECT id FROM jobs WHERE job_type = 'inquiry_next_step_advice'");
    expect(jobs.rows).toHaveLength(0);
  });


  it("advice generated while the Thread changes underneath does not claim to be current", async () => {
    if (!available || !pool) return;
    // The provider call is where real latency lives; a concurrent Iteration
    // during it means the advice reasoned about a superseded revision.
    const service = new InquiryAdviceService(pool, config, async () => {
      await new InquiryIterationService(pool!).recordIteration(identity(), PROJECT, THREAD, {
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
    if (!available || !pool) return;
    await new InquiryIterationService(pool).updateWork(identity(), PROJECT, THREAD, {
      attention_state: "focused",
      next_focus_kind: "read_evidence",
    });
    await new InquiryIterationService(pool).recordIteration(identity(), PROJECT, THREAD, {
      change_summary: "Skimmed the first ten results.",
      answer_state: "partial",
      current_answer_summary: "Looks promising for read-heavy workloads.",
    });

    const jobs = await pool.query<{ payload_json: Record<string, unknown> }>(
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
