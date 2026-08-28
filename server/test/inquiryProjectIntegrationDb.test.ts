import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useTestDatabase } from "./support/testDatabase.js";
import { resetTables } from "./support/resetTables.js";
import { PgProjectRepository } from "../src/modules/projects/repository.js";
import { ProjectAttentionService, registerBuiltInAttentionAdapters } from "../src/modules/projects/attentionService.js";
import { projectAttentionRegistry } from "../src/modules/projects/attentionRegistry.js";
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
});

beforeEach(async () => {
  if (!db.available) return;
  await resetTables(
    db.pool,
    ["inquiry_thread_advice", "inquiry_signal_candidates", "inquiry_evidence_signals", "inquiry_question_states", "inquiry_hypothesis_states", "inquiry_threads", "project_corpus_items", "space_objects", "projects", "space_memberships", "users", "spaces"],
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
  it("the recorded next step for a Thread is Attention, and a stale one is not", async () => {
    if (!db.available) return;
    // Advice is written the moment a search finishes, with its reasoning. It
    // rendered in exactly one place — the Inquiry Area's stage workspace, for
    // the one Thread you had selected — so a finished four-hour search left
    // the Project front page with nothing to say about what to do next.
    const project = await new PgProjectRepository(db.pool).create(identity(), { name: "Agent memory" });
    const threads = new InquiryThreadService(db.pool);
    const current = await threads.createThread(identity(), project.id as string, {
      kind: "question", statement: "agent memory 应该按什么维度分类？",
    });
    const reworded = await threads.createThread(identity(), project.id as string, {
      kind: "question", statement: "How is agent memory stored?",
    });
    const advise = async (threadId: string, version: number, kind: string) => {
      await db.pool!.query(
        `INSERT INTO inquiry_thread_advice (
           id, space_id, project_id, thread_id, recommended_focus_kind, rationale, cited_refs_json,
           thread_version, status, trigger_kind, generated_by_user_id, created_at, updated_at
         ) VALUES ($1,$2,$3,$4,$5,$6,'[]'::jsonb,$7,'open','search_completed',$8,now(),now())`,
        [randomUUID(), SPACE, project.id, threadId, kind, "It bundles four axes into one question.", version, OWNER],
      );
    };
    await advise(String(current.id), Number(current.version), "clarify_or_decompose");
    // Written against the Thread as it read then; the Thread has since been
    // reworded. Advice about a question that no longer reads that way is not
    // a next step, so it is left out rather than shown with a caveat.
    await advise(String(reworded.id), Number(reworded.version), "synthesize");
    await db.pool!.query(
      `UPDATE inquiry_threads SET version = version + 1, statement = 'How is agent memory stored across sessions?'
        WHERE space_id = $1 AND object_id = $2`,
      [SPACE, reworded.id],
    );

    const items = await new ProjectAttentionService(db.pool).listAttentionItems(identity(), project.id as string);
    const advice = items.filter((item) => item.source_type === "inquiry_advice");
    expect(advice).toHaveLength(1);
    expect(advice[0]).toMatchObject({
      source_id: current.id,
      // A suggestion is not a gate: it offers, it does not block.
      attention_class: "next_step",
      reason: "suggested next step",
      href: `/projects/${project.id}/inquiry?thread=${current.id}`,
    });
    expect(advice[0]!.title).toBe("Split this question into sub-questions: agent memory 应该按什么维度分类？");
    expect(advice[0]!.summary).toContain("bundles four axes");
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
      // A knowledge candidate is a decision, not a suggestion.
      attention_class: "gate",
      severity: "high",
      href: `/projects/${project.id}/inquiry?candidate=${signal.candidate_id}`,
    });
  });
});
