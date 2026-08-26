import { randomUUID } from "node:crypto";
import { insertNoteCollection } from "./support/knowledgeFixtures.js";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { withTransaction } from "../src/db/tx.js";
import { __setAuthIdentityForTests } from "../src/modules/auth/identity.js";
import { persistNotesTreeReorder } from "../src/modules/knowledge/notesTreeReorder.js";
import { PgKnowledgeRepository } from "../src/modules/knowledge/repository.js";
import { buildModuleServer } from "./support/moduleServer.js";
import { knowledgeModule } from "../src/modules/knowledge/index.js";
import { useTestDatabase } from "./support/testDatabase.js";
import { resetTables } from "./support/resetTables.js";

// note_collection_items.sort_order existed in the schema before this but was
// always written as a hardcoded 0 and never read for display order — notes
// were always shown newest-updated-first. This covers making that column
// meaningful: append-on-create/move, and explicit repositioning for drag
// reordering within a folder.

const SPACE = "11111111-1111-4111-8111-111111111111";
const USER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

let app: FastifyInstance | undefined;

const db = useTestDatabase(import.meta.filename, { max: 2 });

// Files share a worker: an identity or invoker left in a module-level
// seam would leak into whichever file runs next.
afterAll(() => {
  __setAuthIdentityForTests(null);
});

beforeAll(async () => {
  if (!db.available || !app) return;
  __setAuthIdentityForTests({ spaceId: SPACE, userId: USER });
  app = buildModuleServer(loadConfig({
    SERVER_DATABASE_URL: db.connectionUri,
    SERVER_INTERNAL_TOKEN: "test-internal-token",
    RAINVER_HOME: "/tmp/rainver-note-ordering-test",
  }), [knowledgeModule]);
});

beforeEach(async () => {
  if (!db.available || !app) return;
  await resetTables(
    db.pool,
    ["notes", "note_collections", "note_collection_items", "space_objects", "space_memberships", "users", "spaces"],
    { cascade: true },
  );
  const now = new Date().toISOString();
  await db.pool.query(`INSERT INTO spaces (id,name,type,created_at,updated_at) VALUES ($1,'Space','personal',$2,$2)`, [SPACE, now]);
  await db.pool.query(`INSERT INTO users (id,display_name,status,created_at,updated_at) VALUES ($1,'Owner','active',$2,$2)`, [USER, now]);
  await db.pool.query(`INSERT INTO space_memberships (id,space_id,user_id,role,status,created_at,updated_at) VALUES ($1,$2,$3,'owner','active',$4,$4)`, [randomUUID(), SPACE, USER, now]);
});

interface ListedNote {
  id: string;
  placements: Array<{ collection_id: string; sort_order: number }>;
}

function listedItems(listed: unknown): ListedNote[] {
  return (listed as { items: ListedNote[] }).items;
}

/** A note's order *within one folder*: with several placements there is no
 * single "the" sort order to assert against. */
function placementOrder(note: ListedNote, collectionId: string): number | undefined {
  return note.placements.find((placement) => placement.collection_id === collectionId)?.sort_order;
}

