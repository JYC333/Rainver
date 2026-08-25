import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { withTransaction } from "../src/db/tx";
import { ensureProjectNotesFolder } from "../src/modules/knowledge/noteProjectFolders";
import { persistNotesTreeReorder } from "../src/modules/knowledge/notesTreeReorder";
import { PgKnowledgeRepository } from "../src/modules/knowledge/repository";
import { getTestPostgres, isTestPostgresUnavailableError, type TestPostgresDatabase } from "./support/sharedPostgres";
import { resetTables } from "./support/resetTables";

/**
 * S6 boundary set. `contentAccessSql` evaluates the Project scope as a hard AND
 * *before* visibility and grants, so a note owned by Project A is unreadable to
 * a non-member of A no matter what per-user grant exists — that is why
 * cross-Project placement needed a new term in the predicate rather than a
 * grant. These tests pin what that term may and may not do.
 *
 * The Space is a **team** space: a `personal` space grants project access to
 * every member unconditionally (see `projectReadAccessSql`), which would make
 * every assertion here vacuous.
 */

const SPACE = "11111111-1111-4111-8111-111111111111";
/**
 * Owns Project A and is a member of Project B. Sharing needs write access to
 * both — the Project giving access up and the one receiving it — so the sharer
 * has to be someone who is in both to begin with.
 */
const ALPHA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
/** Owns Project B and is in no other Project. The one who must not see A's notes. */
const BETA = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
/** Member of Project A only; must not learn which other Projects receive its notes. */
const GAMMA = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

let database: TestPostgresDatabase | undefined;
let pool: Pool | undefined;
let available = false;

beforeAll(async () => {
  try {
    database = await getTestPostgres(__filename);
    pool = new Pool({ connectionString: database.getConnectionUri(), max: 2 });
    available = true;
  } catch (error) {
    if (!isTestPostgresUnavailableError(error)) throw error;
    console.warn(`[note-cross-project-share-db] skipped — Docker/Postgres unavailable: ${error instanceof Error ? error.message : String(error)}`);
  }
}, 180_000);

afterAll(async () => {
  await pool?.end();
  await database?.stop();
});

let projectA = "";
let projectB = "";
let folderA = "";
let folderB = "";

beforeEach(async () => {
  if (!available || !pool) return;
  await resetTables(
    pool,
    ["notes", "note_collections", "note_collection_items", "space_object_project_shares", "space_objects", "project_members", "projects", "space_memberships", "users", "spaces"],
    { cascade: true },
  );
  const now = new Date().toISOString();
  await pool.query(`INSERT INTO spaces (id,name,type,created_at,updated_at) VALUES ($1,'Team','team',$2,$2)`, [SPACE, now]);
  for (const [user, name] of [[ALPHA, "Alpha"], [BETA, "Beta"], [GAMMA, "Gamma"]] as const) {
    await pool.query(`INSERT INTO users (id,display_name,status,created_at,updated_at) VALUES ($1,$2,'active',$3,$3)`, [user, name, now]);
    await pool.query(
      `INSERT INTO space_memberships (id,space_id,user_id,role,status,created_at,updated_at) VALUES ($1,$2,$3,'member','active',$4,$4)`,
      [randomUUID(), SPACE, user, now],
    );
  }
  projectA = await makeProject("Project A", ALPHA);
  projectB = await makeProject("Project B", BETA);
  await addProjectMember(projectB, ALPHA);
  await addProjectMember(projectA, GAMMA);
  folderA = await withTransaction(pool, (tx) => ensureProjectNotesFolder(tx, SPACE, projectA));
  folderB = await withTransaction(pool, (tx) => ensureProjectNotesFolder(tx, SPACE, projectB));
});

async function makeProject(name: string, ownerUserId: string): Promise<string> {
  const id = randomUUID();
  const now = new Date().toISOString();
  await pool!.query(
    `INSERT INTO projects (id,space_id,name,status,owner_user_id,created_at,updated_at)
     VALUES ($1,$2,$3,'active',$4,$5,$5)`,
    [id, SPACE, name, ownerUserId, now],
  );
  await pool!.query(
    `INSERT INTO project_members (id,space_id,project_id,user_id,role,status,created_at,updated_at)
     VALUES ($1,$2,$3,$4,'owner','active',$5,$5)`,
    [randomUUID(), SPACE, id, ownerUserId, now],
  );
  return id;
}

async function addProjectMember(projectId: string, userId: string): Promise<void> {
  const now = new Date().toISOString();
  await pool!.query(
    `INSERT INTO project_members (id,space_id,project_id,user_id,role,status,created_at,updated_at)
     VALUES ($1,$2,$3,$4,'member','active',$5,$5)`,
    [randomUUID(), SPACE, projectId, userId, now],
  );
}

const alpha = { spaceId: SPACE, userId: ALPHA };
const beta = { spaceId: SPACE, userId: BETA };
const gamma = { spaceId: SPACE, userId: GAMMA };

