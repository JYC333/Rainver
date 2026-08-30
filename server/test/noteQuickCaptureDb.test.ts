import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { PgKnowledgeRepository } from "../src/modules/knowledge/repository.js";
import { useTestDatabase } from "./support/testDatabase.js";
import { resetTables } from "./support/resetTables.js";
import { seedMainlineRoomsForAllProjects } from "./support/domainSeeds.js";

/**
 * S5 quick capture (U11). Two shapes, and the reason there are two:
 *
 * - **With a context object** — one note per object, appending on repeat. Ten
 *   papers' annotations must not end up in one note.
 * - **Without one** — append to the Project's `inbox` note. A new note per
 *   captured thought would turn the tree into fragments.
 *
 * The inbox is found by `project_role`, never by title: the previous work
 * removed title-based note resolution and `noteProjectRoleGuard.test.ts` fails
 * if it comes back.
 */

const SPACE = "11111111-1111-4111-8111-111111111111";
const USER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

let projectId = "";

const db = useTestDatabase(import.meta.filename, { max: 2 });

beforeEach(async () => {
  if (!db.available) return;
  await resetTables(
    db.pool,
    ["notes", "note_collections", "note_collection_items", "note_links", "space_objects", "project_members", "projects", "space_memberships", "users", "spaces"],
    { cascade: true },
  );
  const now = new Date().toISOString();
  await db.pool.query(`INSERT INTO spaces (id,name,type,created_at,updated_at) VALUES ($1,'Space','personal',$2,$2)`, [SPACE, now]);
  await db.pool.query(`INSERT INTO users (id,display_name,status,created_at,updated_at) VALUES ($1,'Owner','active',$2,$2)`, [USER, now]);
  await db.pool.query(`INSERT INTO space_memberships (id,space_id,user_id,role,status,created_at,updated_at) VALUES ($1,$2,$3,'owner','active',$4,$4)`, [randomUUID(), SPACE, USER, now]);
  projectId = randomUUID();
  await db.pool.query(
    `INSERT INTO projects (id,space_id,name,status,owner_user_id,created_at,updated_at)
     VALUES ($1,$2,'Study','active',$3,$4,$4)`,
    [projectId, SPACE, USER, now],
  );
  await seedMainlineRoomsForAllProjects(db.pool);
});

const identity = { spaceId: SPACE, userId: USER };

async function inboxRow(): Promise<{ object_id: string; project_role: string; role_project_id: string } | undefined> {
  const result = await db.pool.query<{ object_id: string; project_role: string; role_project_id: string }>(
    `SELECT object_id, project_role, role_project_id FROM notes
      WHERE space_id = $1 AND project_role = 'inbox'`,
    [SPACE],
  );
  return result.rows[0];
}

