import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { getTestPostgres, type TestPostgresDatabase } from "./support/sharedPostgres";
import { migrate } from "../src/db/migrator";
import { PgProjectRepository } from "../src/modules/projects/repository";
import { ProjectOverviewService } from "../src/modules/projects/overviewService";
import { ProjectAttentionService, registerBuiltInAttentionAdapters } from "../src/modules/projects/attentionService";
import { projectAttentionRegistry } from "../src/modules/projects/attentionRegistry";
import { projectModeProjectionRegistry } from "../src/modules/projects/overviewRegistry";
import { InquiryThreadService } from "../src/modules/inquiry/threadService";
import { InquirySignalService } from "../src/modules/inquiry/signalService";
import { registerInquiryProjectIntegration } from "../src/modules/inquiry/projectIntegration";

// Proves the Project Kernel <-> Inquiry integration: the Kernel's Mode
// Overview and Attention registries (ADR 0011 decision 5) are actually
// populated by Inquiry, not just structurally capable of being populated.
// `modules/projects` must never query `inquiry_*` tables directly — it only
// calls through these registries.

const MIGRATIONS_DIR = join(process.cwd(), "migrations");
const SPACE = "11111111-1111-4111-8111-111111111111";
const OWNER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

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
    console.warn(`[inquiry-project-integration-db] skipped — Docker/Postgres unavailable: ${error instanceof Error ? error.message : String(error)}`);
  }
}, 180_000);

afterAll(async () => {
  await pool?.end();
  await container?.stop();
});

afterEach(() => {
  projectAttentionRegistry.__resetForTests();
  projectModeProjectionRegistry.__resetForTests();
});

beforeEach(async () => {
  if (!available || !pool) return;
  await pool.query(
    "TRUNCATE inquiry_signal_candidates, inquiry_evidence_signals, inquiry_question_states, inquiry_hypothesis_states, inquiry_threads, project_corpus_items, space_objects, projects, space_memberships, users, spaces CASCADE",
  );
  const now = new Date().toISOString();
  await pool.query(`INSERT INTO spaces (id, name, type, created_at, updated_at) VALUES ($1, 'Household', 'household', $2, $2)`, [SPACE, now]);
  await pool.query(`INSERT INTO users (id, display_name, status, created_at, updated_at) VALUES ($1, 'Owner', 'active', $2, $2)`, [OWNER, now]);
  await pool.query(
    `INSERT INTO space_memberships (id, space_id, user_id, role, status, created_at, updated_at) VALUES ($1, $2, $3, 'owner', 'active', $4, $4)`,
    [randomUUID(), SPACE, OWNER, now],
  );
  registerBuiltInAttentionAdapters();
  registerInquiryProjectIntegration();
});

const identity = () => ({ spaceId: SPACE, userId: OWNER });

async function createCorpusItem(projectId: string): Promise<string> {
  const objectId = randomUUID();
  const corpusItemId = randomUUID();
  const now = new Date().toISOString();
  await pool!.query(
    `INSERT INTO space_objects (id, space_id, object_type, title, status, visibility, owner_user_id, created_at, updated_at)
     VALUES ($1, $2, 'source', 'A source', 'processed', 'private', $3, $4, $4)`,
    [objectId, SPACE, OWNER, now],
  );
  await pool!.query(
    `INSERT INTO project_corpus_items (id, space_id, project_id, object_id, role, status, triage_status, read_status, metadata_json, created_at, updated_at)
     VALUES ($1, $2, $3, $4, 'candidate', 'active', 'new', 'unread', '{}'::jsonb, $5, $5)`,
    [corpusItemId, SPACE, projectId, objectId, now],
  );
  return corpusItemId;
}

describe("Inquiry <-> Project Kernel integration (real Postgres)", () => {
  it("the Project Overview's inquiry mode_projection and workspace_summaries reflect real Thread/Candidate state, not the fallback placeholder", async () => {
    if (!available || !pool) return;
    const project = await new PgProjectRepository(pool).create(identity(), { name: "Integration Project" });
    const threadSvc = new InquiryThreadService(pool);
    const signalSvc = new InquirySignalService(pool);

    const question = await threadSvc.createThread(identity(), project.id as string, { kind: "question", statement: "Does X hold?" });
    const corpusItemId = await createCorpusItem(project.id as string);
    await signalSvc.createSignal(identity(), project.id as string, question.id as string, {
      corpus_item_id: corpusItemId,
      classification: "contradicts",
    });

    const overview = await new ProjectOverviewService(pool).getOverview(identity(), project.id as string);
    expect(overview.mode_projection).toMatchObject({
      mode: "inquiry",
      current_state_summary: expect.stringContaining("1 active Thread"),
    });
    expect(overview.mode_projection).not.toMatchObject({ current_state_summary: expect.stringContaining("no Overview adapter") });
    const progress = (overview.mode_projection as Record<string, unknown>).progress_indicators as Array<{ metric: string; value: number }>;
    expect(progress.find((p) => p.metric === "pending_candidates")?.value).toBe(1);

    const inquirySummary = (overview.area_summaries as Array<{ mode: string; summary: { count: number; status: string } }>)
      .find((w) => w.mode === "inquiry");
    expect(inquirySummary).toMatchObject({ summary: { count: 1, status: "attention" } });
  });

  it("a pending Inquiry Candidate surfaces as a cross-workspace Attention item", async () => {
    if (!available || !pool) return;
    const project = await new PgProjectRepository(pool).create(identity(), { name: "Attention Project" });
    const threadSvc = new InquiryThreadService(pool);
    const signalSvc = new InquirySignalService(pool);
    const question = await threadSvc.createThread(identity(), project.id as string, { kind: "question", statement: "Does Y hold?" });
    const corpusItemId = await createCorpusItem(project.id as string);
    const signal = await signalSvc.createSignal(identity(), project.id as string, question.id as string, {
      corpus_item_id: corpusItemId,
      classification: "contradicts",
    });

    const items = await new ProjectAttentionService(pool).listAttentionItems(identity(), project.id as string);
    const candidateItem = items.find((i) => i.source_type === "inquiry_candidate" && i.source_id === signal.candidate_id);
    expect(candidateItem).toMatchObject({
      area_kind: "inquiry",
      severity: "high",
      href: `/projects/${project.id}/inquiry?candidate=${signal.candidate_id}`,
    });
  });
});
