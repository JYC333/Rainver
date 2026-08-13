import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { migrate } from "../src/db/migrator";
import { __setAuthIdentityForTests } from "../src/modules/auth/identity";
import { PgKnowledgeRepository } from "../src/modules/knowledge/repository";
import { ProjectResearchAreaService } from "../src/modules/projectResearch/areaService";
import { withNoteWrites } from "../src/modules/knowledge/noteWriter";
import { blockIds } from "../src/modules/knowledge/noteBlockIds";
import { getTestPostgres, isTestPostgresUnavailableError, type TestPostgresDatabase } from "./support/sharedPostgres";

/**
 * The shared note writer, asserted through the three things that were wrong
 * before it existed.
 *
 * Note creation had two implementations — the general one and the Project
 * research one — and they had drifted. Reindexing was the caller's job and
 * only the general one did it, so a note an agent maintained was invisible to
 * search until a human saved it by hand. And binding a note to a Project was
 * unchecked, which stopped being harmless once the Project role became the
 * research baseline: assigning a role displaces the previous holder by design.
 */

const SPACE = "44444444-4444-4444-8444-444444444444";
const OWNER = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const OUTSIDER = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const PROJECT = "55555555-5555-4555-8555-555555555555";

let database: TestPostgresDatabase | undefined;
let pool: Pool | undefined;
let available = false;

beforeAll(async () => {
  try {
    database = await getTestPostgres(__filename);
    pool = new Pool({ connectionString: database.getConnectionUri(), max: 4 });
    await migrate(pool, join(process.cwd(), "migrations"));
    __setAuthIdentityForTests({ spaceId: SPACE, userId: OWNER });
    available = true;
  } catch (error) {
    if (!isTestPostgresUnavailableError(error)) throw error;
    console.warn(`[note-writer-db] skipped — Docker/Postgres unavailable: ${error instanceof Error ? error.message : String(error)}`);
  }
}, 180_000);

afterAll(async () => {
  __setAuthIdentityForTests(null);
  await pool?.end();
  await database?.stop();
});

beforeEach(async () => {
  if (!available || !pool) return;
  await pool.query(
    `TRUNCATE retrieval_objects, note_collection_items, note_collections, note_revisions,
              notes, space_objects, projects, space_memberships, users, spaces CASCADE`,
  );
  const now = new Date().toISOString();
  await pool.query(`INSERT INTO spaces (id,name,type,created_at,updated_at) VALUES ($1,'Space','team',$2,$2)`, [SPACE, now]);
  for (const [id, name, role] of [[OWNER, "Owner", "owner"], [OUTSIDER, "Outsider", "member"]] as const) {
    await pool.query(`INSERT INTO users (id,display_name,status,created_at,updated_at) VALUES ($1,$2,'active',$3,$3)`, [id, name, now]);
    await pool.query(
      `INSERT INTO space_memberships (id,space_id,user_id,role,status,created_at,updated_at) VALUES ($1,$2,$3,$4,'active',$5,$5)`,
      [randomUUID(), SPACE, id, role, now],
    );
  }
  await pool.query(
    `INSERT INTO projects (id,space_id,name,status,owner_user_id,created_at,updated_at) VALUES ($1,$2,'Project','active',$3,$4,$4)`,
    [PROJECT, SPACE, OWNER, now],
  );
});

const owner = { spaceId: SPACE, userId: OWNER };
const outsider = { spaceId: SPACE, userId: OUTSIDER };

async function indexedNote(noteId: string): Promise<{ title: string; content_hash: string } | undefined> {
  const rows = await pool!.query<{ title: string; content_hash: string }>(
    `SELECT title, content_hash FROM retrieval_objects
      WHERE space_id=$1 AND object_type='note' AND object_id=$2`,
    [SPACE, noteId],
  );
  return rows.rows[0];
}

