import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useTestDatabase } from "./support/testDatabase.js";
import { resetTables } from "./support/resetTables.js";
import { PgProjectRepository } from "../src/modules/projects/repository.js";
import { ProjectOverviewService } from "../src/modules/projects/overviewService.js";
import { ProjectAttentionService, registerBuiltInAttentionAdapters } from "../src/modules/projects/attentionService.js";
import { projectAttentionRegistry } from "../src/modules/projects/attentionRegistry.js";
import { projectModeProjectionRegistry } from "../src/modules/projects/overviewRegistry.js";
import { DecisionCaseService } from "../src/modules/decisions/caseService.js";
import { registerDecisionsProjectIntegration } from "../src/modules/decisions/projectIntegration.js";
import { LearningService } from "../src/modules/learning/service.js";
import { registerLearningProjectIntegration } from "../src/modules/learning/projectIntegration.js";

// Proves the Decision/Learning <-> Project Kernel integration, mirroring
// inquiryProjectIntegrationDb.test.ts: the Project Overview's Decision and
// Learning entity_summaries reflect real data through the registries
// (ADR 0011 decision 5), not the "no Overview adapter yet" fallback —
// the invariant that each Mode has a real progress model.

const SPACE = "44444444-4444-4444-8444-444444444444";
const OWNER = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";


const db = useTestDatabase(import.meta.filename);

afterEach(() => {
  projectAttentionRegistry.__resetForTests();
  projectModeProjectionRegistry.__resetForTests();
});

beforeEach(async () => {
  if (!db.available) return;
  await resetTables(
    db.pool,
    ["learning_item_mastery", "learning_items", "learning_objectives", "decision_option_scores", "decision_commitments", "decision_criteria", "decision_options", "decision_cases", "knowledge_items", "space_objects", "projects", "space_memberships", "users", "spaces"],
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
  registerDecisionsProjectIntegration();
  registerLearningProjectIntegration();
});

const identity = () => ({ spaceId: SPACE, userId: OWNER });

async function seedKnowledgeItem(projectId: string): Promise<string> {
  const objectId = randomUUID();
  const now = new Date().toISOString();
  await db.pool.query(
    `INSERT INTO space_objects (id, space_id, object_type, title, visibility, owner_user_id, primary_project_id, created_by_user_id, created_at, updated_at)
     VALUES ($1,$2,'knowledge_item','Anchor concept','space_shared',$3,$4,$3,$5,$5)`,
    [objectId, SPACE, OWNER, projectId, now],
  );
  await db.pool.query(
    `INSERT INTO knowledge_items (object_id, space_id, knowledge_kind, content, content_format, content_schema_version, plain_text, verification_status, reflection_status, tags_json, version)
     VALUES ($1,$2,'concept','Concept body','markdown',1,'Concept body','unverified','unreviewed','[]'::jsonb,1)`,
    [objectId, SPACE],
  );
  return objectId;
}

/** Find an entity summary row the Overview composed for this Project. */
function entityRow(overview: Record<string, unknown>, entityType: string) {
  return (overview.entity_summaries as Array<{ entity_type: string; count: number; status: string }>)
    .find((row) => row.entity_type === entityType);
}

describe("Decision/Learning <-> Project Kernel integration (real Postgres)", () => {
  it("a Decision Case ready to decide surfaces in entity_summaries and as a Project Attention item", async () => {
    if (!db.available) return;
    const project = await new PgProjectRepository(db.pool).create(identity(), { name: "Decision Integration Project" });
    const cases = new DecisionCaseService(db.pool);
    const decisionCase = await cases.createCase(identity(), project.id as string, { title: "Pick a vendor" });
    const optionA = await cases.addOption(identity(), project.id as string, decisionCase.id as string, { title: "Vendor A" });
    const optionB = await cases.addOption(identity(), project.id as string, decisionCase.id as string, { title: "Vendor B" });
    const criterion = await cases.addCriterion(identity(), project.id as string, decisionCase.id as string, { name: "Fit" });
    await cases.scoreOption(identity(), project.id as string, decisionCase.id as string, { option_id: optionA.id, criterion_id: criterion.id, score: 5 });
    await cases.scoreOption(identity(), project.id as string, decisionCase.id as string, { option_id: optionB.id, criterion_id: criterion.id, score: 3 });

    const overview = await new ProjectOverviewService(db.pool).getOverview(identity(), project.id as string);
    // Decision is no longer a Primary Mode; it reports an entity summary row
    // that a Project of any Mode can carry.
    expect(entityRow(overview, "decision_case")).toMatchObject({ count: 1, status: "attention" });

    const items = await new ProjectAttentionService(db.pool).listAttentionItems(identity(), project.id as string);
    const attentionItem = items.find((i) => i.source_type === "decision_case" && i.source_id === decisionCase.id);
    expect(attentionItem).toMatchObject({
      area_kind: "decision",
      href: `/projects/${project.id}/decisions?open=${decisionCase.id}`,
    });
  });

  it("Learning mastery progress surfaces in entity_summaries, not the fallback placeholder", async () => {
    if (!db.available) return;
    const project = await new PgProjectRepository(db.pool).create(identity(), { name: "Learning Integration Project" });
    const knowledgeItemId = await seedKnowledgeItem(project.id as string);
    const learning = new LearningService(db.pool);
    const item = await learning.createItem(identity(), {
      project_id: project.id, knowledge_item_id: knowledgeItemId, prompt: "p", answer: "a",
    });
    await learning.recordReview(identity(), item.id as string, { outcome: "correct" });

    const overview = await new ProjectOverviewService(db.pool).getOverview(identity(), project.id as string);
    expect(entityRow(overview, "learning_item")).toMatchObject({ count: 1 });
  });
});
