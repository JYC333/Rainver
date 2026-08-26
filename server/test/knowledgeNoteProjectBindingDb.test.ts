import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { withTransaction } from "../src/db/tx.js";
import { persistNotesTreeReorder } from "../src/modules/knowledge/notesTreeReorder.js";
import { ensureProjectNotesFolder } from "../src/modules/knowledge/noteProjectFolders.js";
import { PgKnowledgeRepository } from "../src/modules/knowledge/repository.js";
import { useTestDatabase } from "./support/testDatabase.js";
import { resetTables } from "./support/resetTables.js";

/**
 * Placement is what binds a note to a Project (U7), and the binding is
 * single-valued because `space_objects.primary_project_id` is a hard AND in the
 * content read gate — display ownership may be plural, governance ownership may
 * not. Until a share table widens that gate (S6), a note placed into a second
 * Project's folder would simply be invisible to its members, so it is refused.
 */

const SPACE = "11111111-1111-4111-8111-111111111111";
const USER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";


const db = useTestDatabase(import.meta.filename, { max: 2 });

beforeEach(async () => {
  if (!db.available) return;
  await resetTables(
    db.pool,
    ["notes", "note_collections", "note_collection_items", "space_objects", "projects", "space_memberships", "users", "spaces"],
    { cascade: true },
  );
  const now = new Date().toISOString();
  await db.pool.query(`INSERT INTO spaces (id,name,type,created_at,updated_at) VALUES ($1,'Space','personal',$2,$2)`, [SPACE, now]);
  await db.pool.query(`INSERT INTO users (id,display_name,status,created_at,updated_at) VALUES ($1,'Owner','active',$2,$2)`, [USER, now]);
  await db.pool.query(`INSERT INTO space_memberships (id,space_id,user_id,role,status,created_at,updated_at) VALUES ($1,$2,$3,'owner','active',$4,$4)`, [randomUUID(), SPACE, USER, now]);
});

const identity = { spaceId: SPACE, userId: USER };

async function makeProject(name: string): Promise<string> {
  const id = randomUUID();
  const now = new Date().toISOString();
  await db.pool.query(
    `INSERT INTO projects (id,space_id,name,status,owner_user_id,created_at,updated_at)
     VALUES ($1,$2,$3,'active',$4,$5,$5)`,
    [id, SPACE, name, USER, now],
  );
  return id;
}

async function makeFolder(name: string, parentId: string | null = null): Promise<string> {
  const id = randomUUID();
  const now = new Date().toISOString();
  await db.pool.query(
    `INSERT INTO note_collections (id,space_id,parent_id,name,system_role,sort_order,is_system,is_hidden,created_at,updated_at)
     VALUES ($1,$2,$3,$4,'normal',0,false,false,$5,$5)`,
    [id, SPACE, parentId, name, now],
  );
  return id;
}

async function primaryProjectOf(noteId: string): Promise<string | null> {
  const row = await db.pool.query<{ primary_project_id: string | null }>(
    `SELECT primary_project_id FROM space_objects WHERE id = $1`,
    [noteId],
  );
  return row.rows[0]?.primary_project_id ?? null;
}

async function roleOf(noteId: string): Promise<{ project_role: string | null; role_project_id: string | null }> {
  const row = await db.pool.query<{ project_role: string | null; role_project_id: string | null }>(
    `SELECT project_role, role_project_id FROM notes WHERE object_id = $1`,
    [noteId],
  );
  return row.rows[0] ?? { project_role: null, role_project_id: null };
}

