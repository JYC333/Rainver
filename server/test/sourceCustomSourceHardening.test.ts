import { randomUUID } from "node:crypto";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { seedCustomSourceWorld } from "./support/customSourceWorld";
import { useTestDatabase } from "./support/testDatabase";
import { resetTables } from "./support/resetTables";
import { loadConfig, type ServerConfig } from "../src/config";
import { CustomSourceCreateFlowService } from "../src/modules/sources/customSources/customSourceCreateFlowService";
import { CustomSourceRepairService } from "../src/modules/sources/customSources/customSourceRepairService";
import { PgCustomSourceHandlerRepository } from "../src/modules/sources/customSources/customSourceHandlerRepository";
import { pruneSupersededCustomSourceHandlerArtifacts } from "../src/modules/sources/customSources/customSourceArtifactRetention";
import { HttpError } from "../src/modules/routeUtils/common";

// Real-Postgres integration tests for Phase 12 (rate limiting, artifact
// retention, and observability). Skips gracefully when Docker is unavailable.

const SPACE_A = "space-a";
const IDENTITY = { spaceId: SPACE_A, userId: "user-1" };

let config: ServerConfig | undefined;
let createFlow: CustomSourceCreateFlowService | undefined;
let artifactStorageRoot: string | undefined;

const db = useTestDatabase(__filename, { max: 10 });

beforeEach(async () => {
  if (!db.available) return;
  await resetTables(
    db.pool,
    ["jobs", "retrieval_edges", "retrieval_chunks", "retrieval_aliases", "retrieval_objects", "policy_decision_records", "proposal_approvals", "proposals", "runs", "space_memberships", "source_handler_runs", "source_handler_versions", "source_recipe_versions", "source_connections", "source_connectors", "scheduler_tasks", "settings", "artifacts", "extraction_jobs", "source_items", "source_snapshots", "extracted_evidence", "credentials", "source_provider_connectors", "source_providers", "users", "spaces"],
    { cascade: true },
  );
  await seedCustomSourceWorld(db.pool, IDENTITY);
  artifactStorageRoot = await mkdtemp(join(tmpdir(), "custom-source-hardening-artifacts-"));
  config = {
    ...loadConfig({}),
    databaseUrl: db.connectionUri,
    artifactStorageRoot,
    customSourceAllowedLanguages: ["typescript_node"],
    customSourceGenerateRateLimitPerHour: 2,
    customSourceArtifactRetentionEnabled: true,
    customSourceArtifactRetentionDays: 30,
  };
  createFlow = new CustomSourceCreateFlowService(db.pool, config);
});

afterEach(async () => {
  if (artifactStorageRoot) await rm(artifactStorageRoot, { recursive: true, force: true });
});

const FIXTURE_HTML = `<html><body>
  <div class="article"><a href="/a1">First Title</a><p>First excerpt text.</p></div>
</body></html>`;

async function createDraftConnection(suffix = "", actor = IDENTITY) {
  const channel = await createFlow!.createDraft(actor, {
    name: `Example Source${suffix}`,
    endpoint_url: `https://example.com/list${suffix}`,
    config: { list_selector: "article" },
  });
  return { ...channel, id: channel.source_connection_id };
}

