import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { withTransaction } from "../src/db/tx";
import { persistNotesTreeReorder } from "../src/modules/knowledge/notesTreeReorder";
import { PgKnowledgeRepository } from "../src/modules/knowledge/repository";
import { useTestDatabase } from "./support/testDatabase";
import { resetTables } from "./support/resetTables";

// Fixed workspace roots remain immovable at the server boundary. Project-backed
// folders are different: they retain protected destructive actions but can be
// reparented so legacy projects can be organized under the Projects root.

const SPACE = "11111111-1111-4111-8111-111111111111";
const USER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";


const db = useTestDatabase(__filename, { max: 2 });

beforeEach(async () => {
  if (!db.available) return;
  await resetTables(db.pool, ["note_collections", "space_memberships", "users", "spaces"], { cascade: true });
  const now = new Date().toISOString();
  await db.pool.query(`INSERT INTO spaces (id,name,type,created_at,updated_at) VALUES ($1,'Space','personal',$2,$2)`, [SPACE, now]);
  await db.pool.query(`INSERT INTO users (id,display_name,status,created_at,updated_at) VALUES ($1,'Owner','active',$2,$2)`, [USER, now]);
  await db.pool.query(`INSERT INTO space_memberships (id,space_id,user_id,role,status,created_at,updated_at) VALUES ($1,$2,$3,'owner','active',$4,$4)`, [randomUUID(), SPACE, USER, now]);
});

