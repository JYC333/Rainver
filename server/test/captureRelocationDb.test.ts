import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { CaptureService } from "../src/modules/capture/service.js";
import { RelocationService } from "../src/modules/capture/relocationService.js";
import { PgKnowledgeRepository } from "../src/modules/knowledge/repository.js";
import { PgSpaceRepository } from "../src/modules/spaces/repository.js";
import { noteBlocks } from "../src/modules/knowledge/noteBlockIds.js";
import { useTestDatabase } from "./support/testDatabase.js";
import { resetTables } from "./support/resetTables.js";

/**
 * Relocation and promotion (ADR 0013 amendment D7).
 *
 * Two rules carry the privacy weight and are asserted from both sides: a member
 * may not take a colleague's contribution out of the team's Space, and copying
 * out is off until the Space says otherwise.
 */

const OWNER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const MATE = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const OWNER_PERSONAL = "11111111-1111-4111-8111-111111111111";
const MATE_PERSONAL = "22222222-2222-4222-8222-222222222222";
const TEAM = "33333333-3333-4333-8333-333333333333";
const PROJECT = "44444444-4444-4444-8444-444444444444";


const db = useTestDatabase(import.meta.filename, { max: 4 });

beforeEach(async () => {
  if (!db.available) return;
  await resetTables(
    db.pool,
    ["notes", "note_collections", "note_collection_items", "note_links", "note_revisions", "activity_records", "space_member_notifications", "space_objects", "project_members", "projects", "space_memberships", "users", "spaces"],
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
            ($3,$8,$6,'member','active',$9,$9),
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
});

const capture = () => new CaptureService(db.pool);
const relocation = () => new RelocationService(db.pool);

async function marginalia(userId: string, text: string) {
  return capture().capture({
    userId, requestSpaceId: TEAM, destination: "project_marginalia", text, projectId: PROJECT,
  });
}

async function noteText(noteId: string, userId: string) {
  const note = await new PgKnowledgeRepository(db.pool).getNote({ spaceId: TEAM, userId }, noteId);
  return noteBlocks((note as { content_json: unknown }).content_json);
}

describe("relocation preview (real Postgres)", () => {
  it("preselects the anchored block and offers the orphans after it", async () => {
    if (!db.available) return;
    const first = await marginalia(OWNER, "The control group is wrong.");
    const identity = { spaceId: TEAM, userId: OWNER };
    const repository = new PgKnowledgeRepository(db.pool);

    // The user writes two further lines beside the capture, then captures again.
    const note = await repository.getNote(identity, first.note_id!) as { content_json: { content: unknown[] }; version: number };
    await repository.updateNote(identity, first.note_id!, {
      content_json: {
        ...note.content_json,
        content: [
          ...note.content_json.content,
          { type: "paragraph", content: [{ type: "text", text: "because the baseline drifted" }] },
        ],
      },
      expect_version: note.version,
    });
    const second = await marginalia(OWNER, "Unrelated later thought.");

    const preview = await relocation().preview({ userId: OWNER, activityId: first.activity_id });

    expect(preview.blocks[0]).toMatchObject({ block_id: first.block_id, anchored: true });
    expect(preview.blocks[1]).toMatchObject({ text: "because the baseline drifted", anchored: false });
    // Stops at the next capture's anchor: that is a different thought.
    expect(preview.blocks.map(block => block.block_id)).not.toContain(second.block_id);
    expect(preview.can_move).toBe(true);
    expect(preview.can_copy_out).toBe(false);
  });
});

describe("promotion to team material (real Postgres)", () => {
  it("carries the note's current text, not the capture snapshot", async () => {
    if (!db.available) return;
    const captured = await marginalia(OWNER, "First wording.");
    const identity = { spaceId: TEAM, userId: OWNER };
    const repository = new PgKnowledgeRepository(db.pool);

    // The user edits the paragraph after capturing. The snapshot is provenance
    // and is allowed to drift; taking it as authority would discard this edit.
    const note = await repository.getNote(identity, captured.note_id!) as { content_json: { content: Record<string, unknown>[] }; version: number };
    const edited = note.content_json.content.map(block => ({
      ...block,
      content: [{ type: "text", text: "Corrected wording." }],
    }));
    await repository.updateNote(identity, captured.note_id!, {
      content_json: { ...note.content_json, content: edited },
      expect_version: note.version,
    });

    const result = await relocation().relocate({
      userId: OWNER, requestSpaceId: TEAM, activityId: captured.activity_id,
      destination: "project_raw", mode: "move", blockIds: [captured.block_id!], projectId: PROJECT,
    });

    const promoted = await db.pool.query(
      `SELECT content, visibility, status FROM activity_records WHERE id = $1`, [result.activity_id],
    );
    expect(promoted.rows[0].content).toBe("Corrected wording.");
    expect(promoted.rows[0].visibility).toBe("space_shared");
    expect(promoted.rows[0].status).toBe("raw");
  });

  it("takes the block out of the private note on a move", async () => {
    if (!db.available) return;
    const captured = await marginalia(OWNER, "Promote me.");
    await marginalia(OWNER, "Keep me.");

    await relocation().relocate({
      userId: OWNER, requestSpaceId: TEAM, activityId: captured.activity_id,
      destination: "project_raw", mode: "move", blockIds: [captured.block_id!], projectId: PROJECT,
    });

    const blocks = await noteText(captured.note_id!, OWNER);
    expect(blocks.map(block => block.text)).not.toContain("Promote me.");
    expect(blocks.map(block => block.text)).toContain("Keep me.");
  });

  it("leaves the block in place on a copy", async () => {
    if (!db.available) return;
    const captured = await marginalia(OWNER, "Copy me.");

    await relocation().relocate({
      userId: OWNER, requestSpaceId: TEAM, activityId: captured.activity_id,
      destination: "project_raw", mode: "copy", blockIds: [captured.block_id!], projectId: PROJECT,
    });

    const blocks = await noteText(captured.note_id!, OWNER);
    expect(blocks.map(block => block.text)).toContain("Copy me.");
  });
});

describe("moving out of a Space (real Postgres)", () => {
  it("lets the owner take their own misfiled capture back to their personal inbox", async () => {
    if (!db.available) return;
    const captured = await marginalia(OWNER, "Meant this to be personal.");

    const result = await relocation().relocate({
      userId: OWNER, requestSpaceId: TEAM, activityId: captured.activity_id,
      destination: "personal_inbox", mode: "move", blockIds: [captured.block_id!],
    });

    const moved = await db.pool.query(
      `SELECT space_id, project_id, visibility FROM activity_records WHERE id = $1`, [result.activity_id],
    );
    expect(moved.rows[0]).toMatchObject({ space_id: OWNER_PERSONAL, project_id: null, visibility: "private" });
    const blocks = await noteText(captured.note_id!, OWNER);
    expect(blocks.map(block => block.text)).not.toContain("Meant this to be personal.");
  });

  it("refuses to let a member move a colleague's capture out", async () => {
    if (!db.available) return;
    // The Owner's marginalia, but shared into the Project so the Mate can
    // genuinely read it — otherwise the refusal would come from the read gate
    // and prove nothing about the move rule. This is the promotion case: team
    // material that the Owner, not the Mate, contributed.
    const theirs = await marginalia(OWNER, "Owner's thought.");
    await db.pool.query(
      `UPDATE space_objects SET visibility = 'space_shared' WHERE id = $1`, [theirs.note_id],
    );
    await db.pool.query(
      `UPDATE activity_records SET visibility = 'space_shared' WHERE id = $1`, [theirs.activity_id],
    );

    await expect(relocation().relocate({
      userId: MATE, requestSpaceId: TEAM, activityId: theirs.activity_id,
      destination: "personal_inbox", mode: "move", blockIds: [theirs.block_id!],
    })).rejects.toMatchObject({ statusCode: 403 });

    const still = await db.pool.query(`SELECT space_id FROM activity_records WHERE id = $1`, [theirs.activity_id]);
    expect(still.rows[0].space_id).toBe(TEAM);
  });

  it("lets the Project's owner administer a member's capture", async () => {
    if (!db.available) return;
    // The Mate's marginalia, shared. The Owner owns the Project, so they may
    // move it — being able to contribute is not authority over others' content,
    // but administering the Project is.
    const theirs = await capture().capture({
      userId: MATE, requestSpaceId: TEAM, destination: "project_marginalia",
      text: "Mate's thought.", projectId: PROJECT,
    });
    await db.pool.query(`UPDATE space_objects SET visibility = 'space_shared' WHERE id = $1`, [theirs.note_id]);
    await db.pool.query(`UPDATE activity_records SET visibility = 'space_shared' WHERE id = $1`, [theirs.activity_id]);

    const result = await relocation().relocate({
      userId: OWNER, requestSpaceId: TEAM, activityId: theirs.activity_id,
      destination: "project_raw", mode: "move", blockIds: [theirs.block_id!], projectId: PROJECT,
    });
    expect(result.mode).toBe("move");
  });

  it("lets you copy your own capture out without asking the Space", async () => {
    if (!db.available) return;
    const captured = await marginalia(OWNER, "Copy out?");

    // Your own content, so the Space setting does not enter into it.
    const result = await relocation().relocate({
      userId: OWNER, requestSpaceId: TEAM, activityId: captured.activity_id,
      destination: "personal_inbox", mode: "copy", blockIds: [captured.block_id!],
    });

    const copied = await db.pool.query(`SELECT space_id FROM activity_records WHERE id = $1`, [result.activity_id]);
    expect(copied.rows[0].space_id).toBe(OWNER_PERSONAL);
    // The original stays put — a copy is a second holder, not a loss.
    const blocks = await noteText(captured.note_id!, OWNER);
    expect(blocks.map(block => block.text)).toContain("Copy out?");
  });

  it("refuses to copy a colleague's content out until the Space allows it", async () => {
    if (!db.available) return;
    const theirs = await capture().capture({
      userId: MATE, requestSpaceId: TEAM, destination: "project_marginalia",
      text: "Mate's contribution.", projectId: PROJECT,
    });
    await db.pool.query(`UPDATE space_objects SET visibility = 'space_shared' WHERE id = $1`, [theirs.note_id]);
    await db.pool.query(`UPDATE activity_records SET visibility = 'space_shared' WHERE id = $1`, [theirs.activity_id]);

    await expect(relocation().relocate({
      userId: OWNER, requestSpaceId: TEAM, activityId: theirs.activity_id,
      destination: "personal_inbox", mode: "copy", blockIds: [theirs.block_id!],
    })).rejects.toMatchObject({ statusCode: 403 });

    await db.pool.query(`UPDATE spaces SET member_copy_out_enabled = true WHERE id = $1`, [TEAM]);
    const result = await relocation().relocate({
      userId: OWNER, requestSpaceId: TEAM, activityId: theirs.activity_id,
      destination: "personal_inbox", mode: "copy", blockIds: [theirs.block_id!],
    });
    const copied = await db.pool.query(`SELECT space_id FROM activity_records WHERE id = $1`, [result.activity_id]);
    expect(copied.rows[0].space_id).toBe(OWNER_PERSONAL);
  });

  it("announces a copy out to the other members when the Space asks for it", async () => {
    if (!db.available) return;
    await db.pool.query(`UPDATE spaces SET egress_notifications_enabled = true WHERE id = $1`, [TEAM]);
    const captured = await marginalia(OWNER, "Watch this leave.");

    await relocation().relocate({
      userId: OWNER, requestSpaceId: TEAM, activityId: captured.activity_id,
      destination: "personal_inbox", mode: "copy", blockIds: [captured.block_id!],
    });

    const notifications = await db.pool.query(
      `SELECT recipient_user_id, event_type, pointer_metadata_json FROM space_member_notifications`,
    );
    expect(notifications.rows).toHaveLength(1);
    expect(notifications.rows[0]).toMatchObject({ recipient_user_id: MATE, event_type: "content_egress" });
    // Pointer metadata only — decision 11 makes this non-negotiable, or the
    // notification becomes a leak channel of its own.
    expect(JSON.stringify(notifications.rows[0].pointer_metadata_json)).not.toContain("Watch this leave");
  });
});

describe("the Space boundary (real Postgres)", () => {
  /**
   * The gate has to key on where the content *lands*, not on what the
   * destination is called. `personal_inbox` is not the only destination that
   * can leave the Space: every Project destination resolves its Space from the
   * caller's `project_id`, so naming a Project in another Space is a crossing
   * under a destination label that reads as staying put.
   */
  const OTHER_SPACE = "55555555-5555-4555-8555-555555555555";
  const OTHER_PROJECT = "66666666-6666-4666-8666-666666666666";

  async function giveOwnerASecondSpace() {
    const now = new Date().toISOString();
    await db.pool.query(
      `INSERT INTO spaces (id, name, type, created_by_user_id, created_at, updated_at)
       VALUES ($1,'Other team','team',$2,$3,$3)`,
      [OTHER_SPACE, OWNER, now],
    );
    await db.pool.query(
      `INSERT INTO space_memberships (id, space_id, user_id, role, status, created_at, updated_at)
       VALUES ($1,$2,$3,'owner','active',$4,$4)`,
      [randomUUID(), OTHER_SPACE, OWNER, now],
    );
    await db.pool.query(
      `INSERT INTO projects (id, space_id, name, status, owner_user_id, created_at, updated_at)
       VALUES ($1,$2,'Elsewhere','active',$3,$4,$4)`,
      [OTHER_PROJECT, OTHER_SPACE, OWNER, now],
    );
  }

  it("refuses a colleague's content crossing into a Project in another Space", async () => {
    if (!db.available) return;
    await giveOwnerASecondSpace();
    // The attack shape: the request Space header names the *destination*, which
    // is what makes the destination Project resolvable at all. `loadCapture`
    // requires membership in the capture's Space, not in the request Space, so
    // a capture in Team still loads. Gating on the destination *name* would let
    // this through — `project_marginalia` reads as staying put.
    const theirs = await capture().capture({
      userId: MATE, requestSpaceId: TEAM, destination: "project_marginalia",
      text: "Mate's contribution.", projectId: PROJECT,
    });
    await db.pool.query(`UPDATE space_objects SET visibility = 'space_shared' WHERE id = $1`, [theirs.note_id]);
    await db.pool.query(`UPDATE activity_records SET visibility = 'space_shared' WHERE id = $1`, [theirs.activity_id]);

    await expect(relocation().relocate({
      userId: OWNER, requestSpaceId: OTHER_SPACE, activityId: theirs.activity_id,
      destination: "project_marginalia", mode: "copy",
      blockIds: [theirs.block_id!], projectId: OTHER_PROJECT,
    })).rejects.toMatchObject({ statusCode: 403 });

    const landed = await db.pool.query(`SELECT id FROM activity_records WHERE space_id = $1`, [OTHER_SPACE]);
    expect(landed.rows).toHaveLength(0);
  });

  it("announces your own content crossing into another Space, and lands it there", async () => {
    if (!db.available) return;
    await giveOwnerASecondSpace();
    await db.pool.query(`UPDATE spaces SET egress_notifications_enabled = true WHERE id = $1`, [TEAM]);
    const captured = await marginalia(OWNER, "Moving this elsewhere.");

    const result = await relocation().relocate({
      userId: OWNER, requestSpaceId: OTHER_SPACE, activityId: captured.activity_id,
      destination: "project_marginalia", mode: "move",
      blockIds: [captured.block_id!], projectId: OTHER_PROJECT,
    });

    const landed = await db.pool.query(`SELECT space_id FROM activity_records WHERE id = $1`, [result.activity_id]);
    expect(landed.rows[0].space_id).toBe(OTHER_SPACE);
    // A move across the boundary is an egress and is announced like one — the
    // destination being a Project rather than the personal inbox changes
    // nothing about the crossing.
    const notifications = await db.pool.query(
      `SELECT recipient_user_id FROM space_member_notifications WHERE space_id = $1`, [TEAM],
    );
    expect(notifications.rows.map(row => row.recipient_user_id)).toEqual([MATE]);
  });

  it("leaves an in-Space promotion ungated — nothing crosses a boundary", async () => {
    if (!db.available) return;
    const captured = await marginalia(OWNER, "Stays here.");

    // Copy-out is off, and that is irrelevant: the destination is the same
    // Space, so this is decision 4's ladder, not egress.
    const result = await relocation().relocate({
      userId: OWNER, requestSpaceId: TEAM, activityId: captured.activity_id,
      destination: "project_raw", mode: "copy", blockIds: [captured.block_id!], projectId: PROJECT,
    });

    const landed = await db.pool.query(`SELECT space_id FROM activity_records WHERE id = $1`, [result.activity_id]);
    expect(landed.rows[0].space_id).toBe(TEAM);
    expect((await db.pool.query(`SELECT id FROM space_member_notifications`)).rows).toHaveLength(0);
  });
});

describe("concurrent edits during relocation (real Postgres)", () => {
  it("waits for an in-flight edit and carries the winning text, not the stale one", async () => {
    if (!db.available) return;
    const captured = await marginalia(OWNER, "Original wording.");
    const identity = { spaceId: TEAM, userId: OWNER };
    const repository = new PgKnowledgeRepository(db.pool);
    const note = await repository.getNote(identity, captured.note_id!) as { content_json: { content: Record<string, unknown>[] }; version: number };

    // A genuinely concurrent edit: a second connection takes the note's row
    // lock and *holds it* while the relocation starts. Without `lockNote` the
    // relocation would read the pre-edit text through its own snapshot, carry
    // that, and delete the post-edit block — losing the other write silently.
    // Sequencing the two would prove nothing, because a committed edit is
    // visible to a later read either way.
    const rival = await db.pool.connect();
    let relocatePromise: Promise<unknown>;
    try {
      await rival.query("BEGIN");
      await rival.query(`SELECT object_id FROM notes WHERE object_id = $1 FOR UPDATE`, [captured.note_id]);

      relocatePromise = relocation().relocate({
        userId: OWNER, requestSpaceId: TEAM, activityId: captured.activity_id,
        destination: "project_raw", mode: "move", blockIds: [captured.block_id!], projectId: PROJECT,
      });

      // Wait for the relocation to reach the lock and block on it. If it never
      // blocks, it has already read the note and this test is not testing what
      // it claims.
      //
      // Scoped to this database and polled rather than slept. `pg_stat_activity`
      // is cluster-wide and the suite runs many files in parallel against one
      // shared container, each with its own database — an unscoped count would
      // be satisfied by some other file's backend and pass for the wrong
      // reason. And a fixed sleep contradicts the timeout this config already
      // carries: a test can sit behind contention far longer than it takes in
      // isolation.
      const blocked = async () => (await db.pool.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM pg_stat_activity
          WHERE datname = current_database()
            AND pid <> pg_backend_pid()
            AND wait_event_type = 'Lock'
            AND state = 'active'`,
      )).rows[0]!.count !== "0";
      const deadline = Date.now() + 10_000;
      while (!(await blocked()) && Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 25));
      }
      expect(await blocked()).toBe(true);

      await rival.query(
        `UPDATE notes SET content_json = $2::jsonb, version = version + 1 WHERE object_id = $1`,
        [captured.note_id, JSON.stringify({
          ...note.content_json,
          content: note.content_json.content.map(block => ({ ...block, content: [{ type: "text", text: "Edited by someone else." }] })),
        })],
      );
      await rival.query("COMMIT");
    } finally {
      rival.release();
    }

    const result = await relocatePromise as { activity_id: string };
    // It waited, then read the winner.
    const promoted = await db.pool.query(`SELECT content FROM activity_records WHERE id = $1`, [result.activity_id]);
    expect(promoted.rows[0].content).toBe("Edited by someone else.");
  });
});

describe("relocation selection (real Postgres)", () => {
  it("refuses a block the preview never offered", async () => {
    if (!db.available) return;
    const mine = await marginalia(OWNER, "Mine.");
    const later = await marginalia(OWNER, "A separate thought.");

    // `later`'s block is a different capture's anchor, past the boundary.
    await expect(relocation().relocate({
      userId: OWNER, requestSpaceId: TEAM, activityId: mine.activity_id,
      destination: "project_raw", mode: "move", blockIds: [later.block_id!], projectId: PROJECT,
    })).rejects.toMatchObject({ statusCode: 422 });
  });
});

describe("the copy-out Space setting (real Postgres)", () => {
  /**
   * The setting is useless without a way to change it. Before this route the
   * only way to enable copy-out was raw SQL, so the capability shipped
   * permanently off and no test noticed — they all reached around the app.
   */
  it("is off by default, readable by a member, and changed only by an owner or admin", async () => {
    if (!db.available) return;
    const repository = new PgSpaceRepository(db.pool);

    expect(await repository.getContentEgressSetting(MATE, TEAM))
      .toMatchObject({ member_copy_out_enabled: false });

    // The Mate is an ordinary member of the Team Space.
    expect(await repository.updateContentEgressSetting(MATE, TEAM, true))
      .toMatchObject({ statusCode: 403 });

    await db.pool.query(`UPDATE space_memberships SET role = 'owner' WHERE space_id = $1 AND user_id = $2`, [TEAM, OWNER]);
    expect(await repository.updateContentEgressSetting(OWNER, TEAM, true))
      .toMatchObject({ member_copy_out_enabled: true });
    expect(await repository.getContentEgressSetting(MATE, TEAM))
      .toMatchObject({ member_copy_out_enabled: true });
  });

  it("refuses a non-member outright", async () => {
    if (!db.available) return;
    const outsider = randomUUID();
    await db.pool.query(
      `INSERT INTO users (id, display_name, status, created_at, updated_at) VALUES ($1,'Outsider','active',now(),now())`,
      [outsider],
    );
    expect(await new PgSpaceRepository(db.pool).getContentEgressSetting(outsider, TEAM))
      .toMatchObject({ statusCode: 403 });
  });
});
