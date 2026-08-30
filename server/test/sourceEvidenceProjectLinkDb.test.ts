import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { useTestDatabase } from "./support/testDatabase.js";
import { resetTables } from "./support/resetTables.js";
import {
  linkEvidenceToBoundProjects,
  recomputeProjectSourceBindingLinks,
} from "../src/modules/projects/projectSourceRoutingService.js";
import { upsertCanonicalEvidence } from "../src/modules/sources/evidenceIdentity.js";
import { PgSourcesRepository } from "../src/modules/sources/repository.js";
import { sourceRetrievalAdapter } from "../src/modules/sources/retrievalAdapter.js";
import type { ServerConfig } from "../src/config.js";
import { ProjectCorpusRepository } from "../src/modules/projects/corpusRepository.js";
import { ProjectResearchArtifactService } from "../src/modules/projectResearch/artifactService.js";
import { PgArtifactRepository } from "../src/modules/artifacts/repository.js";
import { PgActivityRepository } from "../src/modules/activity/repository.js";
import { seedMainlineRoomsForAllProjects } from "./support/domainSeeds.js";

// Real-PostgreSQL tests for evidence→project auto-linking on materialization:
// bound sources produce active `context_candidate` project links, re-runs are
// idempotent (partial unique index), unbound/paused bindings produce nothing,
// and the context evidence selector actually returns the auto-linked evidence
// for a project-scoped selection. Skips when Docker is unavailable.

const SPACE = "11111111-1111-4111-8111-111111111111";
const OWNER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OTHER_USER = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const PROJECT = "55555555-5555-4555-8555-555555555555";
const PROJECT_B = "66666666-6666-4666-8666-666666666666";
const CONNECTOR = "33333333-3333-4333-8333-333333333333";
const CONNECTION = "44444444-4444-4444-8444-444444444444";


const db = useTestDatabase(import.meta.filename);

