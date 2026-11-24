import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { useTestDatabase } from "./support/testDatabase.js";
import { resetTables } from "./support/resetTables.js";
import { seedSpaceOwnerProject } from "./support/domainSeeds.js";
import { InquiryThreadService } from "../src/modules/inquiry/threadService.js";
import {
  syncProjectCorpusEvidenceForSourceItem,
  syncProjectCorpusForSourceItem,
} from "../src/modules/projects/corpusRepository.js";

// A Corpus row reaches its Reference by two lineages: a SourceItem row through
// `source_item_references`, and an Evidence row through the Evidence's
// SourceItem. Each lineage carries its own merge statement. Side by side, the
// same duplicate state must produce the same canonical row, provenance and
// moved Signals, and a failure inside either merge must leave nothing behind.

const db = useTestDatabase(import.meta.filename);

type Lineage = "source_item" | "evidence";
const LINEAGES: Lineage[] = ["source_item", "evidence"];

beforeEach(async () => {
  if (!db.available) return;
  await resetTables(db.pool, ["spaces", "users"], { cascade: true });
});

/** One Project holding a canonical Reference row and a duplicate of the given lineage. */
async function seedPair(lineage: Lineage) {
  // Each lineage gets its own Space, so the two merges cannot see each other.
  const SPACE = randomUUID(), OWNER = randomUUID();
  const project = randomUUID(), item = randomUUID(), reference = randomUUID(), canonical = randomUUID(), duplicate = randomUUID();
  await seedSpaceOwnerProject(db.pool, { space: SPACE, owner: OWNER, project, spaceType: "team" });
  const reviewed = "2026-03-01T10:00:00.000Z", read = "2026-03-02T10:00:00.000Z", created = "2026-01-01T00:00:00.000Z";
  await db.pool.query(
    `INSERT INTO source_items (id, space_id, owner_user_id, visibility, item_type, title, first_seen_at, last_seen_at, content_state, retention_policy, created_at, updated_at)
     VALUES ($1,$2,$3,'space_shared','feed_entry','Paper',$4,$4,'excerpt_saved','summary_only',$4,$4)`,
    [item, SPACE, OWNER, created],
  );
  await db.pool.query(`INSERT INTO space_objects (id, space_id, object_type, title, created_at, updated_at) VALUES ($1,$2,'source','Paper',$3,$3)`, [reference, SPACE, created]);
  await db.pool.query(`INSERT INTO sources (object_id, space_id, source_type, uri, metadata_json) VALUES ($1,$2,'paper','https://example.test/paper','{}'::jsonb)`, [reference, SPACE]);
  await db.pool.query(`INSERT INTO source_item_references (source_item_id, space_id, reference_object_id, created_at, updated_at) VALUES ($1,$2,$3,$4,$4)`, [item, SPACE, reference, created]);
  let evidence: string | null = null;
  if (lineage === "evidence") {
    evidence = randomUUID();
    await db.pool.query(
      `INSERT INTO extracted_evidence (id, space_id, owner_user_id, visibility, source_object_type, source_item_id, evidence_type, title, content_excerpt, extraction_method, trust_level, confidence, status, metadata_json, created_at, updated_at)
       VALUES ($1,$2,$3,'space_shared','source_item',$4,'excerpt','Evidence','Excerpt','manual','normal',0.5,'candidate','{}'::jsonb,$5,$5)`,
      [evidence, SPACE, OWNER, item, created],
    );
  }
  await db.pool.query(
    `INSERT INTO project_corpus_items (id, space_id, project_id, object_id, role, status, triage_status, read_status, reason, metadata_json, created_at, updated_at)
     VALUES ($1,$2,$3,$4,'candidate','active','maybe','skimmed','Canonical reason','{}'::jsonb,$5,$5)`,
    [canonical, SPACE, project, reference, created],
  );
  // The person confirmed the duplicate's triage and read it after the canonical row was made.
  await db.pool.query(
    `INSERT INTO project_corpus_items (id, space_id, project_id, source_item_id, evidence_id, role, status, triage_status, triage_confirmed_by_user,
                                       read_status, last_reviewed_at, last_read_at, reason, metadata_json, created_at, updated_at)
     VALUES ($1,$2,$3,$4,$5,'candidate','active','excluded',true,'read',$6,$7,'Duplicate reason','{}'::jsonb,$8,$8)`,
    [duplicate, SPACE, project, lineage === "source_item" ? item : null, evidence, reviewed, read, created],
  );
  const thread = await new InquiryThreadService(db.pool).createThread({ spaceId: SPACE, userId: OWNER }, project, { kind: "hypothesis", statement: "It holds" });
  const signal = randomUUID();
  await db.pool.query(
    `INSERT INTO inquiry_evidence_signals (id, space_id, project_id, thread_id, corpus_item_id, classification, dedupe_key, status, created_at)
     VALUES ($1,$2,$3,$4,$5,'supports',$6,'pending',now())`,
    [signal, SPACE, project, thread.id, duplicate, `signal-${lineage}`],
  );
  const sync = () => lineage === "source_item"
    ? syncProjectCorpusForSourceItem(db.pool, { spaceId: SPACE, sourceItemId: item, projectId: project })
    : syncProjectCorpusEvidenceForSourceItem(db.pool, { spaceId: SPACE, sourceItemId: item, projectId: project });
  return { project, item, canonical, duplicate, signal, sync };
}

