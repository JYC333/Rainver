import { beforeEach, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { useTestDatabase } from "./support/testDatabase";
import { resetTables } from "./support/resetTables";
import { runRelationDiscoveryScan } from "../src/modules/knowledge/relationDiscovery";
import { insertKnowledgeItem } from "./support/knowledgeFixtures";

// Real-PostgreSQL coverage for Slice F discovery. Locks the SQL-facing behavior
// the FakeDb unit tests cannot: the knowledge_items/space_objects join, the
// readable visibility gate on both sources and targets, and alias resolution.

const SPACE = "11111111-1111-4111-8111-111111111111";
const VIEWER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OTHER = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";


const db = useTestDatabase(__filename);

beforeEach(async () => {
  if (!db.available) return;
  await resetTables(
    db.pool,
    ["artifacts", "activity_records", "source_connections", "source_provider_connectors", "source_providers", "source_connectors", "knowledge_items", "space_objects", "users", "spaces"],
    { cascade: true },
  );
  for (const id of [VIEWER, OTHER]) {
    await db.pool.query(
      `INSERT INTO users (id, display_name, status, created_at, updated_at)
       VALUES ($1, 'User', 'active', now(), now())`,
      [id],
    );
  }
  await db.pool.query(
    `INSERT INTO spaces (id, name, type, created_by_user_id, created_at, updated_at)
     VALUES ($1, 'Discovery Space', 'household', $2, now(), now())`,
    [SPACE, VIEWER],
  );
  await db.pool.query(
    `INSERT INTO space_memberships (id, space_id, user_id, role, status, created_at, updated_at)
     VALUES (gen_random_uuid()::varchar, $1, $2, 'owner', 'active', now(), now())`,
    [SPACE, VIEWER],
  );
});

async function insertNote(pool: Pool, input: { id: string; title: string; plainText: string }): Promise<void> {
  await db.pool.query(
    `WITH obj AS (
       INSERT INTO space_objects (id, space_id, object_type, title, summary, visibility, owner_user_id, created_by_user_id, created_at, updated_at) VALUES ($1, $2, 'note', $3, left($4, 200), 'space_shared', $5, $5, now(), now())
     )
     INSERT INTO notes (object_id, space_id, content_json, content_format, content_schema_version, plain_text)
     VALUES ($1, $2, '{}'::jsonb, 'markdown', 1, $4)`,
    [input.id, SPACE, input.title, input.plainText, VIEWER],
  );
}

async function insertActivity(pool: Pool, input: { id: string; title: string; content: string }): Promise<void> {
  await db.pool.query(
    `INSERT INTO activity_records (
       id, space_id, user_id, owner_user_id, activity_type, title, content,
       payload_json, occurred_at, created_at, updated_at, status, visibility
     ) VALUES ($1, $2, $3, $3, 'capture', $4, $5, '{}'::jsonb, now(), now(), now(), 'raw', 'space_shared')`,
    [input.id, SPACE, VIEWER, input.title, input.content],
  );
}

async function insertArtifact(
  pool: Pool,
  input: { id: string; title: string; content: string; ownerUserId?: string; metadata?: Record<string, unknown> },
): Promise<void> {
  await db.pool.query(
    `INSERT INTO artifacts (
       id, space_id, artifact_type, title, content, mime_type, export_formats_json,
       created_at, updated_at, metadata_json, visibility, owner_user_id
     ) VALUES ($1, $2, 'test_artifact', $3, $4, 'text/plain', '[]'::jsonb, now(), now(), $5::jsonb, 'space_shared', $6)`,
    [input.id, SPACE, input.title, input.content, JSON.stringify(input.metadata ?? {}), input.ownerUserId ?? VIEWER],
  );
}

async function insertSourceConnection(
  pool: Pool,
  input: { id: string; connectorId: string; ownerUserId: string; allowSpaceAdmins?: boolean; allowedReaderUserIds?: string[] },
): Promise<void> {
  await db.pool.query(
    `INSERT INTO source_connectors (
       id, connector_key, display_name, connector_type, ingestion_mode, status,
       capabilities_json, created_at, updated_at
     ) VALUES ($1, $2, 'Test connector', 'external_url', 'manual', 'active', '{}'::jsonb, now(), now())`,
    [input.connectorId, `test-${input.connectorId}`],
  );
  await db.pool.query(
    `INSERT INTO source_providers (id, provider_key, display_name, provider_kind, category, status, capabilities_json, created_at, updated_at)
     VALUES ($1, $2, 'Test provider', 'generic', 'test', 'active', '{}'::jsonb, now(), now())`,
    [input.connectorId, `test-${input.connectorId}`],
  );
  await db.pool.query(
    `INSERT INTO source_provider_connectors (id, provider_id, connector_id, status, priority, capabilities_json, created_at, updated_at)
     VALUES ($1,$1,$1,'active',0,'{}'::jsonb,now(),now())`,
    [input.connectorId],
  );
  const consent = {
    schema_version: 1,
    owner_user_id: input.ownerUserId,
    allowed_reader_user_ids: input.allowedReaderUserIds ?? [],
    allowed_agent_ids: [],
    allow_space_admins: input.allowSpaceAdmins ?? false,
    allow_local_provider_egress: true,
    allow_external_model_egress: true,
  };
  const policy = {
    schema_version: 1,
    source_egress_class: "external_provider_allowed",
  };
  await db.pool.query(
    `INSERT INTO source_connections (
       id, space_id, provider_connector_id, owner_user_id, name, status,
       capture_policy, trust_level, topic_hints_json, consent_json, policy_json,
       config_json, created_at, updated_at
     ) VALUES (
       $1, $2, $3, $4, 'Denied source', 'active',
       'reference_only', 'normal', '[]'::jsonb, $5::jsonb, $6::jsonb,
       '{}'::jsonb, now(), now()
     )`,
    [input.id, SPACE, input.connectorId, input.ownerUserId, JSON.stringify(consent), JSON.stringify(policy)],
  );
}

describe("Slice F relation discovery (real Postgres)", () => {
  it("resolves a wikilink to a visible item and proposes a relation", async () => {
    if (!db.available) return;
    await insertKnowledgeItem(db.pool, { id: "item-b", spaceId: SPACE, title: "Beta", content: "Beta page.", slug: "beta", ownerUserId: VIEWER, createdByUserId: VIEWER });
    await insertKnowledgeItem(db.pool, { id: "item-a", spaceId: SPACE, title: "Alpha", content: "Alpha depends on [[Beta]].", slug: "alpha", ownerUserId: VIEWER, createdByUserId: VIEWER });

    const { report } = await runRelationDiscoveryScan(db.pool, {
      spaceId: SPACE,
      userId: VIEWER,
      request: {
        limit: 200,
        max_candidates: 40,
        review_scope: "private",
        include_unresolved_item_candidates: false,
        llm_extraction_enabled: false,
        llm_max_sources: 8,
        create_packet: true,
      },
    });

    expect(report.candidates).toHaveLength(1);
    expect(report.candidates[0]!.proposed_action).toMatchObject({
      proposal_type: "object_relation_create",
      from_object_id: "item-a",
      to_object_id: "item-b",
    });
  });

  it("a note source proposes an object_relation_create for a resolved wikilink", async () => {
    if (!db.available) return;
    await insertKnowledgeItem(db.pool, { id: "item-b", spaceId: SPACE, title: "Beta", content: "Beta page.", slug: "beta", ownerUserId: VIEWER, createdByUserId: VIEWER });
    await insertNote(db.pool, { id: "note-a", title: "Daily note", plainText: "Talked about [[Beta]] today." });

    const { report } = await runRelationDiscoveryScan(db.pool, {
      spaceId: SPACE,
      userId: VIEWER,
      request: {
        source_object_types: ["knowledge_item", "note"],
        limit: 200,
        max_candidates: 40,
        review_scope: "private",
        include_unresolved_item_candidates: false,
        llm_extraction_enabled: false,
        llm_max_sources: 8,
        create_packet: true,
      },
    });

    const candidate = report.candidates.find((c) => c.kind === "object_relation_candidate");
    expect(candidate).toBeDefined();
    expect(candidate!.proposed_action).toMatchObject({
      proposal_type: "object_relation_create",
      from_object_id: "note-a",
      to_object_id: "item-b",
    });
  });

  it("does not resolve a wikilink to an item the viewer cannot read", async () => {
    if (!db.available) return;
    // Target is private to OTHER -> invisible to VIEWER; the link must not wire
    // to a hidden object, and the unresolved stub stays off by default.
    await insertKnowledgeItem(db.pool, { id: "secret", spaceId: SPACE, title: "Secret", content: "hidden", slug: "secret", visibility: "private", ownerUserId: OTHER, createdByUserId: OTHER });
    await insertKnowledgeItem(db.pool, { id: "item-a", spaceId: SPACE, title: "Alpha", content: "Alpha links to [[Secret]].", slug: "alpha", ownerUserId: VIEWER, createdByUserId: VIEWER });

    const { report } = await runRelationDiscoveryScan(db.pool, {
      spaceId: SPACE,
      userId: VIEWER,
      request: {
        limit: 200,
        max_candidates: 40,
        review_scope: "private",
        include_unresolved_item_candidates: false,
        llm_extraction_enabled: false,
        llm_max_sources: 8,
        create_packet: true,
      },
    });

    expect(report.candidates).toHaveLength(0);
  });

  it("scans visible activity and artifact text as review-only relation evidence", async () => {
    if (!db.available) return;
    await insertKnowledgeItem(db.pool, { id: "item-b", spaceId: SPACE, title: "Beta", content: "Beta page.", slug: "beta", ownerUserId: VIEWER, createdByUserId: VIEWER });
    await insertActivity(db.pool, { id: "activity-a", title: "Inbox", content: "Captured [[supports::Beta]]." });
    await insertArtifact(db.pool, { id: "artifact-a", title: "Report", content: "Report says depends_on -> [[Beta]]." });

    const { report } = await runRelationDiscoveryScan(db.pool, {
      spaceId: SPACE,
      userId: VIEWER,
      request: {
        source_object_types: ["activity", "artifact"],
        limit: 200,
        max_candidates: 40,
        review_scope: "private",
        include_unresolved_item_candidates: false,
        llm_extraction_enabled: false,
        llm_max_sources: 8,
        create_packet: true,
      },
    });

    expect(report.candidates).toHaveLength(2);
    expect(report.candidates.every((candidate) => candidate.kind === "relation_review_candidate")).toBe(true);
    expect(report.candidates.every((candidate) => candidate.proposed_action === null)).toBe(true);
    expect(report.counts.proposal_candidate).toBe(0);
    expect(report.counts.review_only_candidate).toBe(2);
  });

  it("fails closed for artifact text whose source policy denies the viewer", async () => {
    if (!db.available) return;
    const connectionId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
    await insertKnowledgeItem(db.pool, { id: "item-b", spaceId: SPACE, title: "Beta", content: "Beta page.", slug: "beta", ownerUserId: VIEWER, createdByUserId: VIEWER });
    await insertSourceConnection(db.pool, {
      id: connectionId,
      connectorId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
      ownerUserId: OTHER,
      allowSpaceAdmins: false,
    });
    await insertArtifact(db.pool, {
      id: "artifact-denied",
      title: "Denied Report",
      content: "Denied source says [[Beta]].",
      ownerUserId: VIEWER,
      metadata: { source_connection_ids: [connectionId] },
    });

    const { report } = await runRelationDiscoveryScan(db.pool, {
      spaceId: SPACE,
      userId: VIEWER,
      request: {
        source_object_types: ["artifact"],
        limit: 200,
        max_candidates: 40,
        review_scope: "private",
        include_unresolved_item_candidates: false,
        llm_extraction_enabled: false,
        llm_max_sources: 8,
        create_packet: true,
      },
    });

    expect(report.sources_scanned).toBe(0);
    expect(report.candidates).toHaveLength(0);
    expect(report.access_safety.source_policy_enforced).toBe(true);
  });
});
