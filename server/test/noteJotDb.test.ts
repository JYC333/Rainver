import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { __setAuthIdentityForTests } from "../src/modules/auth/identity.js";
import { PgKnowledgeRepository } from "../src/modules/knowledge/repository.js";
import { useTestDatabase } from "./support/testDatabase.js";
import { resetTables } from "./support/resetTables.js";
import { seedMainlineRoomsForAllProjects } from "./support/domainSeeds.js";

// NC/N7: notes and evidence connect both ways. The "jot a note" affordance on
// an evidence or material card has to create the note *and* the link in one
// step — the two-step version is why the connection never got made, and a
// client-side two-call version would strand a note whenever the link failed.

const SPACE = "11111111-1111-4111-8111-111111111111";
const USER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OTHER = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const PROJECT = "22222222-2222-4222-8222-222222222222";


const db = useTestDatabase(import.meta.filename, { max: 2 });

// Files share a worker: an identity or invoker left in a module-level
// seam would leak into whichever file runs next.
afterAll(() => {
  __setAuthIdentityForTests(null);
});

beforeAll(async () => {
  if (!db.available) return;
  __setAuthIdentityForTests({ spaceId: SPACE, userId: USER });
});

const identity = { spaceId: SPACE, userId: USER };

/** A Source `space_object` — what a materialized paper actually is. */
async function seedSource(title: string, opts?: { visibility?: string; ownerUserId?: string }): Promise<string> {
  const objectId = randomUUID();
  const now = new Date().toISOString();
  await db.pool.query(
    `INSERT INTO space_objects (id,space_id,object_type,title,visibility,owner_user_id,created_by_user_id,created_at,updated_at)
     VALUES ($1,$2,'source',$3,$4,$5,$5,$6,$6)`,
    [objectId, SPACE, title, opts?.visibility ?? "space_shared", opts?.ownerUserId ?? USER, now],
  );
  await db.pool.query(
    `INSERT INTO sources (object_id,space_id,status,source_type,uri,metadata_json)
     VALUES ($1,$2,'processed','paper','https://example.test/p','{}'::jsonb)`,
    [objectId, SPACE],
  );
  return objectId;
}

beforeEach(async () => {
  if (!db.available) return;
  await resetTables(
    db.pool,
    ["note_links", "notes", "sources", "space_objects", "projects", "space_memberships", "users", "spaces"],
    { cascade: true },
  );
  const now = new Date().toISOString();
  await db.pool.query(`INSERT INTO spaces (id,name,type,created_at,updated_at) VALUES ($1,'Space','personal',$2,$2)`, [SPACE, now]);
  for (const [id, name] of [[USER, "Owner"], [OTHER, "Other"]] as const) {
    await db.pool.query(`INSERT INTO users (id,display_name,status,created_at,updated_at) VALUES ($1,$2,'active',$3,$3)`, [id, name, now]);
    await db.pool.query(
      `INSERT INTO space_memberships (id,space_id,user_id,role,status,created_at,updated_at) VALUES ($1,$2,$3,'member','active',$4,$4)`,
      [randomUUID(), SPACE, id, now],
    );
  }
  await db.pool.query(
    `INSERT INTO projects (id,space_id,name,status,owner_user_id,created_at,updated_at) VALUES ($1,$2,'Project','active',$3,$4,$4)`,
    [PROJECT, SPACE, USER, now],
  );
  await seedMainlineRoomsForAllProjects(db.pool);
});

