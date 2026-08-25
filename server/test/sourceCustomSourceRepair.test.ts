import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { getTestPostgres, isTestPostgresUnavailableError, type TestPostgresDatabase } from "./support/sharedPostgres";
import { resetTables } from "./support/resetTables";
import { loadConfig, type ServerConfig } from "../src/config";
import { CustomSourceCreateFlowService } from "../src/modules/sources/customSources/customSourceCreateFlowService";
import { CustomSourceRepairService } from "../src/modules/sources/customSources/customSourceRepairService";
import { HttpError } from "../src/modules/routeUtils/common";
import { createDefaultProposalApplierRegistry } from "../src/modules/proposals/applierRegistry";
import { getDbPool } from "../src/db/pool";

// Real-Postgres integration tests for Phase 9 (repair/rollback), matching
// the project-wide preference for real DB tests over fakes.
// Skips gracefully when Docker is unavailable.

const SPACE_A = "space-a";
const IDENTITY = { spaceId: SPACE_A, userId: "user-1" };
const CUSTOM_SOURCE_SPACE_POLICY_SETTINGS_KEY = "source.custom_source.space_policy";

let container: TestPostgresDatabase | undefined;
let pool: Pool | undefined;
let config: ServerConfig | undefined;
let createFlow: CustomSourceCreateFlowService | undefined;
let repairService: CustomSourceRepairService | undefined;
let artifactStorageRoot: string | undefined;
let available = false;

