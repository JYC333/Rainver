import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { getTestPostgres, isTestPostgresUnavailableError, type TestPostgresDatabase } from "./support/sharedPostgres";
import { migrate } from "../src/db/migrator";
import { ProjectCorpusRepository, syncProjectCorpusForSourceItem } from "../src/modules/projects/corpusRepository";
import { materializeProjectSourceItemLinks } from "../src/modules/projects/projectSourceRoutingService";
import type { SpaceUserIdentity } from "../src/modules/routeUtils/common";

// Real-Postgres coverage for Academic Research project corpus behavior:
// Project Corpus DTOs carry joined academic paper metadata, a human's
// explicit triage decision is durable against AI screening-decision sync
// (triage_confirmed_by_user), and project corpus read state never touches
// the personal Library read state on the same source item.

const MIGRATIONS_DIR = join(process.cwd(), "migrations");
const SPACE = "11111111-1111-4111-8111-111111111111";
const OWNER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const SAME_SPACE_MEMBER = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const PROJECT = "55555555-5555-4555-8555-555555555555";
const CONNECTOR = "33333333-3333-4333-8333-333333333333";
const CONNECTION = "44444444-4444-4444-8444-444444444444";
const AGENT = "66666666-6666-4666-8666-666666666666";
const PP_RUN = "77777777-7777-4777-8777-777777777777";

let container: TestPostgresDatabase | undefined;
let pool: Pool | undefined;
let available = false;

beforeAll(async () => {
  try {
    container = await getTestPostgres(__filename);
    pool = new Pool({ connectionString: container.getConnectionUri(), max: 3 });
    await migrate(pool, MIGRATIONS_DIR);
    available = true;
  } catch (err) {
    if (!isTestPostgresUnavailableError(err)) throw err;
    console.warn(`[project-corpus-academic-db] skipped — Docker/Postgres unavailable: ${err instanceof Error ? err.message : String(err)}`);
  }
}, 180_000);

afterAll(async () => {
  await pool?.end();
  await container?.stop();
});

beforeEach(async () => {
  if (!available || !pool) return;
  await pool.query(
    `TRUNCATE academic_papers, sources, space_objects, project_corpus_items, source_item_user_states,
       source_post_processing_item_decisions, source_post_processing_runs, agents, project_source_item_links,
       project_source_bindings, source_channel_item_links, source_channel_user_subscriptions, source_channels,
       source_items, source_connections, source_provider_connectors, source_providers, source_connectors, project_members, projects,
       space_memberships, users, spaces CASCADE`,
  );
  const now = new Date().toISOString();
  await pool.query(`INSERT INTO spaces (id, name, type, created_at, updated_at) VALUES ($1,'Main','personal',$2,$2)`, [SPACE, now]);
  await pool.query(`INSERT INTO users (id, display_name, status, created_at, updated_at) VALUES ($1,$1,'active',$2,$2)`, [OWNER, now]);
  await pool.query(
    `INSERT INTO space_memberships (id, space_id, user_id, role, status, created_at, updated_at)
     VALUES ($1,$2,$3,'owner','active',$4,$4)`,
    [randomUUID(), SPACE, OWNER, now],
  );
  await pool.query(
    `INSERT INTO projects (id, space_id, owner_user_id, name, status, created_at, updated_at)
     VALUES ($1,$2,$3,'Research','active',$4,$4)`,
    [PROJECT, SPACE, OWNER, now],
  );
  await pool.query(
    `INSERT INTO source_connectors (
       id, connector_key, display_name, connector_type, ingestion_mode, status,
       capabilities_json, created_at, updated_at
     ) VALUES ($1,'arxiv','arXiv','external_feed','pull','active','{}'::jsonb,$2,$2)`,
    [CONNECTOR, now],
  );
  await pool.query(
    `INSERT INTO source_providers (id, provider_key, display_name, provider_kind, category, status, capabilities_json, created_at, updated_at)
     VALUES ($1,'arxiv','arXiv','named','academic','active','{}'::jsonb,$2,$2)`,
    [CONNECTOR, now],
  );
  const mappingId = randomUUID();
  await pool.query(
    `INSERT INTO source_provider_connectors (id, provider_id, connector_id, status, priority, capabilities_json, created_at, updated_at)
     VALUES ($1,$2,$3,'active',0,'{}'::jsonb,$4,$4)`,
    [mappingId, CONNECTOR, CONNECTOR, now],
  );
  await pool.query(
    `INSERT INTO source_connections (
       id, space_id, provider_connector_id, owner_user_id, name, status,
       capture_policy, trust_level, consent_json, policy_json, config_json, created_at, updated_at
     ) VALUES ($1,$2,$3,$4,'arXiv feed','active','reference_only','normal',$5::jsonb,$6::jsonb,'{}'::jsonb,$7,$7)`,
    [
      CONNECTION,
      SPACE,
      mappingId,
      OWNER,
      JSON.stringify({
        schema_version: 1,
        owner_user_id: OWNER,
        allowed_reader_user_ids: [],
        allowed_agent_ids: [],
        allow_space_admins: true,
        allow_local_provider_egress: true,
        allow_external_model_egress: true,
      }),
      JSON.stringify({ schema_version: 1, source_egress_class: "external_provider_allowed" }),
      now,
    ],
  );
  // Source connections created through the product repository subscribe their
  // creator. This direct SQL fixture must model that delivery state too, or
  // Project Corpus correctly hides the linked source item.
  await pool.query(
    `INSERT INTO source_channels (
       id, space_id, source_connection_id, created_by_user_id, name, channel_type, endpoint_url,
       query_json, provider_query_json, query_fingerprint, status, fetch_frequency, schedule_rule_json, created_at, updated_at
     ) VALUES ($1,$2,$1,$3,'arXiv Channel','search','https://export.arxiv.org/api/query','{}'::jsonb,'{}'::jsonb,$1,'active','daily','{"frequency":"daily","hour":0,"minute":0}'::jsonb,$4,$4)`,
    [CONNECTION, SPACE, OWNER, now],
  );
  await pool.query(
    `INSERT INTO source_channel_user_subscriptions (
       id, space_id, source_channel_id, user_id, status,
       library_enabled, digest_enabled, created_at, updated_at
     ) VALUES ($1, $2, $3, $4, 'subscribed', true, true, $5, $5)`,
    [randomUUID(), SPACE, CONNECTION, OWNER, now],
  );
});