describe("shared note writer (real Postgres)", () => {
  it("indexes a Project's starter notes and files them in a stable order", async () => {
    if (!available || !pool) return;
    // The Project path built its own note rows: no summary, and every note at
    // sort_order 0, so the four starter notes were ordered by tie-break.
    await new ProjectResearchAreaService(pool).initializeArea(owner, PROJECT);

    const notes = await pool.query<{ id: string; summary: string | null; sort_order: number; project_role: string }>(
      `SELECT n.object_id AS id, so.summary, nci.sort_order, n.project_role
         FROM notes n
         JOIN space_objects so ON so.id = n.object_id AND so.space_id = n.space_id
         JOIN note_collection_items nci ON nci.note_id = n.object_id AND nci.space_id = n.space_id
        WHERE n.space_id = $1 AND n.project_role IS NOT NULL
        ORDER BY nci.sort_order`,
      [SPACE],
    );
    expect(notes.rows).toHaveLength(4);
    expect(notes.rows.map((row) => row.sort_order)).toEqual([0, 1, 2, 3]);
    for (const row of notes.rows) {
      expect(await indexedNote(row.id)).toBeTruthy();
    }
  });

  it("keeps the retrieval index current when an agent writes the note, not only a user", async () => {
    if (!available || !pool) return;
    await new ProjectResearchAreaService(pool).initializeArea(owner, PROJECT);
    const baseline = await pool.query<{ id: string; version: number }>(
      `SELECT object_id AS id, version FROM notes WHERE space_id=$1 AND project_role='understanding'`,
      [SPACE],
    );
    const note = baseline.rows[0]!;
    const before = await indexedNote(note.id);

    // An agent write: no acting user, and reached through the scope rather
    // than through `updateNote`. Every non-user path into the notebook has
    // this shape — report seeding, ask-ai, notebook chat, the monitoring
    // reconciler — and all of them used to leave the projection untouched, so
    // a note an agent had maintained for weeks was stale in search.
    await withNoteWrites(pool, (scope) => scope.write({
      spaceId: SPACE,
      noteId: note.id,
      expectVersion: note.version,
      content: { kind: "ops", ops: [{ op: "append", markdown: "Transformers dominate the recent work." }] },
      source: "ai_monitoring",
    }));

    const after = await indexedNote(note.id);
    expect(after).toBeTruthy();
    expect(after!.content_hash).not.toEqual(before!.content_hash);
  });

  it("refuses to bind a note to a Project the caller cannot write to", async () => {
    if (!available || !pool) return;
    const repository = new PgKnowledgeRepository(pool);
    await expect(
      repository.createNote(outsider, { title: "Mine now", primary_project_id: PROJECT }),
    ).rejects.toMatchObject({ statusCode: 403 });

    const unbound = await repository.createNote(outsider, { title: "Mine" }) as { id: string };
    await expect(
      repository.updateNote(outsider, unbound.id, { primary_project_id: PROJECT }),
    ).rejects.toMatchObject({ statusCode: 403 });
  });

  it("leaves a Project's baseline note in place when an outsider tries to take its role", async () => {
    if (!available || !pool) return;
    // The whole chain: bind a note to someone else's Project, then claim the
    // baseline role, which clears the real holder. The bind is where it stops.
    await new ProjectResearchAreaService(pool).initializeArea(owner, PROJECT);
    const before = await pool.query<{ id: string }>(
      `SELECT object_id AS id FROM notes WHERE space_id=$1 AND project_role='understanding'`,
      [SPACE],
    );
    const repository = new PgKnowledgeRepository(pool);
    const attacker = await repository.createNote(outsider, { title: "Actually" }) as { id: string };
    await expect(
      repository.updateNote(outsider, attacker.id, { primary_project_id: PROJECT, project_role: "understanding" }),
    ).rejects.toMatchObject({ statusCode: 403 });

    const after = await pool.query<{ id: string }>(
      `SELECT object_id AS id FROM notes WHERE space_id=$1 AND project_role='understanding'`,
      [SPACE],
    );
    expect(after.rows).toHaveLength(1);
    expect(after.rows[0]!.id).toEqual(before.rows[0]!.id);
  });
});

/**
 * Notes written before block ids existed. Absence is legal: nothing migrates
 * them, nothing rewrites their revisions, and they must keep loading.
 */