beforeAll(async () => {
  try {
    container = await getTestPostgres(__filename);
    pool = new Pool({ connectionString: container.getConnectionUri() });
    available = true;
  } catch (err) {
    if (!isTestPostgresUnavailableError(err)) throw err;
    console.warn(
      `[source-custom-source-repair] skipped — Docker/Postgres unavailable: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}, 120_000);

afterAll(async () => {
  if (config?.databaseUrl) await getDbPool(config.databaseUrl).end().catch(() => undefined);
  await pool?.end();
  await container?.stop();
});

beforeEach(async () => {
  if (!available || !pool) return;
  await resetTables(
    pool,
    ["jobs", "retrieval_edges", "retrieval_chunks", "retrieval_aliases", "retrieval_objects", "policy_decision_records", "proposal_approvals", "proposals", "runs", "space_memberships", "source_handler_runs", "source_handler_versions", "source_recipe_versions", "source_connections", "source_connectors", "scheduler_tasks", "settings", "artifacts", "extraction_jobs", "source_items", "source_snapshots", "extracted_evidence", "credentials", "source_provider_connectors", "source_providers", "users", "spaces"],
    { cascade: true },
  );
  await pool.query(`INSERT INTO users (id, display_name, status, created_at, updated_at) VALUES ($1, 'User', 'active', now(), now())`, [IDENTITY.userId]);
  await pool.query(`INSERT INTO spaces (id, name, type, created_by_user_id, created_at, updated_at) VALUES ($1, 'Space A', 'team', $2, now(), now())`, [IDENTITY.spaceId, IDENTITY.userId]);
  await pool.query(
    `INSERT INTO source_connectors (
       id, connector_key, display_name, connector_type, ingestion_mode, status,
       capabilities_json, created_at, updated_at
     ) VALUES ('connector-custom-source', 'custom_source', 'Custom Source', 'external_url', 'pull', 'active', '{}'::jsonb, now(), now())`,
  );
  await pool.query(`INSERT INTO source_providers (id, provider_key, display_name, provider_kind, category, status, capabilities_json, created_at, updated_at) VALUES ('provider-custom-source', 'custom_source', 'Custom Source', 'named', 'general', 'active', '{}'::jsonb, now(), now())`);
  await pool.query(`INSERT INTO source_provider_connectors (id, provider_id, connector_id, status, priority, capabilities_json, created_at, updated_at) VALUES ('mapping-custom-source', 'provider-custom-source', 'connector-custom-source', 'active', 0, '{}'::jsonb, now(), now())`);
  artifactStorageRoot = await mkdtemp(join(tmpdir(), "custom-source-repair-artifacts-"));
  config = {
    ...loadConfig({}),
    databaseUrl: container!.getConnectionUri(),
    artifactStorageRoot,
    customSourceAllowedLanguages: ["typescript_node", "declarative_pipeline_v1"],
  };
  createFlow = new CustomSourceCreateFlowService(pool, config);
  repairService = new CustomSourceRepairService(pool, config);
  await pool.query(
    `INSERT INTO space_memberships (id, space_id, user_id, role, status, created_at, updated_at)
     VALUES ($1, $2, $3, 'owner', 'active', now(), now())`,
    [randomUUID(), IDENTITY.spaceId, IDENTITY.userId],
  );
});

afterEach(async () => {
  if (artifactStorageRoot) await rm(artifactStorageRoot, { recursive: true, force: true });
});

const FIXTURE_HTML = `<html><body>
  <div class="article"><a href="/a1">First Title</a><p>First excerpt text.</p></div>
  <div class="article"><a href="/a2">Second Title</a><p>Second excerpt text.</p></div>
</body></html>`;

async function insertCustomSourceSpacePolicy(overrides: Record<string, unknown> = {}) {
  await pool!.query(
    `INSERT INTO settings (
       id, scope_type, scope_id, settings_key, settings_json, created_at, updated_at
     ) VALUES ($1, 'space', $2, $3, $4::jsonb, now(), now())
     ON CONFLICT (scope_type, scope_id, settings_key)
     DO UPDATE SET settings_json = EXCLUDED.settings_json, updated_at = EXCLUDED.updated_at`,
    [
      randomUUID(),
      SPACE_A,
      CUSTOM_SOURCE_SPACE_POLICY_SETTINGS_KEY,
      JSON.stringify({
        creator_roles: ["owner", "admin"],
        default_capture_policy: "extract_text",
        default_retention_policy: "full_text",
        allowed_domains: [],
        credentialed_sources_allowed: false,
        same_envelope_repair_auto_apply: false,
        ...overrides,
      }),
    ],
  );
}

async function createActiveConnection(): Promise<{ connectionId: string; activeVersionId: string }> {
  const connection = await createFlow!.createDraft(IDENTITY, {
    name: "Example Source",
    endpoint_url: "https://example.com/list",
    config: { list_selector: "article" },
  });
  const connectionId = connection.source_connection_id;
  const version = await createFlow!.generateHandler(IDENTITY, connectionId, {});
  await createFlow!.testHandler(IDENTITY, connectionId, {
    handler_version_id: version.id,
    fixture_html: FIXTURE_HTML,
  });
  const activation = await createFlow!.activateHandler(IDENTITY, connectionId, { handler_version_id: version.id });
  expect(activation.status).toBe("active");
  return { connectionId, activeVersionId: version.id };
}

const PIPELINE = {
  pipeline_version: "custom_source.pipeline.v1",
  steps: [
    { type: "fetch_page", url: "$source.endpoint_url", bind: "list_page" },
    { type: "extract_list", input: "list_page", selector: { css_class: "article" }, bind: "items" },
  ],
  output: { items_var: "items" },
};

async function createActivePipelineConnection(): Promise<{ connectionId: string; activeVersionId: string }> {
  const connection = await createFlow!.createDraft(IDENTITY, {
    name: "Example Pipeline Source",
    endpoint_url: "https://example.com/list",
    config: {},
  });
  const connectionId = connection.source_connection_id;
  const version = await createFlow!.generateHandler(IDENTITY, connectionId, {
    generation_mode: "pipeline",
    pipeline: PIPELINE,
  });
  expect(version.language).toBe("declarative_pipeline_v1");
  await createFlow!.testHandler(IDENTITY, connectionId, {
    handler_version_id: version.id,
    fixture_html: FIXTURE_HTML,
  });
  const activation = await createFlow!.activateHandler(IDENTITY, connectionId, { handler_version_id: version.id });
  expect(activation.status).toBe("active");
  return { connectionId, activeVersionId: version.id };
}

describe("CustomSourceRepairService.repairHandler (declarative_pipeline_v1)", () => {
  it("auto-activates an unchanged-envelope repair reusing the active version's stored pipeline", async () => {
    if (!available) return;
    const { connectionId, activeVersionId } = await createActivePipelineConnection();
    await insertCustomSourceSpacePolicy({ same_envelope_repair_auto_apply: true });

    const result = await repairService!.repairHandler(IDENTITY, connectionId, { fixture_html: FIXTURE_HTML });
    expect(result.status).toBe("active");
    if (result.status !== "active") throw new Error("unreachable");
    expect(result.handler_version.language).toBe("declarative_pipeline_v1");
    expect(result.previous_handler_version_id).toBe(activeVersionId);

    const connectionRow = await pool!.query<{ active_handler_version_id: string }>(
      `SELECT active_handler_version_id FROM source_connections WHERE id = $1`,
      [connectionId],
    );
    expect(connectionRow.rows[0]?.active_handler_version_id).toBe(result.handler_version.id);
  });

  it("accepts an explicit pipeline override in the repair request instead of reusing the active version's", async () => {
    if (!available) return;
    const { connectionId } = await createActivePipelineConnection();
    await insertCustomSourceSpacePolicy({ same_envelope_repair_auto_apply: true });
    const updatedPipeline = {
      ...PIPELINE,
      steps: [...PIPELINE.steps, { type: "follow_link", items_var: "items", max_follow: 0 }],
    };

    const result = await repairService!.repairHandler(IDENTITY, connectionId, {
      fixture_html: FIXTURE_HTML,
      pipeline: updatedPipeline,
    });
    expect(result.status).toBe("active");
    if (result.status !== "active") throw new Error("unreachable");
    expect((result.handler_version.manifest_json as { pipeline: { steps: unknown[] } }).pipeline.steps).toHaveLength(3);
  });
});

describe("CustomSourceRepairService.repairHandler", () => {
  it("rejects repair for a connection with no active handler version", async () => {
    if (!available) return;
    const connection = await createFlow!.createDraft(IDENTITY, {
      name: "Draft Only",
      endpoint_url: "https://example.com/list",
      config: { list_selector: "article" },
    });
    await expect(repairService!.repairHandler(IDENTITY, connection.id, { fixture_html: FIXTURE_HTML })).rejects.toThrow(
      HttpError,
    );
  });

  it("rejects a repair call while one is already in progress for the same connection", async () => {
    if (!available) return;
    const { connectionId } = await createActiveConnection();
    await pool!.query(`UPDATE source_connections SET repair_status = 'repair_pending' WHERE id = $1`, [connectionId]);

    await expect(
      repairService!.repairHandler(IDENTITY, connectionId, { fixture_html: FIXTURE_HTML }),
    ).rejects.toThrow(HttpError);
  });


  it("auto-activates an unchanged-envelope repair when Space policy allows it", async () => {
    if (!available) return;
    const { connectionId, activeVersionId } = await createActiveConnection();
    await insertCustomSourceSpacePolicy({ same_envelope_repair_auto_apply: true });

    const result = await repairService!.repairHandler(IDENTITY, connectionId, { fixture_html: FIXTURE_HTML });
    expect(result.status).toBe("active");
    if (result.status !== "active") throw new Error("unreachable");
    expect(result.handler_version.id).not.toBe(activeVersionId);
    expect(result.previous_handler_version_id).toBe(activeVersionId);

    const connectionRow = await pool!.query<{ active_handler_version_id: string; repair_status: string }>(
      `SELECT active_handler_version_id, repair_status FROM source_connections WHERE id = $1`,
      [connectionId],
    );
    expect(connectionRow.rows[0]).toMatchObject({
      active_handler_version_id: result.handler_version.id,
      repair_status: "ok",
    });
    const previousVersionRow = await pool!.query<{ status: string }>(
      `SELECT status FROM source_handler_versions WHERE id = $1`,
      [activeVersionId],
    );
    expect(previousVersionRow.rows[0]?.status).toBe("superseded");
  });

  it("creates a custom_source_repair_activation proposal when the envelope is unchanged but Space policy disallows auto-apply", async () => {
    if (!available) return;
    const { connectionId, activeVersionId } = await createActiveConnection();
    // same_envelope_repair_auto_apply defaults to false.

    const result = await repairService!.repairHandler(IDENTITY, connectionId, { fixture_html: FIXTURE_HTML });
    expect(result.status).toBe("pending_approval");
    if (result.status !== "pending_approval") throw new Error("unreachable");
    expect(result.deltas).toEqual([]);

    const proposalColumns = `id, space_id, proposal_type, title, payload_json, project_folder_id, visibility,
              created_by_user_id, created_by_run_id, project_id`;
    const proposalRow = await pool!.query<{
      id: string;
      space_id: string;
      proposal_type: string;
      title: string | null;
      payload_json: Record<string, unknown>;
      project_folder_id: string | null;
      visibility: string | null;
      created_by_user_id: string | null;
      created_by_run_id: string | null;
      project_id: string | null;
    }>(`SELECT ${proposalColumns} FROM proposals WHERE id = $1`, [result.proposal_id]);
    expect(proposalRow.rows[0]?.proposal_type).toBe("custom_source_repair_activation");
    expect(proposalRow.rows[0]?.payload_json).toMatchObject({
      source_connection_id: connectionId,
      previous_handler_version_id: activeVersionId,
      new_handler_version_id: result.handler_version.id,
      envelope_unchanged: true,
    });

    const connectionRow = await pool!.query<{ active_handler_version_id: string; repair_status: string }>(
      `SELECT active_handler_version_id, repair_status FROM source_connections WHERE id = $1`,
      [connectionId],
    );
    expect(connectionRow.rows[0]).toMatchObject({ active_handler_version_id: activeVersionId, repair_status: "repair_pending" });

    // Accepting through the real proposal applier registry activates the repaired version.
    const applied = await createDefaultProposalApplierRegistry().apply({
      config: config!,
      db: pool!,
      proposal: proposalRow.rows[0]!,
      userId: IDENTITY.userId,
    });
    expect(applied.result).toMatchObject({ status: "active", handler_version_id: result.handler_version.id });
  });

  it("routes a permission-broadening repair through custom_source_policy_delta, not custom_source_repair_activation", async () => {
    if (!available) return;
    const { connectionId, activeVersionId } = await createActiveConnection();
    await insertCustomSourceSpacePolicy({ same_envelope_repair_auto_apply: true });

    // capture_policy broadens extract_text -> archive_original
    // relative to the active version's envelope, independent of any fixture
    // content — this is what should make evaluateCustomSourceActivation
    // report a delta and route through the non-repair proposal types.
    const result = await repairService!.repairHandler(IDENTITY, connectionId, {
      fixture_html: FIXTURE_HTML,
      capture_policy: "archive_original",
    });
    expect(result.status).toBe("pending_approval");
    if (result.status !== "pending_approval") throw new Error("unreachable");
    expect(result.deltas.length).toBeGreaterThan(0);

    const proposalRow = await pool!.query<{ proposal_type: string }>(`SELECT proposal_type FROM proposals WHERE id = $1`, [
      result.proposal_id,
    ]);
    expect(proposalRow.rows[0]?.proposal_type).toBe("custom_source_policy_delta");

    const versionRow = await pool!.query<{ status: string }>(`SELECT status FROM source_handler_versions WHERE id = $1`, [
      activeVersionId,
    ]);
    expect(versionRow.rows[0]?.status).toBe("active");
  });

  it("marks repair_status back to repair_required when the regenerated version fails its fixture test", async () => {
    if (!available) return;
    const { connectionId } = await createActiveConnection();

    const result = await repairService!.repairHandler(IDENTITY, connectionId, {
      fixture_html: `<div class="article"><a href="https://evil.example/x">Bad</a><p>x</p></div>`,
    });
    expect(result.status).toBe("test_failed");

    const connectionRow = await pool!.query<{ repair_status: string }>(
      `SELECT repair_status FROM source_connections WHERE id = $1`,
      [connectionId],
    );
    expect(connectionRow.rows[0]?.repair_status).toBe("repair_required");
  });
});

describe("CustomSourceRepairService.rollbackHandler", () => {
  it("404s when there is no superseded version to roll back to", async () => {
    if (!available) return;
    const { connectionId } = await createActiveConnection();
    await expect(repairService!.rollbackHandler(IDENTITY, connectionId, {})).rejects.toThrow(HttpError);
  });

  it("rolls back to the most recently superseded version", async () => {
    if (!available) return;
    const { connectionId, activeVersionId } = await createActiveConnection();
    await insertCustomSourceSpacePolicy({ same_envelope_repair_auto_apply: true });
    const repaired = await repairService!.repairHandler(IDENTITY, connectionId, { fixture_html: FIXTURE_HTML });
    expect(repaired.status).toBe("active");
    if (repaired.status !== "active") throw new Error("unreachable");

    const rollback = await repairService!.rollbackHandler(IDENTITY, connectionId, {});
    expect(rollback.status).toBe("active");
    expect(rollback.handler_version.id).toBe(activeVersionId);
    expect(rollback.previous_handler_version_id).toBe(repaired.handler_version.id);

    const connectionRow = await pool!.query<{ active_handler_version_id: string }>(
      `SELECT active_handler_version_id FROM source_connections WHERE id = $1`,
      [connectionId],
    );
    expect(connectionRow.rows[0]?.active_handler_version_id).toBe(activeVersionId);

    const repairedVersionRow = await pool!.query<{ status: string }>(
      `SELECT status FROM source_handler_versions WHERE id = $1`,
      [repaired.handler_version.id],
    );
    expect(repairedVersionRow.rows[0]?.status).toBe("superseded");
  });

  it("rejects rolling back to a draft/never-active version", async () => {
    if (!available) return;
    const { connectionId } = await createActiveConnection();
    const draftVersion = await createFlow!.generateHandler(IDENTITY, connectionId, {});
    await expect(
      repairService!.rollbackHandler(IDENTITY, connectionId, { target_version_id: draftVersion.id }),
    ).rejects.toThrow(HttpError);
  });

  it("cross-space connection access 404s", async () => {
    if (!available) return;
    const { connectionId } = await createActiveConnection();
    await expect(
      repairService!.repairHandler({ spaceId: "space-b", userId: "user-2" }, connectionId, {}),
    ).rejects.toThrow(HttpError);
    await expect(
      repairService!.rollbackHandler({ spaceId: "space-b", userId: "user-2" }, connectionId, {}),
    ).rejects.toThrow(HttpError);
  });
});
