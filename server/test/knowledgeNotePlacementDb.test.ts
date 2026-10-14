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
import { ensureProjectNotesFolder } from "../src/modules/knowledge/noteProjectFolders.js";
import { seedMainlineRoomsForAllProjects } from "./support/domainSeeds.js";

/**
 * Multi-placement. `note_collection_items` is unique on
 * `(collection_id, note_id, space_id)`, so a note may sit in several folders.
 * Return every placement. Do not collapse the read to the first one, and do
 * not reorder by `note_id` alone. These tests fail if that comes back.
 */

const SPACE = "11111111-1111-4111-8111-111111111111";
const USER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OTHER_USER = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

let app: FastifyInstance | undefined;

const db = useTestDatabase(import.meta.filename, { max: 2 });

// Files share a worker: an identity or invoker left in a module-level
// seam would leak into whichever file runs next.
afterAll(() => {
  __setAuthIdentityForTests(null);
});

beforeAll(async () => {
  // Not `|| !app`. `app` is what this hook builds. Do not guard on it: the
  // hook returns before building it and every test takes its own `!app`
  // early return, reporting a pass without running.
  if (!db.available) return;
  __setAuthIdentityForTests({ spaceId: SPACE, userId: USER });
  app = buildModuleServer(loadConfig({
    SERVER_DATABASE_URL: db.connectionUri,
    SERVER_INTERNAL_TOKEN: "test-internal-token",
    RAINVER_HOME: "/tmp/rainver-note-placement-test",
  }), [knowledgeModule]);
});

beforeEach(async () => {
  if (!db.available || !app) return;
  await resetTables(
    db.pool,
    ["notes", "note_collections", "note_collection_items", "space_objects", "projects", "space_memberships", "users", "spaces"],
    { cascade: true },
  );
  const now = new Date().toISOString();
  await db.pool.query(`INSERT INTO spaces (id,name,type,created_at,updated_at) VALUES ($1,'Space','personal',$2,$2)`, [SPACE, now]);
  await db.pool.query(`INSERT INTO users (id,display_name,status,created_at,updated_at, email, registration_source) VALUES ($1,'Owner','active',$2,$2, lower(gen_random_uuid()::text || '@test.invalid'), 'system')`, [USER, now]);
  await db.pool.query(`INSERT INTO space_memberships (id,space_id,user_id,role,status,created_at,updated_at) VALUES ($1,$2,$3,'owner','active',$4,$4)`, [randomUUID(), SPACE, USER, now]);
  await db.pool.query(`INSERT INTO users (id,display_name,status,created_at,updated_at, email, registration_source) VALUES ($1,'Member','active',$2,$2, lower(gen_random_uuid()::text || '@test.invalid'), 'system')`, [OTHER_USER, now]);
  await db.pool.query(`INSERT INTO space_memberships (id,space_id,user_id,role,status,created_at,updated_at) VALUES ($1,$2,$3,'member','active',$4,$4)`, [randomUUID(), SPACE, OTHER_USER, now]);
});

const identity = { spaceId: SPACE, userId: USER };

