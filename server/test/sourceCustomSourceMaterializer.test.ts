import { randomUUID } from "node:crypto";
import { customSourcePolicyEnvelope, runnerSettings } from "./support/customSourceFixtures.js";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { useTestDatabase } from "./support/testDatabase.js";
import { resetTables } from "./support/resetTables.js";
import type { CustomSourceHandlerOutput, CustomSourcePolicyEnvelope } from "@agent-space/protocol";
import { loadConfig, type ServerConfig } from "../src/config.js";
import {
  applyCustomSourceRetentionPolicy,
  CustomSourceMaterializationService,
} from "../src/modules/sources/customSources/customSourceMaterializer.js";

// Real-PostgreSQL integration tests for CustomSourceMaterializationService.
// Exercises the actual INSERT statements against the real migrated schema
// (CHECK constraints in particular) so constraint mismatches — e.g. an
// artifacts.trust_level value that is valid for source_snapshots but not
// artifacts — surface here instead of in prod.
//
// It used to load a hand-maintained SQL copy of the schema, which defeated the
// entire point: the copy drifted from the real shape and the suite could no
// longer fail when code and production disagreed.
//
// Skips gracefully when Docker is unavailable so `pnpm test` runs everywhere.

const SPACE_A = "space-a";

let config: ServerConfig | undefined;
let service: CustomSourceMaterializationService | undefined;
let artifactStorageRoot: string | undefined;
let sandboxFilesRoot: string | undefined;

const POLICY_ENVELOPE = customSourcePolicyEnvelope({ allowed_network_origins: ["https://example.com"], limits: { timeout_ms: 30000, max_items: 5, max_evidence_items: 10 } });

const instanceSettings = runnerSettings;

const db = useTestDatabase(import.meta.filename, { max: 10 });

beforeAll(async () => {
  if (!db.available) return;
  artifactStorageRoot = await mkdtemp(join(tmpdir(), "custom-source-materializer-artifacts-"));
  config = { ...loadConfig({}), artifactStorageRoot };
  service = new CustomSourceMaterializationService(db.pool, config, instanceSettings());
}, 120_000);

afterAll(async () => {
  if (artifactStorageRoot) await rm(artifactStorageRoot, { recursive: true, force: true });
});

beforeEach(async () => {
  sandboxFilesRoot = await mkdtemp(join(tmpdir(), "custom-source-materializer-sandbox-"));
  await writeFile(join(sandboxFilesRoot, "article-1.html"), "<html>hi</html>", "utf8");
  if (!db.available) return;
  await resetTables(
    db.pool,
    ["jobs", "retrieval_edges", "retrieval_chunks", "retrieval_aliases", "retrieval_objects", "extracted_evidence", "source_snapshots", "source_items", "artifacts", "source_handler_runs", "source_handler_versions", "source_connections", "source_provider_connectors", "source_providers", "source_connectors", "space_memberships", "users", "spaces"],
    { cascade: true },
  );
  // The real schema enforces the space/user chain and the connector/provider
  // mapping behind every source_connections row.
  await db.pool.query(
    `INSERT INTO users (id, display_name, status, created_at, updated_at)
     VALUES ('user-1', 'User', 'active', now(), now())`,
  );
  await db.pool.query(
    `INSERT INTO spaces (id, name, type, created_by_user_id, created_at, updated_at)
     VALUES ($1, 'Space A', 'team', 'user-1', now(), now())`,
    [SPACE_A],
  );
  await db.pool.query(
    `INSERT INTO source_connectors (
       id, connector_key, display_name, connector_type, ingestion_mode, status,
       capabilities_json, created_at, updated_at
     ) VALUES ('connector-custom-source', 'custom_source', 'Custom Source', 'external_url', 'pull', 'active', '{}'::jsonb, now(), now())`,
  );
  await db.pool.query(
    `INSERT INTO source_providers (
       id, provider_key, display_name, provider_kind, category, status,
       capabilities_json, created_at, updated_at
     ) VALUES ('provider-custom-source', 'custom_source', 'Custom Source', 'named', 'general', 'active', '{}'::jsonb, now(), now())`,
  );
  await db.pool.query(
    `INSERT INTO source_provider_connectors (
       id, provider_id, connector_id, status, priority, capabilities_json, created_at, updated_at
     ) VALUES ('mapping-custom-source', 'provider-custom-source', 'connector-custom-source', 'active', 0, '{}'::jsonb, now(), now())`,
  );
});