describe("generateHandler rate limit", () => {
  it("rejects generation past the configured per-connection-per-hour limit", async () => {
    if (!db.available) return;
    const connection = await createDraftConnection();
    await createFlow!.generateHandler(IDENTITY, connection.id, {});
    await createFlow!.generateHandler(IDENTITY, connection.id, {});
    await expect(createFlow!.generateHandler(IDENTITY, connection.id, {})).rejects.toThrow(HttpError);
  });

  it("serializes concurrent generation attempts before enforcing the per-connection limit", async () => {
    if (!db.available) return;
    const connection = await createDraftConnection();
    const results = await Promise.allSettled([
      createFlow!.generateHandler(IDENTITY, connection.id, {}),
      createFlow!.generateHandler(IDENTITY, connection.id, {}),
      createFlow!.generateHandler(IDENTITY, connection.id, {}),
    ]);

    const fulfilled = results.filter((result) => result.status === "fulfilled");
    const rejected = results.filter((result) => result.status === "rejected");
    expect(fulfilled).toHaveLength(2);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(HttpError);

    const versionCount = await db.pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM source_handler_versions
        WHERE space_id = $1 AND source_connection_id = $2`,
      [IDENTITY.spaceId, connection.id],
    );
    expect(Number(versionCount.rows[0]?.count ?? 0)).toBe(2);

    const artifactCount = await db.pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM artifacts WHERE space_id = $1`,
      [IDENTITY.spaceId],
    );
    expect(Number(artifactCount.rows[0]?.count ?? 0)).toBe(2);
  });

  it("does not share the rate limit budget across different connections", async () => {
    if (!db.available) return;
    const connectionA = await createDraftConnection();
    const identityB = { spaceId: SPACE_A, userId: "user-2" };
    await db.pool.query(
      `INSERT INTO users (id, display_name, status, created_at, updated_at)
       VALUES ($1, 'Second User', 'active', now(), now())`,
      [identityB.userId],
    );
    await db.pool.query(
      `INSERT INTO space_memberships (id, space_id, user_id, role, status, created_at, updated_at)
       VALUES ($1, $2, $3, 'owner', 'active', now(), now())`,
      [randomUUID(), SPACE_A, identityB.userId],
    );
    const connectionB = await createDraftConnection("-b", identityB);
    await createFlow!.generateHandler(IDENTITY, connectionA.id, {});
    await createFlow!.generateHandler(IDENTITY, connectionA.id, {});
    await expect(createFlow!.generateHandler(identityB, connectionB.id, {})).resolves.toBeDefined();
  });

  it("applies to repair too, since repair regenerates through generateHandler internally", async () => {
    if (!db.available) return;
    const connection = await createDraftConnection();
    const version = await createFlow!.generateHandler(IDENTITY, connection.id, {});
    await createFlow!.testHandler(IDENTITY, connection.id, { handler_version_id: version.id, fixture_html: FIXTURE_HTML });
    await createFlow!.activateHandler(IDENTITY, connection.id, { handler_version_id: version.id });
    // That activation's generateHandler call already used 1 of the 2 slots.
    const repairService = new CustomSourceRepairService(db.pool, config!);
    await repairService.repairHandler(IDENTITY, connection.id, { fixture_html: FIXTURE_HTML });
    await expect(repairService.repairHandler(IDENTITY, connection.id, { fixture_html: FIXTURE_HTML })).rejects.toThrow(
      HttpError,
    );
  });
});

describe("PgCustomSourceHandlerRepository.getHandlerSummary observability fields", () => {
  it("surfaces repair_status, recent_run_status_counts, and no pending proposal for a healthy active connection", async () => {
    if (!db.available) return;
    const connection = await createDraftConnection();
    const version = await createFlow!.generateHandler(IDENTITY, connection.id, {});
    await createFlow!.testHandler(IDENTITY, connection.id, { handler_version_id: version.id, fixture_html: FIXTURE_HTML });
    await createFlow!.activateHandler(IDENTITY, connection.id, { handler_version_id: version.id });

    const summary = await new PgCustomSourceHandlerRepository(db.pool, config!).getHandlerSummary(IDENTITY, connection.id);
    expect(summary.repair_status).toBe("ok");
    expect(summary.recent_run_status_counts).toMatchObject({ succeeded: 1 });
    expect(summary.pending_proposals).toEqual([]);
  });

  it("surfaces the pending proposal blocking activation", async () => {
    if (!db.available) return;
    const connection = await createDraftConnection();
    const version = await createFlow!.generateHandler(IDENTITY, connection.id, {});
    await createFlow!.testHandler(IDENTITY, connection.id, { handler_version_id: version.id, fixture_html: FIXTURE_HTML });
    // Restrict allowed_domains only now — createDraft already ran under the
    // permissive default, so activation (not draft creation) is what hits
    // the delta.
    await db.pool.query(
      `INSERT INTO settings (id, scope_type, scope_id, settings_key, settings_json, created_at, updated_at)
       VALUES ($1, 'space', $2, 'source.custom_source.space_policy', $3::jsonb, now(), now())`,
      [
        randomUUID(),
        SPACE_A,
        JSON.stringify({
          creator_roles: ["owner", "admin"],
          default_capture_policy: "extract_text",
          default_retention_policy: "full_text",
          allowed_domains: ["other.example"],
          credentialed_sources_allowed: false,
          same_envelope_repair_auto_apply: false,
        }),
      ],
    );
    const activation = await createFlow!.activateHandler(IDENTITY, connection.id, { handler_version_id: version.id });
    expect(activation.status).toBe("pending_approval");

    const summary = await new PgCustomSourceHandlerRepository(db.pool, config!).getHandlerSummary(IDENTITY, connection.id);
    expect(summary.pending_proposals).toHaveLength(1);
    expect(summary.pending_proposals[0]).toMatchObject({
      proposal_id: activation.proposal_id,
      proposal_type: "custom_source_policy_delta",
    });
  });

  it("surfaces every pending proposal, not only the most recent, when a connection has more than one", async () => {
    if (!db.available) return;
    const permissiveConfig = { ...config!, customSourceGenerateRateLimitPerHour: 10 };
    const flow = new CustomSourceCreateFlowService(db.pool, permissiveConfig);
    const connection = await flow.createDraft(IDENTITY, {
      name: "Example Source",
      endpoint_url: "https://example.com/list",
      config: { list_selector: "article" },
    });
    const v1 = await flow.generateHandler(IDENTITY, connection.id, {});
    await flow.testHandler(IDENTITY, connection.id, { handler_version_id: v1.id, fixture_html: FIXTURE_HTML });
    await flow.activateHandler(IDENTITY, connection.id, { handler_version_id: v1.id });

    // Two independent draft versions, each broadening capture_policy versus
    // the still-active v1 (so each requires its own proposal), generated
    // and tested without the earlier one's proposal ever being resolved —
    // nothing prevents this today.
    const v2 = await flow.generateHandler(IDENTITY, connection.id, { capture_policy: "archive_original" });
    await flow.testHandler(IDENTITY, connection.id, { handler_version_id: v2.id, fixture_html: FIXTURE_HTML });
    const activation2 = await flow.activateHandler(IDENTITY, connection.id, { handler_version_id: v2.id });
    expect(activation2.status).toBe("pending_approval");

    const v3 = await flow.generateHandler(IDENTITY, connection.id, { capture_policy: "archive_original" });
    await flow.testHandler(IDENTITY, connection.id, { handler_version_id: v3.id, fixture_html: FIXTURE_HTML });
    const activation3 = await flow.activateHandler(IDENTITY, connection.id, { handler_version_id: v3.id });
    expect(activation3.status).toBe("pending_approval");

    const summary = await new PgCustomSourceHandlerRepository(db.pool, config!).getHandlerSummary(IDENTITY, connection.id);
    expect(summary.pending_proposals).toHaveLength(2);
    const proposalIds = summary.pending_proposals.map((p) => p.proposal_id);
    expect(proposalIds).toContain(activation2.proposal_id);
    expect(proposalIds).toContain(activation3.proposal_id);
  });
});

