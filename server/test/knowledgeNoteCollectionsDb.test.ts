import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { migrate } from "../src/db/migrator";
import { withTransaction } from "../src/db/tx";
import { persistNotesTreeReorder } from "../src/modules/knowledge/notesTreeReorder";
import { PgKnowledgeRepository } from "../src/modules/knowledge/repository";
import { getTestPostgres, type TestPostgresDatabase } from "./support/sharedPostgres";

// Fixed workspace roots remain immovable at the server boundary. Project-backed
// folders are different: they retain protected destructive actions but can be
// reparented so legacy projects can be organized under the Projects root.

const SPACE = "11111111-1111-4111-8111-111111111111";
const USER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

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
    console.warn(`[knowledge-note-collections-db] skipped — Docker/Postgres unavailable: ${error instanceof Error ? error.message : String(error)}`);
  }
}, 180_000);

afterAll(async () => {
  await pool?.end();
  await database?.stop();
});

beforeEach(async () => {
  if (!available || !pool) return;
  await pool.query(`TRUNCATE note_collections, space_memberships, users, spaces CASCADE`);
  const now = new Date().toISOString();
  await pool.query(`INSERT INTO spaces (id,name,type,created_at,updated_at) VALUES ($1,'Space','personal',$2,$2)`, [SPACE, now]);
  await pool.query(`INSERT INTO users (id,display_name,status,created_at,updated_at) VALUES ($1,'Owner','active',$2,$2)`, [USER, now]);
  await pool.query(`INSERT INTO space_memberships (id,space_id,user_id,role,status,created_at,updated_at) VALUES ($1,$2,$3,'owner','active',$4,$4)`, [randomUUID(), SPACE, USER, now]);
});

