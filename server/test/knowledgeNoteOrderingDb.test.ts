import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { loadConfig } from "../src/config";
import { migrate } from "../src/db/migrator";
import { withTransaction } from "../src/db/tx";
import { __setAuthIdentityForTests } from "../src/modules/auth/identity";
import { persistNotesTreeReorder } from "../src/modules/knowledge/notesTreeReorder";
import { PgKnowledgeRepository } from "../src/modules/knowledge/repository";
import { buildServer } from "../src/server";
import { getTestPostgres, isTestPostgresUnavailableError, type TestPostgresDatabase } from "./support/sharedPostgres";

// note_collection_items.sort_order existed in the schema before this but was
// always written as a hardcoded 0 and never read for display order — notes
// were always shown newest-updated-first. This covers making that column
// meaningful: append-on-create/move, and explicit repositioning for drag
// reordering within a folder.

const SPACE = "11111111-1111-4111-8111-111111111111";
const USER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

let database: TestPostgresDatabase | undefined;
let pool: Pool | undefined;
let app: FastifyInstance | undefined;
let available = false;

beforeAll(async () => {
  try {
    database = await getTestPostgres(__filename);
    pool = new Pool({ connectionString: database.getConnectionUri(), max: 2 });
    await migrate(pool, join(process.cwd(), "migrations"));
    __setAuthIdentityForTests({ spaceId: SPACE, userId: USER });
    app = buildServer(loadConfig({
      SERVER_DATABASE_URL: database.getConnectionUri(),
      SERVER_INTERNAL_TOKEN: "test-internal-token",
      AGENT_SPACE_HOME: "/tmp/agent-space-note-ordering-test",
    }), { logger: false });
    available = true;
  } catch (error) {
    if (!isTestPostgresUnavailableError(error)) throw error;
    console.warn(`[knowledge-note-ordering-db] skipped — Docker/Postgres unavailable: ${error instanceof Error ? error.message : String(error)}`);
  }
}, 180_000);

afterAll(async () => {
  __setAuthIdentityForTests(null);
  await app?.close();
  await pool?.end();
  await database?.stop();
});

beforeEach(async () => {
  if (!available || !pool) return;
  await pool.query(`TRUNCATE notes, note_collections, note_collection_items, space_objects, space_memberships, users, spaces CASCADE`);
  const now = new Date().toISOString();
  await pool.query(`INSERT INTO spaces (id,name,type,created_at,updated_at) VALUES ($1,'Space','personal',$2,$2)`, [SPACE, now]);
  await pool.query(`INSERT INTO users (id,display_name,status,created_at,updated_at) VALUES ($1,'Owner','active',$2,$2)`, [USER, now]);
  await pool.query(`INSERT INTO space_memberships (id,space_id,user_id,role,status,created_at,updated_at) VALUES ($1,$2,$3,'owner','active',$4,$4)`, [randomUUID(), SPACE, USER, now]);
});

async function makeFolder(name: string): Promise<string> {
  const id = randomUUID();
  const now = new Date().toISOString();
  await pool!.query(
    `INSERT INTO note_collections (id,space_id,parent_id,name,system_role,sort_order,is_system,is_hidden,created_at,updated_at)
     VALUES ($1,$2,NULL,$3,'normal',0,false,false,$4,$4)`,
    [id, SPACE, name, now],
  );
  return id;
}

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
    if (!available || !pool) return;
    const identity = { spaceId: SPACE, userId: USER };
    const repository = new PgKnowledgeRepository(pool);
    const folder = await makeFolder("Folder");

    const first = await repository.createNote(identity, { title: "First", collection_id: folder });
    const second = await repository.createNote(identity, { title: "Second", collection_id: folder });
    const third = await repository.createNote(identity, { title: "Third", collection_id: folder });

    const listed = await repository.listNotes(identity, { status: null, projectId: null, collectionId: folder, collectionIds: null, q: null, limit: 50, offset: 0 });
    const items = listedItems(listed);
    expect(items.map((item) => item.id)).toEqual([first.id, second.id, third.id]);
    expect(items.map((item) => placementOrder(item, folder))).toEqual([0, 1, 2]);
  });

  it("appends a note moved into a different folder after that folder's existing notes", async () => {
    if (!available || !pool) return;
    const identity = { spaceId: SPACE, userId: USER };
    const repository = new PgKnowledgeRepository(pool);
    const source = await makeFolder("Source");
    const target = await makeFolder("Target");

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
    if (!available || !pool) return;
    const identity = { spaceId: SPACE, userId: USER };
    const repository = new PgKnowledgeRepository(pool);
    const folder = await makeFolder("Folder");
    const a = await repository.createNote(identity, { title: "A", collection_id: folder }) as { id: string };
    const b = await repository.createNote(identity, { title: "B", collection_id: folder }) as { id: string };

    const before = await pool.query<{ id: string; updated_at: Date }>(
      `SELECT id, updated_at FROM space_objects WHERE id = ANY($1::varchar[]) ORDER BY id`,
      [[a.id, b.id]],
    );

    // Move "B" (currently sort_order 1) to the front, ahead of "A" in one
    // transaction, without turning the reorder into a content update.
    const result = await withTransaction(pool, (client) =>
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
    const after = await pool.query<{ id: string; updated_at: Date }>(
      `SELECT id, updated_at FROM space_objects WHERE id = ANY($1::varchar[]) ORDER BY id`,
      [[a.id, b.id]],
    );
    expect(after.rows).toEqual(before.rows);
  });

  it("rolls back the complete reorder when any destination collection is invalid", async () => {
    if (!available || !pool) return;
    const identity = { spaceId: SPACE, userId: USER };
    const repository = new PgKnowledgeRepository(pool);
    const folder = await makeFolder("Folder");
    const a = await repository.createNote(identity, { title: "A", collection_id: folder }) as { id: string };
    const b = await repository.createNote(identity, { title: "B", collection_id: folder }) as { id: string };

    await expect(withTransaction(pool, (client) =>
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
    if (!available || !pool || !app) return;
    const identity = { spaceId: SPACE, userId: USER };
    const repository = new PgKnowledgeRepository(pool);
    const folder = await makeFolder("Folder");
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
    if (!available || !app) return;
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
    if (!available || !pool || !app) return;
    const first = await makeFolder("First");
    const second = await makeFolder("Second");

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
    const rows = await pool.query<{ id: string; parent_id: string | null; sort_order: number }>(
      `SELECT id,parent_id,sort_order FROM note_collections WHERE id = ANY($1::varchar[]) ORDER BY id`,
      [[first, second]],
    );
    expect(rows.rows).toEqual(expect.arrayContaining([
      { id: first, parent_id: null, sort_order: 0 },
      { id: second, parent_id: first, sort_order: 0 },
    ]));
  });
});