function repo(): ProjectCorpusRepository {
  return new ProjectCorpusRepository(pool!);
}

const identity: SpaceUserIdentity = { spaceId: SPACE, userId: OWNER };

async function makeSharedSpace(): Promise<void> {
  await pool!.query(`UPDATE spaces SET type = 'team' WHERE id = $1`, [SPACE]);
}

async function addSpaceMember(userId: string): Promise<void> {
  const now = new Date().toISOString();
  await pool!.query(`INSERT INTO users (id, display_name, status, created_at, updated_at) VALUES ($1,$1,'active',$2,$2)`, [
    userId,
    now,
  ]);
  await pool!.query(
    `INSERT INTO space_memberships (id, space_id, user_id, role, status, created_at, updated_at)
     VALUES ($1,$2,$3,'member','active',$4,$4)`,
    [randomUUID(), SPACE, userId, now],
  );
}

async function seedPaperCorpusItem(): Promise<{ objectId: string; sourceItemId: string; corpusItemId: string }> {
  const now = new Date().toISOString();
  const sourceItemId = randomUUID();
  await pool!.query(
    `INSERT INTO source_items (
       id, space_id, owner_user_id, visibility, connection_id, item_type, title, first_seen_at, last_seen_at,
       content_state, retention_policy, created_at, updated_at
     ) VALUES ($1,$2,$3,'space_shared',$4,'feed_entry','Paper A',$5,$5,'excerpt_saved','summary_only',$5,$5)`,
    [sourceItemId, SPACE, OWNER, CONNECTION, now],
  );
  const objectId = randomUUID();
  await pool!.query(
    `INSERT INTO space_objects (id, space_id, object_type, title, created_at, updated_at)
     VALUES ($1,$2,'source','Paper A',$3,$3)`,
    [objectId, SPACE, now],
  );
  await pool!.query(
    `INSERT INTO sources (object_id, space_id, source_type, uri, metadata_json)
     VALUES ($1,$2,'paper','https://arxiv.org/abs/2401.00001',$3::jsonb)`,
    [objectId, SPACE, JSON.stringify({ authors: ["Jane Doe"], categories: ["cs.LG"] })],
  );
  await pool!.query(
    `INSERT INTO academic_papers (object_id, space_id, arxiv_id, doi, publication_date, paper_type, created_at, updated_at)
     VALUES ($1,$2,'2401.00001','10.1000/example',$3,'preprint',$3,$3)`,
    [objectId, SPACE, now],
  );
  await pool!.query(
    `INSERT INTO source_item_references (source_item_id, space_id, reference_object_id, created_at, updated_at)
     VALUES ($1,$2,$3,$4,$4)`,
    [sourceItemId, SPACE, objectId, now],
  );
  const corpusItemId = randomUUID();
  await pool!.query(
    `INSERT INTO project_corpus_items (
       id, space_id, project_id, object_id, role, status, triage_status, read_status,
       metadata_json, created_at, updated_at
     ) VALUES ($1,$2,$3,$4,'candidate','active','new','unread','{}'::jsonb,$5,$5)`,
    [corpusItemId, SPACE, PROJECT, objectId, now],
  );
  await pool!.query(
    `INSERT INTO project_corpus_item_sources (
       id, corpus_item_id, space_id, project_id, source_item_id, created_at
     ) VALUES ($1,$2,$3,$4,$5,$6)`,
    [randomUUID(), corpusItemId, SPACE, PROJECT, sourceItemId, now],
  );
  return { objectId, sourceItemId, corpusItemId };
}

