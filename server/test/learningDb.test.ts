import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { getTestPostgres, isTestPostgresUnavailableError, type TestPostgresDatabase } from "./support/sharedPostgres";
import { migrate } from "../src/db/migrator";
import { LearningService } from "../src/modules/learning/service";
import type { SpaceUserIdentity } from "../src/modules/routeUtils/common";

// Real-Postgres coverage for the Learning slice:
// Objective/Item foundations anchored to a stable, versioned Knowledge item,
// per-user mastery kept separate from the shared Item content, and both a
// Project-contextual and a global (cross-Project) listing surface.

const MIGRATIONS_DIR = join(process.cwd(), "migrations");
const SPACE = "33333333-3333-4333-8333-333333333333";
const OWNER = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const OTHER_USER = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const PROJECT = "77777777-7777-4777-8777-777777777777";
const identity: SpaceUserIdentity = { spaceId: SPACE, userId: OWNER };
const otherIdentity: SpaceUserIdentity = { spaceId: SPACE, userId: OTHER_USER };

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
    console.warn(`[learning-db] skipped — Docker/Postgres unavailable: ${error instanceof Error ? error.message : String(error)}`);
  }
}, 180_000);

afterAll(async () => {
  await pool?.end();
  await container?.stop();
});

beforeEach(async () => {
  if (!available || !pool) return;
  await pool.query(
    `TRUNCATE learning_item_mastery, learning_items, learning_objectives, knowledge_items, space_objects,
       project_members, projects, space_memberships, users, spaces CASCADE`,
  );
  const now = new Date().toISOString();
  await pool.query(`INSERT INTO spaces (id, name, type, created_at, updated_at) VALUES ($1,'Main','personal',$2,$2)`, [SPACE, now]);
  await pool.query(`INSERT INTO users (id, display_name, status, created_at, updated_at) VALUES ($1,$1,'active',$2,$2)`, [OWNER, now]);
  await pool.query(`INSERT INTO users (id, display_name, status, created_at, updated_at) VALUES ($1,$1,'active',$2,$2)`, [OTHER_USER, now]);
  await pool.query(
    `INSERT INTO space_memberships (id, space_id, user_id, role, status, created_at, updated_at) VALUES ($1,$2,$3,'owner','active',$4,$4)`,
    [randomUUID(), SPACE, OWNER, now],
  );
  await pool.query(
    `INSERT INTO space_memberships (id, space_id, user_id, role, status, created_at, updated_at) VALUES ($1,$2,$3,'member','active',$4,$4)`,
    [randomUUID(), SPACE, OTHER_USER, now],
  );
  await pool.query(
    `INSERT INTO projects (id, space_id, owner_user_id, name, status, created_at, updated_at) VALUES ($1,$2,$3,'Research','active',$4,$4)`,
    [PROJECT, SPACE, OWNER, now],
  );
});

async function seedKnowledgeItem(version = 1): Promise<string> {
  const objectId = randomUUID();
  const now = new Date().toISOString();
  await pool!.query(
    `INSERT INTO space_objects (id, space_id, object_type, title, visibility, owner_user_id, primary_project_id, created_by_user_id, created_at, updated_at)
     VALUES ($1,$2,'knowledge_item','Anchor concept','space_shared',$3,$4,$3,$5,$5)`,
    [objectId, SPACE, OWNER, PROJECT, now],
  );
  await pool!.query(
    `INSERT INTO knowledge_items (object_id, space_id, knowledge_kind, content, content_format, content_schema_version, plain_text, verification_status, reflection_status, tags_json, version)
     VALUES ($1,$2,'concept','Concept body','markdown',1,'Concept body','unverified','unreviewed','[]'::jsonb,$3)`,
    [objectId, SPACE, version],
  );
  return objectId;
}

async function seedKnowledgeItemIn(spaceId: string, projectId: string, ownerUserId: string): Promise<string> {
  const objectId = randomUUID();
  const now = new Date().toISOString();
  await pool!.query(
    `INSERT INTO space_objects (id, space_id, object_type, title, visibility, owner_user_id, primary_project_id, created_by_user_id, created_at, updated_at)
     VALUES ($1,$2,'knowledge_item','Anchor concept','space_shared',$3,$4,$3,$5,$5)`,
    [objectId, spaceId, ownerUserId, projectId, now],
  );
  await pool!.query(
    `INSERT INTO knowledge_items (object_id, space_id, knowledge_kind, content, content_format, content_schema_version, plain_text, verification_status, reflection_status, tags_json, version)
     VALUES ($1,$2,'concept','Concept body','markdown',1,'Concept body','unverified','unreviewed','[]'::jsonb,1)`,
    [objectId, spaceId],
  );
  return objectId;
}

