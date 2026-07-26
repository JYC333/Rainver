import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { getTestPostgres, type TestPostgresDatabase } from "./support/sharedPostgres";
import { loadConfig, type ServerConfig } from "../src/config";
import { getDbPool } from "../src/db/pool";
import { PgSourcesRepository } from "../src/modules/sources/repository";
import { listSourceRuns } from "../src/modules/sources/sourceRunReadModel";
import { SourceRecipeCreateService } from "../src/modules/sources/sourceRecipes/recipeCreateService";
import { SourceRecipeDryRunService } from "../src/modules/sources/sourceRecipes/recipeDryRunService";
import { PgProposalApplyService } from "../src/modules/proposals/applyService";

const SCHEMA = readFileSync(join(process.cwd(), "test/fixtures/sourceCustomSourceCreateFlowSchema.sql"), "utf8");

const SPACE_A = "space-a";
const IDENTITY = { spaceId: SPACE_A, userId: "user-1" };
const CUSTOM_SOURCE_SPACE_POLICY_SETTINGS_KEY = "source.custom_source.space_policy";

let container: TestPostgresDatabase | undefined;
let pool: Pool | undefined;
let config: ServerConfig | undefined;
let createService: SourceRecipeCreateService | undefined;
let dryRunService: SourceRecipeDryRunService | undefined;
let artifactStorageRoot: string | undefined;
let fixtureServer: Server | undefined;
let available = false;

