import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { __setAuthIdentityForTests } from "../src/modules/auth/identity.js";
import { PgKnowledgeRepository } from "../src/modules/knowledge/repository.js";
import { PgProposalApplyService } from "../src/modules/proposals/applyService.js";
import { loadConfig } from "../src/config.js";
import { useTestDatabase } from "./support/testDatabase.js";
import { resetTables } from "./support/resetTables.js";
import { seedMainlineRoomsForAllProjects } from "./support/domainSeeds.js";

// ND: promoting a passage produces a knowledge item whose provenance records
// the originating Note, and the Note is unchanged. "This knowledge came from
// my note" was not expressible before — `knowledge_item_sources` has a hard FK
// to `sources(object_id)`, and a Note is a `notes` row.

const SPACE = "11111111-1111-4111-8111-111111111111";
const USER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
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

beforeEach(async () => {
  if (!db.available) return;
  await resetTables(
    db.pool,
    ["provenance_links", "knowledge_items", "notes", "space_objects", "proposals", "projects", "space_memberships", "users", "spaces"],
    { cascade: true },
  );
  const now = new Date().toISOString();
  await db.pool.query(`INSERT INTO spaces (id,name,type,created_at,updated_at) VALUES ($1,'Space','personal',$2,$2)`, [SPACE, now]);
  await db.pool.query(`INSERT INTO users (id,display_name,status,created_at,updated_at) VALUES ($1,'Owner','active',$2,$2)`, [USER, now]);
  await db.pool.query(`INSERT INTO space_memberships (id,space_id,user_id,role,status,created_at,updated_at) VALUES ($1,$2,$3,'owner','active',$4,$4)`, [randomUUID(), SPACE, USER, now]);
  await db.pool.query(
    `INSERT INTO projects (id,space_id,name,status,owner_user_id,created_at,updated_at) VALUES ($1,$2,'Project','active',$3,$4,$4)`,
    [PROJECT, SPACE, USER, now],
  );
  await seedMainlineRoomsForAllProjects(db.pool);
});

const identity = { spaceId: SPACE, userId: USER };
const PASSAGE = "Residual connections are what make depth trainable.";

describe("promote a note passage to knowledge (real Postgres)", () => {
  it("routes through the proposal gate rather than writing an item directly", async () => {
    if (!db.available) return;
    const repository = new PgKnowledgeRepository(db.pool);
    const note = await repository.createNote(identity, {
      title: "Reading notes", primary_project_id: PROJECT, plain_text: PASSAGE,
    }) as { id: string };

    const proposal = await repository.promoteNoteToKnowledge(identity, note.id, { content: PASSAGE });

    expect(proposal.proposal_type).toBe("knowledge_create");
    expect(proposal.status).toBe("pending");
    // Nothing exists yet — promotion proposes, it does not create.
    expect((await db.pool.query(`SELECT object_id FROM knowledge_items WHERE space_id=$1`, [SPACE])).rows).toHaveLength(0);
  });

  it("records the originating note as provenance once approved", async () => {
    if (!db.available) return;
    const repository = new PgKnowledgeRepository(db.pool);
    const note = await repository.createNote(identity, {
      title: "Reading notes", primary_project_id: PROJECT, plain_text: PASSAGE,
    }) as { id: string };
    const proposal = await repository.promoteNoteToKnowledge(identity, note.id, { content: PASSAGE });

    // Accepted through the real gate, not by calling the applier directly —
    // the point of ND is that promotion changes nothing about governance.
    const config = loadConfig({
      SERVER_DATABASE_URL: db.connectionUri,
      SERVER_INTERNAL_TOKEN: "test-internal-token",
    });
    await PgProposalApplyService.fromConfig(config).accept(proposal.id, identity);

    const item = (await db.pool.query<{ id: string }>(
      `SELECT object_id AS id FROM knowledge_items WHERE space_id=$1`, [SPACE],
    )).rows[0];
    expect(item).toBeTruthy();
    const provenance = await db.pool.query<{ source_type: string; source_id: string }>(
      `SELECT source_type, source_id FROM provenance_links
        WHERE space_id=$1 AND target_type='knowledge' AND target_id=$2`,
      [SPACE, item!.id],
    );
    expect(provenance.rows).toContainEqual({ source_type: "note", source_id: note.id });
  });

  it("leaves the note's content untouched — promotion is not a move", async () => {
    if (!db.available) return;
    const repository = new PgKnowledgeRepository(db.pool);
    const note = await repository.createNote(identity, {
      title: "Reading notes", primary_project_id: PROJECT, plain_text: PASSAGE,
    }) as { id: string; version: number };

    await repository.promoteNoteToKnowledge(identity, note.id, { content: PASSAGE });

    const after = await repository.getNote(identity, note.id) as { plain_text: string; version: number; status: string };
    expect(after).toMatchObject({ plain_text: PASSAGE, version: note.version, status: "active" });
  });

  it("promotes the selected passage, not the note's whole text", async () => {
    if (!db.available) return;
    const repository = new PgKnowledgeRepository(db.pool);
    const note = await repository.createNote(identity, {
      title: "Reading notes", primary_project_id: PROJECT,
      plain_text: `${PASSAGE}\n\nA second, unrelated idea.`,
    }) as { id: string };

    const proposal = await repository.promoteNoteToKnowledge(identity, note.id, { content: PASSAGE });

    const payload = (await db.pool.query<{ payload_json: { content: string; project_id?: string; source_refs: Array<{ source_type: string; source_id: string }> } }>(
      `SELECT payload_json FROM proposals WHERE id=$1`, [proposal.id],
    )).rows[0]!.payload_json;
    expect(payload.content).toBe(PASSAGE);
    expect(payload.content).not.toContain("unrelated idea");
    // The item lands in the Project the note belongs to.
    expect(payload.project_id).toBe(PROJECT);
    // The provenance carries the passage, not the note's whole body.
    expect(payload.source_refs).toContainEqual(expect.objectContaining({ source_type: "note", source_id: note.id }));
  });

  it("shows the note what it produced, once the promotion is approved", async () => {
    if (!db.available) return;
    const repository = new PgKnowledgeRepository(db.pool);
    const note = await repository.createNote(identity, {
      title: "Reading notes", primary_project_id: PROJECT, plain_text: PASSAGE,
    }) as { id: string };
    const proposal = await repository.promoteNoteToKnowledge(identity, note.id, { content: PASSAGE });

    // Nothing to show while the proposal is still pending — promotion
    // proposes, so the note has not produced anything yet.
    expect(await repository.knowledgeItemsPromotedFromNote(identity, note.id)).toEqual([]);

    const config = loadConfig({
      SERVER_DATABASE_URL: db.connectionUri,
      SERVER_INTERNAL_TOKEN: "test-internal-token",
    });
    await PgProposalApplyService.fromConfig(config).accept(proposal.id, identity);

    const produced = await repository.knowledgeItemsPromotedFromNote(identity, note.id) as Array<{ title: string }>;
    expect(produced).toHaveLength(1);
    expect(produced[0]!.title).toBe("Reading notes");
  });

  it("refuses to promote from a note the caller cannot see", async () => {
    if (!db.available) return;
    const repository = new PgKnowledgeRepository(db.pool);
    await expect(repository.promoteNoteToKnowledge(identity, randomUUID(), { content: PASSAGE }))
      .rejects.toThrow(/Note not found/);
  });
});
