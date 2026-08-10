import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { getTestPostgres, isTestPostgresUnavailableError, type TestPostgresDatabase } from "./support/sharedPostgres";
import type { CustomSourcePolicyEnvelope } from "@agent-space/protocol" with {
  "resolution-mode": "import",
};
import { loadConfig, type ServerConfig } from "../src/config";
import {
  CustomSourceCreateFlowService,
  evaluateCustomSourceActivation,
} from "../src/modules/sources/customSources/customSourceCreateFlowService";
import { SourceRecipeCreateService } from "../src/modules/sources/sourceRecipes/recipeCreateService";
import { SourceRecipeDryRunService } from "../src/modules/sources/sourceRecipes/recipeDryRunService";
import { SourceRecipePipelineBridgeService } from "../src/modules/sources/sourceRecipes/pipelineBridgeService";
import { listSourceRuns } from "../src/modules/sources/sourceRunReadModel";
import { HttpError } from "../src/modules/routeUtils/common";
import { createDefaultProposalApplierRegistry } from "../src/modules/proposals/applierRegistry";
import { PgProposalApplyService } from "../src/modules/proposals/applyService";
import { getDbPool } from "../src/db/pool";

// Real-Postgres + real-child-process integration tests for the Custom Source
// create flow (draft -> generate -> test -> activate/approval), matching the
// project-wide preference for real DB/process tests over fakes
// (TESTING_STRATEGY.md).
// Skips gracefully when Docker is unavailable.

const SPACE_A = "space-a";
const IDENTITY = { spaceId: SPACE_A, userId: "user-1" };
const CUSTOM_SOURCE_SPACE_POLICY_SETTINGS_KEY = "source.custom_source.space_policy";
const CUSTOM_SOURCE_INSTANCE_RUNNER_SETTINGS_KEY = "source.custom_source.runner";