describe("PgKnowledgeRepository note collections (real Postgres)", () => {
  it("creates with a stable client id and appends after existing siblings", async () => {
    if (!available || !pool) return;
    const identity = { spaceId: SPACE, userId: USER };
    const repository = new PgKnowledgeRepository(pool);
    const now = new Date().toISOString();
    const existingId = randomUUID();
    const createdId = randomUUID();
    await pool.query(
      `INSERT INTO note_collections (id,space_id,parent_id,name,system_role,sort_order,is_system,is_hidden,created_at,updated_at)
       VALUES ($1,$2,NULL,'Zulu','normal',7,false,false,$3,$3)`,
      [existingId, SPACE, now],
    );

    await expect(repository.createNoteCollection(identity, {
      id: createdId,
      name: "Alpha",
      parent_id: null,
    })).resolves.toMatchObject({
      id: createdId,
      name: "Alpha",
      parent_id: null,
      sort_order: 8,
    });

    const listed = await repository.listNoteCollections(identity);
    expect(listed.map(collection => collection.id)).toEqual([existingId, createdId]);
  });

  it("rejects reparenting a system folder even though the PATCH route accepts any body", async () => {
    if (!available || !pool) return;
    const identity = { spaceId: SPACE, userId: USER };
    const repository = new PgKnowledgeRepository(pool);
    const now = new Date().toISOString();
    const inboxId = randomUUID();
    const otherId = randomUUID();
    await pool.query(
      `INSERT INTO note_collections (id,space_id,parent_id,name,system_role,sort_order,is_system,is_hidden,created_at,updated_at)
       VALUES ($1,$2,NULL,'Inbox','inbox',0,true,false,$3,$3)`,
      [inboxId, SPACE, now],
    );
    await pool.query(
      `INSERT INTO note_collections (id,space_id,parent_id,name,system_role,sort_order,is_system,is_hidden,created_at,updated_at)
       VALUES ($1,$2,NULL,'Somewhere Else','normal',0,false,false,$3,$3)`,
      [otherId, SPACE, now],
    );

    await expect(repository.updateNoteCollection(identity, inboxId, { parent_id: otherId }))
      .rejects.toMatchObject({ statusCode: 422 });

    // A no-op PATCH that happens to include the unchanged parent_id must
    // still be allowed — only an actual reparent attempt is blocked.
    await expect(repository.updateNoteCollection(identity, inboxId, { parent_id: null, name: "Inbox" }))
      .resolves.toMatchObject({ id: inboxId, parent_id: null });

    // Renaming or hiding a system folder (anything but its parent/role)
    // stays unaffected.
    await expect(repository.updateNoteCollection(identity, inboxId, { is_hidden: true }))
      .resolves.toMatchObject({ id: inboxId, is_hidden: true });
  });

  it("still allows reparenting an ordinary (non-system) folder", async () => {
    if (!available || !pool) return;
    const identity = { spaceId: SPACE, userId: USER };
    const repository = new PgKnowledgeRepository(pool);
    const now = new Date().toISOString();
    const parentId = randomUUID();
    const childId = randomUUID();
    await pool.query(
      `INSERT INTO note_collections (id,space_id,parent_id,name,system_role,sort_order,is_system,is_hidden,created_at,updated_at)
       VALUES ($1,$2,NULL,'Projects','normal',0,false,false,$3,$3)`,
      [parentId, SPACE, now],
    );
    await pool.query(
      `INSERT INTO note_collections (id,space_id,parent_id,name,system_role,sort_order,is_system,is_hidden,created_at,updated_at)
       VALUES ($1,$2,NULL,'Loose folder','normal',0,false,false,$3,$3)`,
      [childId, SPACE, now],
    );

    await expect(repository.updateNoteCollection(identity, childId, { parent_id: parentId }))
      .resolves.toMatchObject({ id: childId, parent_id: parentId });
  });

  it("atomically reorders ordinary folders while retaining protected folder parents", async () => {
    if (!available || !pool) return;
    const identity = { spaceId: SPACE, userId: USER };
    const now = new Date().toISOString();
    const inboxId = randomUUID();
    const folderId = randomUUID();
    await pool.query(
      `INSERT INTO note_collections (id,space_id,parent_id,name,system_role,sort_order,is_system,is_hidden,created_at,updated_at)
       VALUES ($1,$3,NULL,'Inbox','inbox',0,true,false,$4,$4),
              ($2,$3,NULL,'Folder','normal',1,false,false,$4,$4)`,
      [inboxId, folderId, SPACE, now],
    );

    const result = await withTransaction(pool, (client) =>
      persistNotesTreeReorder(client, identity, {
        kind: "collections",
        updates: [
          { id: folderId, parentId: inboxId, sortOrder: 0 },
          { id: inboxId, parentId: null, sortOrder: 0 },
        ],
      }),
    );

    expect(result).toEqual({ kind: "collections", updated: 2 });
    const rows = await pool.query<{ id: string; parent_id: string | null; sort_order: number }>(
      `SELECT id,parent_id,sort_order FROM note_collections WHERE id = ANY($1::varchar[]) ORDER BY id`,
      [[inboxId, folderId]],
    );
    expect(rows.rows).toEqual(expect.arrayContaining([
      { id: inboxId, parent_id: null, sort_order: 0 },
      { id: folderId, parent_id: inboxId, sort_order: 0 },
    ]));
  });

  it("rejects a cyclic folder reorder without changing either folder", async () => {
    if (!available || !pool) return;
    const identity = { spaceId: SPACE, userId: USER };
    const now = new Date().toISOString();
    const parentId = randomUUID();
    const childId = randomUUID();
    await pool.query(
      `INSERT INTO note_collections (id,space_id,parent_id,name,system_role,sort_order,is_system,is_hidden,created_at,updated_at)
       VALUES ($1,$3,NULL,'Parent','normal',0,false,false,$4,$4),
              ($2,$3,$1,'Child','normal',0,false,false,$4,$4)`,
      [parentId, childId, SPACE, now],
    );

    await expect(withTransaction(pool, (client) =>
      persistNotesTreeReorder(client, identity, {
        kind: "collections",
        updates: [{ id: parentId, parentId: childId, sortOrder: 0 }],
      }),
    )).rejects.toMatchObject({ statusCode: 422 });

    const rows = await pool.query<{ id: string; parent_id: string | null }>(
      `SELECT id,parent_id FROM note_collections WHERE id = ANY($1::varchar[]) ORDER BY id`,
      [[parentId, childId]],
    );
    expect(rows.rows).toEqual(expect.arrayContaining([
      { id: parentId, parent_id: null },
      { id: childId, parent_id: parentId },
    ]));
  });

  it("allows a project-backed system folder to move but keeps the Projects root fixed", async () => {
    if (!available || !pool) return;
    const identity = { spaceId: SPACE, userId: USER };
    const now = new Date().toISOString();
    const projectsRootId = randomUUID();
    const projectFolderId = randomUUID();
    const ordinaryId = randomUUID();
    await pool.query(
      `INSERT INTO note_collections (id,space_id,parent_id,name,system_role,sort_order,is_system,is_hidden,created_at,updated_at)
       VALUES ($1,$4,NULL,'Projects','projects_root',0,true,false,$5,$5),
              ($2,$4,NULL,'Legacy Project','project',1,true,false,$5,$5),
              ($3,$4,NULL,'Ordinary','normal',2,false,false,$5,$5)`,
      [projectsRootId, projectFolderId, ordinaryId, SPACE, now],
    );

    await expect(withTransaction(pool, (client) =>
      persistNotesTreeReorder(client, identity, {
        kind: "collections",
        updates: [{ id: projectFolderId, parentId: projectsRootId, sortOrder: 0 }],
      }),
    )).resolves.toEqual({ kind: "collections", updated: 1 });

    await expect(withTransaction(pool, (client) =>
      persistNotesTreeReorder(client, identity, {
        kind: "collections",
        updates: [{ id: projectsRootId, parentId: ordinaryId, sortOrder: 0 }],
      }),
    )).rejects.toMatchObject({ statusCode: 422 });

    const rows = await pool.query<{ id: string; parent_id: string | null }>(
      `SELECT id,parent_id FROM note_collections WHERE id = ANY($1::varchar[]) ORDER BY id`,
      [[projectsRootId, projectFolderId]],
    );
    expect(rows.rows).toEqual(expect.arrayContaining([
      { id: projectsRootId, parent_id: null },
      { id: projectFolderId, parent_id: projectsRootId },
    ]));
  });
});
