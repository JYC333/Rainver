import { beforeEach, describe, expect, it } from "vitest";
import { useTestDatabase } from "./support/testDatabase.js";
import { resetTables } from "./support/resetTables.js";
import { ContextOpsService } from "../src/modules/contextOps/service.js";
import { RetrievalMaintenanceService } from "../src/modules/retrieval/maintenance/service.js";
import { RetrievalProjectionService } from "../src/modules/retrieval/projectionService.js";
import { RetrievalSearchService } from "../src/modules/retrieval/searchService.js";
import { knowledgeRetrievalRegistry } from "../src/modules/knowledge/retrievalAdapter.js";
import { insertKnowledgeItem } from "./support/knowledgeFixtures.js";

// Closes Slice-1 audit gaps end-to-end over real Postgres:
//   G4 — a connector-ingested object lands a provenance_link → source_item →
//        source_connection, so the projection carries source_connection_ids and
//        search fails closed for a non-allowed reader.
//   G1 — the maintenance scan applies the same source read policy and never
//        surfaces a source-restricted object to a non-allowed operator.
//   G5 — Context Ops drill-down object lists apply the same source read policy.
// Both knowledge items are canonically space_shared, so ONLY the source policy
// differentiates the restricted object — isolating the gate under test.

const SPACE = "11111111-1111-4111-8111-111111111111";
const OWNER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"; // source owner — allowed reader
const READER = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"; // space member — NOT an allowed reader
const SOURCE = "source-restricted-1";
const CONNECTOR = "connector-1";
const LONG = "This page has more than enough searchable content to clear the thin threshold comfortably here.";


const db = useTestDatabase(import.meta.filename);

beforeEach(async () => {
  if (!db.available) return;
  await resetTables(
    db.pool,
    ["retrieval_objects", "retrieval_aliases", "retrieval_chunks", "retrieval_edges", "knowledge_items", "space_object_profiles", "space_objects", "provenance_links", "source_items", "source_connections", "source_provider_connectors", "source_providers", "source_connectors", "users", "spaces"],
    { cascade: true },
  );
  await db.pool.query(`INSERT INTO spaces (id, name, type, created_at, updated_at) VALUES ($1, 'SP', 'personal', now(), now())`, [SPACE]);
  for (const id of [OWNER, READER]) {
    await db.pool.query(`INSERT INTO users (id, display_name, status, created_at, updated_at) VALUES ($1, 'U', 'active', now(), now())`, [id]);
  }
  const memberships: Array<[string, string, string]> = [["mem-owner", OWNER, "owner"], ["mem-reader", READER, "member"]];
  for (const [id, user, role] of memberships) {
    await db.pool.query(
      `INSERT INTO space_memberships (id, space_id, user_id, role, status, created_at, updated_at)
       VALUES ($1, $2, $3, $4, 'active', now(), now())`,
      [id, SPACE, user, role],
    );
  }
}, 30_000);

async function seedRestrictedAndOpen(): Promise<void> {
  // Restricted source: only OWNER may read (no allowed readers, admins denied).
  await db.pool.query(
    `INSERT INTO source_connectors (id, connector_key, display_name, connector_type, ingestion_mode, status, capabilities_json, created_at, updated_at)
     VALUES ($1, 'rss', 'RSS', 'external_feed', 'pull', 'active', '{}'::jsonb, now(), now())`,
    [CONNECTOR],
  );
  await db.pool.query(
    `INSERT INTO source_providers (id, provider_key, display_name, provider_kind, category, status, capabilities_json, created_at, updated_at)
     VALUES ($1, 'test-rss', 'RSS', 'generic', 'test', 'active', '{}'::jsonb, now(), now())`,
    [CONNECTOR],
  );
  await db.pool.query(
    `INSERT INTO source_provider_connectors (id, provider_id, connector_id, status, priority, capabilities_json, created_at, updated_at)
     VALUES ($1,$1,$1,'active',0,'{}'::jsonb,now(),now())`,
    [CONNECTOR],
  );
  await db.pool.query(
    `INSERT INTO source_connections (
       id, space_id, provider_connector_id, owner_user_id, name, status,
       capture_policy, trust_level, consent_json, policy_json, config_json, created_at, updated_at
     ) VALUES (
       $1, $2, $3, $4, 'Private feed', 'active',
       'extract_text', 'normal', $5::jsonb, $6::jsonb, '{}'::jsonb, now(), now()
     )`,
    [
      SOURCE, SPACE, CONNECTOR, OWNER,
      JSON.stringify({
        schema_version: 1,
        owner_user_id: OWNER,
        allowed_reader_user_ids: [],
        allowed_agent_ids: [],
        allow_space_admins: false,
        allow_local_provider_egress: true,
        allow_external_model_egress: false,
      }),
      JSON.stringify({ schema_version: 1, source_egress_class: "local_provider_allowed" }),
    ],
  );

  await db.pool.query(
    `INSERT INTO space_object_profiles (
       id, space_id, key, label, base_object_type, status, created_at, updated_at
     ) VALUES
       ('kind-concept', $1, 'concept', 'Concept', 'knowledge_item', 'active', now(), now()),
       ('kind-decision', $1, 'decision', 'Decision', 'knowledge_item', 'active', now(), now())`,
    [SPACE],
  );

  await insertKnowledgeItem(db.pool, {
    id: "restricted-doc",
    spaceId: SPACE,
    title: "Alpha Restricted",
    content: `Restricted alpha. ${LONG}`,
    slug: "restricted-doc",
    knowledgeKind: "concept",
  });
  await insertKnowledgeItem(db.pool, {
    id: "open-doc",
    spaceId: SPACE,
    title: "Alpha Open",
    content: `Open alpha. ${LONG}`,
    slug: "open-doc",
    knowledgeKind: "decision",
  });

  // Connector linkage: source_item carries the connection id; a provenance_link
  // ties the knowledge object to it (source_type = source_item).
  await db.pool.query(
    `INSERT INTO source_items (
       id, space_id, owner_user_id, visibility, connection_id, item_type, title, first_seen_at, last_seen_at,
       content_state, retention_policy, created_at, updated_at
     ) VALUES (
       $1, $2, $3, 'space_shared', $4, 'feed_entry', 'Restricted alpha', now(), now(),
       'content_saved', 'full_text', now(), now()
     )`,
    [SOURCE, SPACE, OWNER, SOURCE],
  );
  await db.pool.query(
    `INSERT INTO provenance_links (id, space_id, target_type, target_id, source_type, source_id, source_trust, created_at)
     VALUES ($1, $2, 'knowledge', 'restricted-doc', 'source_item', $3, 'trusted_external', now())`,
    ["prov-1", SPACE, SOURCE],
  );

  await new RetrievalProjectionService(db.pool, knowledgeRetrievalRegistry).reindexAll(SPACE);
}

