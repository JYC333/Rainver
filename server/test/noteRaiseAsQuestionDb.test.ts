import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { useTestDatabase } from "./support/testDatabase.js";
import { resetTables } from "./support/resetTables.js";
import { __setAuthIdentityForTests } from "../src/modules/auth/identity.js";
import { PgProjectRepository } from "../src/modules/projects/repository.js";
import { PgKnowledgeRepository } from "../src/modules/knowledge/repository.js";
import { InquiryThreadService } from "../src/modules/inquiry/threadService.js";

// NE: "raise as a question" turns a passage into an Inquiry Thread and keeps
// the route back to the note it came from. Without the link the Question would
// be a retyped sentence with no path to the reasoning behind it, which is the
// disconnection the whole plan is about.

const SPACE = "11111111-1111-4111-8111-111111111111";
const OWNER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";


const db = useTestDatabase(import.meta.filename);

// Files share a worker: an identity or invoker left in a module-level
// seam would leak into whichever file runs next.
afterAll(() => {
  __setAuthIdentityForTests(null);
});

beforeAll(async () => {
  if (!db.available) return;
  __setAuthIdentityForTests({ spaceId: SPACE, userId: OWNER });
});

beforeEach(async () => {
  if (!db.available) return;
  await resetTables(
    db.pool,
    ["object_relations", "inquiry_question_states", "inquiry_threads", "notes", "space_objects", "projects", "space_memberships", "users", "spaces"],
    { cascade: true },
  );
  const now = new Date().toISOString();
  await db.pool.query(`INSERT INTO spaces (id, name, type, created_at, updated_at) VALUES ($1, 'Space', 'personal', $2, $2)`, [SPACE, now]);
  await db.pool.query(`INSERT INTO users (id, display_name, status, created_at, updated_at) VALUES ($1, 'Owner', 'active', $2, $2)`, [OWNER, now]);
  await db.pool.query(
    `INSERT INTO space_memberships (id, space_id, user_id, role, status, created_at, updated_at) VALUES ($1, $2, $3, 'owner', 'active', $4, $4)`,
    [randomUUID(), SPACE, OWNER, now],
  );
});

const identity = () => ({ spaceId: SPACE, userId: OWNER });
const PASSAGE = "Does the effect survive a stronger control condition?";

describe("raise a note passage as a Question (real Postgres)", () => {
  it("creates the Thread and links it back to the note", async () => {
    if (!db.available) return;
    const project = await new PgProjectRepository(db.pool).create(identity(), { name: "P" }) as { id: string };
    const note = await new PgKnowledgeRepository(db.pool).createNote(identity(), {
      title: "Reading notes", primary_project_id: project.id, plain_text: PASSAGE,
    }) as { id: string };

    const thread = await new InquiryThreadService(db.pool).raiseNoteAsQuestion(identity(), project.id, {
      note_object_id: note.id,
      statement: PASSAGE,
    }) as { id: string; kind: string; statement: string; lifecycle_status: string };

    expect(thread).toMatchObject({ kind: "question", statement: PASSAGE, lifecycle_status: "active" });
    // The link is a `references` edge in `object_relations` — the same edge
    // `linkNote` writes, not a second mechanism.
    const link = await db.pool.query<{ to_object_id: string; link_type: string }>(
      `SELECT to_object_id, link_type FROM object_relations
        WHERE space_id=$1 AND from_object_id=$2 AND status='active'`,
      [SPACE, thread.id],
    );
    expect(link.rows).toEqual([{ to_object_id: note.id, link_type: "references" }]);
  });

  it("leaves the note alone — raising is not a move either", async () => {
    if (!db.available) return;
    const project = await new PgProjectRepository(db.pool).create(identity(), { name: "P" }) as { id: string };
    const knowledge = new PgKnowledgeRepository(db.pool);
    const note = await knowledge.createNote(identity(), {
      title: "Reading notes", primary_project_id: project.id, plain_text: PASSAGE,
    }) as { id: string; version: number };

    await new InquiryThreadService(db.pool).raiseNoteAsQuestion(identity(), project.id, {
      note_object_id: note.id, statement: PASSAGE,
    });

    const after = await knowledge.getNote(identity(), note.id) as { plain_text: string; version: number };
    expect(after).toMatchObject({ plain_text: PASSAGE, version: note.version });
  });

  it("accepts a hypothesis as well as a question", async () => {
    if (!db.available) return;
    const project = await new PgProjectRepository(db.pool).create(identity(), { name: "P" }) as { id: string };
    const note = await new PgKnowledgeRepository(db.pool).createNote(identity(), {
      title: "Reading notes", primary_project_id: project.id,
    }) as { id: string };

    const thread = await new InquiryThreadService(db.pool).raiseNoteAsQuestion(identity(), project.id, {
      note_object_id: note.id, statement: "Depth is what drives the gain.", kind: "hypothesis",
    }) as { id: string; kind: string };

    expect(thread.kind).toBe("hypothesis");
  });

  it("leaves no Thread behind when the link cannot be made", async () => {
    if (!db.available) return;
    const project = await new PgProjectRepository(db.pool).create(identity(), { name: "P" }) as { id: string };

    // A note id that does not resolve fails the link step, which happens after
    // the Thread insert. Both writes share one transaction, so the Thread must
    // roll back — a Question with no route back to its note is the exact
    // disconnection this action exists to fix.
    await expect(new InquiryThreadService(db.pool).raiseNoteAsQuestion(identity(), project.id, {
      note_object_id: randomUUID(), statement: PASSAGE,
    })).rejects.toThrow();

    expect((await db.pool.query(`SELECT object_id FROM inquiry_threads WHERE space_id=$1`, [SPACE])).rows).toHaveLength(0);
    expect((await db.pool.query(`SELECT id FROM space_objects WHERE space_id=$1 AND object_type='inquiry_thread'`, [SPACE])).rows).toHaveLength(0);
  });

  it("creates no Thread when the note id is missing", async () => {
    if (!db.available) return;
    const project = await new PgProjectRepository(db.pool).create(identity(), { name: "P" }) as { id: string };
    await expect(new InquiryThreadService(db.pool).raiseNoteAsQuestion(identity(), project.id, { statement: PASSAGE }))
      .rejects.toThrow();
    expect((await db.pool.query(`SELECT object_id FROM inquiry_threads WHERE space_id=$1`, [SPACE])).rows).toHaveLength(0);
  });
});