describe("jot a note from an evidence card (real Postgres)", () => {
  it("creates the note and the link in one call", async () => {
    if (!db.available) return;
    const repository = new PgKnowledgeRepository(db.pool);
    const sourceId = await seedSource("Attention Is All You Need");

    const note = await repository.jotNoteForObject(identity, {
      target_id: sourceId,
      text: "The residual connections are what make the depth trainable.",
      project_id: PROJECT,
    }) as { id: string; title: string; plain_text: string };

    expect(note.title).toBe("Note on Attention Is All You Need");
    expect(note.plain_text).toContain("residual connections");
    const links = await repository.noteLinks(identity, note.id) as Array<{ target_id: string; target_type: string; link_type: string }>;
    expect(links).toHaveLength(1);
    expect(links[0]).toMatchObject({ target_id: sourceId, target_type: "source", link_type: "references" });
  });

  it("appends to an existing note instead of littering the tree", async () => {
    if (!db.available) return;
    const repository = new PgKnowledgeRepository(db.pool);
    const sourceId = await seedSource("A paper");

    const first = await repository.jotNoteForObject(identity, {
      target_id: sourceId, text: "First thought.", project_id: PROJECT,
    }) as { id: string };
    const second = await repository.jotNoteForObject(identity, {
      target_id: sourceId, text: "Second thought.", note_id: first.id,
    }) as { id: string; plain_text: string };

    expect(second.id).toBe(first.id);
    expect(second.plain_text).toContain("First thought.");
    expect(second.plain_text).toContain("Second thought.");
    // One note, and one link — the second jot must not duplicate the edge.
    const notes = await db.pool.query(`SELECT object_id FROM notes WHERE space_id=$1`, [SPACE]);
    expect(notes.rows).toHaveLength(1);
    const links = await repository.noteLinks(identity, first.id);
    expect(links).toHaveLength(1);
  });

  it("shows the note from the evidence side too", async () => {
    if (!db.available) return;
    const repository = new PgKnowledgeRepository(db.pool);
    const sourceId = await seedSource("Cited work");
    const note = await repository.jotNoteForObject(identity, {
      target_id: sourceId, text: "Relevant to the replication question.",
    }) as { id: string };

    // The note backlinks route cannot answer this — it is note-keyed on both
    // sides, so its `backlinks` means "notes linking to this *note*". Asking an
    // evidence card what cites it needs its own read.
    const citing = await repository.notesLinkingToObject(identity, sourceId) as Array<{ source_id: string; source_type: string }>;
    expect(citing).toHaveLength(1);
    expect(citing[0]).toMatchObject({ source_id: note.id, source_type: "note" });
  });

  it("writes nothing when the target is not visible to the caller", async () => {
    if (!db.available) return;
    const repository = new PgKnowledgeRepository(db.pool);
    const hidden = await seedSource("Private paper", { visibility: "private", ownerUserId: OTHER });

    await expect(repository.jotNoteForObject(identity, { target_id: hidden, text: "Should not persist." }))
      .rejects.toThrow(/Link target not found/);
    // The point of resolving the target first: a refused jot must not leave a
    // note behind, which would itself disclose that the target exists.
    expect((await db.pool.query(`SELECT object_id FROM notes WHERE space_id=$1`, [SPACE])).rows).toHaveLength(0);
  });

  it("hides a private note from a direct fetch, not only from the list", async () => {
    if (!db.available) return;
    const repository = new PgKnowledgeRepository(db.pool);
    const mine = await repository.createNote(identity, { title: "Private" }) as { id: string };
    await db.pool.query(
      `UPDATE space_objects SET visibility='private', owner_user_id=$2 WHERE id=$1`,
      [mine.id, USER],
    );

    // `getNoteRow` backs every single-note read *and* mutation, so an ungated
    // fetch meant another member could also edit and delete the note.
    const other = { spaceId: SPACE, userId: OTHER };
    expect(await repository.getNote(other, mine.id)).toBeNull();
    await expect(repository.updateNote(other, mine.id, { title: "Taken" })).rejects.toThrow(/Note not found/);
    await expect(repository.deleteNote(other, mine.id)).rejects.toThrow(/Note not found/);
    // The owner is unaffected.
    expect(await repository.getNote(identity, mine.id)).toBeTruthy();
  });

  it("rejects an empty jot rather than creating a blank note", async () => {
    if (!db.available) return;
    const repository = new PgKnowledgeRepository(db.pool);
    const sourceId = await seedSource("A paper");
    await expect(repository.jotNoteForObject(identity, { target_id: sourceId, text: "  " })).rejects.toThrow();
    expect((await db.pool.query(`SELECT object_id FROM notes WHERE space_id=$1`, [SPACE])).rows).toHaveLength(0);
  });
});