// syncProjectCorpusSourceDecisions() only conflict-targets corpus rows keyed
// by source_item_id with object_id/evidence_id both NULL (the partial index
// `uq_project_corpus_items_project_source_item`) — i.e. items not yet
// materialized into a Reference. Screening-decision tests need that row
// shape, not the reference-targeted row seedPaperCorpusItem() produces.
async function seedSourceItemOnlyCorpusItem(): Promise<{ sourceItemId: string; corpusItemId: string }> {
  const now = new Date().toISOString();
  const sourceItemId = randomUUID();
  await pool!.query(
    `INSERT INTO source_items (
       id, space_id, owner_user_id, visibility, connection_id, item_type, title, first_seen_at, last_seen_at,
       content_state, retention_policy, created_at, updated_at
     ) VALUES ($1,$2,$3,'space_shared',$4,'feed_entry','Paper B',$5,$5,'excerpt_saved','summary_only',$5,$5)`,
    [sourceItemId, SPACE, OWNER, CONNECTION, now],
  );
  // backfillFromSources() archives corpus rows lacking a backing active
  // project_source_item_links row — seed a binding + link so the row this
  // test asserts on survives the backfill's archive-orphans step.
  const bindingId = randomUUID();
  await pool!.query(
    `INSERT INTO project_source_bindings (
       id, space_id, project_id, source_channel_id, binding_key,
       status, priority, delivery_scope, collection_notifications_enabled,
       filters_json, routing_policy_json, extraction_policy_json,
       created_at, updated_at
     ) VALUES ($1,$2,$3,$4,'default','active',0,'project_members',true,'{}'::jsonb,'{}'::jsonb,'{}'::jsonb,$5,$5)`,
    [bindingId, SPACE, PROJECT, CONNECTION, now],
  );
  await pool!.query(
    `INSERT INTO project_source_item_links (
       id, space_id, project_id, project_source_binding_id, source_channel_id, source_connection_id,
       source_item_id, status, matched_at, created_at, updated_at
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,'active',$8,$8,$8)`,
    [randomUUID(), SPACE, PROJECT, bindingId, CONNECTION, CONNECTION, sourceItemId, now],
  );
  const corpusItemId = randomUUID();
  await pool!.query(
    `INSERT INTO project_corpus_items (
       id, space_id, project_id, source_item_id, role, status, triage_status, read_status,
       metadata_json, created_at, updated_at
     ) VALUES ($1,$2,$3,$4,'candidate','active','new','unread','{}'::jsonb,$5,$5)`,
    [corpusItemId, SPACE, PROJECT, sourceItemId, now],
  );
  // Production Corpus writers record the SourceItem as explicit project
  // provenance in the same transaction. Keep this direct-SQL fixture aligned
  // so ACL-aware Corpus reads can resolve the source target before backfill.
  await pool!.query(
    `INSERT INTO project_corpus_item_sources (
       id, corpus_item_id, space_id, project_id, source_item_id, created_at
     ) VALUES ($1,$2,$3,$4,$5,$6)`,
    [randomUUID(), corpusItemId, SPACE, PROJECT, sourceItemId, now],
  );
  return { sourceItemId, corpusItemId };
}

async function seedScreeningDecision(
  sourceItemId: string,
  relevance: string,
  options: { runId?: string; at?: string } = {},
): Promise<string> {
  const now = options.at ?? new Date().toISOString();
  const runId = options.runId ?? PP_RUN;
  const decisionId = randomUUID();
  await pool!.query(
    `INSERT INTO agents (id, space_id, owner_user_id, name, status, current_version_id, created_at, updated_at, visibility)
     VALUES ($1,$2,$3,'Screening Agent','active',NULL,$4,$4,'space_shared')
     ON CONFLICT (id) DO NOTHING`,
    [AGENT, SPACE, OWNER, now],
  );
  await pool!.query(
    `INSERT INTO source_post_processing_runs (
       id, space_id, source_channel_id, agent_id, project_id, trigger_type, status, created_at
     ) VALUES ($1,$2,$3,$4,$5,'manual','succeeded',$6)
     ON CONFLICT (id) DO NOTHING`,
    [runId, SPACE, CONNECTION, AGENT, PROJECT, now],
  );
  await pool!.query(
    `INSERT INTO source_post_processing_item_decisions (
       id, space_id, source_channel_id, run_id, project_id, source_item_id, relevance,
       review_status, created_at, updated_at
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,'accepted',$8,$8)`,
    [decisionId, SPACE, CONNECTION, runId, PROJECT, sourceItemId, relevance, now],
  );
  return decisionId;
}