describe("PgKnowledgeRepository note ordering (real Postgres)", () => {
  it("appends newly created notes to the end of their folder in creation order", async () => {
    if (!db.available || !app) return;
    const identity = { spaceId: SPACE, userId: USER };
    const repository = new PgKnowledgeRepository(db.pool);
    const folder = await insertNoteCollection(db.pool, { space: SPACE, name: "Folder" });

    const first = await repository.createNote(identity, { title: "First", collection_id: folder });
    const second = await repository.createNote(identity, { title: "Second", collection_id: folder });
    const third = await repository.createNote(identity, { title: "Third", collection_id: folder });

    const listed = await repository.listNotes(identity, { status: null, projectId: null, collectionId: folder, collectionIds: null, q: null, limit: 50, offset: 0 });
    const items = listedItems(listed);
    expect(items.map((item) => item.id)).toEqual([first.id, second.id, third.id]);
    expect(items.map((item) => placementOrder(item, folder))).toEqual([0, 1, 2]);
  });

  it("appends a note moved into a different folder after that folder's existing notes", async () => {
    if (!db.available || !app) return;
    const identity = { spaceId: SPACE, userId: USER };
    const repository = new PgKnowledgeRepository(db.pool);
    const source = await insertNoteCollection(db.pool, { space: SPACE, name: "Source" });
    const target = await insertNoteCollection(db.pool, { space: SPACE, name: "Target" });

    await repository.createNote(identity, { title: "Already there", collection_id: target });
    const moved = await repository.createNote(identity, { title: "Moved note", collection_id: source }) as { id: string };
    await repository.updateNote(identity, moved.id, { collection_id: target });

    const listed = await repository.listNotes(identity, { status: null, projectId: null, collectionId: target, collectionIds: null, q: null, limit: 50, offset: 0 });
    const items = listedItems(listed);
    const last = items[items.length - 1]!;
    expect(last.id).toBe(moved.id);
    expect(placementOrder(last, target)).toBe(1);
  });

  it("repositions a note within its current folder without changing which folder it's in", async () => {
    if (!db.available || !app) return;
    const identity = { spaceId: SPACE, userId: USER };
    const repository = new PgKnowledgeRepository(db.pool);
    const folder = await insertNoteCollection(db.pool, { space: SPACE, name: "Folder" });
    const a = await repository.createNote(identity, { title: "A", collection_id: folder }) as { id: string };
    const b = await repository.createNote(identity, { title: "B", collection_id: folder }) as { id: string };

    const before = await db.pool.query<{ id: string; updated_at: Date }>(
      `SELECT id, updated_at FROM space_objects WHERE id = ANY($1::varchar[]) ORDER BY id`,
      [[a.id, b.id]],
    );

    // Move "B" (currently sort_order 1) to the front, ahead of "A" in one
    // transaction, without turning the reorder into a content update.
    const result = await withTransaction(db.pool, (client) =>
      persistNotesTreeReorder(client, identity, {
        kind: "notes",
        updates: [
          { noteId: b.id, fromCollectionId: folder, collectionId: folder, sortOrder: 0 },
          { noteId: a.id, fromCollectionId: folder, collectionId: folder, sortOrder: 1 },
        ],
      }),
    );

    const listed = await repository.listNotes(identity, { status: null, projectId: null, collectionId: folder, collectionIds: null, q: null, limit: 50, offset: 0 });
    const items = (listed as { items: Array<{ id: string }> }).items;
    expect(result).toEqual({ kind: "notes", updated: 2 });
    expect(items.map((item) => item.id)).toEqual([b.id, a.id]);
    const after = await db.pool.query<{ id: string; updated_at: Date }>(
      `SELECT id, updated_at FROM space_objects WHERE id = ANY($1::varchar[]) ORDER BY id`,
      [[a.id, b.id]],
    );
    expect(after.rows).toEqual(before.rows);
  });

  it("rolls back the complete reorder when any destination collection is invalid", async () => {
    if (!db.available || !app) return;
    const identity = { spaceId: SPACE, userId: USER };
    const repository = new PgKnowledgeRepository(db.pool);
    const folder = await insertNoteCollection(db.pool, { space: SPACE, name: "Folder" });
    const a = await repository.createNote(identity, { title: "A", collection_id: folder }) as { id: string };
    const b = await repository.createNote(identity, { title: "B", collection_id: folder }) as { id: string };

    await expect(withTransaction(db.pool, (client) =>
      persistNotesTreeReorder(client, identity, {
        kind: "notes",
        updates: [
          { noteId: b.id, fromCollectionId: folder, collectionId: folder, sortOrder: 0 },
          { noteId: a.id, fromCollectionId: folder, collectionId: randomUUID(), sortOrder: 0 },
        ],
      }),
    )).rejects.toMatchObject({ statusCode: 404 });

    const listed = await repository.listNotes(identity, { status: null, projectId: null, collectionId: folder, collectionIds: null, q: null, limit: 50, offset: 0 });
    const items = listedItems(listed);
    expect(items.map((item) => [item.id, placementOrder(item, folder)])).toEqual([
      [a.id, 0],
      [b.id, 1],
    ]);
  });

  it("persists a complete reorder through one public API request", async () => {
    if (!db.available || !app) return;
    const identity = { spaceId: SPACE, userId: USER };
    const repository = new PgKnowledgeRepository(db.pool);
    const folder = await insertNoteCollection(db.pool, { space: SPACE, name: "Folder" });
    const a = await repository.createNote(identity, { title: "A", collection_id: folder }) as { id: string };
    const b = await repository.createNote(identity, { title: "B", collection_id: folder }) as { id: string };

    const response = await app.inject({
      method: "PATCH",
      url: "/api/v1/knowledge/notes/tree/reorder",
      payload: {
        kind: "notes",
        updates: [
          { note_id: b.id, from_collection_id: folder, collection_id: folder, sort_order: 0 },
          { note_id: a.id, from_collection_id: folder, collection_id: folder, sort_order: 1 },
        ],
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ kind: "notes", updated: 2 });
    const listed = await repository.listNotes(identity, { status: null, projectId: null, collectionId: folder, collectionIds: null, q: null, limit: 50, offset: 0 });
    expect((listed as { items: Array<{ id: string }> }).items.map((item) => item.id)).toEqual([b.id, a.id]);
  });

  it("rejects ambiguous duplicate positions at the API boundary", async () => {
    if (!db.available || !app) return;
    const collectionId = randomUUID();
    const response = await app.inject({
      method: "PATCH",
      url: "/api/v1/knowledge/notes/tree/reorder",
      payload: {
        kind: "notes",
        updates: [
          { id: randomUUID(), collection_id: collectionId, sort_order: 0 },
          { id: randomUUID(), collection_id: collectionId, sort_order: 0 },
        ],
      },
    });

    expect(response.statusCode).toBe(422);
  });

  it("persists folder ordering through the shared tree reorder API", async () => {
    if (!db.available || !app) return;
    const first = await insertNoteCollection(db.pool, { space: SPACE, name: "First" });
    const second = await insertNoteCollection(db.pool, { space: SPACE, name: "Second" });

    const response = await app.inject({
      method: "PATCH",
      url: "/api/v1/knowledge/notes/tree/reorder",
      payload: {
        kind: "collections",
        updates: [
          { id: second, parent_id: first, sort_order: 0 },
          { id: first, parent_id: null, sort_order: 0 },
        ],
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ kind: "collections", updated: 2 });
    const rows = await db.pool.query<{ id: string; parent_id: string | null; sort_order: number }>(
      `SELECT id,parent_id,sort_order FROM note_collections WHERE id = ANY($1::varchar[]) ORDER BY id`,
      [[first, second]],
    );
    expect(rows.rows).toEqual(expect.arrayContaining([
      { id: first, parent_id: null, sort_order: 0 },
      { id: second, parent_id: first, sort_order: 0 },
    ]));
  });
});
