import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config";
import { withTransaction } from "../src/db/tx";
import { __setAuthIdentityForTests } from "../src/modules/auth/identity";
import { persistNotesTreeReorder } from "../src/modules/knowledge/notesTreeReorder";
import { PgKnowledgeRepository } from "../src/modules/knowledge/repository";
import { buildModuleServer } from "./support/moduleServer";
import { knowledgeModule } from "../src/modules/knowledge";
import { useTestDatabase } from "./support/testDatabase";
import { resetTables } from "./support/resetTables";

/**
 * Multi-placement (U5). `note_collection_items` is unique on
 * `(collection_id, note_id, space_id)`, so the schema has always allowed a note
 * to sit in several folders — the reads collapsed it to the first one and the
 * reorder matched on `note_id` alone, so moving one placement rewrote them all.
 * These tests are the reason that cannot come back.
 */

const SPACE = "11111111-1111-4111-8111-111111111111";
const USER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OTHER_USER = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

let app: FastifyInstance | undefined;

const db = useTestDatabase(__filename, { max: 2 });

beforeAll(async () => {
  if (!db.available || !app) return;
  __setAuthIdentityForTests({ spaceId: SPACE, userId: USER });
  app = buildModuleServer(loadConfig({
    SERVER_DATABASE_URL: db.connectionUri,
    SERVER_INTERNAL_TOKEN: "test-internal-token",
    AGENT_SPACE_HOME: "/tmp/agent-space-note-placement-test",
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
  await db.pool.query(`INSERT INTO users (id,display_name,status,created_at,updated_at) VALUES ($1,'Member','active',$2,$2)`, [OTHER_USER, now]);
  await db.pool.query(`INSERT INTO space_memberships (id,space_id,user_id,role,status,created_at,updated_at) VALUES ($1,$2,$3,'member','active',$4,$4)`, [randomUUID(), SPACE, OTHER_USER, now]);
});

const identity = { spaceId: SPACE, userId: USER };

interface Placement { collection_id: string; sort_order: number }

async function makeFolder(name: string): Promise<string> {
  const id = randomUUID();
  const now = new Date().toISOString();
  await db.pool.query(
    `INSERT INTO note_collections (id,space_id,parent_id,name,system_role,sort_order,is_system,is_hidden,created_at,updated_at)
     VALUES ($1,$2,NULL,$3,'normal',0,false,false,$4,$4)`,
    [id, SPACE, name, now],
  );
  return id;
}

function placements(note: unknown): Placement[] {
  return (note as { placements: Placement[] }).placements;
}

function orderIn(note: unknown, collectionId: string): number | undefined {
  return placements(note).find((placement) => placement.collection_id === collectionId)?.sort_order;
}

describe("note placements (real Postgres)", () => {
  it("reports every folder a note is placed in", async () => {
    if (!db.available || !app) return;
    const repository = new PgKnowledgeRepository(db.pool);
    const first = await makeFolder("First");
    const second = await makeFolder("Second");
    const note = await repository.createNote(identity, { title: "Shared", collection_id: first }) as { id: string };

    await repository.addNotePlacement(identity, note.id, second);

    const read = await repository.getNote(identity, note.id);
    expect(placements(read).map((placement) => placement.collection_id).sort())
      .toEqual([first, second].sort());
  });

  it("reorders one placement without disturbing the note's other placement", async () => {
    if (!db.available || !app) return;
    const repository = new PgKnowledgeRepository(db.pool);
    const first = await makeFolder("First");
    const second = await makeFolder("Second");
    const shared = await repository.createNote(identity, { title: "Shared", collection_id: first }) as { id: string };
    const other = await repository.createNote(identity, { title: "Other", collection_id: first }) as { id: string };
    await repository.addNotePlacement(identity, shared.id, second);
    const before = orderIn(await repository.getNote(identity, shared.id), second);

    // Move the shared note to the front of `first`. Its placement in `second`
    // must be untouched — the previous UPDATE matched on note_id alone and
    // dragged that row into `first` too.
    await withTransaction(db.pool, (client) => persistNotesTreeReorder(client, identity, {
      kind: "notes",
      updates: [
        { noteId: shared.id, fromCollectionId: first, collectionId: first, sortOrder: 0 },
        { noteId: other.id, fromCollectionId: first, collectionId: first, sortOrder: 1 },
      ],
    }));

    const read = await repository.getNote(identity, shared.id);
    expect(placements(read)).toHaveLength(2);
    expect(orderIn(read, first)).toBe(0);
    expect(orderIn(read, second)).toBe(before);
  });

  it("moves only the addressed placement when a note is dragged between folders", async () => {
    if (!db.available || !app) return;
    const repository = new PgKnowledgeRepository(db.pool);
    const first = await makeFolder("First");
    const second = await makeFolder("Second");
    const third = await makeFolder("Third");
    const note = await repository.createNote(identity, { title: "Shared", collection_id: first }) as { id: string };
    await repository.addNotePlacement(identity, note.id, second);

    await withTransaction(db.pool, (client) => persistNotesTreeReorder(client, identity, {
      kind: "notes",
      updates: [{ noteId: note.id, fromCollectionId: first, collectionId: third, sortOrder: 0 }],
    }));

    const read = await repository.getNote(identity, note.id);
    expect(placements(read).map((placement) => placement.collection_id).sort())
      .toEqual([second, third].sort());
  });

  it("refuses a reorder that names a folder the note is not placed in", async () => {
    if (!db.available || !app) return;
    const repository = new PgKnowledgeRepository(db.pool);
    const first = await makeFolder("First");
    const elsewhere = await makeFolder("Elsewhere");
    const note = await repository.createNote(identity, { title: "Only here", collection_id: first }) as { id: string };

    await expect(withTransaction(db.pool, (client) => persistNotesTreeReorder(client, identity, {
      kind: "notes",
      updates: [{ noteId: note.id, fromCollectionId: elsewhere, collectionId: elsewhere, sortOrder: 0 }],
    }))).rejects.toMatchObject({ statusCode: 404 });

    expect(placements(await repository.getNote(identity, note.id)))
      .toEqual([{ collection_id: first, sort_order: 0 }]);
  });

  it("rejects placing a note twice in the same folder", async () => {
    if (!db.available || !app) return;
    const repository = new PgKnowledgeRepository(db.pool);
    const folder = await makeFolder("Folder");
    const note = await repository.createNote(identity, { title: "Note", collection_id: folder }) as { id: string };

    await expect(repository.addNotePlacement(identity, note.id, folder))
      .rejects.toMatchObject({ statusCode: 409 });
  });

  it("removes a placement but refuses to remove the last one", async () => {
    if (!db.available || !app) return;
    const repository = new PgKnowledgeRepository(db.pool);
    const first = await makeFolder("First");
    const second = await makeFolder("Second");
    const note = await repository.createNote(identity, { title: "Note", collection_id: first }) as { id: string };
    await repository.addNotePlacement(identity, note.id, second);

    const afterRemove = await repository.removeNotePlacement(identity, note.id, first);
    expect(placements(afterRemove)).toEqual([{ collection_id: second, sort_order: 0 }]);

    // Taking a note out of its last folder is deleting it, which is a different
    // decision with its own action.
    await expect(repository.removeNotePlacement(identity, note.id, second))
      .rejects.toMatchObject({ statusCode: 422 });
    expect(placements(await repository.getNote(identity, note.id))).toHaveLength(1);
  });

  it("carries both placement actions through the public routes", async () => {
    if (!db.available || !app) return;
    const repository = new PgKnowledgeRepository(db.pool);
    const first = await makeFolder("First");
    const second = await makeFolder("Second");
    const note = await repository.createNote(identity, { title: "Note", collection_id: first }) as { id: string };

    const added = await app.inject({
      method: "POST",
      url: `/api/v1/knowledge/notes/${note.id}/placements`,
      payload: { collection_id: second },
    });
    expect(added.statusCode).toBe(201);
    expect(placements(added.json())).toHaveLength(2);

    const removed = await app.inject({
      method: "DELETE",
      url: `/api/v1/knowledge/notes/${note.id}/placements/${first}`,
    });
    expect(removed.statusCode).toBe(200);
    expect(placements(removed.json())).toEqual([{ collection_id: second, sort_order: 0 }]);
  });

  /**
   * The placement rows carry no access of their own, so a reorder that checked
   * only that they exist would let any Space member rearrange notes they cannot
   * open. The gate has to come from the note's `space_objects` row.
   */
  it("refuses to reorder a placement of a note the caller cannot read", async () => {
    if (!db.available || !app) return;
    const repository = new PgKnowledgeRepository(db.pool);
    const first = await makeFolder("First");
    const second = await makeFolder("Second");
    const mine = await repository.createNote(identity, { title: "Private", collection_id: first }) as { id: string };
    await db.pool.query(`UPDATE space_objects SET visibility = 'private' WHERE id = $1`, [mine.id]);

    const stranger = { spaceId: SPACE, userId: OTHER_USER };
    await expect(withTransaction(db.pool, (client) => persistNotesTreeReorder(client, stranger, {
      kind: "notes",
      updates: [{ noteId: mine.id, fromCollectionId: first, collectionId: second, sortOrder: 0 }],
    }))).rejects.toMatchObject({ statusCode: 404 });

    expect(placements(await repository.getNote(identity, mine.id)))
      .toEqual([{ collection_id: first, sort_order: 0 }]);

    // The owner is unaffected — the refusal is about who is asking.
    await withTransaction(db.pool, (client) => persistNotesTreeReorder(client, identity, {
      kind: "notes",
      updates: [{ noteId: mine.id, fromCollectionId: first, collectionId: second, sortOrder: 0 }],
    }));
    expect(placements(await repository.getNote(identity, mine.id)))
      .toEqual([{ collection_id: second, sort_order: 0 }]);
  });
});