describe("block ids on notes written before they existed (real Postgres)", () => {
  it("loads an id-less note and stamps it on the next write, leaving its history alone", async () => {
    if (!available || !pool) return;
    const repository = new PgKnowledgeRepository(pool);
    const identity = { spaceId: SPACE, userId: OWNER };
    const note = await repository.createNote(identity, { title: "Legacy" }) as { id: string };

    // Rewrite the stored document to the pre-block-id shape, exactly as a note
    // saved before this feature would sit in the database.
    const legacy = { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Older text." }] }] };
    await pool.query(`UPDATE notes SET content_json = $2::jsonb WHERE object_id = $1`, [note.id, JSON.stringify(legacy)]);
    await pool.query(`UPDATE note_revisions SET content_json = $2::jsonb WHERE note_id = $1`, [note.id, JSON.stringify(legacy)]);

    const loaded = await repository.getNote(identity, note.id) as { content_json: unknown; version: number };
    expect(blockIds(loaded.content_json)).toEqual([null]);

    const updated = await repository.updateNote(identity, note.id, {
      content_json: legacy,
      expect_version: loaded.version,
    }) as { content_json: unknown };
    expect(blockIds(updated.content_json).every(id => typeof id === "string")).toBe(true);

    // The historical revision is untouched — history is evidence, not something
    // to backfill.
    const revisions = await pool.query<{ content_json: unknown }>(
      `SELECT content_json FROM note_revisions WHERE note_id = $1 ORDER BY version ASC LIMIT 1`,
      [note.id],
    );
    expect(blockIds(revisions.rows[0]!.content_json)).toEqual([null]);
  });

  it("anchors an append on the appended block, not on the first pre-existing one", async () => {
    if (!available || !pool) return;
    const identity = { spaceId: SPACE, userId: OWNER };
    const repository = new PgKnowledgeRepository(pool);
    const note = await repository.createNote(identity, { title: "Pre-block-id note" }) as { id: string };

    // Exactly the shape every note written before block ids has — and the shape
    // of every marginalia note P1 already created in production.
    const legacy = {
      type: "doc",
      content: [
        { type: "paragraph", content: [{ type: "text", text: "old one" }] },
        { type: "paragraph", content: [{ type: "text", text: "old two" }] },
      ],
    };
    await pool.query(`UPDATE notes SET content_json = $2::jsonb WHERE object_id = $1`, [note.id, JSON.stringify(legacy)]);

    const result = await withNoteWrites(pool, (scope) => scope.write({
      spaceId: SPACE,
      noteId: note.id,
      content: { kind: "ops", ops: [{ op: "append", markdown: "THE CAPTURE" }] },
      source: "user_edit",
      userId: OWNER,
    }));
    expect(result.outcome).toBe("written");
    if (result.outcome !== "written") return;

    // One block was added, and it is the one the append wrote. Diffing against
    // the unstamped document would have reported all three as added and
    // anchored the capture on "old one".
    expect(result.addedBlockIds).toHaveLength(1);
    const stored = await repository.getNote(identity, note.id) as { content_json: unknown };
    const ids = blockIds(stored.content_json);
    expect(ids).toHaveLength(3);
    expect(ids[2]).toBe(result.addedBlockIds[0]);
    expect(ids[0]).not.toBe(result.addedBlockIds[0]);
  });

  it("stamps a rollback that restores an id-less revision", async () => {
    if (!available || !pool) return;
    const repository = new PgKnowledgeRepository(pool);
    const identity = { spaceId: SPACE, userId: OWNER };
    const note = await repository.createNote(identity, { title: "Rollback" }) as { id: string };
    const legacy = { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Version one." }] }] };
    await pool.query(`UPDATE note_revisions SET content_json = $2::jsonb WHERE note_id = $1 AND version = 1`, [note.id, JSON.stringify(legacy)]);

    const current = await repository.getNote(identity, note.id) as { version: number };
    await repository.updateNote(identity, note.id, {
      content_json: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Version two." }] }] },
      expect_version: current.version,
    });
    const rolled = await repository.rollbackNote(identity, note.id, 1) as { content_json: unknown };

    expect(blockIds(rolled.content_json).every(id => typeof id === "string")).toBe(true);
  });
});