describe("quick capture (real Postgres)", () => {
  it("creates the Project inbox on the first contextless capture", async () => {
    if (!db.available) return;
    const repository = new PgKnowledgeRepository(db.pool);

    const note = await repository.jotNoteForObject(identity, {
      project_id: projectId,
      text: "Batching might be the bottleneck.",
    }) as { id: string; title: string; plain_text: string };

    expect(note.title).toBe("Project inbox");
    expect(note.plain_text).toContain("Batching might be the bottleneck.");
    expect(await inboxRow()).toMatchObject({
      object_id: note.id,
      project_role: "inbox",
      role_project_id: projectId,
    });
    // Filed in the Project's own notes folder, so it shows up on the Project
    // notes surface rather than only in the global tree.
    const placements = await db.pool.query<{ project_id: string | null }>(
      `SELECT c.project_id
         FROM note_collection_items i
         JOIN note_collections c ON c.id = i.collection_id AND c.space_id = i.space_id
        WHERE i.space_id = $1 AND i.note_id = $2`,
      [SPACE, note.id],
    );
    expect(placements.rows).toEqual([{ project_id: projectId }]);
  });

  it("appends to the same inbox rather than making a second one", async () => {
    if (!db.available) return;
    const repository = new PgKnowledgeRepository(db.pool);

    const first = await repository.jotNoteForObject(identity, {
      project_id: projectId, text: "First thought.",
    }) as { id: string };
    const second = await repository.jotNoteForObject(identity, {
      project_id: projectId, text: "Second thought.",
    }) as { id: string; plain_text: string; version: number };

    expect(second.id).toBe(first.id);
    expect(second.plain_text).toContain("First thought.");
    expect(second.plain_text).toContain("Second thought.");
    expect(second.version).toBeGreaterThan(1);
    const all = await db.pool.query(`SELECT object_id FROM notes WHERE space_id = $1`, [SPACE]);
    expect(all.rows).toHaveLength(1);
  });

  it("keeps using the inbox after it has been renamed", async () => {
    if (!db.available) return;
    const repository = new PgKnowledgeRepository(db.pool);
    const first = await repository.jotNoteForObject(identity, {
      project_id: projectId, text: "First thought.",
    }) as { id: string };
    // The whole point of the role: a rename must not orphan the inbox and
    // silently start a second one.
    await repository.updateNote(identity, first.id, { title: "Scratch" });

    const second = await repository.jotNoteForObject(identity, {
      project_id: projectId, text: "Second thought.",
    }) as { id: string; title: string };

    expect(second.id).toBe(first.id);
    expect(second.title).toBe("Scratch");
  });

  it("gives each Project its own inbox", async () => {
    if (!db.available) return;
    const repository = new PgKnowledgeRepository(db.pool);
    const other = randomUUID();
    const now = new Date().toISOString();
    await db.pool.query(
      `INSERT INTO projects (id,space_id,name,status,owner_user_id,created_at,updated_at)
       VALUES ($1,$2,'Other','active',$3,$4,$4)`,
      [other, SPACE, USER, now],
    );
    await seedMainlineRoomsForAllProjects(db.pool);

    const a = await repository.jotNoteForObject(identity, { project_id: projectId, text: "A" }) as { id: string };
    const b = await repository.jotNoteForObject(identity, { project_id: other, text: "B" }) as { id: string };

    expect(b.id).not.toBe(a.id);
    const rows = await db.pool.query(`SELECT role_project_id FROM notes WHERE project_role = 'inbox' ORDER BY role_project_id`, []);
    expect(rows.rows).toHaveLength(2);
  });

  it("requires a project when there is no context object to hang the note on", async () => {
    if (!db.available) return;
    const repository = new PgKnowledgeRepository(db.pool);

    await expect(repository.jotNoteForObject(identity, { text: "Nowhere to put this." }))
      .rejects.toMatchObject({ statusCode: 422 });
    expect(await inboxRow()).toBeUndefined();
  });

  it("still makes one note per object when a context object is given", async () => {
    if (!db.available) return;
    const repository = new PgKnowledgeRepository(db.pool);
    const target = await repository.createNote(identity, { title: "Target" }) as { id: string };

    const jotted = await repository.jotNoteForObject(identity, {
      target_id: target.id, text: "About the target.",
    }) as { id: string; title: string };
    // The server resolves the existing link itself. Clients may pass note_id as
    // an optimization, but correctness cannot depend on their backlink cache.
    const repeated = await repository.jotNoteForObject(identity, {
      target_id: target.id, text: "More about the target.",
    }) as { id: string; plain_text: string };

    expect(repeated.id).toBe(jotted.id);
    expect(repeated.plain_text).toContain("About the target.");
    expect(repeated.plain_text).toContain("More about the target.");
    expect(jotted.title).toBe("Note on Target");
    // The contextful path is untouched by the inbox: no role, and a link.
    expect(await inboxRow()).toBeUndefined();
    const links = await db.pool.query(
      `SELECT to_object_id FROM note_links WHERE space_id = $1 AND from_object_id = $2`,
      [SPACE, jotted.id],
    );
    expect(links.rows).toEqual([{ to_object_id: target.id }]);
    const notes = await db.pool.query(`SELECT object_id FROM notes WHERE space_id = $1`, [SPACE]);
    expect(notes.rows).toHaveLength(2); // target + one quick-capture note
  });

  it("serializes concurrent first captures for the same context object", async () => {
    if (!db.available) return;
    const repository = new PgKnowledgeRepository(db.pool);
    const target = await repository.createNote(identity, { title: "Target" }) as { id: string };

    const [first, second] = await Promise.all([
      repository.jotNoteForObject(identity, { target_id: target.id, text: "First concurrent thought." }),
      repository.jotNoteForObject(identity, { target_id: target.id, text: "Second concurrent thought." }),
    ]) as Array<{ id: string; plain_text: string }>;

    expect(second.id).toBe(first.id);
    const saved = await repository.getNote(identity, first.id) as { plain_text: string };
    expect(saved.plain_text).toContain("First concurrent thought.");
    expect(saved.plain_text).toContain("Second concurrent thought.");
    const linkedNotes = await db.pool.query(
      `SELECT DISTINCT from_object_id
         FROM note_links
        WHERE space_id = $1 AND to_object_id = $2 AND status = 'active'`,
      [SPACE, target.id],
    );
    expect(linkedNotes.rows).toEqual([{ from_object_id: first.id }]);
  });

  it("refuses to append to an inbox the caller cannot read", async () => {
    if (!db.available) return;
    const repository = new PgKnowledgeRepository(db.pool);
    const first = await repository.jotNoteForObject(identity, {
      project_id: projectId, text: "Mine.",
    }) as { id: string };

    // A second Project writer whose captures would land in a note they can
    // never open. Writing anyway would also make the reply — a gated read —
    // come back empty.
    const other = randomUUID();
    const now = new Date().toISOString();
    await db.pool.query(`INSERT INTO users (id,display_name,status,created_at,updated_at) VALUES ($1,'Other','active',$2,$2)`, [other, now]);
    await db.pool.query(`INSERT INTO space_memberships (id,space_id,user_id,role,status,created_at,updated_at) VALUES ($1,$2,$3,'owner','active',$4,$4)`, [randomUUID(), SPACE, other, now]);
    await db.pool.query(`UPDATE space_objects SET visibility = 'private' WHERE id = $1`, [first.id]);

    await expect(repository.jotNoteForObject({ spaceId: SPACE, userId: other }, {
      project_id: projectId, text: "Theirs.",
    })).rejects.toMatchObject({ statusCode: 409 });

    // And the role stays where it was — a second inbox would have taken it.
    const rows = await db.pool.query(`SELECT object_id FROM notes WHERE project_role = 'inbox'`, []);
    expect(rows.rows).toEqual([{ object_id: first.id }]);
  });
});
