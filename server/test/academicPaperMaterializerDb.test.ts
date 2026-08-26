import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { useTestDatabase } from "./support/testDatabase.js";
import { seedSpaceOwnerProject } from "./support/domainSeeds.js";
import { resetTables } from "./support/resetTables.js";
import { materializeAcademicPaperFromSourceItem } from "../src/modules/academic/paperMaterializer.js";
import { syncProjectCorpusForSourceItem } from "../src/modules/projects/corpusRepository.js";
import { materializeProjectSourceItemLinks } from "../src/modules/projects/projectSourceRoutingService.js";
import { GraphProjectionRepository } from "../src/modules/graph/projectionRepository.js";

// Real-Postgres coverage for Academic Research arXiv paper materialization:
// arXiv source items materialize into academic_paper_v1 objects (deduped by
// arxiv_id/doi), become visible in Project Corpus, and are graph-visible.

const SPACE = "11111111-1111-4111-8111-111111111111";
const OWNER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OTHER = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const PROJECT = "55555555-5555-4555-8555-555555555555";
const CONNECTOR = "33333333-3333-4333-8333-333333333333";
const CONNECTION = "44444444-4444-4444-8444-444444444444";


const db = useTestDatabase(import.meta.filename);

beforeEach(async () => {
  if (!db.available) return;
  await resetTables(
    db.pool,
    ["academic_papers", "sources", "space_objects", "project_corpus_items", "project_source_item_links", "project_source_bindings", "source_channel_item_links", "source_channel_user_subscriptions", "source_channels", "source_items", "source_connections", "source_provider_connectors", "source_providers", "source_connectors", "project_members", "projects", "space_memberships", "users", "spaces"],
    { cascade: true },
  );
  const { now } = await seedSpaceOwnerProject(db.pool, { space: SPACE, owner: OWNER, project: PROJECT });
  await db.pool.query(
    `INSERT INTO source_connectors (
       id, connector_key, display_name, connector_type, ingestion_mode, status,
       capabilities_json, created_at, updated_at
     ) VALUES ($1,'arxiv','arXiv','external_feed','pull','active','{}'::jsonb,$2,$2)`,
    [CONNECTOR, now],
  );
  const mappingId = randomUUID();
  await db.pool.query(
    `INSERT INTO source_providers (id, provider_key, display_name, provider_kind, category, status, capabilities_json, created_at, updated_at)
     VALUES ($1,'arxiv','arXiv','named','academic','active','{}'::jsonb,$2,$2)`,
    [CONNECTOR, now],
  );
  await db.pool.query(
    `INSERT INTO source_provider_connectors (id, provider_id, connector_id, status, priority, capabilities_json, created_at, updated_at)
     VALUES ($1,$2,$3,'active',0,'{}'::jsonb,$4,$4)`,
    [mappingId, CONNECTOR, CONNECTOR, now],
  );
  await db.pool.query(
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
  await db.pool.query(
    `INSERT INTO source_channels (
       id, space_id, source_connection_id, created_by_user_id, name, channel_type, endpoint_url,
       query_json, provider_query_json, query_fingerprint, status, fetch_frequency, schedule_rule_json, created_at, updated_at
     ) VALUES ($1,$2,$1,$3,'arXiv Channel','search','https://export.arxiv.org/api/query','{}'::jsonb,'{}'::jsonb,$1,'active','daily','{"frequency":"daily","hour":0,"minute":0}'::jsonb,$4,$4)`,
    [CONNECTION, SPACE, OWNER, now],
  );
});

async function seedBinding(profileKey: string | null, standingComparisonEnabled = false): Promise<string> {
  const id = randomUUID();
  const now = new Date().toISOString();
  await db.pool.query(
    `INSERT INTO project_source_bindings (
       id, space_id, project_id, source_channel_id, binding_key,
       status, priority, delivery_scope, collection_notifications_enabled,standing_comparison_enabled,
       filters_json, routing_policy_json, extraction_policy_json,
       created_at, updated_at
     ) VALUES ($1,$2,$3,$4,'default','active',0,'project_members',true,$5,'{}'::jsonb,'{}'::jsonb,$6::jsonb,$7,$7)`,
    [id, SPACE, PROJECT, CONNECTION, standingComparisonEnabled, JSON.stringify(profileKey ? { profile_key: profileKey } : {}), now],
  );
  return id;
}

async function seedArxivItem(arxivId: string, doi: string | null = null): Promise<string> {
  const itemId = randomUUID();
  const now = new Date().toISOString();
  await db.pool.query(
    `INSERT INTO source_items (
       id, space_id, owner_user_id, visibility, connection_id, item_type, title, source_uri, first_seen_at, last_seen_at,
       content_state, retention_policy, metadata_json, created_at, updated_at
     ) VALUES ($1,$2,$3,'space_shared',$4,'feed_entry',$5,$6,$7,$7,'excerpt_saved','summary_only',$8::jsonb,$7,$7)`,
    [
      itemId,
      SPACE,
      OWNER,
      CONNECTION,
      `Paper ${arxivId}`,
      `https://arxiv.org/abs/${arxivId}`,
      now,
      JSON.stringify({
        arxiv_id: arxivId,
        doi,
        authors: ["Jane Doe", "John Smith"],
        categories: ["cs.LG", "cs.AI"],
        primary_category: "cs.LG",
        published_at: now,
        updated_at: now,
        abs_url: `https://arxiv.org/abs/${arxivId}`,
        html_url: `https://arxiv.org/html/${arxivId}`,
        pdf_url: `https://arxiv.org/pdf/${arxivId}`,
        journal_ref: null,
        comment: null,
      }),
    ],
  );
  return itemId;
}

async function seedProviderItem(metadata: Record<string, unknown>, title: string): Promise<string> {
  const itemId = randomUUID(); const now = new Date().toISOString();
  await db.pool.query(
    `INSERT INTO source_items (id,space_id,owner_user_id,visibility,connection_id,item_type,title,source_uri,first_seen_at,last_seen_at,content_state,retention_policy,metadata_json,created_at,updated_at)
     VALUES ($1,$2,$3,'space_shared',$4,'feed_entry',$5,$6,$7,$7,'metadata_only','metadata_only',$8::jsonb,$7,$7)`,
    [itemId, SPACE, OWNER, CONNECTION, title, String(metadata.source_url ?? "https://example.test/paper"), now, JSON.stringify(metadata)],
  );
  return itemId;
}

async function seedGenericDocumentItem(): Promise<string> {
  const itemId = randomUUID();
  const now = new Date().toISOString();
  const canonicalUri = "https://example.test/articles/general-research";
  await db.pool.query(
    `INSERT INTO source_items (
       id, space_id, owner_user_id, visibility, connection_id, item_type, title,
       source_uri, canonical_uri, source_domain, author, occurred_at, excerpt,
       first_seen_at, last_seen_at, content_state, retention_policy, metadata_json,
       created_at, updated_at
     ) VALUES (
       $1,$2,$3,'space_shared',$4,'external_url',$5,$6,$6,'example.test',$7,$8,$9,
       $8,$8,'excerpt_saved','summary_only','{}'::jsonb,$8,$8
     )`,
    [itemId, SPACE, OWNER, CONNECTION, "General research document", canonicalUri, "Researcher", now,
      "A generic web document that passed project triage."],
  );
  return itemId;
}

describe("Academic paper materialization from arXiv source items (real Postgres)", () => {
  it("collects standing comparison only when a matching link first lands or is reactivated", async () => {
    if (!db.available) return;
    await seedBinding(null, true);
    const itemId = await seedArxivItem("2401.00000");

    expect(await materializeProjectSourceItemLinks(db.pool, { spaceId: SPACE, sourceItemId: itemId }))
      .toEqual({ created: 1, reactivated: 0, archived: 0 });
    expect(await materializeProjectSourceItemLinks(db.pool, { spaceId: SPACE, sourceItemId: itemId }))
      .toEqual({ created: 0, reactivated: 0, archived: 0 });
    expect((await db.pool.query<{ source_item_ids_json: string[] }>(
      `SELECT source_item_ids_json FROM project_research_standing_batches WHERE project_id=$1`,
      [PROJECT],
    )).rows).toEqual([{ source_item_ids_json: [itemId] }]);

    await db.pool.query(
      `UPDATE project_source_item_links SET status='archived' WHERE project_id=$1 AND source_item_id=$2`,
      [PROJECT, itemId],
    );
    expect(await materializeProjectSourceItemLinks(db.pool, { spaceId: SPACE, sourceItemId: itemId }))
      .toEqual({ created: 0, reactivated: 1, archived: 0 });
    expect((await db.pool.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM project_research_standing_batches WHERE project_id=$1`,
      [PROJECT],
    )).rows[0]?.count).toBe(1);
  });

  it("accepts future well-formed profile keys and rejects malformed keys", async () => {
    if (!db.available) return;
    const bindingId = await seedBinding("academic_paper_v1");
    const futureKey = `future_${randomUUID().replaceAll("-", "")}`;
    await expect(db.pool.query(
      "UPDATE project_source_bindings SET extraction_policy_json=$2::jsonb WHERE id=$1",
      [bindingId, JSON.stringify({ profile_key: futureKey })],
    )).resolves.toMatchObject({ rowCount: 1 });
    await expect(db.pool.query(
      "UPDATE project_source_bindings SET extraction_policy_json=$2::jsonb WHERE id=$1",
      [bindingId, JSON.stringify({ profile_key: "Invalid Profile Key" })],
    )).rejects.toMatchObject({ code: "23514" });
  });

  it("materializes a paper object and syncs into Project Corpus + graph", async () => {
    if (!db.available) return;
    await seedBinding("academic_paper_v1");
    const itemId = await seedArxivItem("2401.00001", "10.1000/example");
    const routeResult = await materializeProjectSourceItemLinks(db.pool, { spaceId: SPACE, sourceItemId: itemId });
    expect(routeResult).toMatchObject({ created: 1, reactivated: 0, archived: 0 });

    expect((await db.pool.query("SELECT reference_object_id FROM source_item_references WHERE source_item_id = $1", [itemId])).rows).toHaveLength(0);
    await db.pool.query("UPDATE project_corpus_items SET triage_status = $3 WHERE project_id = $1 AND source_item_id = $2", [PROJECT, itemId, "relevant"]);
    await syncProjectCorpusForSourceItem(db.pool, { spaceId: SPACE, projectId: PROJECT, sourceItemId: itemId });

    const item = await db.pool.query<{ reference_object_id: string }>(
      `SELECT reference_object_id FROM source_item_references WHERE source_item_id = $1`,
      [itemId],
    );
    const objectId = item.rows[0]!.reference_object_id;
    expect(objectId).toBeTruthy();
    const scope = await db.pool.query<{ primary_project_id: string | null }>("SELECT primary_project_id FROM space_objects WHERE id = $1", [objectId]);
    expect(scope.rows[0]!.primary_project_id).toBe(PROJECT);

    const paper = await db.pool.query<{ arxiv_id: string; doi: string | null; paper_type: string }>(
      `SELECT arxiv_id, doi, paper_type FROM academic_papers WHERE object_id = $1`,
      [objectId],
    );
    expect(paper.rows[0]).toMatchObject({ arxiv_id: "2401.00001", doi: "10.1000/example", paper_type: "preprint" });

    const sourceRow = await db.pool.query<{ metadata_json: { authors: string[] } }>(
      `SELECT metadata_json FROM sources WHERE object_id = $1`,
      [objectId],
    );
    expect(sourceRow.rows[0]!.metadata_json.authors).toEqual(["Jane Doe", "John Smith"]);

    const corpusItem = await db.pool.query<{ object_id: string; triage_status: string }>(
      `SELECT object_id, triage_status FROM project_corpus_items WHERE project_id = $1 AND object_id = $2`,
      [PROJECT, objectId],
    );
    expect(corpusItem.rows).toHaveLength(1);
    expect(corpusItem.rows[0]!.triage_status).toBe("relevant");

    const graphRepo = new GraphProjectionRepository(db.pool);
    const visible = await graphRepo.getVisibleObject({ spaceId: SPACE, userId: OWNER }, objectId, { projectId: PROJECT });
    expect(visible?.id).toBe(objectId);
  });

  it("materializes a canonical web document only after triage and keeps it project-scoped and graphable", async () => {
    if (!db.available) return;
    await db.pool.query("UPDATE spaces SET type = $2 WHERE id = $1", [SPACE, "team"]);
    const now = new Date().toISOString();
    await db.pool.query("INSERT INTO users (id, display_name, status, created_at, updated_at) VALUES ($1,$1,'active',$2,$2)", [OTHER, now]);
    await db.pool.query("INSERT INTO space_memberships (id, space_id, user_id, role, status, created_at, updated_at) VALUES ($1,$2,$3,'member','active',$4,$4)", [randomUUID(), SPACE, OTHER, now]);
    await seedBinding("generic_document_v1");
    const itemId = await seedGenericDocumentItem();
    await materializeProjectSourceItemLinks(db.pool, { spaceId: SPACE, sourceItemId: itemId });
    expect((await db.pool.query("SELECT reference_object_id FROM source_item_references WHERE source_item_id = $1", [itemId])).rows).toHaveLength(0);
    await db.pool.query("UPDATE project_corpus_items SET triage_status = $3 WHERE project_id = $1 AND source_item_id = $2", [PROJECT, itemId, "relevant"]);
    await syncProjectCorpusForSourceItem(db.pool, { spaceId: SPACE, projectId: PROJECT, sourceItemId: itemId });
    const materialized = await db.pool.query<{ object_id: string; primary_project_id: string; uri: string; source_type: string; source_item_id: string | null }>(
      `SELECT corpus.object_id, object.primary_project_id, source.uri, source.source_type, corpus.source_item_id
         FROM project_corpus_items corpus
         JOIN space_objects object ON object.id = corpus.object_id AND object.space_id = corpus.space_id
         JOIN sources source ON source.object_id = object.id AND source.space_id = object.space_id
        WHERE corpus.project_id = $1`, [PROJECT]);
    expect(materialized.rows).toEqual([expect.objectContaining({ primary_project_id: PROJECT, uri: "https://example.test/articles/general-research", source_type: "webpage", source_item_id: null })]);
    const objectId = materialized.rows[0]!.object_id;
    const graphRepo = new GraphProjectionRepository(db.pool);
    await expect(graphRepo.getVisibleObject({ spaceId: SPACE, userId: OWNER }, objectId, { projectId: PROJECT })).resolves.toMatchObject({ id: objectId, object_type: "source" });
    await expect(graphRepo.getVisibleObject({ spaceId: SPACE, userId: OTHER }, objectId, { projectId: PROJECT })).resolves.toBeNull();
  });

  it("is idempotent: re-running does not create a duplicate paper", async () => {
    if (!db.available) return;
    const itemId = await seedArxivItem("2401.00002");

    const first = await materializeAcademicPaperFromSourceItem(db.pool, { spaceId: SPACE, projectId: PROJECT, sourceItemId: itemId });
    const second = await materializeAcademicPaperFromSourceItem(db.pool, { spaceId: SPACE, projectId: PROJECT, sourceItemId: itemId });

    expect(second).toMatchObject({ objectId: first!.objectId, created: false });
    const count = await db.pool.query(`SELECT count(*)::int AS total FROM academic_papers WHERE arxiv_id = '2401.00002'`);
    expect(count.rows[0]!.total).toBe(1);
  });

  it("dedupes a second arXiv item that shares an existing doi", async () => {
    if (!db.available) return;
    const firstItemId = await seedArxivItem("2401.00003", "10.1000/shared");
    const first = await materializeAcademicPaperFromSourceItem(db.pool, { spaceId: SPACE, projectId: PROJECT, sourceItemId: firstItemId });

    const secondItemId = await seedArxivItem("2401.00004", "10.1000/shared");
    const second = await materializeAcademicPaperFromSourceItem(db.pool, { spaceId: SPACE, projectId: PROJECT, sourceItemId: secondItemId });

    expect(second).toMatchObject({ objectId: first!.objectId, created: false });
    const count = await db.pool.query(`SELECT count(*)::int AS total FROM academic_papers WHERE doi = '10.1000/shared'`);
    expect(count.rows[0]!.total).toBe(1);
  });

  it("atomically dedupes concurrent SourceItems for the same academic identity", async () => {
    if (!db.available) return;
    const firstItemId = await seedArxivItem("2401.00030", "10.1000/concurrent-materialize");
    const secondItemId = await seedArxivItem("2401.00031", "10.1000/concurrent-materialize");

    const [first, second] = await Promise.all([
      materializeAcademicPaperFromSourceItem(db.pool, { spaceId: SPACE, projectId: PROJECT, sourceItemId: firstItemId }),
      materializeAcademicPaperFromSourceItem(db.pool, { spaceId: SPACE, projectId: PROJECT, sourceItemId: secondItemId }),
    ]);

    expect(second!.objectId).toBe(first!.objectId);
    expect([first!.created, second!.created].sort()).toEqual([false, true]);
    const counts = await db.pool.query<{
      objects: number;
      sources: number;
      papers: number;
      references: number;
    }>(
      `SELECT
         (SELECT count(*)::int FROM space_objects WHERE space_id=$1 AND object_type='source') AS objects,
         (SELECT count(*)::int FROM sources WHERE space_id=$1) AS sources,
         (SELECT count(*)::int FROM academic_papers WHERE space_id=$1 AND doi='10.1000/concurrent-materialize') AS papers,
         (SELECT count(*)::int FROM source_item_references WHERE space_id=$1 AND reference_object_id=$2) AS references`,
      [SPACE, first!.objectId],
    );
    expect(counts.rows[0]).toEqual({ objects: 1, sources: 1, papers: 1, references: 2 });
  });

  it("canonicalizes case variants before locking and persisting academic identities", async () => {
    if (!db.available) return;
    const firstItemId = await seedProviderItem({
      academic_provider: "openalex",
      openalex_id: "W-CASE-1",
      doi: "10.1000/Case-Sensitive",
      source_url: "https://openalex.org/W-CASE-1",
    }, "Case variant one");
    const secondItemId = await seedProviderItem({
      academic_provider: "semantic_scholar",
      semantic_scholar_id: "S2-CASE-2",
      doi: "10.1000/case-sensitive",
      source_url: "https://semanticscholar.org/paper/S2-CASE-2",
    }, "Case variant two");

    const [first, second] = await Promise.all([
      materializeAcademicPaperFromSourceItem(db.pool, { spaceId: SPACE, projectId: PROJECT, sourceItemId: firstItemId }),
      materializeAcademicPaperFromSourceItem(db.pool, { spaceId: SPACE, projectId: PROJECT, sourceItemId: secondItemId }),
    ]);

    expect(second!.objectId).toBe(first!.objectId);
    const rows = await db.pool.query<{ doi: string; openalex_id: string | null; semantic_scholar_id: string | null }>(
      `SELECT doi, openalex_id, semantic_scholar_id FROM academic_papers WHERE object_id=$1`,
      [first!.objectId],
    );
    expect(rows.rows).toEqual([{
      doi: "10.1000/case-sensitive",
      openalex_id: "w-case-1",
      semantic_scholar_id: "s2-case-2",
    }]);
    await expect(db.pool.query(
      `UPDATE academic_papers SET doi='10.1000/UPPER' WHERE object_id=$1`,
      [first!.objectId],
    )).rejects.toMatchObject({ constraint: "ck_academic_papers_canonical_identity" });
    await expect(db.pool.query(
      `UPDATE academic_papers SET doi=' 10.1000/case-sensitive ' WHERE object_id=$1`,
      [first!.objectId],
    )).rejects.toMatchObject({ constraint: "ck_academic_papers_canonical_identity" });
    await expect(db.pool.query(
      `UPDATE academic_papers SET doi='' WHERE object_id=$1`,
      [first!.objectId],
    )).rejects.toMatchObject({ constraint: "ck_academic_papers_canonical_identity" });
  });

  it("materializes OpenAlex and links a Semantic Scholar record with the same DOI to one paper", async () => {
    if (!db.available) return;
    const openAlexItem = await seedProviderItem({ academic_provider: "openalex", openalex_id: "W123", doi: "10.1000/cross-provider", authors: ["Ada"], published_at: "2026-01-01", venue: "Journal", paper_type: "article", cited_by_count: 7, reference_count: 11, source_url: "https://openalex.org/W123" }, "Cross-provider paper");
    const first = await materializeAcademicPaperFromSourceItem(db.pool, { spaceId: SPACE, projectId: PROJECT, sourceItemId: openAlexItem });
    const semanticItem = await seedProviderItem({ academic_provider: "semantic_scholar", semantic_scholar_id: "s2-123", doi: "10.1000/cross-provider", authors: ["Ada"], published_at: "2026-01-01", source_url: "https://semanticscholar.org/paper/s2-123" }, "Cross-provider paper");
    const second = await materializeAcademicPaperFromSourceItem(db.pool, { spaceId: SPACE, projectId: PROJECT, sourceItemId: semanticItem });
    expect(second).toEqual({ objectId: first!.objectId, created: false });
    const row = await db.pool.query(`SELECT openalex_id,semantic_scholar_id,cited_by_count,reference_count FROM academic_papers WHERE object_id=$1`, [first!.objectId]);
    expect(row.rows[0]).toMatchObject({ openalex_id: "w123", semantic_scholar_id: "s2-123", cited_by_count: 7, reference_count: 11 });
    expect((await db.pool.query(`SELECT count(*)::int AS total FROM academic_papers WHERE doi='10.1000/cross-provider'`)).rows[0].total).toBe(1);
  });

  it("promotes a source-target corpus row in place when the SourceItem gains a Reference", async () => {
    if (!db.available) return;
    await seedBinding(null);
    const itemId = await seedArxivItem("2401.00005");
    await materializeProjectSourceItemLinks(db.pool, { spaceId: SPACE, sourceItemId: itemId });
    await syncProjectCorpusForSourceItem(db.pool, { spaceId: SPACE, sourceItemId: itemId });

    const before = await db.pool.query<{ id: string }>(
      `UPDATE project_corpus_items
          SET triage_status = 'included', triage_confirmed_by_user = true, read_status = 'discussed'
        WHERE project_id = $1 AND source_item_id = $2
        RETURNING id`,
      [PROJECT, itemId],
    );
    expect(before.rows).toHaveLength(1);

    const materialized = await materializeAcademicPaperFromSourceItem(db.pool, { spaceId: SPACE, projectId: PROJECT, sourceItemId: itemId });
    await syncProjectCorpusForSourceItem(db.pool, { spaceId: SPACE, sourceItemId: itemId });

    const after = await db.pool.query<{
      id: string;
      object_id: string;
      source_item_id: string | null;
      triage_status: string;
      triage_confirmed_by_user: boolean;
      read_status: string;
    }>(
      `SELECT id, object_id, source_item_id, triage_status, triage_confirmed_by_user, read_status
         FROM project_corpus_items
        WHERE project_id = $1`,
      [PROJECT],
    );
    expect(after.rows).toEqual([
      expect.objectContaining({
        id: before.rows[0]!.id,
        object_id: materialized!.objectId,
        source_item_id: null,
        triage_status: "included",
        triage_confirmed_by_user: true,
        read_status: "discussed",
      }),
    ]);
  });

  it("merges human corpus state when a canonical Reference row already exists", async () => {
    if (!db.available) return;
    await seedBinding(null);
    const itemId = await seedArxivItem("2401.00007");
    await materializeProjectSourceItemLinks(db.pool, { spaceId: SPACE, sourceItemId: itemId });
    await syncProjectCorpusForSourceItem(db.pool, { spaceId: SPACE, sourceItemId: itemId });
    await db.pool.query(
      `UPDATE project_corpus_items
          SET triage_status = 'included', triage_confirmed_by_user = true, read_status = 'discussed'
        WHERE project_id = $1 AND source_item_id = $2`,
      [PROJECT, itemId],
    );

    const materialized = await materializeAcademicPaperFromSourceItem(db.pool, { spaceId: SPACE, projectId: PROJECT, sourceItemId: itemId });
    const canonicalId = randomUUID();
    const now = new Date().toISOString();
    await db.pool.query(
      `INSERT INTO project_corpus_items (
         id, space_id, project_id, object_id, role, status, triage_status, read_status,
         metadata_json, created_at, updated_at
       ) VALUES ($1,$2,$3,$4,'candidate','active','new','skimmed','{}'::jsonb,$5,$5)`,
      [canonicalId, SPACE, PROJECT, materialized!.objectId, now],
    );

    await syncProjectCorpusForSourceItem(db.pool, { spaceId: SPACE, sourceItemId: itemId });
    const after = await db.pool.query<{
      id: string;
      source_item_id: string | null;
      triage_status: string;
      triage_confirmed_by_user: boolean;
      read_status: string;
    }>(
      `SELECT id, source_item_id, triage_status, triage_confirmed_by_user, read_status
         FROM project_corpus_items WHERE project_id = $1`,
      [PROJECT],
    );
    expect(after.rows).toEqual([
      expect.objectContaining({
        id: canonicalId,
        source_item_id: null,
        triage_status: "included",
        triage_confirmed_by_user: true,
        read_status: "discussed",
      }),
    ]);
  });

  it("serializes concurrent promotions of two SourceItems to one Reference", async () => {
    if (!db.available) return;
    await seedBinding(null);
    const firstItemId = await seedArxivItem("2401.00008", "10.1000/concurrent");
    const secondItemId = await seedArxivItem("2401.00009", "10.1000/concurrent");
    await materializeProjectSourceItemLinks(db.pool, { spaceId: SPACE, sourceItemId: firstItemId });
    await materializeProjectSourceItemLinks(db.pool, { spaceId: SPACE, sourceItemId: secondItemId });
    await syncProjectCorpusForSourceItem(db.pool, { spaceId: SPACE, sourceItemId: firstItemId });
    await syncProjectCorpusForSourceItem(db.pool, { spaceId: SPACE, sourceItemId: secondItemId });
    const first = await materializeAcademicPaperFromSourceItem(db.pool, { spaceId: SPACE, projectId: PROJECT, sourceItemId: firstItemId });
    const second = await materializeAcademicPaperFromSourceItem(db.pool, { spaceId: SPACE, projectId: PROJECT, sourceItemId: secondItemId });
    expect(second!.objectId).toBe(first!.objectId);

    await Promise.all([
      syncProjectCorpusForSourceItem(db.pool, { spaceId: SPACE, sourceItemId: firstItemId }),
      syncProjectCorpusForSourceItem(db.pool, { spaceId: SPACE, sourceItemId: secondItemId }),
    ]);

    const corpus = await db.pool.query<{ id: string; object_id: string; source_item_id: string | null }>(
      `SELECT id, object_id, source_item_id FROM project_corpus_items WHERE project_id = $1`,
      [PROJECT],
    );
    expect(corpus.rows).toEqual([
      expect.objectContaining({ object_id: first!.objectId, source_item_id: null }),
    ]);
    const provenance = await db.pool.query<{ source_item_id: string }>(
      `SELECT source_item_id FROM project_corpus_item_sources WHERE corpus_item_id = $1 ORDER BY source_item_id`,
      [corpus.rows[0]!.id],
    );
    expect(provenance.rows.map((row) => row.source_item_id).sort()).toEqual([firstItemId, secondItemId].sort());
  });

  it("enforces Reference bridge type and exact-one corpus targets in PostgreSQL", async () => {
    if (!db.available) return;
    const itemId = await seedArxivItem("2401.00006");
    const now = new Date().toISOString();
    const noteId = randomUUID();
    await db.pool.query(
      `INSERT INTO space_objects (id, space_id, object_type, title, created_at, updated_at)
       VALUES ($1,$2,'note','Not a Reference',$3,$3)`,
      [noteId, SPACE, now],
    );

    await expect(
      db.pool.query(
        `INSERT INTO source_item_references (source_item_id, space_id, reference_object_id, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$4)`,
        [itemId, SPACE, noteId, now],
      ),
    ).rejects.toMatchObject({ code: "23503" });

    const materialized = await materializeAcademicPaperFromSourceItem(db.pool, { spaceId: SPACE, projectId: PROJECT, sourceItemId: itemId });
    await expect(
      db.pool.query(
        `INSERT INTO project_corpus_items (
           id, space_id, project_id, object_id, source_item_id, role, status, triage_status, read_status,
           metadata_json, created_at, updated_at
         ) VALUES ($1,$2,$3,$4,$5,'candidate','active','new','unread','{}'::jsonb,$6,$6)`,
        [randomUUID(), SPACE, PROJECT, materialized!.objectId, itemId, now],
      ),
    ).rejects.toMatchObject({ code: "23514" });

    await expect(
      db.pool.query(
        `UPDATE source_items SET source_object_type = 'source', source_object_id = $2 WHERE id = $1`,
        [itemId, materialized!.objectId],
      ),
    ).rejects.toMatchObject({ code: "23514" });
  });

  it("returns null for a non-arXiv source item", async () => {
    if (!db.available) return;
    const itemId = randomUUID();
    const now = new Date().toISOString();
    await db.pool.query(
      `INSERT INTO source_items (
         id, space_id, owner_user_id, visibility, connection_id, item_type, title, first_seen_at, last_seen_at,
         content_state, retention_policy, created_at, updated_at
       ) VALUES ($1,$2,$3,'space_shared',$4,'external_url','A web page',$5,$5,'excerpt_saved','summary_only',$5,$5)`,
      [itemId, SPACE, OWNER, CONNECTION, now],
    );
    const result = await materializeAcademicPaperFromSourceItem(db.pool, { spaceId: SPACE, projectId: PROJECT, sourceItemId: itemId });
    expect(result).toBeNull();
  });
});
