import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { CaptureService } from "../src/modules/capture/service.js";
import { PgKnowledgeRepository } from "../src/modules/knowledge/repository.js";
import { blockIds } from "../src/modules/knowledge/noteBlockIds.js";
import { useTestDatabase } from "./support/testDatabase.js";
import { resetTables } from "./support/resetTables.js";

/**
 * The four capture destinations behind one entry (D1/D2).
 *
 * What these tests are guarding is the decoupling of ownership from pipeline.
 * Binding the two — Project implies shared, personal implies reviewed — is the
 * arrangement this work replaced, and its failure mode is silent: material
 * pasted into a Project becomes the user's private marginalia, invisible to the
 * team it was meant for. The mirror of that, a margin note published to the
 * whole team on the first keystroke, is what ADR 0013 decision 3a exists to
 * prevent. Both directions are asserted here.
 */

const OWNER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const MATE = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const OWNER_PERSONAL = "11111111-1111-4111-8111-111111111111";
const MATE_PERSONAL = "22222222-2222-4222-8222-222222222222";
const TEAM = "33333333-3333-4333-8333-333333333333";
const PROJECT = "44444444-4444-4444-8444-444444444444";

let targetId = "";

const db = useTestDatabase(import.meta.filename, { max: 4 });

beforeEach(async () => {
  if (!db.available) return;
  await resetTables(
    db.pool,
    ["notes", "note_collections", "note_collection_items", "note_links", "note_revisions", "activity_records", "space_objects", "project_members", "projects", "space_memberships", "users", "spaces"],
    { cascade: true },
  );
  const now = new Date().toISOString();
  await db.pool.query(
    `INSERT INTO users (id, display_name, status, created_at, updated_at)
     VALUES ($1,'Owner','active',$3,$3), ($2,'Mate','active',$3,$3)`,
    [OWNER, MATE, now],
  );
  await db.pool.query(
    `INSERT INTO spaces (id, name, type, created_by_user_id, created_at, updated_at)
     VALUES ($1,'Owner personal','personal',$4,$5,$5),
            ($2,'Mate personal','personal',$6,$5,$5),
            ($3,'Team','team',$4,$5,$5)`,
    [OWNER_PERSONAL, MATE_PERSONAL, TEAM, OWNER, now, MATE],
  );
  await db.pool.query(
    `INSERT INTO space_memberships (id, space_id, user_id, role, status, created_at, updated_at)
     VALUES ($1,$4,$6,'owner','active',$9,$9),
            ($2,$5,$7,'owner','active',$9,$9),
            ($3,$8,$6,'owner','active',$9,$9),
            ($10,$8,$7,'member','active',$9,$9)`,
    [randomUUID(), randomUUID(), randomUUID(), OWNER_PERSONAL, MATE_PERSONAL, OWNER, MATE, TEAM, now, randomUUID()],
  );
  await db.pool.query(
    `INSERT INTO projects (id, space_id, name, status, owner_user_id, created_at, updated_at)
     VALUES ($1,$2,'Study','active',$3,$4,$4)`,
    [PROJECT, TEAM, OWNER, now],
  );
  await db.pool.query(
    `INSERT INTO project_members (id, space_id, project_id, user_id, role, status, created_at, updated_at)
     VALUES ($1,$2,$3,$4,'member','active',$5,$5)`,
    [randomUUID(), TEAM, PROJECT, MATE, now],
  );
  // The object an Area declares as "what this page is about". A shared note
  // stands in for a Thread here: what matters to capture is only that it is a
  // `space_objects` row both members can see.
  targetId = randomUUID();
  await db.pool.query(
    `INSERT INTO space_objects (id, space_id, object_type, title, visibility, owner_user_id,
                                primary_project_id, created_by_user_id, created_at, updated_at)
     VALUES ($1,$2,'note','The shared thread','space_shared',$3,$4,$3,$5,$5)`,
    [targetId, TEAM, OWNER, PROJECT, now],
  );
  await db.pool.query(
    `INSERT INTO notes (object_id, space_id, content_json, content_format, content_schema_version,
                        plain_text, status, version)
     VALUES ($1,$2,'{"type":"doc","content":[]}'::jsonb,'prosemirror_json',1,'','active',1)`,
    [targetId, TEAM],
  );
});

function capture() {
  return new CaptureService(db.pool);
}