describe("PgKnowledgeRepository note collections (real Postgres)", () => {
  it("creates with a stable client id and appends after existing siblings", async () => {
    if (!db.available) return;
    const identity = { spaceId: SPACE, userId: USER };
    const repository = new PgKnowledgeRepository(db.pool);
    const now = new Date().toISOString();
    const existingId = randomUUID();
    const createdId = randomUUID();
    await db.pool.query(
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
    if (!db.available) return;
    const identity = { spaceId: SPACE, userId: USER };
    const repository = new PgKnowledgeRepository(db.pool);
    const now = new Date().toISOString();
    const inboxId = randomUUID();
    const otherId = randomUUID();
    await db.pool.query(
      `INSERT INTO note_collections (id,space_id,parent_id,name,system_role,sort_order,is_system,is_hidden,created_at,updated_at)
       VALUES ($1,$2,NULL,'Inbox','inbox',0,true,false,$3,$3)`,
      [inboxId, SPACE, now],
    );
    await db.pool.query(
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
    if (!db.available) return;
    const identity = { spaceId: SPACE, userId: USER };
    const repository = new PgKnowledgeRepository(db.pool);
    const now = new Date().toISOString();
    const parentId = randomUUID();
    const childId = randomUUID();
    await db.pool.query(
      `INSERT INTO note_collections (id,space_id,parent_id,name,system_role,sort_order,is_system,is_hidden,created_at,updated_at)
       VALUES ($1,$2,NULL,'Projects','normal',0,false,false,$3,$3)`,
      [parentId, SPACE, now],
    );
    await db.pool.query(
      `INSERT INTO note_collections (id,space_id,parent_id,name,system_role,sort_order,is_system,is_hidden,created_at,updated_at)
       VALUES ($1,$2,NULL,'Loose folder','normal',0,false,false,$3,$3)`,
      [childId, SPACE, now],
    );

    await expect(repository.updateNoteCollection(identity, childId, { parent_id: parentId }))
      .resolves.toMatchObject({ id: childId, parent_id: parentId });
  });

  it("atomically reorders ordinary folders while retaining protected folder parents", async () => {
    if (!db.available) return;
    const identity = { spaceId: SPACE, userId: USER };
    const now = new Date().toISOString();
    const inboxId = randomUUID();
    const folderId = randomUUID();
    await db.pool.query(
      `INSERT INTO note_collections (id,space_id,parent_id,name,system_role,sort_order,is_system,is_hidden,created_at,updated_at)
       VALUES ($1,$3,NULL,'Inbox','inbox',0,true,false,$4,$4),
              ($2,$3,NULL,'Folder','normal',1,false,false,$4,$4)`,
      [inboxId, folderId, SPACE, now],
    );

    const result = await withTransaction(db.pool, (client) =>
      persistNotesTreeReorder(client, identity, {
        kind: "collections",
        updates: [
          { id: folderId, parentId: inboxId, sortOrder: 0 },
          { id: inboxId, parentId: null, sortOrder: 0 },
        ],
      }),
    );

    expect(result).toEqual({ kind: "collections", updated: 2 });
    const rows = await db.pool.query<{ id: string; parent_id: string | null; sort_order: number }>(
      `SELECT id,parent_id,sort_order FROM note_collections WHERE id = ANY($1::varchar[]) ORDER BY id`,
      [[inboxId, folderId]],
    );
    expect(rows.rows).toEqual(expect.arrayContaining([
      { id: inboxId, parent_id: null, sort_order: 0 },
      { id: folderId, parent_id: inboxId, sort_order: 0 },
    ]));
  });

  it("rejects a cyclic folder reorder without changing either folder", async () => {
    if (!db.available) return;
    const identity = { spaceId: SPACE, userId: USER };
    const now = new Date().toISOString();
    const parentId = randomUUID();
    const childId = randomUUID();
    await db.pool.query(
      `INSERT INTO note_collections (id,space_id,parent_id,name,system_role,sort_order,is_system,is_hidden,created_at,updated_at)
       VALUES ($1,$3,NULL,'Parent','normal',0,false,false,$4,$4),
              ($2,$3,$1,'Child','normal',0,false,false,$4,$4)`,
      [parentId, childId, SPACE, now],
    );

    await expect(withTransaction(db.pool, (client) =>
      persistNotesTreeReorder(client, identity, {
        kind: "collections",
        updates: [{ id: parentId, parentId: childId, sortOrder: 0 }],
      }),
    )).rejects.toMatchObject({ statusCode: 422 });

    const rows = await db.pool.query<{ id: string; parent_id: string | null }>(
      `SELECT id,parent_id FROM note_collections WHERE id = ANY($1::varchar[]) ORDER BY id`,
      [[parentId, childId]],
    );
    expect(rows.rows).toEqual(expect.arrayContaining([
      { id: parentId, parent_id: null },
      { id: childId, parent_id: parentId },
    ]));
  });

  it("allows a project-backed system folder to move but keeps the Projects root fixed", async () => {
    if (!db.available) return;
    const identity = { spaceId: SPACE, userId: USER };
    const now = new Date().toISOString();
    const projectsRootId = randomUUID();
    const projectFolderId = randomUUID();
    const ordinaryId = randomUUID();
    await db.pool.query(
      `INSERT INTO note_collections (id,space_id,parent_id,name,system_role,sort_order,is_system,is_hidden,created_at,updated_at)
       VALUES ($1,$4,NULL,'Projects','projects_root',0,true,false,$5,$5),
              ($2,$4,NULL,'Legacy Project','project',1,true,false,$5,$5),
              ($3,$4,NULL,'Ordinary','normal',2,false,false,$5,$5)`,
      [projectsRootId, projectFolderId, ordinaryId, SPACE, now],
    );

    await expect(withTransaction(db.pool, (client) =>
      persistNotesTreeReorder(client, identity, {
        kind: "collections",
        updates: [{ id: projectFolderId, parentId: projectsRootId, sortOrder: 0 }],
      }),
    )).resolves.toEqual({ kind: "collections", updated: 1 });

    await expect(withTransaction(db.pool, (client) =>
      persistNotesTreeReorder(client, identity, {
        kind: "collections",
        updates: [{ id: projectsRootId, parentId: ordinaryId, sortOrder: 0 }],
      }),
    )).rejects.toMatchObject({ statusCode: 422 });

    const rows = await db.pool.query<{ id: string; parent_id: string | null }>(
      `SELECT id,parent_id FROM note_collections WHERE id = ANY($1::varchar[]) ORDER BY id`,
      [[projectsRootId, projectFolderId]],
    );
    expect(rows.rows).toEqual(expect.arrayContaining([
      { id: projectsRootId, parent_id: null },
      { id: projectFolderId, parent_id: projectsRootId },
    ]));
  });
  it("hides inaccessible Project workspaces and lets a Project viewer open but not mutate an existing one", async () => {
    if (!db.available) return;
    const viewer = randomUUID();
    const privateProject = randomUUID();
    const sharedProject = randomUUID();
    const now = new Date().toISOString();
    await db.pool.query(`UPDATE spaces SET type = 'team' WHERE id = $1`, [SPACE]);
    await db.pool.query(
      `INSERT INTO users (id,display_name,status,created_at,updated_at)
       VALUES ($1,'Viewer','active',$2,$2)`,
      [viewer, now],
    );
    await db.pool.query(
      `INSERT INTO space_memberships (id,space_id,user_id,role,status,created_at,updated_at)
       VALUES ($1,$2,$3,'member','active',$4,$4)`,
      [randomUUID(), SPACE, viewer, now],
    );
    await db.pool.query(
      `INSERT INTO projects (id,space_id,name,status,owner_user_id,created_at,updated_at)
       VALUES ($1,$3,'Private','active',$4,$5,$5),
              ($2,$3,'Shared','active',$4,$5,$5)`,
      [privateProject, sharedProject, SPACE, USER, now],
    );
    await db.pool.query(
      `INSERT INTO project_members (id,space_id,project_id,user_id,role,status,created_at,updated_at)
       VALUES ($1,$2,$3,$4,'viewer','active',$5,$5)`,
      [randomUUID(), SPACE, sharedProject, viewer, now],
    );

    const ownerRepository = new PgKnowledgeRepository(db.pool);
    const privateRoot = (await ownerRepository.ensureProjectNotesCollection(
      { spaceId: SPACE, userId: USER }, privateProject,
    ) as { id: string }).id;
    const sharedRoot = (await ownerRepository.ensureProjectNotesCollection(
      { spaceId: SPACE, userId: USER }, sharedProject,
    ) as { id: string }).id;
    const sharedChild = (await ownerRepository.createNoteCollection(
      { spaceId: SPACE, userId: USER },
      { name: "Visible child", parent_id: sharedRoot },
    ) as { id: string }).id;
    const privateChild = (await ownerRepository.createNoteCollection(
      { spaceId: SPACE, userId: USER },
      { name: "Secret child", parent_id: privateRoot },
    ) as { id: string }).id;

    const viewerRepository = new PgKnowledgeRepository(db.pool);
    const viewerIdentity = { spaceId: SPACE, userId: viewer };
    const listed = await viewerRepository.listNoteCollections(viewerIdentity);
    expect(listed.map((row) => row.id)).toEqual(expect.arrayContaining([sharedRoot, sharedChild]));
    expect(listed.map((row) => row.id)).not.toContain(privateRoot);
    expect(listed.map((row) => row.id)).not.toContain(privateChild);
    await expect(viewerRepository.ensureProjectNotesCollection(viewerIdentity, sharedProject))
      .resolves.toMatchObject({ id: sharedRoot });
    await expect(viewerRepository.ensureProjectNotesCollection(viewerIdentity, privateProject))
      .rejects.toMatchObject({ statusCode: 404 });
    await expect(viewerRepository.updateNoteCollection(viewerIdentity, sharedChild, { is_hidden: true }))
      .rejects.toMatchObject({ statusCode: 403 });
  });

  it("refuses moving a whole folder across a Project workspace boundary", async () => {
    if (!db.available) return;
    const repository = new PgKnowledgeRepository(db.pool);
    const projectId = randomUUID();
    const now = new Date().toISOString();
    await db.pool.query(
      `INSERT INTO projects (id,space_id,name,status,owner_user_id,created_at,updated_at)
       VALUES ($1,$2,'Project','active',$3,$4,$4)`,
      [projectId, SPACE, USER, now],
    );
    const projectRoot = (await repository.ensureProjectNotesCollection(
      { spaceId: SPACE, userId: USER }, projectId,
    ) as { id: string }).id;
    const loose = (await repository.createNoteCollection(
      { spaceId: SPACE, userId: USER }, { name: "Loose" },
    ) as { id: string }).id;

    await expect(withTransaction(db.pool, (client) =>
      persistNotesTreeReorder(client, { spaceId: SPACE, userId: USER }, {
        kind: "collections",
        updates: [{ id: loose, parentId: projectRoot, sortOrder: 0 }],
      }),
    )).rejects.toMatchObject({ statusCode: 422 });
    await expect(repository.updateNoteCollection(
      { spaceId: SPACE, userId: USER }, loose, { parent_id: projectRoot },
    )).rejects.toMatchObject({ statusCode: 422 });

    const row = await db.pool.query<{ parent_id: string | null }>(
      `SELECT parent_id FROM note_collections WHERE id = $1`,
      [loose],
    );
    expect(row.rows[0]?.parent_id).toBeNull();
  });
});