/** The Project's Corpus as data a lineage cannot influence: no ids, no write times. */
async function corpusState(pair: Awaited<ReturnType<typeof seedPair>>) {
  const rows = await db.pool.query(
    `SELECT id = $2 AS is_canonical, object_id IS NOT NULL AS has_object, source_item_id, evidence_id IS NOT NULL AS has_evidence,
            status, triage_status, triage_confirmed_by_user, read_status,
            last_reviewed_at::text, last_read_at::text, reason, relevance, confidence, source_decision_id
       FROM project_corpus_items WHERE project_id = $1 ORDER BY is_canonical DESC, id`,
    [pair.project, pair.canonical],
  );
  const provenance = await db.pool.query(
    `SELECT corpus_item_id = $2 AS on_canonical, source_item_id = $3 AS from_item FROM project_corpus_item_sources WHERE project_id = $1 ORDER BY 1, 2`,
    [pair.project, pair.canonical, pair.item],
  );
  const signal = await db.pool.query(`SELECT corpus_item_id = $2 AS on_canonical FROM inquiry_evidence_signals WHERE id = $1`, [pair.signal, pair.canonical]);
  return { rows: rows.rows, provenance: provenance.rows, signal: signal.rows };
}

describe("Corpus merge across both lineages (real Postgres)", () => {
  it("produces the same canonical row, provenance and Signals from a SourceItem or an Evidence duplicate", async (ctx) => {
    if (!db.available) return ctx.skip();
    const results: Record<Lineage, Awaited<ReturnType<typeof corpusState>>> = {} as never;
    for (const lineage of LINEAGES) {
      const pair = await seedPair(lineage);
      await pair.sync();
      results[lineage] = await corpusState(pair);
      // Replaying the sync is a no-op on what the first merge settled.
      await pair.sync();
      expect(await corpusState(pair), `${lineage} replay`).toEqual(results[lineage]);
    }
    expect(results.source_item).toEqual({
      rows: [{
        is_canonical: true, has_object: true, source_item_id: null, has_evidence: false, status: "active",
        triage_status: "excluded", triage_confirmed_by_user: true, read_status: "read",
        last_reviewed_at: "2026-03-01 10:00:00+00", last_read_at: "2026-03-02 10:00:00+00",
        reason: "Canonical reason", relevance: null, confidence: null, source_decision_id: null,
      }],
      provenance: [{ on_canonical: true, from_item: true }],
      signal: [{ on_canonical: true }],
    });
    expect(results.evidence).toEqual(results.source_item);
  });

  async function expectMergeRollback(lineage: Lineage) {
    const pair = await seedPair(lineage);
    const before = await corpusState(pair);
    await db.pool.query("CREATE FUNCTION refuse_signal_move() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'signal move refused'; END $$");
    await db.pool.query("CREATE TRIGGER refuse_signal_move BEFORE UPDATE ON inquiry_evidence_signals FOR EACH ROW EXECUTE FUNCTION refuse_signal_move()");
    try {
      await expect(pair.sync()).rejects.toThrow(/signal move refused/);
    } finally {
      await db.pool.query("DROP TRIGGER refuse_signal_move ON inquiry_evidence_signals");
      await db.pool.query("DROP FUNCTION refuse_signal_move()");
    }
    expect(await corpusState(pair)).toEqual(before);
    expect(before.rows).toHaveLength(2);
  }

  it("rolls back the whole SourceItem merge when moving a Signal fails", async (ctx) => {
    if (!db.available) return ctx.skip();
    await expectMergeRollback("source_item");
  });

  it("rolls back the whole Evidence merge when moving a Signal fails", async (ctx) => {
    if (!db.available) return ctx.skip();
    await expectMergeRollback("evidence");
  });
});