let container: TestPostgresDatabase | undefined;
let pool: Pool | undefined;
let config: ServerConfig | undefined;
let service: CustomSourceCreateFlowService | undefined;
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
      `[source-custom-source-create-flow] skipped — Docker/Postgres unavailable: ${
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
  await pool.query(
    `TRUNCATE evolution_bundle_members, evolution_bundles,
              jobs, retrieval_edges, retrieval_chunks, retrieval_aliases, retrieval_objects,
              policy_decision_records, proposal_approvals, proposals, runs, space_memberships,
              source_handler_runs, source_handler_versions, source_recipe_versions, source_channel_item_links,
              source_channel_user_subscriptions, source_channels, source_connections, source_connectors,
              scheduler_tasks, settings, artifacts, extraction_jobs, source_items,
              source_snapshots, extracted_evidence, credentials,
              source_provider_connectors, source_providers, users, spaces CASCADE`,
  );
  await pool.query(
    `INSERT INTO users (id, display_name, status, created_at, updated_at)
     VALUES ($1, 'User', 'active', now(), now())`,
    [IDENTITY.userId],
  );
  await pool.query(
    `INSERT INTO spaces (id, name, type, created_by_user_id, created_at, updated_at)
     VALUES ($1, 'Space A', 'team', $2, now(), now())`,
    [IDENTITY.spaceId, IDENTITY.userId],
  );
  await pool.query(
    `INSERT INTO source_connectors (
       id, connector_key, display_name, connector_type, ingestion_mode, status,
       capabilities_json, created_at, updated_at
     ) VALUES ('connector-custom-source', 'custom_source', 'Custom Source', 'external_url', 'pull', 'active', '{}'::jsonb, now(), now())`,
  );
  await pool.query(
    `INSERT INTO source_providers (
       id, provider_key, display_name, provider_kind, category, status,
       capabilities_json, created_at, updated_at
     ) VALUES ('provider-custom-source', 'custom_source', 'Custom Source', 'named', 'general', 'active', '{}'::jsonb, now(), now())`,
  );
  await pool.query(
    `INSERT INTO source_provider_connectors (
       id, provider_id, connector_id, status, priority, capabilities_json, created_at, updated_at
     ) VALUES ('mapping-custom-source', 'provider-custom-source', 'connector-custom-source', 'active', 0, '{}'::jsonb, now(), now())`,
  );
  artifactStorageRoot = await mkdtemp(join(tmpdir(), "custom-source-create-flow-artifacts-"));
  config = {
    ...loadConfig({}),
    databaseUrl: container!.getConnectionUri(),
    artifactStorageRoot,
    customSourceAllowedLanguages: ["typescript_node"],
  };
  service = new CustomSourceCreateFlowService(pool, config);
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

async function createDraftConnection(overrides: Record<string, unknown> = {}) {
  const channel = await service!.createDraft(IDENTITY, {
    name: "Example Source",
    endpoint_url: "https://example.com/list",
    config: { list_selector: "article" },
    ...overrides,
  });
  // The create-flow methods are keyed by the underlying source connection;
  // SourceChannelService returns the channel id as `id` for its public shape.
  return { ...channel, id: channel.source_connection_id };
}

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

async function setInstanceRunnerEnabled(enabled: boolean) {
  await pool!.query(
    `INSERT INTO settings (
       id, scope_type, scope_id, settings_key, settings_json, updated_by_user_id, created_at, updated_at
     ) VALUES ($1, 'instance', 'instance', $2, $3::jsonb, $4, now(), now())
     ON CONFLICT (scope_type, scope_id, settings_key)
     DO UPDATE SET settings_json = EXCLUDED.settings_json, updated_at = EXCLUDED.updated_at`,
    [
      randomUUID(),
      CUSTOM_SOURCE_INSTANCE_RUNNER_SETTINGS_KEY,
      JSON.stringify({ runner_enabled: enabled }),
      IDENTITY.userId,
    ],
  );
}

describe("CustomSourceCreateFlowService (real Postgres + real sandboxed runner)", () => {
  it("createDraft rejects a raw credential_ref — a credential must be created first and referenced by credential_id", async () => {
    if (!available) return;
    await expect(createDraftConnection({ credential_ref: "cred-1" })).rejects.toThrow(HttpError);
  });

  it("createDraft rejects a credential_id that does not exist in this space", async () => {
    if (!available) return;
    await expect(createDraftConnection({ credential_id: "does-not-exist" })).rejects.toThrow(HttpError);
  });

  it("createDraft creates a paused, generated_custom connection", async () => {
    if (!available) return;
    const connection = await createDraftConnection();
    expect(connection.handler_kind).toBe("generated_custom");
    expect(connection.status).toBe("paused");
    expect(connection.source_connection_id).toBeTruthy();
  });

  it("createDraft enforces Space Custom Source creator roles", async () => {
    if (!available) return;
    await pool!.query(
      `INSERT INTO users (id, display_name, status, created_at, updated_at)
       VALUES ('member-1', 'Member', 'active', now(), now())`,
    );
    await pool!.query(
      `INSERT INTO space_memberships (id, space_id, user_id, role, status, created_at, updated_at)
       VALUES ($1, $2, 'member-1', 'member', 'active', now(), now())`,
      [randomUUID(), SPACE_A],
    );
    await expect(
      service!.createDraft({ spaceId: SPACE_A, userId: "member-1" }, {
        name: "Blocked Source",
        endpoint_url: "https://example.com/list",
        config: { list_selector: "article" },
      }),
    ).rejects.toThrow(HttpError);

    await insertCustomSourceSpacePolicy({ creator_roles: ["owner", "admin", "member"] });

    const allowed = await service!.createDraft({ spaceId: SPACE_A, userId: "member-1" }, {
      name: "Allowed Source",
      endpoint_url: "https://example.com/list",
      config: { list_selector: "article" },
    });
    expect(allowed.handler_kind).toBe("generated_custom");
    expect(allowed.source_connection_id).toBeTruthy();
  });

  it("full happy path: draft -> generate -> test (fixture) -> activate", async () => {
    if (!available) return;
    const connection = await createDraftConnection();

    const version = await service!.generateHandler(IDENTITY, connection.id, {});
    expect(version.status).toBe("draft");
    expect(version.version_number).toBe(1);

    const testOutcome = await service!.testHandler(IDENTITY, connection.id, {
      handler_version_id: version.id,
      fixture_html: FIXTURE_HTML,
    });
    expect(testOutcome.run.status).toBe("succeeded");
    expect(testOutcome.version.status).toBe("draft");
    expect((testOutcome.test_result as { item_count: number }).item_count).toBe(2);

    const activation = await service!.activateHandler(IDENTITY, connection.id, {
      handler_version_id: version.id,
    });
    expect(activation.status).toBe("active");
    expect(activation.handler_version.status).toBe("active");

    const connectionRow = await pool!.query<{ active_handler_version_id: string; status: string }>(
      `SELECT active_handler_version_id, status FROM source_connections WHERE id = $1`,
      [connection.id],
    );
    expect(connectionRow.rows[0]?.active_handler_version_id).toBe(version.id);
    expect(connectionRow.rows[0]?.status).toBe("active");

    const sourceRuns = await listSourceRuns(pool!, IDENTITY, connection.source_channel_id, { limit: 10, offset: 0 });
    expect(sourceRuns.items).toEqual([
      expect.objectContaining({
        id: `handler_run:${testOutcome.run.id}`,
        run_kind: "test",
        implementation: "generated_handler",
        status: "succeeded",
        handler_run_id: testOutcome.run.id,
        extraction_job_id: null,
      }),
    ]);
  });

  it("testHandler fails closed when the instance runner setting is disabled", async () => {
    if (!available) return;
    const connection = await createDraftConnection();
    const version = await service!.generateHandler(IDENTITY, connection.id, {});
    await setInstanceRunnerEnabled(false);

    const outcome = await service!.testHandler(IDENTITY, connection.id, {
      handler_version_id: version.id,
      fixture_html: FIXTURE_HTML,
    });

    expect(outcome.run.status).toBe("blocked");
    expect(outcome.run.failure_class).toBe("runner_disabled");
    expect(outcome.version.status).toBe("test_failed");
    expect(outcome.test_result).toMatchObject({ status: "blocked", reason: "runner_disabled" });
  });

  it("testHandler refuses to retest active handler versions", async () => {
    if (!available) return;
    const connection = await createDraftConnection();
    const version = await service!.generateHandler(IDENTITY, connection.id, {});
    await service!.testHandler(IDENTITY, connection.id, {
      handler_version_id: version.id,
      fixture_html: FIXTURE_HTML,
    });
    await service!.activateHandler(IDENTITY, connection.id, {
      handler_version_id: version.id,
    });

    await expect(
      service!.testHandler(IDENTITY, connection.id, {
        handler_version_id: version.id,
        fixture_html: FIXTURE_HTML,
      }),
    ).rejects.toThrow(HttpError);
    const versionRow = await pool!.query<{ status: string }>(
      `SELECT status FROM source_handler_versions WHERE id = $1`,
      [version.id],
    );
    expect(versionRow.rows[0]?.status).toBe("active");
  });

  it("recordTestOutcome refuses to overwrite a version that stopped being testable mid-run", async () => {
    if (!available) return;
    const connection = await createDraftConnection();
    const version = await service!.generateHandler(IDENTITY, connection.id, {});
    const runId = randomUUID();
    await pool!.query(
      `INSERT INTO source_handler_runs (
         id, space_id, source_connection_id, handler_version_id, status, created_at, started_at
       ) VALUES ($1, $2, $3, $4, 'running', now(), now())`,
      [runId, SPACE_A, connection.id, version.id],
    );
    await pool!.query(`UPDATE source_handler_versions SET status = 'pending_approval' WHERE id = $1`, [version.id]);

    await expect(
      (service! as unknown as {
        recordTestOutcome(
          identity: typeof IDENTITY,
          connectionId: string,
          versionId: string,
          runId: string,
          input: { status: string; failure_class: string | null; test_result: Record<string, unknown> },
        ): Promise<unknown>;
      }).recordTestOutcome(IDENTITY, connection.id, version.id, runId, {
        status: "succeeded",
        failure_class: null,
        test_result: { status: "succeeded" },
      }),
    ).rejects.toThrow(HttpError);

    const versionRow = await pool!.query<{ status: string; test_result_json: Record<string, unknown> | null }>(
      `SELECT status, test_result_json FROM source_handler_versions WHERE id = $1`,
      [version.id],
    );
    expect(versionRow.rows[0]).toMatchObject({ status: "pending_approval", test_result_json: null });
  });

  it("activation is blocked without a preceding successful test", async () => {
    if (!available) return;
    const connection = await createDraftConnection();
    const version = await service!.generateHandler(IDENTITY, connection.id, {});
    await expect(
      service!.activateHandler(IDENTITY, connection.id, { handler_version_id: version.id }),
    ).rejects.toThrow(HttpError);
  });

  it("policy-delta activation creates a pending proposal and the proposal applier activates it", async () => {
    if (!available) return;
    const connection = await createDraftConnection();
    const version = await service!.generateHandler(IDENTITY, connection.id, {});
    await service!.testHandler(IDENTITY, connection.id, {
      handler_version_id: version.id,
      fixture_html: FIXTURE_HTML,
    });
    await insertCustomSourceSpacePolicy({ allowed_domains: ["other.example"] });

    const activation = await service!.activateHandler(IDENTITY, connection.id, {
      handler_version_id: version.id,
    });
    expect(activation.status).toBe("pending_approval");
    expect(activation.proposal_id).toEqual(expect.any(String));
    expect(activation.handler_version.status).toBe("pending_approval");
    expect(activation.deltas[0]).toContain("not allowed by Space Custom Source policy");

    const versionRow = await pool!.query<{ status: string; proposal_id: string | null }>(
      `SELECT status, proposal_id FROM source_handler_versions WHERE id = $1`,
      [version.id],
    );
    expect(versionRow.rows[0]).toMatchObject({ status: "pending_approval", proposal_id: activation.proposal_id });
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
    }>(
      `SELECT id, space_id, proposal_type, title, payload_json, project_folder_id, visibility,
              created_by_user_id, created_by_run_id, project_id
         FROM proposals WHERE id = $1`,
      [activation.proposal_id],
    );
    expect(proposalRow.rows[0]?.proposal_type).toBe("custom_source_policy_delta");
    expect(proposalRow.rows[0]?.payload_json).toMatchObject({
      source_connection_id: connection.id,
      handler_version_id: version.id,
      current_handler_version_id: null,
    });
    expect(String(proposalRow.rows[0]?.payload_json.proposed_content)).toContain(
      "network origin not allowed by Space Custom Source policy",
    );
    const connectionRow = await pool!.query<{ active_handler_version_id: string | null; status: string }>(
      `SELECT active_handler_version_id, status FROM source_connections WHERE id = $1`,
      [connection.id],
    );
    expect(connectionRow.rows[0]).toMatchObject({ active_handler_version_id: null, status: "paused" });
    await expect(
      service!.testHandler(IDENTITY, connection.id, {
        handler_version_id: version.id,
        fixture_html: FIXTURE_HTML,
      }),
    ).rejects.toThrow(HttpError);

    const result = await createDefaultProposalApplierRegistry().apply({
      config: config!,
      db: pool!,
      proposal: proposalRow.rows[0]!,
      userId: IDENTITY.userId,
    });
    expect(result.result_type).toBe("custom_source_handler_version");
    expect(result.result).toMatchObject({
      source_connection_id: connection.id,
      handler_version_id: version.id,
      status: "active",
    });
    const activeConnection = await pool!.query<{ active_handler_version_id: string | null; status: string }>(
      `SELECT active_handler_version_id, status FROM source_connections WHERE id = $1`,
      [connection.id],
    );
    expect(activeConnection.rows[0]).toMatchObject({ active_handler_version_id: version.id, status: "active" });
    const activeVersion = await pool!.query<{ status: string }>(
      `SELECT status FROM source_handler_versions WHERE id = $1`,
      [version.id],
    );
    expect(activeVersion.rows[0]?.status).toBe("active");
  });

  it("custom source proposal applier rejects non-pending and tampered handler versions", async () => {
    if (!available) return;
    const connection = await createDraftConnection();
    const version = await service!.generateHandler(IDENTITY, connection.id, {});
    await service!.testHandler(IDENTITY, connection.id, {
      handler_version_id: version.id,
      fixture_html: FIXTURE_HTML,
    });
    await insertCustomSourceSpacePolicy({ allowed_domains: ["other.example"] });
    const activation = await service!.activateHandler(IDENTITY, connection.id, {
      handler_version_id: version.id,
    });
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
    }>(
      `SELECT id, space_id, proposal_type, title, payload_json, project_folder_id, visibility,
              created_by_user_id, created_by_run_id, project_id
         FROM proposals WHERE id = $1`,
      [activation.proposal_id],
    );

    const registry = createDefaultProposalApplierRegistry();
    await pool!.query(`UPDATE source_handler_versions SET status = 'draft' WHERE id = $1`, [version.id]);
    await expect(
      registry.apply({
        config: config!,
        db: pool!,
        proposal: proposalRow.rows[0]!,
        userId: IDENTITY.userId,
      }),
    ).rejects.toThrow("pending approval");

    await pool!.query(
      `UPDATE source_handler_versions
          SET status = 'pending_approval',
              policy_envelope_json = jsonb_set(policy_envelope_json, '{retention_policy}', '"full_snapshot"'::jsonb)
        WHERE id = $1`,
      [version.id],
    );
    await expect(
      registry.apply({
        config: config!,
        db: pool!,
        proposal: proposalRow.rows[0]!,
        userId: IDENTITY.userId,
      }),
    ).rejects.toThrow("policy envelope changed");
  });

  it("proposal apply service accepts a Custom Source proposal and persists the accepted result", async () => {
    if (!available) return;
    const connection = await createDraftConnection();
    const version = await service!.generateHandler(IDENTITY, connection.id, {});
    await service!.testHandler(IDENTITY, connection.id, {
      handler_version_id: version.id,
      fixture_html: FIXTURE_HTML,
    });
    await insertCustomSourceSpacePolicy({ allowed_domains: ["other.example"] });
    const activation = await service!.activateHandler(IDENTITY, connection.id, {
      handler_version_id: version.id,
    });

    const accepted = await PgProposalApplyService.fromConfig(config!).accept(
      activation.proposal_id!,
      IDENTITY,
    );
    expect(accepted?.result_type).toBe("custom_source_handler_version");
    expect(accepted?.result).toMatchObject({
      source_connection_id: connection.id,
      handler_version_id: version.id,
      status: "active",
    });
    expect(accepted?.proposal.status).toBe("accepted");

    const proposal = await pool!.query<{ status: string; reviewed_by: string | null; payload_json: Record<string, unknown> }>(
      `SELECT status, reviewed_by, payload_json FROM proposals WHERE id = $1`,
      [activation.proposal_id],
    );
    expect(proposal.rows[0]).toMatchObject({ status: "accepted", reviewed_by: IDENTITY.userId });
    expect(proposal.rows[0]?.payload_json).toMatchObject({
      activated_handler_version_id: version.id,
      accepted_by_user_id: IDENTITY.userId,
    });

    const audit = await pool!.query<{ decision: string; required_approver_role: string | null }>(
      `SELECT decision, required_approver_role
         FROM policy_decision_records
        WHERE proposal_id = $1 AND action = 'proposal.apply'
        ORDER BY created_at DESC
        LIMIT 1`,
      [activation.proposal_id],
    );
    expect(audit.rows[0]).toMatchObject({ decision: "allow", required_approver_role: "owner" });
  });

  it("rejecting a Custom Source proposal releases the handler version back to draft", async () => {
    if (!available) return;
    const connection = await createDraftConnection();
    const version = await service!.generateHandler(IDENTITY, connection.id, {});
    await service!.testHandler(IDENTITY, connection.id, {
      handler_version_id: version.id,
      fixture_html: FIXTURE_HTML,
    });
    await insertCustomSourceSpacePolicy({ allowed_domains: ["other.example"] });
    const activation = await service!.activateHandler(IDENTITY, connection.id, {
      handler_version_id: version.id,
    });

    const rejected = await PgProposalApplyService.fromConfig(config!).reject(
      activation.proposal_id!,
      IDENTITY,
    );
    expect(rejected?.status).toBe("rejected");

    const versionRow = await pool!.query<{ status: string; proposal_id: string | null }>(
      `SELECT status, proposal_id FROM source_handler_versions WHERE id = $1`,
      [version.id],
    );
    expect(versionRow.rows[0]).toMatchObject({ status: "draft", proposal_id: null });
  });

  it("space owner can reject an owner-required Custom Source proposal created by an allowed member", async () => {
    if (!available) return;
    const memberIdentity = { spaceId: SPACE_A, userId: "member-1" };
    await pool!.query(
      `INSERT INTO users (id, display_name, status, created_at, updated_at)
       VALUES ($1, 'Member', 'active', now(), now())`,
      [memberIdentity.userId],
    );
    await pool!.query(
      `INSERT INTO space_memberships (id, space_id, user_id, role, status, created_at, updated_at)
       VALUES ($1, $2, $3, 'member', 'active', now(), now())`,
      [randomUUID(), SPACE_A, memberIdentity.userId],
    );
    await insertCustomSourceSpacePolicy({ creator_roles: ["owner", "admin", "member"] });
    const connection = await service!.createDraft(memberIdentity, {
      name: "Member Source",
      endpoint_url: "https://example.com/list",
      config: { list_selector: "article" },
    });
    const connectionId = connection.source_connection_id;
    const version = await service!.generateHandler(memberIdentity, connectionId, {});
    await service!.testHandler(memberIdentity, connectionId, {
      handler_version_id: version.id,
      fixture_html: FIXTURE_HTML,
    });
    await insertCustomSourceSpacePolicy({
      creator_roles: ["owner", "admin", "member"],
      allowed_domains: ["other.example"],
    });

    const activation = await service!.activateHandler(memberIdentity, connectionId, {
      handler_version_id: version.id,
    });
    expect(activation.status).toBe("pending_approval");

    const rejected = await PgProposalApplyService.fromConfig(config!).reject(
      activation.proposal_id!,
      IDENTITY,
    );
    expect(rejected?.status).toBe("rejected");
    const versionRow = await pool!.query<{ status: string; proposal_id: string | null }>(
      `SELECT status, proposal_id FROM source_handler_versions WHERE id = $1`,
      [version.id],
    );
    expect(versionRow.rows[0]).toMatchObject({ status: "draft", proposal_id: null });
  });

  it("a failing fixture test marks the version test_failed and still blocks activation", async () => {
    if (!available) return;
    const connection = await createDraftConnection();
    const version = await service!.generateHandler(IDENTITY, connection.id, {});
    // Single-page generation was requested via list_selector above; force a
    // list-mode handler to see zero items (no matching blocks) — this still
    // produces a *succeeded* run with 0 items, so instead exercise a genuine
    // validation failure: fixture HTML containing an out-of-origin link.
    const outcome = await service!.testHandler(IDENTITY, connection.id, {
      handler_version_id: version.id,
      fixture_html: `<div class="article"><a href="https://evil.example/x">Bad</a><p>x</p></div>`,
    });
    expect(outcome.run.status).toBe("validation_failed");
    expect(outcome.version.status).toBe("test_failed");

    await expect(
      service!.activateHandler(IDENTITY, connection.id, { handler_version_id: version.id }),
    ).rejects.toThrow(HttpError);
  });

  it("cross-space connection access 404s", async () => {
    if (!available) return;
    const connection = await createDraftConnection();
    await expect(
      service!.generateHandler({ spaceId: "space-b", userId: "user-2" }, connection.id, {}),
    ).rejects.toThrow(HttpError);
  });

  describe("generation_mode: 'pipeline' compatibility bridge", () => {
    const PIPELINE = {
      pipeline_version: "custom_source.pipeline.v1",
      steps: [
        { type: "fetch_page", url: "$source.endpoint_url", bind: "list_page" },
        { type: "extract_list", input: "list_page", selector: { css_class: "article" }, bind: "items" },
      ],
      output: { items_var: "items" },
    };

    it("rejects generation_mode 'pipeline' without a valid pipeline definition", async () => {
      if (!available) return;
      const connection = await createDraftConnection();
      await expect(
        service!.generateHandler(IDENTITY, connection.id, { generation_mode: "pipeline" }),
      ).rejects.toThrow(HttpError);
      await expect(
        service!.generateHandler(IDENTITY, connection.id, {
          generation_mode: "pipeline",
          pipeline: { pipeline_version: "custom_source.pipeline.v1", steps: [], output: { items_var: "items" } },
        }),
      ).rejects.toThrow(HttpError);
    });

    it("full happy path with a declarative pipeline handler: draft -> generate -> test (fixture) -> activate", async () => {
      if (!available) return;
      // The shared `config`/`service!` fixture restricts allowed_languages to
      // ["typescript_node"] (see beforeEach) to keep the existing
      // code-template tests' fail-closed behavior obvious; this test needs a
      // service that also allows declarative_pipeline_v1.
      const permissiveConfig = { ...config!, customSourceAllowedLanguages: ["typescript_node", "declarative_pipeline_v1"] };
      const permissiveService = new CustomSourceCreateFlowService(pool!, permissiveConfig);

      const connection = await createDraftConnection();
      const version = await permissiveService.generateHandler(IDENTITY, connection.id, {
        generation_mode: "pipeline",
        pipeline: PIPELINE,
      });
      expect(version.language).toBe("declarative_pipeline_v1");
      expect(version.handler_artifact_id).toBeNull();

      const testOutcome = await permissiveService.testHandler(IDENTITY, connection.id, {
        handler_version_id: version.id,
        fixture_html: FIXTURE_HTML,
      });
      expect(testOutcome.run.status).toBe("succeeded");
      expect((testOutcome.test_result as { item_count: number }).item_count).toBe(2);

      const activation = await permissiveService.activateHandler(IDENTITY, connection.id, {
        handler_version_id: version.id,
      });
      expect(activation.status).toBe("active");

      const connectionRow = await pool!.query<{ active_handler_version_id: string; status: string }>(
        `SELECT active_handler_version_id, status FROM source_connections WHERE id = $1`,
        [connection.id],
      );
      expect(connectionRow.rows[0]?.active_handler_version_id).toBe(version.id);
      expect(connectionRow.rows[0]?.status).toBe("active");
    });

    it("bridges a declarative pipeline handler into a paused recipe source and draft recipe version", async () => {
      if (!available) return;
      const connection = await createDraftConnection();
      const version = await service!.generateHandler(IDENTITY, connection.id, {
        generation_mode: "pipeline",
        pipeline: PIPELINE,
      });

      const bridged = await new SourceRecipePipelineBridgeService(pool!, config!).bridgePipelineHandler(
        IDENTITY,
        connection.id,
        { handler_version_id: version.id, name: "Example Recipe Source" },
      );
      expect(bridged.bridged_from_connection_id).toBe(connection.id);
      expect(bridged.bridged_from_handler_version_id).toBe(version.id);
      expect(bridged.connection.id).not.toBe(connection.id);
      expect(bridged.connection.name).toBe("Example Recipe Source");
      expect(bridged.connection.handler_kind).toBe("recipe");
      expect(bridged.connection.status).toBe("paused");
      expect(bridged.connection.schedule_rule).toBeNull();
      expect(bridged.recipe_version.status).toBe("draft");
      expect(bridged.recipe_version.recipe_json).toMatchObject({
        recipe_version: "source.recipe.v1",
        output: { items_var: "items" },
      });
      expect(bridged.recipe_version.primitive_versions_json).toMatchObject({
        fetch_page: 1,
        extract_list: 1,
      });

      const oldConnectionRow = await pool!.query<{ handler_kind: string; active_recipe_version_id: string | null }>(
        `SELECT handler_kind, active_recipe_version_id FROM source_connections WHERE id = $1`,
        [connection.id],
      );
      expect(oldConnectionRow.rows[0]).toMatchObject({
        handler_kind: "generated_custom",
        active_recipe_version_id: null,
      });
      const newConnectionRow = await pool!.query<{
        handler_kind: string;
        active_recipe_version_id: string | null;
        config_json: Record<string, unknown>;
      }>(
        `SELECT handler_kind, active_recipe_version_id, config_json FROM source_connections WHERE id = $1`,
        [bridged.connection.source_connection_id],
      );
      expect(newConnectionRow.rows[0]?.handler_kind).toBe("recipe");
      expect(newConnectionRow.rows[0]?.active_recipe_version_id).toBeNull();
      expect(newConnectionRow.rows[0]?.config_json).toMatchObject({
        source_type: "pipeline_bridge",
        bridged_from: {
          source_connection_id: connection.id,
          handler_version_id: version.id,
          handler_language: "declarative_pipeline_v1",
        },
      });

      const dryRun = await new SourceRecipeDryRunService(pool!, config!).dryRunRecipeVersion(
        IDENTITY,
        bridged.connection.source_connection_id,
        {
          recipe_version_id: bridged.recipe_version.id,
          fixture_content: FIXTURE_HTML,
        },
      );
      expect(dryRun.dry_run.status).toBe("succeeded");
      expect(dryRun.dry_run.item_count).toBe(2);

      const activation = await new SourceRecipeCreateService(pool!, config!).activateRecipe(
        IDENTITY,
        bridged.connection.source_connection_id,
        { recipe_version_id: bridged.recipe_version.id },
      );
      expect(activation.status).toBe("active");
      const activeRecipeConnection = await pool!.query<{ active_recipe_version_id: string | null; status: string }>(
        `SELECT active_recipe_version_id, status FROM source_connections WHERE id = $1`,
        [bridged.connection.source_connection_id],
      );
      expect(activeRecipeConnection.rows[0]).toMatchObject({
        active_recipe_version_id: bridged.recipe_version.id,
        status: "active",
      });
    });

    it("testHandler fails closed when declarative_pipeline_v1 is not in the instance allowed_languages", async () => {
      if (!available) return;
      const connection = await createDraftConnection();
      const version = await service!.generateHandler(IDENTITY, connection.id, {
        generation_mode: "pipeline",
        pipeline: PIPELINE,
      });
      const restrictedConfig = { ...config!, customSourceAllowedLanguages: ["typescript_node"] };
      const restrictedService = new CustomSourceCreateFlowService(pool!, restrictedConfig);
      const outcome = await restrictedService.testHandler(IDENTITY, connection.id, {
        handler_version_id: version.id,
        fixture_html: FIXTURE_HTML,
      });
      expect(outcome.run.status).toBe("blocked");
      expect(outcome.run.failure_class).toBe("language_not_allowed");
    });
  });
});

describe("evaluateCustomSourceActivation", () => {
  const baseEnvelope: CustomSourcePolicyEnvelope = {
    allowed_network_origins: ["https://example.com"],
    capture_policy: "extract_text",
    retention_policy: "full_text",
    credential_ref: null,
    language: "typescript_node" as const,
    browser_automation_enabled: false,
    shell_enabled: false,
    dependency_installation_enabled: false,
    log_redaction_enabled: true,
    limits: {
      timeout_ms: 5000,
      max_download_bytes: 1000,
      max_output_bytes: 1000,
      max_files: 1,
      max_items: 10,
      max_evidence_items: 10,
      log_max_bytes: 1000,
    },
  };

  it("is within envelope on first activation when Space policy has no domain allowlist", () => {
    const result = evaluateCustomSourceActivation(baseEnvelope, {
      activeEnvelope: null,
      spaceAllowedDomains: [],
    });
    expect(result.withinEnvelope).toBe(true);
  });

  it("flags a first activation whose origin is outside the Space's allowed_domains", () => {
    const result = evaluateCustomSourceActivation(baseEnvelope, {
      activeEnvelope: null,
      spaceAllowedDomains: ["other.example"],
    });
    expect(result.withinEnvelope).toBe(false);
    expect(result.deltas[0]).toContain("not allowed by Space Custom Source policy");
  });

  it("flags a new origin not present in the previously active version's envelope", () => {
    const result = evaluateCustomSourceActivation(
      { ...baseEnvelope, allowed_network_origins: ["https://example.com", "https://new-domain.example"] },
      { activeEnvelope: baseEnvelope, spaceAllowedDomains: [] },
    );
    expect(result.withinEnvelope).toBe(false);
    expect(result.deltas[0]).toContain("not previously approved");
  });

  it("flags capture and retention broadening against the active envelope", () => {
    const result = evaluateCustomSourceActivation(
      {
        ...baseEnvelope,
        capture_policy: "archive_original",
        retention_policy: "full_snapshot",
      },
      { activeEnvelope: baseEnvelope, spaceAllowedDomains: [] },
    );
    expect(result.withinEnvelope).toBe(false);
    expect(result.deltas).toContain("capture policy broadened: extract_text -> archive_original");
    expect(result.deltas).toContain("retention policy broadened: full_text -> full_snapshot");
  });

  it("flags first-activation capture broadening beyond Space defaults", () => {
    const result = evaluateCustomSourceActivation(
      { ...baseEnvelope, capture_policy: "extract_text" },
      {
        activeEnvelope: null,
        spaceAllowedDomains: [],
        spaceDefaultCapturePolicy: "reference_only",
        spaceDefaultRetentionPolicy: "full_text",
      },
    );
    expect(result.withinEnvelope).toBe(false);
    expect(result.deltas).toContain("capture policy broadened: reference_only -> extract_text");
  });

  it("flags policy limit increases but allows narrower repairs", () => {
    const wider = evaluateCustomSourceActivation(
      { ...baseEnvelope, limits: { ...baseEnvelope.limits, max_items: 20 } },
      { activeEnvelope: baseEnvelope, spaceAllowedDomains: [] },
    );
    expect(wider.withinEnvelope).toBe(false);
    expect(wider.deltas).toContain("policy limit increased: max_items 10 -> 20");

    const narrower = evaluateCustomSourceActivation(
      {
        ...baseEnvelope,
        capture_policy: "reference_only",
        retention_policy: "summary_only",
        limits: { ...baseEnvelope.limits, max_items: 5 },
      },
      { activeEnvelope: baseEnvelope, spaceAllowedDomains: [] },
    );
    expect(narrower.withinEnvelope).toBe(true);
  });

  it("flags new credential/browser/shell/dependency requests", () => {
    const result = evaluateCustomSourceActivation(
      { ...baseEnvelope, credential_ref: "cred-1", browser_automation_enabled: true },
      { activeEnvelope: null, spaceAllowedDomains: [] },
    );
    expect(result.withinEnvelope).toBe(false);
    expect(result.deltas).toContain("credential reference requested");
    expect(result.deltas).toContain("browser automation requested");
  });
});