afterEach(async () => {
  if (sandboxFilesRoot) await rm(sandboxFilesRoot, { recursive: true, force: true });
});

async function insertConnection(connId: string): Promise<void> {
  await db.pool.query(
    `INSERT INTO source_connections (
       id, space_id, provider_connector_id, owner_user_id, name, status,
       capture_policy, trust_level, consent_json, policy_json, config_json,
       created_at, updated_at
     ) VALUES ($1, $2, 'mapping-custom-source', 'user-1', 'Custom source', 'active',
       'extract_text', 'normal', '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, now(), now())`,
    [connId, SPACE_A],
  );
}

async function seedRun(): Promise<{ connId: string; runId: string; versionId: string }> {
  const connId = randomUUID();
  const runId = randomUUID();
  const versionId = randomUUID();
  await insertConnection(connId);
  await db.pool.query(
    `INSERT INTO source_handler_versions (
       id, space_id, source_connection_id, version_number, language, entrypoint,
       manifest_json, policy_envelope_json, checksum, status, created_at
     ) VALUES ($1, $2, $3, 1, 'typescript_node', 'handler.ts',
       '{}'::jsonb, '{}'::jsonb, 'checksum', 'active', now())`,
    [versionId, SPACE_A, connId],
  );
  await db.pool.query(
    `INSERT INTO source_handler_runs (id, space_id, source_connection_id, handler_version_id, status, created_at)
     VALUES ($1, $2, $3, $4, 'running', now())`,
    [runId, SPACE_A, connId, versionId],
  );
  return { connId, runId, versionId };
}

/** A second handler run against an existing connection's handler version. */
async function seedAnotherRun(connId: string, versionId: string): Promise<string> {
  const runId = randomUUID();
  await db.pool.query(
    `INSERT INTO source_handler_runs (id, space_id, source_connection_id, handler_version_id, status, created_at)
     VALUES ($1, $2, $3, $4, 'running', now())`,
    [runId, SPACE_A, connId, versionId],
  );
  return runId;
}

async function seedConnection(): Promise<{ connId: string }> {
  const connId = randomUUID();
  await insertConnection(connId);
  return { connId };
}

function validOutput(): CustomSourceHandlerOutput {
  return {
    contract_version: "custom_source.handler_output.v1",
    items: [
      {
        external_id: "article-1",
        title: "Article title",
        source_uri: "https://example.com/research/article-1",
        excerpt: "Short excerpt",
        snapshots: [{ snapshot_type: "raw_html", file_path: "article-1.html", mime_type: "text/html" }],
        evidence: [{ evidence_type: "excerpt", title: "Quote", content_excerpt: "A passage.", confidence: 0.8 }],
      },
    ],
    diagnostics: { warnings: [] },
  };
}