describe("Retrieval source policy closure (real Postgres)", () => {
  it("G4: projects source_connection_ids from the connector provenance chain", async () => {
    if (!db.available) return;
    await seedRestrictedAndOpen();
    const row = await db.pool.query<{ source_connection_ids_json: unknown }>(
      `SELECT source_connection_ids_json FROM retrieval_objects WHERE space_id = $1 AND object_id = 'restricted-doc'`,
      [SPACE],
    );
    expect(row.rows[0]?.source_connection_ids_json).toEqual([SOURCE]);
  });

  it("G4: search fails closed for a non-allowed reader and open for the owner", async () => {
    if (!db.available) return;
    await seedRestrictedAndOpen();
    const service = new RetrievalSearchService(db.pool, knowledgeRetrievalRegistry);

    const ownerResults = await service.search({ spaceId: SPACE, viewerUserId: OWNER, query: "alpha" });
    expect(ownerResults.items.map((i) => i.object_id).sort()).toEqual(["open-doc", "restricted-doc"]);

    const readerResults = await service.search({ spaceId: SPACE, viewerUserId: READER, query: "alpha", includeTrace: true });
    const readerIds = readerResults.items.map((i) => i.object_id);
    expect(readerIds).toContain("open-doc");
    expect(readerIds).not.toContain("restricted-doc");
    expect(JSON.stringify(readerResults.trace)).not.toContain("source_policy_denied");
  });

  it("G2: object_profile filters do not reveal source-restricted kind distributions", async () => {
    if (!db.available) return;
    await seedRestrictedAndOpen();
    const service = new RetrievalSearchService(db.pool, knowledgeRetrievalRegistry);

    const ownerConcept = await service.search({
      spaceId: SPACE,
      viewerUserId: OWNER,
      query: "alpha",
      objectTypes: ["knowledge_item"],
      objectProfiles: ["concept"],
      includeTrace: true,
    });
    expect(ownerConcept.items).toHaveLength(1);
    expect(ownerConcept.items[0]).toMatchObject({
      object_id: "restricted-doc",
      object_profile: "concept",
      object_profile_label: "Concept",
    });

    const readerConcept = await service.search({
      spaceId: SPACE,
      viewerUserId: READER,
      query: "alpha",
      objectTypes: ["knowledge_item"],
      objectProfiles: ["concept"],
      includeTrace: true,
    });
    expect(readerConcept.items).toHaveLength(0);
    const serializedTrace = JSON.stringify(readerConcept.trace);
    expect(serializedTrace).not.toContain("concept");
    expect(serializedTrace).not.toContain("restricted-doc");
    expect(serializedTrace).not.toContain("Alpha Restricted");
    expect(serializedTrace).not.toContain("source_policy_denied");
  });

  it("G1: maintenance scan hides the source-restricted object from a non-allowed operator", async () => {
    if (!db.available) return;
    await seedRestrictedAndOpen();
    const service = new RetrievalMaintenanceService(db.pool, knowledgeRetrievalRegistry);

    const ownerReport = await service.scan(SPACE, OWNER);
    const ownerIds = ownerReport.findings.flatMap((f) => f.objects.map((o) => o.object_id));
    expect(ownerIds).toContain("restricted-doc"); // owner is an allowed reader

    const readerReport = await service.scan(SPACE, READER);
    const readerIds = readerReport.findings.flatMap((f) => f.objects.map((o) => o.object_id));
    expect(readerIds).toContain("open-doc");
    expect(readerIds).not.toContain("restricted-doc"); // source-restricted ⇒ never surfaced
  });

  it("G5: Context Ops drill-down hides the source-restricted object from a non-allowed operator", async () => {
    if (!db.available) return;
    await seedRestrictedAndOpen();
    const service = new ContextOpsService(db.pool);

    const ownerDrilldown = await service.getDrilldown({
      spaceId: SPACE,
      userId: OWNER,
      section: "embedding_backlog",
      limit: 10,
      registry: knowledgeRetrievalRegistry,
      includeAllSources: false,
      now: new Date("2026-06-25T12:00:00.000Z"),
    });
    const ownerIds = ownerDrilldown.objects.map((object) => object.object_id);
    expect(ownerIds).toContain("restricted-doc");

    const readerDrilldown = await service.getDrilldown({
      spaceId: SPACE,
      userId: READER,
      section: "embedding_backlog",
      limit: 10,
      registry: knowledgeRetrievalRegistry,
      includeAllSources: false,
      now: new Date("2026-06-25T12:00:00.000Z"),
    });
    const readerIds = readerDrilldown.objects.map((object) => object.object_id);
    expect(readerIds).toContain("open-doc");
    expect(readerIds).not.toContain("restricted-doc");
  });
});
