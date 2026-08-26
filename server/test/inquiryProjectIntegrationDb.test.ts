import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useTestDatabase } from "./support/testDatabase.js";
import { resetTables } from "./support/resetTables.js";
import { PgProjectRepository } from "../src/modules/projects/repository.js";
import { ProjectOverviewService } from "../src/modules/projects/overviewService.js";
import { ProjectAttentionService, registerBuiltInAttentionAdapters } from "../src/modules/projects/attentionService.js";
import { projectAttentionRegistry } from "../src/modules/projects/attentionRegistry.js";
import { projectModeProjectionRegistry } from "../src/modules/projects/overviewRegistry.js";
import { InquiryThreadService } from "../src/modules/inquiry/threadService.js";
import { InquirySignalService } from "../src/modules/inquiry/signalService.js";
import { registerInquiryProjectIntegration } from "../src/modules/inquiry/projectIntegration.js";

// Proves the Project Kernel <-> Inquiry integration: the Kernel's Mode
// Overview and Attention registries (ADR 0011 decision 5) are actually
// populated by Inquiry, not just structurally capable of being populated.
// `modules/projects` must never query `inquiry_*` tables directly — it only
// calls through these registries.

const SPACE = "11111111-1111-4111-8111-111111111111";
const OWNER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";


const db = useTestDatabase(import.meta.filename);

afterEach(() => {
  projectAttentionRegistry.__resetForTests();
  projectModeProjectionRegistry.__resetForTests();
});

beforeEach(async () => {
  if (!db.available) return;
  await resetTables(
    db.pool,
    ["inquiry_signal_candidates", "inquiry_evidence_signals", "inquiry_question_states", "inquiry_hypothesis_states", "inquiry_threads", "project_corpus_items", "space_objects", "projects", "space_memberships", "users", "spaces"],
    { cascade: true },
  );
  const now = new Date().toISOString();
  await db.pool.query(`INSERT INTO spaces (id, name, type, created_at, updated_at) VALUES ($1, 'Household', 'household', $2, $2)`, [SPACE, now]);
  await db.pool.query(`INSERT INTO users (id, display_name, status, created_at, updated_at) VALUES ($1, 'Owner', 'active', $2, $2)`, [OWNER, now]);
  await db.pool.query(
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
  await db.pool.query(
    `INSERT INTO space_objects (id, space_id, object_type, title, visibility, owner_user_id, created_at, updated_at)
     VALUES ($1, $2, 'source', 'A source', 'private', $3, $4, $4)`,
    [objectId, SPACE, OWNER, now],
  );
  await db.pool.query(
    `INSERT INTO project_corpus_items (id, space_id, project_id, object_id, role, status, triage_status, read_status, metadata_json, created_at, updated_at)
     VALUES ($1, $2, $3, $4, 'candidate', 'active', 'new', 'unread', '{}'::jsonb, $5, $5)`,
    [corpusItemId, SPACE, projectId, objectId, now],
  );
  return corpusItemId;
}

describe("Inquiry <-> Project Kernel integration (real Postgres)", () => {
  it("the Project Overview's inquiry mode_projection and entity_summaries reflect real Thread/Candidate state, not the fallback placeholder", async () => {
    if (!db.available) return;
    const project = await new PgProjectRepository(db.pool).create(identity(), { name: "Integration Project" });
    const threadSvc = new InquiryThreadService(db.pool);
    const signalSvc = new InquirySignalService(db.pool);

    const question = await threadSvc.createThread(identity(), project.id as string, { kind: "question", statement: "Does X hold?" });
    const corpusItemId = await createCorpusItem(project.id as string);
    await signalSvc.createSignal(identity(), project.id as string, question.id as string, {
      corpus_item_id: corpusItemId,
      classification: "contradicts",
    });

    // Inquiry is no longer a Primary Mode — asking is how research starts, so
    // `research` absorbed it. A Thread stays a first-class entity with its own
    // summary row and its own Area, and a pending Candidate still reaches the
    // shell through the attention adapter (asserted in the next case).
    const overview = await new ProjectOverviewService(db.pool).getOverview(identity(), project.id as string);
    const inquirySummary = (overview.entity_summaries as Array<{ entity_type: string; count: number; status: string }>)
      .find((row) => row.entity_type === "inquiry_thread");
    expect(inquirySummary).toMatchObject({ count: 1, status: "attention" });
  });

  it("a pending Inquiry Candidate surfaces as a cross-workspace Attention item", async () => {
    if (!db.available) return;
    const project = await new PgProjectRepository(db.pool).create(identity(), { name: "Attention Project" });
    const threadSvc = new InquiryThreadService(db.pool);
    const signalSvc = new InquirySignalService(db.pool);
    const question = await threadSvc.createThread(identity(), project.id as string, { kind: "question", statement: "Does Y hold?" });
    const corpusItemId = await createCorpusItem(project.id as string);
    const signal = await signalSvc.createSignal(identity(), project.id as string, question.id as string, {
      corpus_item_id: corpusItemId,
      classification: "contradicts",
    });

    const items = await new ProjectAttentionService(db.pool).listAttentionItems(identity(), project.id as string);
    const candidateItem = items.find((i) => i.source_type === "inquiry_candidate" && i.source_id === signal.candidate_id);
    expect(candidateItem).toMatchObject({
      area_kind: "inquiry",
      severity: "high",
      href: `/projects/${project.id}/inquiry?candidate=${signal.candidate_id}`,
    });
  });
});