describe("Learning Domain (real Postgres)", () => {
  it("creates an Objective and an anchored Item, and lists it in both Project-contextual and global surfaces", async () => {
    if (!available || !pool) return;
    const knowledgeItemId = await seedKnowledgeItem(2);
    const learning = new LearningService(pool);

    const objective = await learning.createObjective(identity, { project_id: PROJECT, title: "Master caching" });
    expect(objective).toMatchObject({ project_id: PROJECT, title: "Master caching", status: "active" });

    const item = await learning.createItem(identity, {
      project_id: PROJECT, objective_id: objective.id, knowledge_item_id: knowledgeItemId,
      prompt: "What does the concept say?", answer: "Concept body",
    });
    expect(item).toMatchObject({ knowledge_item_id: knowledgeItemId, knowledge_item_version: 2, item_kind: "card" });

    const projectItems = await learning.listItems(identity, { projectId: PROJECT });
    expect(projectItems).toHaveLength(1);
    const globalItems = await learning.listItems(identity, {});
    expect(globalItems).toHaveLength(1);
    const globalObjectives = await learning.listObjectives(identity, {});
    expect(globalObjectives.map((o) => o.id)).toContain(objective.id);
  });

  it("rejects an Item anchored to a Knowledge item that does not exist in this Space", async () => {
    if (!available || !pool) return;
    const learning = new LearningService(pool);
    await expect(learning.createItem(identity, {
      knowledge_item_id: randomUUID(), prompt: "p", answer: "a",
    })).rejects.toMatchObject({ statusCode: 404 });
  });

  it("scopes the global surface to Projects the caller can actually read, in a team Space with per-Project membership", async () => {
    if (!available || !pool) return;
    const teamSpace = randomUUID();
    const outsider = randomUUID();
    const readableProject = randomUUID();
    const restrictedProject = randomUUID();
    const now = new Date().toISOString();
    await pool.query(`INSERT INTO spaces (id, name, type, created_at, updated_at) VALUES ($1,'Team','household',$2,$2)`, [teamSpace, now]);
    await pool.query(`INSERT INTO users (id, display_name, status, created_at, updated_at) VALUES ($1,$1,'active',$2,$2)`, [outsider, now]);
    await pool.query(
      `INSERT INTO space_memberships (id, space_id, user_id, role, status, created_at, updated_at) VALUES ($1,$2,$3,'owner','active',$4,$4)`,
      [randomUUID(), teamSpace, OWNER, now],
    );
    await pool.query(
      `INSERT INTO space_memberships (id, space_id, user_id, role, status, created_at, updated_at) VALUES ($1,$2,$3,'member','active',$4,$4)`,
      [randomUUID(), teamSpace, outsider, now],
    );
    // OWNER owns readableProject (owner_user_id grants access without a
    // project_members row); outsider owns restrictedProject and OWNER is
    // never added to it — OWNER must not see its Learning content.
    await pool.query(
      `INSERT INTO projects (id, space_id, owner_user_id, name, status, created_at, updated_at) VALUES ($1,$2,$3,'Readable','active',$4,$4)`,
      [readableProject, teamSpace, OWNER, now],
    );
    await pool.query(
      `INSERT INTO projects (id, space_id, owner_user_id, name, status, created_at, updated_at) VALUES ($1,$2,$3,'Restricted','active',$4,$4)`,
      [restrictedProject, teamSpace, outsider, now],
    );

    const teamIdentity: SpaceUserIdentity = { spaceId: teamSpace, userId: OWNER };
    const outsiderIdentity: SpaceUserIdentity = { spaceId: teamSpace, userId: outsider };
    const learning = new LearningService(pool);
    const readableKnowledgeId = await seedKnowledgeItemIn(teamSpace, readableProject, OWNER);
    const restrictedKnowledgeId = await seedKnowledgeItemIn(teamSpace, restrictedProject, outsider);
    await learning.createObjective(teamIdentity, { project_id: readableProject, title: "Readable objective" });
    await learning.createObjective(outsiderIdentity, { project_id: restrictedProject, title: "Restricted objective" });
    await learning.createItem(teamIdentity, { project_id: readableProject, knowledge_item_id: readableKnowledgeId, prompt: "p1", answer: "a1" });
    const restrictedItem = await learning.createItem(outsiderIdentity, { project_id: restrictedProject, knowledge_item_id: restrictedKnowledgeId, prompt: "p2", answer: "a2" });

    const ownerGlobalObjectives = await learning.listObjectives(teamIdentity, {});
    expect(ownerGlobalObjectives).toHaveLength(1);
    expect(ownerGlobalObjectives[0]).toMatchObject({ project_id: readableProject });

    const ownerGlobalItems = await learning.listItems(teamIdentity, {});
    expect(ownerGlobalItems).toHaveLength(1);
    expect(ownerGlobalItems[0]).toMatchObject({ project_id: readableProject });

    // Directly requesting the restricted Project by id is rejected outright.
    await expect(learning.listItems(teamIdentity, { projectId: restrictedProject })).rejects.toMatchObject({ statusCode: 404 });
    // A direct-by-id review call must respect the same boundary, not just the listing filter.
    await expect(learning.recordReview(teamIdentity, restrictedItem.id as string, { outcome: "correct" })).rejects.toMatchObject({ statusCode: 404 });
  });

  it("keeps mastery per-user: two users reviewing the same Item never see each other's progress", async () => {
    if (!available || !pool) return;
    const knowledgeItemId = await seedKnowledgeItem();
    const learning = new LearningService(pool);
    const item = await learning.createItem(identity, { knowledge_item_id: knowledgeItemId, prompt: "p", answer: "a" });

    await learning.recordReview(identity, item.id as string, { outcome: "correct" });
    await learning.recordReview(identity, item.id as string, { outcome: "correct" });
    const ownerMastery = await learning.recordReview(identity, item.id as string, { outcome: "correct" });
    expect(ownerMastery).toMatchObject({ mastery_state: "mastered", correct_streak: 3 });

    // The other user has never reviewed this Item — their own mastery state
    // starts fresh, unaffected by the owner's streak.
    const otherMastery = await learning.recordReview(otherIdentity, item.id as string, { outcome: "incorrect" });
    expect(otherMastery).toMatchObject({ mastery_state: "learning", correct_streak: 0 });

    const ownerSummary = await learning.getMasterySummary(identity, {});
    expect(ownerSummary.mastered_count).toBe(1);
    const otherSummary = await learning.getMasterySummary(otherIdentity, {});
    expect(otherSummary.mastered_count).toBe(0);
    expect(otherSummary.learning_count).toBe(1);

    const rows = await pool.query(`SELECT count(*)::int AS n FROM learning_item_mastery WHERE learning_item_id=$1`, [item.id]);
    expect(rows.rows[0].n).toBe(2);
  });

  it("rejects cross-Project Objectives and private Knowledge anchors", async () => {
    if (!available || !pool) return;
    const otherProject = randomUUID();
    const now = new Date().toISOString();
    await pool.query(
      `INSERT INTO projects (id,space_id,owner_user_id,name,status,created_at,updated_at)
       VALUES ($1,$2,$3,'Other','active',$4,$4)`,
      [otherProject, SPACE, OWNER, now],
    );
    const learning = new LearningService(pool);
    const objective = await learning.createObjective(identity, { project_id: otherProject, title: "Other objective" });
    const sharedKnowledge = await seedKnowledgeItem();
    await expect(learning.createItem(identity, {
      project_id: PROJECT, objective_id: objective.id, knowledge_item_id: sharedKnowledge, prompt: "p", answer: "a",
    })).rejects.toMatchObject({ statusCode: 422 });

    const privateKnowledge = await seedKnowledgeItem();
    await pool.query(`UPDATE space_objects SET visibility='private' WHERE id=$1`, [privateKnowledge]);
    await expect(learning.createItem(identity, {
      project_id: PROJECT, knowledge_item_id: privateKnowledge, prompt: "p", answer: "a",
    })).rejects.toMatchObject({ statusCode: 404 });
  });

  it("does not lose concurrent mastery increments", async () => {
    if (!available || !pool) return;
    const learning = new LearningService(pool);
    const item = await learning.createItem(identity, {
      knowledge_item_id: await seedKnowledgeItem(), prompt: "p", answer: "a",
    });
    await Promise.all([
      learning.recordReview(identity, item.id as string, { outcome: "correct" }),
      learning.recordReview(identity, item.id as string, { outcome: "correct" }),
      learning.recordReview(identity, item.id as string, { outcome: "correct" }),
    ]);
    const mastery = await pool.query<{ correct_streak: number; mastery_state: string }>(
      `SELECT correct_streak, mastery_state FROM learning_item_mastery WHERE learning_item_id=$1 AND user_id=$2`,
      [item.id, OWNER],
    );
    expect(mastery.rows[0]).toMatchObject({ correct_streak: 3, mastery_state: "mastered" });
  });
});