describe("Project Corpus academic enrichment (real Postgres)", () => {
  it("canonicalizes a materialized SourceItem upsert to the existing Reference corpus row", async () => {
    if (!available) return;
    const { objectId, sourceItemId, corpusItemId } = await seedPaperCorpusItem();

    const upserted = await repo().upsert(identity, PROJECT, { source_item_id: sourceItemId });

    expect(upserted).toMatchObject({ id: corpusItemId, object_id: objectId });
    const rows = await pool!.query<{ id: string; object_id: string | null; source_item_id: string | null }>(
      `SELECT id, object_id, source_item_id FROM project_corpus_items WHERE project_id=$1`,
      [PROJECT],
    );
    expect(rows.rows).toEqual([{ id: corpusItemId, object_id: objectId, source_item_id: null }]);
  });

  it("serializes a SourceItem upsert behind concurrent Reference materialization", async () => {
    if (!available) return;
    const { objectId, sourceItemId, corpusItemId } = await seedPaperCorpusItem();
    await pool!.query(`DELETE FROM project_corpus_item_sources WHERE corpus_item_id=$1`, [corpusItemId]);
    await pool!.query(`DELETE FROM project_corpus_items WHERE id=$1`, [corpusItemId]);
    await pool!.query(`DELETE FROM source_item_references WHERE source_item_id=$1`, [sourceItemId]);

    const materializer = await pool!.connect();
    const now = new Date().toISOString();
    const canonicalCorpusId = randomUUID();
    try {
      await materializer.query("BEGIN");
      await materializer.query(
        `SELECT id FROM projects WHERE id=$1 AND space_id=$2 FOR UPDATE`,
        [PROJECT, SPACE],
      );
      await materializer.query(
        `INSERT INTO source_item_references (source_item_id, space_id, reference_object_id, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$4)`,
        [sourceItemId, SPACE, objectId, now],
      );
      await materializer.query(
        `INSERT INTO project_corpus_items (
           id, space_id, project_id, object_id, role, status, triage_status, read_status,
           metadata_json, created_at, updated_at
         ) VALUES ($1,$2,$3,$4,'candidate','active','new','unread','{}'::jsonb,$5,$5)`,
        [canonicalCorpusId, SPACE, PROJECT, objectId, now],
      );

      const pendingUpsert = repo().upsert(identity, PROJECT, { source_item_id: sourceItemId });
      await new Promise<void>((resolve) => setImmediate(resolve));
      await materializer.query("COMMIT");

      await expect(pendingUpsert).resolves.toMatchObject({ id: canonicalCorpusId, object_id: objectId });
    } finally {
      await materializer.query("ROLLBACK").catch(() => undefined);
      materializer.release();
    }

    const rows = await pool!.query<{ object_id: string | null; source_item_id: string | null }>(
      `SELECT object_id, source_item_id FROM project_corpus_items WHERE project_id=$1`,
      [PROJECT],
    );
    expect(rows.rows).toEqual([{ object_id: objectId, source_item_id: null }]);
  });

  it("rejects Corpus inserts and updates that lose a race with Project archive", async () => {
    if (!available) return;
    const { corpusItemId } = await seedPaperCorpusItem();
    const newObjectId = randomUUID();
    const now = new Date().toISOString();
    await pool!.query(
      `INSERT INTO space_objects (id, space_id, object_type, title, created_at, updated_at)
       VALUES ($1,$2,'source','New Reference',$3,$3)`,
      [newObjectId, SPACE, now],
    );

    const archiver = await pool!.connect();
    try {
      await archiver.query("BEGIN");
      await archiver.query(`SELECT id FROM projects WHERE id=$1 AND space_id=$2 FOR UPDATE`, [PROJECT, SPACE]);
      await archiver.query(
        `UPDATE projects SET status='archived', archived_at=$3, updated_at=$3 WHERE id=$1 AND space_id=$2`,
        [PROJECT, SPACE, now],
      );

      const pendingInsert = repo().upsert(identity, PROJECT, { object_id: newObjectId });
      const pendingUpdate = repo().update(identity, PROJECT, corpusItemId, { read_status: "read" });
      await new Promise<void>((resolve) => setImmediate(resolve));
      await archiver.query("COMMIT");

      await expect(pendingInsert).rejects.toMatchObject({ statusCode: 409 });
      await expect(pendingUpdate).rejects.toMatchObject({ statusCode: 409 });
    } finally {
      await archiver.query("ROLLBACK").catch(() => undefined);
      archiver.release();
    }

    const rows = await pool!.query<{ object_id: string | null; read_status: string }>(
      `SELECT object_id, read_status FROM project_corpus_items WHERE project_id=$1`,
      [PROJECT],
    );
    expect(rows.rows).toEqual([{ object_id: expect.any(String), read_status: "unread" }]);
    expect(rows.rows.some((row) => row.object_id === newObjectId)).toBe(false);
  });

  it("does not route or sync after Project archive wins", async () => {
    if (!available) return;
    const { sourceItemId, corpusItemId } = await seedSourceItemOnlyCorpusItem();
    await pool!.query(`DELETE FROM project_corpus_item_sources WHERE corpus_item_id=$1`, [corpusItemId]);
    await pool!.query(`DELETE FROM project_corpus_items WHERE id=$1`, [corpusItemId]);
    await pool!.query(
      `UPDATE project_source_item_links SET status='archived' WHERE project_id=$1 AND source_item_id=$2`,
      [PROJECT, sourceItemId],
    );

    const archiver = await pool!.connect();
    const now = new Date().toISOString();
    try {
      await archiver.query("BEGIN");
      await archiver.query(`SELECT id FROM projects WHERE id=$1 AND space_id=$2 FOR UPDATE`, [PROJECT, SPACE]);
      await archiver.query(
        `UPDATE projects SET status='archived', archived_at=$3, updated_at=$3 WHERE id=$1 AND space_id=$2`,
        [PROJECT, SPACE, now],
      );

      const pendingRouting = materializeProjectSourceItemLinks(pool!, { spaceId: SPACE, sourceItemId });
      const pendingSync = syncProjectCorpusForSourceItem(pool!, { spaceId: SPACE, sourceItemId, projectId: PROJECT });
      const outcomes = Promise.allSettled([pendingRouting, pendingSync]);
      await new Promise<void>((resolve) => setImmediate(resolve));
      await archiver.query("COMMIT");

      await expect(outcomes).resolves.toEqual([
        { status: "fulfilled", value: { created: 0, reactivated: 0, archived: 0 } },
        { status: "rejected", reason: expect.objectContaining({ statusCode: 409 }) },
      ]);
    } finally {
      await archiver.query("ROLLBACK").catch(() => undefined);
      archiver.release();
    }

    const corpus = await pool!.query(`SELECT id FROM project_corpus_items WHERE project_id=$1`, [PROJECT]);
    const link = await pool!.query<{ status: string }>(
      `SELECT status FROM project_source_item_links WHERE project_id=$1 AND source_item_id=$2`,
      [PROJECT, sourceItemId],
    );
    expect(corpus.rows).toEqual([]);
    expect(link.rows).toEqual([{ status: "archived" }]);
  });

  it("syncs an active Project without expanding the lock set to an archived Project", async () => {
    if (!available) return;
    const { sourceItemId } = await seedSourceItemOnlyCorpusItem();
    const archivedProjectId = randomUUID();
    const archivedBindingId = randomUUID();
    const now = new Date().toISOString();
    await pool!.query(
      `INSERT INTO projects (id, space_id, owner_user_id, name, status, archived_at, created_at, updated_at)
       VALUES ($1,$2,$3,'Archived Research','archived',$4,$4,$4)`,
      [archivedProjectId, SPACE, OWNER, now],
    );
    await pool!.query(
      `INSERT INTO project_source_bindings (
         id, space_id, project_id, source_channel_id, binding_key,
         status, priority, delivery_scope, collection_notifications_enabled,
         filters_json, routing_policy_json, extraction_policy_json,
         created_at, updated_at
       ) VALUES ($1,$2,$3,$4,'archived-binding','paused',0,'project_members',true,'{}'::jsonb,'{}'::jsonb,'{}'::jsonb,$5,$5)`,
      [archivedBindingId, SPACE, archivedProjectId, CONNECTION, now],
    );
    await pool!.query(
      `INSERT INTO project_source_item_links (
         id, space_id, project_id, project_source_binding_id, source_channel_id, source_connection_id,
         source_item_id, status, matched_at, created_at, updated_at
       ) VALUES ($1,$2,$3,$4,$5,$5,$6,'active',$7,$7,$7)`,
      [randomUUID(), SPACE, archivedProjectId, archivedBindingId, CONNECTION, sourceItemId, now],
    );

    await expect(materializeProjectSourceItemLinks(pool!, {
      spaceId: SPACE,
      sourceItemId,
    })).resolves.toMatchObject({ archived: 0 });

    const activeCorpus = await pool!.query<{ status: string }>(
      `SELECT status FROM project_corpus_items WHERE project_id=$1 AND source_item_id=$2`,
      [PROJECT, sourceItemId],
    );
    const archivedCorpus = await pool!.query(
      `SELECT id FROM project_corpus_items WHERE project_id=$1`,
      [archivedProjectId],
    );
    expect(activeCorpus.rows).toEqual([{ status: "active" }]);
    expect(archivedCorpus.rows).toEqual([]);
  });

  it("includes joined academic paper metadata in the corpus list DTO", async () => {
    if (!available) return;
    const { sourceItemId } = await seedPaperCorpusItem();

    const page = await repo().list(identity, PROJECT, { limit: 50, offset: 0 });
    const items = page.items as Array<{
      object: { academic: Record<string, unknown> | null };
      source_item: { id: string } | null;
    }>;
    expect(items).toHaveLength(1);
    expect(items[0]!.object.academic).toMatchObject({
      arxiv_id: "2401.00001",
      doi: "10.1000/example",
      paper_type: "preprint",
      authors: ["Jane Doe"],
      categories: ["cs.LG"],
    });
    expect(items[0]!.source_item?.id).toBe(sourceItemId);
  });

  it("does not expose project corpus to a same-space non-project member", async () => {
    if (!available) return;
    await makeSharedSpace();
    await addSpaceMember(SAME_SPACE_MEMBER);
    await seedPaperCorpusItem();

    await expect(
      repo().list({ spaceId: SPACE, userId: SAME_SPACE_MEMBER }, PROJECT, { limit: 50, offset: 0 }),
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  it("does not infer project provenance from unrelated or deleted SourceItems sharing a Reference", async () => {
    if (!available) return;
    await makeSharedSpace();
    await addSpaceMember(SAME_SPACE_MEMBER);
    const { objectId, sourceItemId } = await seedPaperCorpusItem();
    const unrelatedSourceItemId = randomUUID();
    const now = new Date().toISOString();
    await pool!.query(
      `INSERT INTO source_items (
         id, space_id, owner_user_id, visibility, item_type, title, first_seen_at, last_seen_at,
         content_state, retention_policy, created_at, updated_at
       ) VALUES ($1,$2,$3,'private','feed_entry','Private duplicate',$4,$4,'excerpt_saved','summary_only',$4,$4)`,
      [unrelatedSourceItemId, SPACE, SAME_SPACE_MEMBER, now],
    );
    await pool!.query(
      `INSERT INTO source_item_references (source_item_id, space_id, reference_object_id, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$4)`,
      [unrelatedSourceItemId, SPACE, objectId, now],
    );

    const beforeDelete = await repo().list(identity, PROJECT, { limit: 50, offset: 0 });
    const beforeItems = (beforeDelete as { items: unknown[] }).items;
    expect((beforeItems[0] as { source_item: { id: string } | null }).source_item?.id).toBe(sourceItemId);

    await pool!.query(`UPDATE source_items SET deleted_at = $3, updated_at = $3 WHERE id = $1 AND space_id = $2`, [sourceItemId, SPACE, now]);
    const afterDelete = await repo().list(identity, PROJECT, { limit: 50, offset: 0 });
    const afterItems = (afterDelete as { items: unknown[] }).items;
    expect((afterItems[0] as { source_item: { id: string } | null }).source_item).toBeNull();
  });

  it("rejects manually adding corpus targets that the writer cannot read", async () => {
    if (!available) return;
    await makeSharedSpace();
    await addSpaceMember(SAME_SPACE_MEMBER);
    const now = new Date().toISOString();

    const privateObjectId = randomUUID();
    await pool!.query(
      `INSERT INTO space_objects (id, space_id, object_type, title, visibility, owner_user_id, created_by_user_id, created_at, updated_at) VALUES ($1,$2,'source','Private Paper','private',$3,$3,$4,$4)`,
      [privateObjectId, SPACE, SAME_SPACE_MEMBER, now],
    );
    await expect(repo().upsert(identity, PROJECT, { object_id: privateObjectId })).rejects.toMatchObject({ statusCode: 422 });

    const privateSourceItemId = randomUUID();
    await pool!.query(
      `INSERT INTO source_items (
         id, space_id, owner_user_id, visibility, created_by_user_id, item_type, title, first_seen_at, last_seen_at,
         content_state, retention_policy, created_at, updated_at
       ) VALUES ($1,$2,$3,'private',$3,'feed_entry','Private source item',$4,$4,'excerpt_saved','summary_only',$4,$4)`,
      [privateSourceItemId, SPACE, SAME_SPACE_MEMBER, now],
    );
    await expect(repo().upsert(identity, PROJECT, { source_item_id: privateSourceItemId })).rejects.toMatchObject({ statusCode: 422 });

    const privateEvidenceId = randomUUID();
    await pool!.query(
      `INSERT INTO extracted_evidence (
         id, space_id, owner_user_id, visibility, source_item_id, evidence_type, title, content_excerpt,
         extraction_method, trust_level, status, created_by_user_id, created_at, updated_at
       ) VALUES ($1,$2,$3,'private',$4,'excerpt','Private evidence','secret','full_text','normal','candidate',$3,$5,$5)`,
      [privateEvidenceId, SPACE, SAME_SPACE_MEMBER, privateSourceItemId, now],
    );
    await expect(repo().upsert(identity, PROJECT, { evidence_id: privateEvidenceId })).rejects.toMatchObject({ statusCode: 422 });

    const sharedObjectId = randomUUID();
    await pool!.query(
      `INSERT INTO space_objects (id, space_id, object_type, title, created_at, updated_at)
       VALUES ($1,$2,'source','Shared Reference',$3,$3)`,
      [sharedObjectId, SPACE, now],
    );
    await pool!.query(
      `INSERT INTO sources (object_id, space_id, source_type, uri, metadata_json)
       VALUES ($1,$2,'paper','https://example.test/shared-reference','{}'::jsonb)`,
      [sharedObjectId, SPACE],
    );
    await pool!.query(
      `INSERT INTO source_item_references (source_item_id, space_id, reference_object_id, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$4)`,
      [privateSourceItemId, SPACE, sharedObjectId, now],
    );
    const bindingId = randomUUID();
    await pool!.query(
      `INSERT INTO project_source_bindings (
         id, space_id, project_id, source_channel_id, binding_key,
         status, priority, delivery_scope, collection_notifications_enabled,
         filters_json, routing_policy_json, extraction_policy_json, created_at, updated_at
       ) VALUES ($1,$2,$3,$4,'private-linked','active',0,'project_members',true,
                 '{}'::jsonb,'{}'::jsonb,'{}'::jsonb,$5,$5)`,
      [bindingId, SPACE, PROJECT, CONNECTION, now],
    );
    await pool!.query(
      `INSERT INTO project_source_item_links (
         id, space_id, project_id, project_source_binding_id, source_channel_id,
         source_connection_id, source_item_id, status, matched_at, created_at, updated_at
       ) VALUES ($1,$2,$3,$4,$5,$5,$6,'active',$7,$7,$7)`,
      [randomUUID(), SPACE, PROJECT, bindingId, CONNECTION, privateSourceItemId, now],
    );

    const added = await repo().upsert(identity, PROJECT, { object_id: sharedObjectId });
    expect(added.source_item).toBeNull();
    const provenance = await pool!.query<{ total: number }>(
      `SELECT count(*)::int AS total
         FROM project_corpus_item_sources
        WHERE corpus_item_id = $1`,
      [added.id],
    );
    expect(provenance.rows[0]!.total).toBe(0);
  });

  it("rejects an API write that supplies more than one Corpus target", async () => {
    if (!available) return;
    const { objectId, sourceItemId } = await seedPaperCorpusItem();
    await expect(
      repo().upsert(identity, PROJECT, { object_id: objectId, source_item_id: sourceItemId }),
    ).rejects.toMatchObject({ statusCode: 422 });
  });

  it("marks triage_confirmed_by_user when a human explicitly sets triage_status via update", async () => {
    if (!available) return;
    const { corpusItemId } = await seedPaperCorpusItem();

    const updated = await repo().update(identity, PROJECT, corpusItemId, { triage_status: "included" });
    expect(updated).toMatchObject({ triage_status: "included", triage_confirmed_by_user: true });

    const staleReviewAt = "2000-01-01T00:00:00.000Z";
    await pool!.query(`UPDATE project_corpus_items SET last_reviewed_at = $2 WHERE id = $1`, [corpusItemId, staleReviewAt]);
    const reconfirmed = await repo().update(identity, PROJECT, corpusItemId, { triage_status: "included" });
    expect(reconfirmed.last_reviewed_at).not.toBe(staleReviewAt);

    const untouched = await repo().update(identity, PROJECT, corpusItemId, { reason: "still relevant" });
    expect(untouched).toMatchObject({ triage_status: "included", triage_confirmed_by_user: true });
  });

  it("does not let a later AI screening decision overwrite a user-confirmed triage_status", async () => {
    if (!available) return;
    const { corpusItemId, sourceItemId } = await seedSourceItemOnlyCorpusItem();
    await repo().update(identity, PROJECT, corpusItemId, { triage_status: "included" });

    await seedScreeningDecision(sourceItemId, "not_relevant");
    await repo().backfillFromSources(identity, PROJECT);

    const page = await repo().list(identity, PROJECT, { limit: 50, offset: 0 });
    const item = (page.items as Array<{ id: string; triage_status: string }>).find((row) => row.id === corpusItemId);
    expect(item?.triage_status).toBe("included");
  });

  it("lets an AI screening decision set triage_status when the item is not yet user-confirmed", async () => {
    if (!available) return;
    const { corpusItemId, sourceItemId } = await seedSourceItemOnlyCorpusItem();

    await seedScreeningDecision(sourceItemId, "relevant");
    await repo().backfillFromSources(identity, PROJECT);

    const page = await repo().list(identity, PROJECT, { limit: 50, offset: 0 });
    const item = (page.items as Array<{ id: string; triage_status: string; triage_confirmed_by_user: boolean }>).find(
      (row) => row.id === corpusItemId,
    );
    expect(item?.triage_status).toBe("relevant");
    expect(item?.triage_confirmed_by_user).toBe(false);
  });

  it("keeps the newest AI decision when a source row merges into an existing Reference row", async () => {
    if (!available) return;
    const { sourceItemId } = await seedSourceItemOnlyCorpusItem();
    const now = new Date().toISOString();
    const objectId = randomUUID();
    await pool!.query(
      `INSERT INTO space_objects (id, space_id, object_type, title, created_at, updated_at)
       VALUES ($1,$2,'source','Paper B',$3,$3)`,
      [objectId, SPACE, now],
    );
    await pool!.query(
      `INSERT INTO sources (object_id, space_id, source_type, uri, metadata_json)
       VALUES ($1,$2,'paper','https://example.test/paper-b','{}'::jsonb)`,
      [objectId, SPACE],
    );
    await pool!.query(
      `INSERT INTO source_item_references (source_item_id, space_id, reference_object_id, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$4)`,
      [sourceItemId, SPACE, objectId, now],
    );
    const canonicalCorpusItemId = randomUUID();
    await pool!.query(
      `INSERT INTO project_corpus_items (
         id, space_id, project_id, object_id, role, status, triage_status, read_status,
         metadata_json, created_at, updated_at
       ) VALUES ($1,$2,$3,$4,'candidate','active','new','unread','{}'::jsonb,$5,$5)`,
      [canonicalCorpusItemId, SPACE, PROJECT, objectId, now],
    );
    const decisionId = await seedScreeningDecision(sourceItemId, "relevant");

    await repo().backfillFromSources(identity, PROJECT);

    const canonical = await pool!.query<{
      source_decision_id: string | null;
      relevance: string | null;
      triage_status: string;
    }>(
      `SELECT source_decision_id, relevance, triage_status
         FROM project_corpus_items WHERE id = $1`,
      [canonicalCorpusItemId],
    );
    expect(canonical.rows[0]).toMatchObject({
      source_decision_id: decisionId,
      relevance: "relevant",
      triage_status: "relevant",
    });
    expect(
      (await pool!.query(`SELECT count(*)::int AS total FROM project_corpus_items WHERE project_id = $1`, [PROJECT])).rows[0]!.total,
    ).toBe(1);
  });

  it("does not replace a newer canonical AI decision with an older duplicate decision", async () => {
    if (!available) return;
    const { sourceItemId, corpusItemId: duplicateId } = await seedSourceItemOnlyCorpusItem();
    const now = Date.now();
    const olderDecisionAt = new Date(now - 120_000).toISOString();
    const newerDecisionAt = new Date(now - 60_000).toISOString();
    const objectId = randomUUID();
    await pool!.query(
      `INSERT INTO space_objects (id, space_id, object_type, title, created_at, updated_at)
       VALUES ($1,$2,'source','Canonical Paper',$3,$3)`,
      [objectId, SPACE, olderDecisionAt],
    );
    await pool!.query(
      `INSERT INTO sources (object_id, space_id, source_type, uri, metadata_json)
       VALUES ($1,$2,'paper','https://example.test/canonical-paper','{}'::jsonb)`,
      [objectId, SPACE],
    );
    await pool!.query(
      `INSERT INTO source_item_references (source_item_id, space_id, reference_object_id, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$4)`,
      [sourceItemId, SPACE, objectId, olderDecisionAt],
    );
    const olderDecisionId = await seedScreeningDecision(sourceItemId, "not_relevant", {
      runId: randomUUID(),
      at: olderDecisionAt,
    });
    const newerDecisionId = await seedScreeningDecision(sourceItemId, "relevant", {
      runId: randomUUID(),
      at: newerDecisionAt,
    });
    const canonicalId = randomUUID();
    await pool!.query(
      `INSERT INTO project_corpus_items (
         id, space_id, project_id, object_id, source_decision_id, role, status,
         triage_status, read_status, relevance, confidence, reason,
         metadata_json, created_at, updated_at
      ) VALUES ($1,$2,$3,$4,$5,'candidate','active','relevant','unread','relevant',0.9,
                 'new canonical decision','{}'::jsonb,$6,$6)`,
      [canonicalId, SPACE, PROJECT, objectId, newerDecisionId, olderDecisionAt],
    );
    await pool!.query(
      `UPDATE project_corpus_items
          SET source_decision_id = $2, triage_status = 'excluded', relevance = 'not_relevant',
              confidence = 0.2, reason = 'older duplicate decision'
        WHERE id = $1`,
      [duplicateId, olderDecisionId],
    );

    await syncProjectCorpusForSourceItem(pool!, { spaceId: SPACE, sourceItemId, projectId: PROJECT });

    const canonical = await pool!.query<{
      source_decision_id: string | null;
      relevance: string | null;
      confidence: number | null;
      reason: string | null;
    }>(
      `SELECT source_decision_id, relevance, confidence, reason FROM project_corpus_items WHERE id = $1`,
      [canonicalId],
    );
    expect(canonical.rows[0]).toMatchObject({
      source_decision_id: newerDecisionId,
      relevance: "relevant",
      confidence: 0.9,
      reason: "new canonical decision",
    });
    expect((await pool!.query(`SELECT id FROM project_corpus_items WHERE id = $1`, [duplicateId])).rowCount).toBe(0);
  });

  it("keeps a newer duplicate AI decision even when materialization refreshes the canonical row", async () => {
    if (!available) return;
    const { sourceItemId, corpusItemId: duplicateId } = await seedSourceItemOnlyCorpusItem();
    const now = Date.now();
    const oldAt = new Date(now - 120_000).toISOString();
    const newAt = new Date(now - 60_000).toISOString();
    const objectId = randomUUID();
    await pool!.query(
      `INSERT INTO space_objects (id, space_id, object_type, title, created_at, updated_at)
       VALUES ($1,$2,'source','Decision Ordering Paper',$3,$3)`,
      [objectId, SPACE, oldAt],
    );
    await pool!.query(
      `INSERT INTO sources (object_id, space_id, source_type, uri, metadata_json)
       VALUES ($1,$2,'paper','https://example.test/decision-ordering','{}'::jsonb)`,
      [objectId, SPACE],
    );
    await pool!.query(
      `INSERT INTO source_item_references (source_item_id, space_id, reference_object_id, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$4)`,
      [sourceItemId, SPACE, objectId, oldAt],
    );
    const oldDecisionId = await seedScreeningDecision(sourceItemId, "not_relevant", {
      runId: randomUUID(),
      at: oldAt,
    });
    const canonicalId = randomUUID();
    await pool!.query(
      `INSERT INTO project_corpus_items (
         id, space_id, project_id, object_id, source_decision_id, role, status,
         triage_status, read_status, relevance, confidence, reason,
         metadata_json, created_at, updated_at
       ) VALUES ($1,$2,$3,$4,$5,'candidate','active','excluded','unread','not_relevant',0.2,
                 'old canonical decision','{}'::jsonb,$6,$6)`,
      [canonicalId, SPACE, PROJECT, objectId, oldDecisionId, oldAt],
    );
    const newDecisionId = await seedScreeningDecision(sourceItemId, "relevant", {
      runId: randomUUID(),
      at: newAt,
    });

    await repo().backfillFromSources(identity, PROJECT);

    const canonical = await pool!.query<{
      source_decision_id: string | null;
      relevance: string | null;
      reason: string | null;
      updated_at: Date;
    }>(
      `SELECT source_decision_id, relevance, reason, updated_at
         FROM project_corpus_items WHERE id = $1`,
      [canonicalId],
    );
    expect(canonical.rows[0]).toMatchObject({
      source_decision_id: newDecisionId,
      relevance: "relevant",
    });
    expect(canonical.rows[0]!.updated_at.getTime()).toBeGreaterThan(new Date(newAt).getTime());
    expect((await pool!.query(`SELECT id FROM project_corpus_items WHERE id = $1`, [duplicateId])).rowCount).toBe(0);
  });

  it("orders human triage confirmations by last_reviewed_at, not row updated_at", async () => {
    if (!available) return;
    const { sourceItemId, corpusItemId: duplicateId } = await seedSourceItemOnlyCorpusItem();
    const now = Date.now();
    const olderReviewAt = new Date(now - 120_000).toISOString();
    const newerReviewAt = new Date(now - 60_000).toISOString();
    const staleRowUpdatedAt = new Date(now - 180_000).toISOString();
    const objectId = randomUUID();
    await pool!.query(
      `INSERT INTO space_objects (id, space_id, object_type, title, created_at, updated_at)
       VALUES ($1,$2,'source','Triage Ordering Paper',$3,$3)`,
      [objectId, SPACE, olderReviewAt],
    );
    await pool!.query(
      `INSERT INTO sources (object_id, space_id, source_type, uri, metadata_json)
       VALUES ($1,$2,'paper','https://example.test/triage-ordering','{}'::jsonb)`,
      [objectId, SPACE],
    );
    await pool!.query(
      `INSERT INTO source_item_references (source_item_id, space_id, reference_object_id, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$4)`,
      [sourceItemId, SPACE, objectId, olderReviewAt],
    );
    const canonicalId = randomUUID();
    await pool!.query(
      `INSERT INTO project_corpus_items (
         id, space_id, project_id, object_id, role, status, triage_status,
         triage_confirmed_by_user, read_status, metadata_json,
         created_at, updated_at, last_reviewed_at
       ) VALUES ($1,$2,$3,$4,'candidate','active','included',true,'unread','{}'::jsonb,$5,$5,$5)`,
      [canonicalId, SPACE, PROJECT, objectId, olderReviewAt],
    );
    await pool!.query(
      `UPDATE project_corpus_items
          SET triage_status = 'excluded', triage_confirmed_by_user = true,
              last_reviewed_at = NULL, created_at = $2, updated_at = $3
        WHERE id = $1`,
      [duplicateId, newerReviewAt, staleRowUpdatedAt],
    );

    await syncProjectCorpusForSourceItem(pool!, { spaceId: SPACE, sourceItemId, projectId: PROJECT });

    const canonical = await pool!.query<{ triage_status: string; last_reviewed_at: Date; updated_at: Date }>(
      `SELECT triage_status, last_reviewed_at, updated_at
         FROM project_corpus_items WHERE id = $1`,
      [canonicalId],
    );
    expect(canonical.rows[0]!.triage_status).toBe("excluded");
    expect(canonical.rows[0]!.last_reviewed_at.toISOString()).toBe(newerReviewAt);
    expect(canonical.rows[0]!.updated_at.getTime()).toBeGreaterThan(new Date(newerReviewAt).getTime());
  });

  it("keeps Library personal read state separate from project corpus triage/read state", async () => {
    if (!available) return;
    const { corpusItemId, sourceItemId } = await seedPaperCorpusItem();
    await repo().update(identity, PROJECT, corpusItemId, { triage_status: "included", read_status: "read" });

    const now = new Date().toISOString();
    await pool!.query(
      `INSERT INTO source_item_user_states (
         id, space_id, source_item_id, user_id, library_status, read_status, created_at, updated_at
       ) VALUES ($1,$2,$3,$4,'new','unread',$5,$5)`,
      [randomUUID(), SPACE, sourceItemId, OWNER, now],
    );

    const libraryState = await pool!.query<{ read_status: string; library_status: string }>(
      `SELECT read_status, library_status FROM source_item_user_states WHERE source_item_id = $1`,
      [sourceItemId],
    );
    expect(libraryState.rows[0]).toMatchObject({ read_status: "unread", library_status: "new" });

    const corpusItem = await pool!.query<{ read_status: string; triage_status: string }>(
      `SELECT read_status, triage_status FROM project_corpus_items WHERE id = $1`,
      [corpusItemId],
    );
    expect(corpusItem.rows[0]).toMatchObject({ read_status: "read", triage_status: "included" });
  });
});
