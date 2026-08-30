import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { __setAuthIdentityForTests } from "../src/modules/auth/identity.js";
import { PgKnowledgeRepository } from "../src/modules/knowledge/repository.js";
import { resolveNotebookNote } from "../src/modules/projectResearch/notebookNotes.js";
import { useTestDatabase } from "./support/testDatabase.js";
import { resetTables } from "./support/resetTables.js";
import { seedMainlineRoomsForAllProjects } from "./support/domainSeeds.js";

// NA: the project research baseline used to be bound by title string, so
// renaming a starter note silently removed it from the baseline and the
// monitoring comparison degraded without reporting anything. These assertions
// are the acceptance criterion for the role marker replacing that binding.

const SPACE = "11111111-1111-4111-8111-111111111111";
const USER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const PROJECT = "22222222-2222-4222-8222-222222222222";
const OTHER_PROJECT = "33333333-3333-4333-8333-333333333333";


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

beforeEach(async () => {
  if (!db.available) return;
  await resetTables(
    db.pool,
    ["notes", "space_objects", "projects", "space_memberships", "users", "spaces"],
    { cascade: true },
  );
  const now = new Date().toISOString();
  await db.pool.query(`INSERT INTO spaces (id,name,type,created_at,updated_at) VALUES ($1,'Space','personal',$2,$2)`, [SPACE, now]);
  await db.pool.query(`INSERT INTO users (id,display_name,status,created_at,updated_at) VALUES ($1,'Owner','active',$2,$2)`, [USER, now]);
  await db.pool.query(`INSERT INTO space_memberships (id,space_id,user_id,role,status,created_at,updated_at) VALUES ($1,$2,$3,'owner','active',$4,$4)`, [randomUUID(), SPACE, USER, now]);
  for (const [id, name] of [[PROJECT, "Project"], [OTHER_PROJECT, "Other"]] as const) {
    await db.pool.query(
      `INSERT INTO projects (id,space_id,name,status,owner_user_id,created_at,updated_at) VALUES ($1,$2,$3,'active',$4,$5,$5)`,
      [id, SPACE, name, USER, now],
    );
    await seedMainlineRoomsForAllProjects(db.pool);
  }
});

const identity = { spaceId: SPACE, userId: USER };

describe("note project role (real Postgres)", () => {
  it("keeps the baseline bound across a rename, which the title binding could not", async () => {
    if (!db.available) return;
    const repository = new PgKnowledgeRepository(db.pool);
    const note = await repository.createNote(identity, {
      title: "Current understanding", primary_project_id: PROJECT,
    }) as { id: string };
    await repository.updateNote(identity, note.id, { project_role: "understanding" });

    await repository.updateNote(identity, note.id, { title: "What we think so far" });

    const resolved = await resolveNotebookNote(db.pool, SPACE, PROJECT, "understanding");
    expect(resolved.present).toBe(true);
    expect(resolved.present && resolved.note.id).toBe(note.id);
  });

  it("reports an absent role instead of resolving to nothing", async () => {
    if (!db.available) return;
    const resolved = await resolveNotebookNote(db.pool, SPACE, PROJECT, "understanding");
    expect(resolved).toEqual({ present: false, role: "understanding", reason: "no_note_in_role" });
  });

  it("moves a role rather than creating a second baseline for it", async () => {
    if (!db.available) return;
    const repository = new PgKnowledgeRepository(db.pool);
    const first = await repository.createNote(identity, { title: "First", primary_project_id: PROJECT }) as { id: string };
    const second = await repository.createNote(identity, { title: "Second", primary_project_id: PROJECT }) as { id: string };
    await repository.updateNote(identity, first.id, { project_role: "ideas" });

    await repository.updateNote(identity, second.id, { project_role: "ideas" });

    const resolved = await resolveNotebookNote(db.pool, SPACE, PROJECT, "ideas");
    expect(resolved.present && resolved.note.id).toBe(second.id);
    const holders = await db.pool.query<{ object_id: string }>(
      `SELECT object_id FROM notes WHERE space_id=$1 AND role_project_id=$2 AND project_role='ideas'`,
      [SPACE, PROJECT],
    );
    expect(holders.rows.map((row) => row.object_id)).toEqual([second.id]);
    // The demoted note keeps everything except the role.
    const demoted = await repository.getNote(identity, first.id) as { title: string; project_role: string | null };
    expect(demoted.title).toBe("First");
    expect(demoted.project_role).toBeNull();
  });

  it("clears a role on request and refuses one the registry does not know", async () => {
    if (!db.available) return;
    const repository = new PgKnowledgeRepository(db.pool);
    const note = await repository.createNote(identity, { title: "Log", primary_project_id: PROJECT }) as { id: string };
    await repository.updateNote(identity, note.id, { project_role: "experiments" });

    await expect(repository.updateNote(identity, note.id, { project_role: "burndown" })).rejects.toThrow(/Unknown note project role/);
    // The rejected assignment left the existing role untouched.
    expect((await resolveNotebookNote(db.pool, SPACE, PROJECT, "experiments")).present).toBe(true);

    await repository.updateNote(identity, note.id, { project_role: null });
    expect((await resolveNotebookNote(db.pool, SPACE, PROJECT, "experiments")).present).toBe(false);
  });

  it("refuses a role on a note that belongs to no project", async () => {
    if (!db.available) return;
    const repository = new PgKnowledgeRepository(db.pool);
    const note = await repository.createNote(identity, { title: "Personal" }) as { id: string };
    await expect(repository.updateNote(identity, note.id, { project_role: "questions" }))
      .rejects.toThrow(/must belong to a project/);
  });

  it("drops the role when the note leaves the project the role was scoped to", async () => {
    if (!db.available) return;
    const repository = new PgKnowledgeRepository(db.pool);
    const note = await repository.createNote(identity, { title: "Questions", primary_project_id: PROJECT }) as { id: string };
    await repository.updateNote(identity, note.id, { project_role: "questions" });

    await repository.updateNote(identity, note.id, { primary_project_id: OTHER_PROJECT });

    expect((await resolveNotebookNote(db.pool, SPACE, PROJECT, "questions")).present).toBe(false);
    expect((await resolveNotebookNote(db.pool, SPACE, OTHER_PROJECT, "questions")).present).toBe(false);
  });

  it("scopes the same role independently per project", async () => {
    if (!db.available) return;
    const repository = new PgKnowledgeRepository(db.pool);
    const mine = await repository.createNote(identity, { title: "Ours", primary_project_id: PROJECT }) as { id: string };
    const theirs = await repository.createNote(identity, { title: "Theirs", primary_project_id: OTHER_PROJECT }) as { id: string };
    await repository.updateNote(identity, mine.id, { project_role: "understanding" });
    await repository.updateNote(identity, theirs.id, { project_role: "understanding" });

    expect((await resolveNotebookNote(db.pool, SPACE, PROJECT, "understanding")).present && true).toBe(true);
    const other = await resolveNotebookNote(db.pool, SPACE, OTHER_PROJECT, "understanding");
    expect(other.present && other.note.id).toBe(theirs.id);
  });
});