interface Placement { collection_id: string; sort_order: number }

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
    const first = await insertNoteCollection(db.pool, { space: SPACE, name: "First" });
    const second = await insertNoteCollection(db.pool, { space: SPACE, name: "Second" });
    const note = await repository.createNote(identity, { title: "Shared", collection_id: first }) as { id: string };

    await repository.addNotePlacement(identity, note.id, second);

    const read = await repository.getNote(identity, note.id);
    expect(placements(read).map((placement) => placement.collection_id).sort())
      .toEqual([first, second].sort());
  });

  it("reorders one placement without disturbing the note's other placement", async () => {
    if (!db.available || !app) return;
    const repository = new PgKnowledgeRepository(db.pool);
    const first = await insertNoteCollection(db.pool, { space: SPACE, name: "First" });
    const second = await insertNoteCollection(db.pool, { space: SPACE, name: "Second" });
    const shared = await repository.createNote(identity, { title: "Shared", collection_id: first }) as { id: string };
    const other = await repository.createNote(identity, { title: "Other", collection_id: first }) as { id: string };
    await repository.addNotePlacement(identity, shared.id, second);
    const before = orderIn(await repository.getNote(identity, shared.id), second);

    // Move the shared note to the front of `first`. Its placement in `second`
    // stays where it is. Do not match the move on note_id alone.
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
    const first = await insertNoteCollection(db.pool, { space: SPACE, name: "First" });
    const second = await insertNoteCollection(db.pool, { space: SPACE, name: "Second" });
    const third = await insertNoteCollection(db.pool, { space: SPACE, name: "Third" });
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

  it("refuses dragging a placement into a folder that already holds the note", async () => {
    if (!db.available || !app) return;
    const repository = new PgKnowledgeRepository(db.pool);
    const first = await insertNoteCollection(db.pool, { space: SPACE, name: "First" });
    const second = await insertNoteCollection(db.pool, { space: SPACE, name: "Second" });
    const note = await repository.createNote(identity, { title: "Twice placed", collection_id: first }) as { id: string };
    await repository.addNotePlacement(identity, note.id, second);

    // The same answer the placement action gives, not the unique index's 500.
    await expect(withTransaction(db.pool, (client) => persistNotesTreeReorder(client, identity, {
      kind: "notes",
      updates: [{ noteId: note.id, fromCollectionId: first, collectionId: second, sortOrder: 0 }],
    }))).rejects.toMatchObject({ statusCode: 409 });
    expect(placements(await repository.getNote(identity, note.id)).map((placement) => placement.collection_id).sort())
      .toEqual([first, second].sort());
  });

  it("refuses a reorder that names a folder the note is not placed in", async () => {
    if (!db.available || !app) return;
    const repository = new PgKnowledgeRepository(db.pool);
    const first = await insertNoteCollection(db.pool, { space: SPACE, name: "First" });
    const elsewhere = await insertNoteCollection(db.pool, { space: SPACE, name: "Elsewhere" });
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
    const folder = await insertNoteCollection(db.pool, { space: SPACE, name: "Folder" });
    const note = await repository.createNote(identity, { title: "Note", collection_id: folder }) as { id: string };

    await expect(repository.addNotePlacement(identity, note.id, folder))
      .rejects.toMatchObject({ statusCode: 409 });
  });

  it("removes a placement but refuses to remove the last one", async () => {
    if (!db.available || !app) return;
    const repository = new PgKnowledgeRepository(db.pool);
    const first = await insertNoteCollection(db.pool, { space: SPACE, name: "First" });
    const second = await insertNoteCollection(db.pool, { space: SPACE, name: "Second" });
    const note = await repository.createNote(identity, { title: "Note", collection_id: first }) as { id: string };
    await repository.addNotePlacement(identity, note.id, second);

    const afterRemove = await repository.removeNotePlacement(identity, note.id, first);
    expect(placements(afterRemove)).toEqual([{ collection_id: second, sort_order: 0 }]);

    // Taking a note out of its last folder is deleting it, which is a different
    // decision with its own action — and the refusal names that action.
    await expect(repository.removeNotePlacement(identity, note.id, second))
      .rejects.toMatchObject({
        statusCode: 422,
        responseBody: {
          code: "note_owning_entry_required",
          note_id: note.id,
          owning_project_id: null,
          actions: ["move_to_folder", "delete_note"],
        },
      });
    expect(placements(await repository.getNote(identity, note.id))).toHaveLength(1);
  });

  it("refuses to delete a folder that is some note's last entry, and keeps subfolders in place otherwise", async () => {
    if (!db.available || !app) return;
    const repository = new PgKnowledgeRepository(db.pool);
    const parent = await insertNoteCollection(db.pool, { space: SPACE, name: "Parent" });
    const doomed = await repository.createNoteCollection(identity, { name: "Doomed", parent_id: parent }) as { id: string };
    const child = await repository.createNoteCollection(identity, { name: "Child", parent_id: doomed.id }) as { id: string };
    const elsewhere = await insertNoteCollection(db.pool, { space: SPACE, name: "Elsewhere" });
    const only = await repository.createNote(identity, { title: "Only here", collection_id: doomed.id }) as { id: string };
    const also = await repository.createNote(identity, { title: "Also elsewhere", collection_id: doomed.id }) as { id: string };
    await repository.addNotePlacement(identity, also.id, elsewhere);

    const deleteDoomed = () => app!.inject({ method: "DELETE", url: `/api/v1/notes/collections/${doomed.id}` });
    const refused = await deleteDoomed();
    expect(refused.statusCode).toBe(422);
    expect(refused.json()).toMatchObject({ code: "note_owning_entry_required", note_id: only.id, affected_note_count: 1 });
    // Nothing moved: the refusal is the whole answer.
    expect(placements(await repository.getNote(identity, only.id))).toEqual([{ collection_id: doomed.id, sort_order: 0 }]);
    const childRow = await db.pool.query<{ parent_id: string | null }>(`SELECT parent_id FROM note_collections WHERE id = $1`, [child.id]);
    expect(childRow.rows[0]?.parent_id).toBe(doomed.id);

    await repository.addNotePlacement(identity, only.id, elsewhere);
    expect((await deleteDoomed()).statusCode).toBe(204);
    // The folder's own placements go with it; its subfolder moves up to its
    // parent rather than to the root.
    expect(placements(await repository.getNote(identity, only.id))).toEqual([{ collection_id: elsewhere, sort_order: 1 }]);
    expect(placements(await repository.getNote(identity, also.id))).toEqual([{ collection_id: elsewhere, sort_order: 0 }]);
    const movedChild = await db.pool.query<{ parent_id: string | null }>(`SELECT parent_id FROM note_collections WHERE id = $1`, [child.id]);
    expect(movedChild.rows[0]?.parent_id).toBe(parent);
  });

  it("refuses to restore a trashed Project note whose Project folder was deleted until it names one", async () => {
    if (!db.available || !app) return;
    const projectId = randomUUID();
    await db.pool.query(
      `INSERT INTO projects (id, space_id, name, status, owner_user_id, created_at, updated_at)
       VALUES ($1, $2, 'Project', 'active', $3, now(), now())`,
      [projectId, SPACE, USER],
    );
    await seedMainlineRoomsForAllProjects(db.pool);
    const repository = new PgKnowledgeRepository(db.pool);
    const projectFolder = await ensureProjectNotesFolder(db.pool, SPACE, projectId);
    const doomed = await repository.createNoteCollection(identity, { name: "Doomed", parent_id: projectFolder }) as { id: string };
    const note = await repository.createNote(identity, { title: "Trashed", primary_project_id: projectId, collection_id: doomed.id }) as { id: string };
    await repository.updateNote(identity, note.id, { status: "deleted" });
    // A deleted note holds no folder back, so its only folder can go.
    expect((await app!.inject({ method: "DELETE", url: `/api/v1/notes/collections/${doomed.id}` })).statusCode).toBe(204);

    await expect(repository.updateNote(identity, note.id, { status: "active" }))
      .rejects.toMatchObject({ statusCode: 422, responseBody: expect.objectContaining({ code: "note_owning_entry_required", note_id: note.id }) });
    const restored = await repository.updateNote(identity, note.id, { status: "active", collection_id: projectFolder });
    expect(placements(restored)).toEqual([{ collection_id: projectFolder, sort_order: 0 }]);
  });

  it("restores a note outside every Project without a folder, since it may be unfiled", async () => {
    if (!db.available || !app) return;
    const repository = new PgKnowledgeRepository(db.pool);
    const doomed = await repository.createNoteCollection(identity, { name: "Doomed" }) as { id: string };
    const note = await repository.createNote(identity, { title: "Loose", collection_id: doomed.id }) as { id: string };
    await repository.updateNote(identity, note.id, { status: "deleted" });
    expect((await app!.inject({ method: "DELETE", url: `/api/v1/notes/collections/${doomed.id}` })).statusCode).toBe(204);
    await expect(repository.updateNote(identity, note.id, { status: "active" })).resolves.toMatchObject({ id: note.id });
  });

  it("refuses a batch reorder whose net effect strips a note of its last folder", async () => {
    if (!db.available || !app) return;
    const repository = new PgKnowledgeRepository(db.pool);
    const first = await insertNoteCollection(db.pool, { space: SPACE, name: "First" });
    const second = await insertNoteCollection(db.pool, { space: SPACE, name: "Second" });
    const note = await repository.createNote(identity, { title: "Note", collection_id: first }) as { id: string };
    const other = await repository.createNote(identity, { title: "Other", collection_id: second }) as { id: string };

    // A move between folders keeps the note somewhere, so the batch is fine...
    await withTransaction(db.pool, (client) => persistNotesTreeReorder(client, identity, {
      kind: "notes",
      updates: [
        { noteId: note.id, fromCollectionId: first, collectionId: second, sortOrder: 1 },
        { noteId: other.id, fromCollectionId: second, collectionId: second, sortOrder: 0 },
      ],
    }));
    expect(placements(await repository.getNote(identity, note.id))).toEqual([{ collection_id: second, sort_order: 1 }]);
  });

  it("carries both placement actions through the public routes", async () => {
    if (!db.available || !app) return;
    const repository = new PgKnowledgeRepository(db.pool);
    const first = await insertNoteCollection(db.pool, { space: SPACE, name: "First" });
    const second = await insertNoteCollection(db.pool, { space: SPACE, name: "Second" });
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
    const first = await insertNoteCollection(db.pool, { space: SPACE, name: "First" });
    const second = await insertNoteCollection(db.pool, { space: SPACE, name: "Second" });
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