describe("applyCustomSourceRetentionPolicy", () => {
  it("removes handler-provided content fields for metadata_only retention", () => {
    const output = validOutput();
    output.items[0]!.metadata = { tags: ["research"], body_like: "full article text" };

    const retained = applyCustomSourceRetentionPolicy(output, "metadata_only");

    expect(retained.items[0]!.excerpt).toBeNull();
    expect(retained.items[0]!.metadata).toBeNull();
    expect(retained.items[0]!.snapshots).toEqual([]);
    expect(retained.items[0]!.evidence).toEqual([]);
    expect(retained.items[0]!.title).toBe("Article title");
    expect(retained.items[0]!.source_uri).toBe("https://example.com/research/article-1");
  });

  it("allows text-derived fields but not snapshot files for full_text retention", () => {
    const retained = applyCustomSourceRetentionPolicy(validOutput(), "full_text");

    expect(retained.items[0]!.excerpt).toBe("Short excerpt");
    expect(retained.items[0]!.evidence).toHaveLength(1);
    expect(retained.items[0]!.snapshots).toEqual([]);
  });

  it("preserves snapshot files only for full_snapshot-style retention", () => {
    const retained = applyCustomSourceRetentionPolicy(validOutput(), "full_snapshot");

    expect(retained.items[0]!.excerpt).toBe("Short excerpt");
    expect(retained.items[0]!.evidence).toHaveLength(1);
    expect(retained.items[0]!.snapshots).toHaveLength(1);
  });
});