beforeAll(async () => {
  try {
    container = await getTestPostgres(__filename, { empty: true });
    pool = new Pool({ connectionString: container.getConnectionUri() });
    await pool.query(SCHEMA);
    available = true;
  } catch (err) {
    console.warn(
      `[source-source-recipe-create-flow] skipped - Docker/Postgres unavailable: ${
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
              source_channel_user_subscriptions, source_channels, source_connections,
              source_connectors, scheduler_tasks, settings, artifacts, extraction_jobs, source_items,
              source_snapshots, extracted_evidence, credentials`,
  );
  await pool.query(
    `INSERT INTO source_connectors (
       id, connector_key, display_name, connector_type, ingestion_mode, status,
       capabilities_json, created_at, updated_at
     ) VALUES ('connector-custom-source', 'custom_source', 'Custom Source', 'external_url', 'pull', 'active', '{}'::jsonb, now(), now())`,
  );
  await pool.query(
    `INSERT INTO space_memberships (id, space_id, user_id, role, status, created_at, updated_at)
     VALUES ($1, $2, $3, 'owner', 'active', now(), now())`,
    [randomUUID(), IDENTITY.spaceId, IDENTITY.userId],
  );
  artifactStorageRoot = await mkdtemp(join(tmpdir(), "source-recipe-create-flow-artifacts-"));
  config = {
    ...loadConfig({}),
    databaseUrl: container!.getConnectionUri(),
    artifactStorageRoot,
  };
  createService = new SourceRecipeCreateService(pool, config);
  dryRunService = new SourceRecipeDryRunService(pool, config);
});

afterEach(async () => {
  await new Promise<void>((resolve, reject) => {
    if (!fixtureServer) return resolve();
    fixtureServer.close((error) => (error ? reject(error) : resolve()));
    fixtureServer = undefined;
  });
  if (artifactStorageRoot) await rm(artifactStorageRoot, { recursive: true, force: true });
});

const RSS_FIXTURE = `<?xml version="1.0"?>
<rss version="2.0"><channel><title>Feed</title>
  <item><title>One</title><link>/one</link><guid>guid-1</guid><description>First body</description></item>
  <item><title>Two</title><link>/two</link><guid>guid-2</guid><description>Second body</description></item>
</channel></rss>`;
const HOURLY_SCHEDULE_RULE = { frequency: "hourly", minute: 0 };

async function startFixtureServer(body: string): Promise<string> {
  fixtureServer = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/rss+xml; charset=utf-8" });
    res.end(body);
  });
  await new Promise<void>((resolve) => fixtureServer!.listen(0, "127.0.0.1", resolve));
  const address = fixtureServer.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}/feed.xml`;
}

async function createDryRunActivatedRecipeSource(endpointUrl: string) {
  const plan = await createService!.planSource(IDENTITY, {
    name: "Recipe Feed",
    endpoint_url: endpointUrl,
    fetch_frequency: "hourly",
    capture_policy: "extract_text",
    fixture_content: RSS_FIXTURE,
  });
  expect(plan.source_type).toBe("rss");
  expect(plan.preview.status).toBe("succeeded");
  expect(plan.preview.sample_items.map((item: { title: string }) => item.title)).toEqual(["One", "Two"]);

  const created = await createService!.createSource(IDENTITY, {
    name: "Recipe Feed",
    endpoint_url: endpointUrl,
    fetch_frequency: "hourly",
    schedule_rule: HOURLY_SCHEDULE_RULE,
    capture_policy: "extract_text",
    recipe: plan.recipe,
  });
  expect(created.connection.handler_kind).toBe("recipe");
  expect(created.connection.status).toBe("paused");
  // Paused channels intentionally do not carry an active scheduler rule;
  // activation applies the requested schedule atomically.
  expect(created.connection.schedule_rule).toBeNull();

  const dryRun = await dryRunService!.dryRunRecipeVersion(IDENTITY, created.connection.id, {
    recipe_version_id: created.recipe_version.id,
    fixture_content: RSS_FIXTURE,
  });
  expect(dryRun.dry_run.status).toBe("succeeded");
  expect(dryRun.dry_run.item_count).toBe(2);

  const activation = await createService!.activateRecipe(IDENTITY, created.connection.id, {
    recipe_version_id: dryRun.recipe_version.id,
    schedule_rule: HOURLY_SCHEDULE_RULE,
  });
  expect(activation.status).toBe("active");

  return { plan, created, dryRun, activation };
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

describe("SourceRecipeCreateService (real Postgres)", () => {
  it("plans, creates, dry-runs, activates, and scans a recipe source into Source", async () => {
    if (!available) return;
    const endpointUrl = await startFixtureServer(RSS_FIXTURE);
    const { created, dryRun, activation } = await createDryRunActivatedRecipeSource(endpointUrl);

    const connectionRow = await pool!.query<{
      handler_kind: string;
      active_recipe_version_id: string | null;
      status: string;
      config_json: Record<string, unknown>;
    }>(
      `SELECT handler_kind, active_recipe_version_id, status, config_json FROM source_connections WHERE id = $1`,
      [created.connection.id],
    );
    expect(connectionRow.rows[0]).toMatchObject({
      handler_kind: "recipe",
      active_recipe_version_id: dryRun.recipe_version.id,
      status: "active",
      config_json: { source_type: "rss" },
    });
    expect(activation.recipe_version.status).toBe("active");

    const repo = new PgSourcesRepository(pool!, config!);
    const queued = await repo.scanChannel(IDENTITY, created.connection.source_channel_id);
    expect(queued.metadata_json).toMatchObject({
      implementation: "recipe",
      recipe_version_id: dryRun.recipe_version.id,
    });
    const completed = await repo.runJob(IDENTITY, queued.id);
    expect(completed.status).toBe("succeeded");
    expect(completed.items_created).toBe(2);

    const items = await pool!.query<{
      title: string;
      source_external_id: string | null;
      content_state: string;
      metadata_json: Record<string, unknown>;
    }>(
      `SELECT title, source_external_id, content_state, metadata_json FROM source_items WHERE connection_id = $1 ORDER BY title ASC`,
      [created.connection.id],
    );
    expect(items.rows).toMatchObject([
      { title: "One", source_external_id: "guid-1", content_state: "excerpt_saved", metadata_json: { capture_method: "source_recipe" } },
      { title: "Two", source_external_id: "guid-2", content_state: "excerpt_saved", metadata_json: { capture_method: "source_recipe" } },
    ]);

    const sourceRuns = await listSourceRuns(pool!, IDENTITY, created.connection.source_channel_id, { limit: 10, offset: 0 });
    expect(sourceRuns.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: `recipe_dry_run:${dryRun.recipe_version.id}`,
          run_kind: "dry_run",
          implementation: "recipe",
          status: "succeeded",
          items_created: 2,
          recipe_version_id: dryRun.recipe_version.id,
        }),
        expect.objectContaining({
          id: `job:${queued.id}`,
          run_kind: "scan",
          implementation: "recipe",
          status: "succeeded",
          items_created: 2,
          extraction_job_id: queued.id,
          handler_run_id: null,
          recipe_version_id: dryRun.recipe_version.id,
        }),
      ]),
    );

    const firstItem = await pool!.query<{ id: string }>(
      `SELECT id FROM source_items WHERE connection_id = $1 ORDER BY title ASC LIMIT 1`,
      [created.connection.id],
    );
    await repo.createEvidence(IDENTITY, {
      source_item_id: firstItem.rows[0]!.id,
      evidence_type: "excerpt",
      title: "Recipe evidence",
      content_excerpt: "Evidence created from a recipe item.",
      trust_level: "normal",
      extraction_method: "manual_test",
      confidence: 0.7,
      status: "candidate",
      metadata: { source: "proposal_apply_test" },
    });
    const evidencePage = await repo.listEvidence(IDENTITY, {
      status: null,
      evidenceType: null,
      sourceItemId: null,
      projectId: null,
      connectionId: created.connection.id,
      limit: 20,
      offset: 0,
    });
    expect(evidencePage.items).toEqual([
      expect.objectContaining({
        title: "Recipe evidence",
        source_item_id: firstItem.rows[0]!.id,
      }),
    ]);
  });

  it("routes policy-envelope deltas through a source_recipe_activation proposal applier", async () => {
    if (!available) return;
    const endpointUrl = await startFixtureServer(RSS_FIXTURE);
    const plan = await createService!.planSource(IDENTITY, {
      name: "Policy Recipe Feed",
      endpoint_url: endpointUrl,
      fetch_frequency: "hourly",
      capture_policy: "extract_text",
      fixture_content: RSS_FIXTURE,
    });
    const created = await createService!.createSource(IDENTITY, {
      name: "Policy Recipe Feed",
      endpoint_url: endpointUrl,
      fetch_frequency: "hourly",
      schedule_rule: HOURLY_SCHEDULE_RULE,
      capture_policy: "extract_text",
      recipe: plan.recipe,
    });
    const dryRun = await dryRunService!.dryRunRecipeVersion(IDENTITY, created.connection.id, {
      recipe_version_id: created.recipe_version.id,
      fixture_content: RSS_FIXTURE,
    });

    await insertCustomSourceSpacePolicy({ allowed_domains: ["other.example"] });
    const activation = await createService!.activateRecipe(IDENTITY, created.connection.id, {
      recipe_version_id: dryRun.recipe_version.id,
      schedule_rule: HOURLY_SCHEDULE_RULE,
    });
    expect(activation.status).toBe("pending_approval");
    expect(activation.proposal_id).toEqual(expect.any(String));
    expect(activation.deltas[0]).toContain("not allowed by Space Custom Source policy");

    const pendingVersion = await pool!.query<{ status: string; proposal_id: string | null }>(
      `SELECT status, proposal_id FROM source_recipe_versions WHERE id = $1`,
      [dryRun.recipe_version.id],
    );
    expect(pendingVersion.rows[0]).toMatchObject({
      status: "pending_approval",
      proposal_id: activation.proposal_id,
    });

    const accepted = await PgProposalApplyService.fromConfig(config!).accept(
      activation.proposal_id!,
      IDENTITY,
    );
    expect(accepted?.result_type).toBe("source_recipe_version");
    expect(accepted?.result).toMatchObject({
      source_connection_id: created.connection.id,
      recipe_version_id: dryRun.recipe_version.id,
      status: "active",
    });
    expect(accepted?.proposal.status).toBe("accepted");

    const activeConnection = await pool!.query<{ active_recipe_version_id: string | null; status: string }>(
      `SELECT active_recipe_version_id, status FROM source_connections WHERE id = $1`,
      [created.connection.id],
    );
    expect(activeConnection.rows[0]).toMatchObject({
      active_recipe_version_id: dryRun.recipe_version.id,
      status: "active",
    });
  });
});