async function noteInProjectA(): Promise<string> {
  const repository = new PgKnowledgeRepository(pool!);
  const note = await repository.createNote(alpha, {
    title: "Alpha finding",
    collection_id: folderA,
  }) as { id: string };
  // Space-shared: the share must be what lets Beta in, not the visibility.
  await pool!.query(`UPDATE space_objects SET visibility = 'space_shared' WHERE id = $1`, [note.id]);
  return note.id;
}

function placements(note: unknown): Array<{ collection_id: string }> {
  return (note as { placements: Array<{ collection_id: string }> }).placements;
}

describe("cross-project note sharing (real Postgres)", () => {
  it("hides an unshared note in Project A from a member of Project B", async () => {
    if (!available || !pool) return;
    const repository = new PgKnowledgeRepository(pool);
    const noteId = await noteInProjectA();

    expect(await repository.getNote(beta, noteId)).toBeNull();
    const listed = await repository.listNotes(beta, {
      status: null, projectId: null, collectionId: null, collectionIds: null,
      q: null, limit: 50, offset: 0,
    });
    expect((listed as { items: Array<{ id: string }> }).items).toEqual([]);
    expect((listed as { total: number }).total).toBe(0);
  });

  it("refuses a cross-project placement until the share is confirmed, and names the case", async () => {
    if (!available || !pool) return;
    const repository = new PgKnowledgeRepository(pool);
    const noteId = await noteInProjectA();

    await expect(repository.addNotePlacement(alpha, noteId, folderB))
      .rejects.toMatchObject({ statusCode: 409 });
    // Nothing happened: no placement, no share, and Beta still cannot see it.
    expect(placements(await repository.getNote(alpha, noteId))).toHaveLength(1);
    expect(await repository.listNoteProjectShares(alpha, noteId)).toEqual([]);
    expect(await repository.getNote(beta, noteId)).toBeNull();
  });

  it("makes the note readable by Project B once the share is confirmed", async () => {
    if (!available || !pool) return;
    const repository = new PgKnowledgeRepository(pool);
    const noteId = await noteInProjectA();

    await repository.addNotePlacement(alpha, noteId, folderB, true);

    expect(await repository.getNote(beta, noteId)).toMatchObject({ id: noteId });
    expect(await repository.listNoteProjectShares(alpha, noteId)).toEqual([
      expect.objectContaining({ project_id: projectB, project_name: "Project B", shared_by_user_id: ALPHA }),
    ]);
    // Governance ownership does not move (U7).
    const owner = await pool.query<{ primary_project_id: string }>(
      `SELECT primary_project_id FROM space_objects WHERE id = $1`, [noteId],
    );
    expect(owner.rows[0]?.primary_project_id).toBe(projectA);
  });

  it("keeps a shared note read-only for the receiving Project", async () => {
    if (!available || !pool) return;
    const repository = new PgKnowledgeRepository(pool);
    const noteId = await noteInProjectA();
    await repository.updateNote(alpha, noteId, {
      content_json: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Original" }] }] },
      plain_text: "Original",
    });
    await repository.addNotePlacement(alpha, noteId, folderB, true);

    await expect(repository.updateNote(beta, noteId, { title: "Taken" }))
      .rejects.toMatchObject({ statusCode: 404 });
    await expect(repository.rollbackNote(beta, noteId, 1))
      .rejects.toMatchObject({ statusCode: 404 });
    await expect(repository.deleteNote(beta, noteId))
      .rejects.toMatchObject({ statusCode: 404 });
    await expect(repository.createNoteLink(beta, noteId, {
      target_type: "note",
      target_id: noteId,
      link_type: "related_to",
    })).rejects.toMatchObject({ statusCode: 404 });

    expect(await repository.getNote(alpha, noteId)).toMatchObject({
      title: "Alpha finding",
      plain_text: "Original",
      status: "active",
    });
  });

  it("does not reveal receiving Project metadata to other owning-Project members", async () => {
    if (!available || !pool) return;
    const repository = new PgKnowledgeRepository(pool);
    const noteId = await noteInProjectA();
    await repository.addNotePlacement(alpha, noteId, folderB, true);

    expect(await repository.getNote(gamma, noteId)).toMatchObject({ id: noteId });
    expect(await repository.listNoteProjectShares(gamma, noteId)).toEqual([]);
  });

  it("shares scope, not visibility — a private note stays private", async () => {
    if (!available || !pool) return;
    const repository = new PgKnowledgeRepository(pool);
    const noteId = await noteInProjectA();
    await pool.query(`UPDATE space_objects SET visibility = 'private' WHERE id = $1`, [noteId]);

    await repository.addNotePlacement(alpha, noteId, folderB, true);

    // The share removed the Project barrier; the owner check is a separate
    // conjunct and still refuses.
    expect(await repository.getNote(beta, noteId)).toBeNull();
    expect(await repository.getNote(alpha, noteId)).toMatchObject({ id: noteId });
  });

  it("takes the note out of Project B's tree the moment the share is revoked", async () => {
    if (!available || !pool) return;
    const repository = new PgKnowledgeRepository(pool);
    const noteId = await noteInProjectA();
    await repository.addNotePlacement(alpha, noteId, folderB, true);
    expect(await repository.getNote(beta, noteId)).toMatchObject({ id: noteId });

    await repository.revokeNoteProjectShare(alpha, noteId, projectB);

    expect(await repository.getNote(beta, noteId)).toBeNull();
    expect(await repository.listNoteProjectShares(alpha, noteId)).toEqual([]);
    // The placement goes with the share: a tree with a hole in it is the silent
    // absence the explicit-share rule exists to prevent.
    expect(placements(await repository.getNote(alpha, noteId)))
      .toEqual([{ collection_id: folderA, sort_order: 0 }]);
  });

  it("does not let the receiving side pass the note on to a third Project", async () => {
    if (!available || !pool) return;
    const repository = new PgKnowledgeRepository(pool);
    const noteId = await noteInProjectA();
    const projectC = await makeProject("Project C", BETA);
    const folderC = await withTransaction(pool, (tx) => ensureProjectNotesFolder(tx, SPACE, projectC));

    // Alpha opens the note to Beta's Project B. Beta can now read it — and that
    // is the whole of what they gained. Sharing it onward into a Project of
    // their own is still a write to Project A, which Beta is not in, so a share
    // cannot be laundered into ownership.
    await repository.addNotePlacement(alpha, noteId, folderB, true);
    expect(await repository.getNote(beta, noteId)).toMatchObject({ id: noteId });

    await expect(repository.addNotePlacement(beta, noteId, folderC, true))
      .rejects.toMatchObject({ statusCode: 403 });
    expect(await repository.listNoteProjectShares(alpha, noteId))
      .toEqual([expect.objectContaining({ project_id: projectB })]);
  });

  it("gives a caller who cannot see the note nothing to act on", async () => {
    if (!available || !pool) return;
    const repository = new PgKnowledgeRepository(pool);
    const noteId = await noteInProjectA();

    // Not 403: telling Beta "you may not share this" would confirm it exists.
    await expect(repository.addNotePlacement(beta, noteId, folderB, true))
      .rejects.toMatchObject({ statusCode: 404 });
    await expect(repository.listNoteProjectShares(beta, noteId))
      .rejects.toMatchObject({ statusCode: 404 });
  });

  it("keeps the drag path refused — a share is never a side effect of a move", async () => {
    if (!available || !pool) return;
    const repository = new PgKnowledgeRepository(pool);
    const noteId = await noteInProjectA();

    await expect(withTransaction(pool, (client) => persistNotesTreeReorder(client, alpha, {
      kind: "notes",
      updates: [{ noteId, fromCollectionId: folderA, collectionId: folderB, sortOrder: 0 }],
    }))).rejects.toMatchObject({ statusCode: 409 });

    expect(await repository.listNoteProjectShares(alpha, noteId)).toEqual([]);
    expect(placements(await repository.getNote(alpha, noteId)))
      .toEqual([{ collection_id: folderA, sort_order: 0 }]);
  });

  it("re-uses the row on re-share so the history survives a revoke cycle", async () => {
    if (!available || !pool) return;
    const repository = new PgKnowledgeRepository(pool);
    const noteId = await noteInProjectA();

    await repository.addNotePlacement(alpha, noteId, folderB, true);
    await repository.revokeNoteProjectShare(alpha, noteId, projectB);
    await repository.addNotePlacement(alpha, noteId, folderB, true);

    const rows = await pool.query<{ revoked_at: string | null }>(
      `SELECT revoked_at FROM space_object_project_shares WHERE space_id = $1 AND object_id = $2`,
      [SPACE, noteId],
    );
    expect(rows.rows).toEqual([{ revoked_at: null }]);
    expect(await repository.getNote(beta, noteId)).toMatchObject({ id: noteId });
  });

  it("counts in the knowledge summary only what the viewer can read", async () => {
    if (!available || !pool) return;
    const repository = new PgKnowledgeRepository(pool);
    const noteId = await noteInProjectA();

    // A count is a weaker leak than a list, but it is still an answer about
    // content the viewer cannot open — and it makes the number wrong.
    const before = await repository.summary(beta) as { notes: { total: number } };
    expect(before.notes.total).toBe(0);
    expect((await repository.summary(alpha) as { notes: { total: number } }).notes.total).toBe(1);

    await repository.addNotePlacement(alpha, noteId, folderB, true);

    const after = await repository.summary(beta) as { notes: { total: number } };
    expect(after.notes.total).toBe(1);
  });
});