describe("note project binding by placement (real Postgres)", () => {
  it("binds a note to the Project when it is first placed in its subtree", async () => {
    if (!db.available) return;
    const repository = new PgKnowledgeRepository(db.pool);
    const projectId = await makeProject("Study");
    const projectFolder = await withTransaction(db.pool, (tx) => ensureProjectNotesFolder(tx, SPACE, projectId));
    const loose = await makeFolder("Loose");
    const note = await repository.createNote(identity, { title: "Unfiled", collection_id: loose }) as { id: string };
    expect(await primaryProjectOf(note.id)).toBeNull();

    await withTransaction(db.pool, (client) => persistNotesTreeReorder(client, identity, {
      kind: "notes",
      updates: [{ noteId: note.id, fromCollectionId: loose, collectionId: projectFolder, sortOrder: 0 }],
    }));

    expect(await primaryProjectOf(note.id)).toBe(projectId);
  });

  it("binds through a subfolder of the Project's folder, not only its root", async () => {
    if (!db.available) return;
    const repository = new PgKnowledgeRepository(db.pool);
    const projectId = await makeProject("Study");
    const projectFolder = await withTransaction(db.pool, (tx) => ensureProjectNotesFolder(tx, SPACE, projectId));
    const nested = await makeFolder("Experiments", projectFolder);
    const loose = await makeFolder("Loose");
    const note = await repository.createNote(identity, { title: "Unfiled", collection_id: loose }) as { id: string };

    await repository.addNotePlacement(identity, note.id, nested);

    expect(await primaryProjectOf(note.id)).toBe(projectId);
  });

  it("refuses an unconfirmed placement into a second Project's subtree", async () => {
    if (!db.available) return;
    const repository = new PgKnowledgeRepository(db.pool);
    const first = await makeProject("First");
    const second = await makeProject("Second");
    const firstFolder = await withTransaction(db.pool, (tx) => ensureProjectNotesFolder(tx, SPACE, first));
    const secondFolder = await withTransaction(db.pool, (tx) => ensureProjectNotesFolder(tx, SPACE, second));
    const note = await repository.createNote(identity, { title: "Owned", collection_id: firstFolder }) as { id: string };

    // 409 with a code rather than a flat refusal: S6 made this case reachable
    // through an explicit share, so the client's answer is to ask the user.
    // The drag path has no such answer and stays refused.
    await expect(repository.addNotePlacement(identity, note.id, secondFolder))
      .rejects.toMatchObject({ statusCode: 409 });
    await expect(withTransaction(db.pool, (client) => persistNotesTreeReorder(client, identity, {
      kind: "notes",
      updates: [{ noteId: note.id, fromCollectionId: firstFolder, collectionId: secondFolder, sortOrder: 0 }],
    }))).rejects.toMatchObject({ statusCode: 409 });

    expect(await primaryProjectOf(note.id)).toBe(first);
    const placements = await db.pool.query(`SELECT collection_id FROM note_collection_items WHERE note_id = $1`, [note.id]);
    expect(placements.rows).toEqual([{ collection_id: firstFolder }]);
  });

  it("drops a baseline role a drag would otherwise carry into another Project", async () => {
    if (!db.available) return;
    const repository = new PgKnowledgeRepository(db.pool);
    const projectId = await makeProject("Study");
    const projectFolder = await withTransaction(db.pool, (tx) => ensureProjectNotesFolder(tx, SPACE, projectId));
    const loose = await makeFolder("Loose");
    const note = await repository.createNote(identity, { title: "Stale role", collection_id: loose }) as { id: string };
    // A role scoped to a Project the note is not (yet) in — the shape the guard
    // exists for. The role write path refuses to create this, so it is set up
    // directly.
    await db.pool.query(
      `UPDATE notes SET project_role = 'understanding', role_project_id = $2 WHERE object_id = $1`,
      [note.id, await makeProject("Elsewhere")],
    );

    await withTransaction(db.pool, (client) => persistNotesTreeReorder(client, identity, {
      kind: "notes",
      updates: [{ noteId: note.id, fromCollectionId: loose, collectionId: projectFolder, sortOrder: 0 }],
    }));

    expect(await primaryProjectOf(note.id)).toBe(projectId);
    expect(await roleOf(note.id)).toEqual({ project_role: null, role_project_id: null });
  });

  it("leaves a note's Project alone when it is placed outside every Project subtree", async () => {
    if (!db.available) return;
    const repository = new PgKnowledgeRepository(db.pool);
    const projectId = await makeProject("Study");
    const projectFolder = await withTransaction(db.pool, (tx) => ensureProjectNotesFolder(tx, SPACE, projectId));
    const loose = await makeFolder("Loose");
    const note = await repository.createNote(identity, { title: "Owned", collection_id: projectFolder }) as { id: string };
    await repository.updateNote(identity, note.id, { project_role: "understanding" });

    await repository.addNotePlacement(identity, note.id, loose);

    expect(await primaryProjectOf(note.id)).toBe(projectId);
    expect(await roleOf(note.id)).toEqual({ project_role: "understanding", role_project_id: projectId });
  });

  it("creates the Project notes folder once, under the seeded Projects root", async () => {
    if (!db.available) return;
    const projectId = await makeProject("Study");
    const projectsRoot = randomUUID();
    const now = new Date().toISOString();
    await db.pool.query(
      `INSERT INTO note_collections (id,space_id,parent_id,name,system_role,sort_order,is_system,is_hidden,created_at,updated_at)
       VALUES ($1,$2,NULL,'Projects','projects_root',0,true,false,$3,$3)`,
      [projectsRoot, SPACE, now],
    );

    const first = await withTransaction(db.pool, (tx) => ensureProjectNotesFolder(tx, SPACE, projectId));
    const again = await withTransaction(db.pool, (tx) => ensureProjectNotesFolder(tx, SPACE, projectId));

    expect(again).toBe(first);
    const row = await db.pool.query<{ parent_id: string | null; system_role: string }>(
      `SELECT parent_id, system_role FROM note_collections WHERE id = $1`,
      [first],
    );
    expect(row.rows[0]).toEqual({ parent_id: projectsRoot, system_role: "project" });
  });
  it("allows Project viewers to read notes but not mutate their placements", async () => {
    if (!db.available) return;
    const viewer = randomUUID();
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
    const projectId = await makeProject("Shared");
    await db.pool.query(
      `INSERT INTO project_members (id,space_id,project_id,user_id,role,status,created_at,updated_at)
       VALUES ($1,$2,$3,$4,'viewer','active',$5,$5)`,
      [randomUUID(), SPACE, projectId, viewer, now],
    );
    const projectRoot = await withTransaction(db.pool, (tx) =>
      ensureProjectNotesFolder(tx, SPACE, projectId));
    const nested = await makeFolder("Nested", projectRoot);
    const loose = await makeFolder("Loose");
    const ownerRepository = new PgKnowledgeRepository(db.pool);
    const note = await ownerRepository.createNote(identity, {
      title: "Project note",
      collection_id: projectRoot,
    }) as { id: string };
    await ownerRepository.addNotePlacement(identity, note.id, loose);

    const viewerIdentity = { spaceId: SPACE, userId: viewer };
    const viewerRepository = new PgKnowledgeRepository(db.pool);
    await expect(viewerRepository.getNote(viewerIdentity, note.id)).resolves.toMatchObject({ id: note.id });
    await expect(viewerRepository.addNotePlacement(viewerIdentity, note.id, nested))
      .rejects.toMatchObject({ statusCode: 403 });
    await expect(viewerRepository.removeNotePlacement(viewerIdentity, note.id, projectRoot))
      .rejects.toMatchObject({ statusCode: 403 });
    await expect(withTransaction(db.pool, (client) => persistNotesTreeReorder(client, viewerIdentity, {
      kind: "notes",
      updates: [{ noteId: note.id, fromCollectionId: projectRoot, collectionId: projectRoot, sortOrder: 0 }],
    }))).rejects.toMatchObject({ statusCode: 403 });
  });
});
