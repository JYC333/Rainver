import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { migrate } from "../src/db/migrator";
import { PgChatCandidateRepository } from "../src/modules/context/candidateRepository";
import { getTestPostgres, type TestPostgresDatabase } from "./support/sharedPostgres";

// Real-Postgres coverage for the two Notes context selectors added to close
// a gap: personal Notes never reached AI chat context before this, and a
// project's notes must stay isolated to that project's own Chat requests
// (see chatCandidateCollector.ts — Project Chat suppresses every space-wide
// selector, so selectProjectNotes is the *only* thing standing between one
// project's notes and another's).

const SPACE = "11111111-1111-4111-8111-111111111111";
const USER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const PROJECT_A = "55555555-5555-4555-8555-555555555555";
const PROJECT_B = "56565656-5656-4565-8565-565656565656";

let database: TestPostgresDatabase | undefined;
let pool: Pool | undefined;
let available = false;

beforeAll(async () => {
  try {
    database = await getTestPostgres(__filename);
    pool = new Pool({ connectionString: database.getConnectionUri(), max: 2 });
    await migrate(pool, join(process.cwd(), "migrations"));
    available = true;
  } catch (error) {
    console.warn(`[chat-candidate-notes-db] skipped — Docker/Postgres unavailable: ${error instanceof Error ? error.message : String(error)}`);
  }
}, 180_000);

afterAll(async () => {
  await pool?.end();
  await database?.stop();
});

beforeEach(async () => {
  if (!available || !pool) return;
  await pool.query(`TRUNCATE notes, note_collections, note_collection_items, space_objects, projects, space_memberships, users, spaces CASCADE`);
  const now = new Date().toISOString();
  await pool.query(`INSERT INTO spaces (id,name,type,created_at,updated_at) VALUES ($1,'Space','personal',$2,$2)`, [SPACE, now]);
  await pool.query(`INSERT INTO users (id,display_name,status,created_at,updated_at) VALUES ($1,'Owner','active',$2,$2)`, [USER, now]);
  await pool.query(`INSERT INTO space_memberships (id,space_id,user_id,role,status,created_at,updated_at) VALUES ($1,$2,$3,'owner','active',$4,$4)`, [randomUUID(), SPACE, USER, now]);
  await pool.query(`INSERT INTO projects (id,space_id,owner_user_id,name,status,created_at,updated_at) VALUES ($1,$2,$3,'Project A','active',$4,$4)`, [PROJECT_A, SPACE, USER, now]);
  await pool.query(`INSERT INTO projects (id,space_id,owner_user_id,name,status,created_at,updated_at) VALUES ($1,$2,$3,'Project B','active',$4,$4)`, [PROJECT_B, SPACE, USER, now]);
});

async function seedNote(input: { title: string; plainText: string; projectId?: string | null; visibility?: string; ownerUserId?: string | null }): Promise<string> {
  const objectId = randomUUID();
  const now = new Date().toISOString();
  await pool!.query(
    `INSERT INTO space_objects (id,space_id,object_type,title,status,visibility,owner_user_id,primary_project_id,created_by_user_id,created_at,updated_at)
     VALUES ($1,$2,'note',$3,'active',$4,$5,$6,$5,$7,$7)`,
    [objectId, SPACE, input.title, input.visibility ?? "space_shared", input.ownerUserId ?? USER, input.projectId ?? null, now],
  );
  await pool!.query(
    `INSERT INTO notes (object_id,space_id,content_json,content_format,content_schema_version,plain_text,version,content_hash)
     VALUES ($1,$2,'{"type":"doc","content":[]}'::jsonb,'prosemirror_json',1,$3,1,'hash')`,
    [objectId, SPACE, input.plainText],
  );
  return objectId;
}

describe("Notes context selectors (real Postgres)", () => {
  it("selectProjectNotes returns only the requested project's notes, never another project's", async () => {
    if (!available || !pool) return;
    const noteA = await seedNote({ title: "A note", plainText: "Belongs to project A", projectId: PROJECT_A });
    await seedNote({ title: "B note", plainText: "Belongs to project B", projectId: PROJECT_B });
    await seedNote({ title: "Unfiled note", plainText: "No project at all", projectId: null });

    const repo = new PgChatCandidateRepository(pool);
    const resultA = await repo.selectProjectNotes(SPACE, PROJECT_A, 20);
    expect(resultA.map((row) => row.item_id)).toEqual([noteA]);
    expect(resultA[0]).toMatchObject({ title: "A note", text: "Belongs to project A" });

    const resultB = await repo.selectProjectNotes(SPACE, PROJECT_B, 20);
    expect(resultB.map((row) => row.text)).toEqual(["Belongs to project B"]);
  });

  it("selectNotes surfaces space-wide notes (including project-tagged ones) for ordinary chat", async () => {
    if (!available || !pool) return;
    await seedNote({ title: "A note", plainText: "Belongs to project A", projectId: PROJECT_A });
    await seedNote({ title: "Unfiled note", plainText: "No project at all", projectId: null });

    const repo = new PgChatCandidateRepository(pool);
    const result = await repo.selectNotes(SPACE, USER, "", 20);
    expect(result.map((row) => row.title).sort()).toEqual(["A note", "Unfiled note"]);
  });

  it("selectNotes respects private note visibility — another user's private note is not a candidate", async () => {
    if (!available || !pool) return;
    const otherUser = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    await pool.query(`INSERT INTO users (id,display_name,status,created_at,updated_at) VALUES ($1,'Other','active',now(),now())`, [otherUser]);
    await seedNote({ title: "Private to other", plainText: "Should not leak", visibility: "private", ownerUserId: otherUser });
    await seedNote({ title: "My note", plainText: "Visible" });

    const repo = new PgChatCandidateRepository(pool);
    const result = await repo.selectNotes(SPACE, USER, "", 20);
    expect(result.map((row) => row.title)).toEqual(["My note"]);
  });
});