describe("pruneSupersededCustomSourceHandlerArtifacts", () => {
  it("prunes an old superseded version's artifact but never the connection's most-recently-superseded version", async () => {
    if (!db.available) return;
    // This test regenerates 3 times for one connection, deliberately above
    // the rate limit under test elsewhere in this file — orthogonal concern.
    const permissiveConfig = { ...config!, customSourceGenerateRateLimitPerHour: 10 };
    const flow = new CustomSourceCreateFlowService(db.pool, permissiveConfig);
    const connection = await flow.createDraft(IDENTITY, {
      name: "Example Source",
      endpoint_url: "https://example.com/list",
      config: { list_selector: "article" },
    });

    const v1 = await flow.generateHandler(IDENTITY, connection.id, {});
    await flow.testHandler(IDENTITY, connection.id, { handler_version_id: v1.id, fixture_html: FIXTURE_HTML });
    await flow.activateHandler(IDENTITY, connection.id, { handler_version_id: v1.id });

    const v2 = await flow.generateHandler(IDENTITY, connection.id, {});
    await flow.testHandler(IDENTITY, connection.id, { handler_version_id: v2.id, fixture_html: FIXTURE_HTML });
    await flow.activateHandler(IDENTITY, connection.id, { handler_version_id: v2.id });

    const v3 = await flow.generateHandler(IDENTITY, connection.id, {});
    await flow.testHandler(IDENTITY, connection.id, { handler_version_id: v3.id, fixture_html: FIXTURE_HTML });
    await flow.activateHandler(IDENTITY, connection.id, { handler_version_id: v3.id });

    // v1 and v2 are now both 'superseded'. Backdate both past the retention
    // window — only v1 should be pruned; v2 is this connection's most
    // recently superseded version (rollback's default target) and must
    // survive regardless of age.
    // Distinct timestamps, both past the retention cutoff — v2 is still the
    // more recently superseded of the two even though both are old.
    const v1SupersededAt = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000).toISOString();
    const v2SupersededAt = new Date(Date.now() - 35 * 24 * 60 * 60 * 1000).toISOString();
    await db.pool.query(`UPDATE source_handler_versions SET superseded_at = $2 WHERE id = $1`, [v1.id, v1SupersededAt]);
    await db.pool.query(`UPDATE source_handler_versions SET superseded_at = $2 WHERE id = $1`, [v2.id, v2SupersededAt]);

    const v1Before = await db.pool.query<{ handler_artifact_id: string | null }>(
      `SELECT handler_artifact_id FROM source_handler_versions WHERE id = $1`,
      [v1.id],
    );
    const v1ArtifactPath = await db.pool.query<{ storage_path: string }>(`SELECT storage_path FROM artifacts WHERE id = $1`, [
      v1Before.rows[0]!.handler_artifact_id,
    ]);
    const v1AbsolutePath = join(config!.artifactStorageRoot, v1ArtifactPath.rows[0]!.storage_path);
    await expect(stat(v1AbsolutePath)).resolves.toBeDefined();

    const pruned = await pruneSupersededCustomSourceHandlerArtifacts(db.pool, config!);
    expect(pruned).toBe(1);

    const v1After = await db.pool.query<{ handler_artifact_id: string | null }>(
      `SELECT handler_artifact_id FROM source_handler_versions WHERE id = $1`,
      [v1.id],
    );
    expect(v1After.rows[0]?.handler_artifact_id).toBeNull();
    const v1ArtifactRow = await db.pool.query(`SELECT id FROM artifacts WHERE id = $1`, [
      v1Before.rows[0]!.handler_artifact_id,
    ]);
    expect(v1ArtifactRow.rows).toHaveLength(0);
    await expect(stat(v1AbsolutePath)).rejects.toThrow();

    const v2After = await db.pool.query<{ handler_artifact_id: string | null }>(
      `SELECT handler_artifact_id FROM source_handler_versions WHERE id = $1`,
      [v2.id],
    );
    expect(v2After.rows[0]?.handler_artifact_id).not.toBeNull();
  });

  it("is a no-op when disabled", async () => {
    if (!db.available) return;
    const disabledConfig = { ...config!, customSourceArtifactRetentionEnabled: false };
    expect(await pruneSupersededCustomSourceHandlerArtifacts(db.pool, disabledConfig)).toBe(0);
  });

  it("agrees with rollback's default target on which version is 'most recent' when two share the same superseded_at", async () => {
    if (!db.available) return;
    // Retention's exclusion query and rollback's default-target query must
    // never disagree about which superseded version is "most recent" —
    // otherwise retention could prune the exact version a no-argument
    // rollback would target. Both use version_number DESC as a tiebreaker
    // for this reason; this test forces the tie the tiebreaker exists for.
    const permissiveConfig = { ...config!, customSourceGenerateRateLimitPerHour: 10 };
    const flow = new CustomSourceCreateFlowService(db.pool, permissiveConfig);
    const repairService = new CustomSourceRepairService(db.pool, permissiveConfig);
    const connection = await flow.createDraft(IDENTITY, {
      name: "Example Source",
      endpoint_url: "https://example.com/list",
      config: { list_selector: "article" },
    });

    const v1 = await flow.generateHandler(IDENTITY, connection.id, {});
    await flow.testHandler(IDENTITY, connection.id, { handler_version_id: v1.id, fixture_html: FIXTURE_HTML });
    await flow.activateHandler(IDENTITY, connection.id, { handler_version_id: v1.id });

    const v2 = await flow.generateHandler(IDENTITY, connection.id, {});
    await flow.testHandler(IDENTITY, connection.id, { handler_version_id: v2.id, fixture_html: FIXTURE_HTML });
    await flow.activateHandler(IDENTITY, connection.id, { handler_version_id: v2.id });

    const v3 = await flow.generateHandler(IDENTITY, connection.id, {});
    await flow.testHandler(IDENTITY, connection.id, { handler_version_id: v3.id, fixture_html: FIXTURE_HTML });
    await flow.activateHandler(IDENTITY, connection.id, { handler_version_id: v3.id });

    // Force the tie: v1 and v2 (both superseded, v2 has the higher
    // version_number) now share one identical, far-past-retention timestamp.
    const tiedTimestamp = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000).toISOString();
    await db.pool.query(`UPDATE source_handler_versions SET superseded_at = $2 WHERE id = $1`, [v1.id, tiedTimestamp]);
    await db.pool.query(`UPDATE source_handler_versions SET superseded_at = $2 WHERE id = $1`, [v2.id, tiedTimestamp]);

    const pruned = await pruneSupersededCustomSourceHandlerArtifacts(db.pool, permissiveConfig);
    expect(pruned).toBe(1);
    const v1AfterPrune = await db.pool.query<{ handler_artifact_id: string | null }>(
      `SELECT handler_artifact_id FROM source_handler_versions WHERE id = $1`,
      [v1.id],
    );
    expect(v1AfterPrune.rows[0]?.handler_artifact_id).toBeNull();
    const v2AfterPrune = await db.pool.query<{ handler_artifact_id: string | null }>(
      `SELECT handler_artifact_id FROM source_handler_versions WHERE id = $1`,
      [v2.id],
    );
    expect(v2AfterPrune.rows[0]?.handler_artifact_id).not.toBeNull();

    const rollback = await repairService.rollbackHandler(IDENTITY, connection.id, {});
    expect(rollback.handler_version.id).toBe(v2.id);
  });
});