describe("CustomSourceMaterializationService (real Postgres)", () => {
  it("a validation failure writes no Source rows and marks the run validation_failed", async () => {
    if (!db.available || !service) return;
    const { connId, runId } = await seedRun();
    const result = await service.materialize({
      run: { runId, spaceId: SPACE_A, sourceConnectionId: connId, handlerVersionId: randomUUID() },
      policyEnvelope: POLICY_ENVELOPE,
      sandboxFilesRoot: sandboxFilesRoot!,
      rawOutputJson: { contract_version: "wrong" },
    });
    expect(result.status).toBe("validation_failed");
    expect(result.itemsCreated).toBe(0);

    const items = await db.pool.query(`SELECT count(*)::int AS n FROM source_items`);
    expect(items.rows[0]!.n).toBe(0);
    const run = await db.pool.query<{ status: string }>(`SELECT status FROM source_handler_runs WHERE id = $1`, [runId]);
    expect(run.rows[0]!.status).toBe("validation_failed");
  });

  it("a valid output writes source_items, source_snapshots, extracted_evidence, and artifacts, and marks the run succeeded", async () => {
    if (!db.available || !service) return;
    const { connId, runId } = await seedRun();
    // full_snapshot retention: full_text would (correctly) strip the snapshot
    // before materialization — see the applyCustomSourceRetentionPolicy tests.
    const result = await service.materialize({
      run: { runId, spaceId: SPACE_A, sourceConnectionId: connId, handlerVersionId: randomUUID() },
      policyEnvelope: { ...POLICY_ENVELOPE, retention_policy: "full_snapshot" },
      sandboxFilesRoot: sandboxFilesRoot!,
      rawOutputJson: validOutput(),
    });
    expect(result.status).toBe("succeeded");
    expect(result.itemsCreated).toBe(1);
    expect(result.snapshotsCreated).toBe(1);
    expect(result.evidenceCreated).toBe(1);

    const item = await db.pool.query<{ source_external_id: string; content_state: string; retention_policy: string }>(
      `SELECT source_external_id, content_state, retention_policy FROM source_items WHERE space_id = $1`,
      [SPACE_A],
    );
    expect(item.rows).toHaveLength(1);
    expect(item.rows[0]!.source_external_id).toBe("article-1");
    expect(item.rows[0]!.content_state).toBe("content_saved");
    expect(item.rows[0]!.retention_policy).toBe("full_snapshot");

    const snapshots = await db.pool.query(`SELECT * FROM source_snapshots WHERE space_id = $1`, [SPACE_A]);
    expect(snapshots.rows).toHaveLength(1);
    const evidence = await db.pool.query(`SELECT * FROM extracted_evidence WHERE space_id = $1`, [SPACE_A]);
    expect(evidence.rows).toHaveLength(1);

    // Two artifacts: the copied snapshot file and the stored raw output.json.
    const artifacts = await db.pool.query<{ storage_path: string }>(`SELECT storage_path FROM artifacts WHERE space_id = $1`, [SPACE_A]);
    expect(artifacts.rows).toHaveLength(2);
    for (const row of artifacts.rows) {
      const onDisk = await readFile(join(config!.artifactStorageRoot, row.storage_path), "utf8");
      expect(onDisk.length).toBeGreaterThan(0);
    }

    const run = await db.pool.query<{ status: string; output_artifact_id: string | null }>(
      `SELECT status, output_artifact_id FROM source_handler_runs WHERE id = $1`,
      [runId],
    );
    expect(run.rows[0]!.status).toBe("succeeded");
    expect(run.rows[0]!.output_artifact_id).not.toBeNull();

    const conn = await db.pool.query<{ last_handler_run_id: string }>(
      `SELECT last_handler_run_id FROM source_connections WHERE id = $1`,
      [connId],
    );
    expect(conn.rows[0]!.last_handler_run_id).toBe(runId);
  });

  it("stores excerpt-only output as excerpt_saved so full-text extraction remains available", async () => {
    if (!db.available || !service) return;
    const { connId, runId } = await seedRun();
    const output = validOutput();
    output.items[0]!.snapshots = [];
    output.items[0]!.evidence = [];

    const result = await service.materialize({
      run: { runId, spaceId: SPACE_A, sourceConnectionId: connId, handlerVersionId: randomUUID() },
      policyEnvelope: POLICY_ENVELOPE,
      sandboxFilesRoot: sandboxFilesRoot!,
      rawOutputJson: output,
    });
    expect(result.status).toBe("succeeded");

    const item = await db.pool.query<{ content_state: string; excerpt: string | null }>(
      `SELECT content_state, excerpt FROM source_items WHERE space_id = $1`,
      [SPACE_A],
    );
    expect(item.rows[0]).toMatchObject({
      content_state: "excerpt_saved",
      excerpt: "Short excerpt",
    });
  });

  it("repairs previously misclassified excerpt-only items on re-materialization", async () => {
    if (!db.available || !service) return;
    const { connId, runId } = await seedRun();
    await db.pool.query(
      // owner_user_id is required for a private item (ck_source_items_private_owner).
      `INSERT INTO source_items (
         id, space_id, owner_user_id, connection_id, item_type, title, source_uri, canonical_uri,
         source_domain, source_external_id, first_seen_at, last_seen_at,
         content_hash, excerpt, content_state,
         retention_policy, metadata_json, created_at, updated_at
       ) VALUES (
         $1, $2, 'user-1', $3, 'external_url', 'Old title', 'https://example.com/research/article-1',
         'https://example.com/research/article-1', 'example.com', 'article-1', now(), now(),
         'old-hash', 'Old excerpt', 'content_saved',
         'full_text', '{}'::jsonb, now(), now()
       )`,
      [randomUUID(), SPACE_A, connId],
    );
    const output = validOutput();
    output.items[0]!.snapshots = [];
    output.items[0]!.evidence = [];

    const result = await service.materialize({
      run: { runId, spaceId: SPACE_A, sourceConnectionId: connId, handlerVersionId: randomUUID() },
      policyEnvelope: POLICY_ENVELOPE,
      sandboxFilesRoot: sandboxFilesRoot!,
      rawOutputJson: output,
    });
    expect(result.errors).toEqual([]);

    const item = await db.pool.query<{ content_state: string }>(
      `SELECT content_state FROM source_items WHERE connection_id = $1 AND source_external_id = 'article-1'`,
      [connId],
    );
    expect(item.rows[0]!.content_state).toBe("excerpt_saved");
  });

  it("labels Level 2 Source Recipe materialization separately from handler runs", async () => {
    if (!db.available || !service) return;
    const { connId } = await seedConnection();
    const extractionJobId = randomUUID();
    const recipeVersionId = randomUUID();
    const result = await service.materialize({
      run: {
        runId: extractionJobId,
        spaceId: SPACE_A,
        sourceConnectionId: connId,
        handlerVersionId: recipeVersionId,
      },
      policyEnvelope: { ...POLICY_ENVELOPE, retention_policy: "full_snapshot" },
      sandboxFilesRoot: sandboxFilesRoot!,
      rawOutputJson: validOutput(),
      recordHandlerRun: false,
      sourceKind: "source_recipe",
    });

    expect(result.status).toBe("succeeded");
    expect(result.snapshotsCreated).toBe(1);
    expect(result.evidenceCreated).toBe(1);

    const item = await db.pool.query<{ metadata_json: Record<string, unknown> }>(
      `SELECT metadata_json FROM source_items WHERE connection_id = $1`,
      [connId],
    );
    expect(item.rows[0]!.metadata_json).toMatchObject({
      capture_method: "source_recipe",
      recipe_version_id: recipeVersionId,
      extraction_job_id: extractionJobId,
    });

    const snapshot = await db.pool.query<{ capture_method: string; metadata_json: Record<string, unknown> }>(
      `SELECT capture_method, metadata_json FROM source_snapshots WHERE connection_id = $1`,
      [connId],
    );
    expect(snapshot.rows[0]).toMatchObject({
      capture_method: "source_recipe",
      metadata_json: {
        recipe_version_id: recipeVersionId,
        extraction_job_id: extractionJobId,
      },
    });

    const evidence = await db.pool.query<{ extraction_method: string; metadata_json: Record<string, unknown> }>(
      `SELECT extraction_method, metadata_json FROM extracted_evidence WHERE space_id = $1`,
      [SPACE_A],
    );
    expect(evidence.rows[0]).toMatchObject({
      extraction_method: "source_recipe",
      metadata_json: {
        recipe_version_id: recipeVersionId,
        extraction_job_id: extractionJobId,
      },
    });

    const artifacts = await db.pool.query<{ artifact_type: string; title: string; storage_path: string }>(
      `SELECT artifact_type, title, storage_path FROM artifacts WHERE space_id = $1 ORDER BY artifact_type`,
      [SPACE_A],
    );
    expect(artifacts.rows.map((row) => row.artifact_type).sort()).toEqual([
      "source_recipe_output",
      "source_recipe_snapshot",
    ]);
    expect(artifacts.rows.every((row) => row.storage_path.startsWith(`${SPACE_A}/source-recipe/`))).toBe(true);
  });

  it("validates handler output against instance hard limits, not only the policy envelope", async () => {
    if (!db.available || !config) return;
    await writeFile(join(sandboxFilesRoot!, "article-2.html"), "<html>two</html>", "utf8");
    const output = validOutput();
    output.items[0]!.snapshots.push({
      snapshot_type: "raw_html",
      file_path: "article-2.html",
      mime_type: "text/html",
    });
    const strictService = new CustomSourceMaterializationService(db.pool, config, instanceSettings({ max_files: 1 }));
    const { connId, runId } = await seedRun();
    const result = await strictService.materialize({
      run: { runId, spaceId: SPACE_A, sourceConnectionId: connId, handlerVersionId: randomUUID() },
      policyEnvelope: POLICY_ENVELOPE,
      sandboxFilesRoot: sandboxFilesRoot!,
      rawOutputJson: output,
    });

    expect(result.status).toBe("validation_failed");
    expect(result.errors.some((error) => error.includes("max_files 1"))).toBe(true);
    const items = await db.pool.query(`SELECT count(*)::int AS n FROM source_items`);
    expect(items.rows[0]!.n).toBe(0);
  });

  it("re-materializing the same external_id updates the existing item instead of duplicating it", async () => {
    if (!db.available || !service) return;
    const { connId, runId, versionId } = await seedRun();
    await service.materialize({
      run: { runId, spaceId: SPACE_A, sourceConnectionId: connId, handlerVersionId: randomUUID() },
      policyEnvelope: POLICY_ENVELOPE,
      sandboxFilesRoot: sandboxFilesRoot!,
      rawOutputJson: validOutput(),
    });

    const runId2 = await seedAnotherRun(connId, versionId);
    const result = await service.materialize({
      run: { runId: runId2, spaceId: SPACE_A, sourceConnectionId: connId, handlerVersionId: randomUUID() },
      policyEnvelope: POLICY_ENVELOPE,
      sandboxFilesRoot: sandboxFilesRoot!,
      rawOutputJson: validOutput(),
    });
    expect(result.errors).toEqual([]);
    expect(result.itemsCreated).toBe(0);
    expect(result.itemsUpdated).toBe(1);

    const items = await db.pool.query(`SELECT count(*)::int AS n FROM source_items WHERE space_id = $1`, [SPACE_A]);
    expect(items.rows[0]!.n).toBe(1);
  });

  it("writes the policy envelope's retention_policy instead of a hardcoded value, on both insert and update", async () => {
    if (!db.available || !service) return;
    const { connId, runId, versionId } = await seedRun();
    await service.materialize({
      run: { runId, spaceId: SPACE_A, sourceConnectionId: connId, handlerVersionId: randomUUID() },
      policyEnvelope: { ...POLICY_ENVELOPE, retention_policy: "metadata_only" },
      sandboxFilesRoot: sandboxFilesRoot!,
      rawOutputJson: validOutput(),
    });
    const afterInsert = await db.pool.query<{
      retention_policy: string;
      content_state: string;
      excerpt: string | null;
      metadata_json: Record<string, unknown>;
    }>(
      `SELECT retention_policy, content_state, excerpt, metadata_json FROM source_items WHERE space_id = $1`,
      [SPACE_A],
    );
    expect(afterInsert.rows[0]!.retention_policy).toBe("metadata_only");
    expect(afterInsert.rows[0]!.content_state).toBe("metadata_only");
    expect(afterInsert.rows[0]!.excerpt).toBeNull();
    expect(afterInsert.rows[0]!.metadata_json).not.toHaveProperty("tags");
    const snapshotsAfterInsert = await db.pool.query(`SELECT count(*)::int AS n FROM source_snapshots`);
    expect(snapshotsAfterInsert.rows[0]!.n).toBe(0);
    const evidenceAfterInsert = await db.pool.query(`SELECT count(*)::int AS n FROM extracted_evidence`);
    expect(evidenceAfterInsert.rows[0]!.n).toBe(0);

    const runId2 = await seedAnotherRun(connId, versionId);
    const updateResult = await service.materialize({
      run: { runId: runId2, spaceId: SPACE_A, sourceConnectionId: connId, handlerVersionId: randomUUID() },
      policyEnvelope: { ...POLICY_ENVELOPE, retention_policy: "full_snapshot" },
      sandboxFilesRoot: sandboxFilesRoot!,
      rawOutputJson: validOutput(),
    });
    expect(updateResult.errors).toEqual([]);
    const afterUpdate = await db.pool.query<{ retention_policy: string }>(
      `SELECT retention_policy FROM source_items WHERE space_id = $1`,
      [SPACE_A],
    );
    expect(afterUpdate.rows[0]!.retention_policy).toBe("full_snapshot");
  });

  it("falls back to the narrowest retention_policy for an unrecognized policy envelope value, never to full_text", async () => {
    if (!db.available || !service) return;
    const { connId, runId } = await seedRun();
    await service.materialize({
      run: { runId, spaceId: SPACE_A, sourceConnectionId: connId, handlerVersionId: randomUUID() },
      policyEnvelope: { ...POLICY_ENVELOPE, retention_policy: "not_a_real_policy" } as unknown as CustomSourcePolicyEnvelope,
      sandboxFilesRoot: sandboxFilesRoot!,
      rawOutputJson: validOutput(),
    });
    const item = await db.pool.query<{ retention_policy: string }>(
      `SELECT retention_policy FROM source_items WHERE space_id = $1`,
      [SPACE_A],
    );
    expect(item.rows[0]!.retention_policy).toBe("metadata_only");
  });
});