beforeEach(async () => {
  if (!db.available) return;
  await resetTables(
    db.pool,
    ["evidence_links", "extracted_evidence", "source_snapshots", "source_items", "project_source_item_links", "project_source_bindings", "source_channel_item_links", "source_channel_user_subscriptions", "source_channels", "source_connections", "source_provider_connectors", "source_providers", "source_connectors", "project_members", "projects", "space_memberships", "users", "spaces"],
    { cascade: true },
  );
  const now = new Date().toISOString();
  await db.pool.query(
    `INSERT INTO spaces (id, name, type, created_at, updated_at) VALUES ($1,'Main','personal',$2,$2)`,
    [SPACE, now],
  );
  await db.pool.query(
    `INSERT INTO users (id, display_name, status, created_at, updated_at)
     VALUES ($1,$1,'active',$3,$3), ($2,$2,'active',$3,$3)`,
    [OWNER, OTHER_USER, now],
  );
  await db.pool.query(
    `INSERT INTO space_memberships (id, space_id, user_id, role, status, created_at, updated_at)
     VALUES ($1,$2,$3,'owner','active',$5,$5), ($4,$2,$6,'member','active',$5,$5)`,
    [randomUUID(), SPACE, OWNER, randomUUID(), now, OTHER_USER],
  );
  await db.pool.query(
    `INSERT INTO projects (id, space_id, owner_user_id, name, status, created_at, updated_at)
     VALUES ($1,$2,$3,'Research','active',$4,$4), ($5,$2,$3,'Second','active',$4,$4)`,
    [PROJECT, SPACE, OWNER, now, PROJECT_B],
  );
  await seedMainlineRoomsForAllProjects(db.pool);
  await db.pool.query(
    `INSERT INTO source_connectors (
       id, connector_key, display_name, connector_type, ingestion_mode, status,
       capabilities_json, created_at, updated_at
     ) VALUES ($1,'rss','RSS','external_feed','pull','active','{}'::jsonb,$2,$2)`,
    [CONNECTOR, now],
  );
  const providerId = randomUUID();
  const mappingId = randomUUID();
  await db.pool.query(
    `INSERT INTO source_providers (id, provider_key, display_name, provider_kind, category, status, capabilities_json, created_at, updated_at)
     VALUES ($1,'generic_rss','RSS','generic','feed','active','{}'::jsonb,$2,$2)`,
    [providerId, now],
  );
  await db.pool.query(
    `INSERT INTO source_provider_connectors (id, provider_id, connector_id, status, priority, capabilities_json, created_at, updated_at)
     VALUES ($1,$2,$3,'active',0,'{}'::jsonb,$4,$4)`,
    [mappingId, providerId, CONNECTOR, now],
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
     ) VALUES ($1,$2,$1,$3,'RSS Channel','feed','https://example.org/rss','{}'::jsonb,'{}'::jsonb,$1,'active','daily','{"frequency":"daily","hour":0,"minute":0}'::jsonb,$4,$4)`,
    [CONNECTION, SPACE, OWNER, now],
  );
  await db.pool.query(
    `INSERT INTO source_channel_user_subscriptions (id, space_id, source_channel_id, user_id, status, library_enabled, digest_enabled, created_at, updated_at)
     VALUES ($1,$2,$3,$4,'subscribed',true,true,$5,$5)`,
    [randomUUID(), SPACE, CONNECTION, OWNER, now],
  );
});

async function seedBinding(projectId: string, status = "active", bindingKey = "default"): Promise<string> {
  const id = randomUUID();
  const now = new Date().toISOString();
  await db.pool.query(
    `INSERT INTO project_source_bindings (
       id, space_id, project_id, source_channel_id, binding_key,
       status, priority, delivery_scope, collection_notifications_enabled,
       filters_json, routing_policy_json, extraction_policy_json,
       created_at, updated_at
     ) VALUES ($1,$2,$3,$4,$5,$6,0,'project_members',true,'{}'::jsonb,'{}'::jsonb,'{}'::jsonb,$7,$7)`,
    [id, SPACE, projectId, CONNECTION, bindingKey, status, now],
  );
  return id;
}

async function seedItemWithEvidence(connectionId: string | null = CONNECTION): Promise<{ itemId: string; evidenceId: string }> {
  const itemId = randomUUID();
  const evidenceId = randomUUID();
  const now = new Date().toISOString();
  await db.pool.query(
    `INSERT INTO source_items (
       id, space_id, owner_user_id, visibility, connection_id, item_type, title, first_seen_at, last_seen_at,
       content_state, retention_policy, created_at, updated_at
     ) VALUES ($1,$2,$3,'space_shared',$4,'external_url','New paper',$5,$5,'excerpt_saved','summary_only',$5,$5)`,
    [itemId, SPACE, OWNER, connectionId, now],
  );
  await db.pool.query(
    `INSERT INTO extracted_evidence (
       id, space_id, owner_user_id, visibility, source_item_id, source_object_type, source_object_id,
       evidence_type, title, content_excerpt, extraction_method, trust_level,
       confidence, status, metadata_json, created_at, updated_at
     ) VALUES ($1,$2,$3,'space_shared',$4,'source_item',$4,'excerpt','New paper','Abstract text','connection_scan','normal',
       0.55,'candidate','{}'::jsonb,$5,$5)`,
    [evidenceId, SPACE, OWNER, itemId, now],
  );
  return { itemId, evidenceId };
}

async function seedSourceSnapshot(itemId: string, connectionId: string): Promise<void> {
  const now = new Date().toISOString();
  await db.pool.query(
    `INSERT INTO source_snapshots (
       id, space_id, owner_user_id, visibility, source_item_id, connection_id, snapshot_type, content_hash,
       source_uri, capture_method, trust_level, metadata_json, captured_at, created_at, updated_at
     ) VALUES ($1,$2,$3,'space_shared',$4,$5,'metadata','hash','https://example.org/paper',
       'connection_scan','normal','{}'::jsonb,$6,$6,$6)`,
    [randomUUID(), SPACE, OWNER, itemId, connectionId, now],
  );
}

async function seedConnectionOnlySnapshot(): Promise<string> {
  const id = randomUUID();
  const now = new Date().toISOString();
  await db.pool.query(
    `INSERT INTO source_snapshots (
       id, space_id, owner_user_id, visibility, connection_id, snapshot_type, content_hash,
       source_uri, capture_method, trust_level, metadata_json, captured_at, created_at, updated_at
     ) VALUES ($1,$2,$3,'space_shared',$4,'metadata','connection-only-hash','https://example.org/snapshot',
       'connection_scan','normal','{}'::jsonb,$5,$5,$5)`,
    [id, SPACE, OWNER, CONNECTION, now],
  );
  return id;
}

describe("Evidence→project auto-link (real Postgres)", () => {
  it("rejects duplicate post-processing evidence for the same source content", async () => {
    if (!db.available) return;
    const { itemId } = await seedItemWithEvidence();
    const now = new Date().toISOString();
    const key = [randomUUID(), SPACE, OWNER, itemId, "post-processing-hash", "source_post_processing", now];
    const insert = `INSERT INTO extracted_evidence (
       id, space_id, owner_user_id, visibility, source_item_id, source_object_type, source_object_id,
       evidence_type, title, content_excerpt, content_hash, extraction_method, trust_level,
       confidence, status, metadata_json, created_at, updated_at
     ) VALUES ($1,$2,$3,'space_shared',$4,'source_item',$4,'summary','Summary','Content',$5,$6,'normal',
       0.7,'candidate','{}'::jsonb,$7,$7)`;
    await db.pool.query(insert, key);
    await expect(db.pool.query(insert, [randomUUID(), SPACE, OWNER, itemId, "post-processing-hash", "manual", now])).rejects.toMatchObject({
      code: "23505",
      constraint: "uq_extracted_evidence_source_content",
    });
  });

  it("reuses canonical content identity while preserving distinct extraction observations", async () => {
    if (!db.available) return;
    const { itemId } = await seedItemWithEvidence();
    const now = new Date().toISOString();
    const common = {
      spaceId: SPACE,
      projectId: null,
      ownerUserId: OWNER,
      visibility: "space_shared",
      accessLevel: "full",
      sourceItemId: itemId,
      sourceObjectType: "source_item",
      sourceObjectId: itemId,
      title: "Canonical text",
      contentExcerpt: "Same canonical content",
      contentHash: "canonical-content-hash",
      trustLevel: "normal",
      confidence: 0.7,
      status: "candidate",
      observedAt: now,
    };
    const first = await upsertCanonicalEvidence(db.pool, {
      ...common,
      evidenceType: "summary",
      extractionMethod: "source_post_processing",
      createdByRunId: null,
      metadata: { source: "digest" },
    });
    const second = await upsertCanonicalEvidence(db.pool, {
      ...common,
      evidenceType: "excerpt",
      extractionMethod: "manual",
      createdByUserId: OWNER,
      metadata: { source: "reader" },
    });
    expect(second).toBe(first);
    const row = await db.pool.query<{ observations: unknown[] }>(
      `SELECT metadata_json->'evidence_observations' AS observations
         FROM extracted_evidence WHERE id=$1`,
      [first],
    );
    expect(row.rows[0]!.observations).toHaveLength(2);
    await upsertCanonicalEvidence(db.pool, {
      ...common,
      evidenceType: "excerpt",
      extractionMethod: "manual",
      createdByUserId: OWNER,
      metadata: { source: "reader" },
    });
    const retry = await db.pool.query<{ count: number }>(
      `SELECT jsonb_array_length(metadata_json->'evidence_observations')::int AS count
         FROM extracted_evidence WHERE id=$1`,
      [first],
    );
    expect(retry.rows[0]!.count).toBe(2);
  });

  it("does not merge ACL-scoped annotation Evidence into Source content identity", async () => {
    if (!db.available) return;
    const now = new Date().toISOString();
    const common = {
      spaceId: SPACE,
      projectId: null,
      accessLevel: "full",
      sourceItemId: null,
      sourceObjectType: "reader_annotation",
      evidenceType: "excerpt",
      title: "Same quote",
      contentExcerpt: "Same quote text",
      contentHash: "same-reader-quote",
      trustLevel: "normal",
      extractionMethod: "manual",
      status: "candidate",
      observedAt: now,
    };
    const privateId = await upsertCanonicalEvidence(db.pool, {
      ...common,
      ownerUserId: OWNER,
      visibility: "private",
      sourceObjectId: "annotation-private",
      metadata: { annotation_id: "annotation-private" },
      createdByUserId: OWNER,
    });
    const sharedId = await upsertCanonicalEvidence(db.pool, {
      ...common,
      ownerUserId: OWNER,
      visibility: "space_shared",
      sourceObjectId: "annotation-shared",
      metadata: { annotation_id: "annotation-shared" },
      createdByUserId: OWNER,
    });
    expect(sharedId).not.toBe(privateId);
    const rows = await db.pool.query<{ id: string; visibility: string; annotation_id: string }>(
      `SELECT id, visibility, metadata_json->>'annotation_id' AS annotation_id
         FROM extracted_evidence WHERE id=ANY($1::varchar[]) ORDER BY visibility`,
      [[privateId, sharedId]],
    );
    expect(rows.rows).toEqual([
      { id: privateId, visibility: "private", annotation_id: "annotation-private" },
      { id: sharedId, visibility: "space_shared", annotation_id: "annotation-shared" },
    ]);
  });

  it("preserves canonical extraction observations when Evidence metadata is patched", async () => {
    if (!db.available) return;
    const { itemId } = await seedItemWithEvidence();
    const now = new Date().toISOString();
    const evidenceId = await upsertCanonicalEvidence(db.pool, {
      spaceId: SPACE,
      projectId: null,
      ownerUserId: OWNER,
      visibility: "space_shared",
      accessLevel: "full",
      sourceItemId: itemId,
      sourceObjectType: "source_item",
      sourceObjectId: itemId,
      evidenceType: "summary",
      title: "Observed summary",
      contentExcerpt: "Observed content",
      contentHash: "observed-content-hash",
      trustLevel: "normal",
      extractionMethod: "source_post_processing",
      status: "candidate",
      metadata: { producer: "digest" },
      observedAt: now,
    });
    const repository = new PgSourcesRepository(db.pool, {} as ServerConfig);
    await repository.updateEvidence({ spaceId: SPACE, userId: OWNER }, evidenceId, {
      metadata: { edited: true, evidence_observations: [{ forged: true }] },
    });
    const row = await db.pool.query<{ metadata: Record<string, unknown> }>(
      `SELECT metadata_json AS metadata FROM extracted_evidence WHERE id=$1`,
      [evidenceId],
    );
    expect(row.rows[0]!.metadata.edited).toBe(true);
    expect(row.rows[0]!.metadata.evidence_observations).toEqual([
      expect.objectContaining({ extraction_method: "source_post_processing" }),
    ]);
  });

  it("keeps annotation Evidence outside content dedupe while enforcing its origin Source gate", async () => {
    if (!db.available) return;
    const { itemId } = await seedItemWithEvidence();
    const evidenceId = await upsertCanonicalEvidence(db.pool, {
      spaceId: SPACE,
      projectId: null,
      ownerUserId: OWNER,
      visibility: "space_shared",
      accessLevel: "full",
      sourceItemId: null,
      originSourceItemId: itemId,
      sourceObjectType: "reader_annotation",
      sourceObjectId: "annotation-origin-gated",
      evidenceType: "excerpt",
      title: "Origin-gated quote",
      contentExcerpt: "A human observation of source content",
      contentHash: "origin-gated-quote",
      trustLevel: "normal",
      extractionMethod: "manual",
      status: "candidate",
      observedAt: new Date().toISOString(),
    });
    const repository = new PgSourcesRepository(db.pool, {} as ServerConfig);
    const filters = {
      status: null, evidenceType: null, sourceItemId: null, projectId: null, connectionId: null, limit: 50, offset: 0,
    };
    const ownerPage = await repository.listEvidence({ spaceId: SPACE, userId: OWNER }, filters);
    expect(ownerPage.items.map((item) => item.id)).toContain(evidenceId);
    const unconsentedPage = await repository.listEvidence({ spaceId: SPACE, userId: OTHER_USER }, filters);
    expect(unconsentedPage.items.map((item) => item.id)).not.toContain(evidenceId);
    await expect(repository.getEvidence({ spaceId: SPACE, userId: OTHER_USER }, evidenceId)).resolves.toBeNull();

    const corpus = new ProjectCorpusRepository(db.pool);
    const corpusItem = await corpus.upsert({ spaceId: SPACE, userId: OWNER }, PROJECT, { evidence_id: evidenceId });
    await db.pool.query(
      `INSERT INTO project_members (id,space_id,project_id,user_id,role,status,created_at,updated_at)
       VALUES ($1,$2,$3,$4,'member','active',$5,$5)`,
      [randomUUID(), SPACE, PROJECT, OTHER_USER, new Date().toISOString()],
    );
    await expect(corpus.update(
      { spaceId: SPACE, userId: OTHER_USER }, PROJECT, String(corpusItem.id), { role: "reference" },
    )).rejects.toMatchObject({ statusCode: 404 });
    const ownerCorpus = await corpus.list({ spaceId: SPACE, userId: OWNER }, PROJECT, { limit: 50, offset: 0 });
    expect((ownerCorpus.items as Array<{ id: string }>).map((item) => item.id)).toHaveLength(1);
    const unconsentedCorpus = await corpus.list({ spaceId: SPACE, userId: OTHER_USER }, PROJECT, { limit: 50, offset: 0 });
    expect(unconsentedCorpus.items as unknown[]).toHaveLength(0);

    // The Project Overview's corpus counts run the same readability predicate
    // as the list, so a row the viewer cannot open is not counted for them
    // either — a count is a disclosure.
    await expect(corpus.entityCounts({ spaceId: SPACE, userId: OWNER }, PROJECT))
      .resolves.toEqual({ source_item_count: 1, extracted_evidence_count: 1 });
    await expect(corpus.entityCounts({ spaceId: SPACE, userId: OTHER_USER }, PROJECT))
      .resolves.toEqual({ source_item_count: 0, extracted_evidence_count: 0 });

    await expect(sourceRetrievalAdapter.revalidate(db.pool, SPACE, "extracted_evidence", evidenceId, OWNER)).resolves.not.toBeNull();
    await expect(sourceRetrievalAdapter.revalidate(db.pool, SPACE, "extracted_evidence", evidenceId, OTHER_USER)).resolves.toBeNull();
  });

  it("enforces snapshot connection consent when annotation Evidence has no origin Source item", async () => {
    if (!db.available) return;
    const snapshotId = await seedConnectionOnlySnapshot();
    const evidenceId = await upsertCanonicalEvidence(db.pool, {
      spaceId: SPACE,
      projectId: null,
      ownerUserId: OWNER,
      visibility: "space_shared",
      accessLevel: "full",
      sourceItemId: null,
      sourceSnapshotId: snapshotId,
      sourceObjectType: "reader_annotation",
      sourceObjectId: "snapshot-annotation",
      evidenceType: "excerpt",
      title: "Snapshot quote",
      contentExcerpt: "A quote from a connection-only snapshot",
      contentHash: "snapshot-annotation-hash",
      trustLevel: "normal",
      extractionMethod: "manual",
      status: "candidate",
      observedAt: new Date().toISOString(),
    });
    const repository = new PgSourcesRepository(db.pool, {} as ServerConfig);
    const filters = {
      status: null, evidenceType: null, sourceItemId: null, projectId: null, connectionId: null, limit: 50, offset: 0,
    };
    const ownerPage = await repository.listEvidence({ spaceId: SPACE, userId: OWNER }, filters);
    expect(ownerPage.items.map((item) => item.id)).toContain(evidenceId);
    const unconsentedPage = await repository.listEvidence({ spaceId: SPACE, userId: OTHER_USER }, filters);
    expect(unconsentedPage.items.map((item) => item.id)).not.toContain(evidenceId);
    await expect(repository.getEvidence({ spaceId: SPACE, userId: OTHER_USER }, evidenceId)).resolves.toBeNull();
    await expect(sourceRetrievalAdapter.revalidate(db.pool, SPACE, "extracted_evidence", evidenceId, OWNER)).resolves.not.toBeNull();
    await expect(sourceRetrievalAdapter.revalidate(db.pool, SPACE, "extracted_evidence", evidenceId, OTHER_USER)).resolves.toBeNull();

    await db.pool.query(
      `INSERT INTO project_members (id,space_id,project_id,user_id,role,status,created_at,updated_at)
       VALUES ($1,$2,$3,$4,'member','active',$5,$5)`,
      [randomUUID(), SPACE, PROJECT, OTHER_USER, new Date().toISOString()],
    );
    const corpus = new ProjectCorpusRepository(db.pool);
    await expect(corpus.upsert(
      { spaceId: SPACE, userId: OTHER_USER }, PROJECT, { evidence_id: evidenceId },
    )).rejects.toMatchObject({ statusCode: 422 });
    await corpus.upsert({ spaceId: SPACE, userId: OWNER }, PROJECT, { evidence_id: evidenceId });
    const artifactId = await new ProjectResearchArtifactService(db.pool).ensureEvidenceMatrix({
      spaceId: SPACE,
      projectId: PROJECT,
      workflowId: "workflow-policy-test",
      operationId: "operation-policy-test",
      ownerUserId: OTHER_USER,
    });
    const artifact = await db.pool.query<{ content: string; visibility: string; owner_user_id: string }>(
      `SELECT content,visibility,owner_user_id FROM artifacts WHERE id=$1`, [artifactId],
    );
    expect(JSON.parse(artifact.rows[0]!.content).rows).toEqual([]);
    expect(artifact.rows[0]).toMatchObject({ visibility: "private", owner_user_id: OTHER_USER });
    const artifacts = new PgArtifactRepository(db.pool, { artifactStorageRoot: "/tmp", sandboxRoot: "/tmp" });
    await expect(artifacts.getVisible(SPACE, OWNER, artifactId, true)).resolves.toBeNull();
    await expect(artifacts.getVisible(SPACE, OTHER_USER, artifactId, true)).resolves.toMatchObject({ id: artifactId });
  });

  it("redacts full Source and Evidence fields for every summary-access path", async () => {
    if (!db.available) return;
    const now = new Date().toISOString();
    await db.pool.query(`UPDATE spaces SET oversight_mode='summary' WHERE id=$1`, [SPACE]);
    await db.pool.query(
      `UPDATE space_memberships SET role='admin' WHERE space_id=$1 AND user_id=$2`,
      [SPACE, OTHER_USER],
    );
    const sharedItem = randomUUID();
    const selectedItem = randomUUID();
    const oversightItem = randomUUID();
    for (const [id, visibility, accessLevel] of [
      [sharedItem, "space_shared", "summary"],
      [selectedItem, "selected_users", "full"],
      [oversightItem, "private", "full"],
    ] as const) {
      await db.pool.query(
        `INSERT INTO source_items (
           id,space_id,owner_user_id,created_by_user_id,visibility,access_level,item_type,title,source_uri,
           canonical_uri,content_hash,excerpt,metadata_json,first_seen_at,last_seen_at,content_state,retention_policy,created_at,updated_at
         ) VALUES ($1,$2,$3,$3,$4,$5,'feed_entry',$6,$7,$7,$8,$9,$10::jsonb,$11,$11,'excerpt_saved','summary_only',$11,$11)`,
        [id, SPACE, OWNER, visibility, accessLevel, `Summary ${id}`, `https://secret.test/${id}`, `hash-${id}`, `secret-${id}`, JSON.stringify({ secret: id }), now],
      );
    }
    const evidenceIds = [randomUUID(), randomUUID(), randomUUID()];
    for (let index = 0; index < evidenceIds.length; index += 1) {
      const visibility = index === 0 ? "space_shared" : index === 1 ? "selected_users" : "private";
      const accessLevel = index === 0 ? "summary" : "full";
      await db.pool.query(
        `INSERT INTO extracted_evidence (
           id,space_id,owner_user_id,visibility,access_level,source_item_id,source_object_type,evidence_type,title,
           content_excerpt,content_hash,source_uri,metadata_json,extraction_method,trust_level,status,created_at,updated_at
         ) VALUES ($1,$2,$3,$4,$5,$6,'source_item','excerpt',$7,$8,$9,$10,$11::jsonb,'manual','normal','candidate',$12,$12)`,
        [evidenceIds[index], SPACE, OWNER, visibility, accessLevel, [sharedItem, selectedItem, oversightItem][index], `Evidence ${index}`, `evidence-secret-${index}`, `evidence-hash-${index}`, `https://secret.test/evidence/${index}`, JSON.stringify({ secret: index }), now],
      );
    }
    await db.pool.query(
      `INSERT INTO content_access_grants (
         id,space_id,resource_type,resource_id,grantee_user_id,granted_by_user_id,access_level,created_at,updated_at
       ) VALUES
         ($1,$2,'source_item',$3,$4,$5,'summary',$6,$6),
         ($7,$2,'extracted_evidence',$8,$4,$5,'full',$6,$6)`,
      [randomUUID(), SPACE, selectedItem, OTHER_USER, OWNER, now, randomUUID(), evidenceIds[1]],
    );

    const repository = new PgSourcesRepository(db.pool, {} as ServerConfig);
    const itemPage = await repository.listItems({ spaceId: SPACE, userId: OTHER_USER }, {
      libraryStatus: null, readStatus: null, contentState: null, connectionId: null, itemType: null,
      libraryType: null, sourceDomain: null, createdAfter: null, occurredAfter: null, q: null, limit: 50, offset: 0,
    });
    for (const id of [sharedItem, selectedItem, oversightItem]) {
      const item = itemPage.items.find((candidate) => candidate.id === id);
      expect(item).toMatchObject({ id, effective_access_level: "summary", excerpt: null, source_uri: null, content_hash: null, metadata_json: null });
      await expect(repository.getItem({ spaceId: SPACE, userId: OTHER_USER }, id)).resolves.toMatchObject({
        id, effective_access_level: "summary", excerpt: null, source_uri: null, content_hash: null, metadata_json: null,
      });
    }
    const evidencePage = await repository.listEvidence({ spaceId: SPACE, userId: OTHER_USER }, {
      status: null, evidenceType: null, sourceItemId: null, projectId: null, connectionId: null, limit: 50, offset: 0,
    });
    for (const id of evidenceIds) {
      const evidence = evidencePage.items.find((candidate) => candidate.id === id);
      expect(evidence).toMatchObject({ id, effective_access_level: "summary", content_excerpt: null, source_uri: null, content_hash: null, metadata_json: null });
      await expect(repository.getEvidence({ spaceId: SPACE, userId: OTHER_USER }, id)).resolves.toMatchObject({
        id, effective_access_level: "summary", content_excerpt: null, source_uri: null, content_hash: null, metadata_json: null,
      });
    }
    const revalidatedItems = await sourceRetrievalAdapter.revalidateMany!(
      db.pool, SPACE, "source_item", [sharedItem, selectedItem, oversightItem], OTHER_USER,
    );
    expect([...revalidatedItems.keys()]).toEqual([]);
    const revalidatedEvidence = await sourceRetrievalAdapter.revalidateMany!(
      db.pool, SPACE, "extracted_evidence", evidenceIds, OTHER_USER,
    );
    expect([...revalidatedEvidence.keys()]).toEqual([]);
    await expect(repository.createSummaryRun({ spaceId: SPACE, userId: OTHER_USER }, {
      source_item_ids: [sharedItem], evidence_ids: [],
    })).rejects.toMatchObject({ statusCode: 404 });
    await expect(repository.createSummaryRun({ spaceId: SPACE, userId: OTHER_USER }, {
      source_item_ids: [], evidence_ids: [evidenceIds[1]],
    })).rejects.toMatchObject({ statusCode: 404 });
    const summary = await repository.createSummaryRun({ spaceId: SPACE, userId: OWNER }, {
      source_item_ids: [sharedItem], evidence_ids: [],
    });
    expect((await db.pool.query<{ visibility: string; owner_user_id: string }>(
      `SELECT visibility,owner_user_id FROM artifacts WHERE id=$1`, [String(summary.artifact_id)],
    )).rows[0]).toEqual({ visibility: "private", owner_user_id: OWNER });
  });

  it("does not let Activity summary guess or republish restricted Source content", async () => {
    if (!db.available) return;
    const { itemId, evidenceId } = await seedItemWithEvidence();
    await db.pool.query(`UPDATE source_items SET visibility='private' WHERE id=$1`, [itemId]);
    await db.pool.query(`UPDATE extracted_evidence SET visibility='private' WHERE id=$1`, [evidenceId]);
    const summaries = new PgActivityRepository(db.pool);
    const input = {
      activityIds: [], evidenceIds: [evidenceId], sourceItemIds: [itemId], summaryGoal: "Restricted summary",
      createMemoryProposal: false, createKnowledgeProposal: false,
    };
    await expect(summaries.createSummaryRun({ spaceId: SPACE, userId: OTHER_USER }, input)).rejects.toMatchObject({ statusCode: 403 });
    await expect(summaries.createSummaryRun({ spaceId: SPACE, userId: OWNER }, {
      ...input, createMemoryProposal: true,
    })).rejects.toMatchObject({ statusCode: 403 });

    const created = await summaries.createSummaryRun({ spaceId: SPACE, userId: OWNER }, input);
    const artifactId = String(created.artifact_id);
    const artifact = await db.pool.query<{ visibility: string; owner_user_id: string }>(
      `SELECT visibility,owner_user_id FROM artifacts WHERE id=$1`, [artifactId],
    );
    expect(artifact.rows[0]).toEqual({ visibility: "private", owner_user_id: OWNER });
    const repository = new PgArtifactRepository(db.pool, { artifactStorageRoot: "/tmp", sandboxRoot: "/tmp" });
    await expect(repository.getVisible(SPACE, OTHER_USER, artifactId, true)).resolves.toBeNull();
  });

  it("links new evidence to the bound project and is idempotent on re-run", async () => {
    if (!db.available) return;
    const bindingId = await seedBinding(PROJECT);
    const { itemId, evidenceId } = await seedItemWithEvidence();

    const created = await linkEvidenceToBoundProjects(db.pool, { spaceId: SPACE, sourceItemId: itemId });
    expect(created).toBe(1);

    const links = await db.pool.query(
      `SELECT target_type, target_id, link_type, status, reason FROM evidence_links WHERE evidence_id = $1`,
      [evidenceId],
    );
    expect(links.rows).toEqual([
      {
        target_type: "project",
        target_id: PROJECT,
        link_type: "context_candidate",
        status: "active",
        reason: `project_source_binding:${bindingId}`,
      },
    ]);

    const again = await linkEvidenceToBoundProjects(db.pool, { spaceId: SPACE, sourceItemId: itemId });
    expect(again).toBe(0);
  });

  it("backfills historical evidence after a source binding is created", async () => {
    if (!db.available) return;
    const { evidenceId } = await seedItemWithEvidence();
    const bindingId = await seedBinding(PROJECT);

    const result = await recomputeProjectSourceBindingLinks(db.pool, { spaceId: SPACE, bindingId });
    expect(result.created_links).toBe(1);
    expect(result.evidence_links).toBe(1);

    const links = await db.pool.query(
      `SELECT target_type, target_id, link_type, status, reason FROM evidence_links WHERE evidence_id = $1`,
      [evidenceId],
    );
    expect(links.rows).toEqual([
      {
        target_type: "project",
        target_id: PROJECT,
        link_type: "context_candidate",
        status: "active",
        reason: `project_source_binding:${bindingId}`,
      },
    ]);

    const again = await recomputeProjectSourceBindingLinks(db.pool, { spaceId: SPACE, bindingId });
    expect(again.created_links).toBe(0);
    expect(again.evidence_links).toBe(0);
  });

  it("two bindings to the same project produce one link; distinct projects each get one", async () => {
    if (!db.available) return;
    await seedBinding(PROJECT, "active", "default");
    await seedBinding(PROJECT, "active", "secondary");
    await seedBinding(PROJECT_B, "active", "default");
    const { itemId, evidenceId } = await seedItemWithEvidence();

    const created = await linkEvidenceToBoundProjects(db.pool, { spaceId: SPACE, sourceItemId: itemId });
    expect(created).toBe(2);

    const targets = await db.pool.query<{ target_id: string }>(
      `SELECT target_id FROM evidence_links WHERE evidence_id = $1 ORDER BY target_id`,
      [evidenceId],
    );
    expect(targets.rows.map((r) => r.target_id)).toEqual([PROJECT, PROJECT_B].sort());
  });

  it("creates nothing for paused bindings", async () => {
    if (!db.available) return;
    await seedBinding(PROJECT, "paused");
    const { itemId, evidenceId } = await seedItemWithEvidence();

    const created = await linkEvidenceToBoundProjects(db.pool, { spaceId: SPACE, sourceItemId: itemId });
    expect(created).toBe(0);
    const links = await db.pool.query(`SELECT id FROM evidence_links WHERE evidence_id = $1`, [evidenceId]);
    expect(links.rows).toHaveLength(0);
  });

  it("links evidence through source snapshot provenance when the item belongs to another source", async () => {
    if (!db.available) return;
    const bindingId = await seedBinding(PROJECT);
    const { itemId, evidenceId } = await seedItemWithEvidence(null);
    await seedSourceSnapshot(itemId, CONNECTION);

    const created = await linkEvidenceToBoundProjects(db.pool, { spaceId: SPACE, sourceItemId: itemId });
    expect(created).toBe(1);

    const links = await db.pool.query(
      `SELECT target_id, reason FROM evidence_links WHERE evidence_id = $1`,
      [evidenceId],
    );
    expect(links.rows).toEqual([{ target_id: PROJECT, reason: `project_source_binding:${bindingId}` }]);
  });

});