async function activityRow(id: string) {
  const result = await db.pool.query(
    `SELECT space_id, project_id, visibility, status, owner_user_id, source_kind
       FROM activity_records WHERE id = $1`,
    [id],
  );
  return result.rows[0];
}

async function objectRow(id: string) {
  const result = await db.pool.query(
    `SELECT visibility, owner_user_id, primary_project_id, title FROM space_objects WHERE id = $1`,
    [id],
  );
  return result.rows[0];
}

describe("capture destinations (real Postgres)", () => {
  it("sends the personal inbox to the caller's own Space even when standing in a Project", async () => {
    if (!db.available) return;
    const result = await capture().capture({
      userId: OWNER,
      requestSpaceId: TEAM,
      destination: "personal_inbox",
      text: "Unrelated to this project.",
      projectId: PROJECT,
    });

    expect(result).toMatchObject({
      space_id: OWNER_PERSONAL,
      project_id: null,
      visibility: "private",
      status: "raw",
      note_id: null,
    });
    expect(await activityRow(result.activity_id)).toMatchObject({
      space_id: OWNER_PERSONAL,
      project_id: null,
      visibility: "private",
      status: "raw",
      owner_user_id: OWNER,
    });
  });

  it("keeps project raw material team-visible and awaiting processing", async () => {
    if (!db.available) return;
    const result = await capture().capture({
      userId: OWNER,
      requestSpaceId: TEAM,
      destination: "project_raw",
      text: "https://example.com/paper",
      projectId: PROJECT,
    });

    expect(result).toMatchObject({
      space_id: TEAM,
      project_id: PROJECT,
      visibility: "space_shared",
      status: "raw",
      note_id: null,
    });
    // A URL is captured as a link, so the pipeline downstream knows to fetch it.
    expect(await activityRow(result.activity_id)).toMatchObject({ source_kind: "web_capture" });
    // The teammate can read it: this is the case that was being privatised.
    const seen = await db.pool.query(
      `SELECT id FROM activity_records WHERE id = $1 AND visibility = 'space_shared' AND space_id = $2`,
      [result.activity_id, TEAM],
    );
    expect(seen.rows).toHaveLength(1);
  });

  it("writes project marginalia into a private note and records the activity as its provenance", async () => {
    if (!db.available) return;
    const result = await capture().capture({
      userId: OWNER,
      requestSpaceId: TEAM,
      destination: "project_marginalia",
      text: "The control group here is wrong.",
      projectId: PROJECT,
    });

    expect(result).toMatchObject({
      space_id: TEAM,
      project_id: PROJECT,
      visibility: "private",
      status: "processed",
    });
    expect(result.note_id).toBeTruthy();
    expect(await activityRow(result.activity_id)).toMatchObject({
      space_id: TEAM,
      project_id: PROJECT,
      visibility: "private",
      status: "processed",
    });
    expect(await objectRow(result.note_id!)).toMatchObject({
      visibility: "private",
      owner_user_id: OWNER,
      primary_project_id: PROJECT,
    });
    const note = await db.pool.query(
      `SELECT plain_text, created_from_activity_id, marginalia_project_id,
              marginalia_owner_user_id, marginalia_target_object_id
         FROM notes WHERE object_id = $1`,
      [result.note_id],
    );
    expect(note.rows[0]).toMatchObject({
      created_from_activity_id: result.activity_id,
      marginalia_project_id: PROJECT,
      marginalia_owner_user_id: OWNER,
      marginalia_target_object_id: null,
    });
    expect(note.rows[0].plain_text).toContain("The control group here is wrong.");
  });

  it("appends a second project marginalia capture to the same note", async () => {
    if (!db.available) return;
    const first = await capture().capture({
      userId: OWNER, requestSpaceId: TEAM, destination: "project_marginalia",
      text: "First.", projectId: PROJECT,
    });
    const second = await capture().capture({
      userId: OWNER, requestSpaceId: TEAM, destination: "project_marginalia",
      text: "Second.", projectId: PROJECT,
    });

    expect(second.note_id).toBe(first.note_id);
    const note = await db.pool.query(`SELECT plain_text FROM notes WHERE object_id = $1`, [first.note_id]);
    expect(note.rows[0].plain_text).toContain("First.");
    expect(note.rows[0].plain_text).toContain("Second.");
    // Two captures, two activity records, one note.
    const activities = await db.pool.query(`SELECT id FROM activity_records`);
    expect(activities.rows).toHaveLength(2);
  });

  it("hangs object marginalia on the declared object and reuses that note", async () => {
    if (!db.available) return;
    const first = await capture().capture({
      userId: OWNER, requestSpaceId: TEAM, destination: "object_marginalia",
      text: "Anchored thought.", projectId: PROJECT, targetId,
    });
    const second = await capture().capture({
      userId: OWNER, requestSpaceId: TEAM, destination: "object_marginalia",
      text: "Another one.", projectId: PROJECT, targetId,
    });

    expect(second.note_id).toBe(first.note_id);
    expect(await objectRow(first.note_id!)).toMatchObject({
      visibility: "private",
      owner_user_id: OWNER,
      title: "My notes on The shared thread",
    });
    const links = await db.pool.query(
      `SELECT to_object_id, link_type FROM note_links WHERE from_object_id = $1 AND status = 'active'`,
      [first.note_id],
    );
    expect(links.rows).toEqual([{ to_object_id: targetId, link_type: "references" }]);
    // The binding names the object too, which is what keeps this note apart
    // from the Project-level one and from a team note about the same object.
    const note = await db.pool.query(
      `SELECT marginalia_project_id, marginalia_owner_user_id, marginalia_target_object_id
         FROM notes WHERE object_id = $1`,
      [first.note_id],
    );
    expect(note.rows[0]).toMatchObject({
      marginalia_project_id: PROJECT,
      marginalia_owner_user_id: OWNER,
      marginalia_target_object_id: targetId,
    });
  });

  it("gives each member their own marginalia, on the Project and on one object", async () => {
    if (!db.available) return;
    const ownerProject = await capture().capture({
      userId: OWNER, requestSpaceId: TEAM, destination: "project_marginalia",
      text: "Owner's project note.", projectId: PROJECT,
    });
    const mateProject = await capture().capture({
      userId: MATE, requestSpaceId: TEAM, destination: "project_marginalia",
      text: "Mate's project note.", projectId: PROJECT,
    });
    const ownerObject = await capture().capture({
      userId: OWNER, requestSpaceId: TEAM, destination: "object_marginalia",
      text: "Owner on the thread.", projectId: PROJECT, targetId,
    });
    const mateObject = await capture().capture({
      userId: MATE, requestSpaceId: TEAM, destination: "object_marginalia",
      text: "Mate on the thread.", projectId: PROJECT, targetId,
    });

    expect(mateProject.note_id).not.toBe(ownerProject.note_id);
    expect(mateObject.note_id).not.toBe(ownerObject.note_id);

    // Neither can read the other's, and neither text leaked into the other note.
    const repository = new PgKnowledgeRepository(db.pool);
    expect(await repository.getNote({ spaceId: TEAM, userId: MATE }, ownerProject.note_id!)).toBeNull();
    expect(await repository.getNote({ spaceId: TEAM, userId: OWNER }, mateProject.note_id!)).toBeNull();
    expect(await repository.getNote({ spaceId: TEAM, userId: MATE }, ownerObject.note_id!)).toBeNull();
    expect(await repository.getNote({ spaceId: TEAM, userId: OWNER }, mateObject.note_id!)).toBeNull();

    const mine = await repository.getNote({ spaceId: TEAM, userId: OWNER }, ownerProject.note_id!);
    expect(String(mine!.plain_text)).toContain("Owner's project note.");
    expect(String(mine!.plain_text)).not.toContain("Mate's project note.");
  });

  it("does not adopt a pre-existing shared note on the same object as marginalia", async () => {
    if (!db.available) return;
    const repository = new PgKnowledgeRepository(db.pool);
    const shared = await repository.jotNoteForObject({ spaceId: TEAM, userId: OWNER }, {
      target_id: targetId,
      project_id: PROJECT,
      text: "Team-visible jot from an evidence card.",
    }) as { id: string };

    const marginalia = await capture().capture({
      userId: OWNER, requestSpaceId: TEAM, destination: "object_marginalia",
      text: "Private aside.", projectId: PROJECT, targetId,
    });

    expect(marginalia.note_id).not.toBe(shared.id);
    expect(await objectRow(shared.id)).toMatchObject({ visibility: "space_shared" });
    expect(await objectRow(marginalia.note_id!)).toMatchObject({ visibility: "private" });
  });

  it("frees the marginalia slot when its note is archived, so capture keeps working", async () => {
    if (!db.available) return;
    const repository = new PgKnowledgeRepository(db.pool);
    const first = await capture().capture({
      userId: OWNER, requestSpaceId: TEAM, destination: "project_marginalia",
      text: "First.", projectId: PROJECT,
    });
    await repository.updateNote({ spaceId: TEAM, userId: OWNER }, first.note_id!, { status: "archived" });

    const second = await capture().capture({
      userId: OWNER, requestSpaceId: TEAM, destination: "project_marginalia",
      text: "After archiving.", projectId: PROJECT,
    });

    expect(second.note_id).not.toBe(first.note_id);
    const bindings = await db.pool.query(
      `SELECT object_id FROM notes WHERE marginalia_owner_user_id = $1 AND marginalia_project_id = $2`,
      [OWNER, PROJECT],
    );
    expect(bindings.rows).toEqual([{ object_id: second.note_id }]);
  });

  it("keeps a shared jot on the same object out of the private marginalia note", async () => {
    if (!db.available) return;
    const repository = new PgKnowledgeRepository(db.pool);
    // Marginalia first: this is the order that used to make the jot land in it.
    const marginalia = await capture().capture({
      userId: OWNER, requestSpaceId: TEAM, destination: "object_marginalia",
      text: "Private aside.", projectId: PROJECT, targetId,
    });
    const jotted = await repository.jotNoteForObject({ spaceId: TEAM, userId: OWNER }, {
      target_id: targetId,
      project_id: PROJECT,
      text: "Team-visible jot from an evidence card.",
    }) as { id: string };

    expect(jotted.id).not.toBe(marginalia.note_id);
    expect(await objectRow(jotted.id)).toMatchObject({ visibility: "space_shared" });
    const privateNote = await db.pool.query(`SELECT plain_text FROM notes WHERE object_id = $1`, [marginalia.note_id]);
    expect(privateNote.rows[0].plain_text).not.toContain("Team-visible jot");
  });

  it("keeps working after the marginalia note's link is deleted", async () => {
    if (!db.available) return;
    const first = await capture().capture({
      userId: OWNER, requestSpaceId: TEAM, destination: "object_marginalia",
      text: "Anchored.", projectId: PROJECT, targetId,
    });
    // The note editor offers this, and the binding — not the link — is what
    // the unique index is on, so the two must not be allowed to disagree.
    await db.pool.query(`DELETE FROM note_links WHERE from_object_id = $1`, [first.note_id]);

    const second = await capture().capture({
      userId: OWNER, requestSpaceId: TEAM, destination: "object_marginalia",
      text: "Anchored again.", projectId: PROJECT, targetId,
    });

    expect(second.note_id).toBe(first.note_id);
    const note = await db.pool.query(`SELECT plain_text FROM notes WHERE object_id = $1`, [first.note_id]);
    expect(note.rows[0].plain_text).toContain("Anchored again.");
  });

  it("never lets a shared jot resolve to a private note, even one whose binding was cleared", async () => {
    if (!db.available) return;
    const repository = new PgKnowledgeRepository(db.pool);
    const marginalia = await capture().capture({
      userId: OWNER, requestSpaceId: TEAM, destination: "object_marginalia",
      text: "Private aside.", projectId: PROJECT, targetId,
    });
    // Archiving clears the binding; restoring leaves an active, still-linked,
    // still-private note. "No binding" alone must not read as "team note".
    const identity = { spaceId: TEAM, userId: OWNER };
    await repository.updateNote(identity, marginalia.note_id!, { status: "archived" });
    await repository.updateNote(identity, marginalia.note_id!, { status: "active" });

    const jotted = await repository.jotNoteForObject(identity, {
      target_id: targetId, project_id: PROJECT, text: "Team-visible jot.",
    }) as { id: string };

    expect(jotted.id).not.toBe(marginalia.note_id);
    expect(await objectRow(jotted.id)).toMatchObject({ visibility: "space_shared" });
  });

  it("anchors the capture on the block it wrote, and the anchor survives editing", async () => {
    if (!db.available) return;
    const repository = new PgKnowledgeRepository(db.pool);
    const identity = { spaceId: TEAM, userId: OWNER };
    const first = await capture().capture({
      userId: OWNER, requestSpaceId: TEAM, destination: "project_marginalia",
      text: "The control group here is wrong.", projectId: PROJECT,
    });

    expect(first.block_id).toBeTruthy();
    const record = await db.pool.query(`SELECT payload_json FROM activity_records WHERE id = $1`, [first.activity_id]);
    expect(record.rows[0].payload_json.marginalia.block_id).toBe(first.block_id);

    // A second capture, and then an edit that rewrites the surrounding text.
    // An index would have moved by now; the id must not.
    const second = await capture().capture({
      userId: OWNER, requestSpaceId: TEAM, destination: "project_marginalia",
      text: "A later thought.", projectId: PROJECT,
    });
    expect(second.block_id).not.toBe(first.block_id);

    const note = await repository.getNote(identity, first.note_id!) as { content_json: unknown; version: number };
    const doc = note.content_json as { content: Record<string, unknown>[] };
    await repository.updateNote(identity, first.note_id!, {
      content_json: { ...doc, content: [{ type: "paragraph", content: [{ type: "text", text: "Inserted above." }] }, ...doc.content] },
      expect_version: note.version,
    });

    const reread = await repository.getNote(identity, first.note_id!) as { content_json: unknown };
    const ids = blockIds(reread.content_json);
    expect(ids).toContain(first.block_id);
    expect(ids).toContain(second.block_id);
    expect(ids.indexOf(first.block_id!)).toBe(1);
  });

  it("refuses an object that belongs to another Project", async () => {
    if (!db.available) return;
    const otherProject = randomUUID();
    await db.pool.query(
      `INSERT INTO projects (id, space_id, name, status, owner_user_id, created_at, updated_at)
       VALUES ($1,$2,'Other','active',$3,now(),now())`,
      [otherProject, TEAM, OWNER],
    );

    await expect(capture().capture({
      userId: OWNER, requestSpaceId: TEAM, destination: "object_marginalia",
      text: "Wrong project.", projectId: otherProject, targetId,
    })).rejects.toMatchObject({ statusCode: 422 });
    expect((await db.pool.query(`SELECT id FROM activity_records`)).rows).toHaveLength(0);
  });

  it("refuses a Project the caller cannot write, and leaves nothing behind", async () => {
    if (!db.available) return;
    await db.pool.query(`DELETE FROM project_members WHERE project_id = $1 AND user_id = $2`, [PROJECT, MATE]);
    await db.pool.query(`UPDATE space_memberships SET role = 'guest' WHERE space_id = $1 AND user_id = $2`, [TEAM, MATE]);

    await expect(capture().capture({
      userId: MATE, requestSpaceId: TEAM, destination: "project_marginalia",
      text: "Should not land.", projectId: PROJECT,
    })).rejects.toMatchObject({ statusCode: 403 });

    expect((await db.pool.query(`SELECT id FROM activity_records`)).rows).toHaveLength(0);
    expect((await db.pool.query(`SELECT object_id FROM notes WHERE marginalia_owner_user_id IS NOT NULL`)).rows)
      .toHaveLength(0);
  });

  it("refuses an object the caller cannot see, and writes no activity record", async () => {
    if (!db.available) return;
    await db.pool.query(
      `UPDATE space_objects SET visibility = 'private', owner_user_id = $2 WHERE id = $1`,
      [targetId, OWNER],
    );

    await expect(capture().capture({
      userId: MATE, requestSpaceId: TEAM, destination: "object_marginalia",
      text: "Should not land.", projectId: PROJECT, targetId,
    })).rejects.toMatchObject({ statusCode: 404 });

    expect((await db.pool.query(`SELECT id FROM activity_records`)).rows).toHaveLength(0);
  });

  it("rejects a Project destination with no Project", async () => {
    if (!db.available) return;
    await expect(capture().capture({
      userId: OWNER, requestSpaceId: TEAM, destination: "project_raw", text: "No project.",
    })).rejects.toMatchObject({ statusCode: 422 });
    await expect(capture().capture({
      userId: OWNER, requestSpaceId: TEAM, destination: "object_marginalia",
      text: "No target.", projectId: PROJECT,
    })).rejects.toMatchObject({ statusCode: 422 });
  });
});
