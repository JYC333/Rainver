import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { getTestPostgres, isTestPostgresUnavailableError, type TestPostgresDatabase } from "./support/sharedPostgres";
import { migrate } from "../src/db/migrator";
import { PgProjectRepository } from "../src/modules/projects/repository";
import { ProjectOverviewService } from "../src/modules/projects/overviewService";
import { ProjectAttentionService, registerBuiltInAttentionAdapters } from "../src/modules/projects/attentionService";
import { projectAttentionRegistry } from "../src/modules/projects/attentionRegistry";
import { projectModeProjectionRegistry } from "../src/modules/projects/overviewRegistry";
import { DecisionCaseService } from "../src/modules/decisions/caseService";
import { registerDecisionsProjectIntegration } from "../src/modules/decisions/projectIntegration";
import { LearningService } from "../src/modules/learning/service";
import { registerLearningProjectIntegration } from "../src/modules/learning/projectIntegration";

// Proves the Decision/Learning <-> Project Kernel integration, mirroring
// inquiryProjectIntegrationDb.test.ts: the Project Overview's Decision and
// Learning entity_summaries reflect real data through the registries
// (ADR 0011 decision 5), not the "no Overview adapter yet" fallback —
// the invariant that each Mode has a real progress model.

const MIGRATIONS_DIR = join(process.cwd(), "migrations");
const SPACE = "44444444-4444-4444-8444-444444444444";
const OWNER = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";

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
    if (!isTestPostgresUnavailableError(error)) throw error;
    console.warn(`[decision-learning-project-integration-db] skipped — Docker/Postgres unavailable: ${error instanceof Error ? error.message : String(error)}`);
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
    `TRUNCATE learning_item_mastery, learning_items, learning_objectives, decision_option_scores, decision_commitments,
       decision_criteria, decision_options, decision_cases, knowledge_items, space_objects,
       projects, space_memberships, users, spaces CASCADE`,
  );
  const now = new Date().toISOString();
  await pool.query(`INSERT INTO spaces (id, name, type, created_at, updated_at) VALUES ($1, 'Household', 'household', $2, $2)`, [SPACE, now]);
  await pool.query(`INSERT INTO users (id, display_name, status, created_at, updated_at) VALUES ($1, 'Owner', 'active', $2, $2)`, [OWNER, now]);
  await pool.query(
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
  await pool!.query(
    `INSERT INTO space_objects (id, space_id, object_type, title, visibility, owner_user_id, primary_project_id, created_by_user_id, created_at, updated_at)
     VALUES ($1,$2,'knowledge_item','Anchor concept','space_shared',$3,$4,$3,$5,$5)`,
    [objectId, SPACE, OWNER, projectId, now],
  );
  await pool!.query(
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
    if (!available || !pool) return;
    const project = await new PgProjectRepository(pool).create(identity(), { name: "Decision Integration Project" });
    const cases = new DecisionCaseService(pool);
    const decisionCase = await cases.createCase(identity(), project.id as string, { title: "Pick a vendor" });
    const optionA = await cases.addOption(identity(), project.id as string, decisionCase.id as string, { title: "Vendor A" });
    const optionB = await cases.addOption(identity(), project.id as string, decisionCase.id as string, { title: "Vendor B" });
    const criterion = await cases.addCriterion(identity(), project.id as string, decisionCase.id as string, { name: "Fit" });
    await cases.scoreOption(identity(), project.id as string, decisionCase.id as string, { option_id: optionA.id, criterion_id: criterion.id, score: 5 });
    await cases.scoreOption(identity(), project.id as string, decisionCase.id as string, { option_id: optionB.id, criterion_id: criterion.id, score: 3 });

    const overview = await new ProjectOverviewService(pool).getOverview(identity(), project.id as string);
    // Decision is no longer a Primary Mode; it reports an entity summary row
    // that a Project of any Mode can carry.
    expect(entityRow(overview, "decision_case")).toMatchObject({ count: 1, status: "attention" });

    const items = await new ProjectAttentionService(pool).listAttentionItems(identity(), project.id as string);
    const attentionItem = items.find((i) => i.source_type === "decision_case" && i.source_id === decisionCase.id);
    expect(attentionItem).toMatchObject({
      area_kind: "decision",
      href: `/projects/${project.id}/decisions?open=${decisionCase.id}`,
    });
  });

  it("Learning mastery progress surfaces in entity_summaries, not the fallback placeholder", async () => {
    if (!available || !pool) return;
    const project = await new PgProjectRepository(pool).create(identity(), { name: "Learning Integration Project" });
    const knowledgeItemId = await seedKnowledgeItem(project.id as string);
    const learning = new LearningService(pool);
    const item = await learning.createItem(identity(), {
      project_id: project.id, knowledge_item_id: knowledgeItemId, prompt: "p", answer: "a",
    });
    await learning.recordReview(identity(), item.id as string, { outcome: "correct" });

    const overview = await new ProjectOverviewService(pool).getOverview(identity(), project.id as string);
    expect(entityRow(overview, "learning_item")).toMatchObject({ count: 1 });
  });
});
