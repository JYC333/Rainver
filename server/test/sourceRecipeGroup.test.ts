import { randomUUID } from "node:crypto";
import { sourcePolicyEnvelope } from "./support/customSourceFixtures.js";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SourceRecipeDefinition } from "@agent-space/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadConfig, type ServerConfig } from "../src/config.js";
import { PgProposalApplyService } from "../src/modules/proposals/applyService.js";
import { HttpError } from "../src/modules/routeUtils/common.js";
import { PgSourcesRepository } from "../src/modules/sources/repository.js";
import { analyzeSourceRecipe, SOURCE_RECIPE_PRIMITIVE_REGISTRY } from "../src/modules/sources/sourceRecipes/primitiveRegistry.js";
import { SourceRecipeCreateService } from "../src/modules/sources/sourceRecipes/recipeCreateService.js";
import { SourceRecipeDryRunService } from "../src/modules/sources/sourceRecipes/recipeDryRunService.js";
import { insertSourceRecipeVersion } from "../src/modules/sources/sourceRecipes/recipeVersionStore.js";
import { listSourceRuns } from "../src/modules/sources/sourceRunReadModel.js";
import { seedCustomSourceWorld, upsertCustomSourceSpacePolicy } from "./support/customSourceWorld.js";
import { resetTables } from "./support/resetTables.js";
import { useTestDatabase } from "./support/testDatabase.js";

describe("sourceRecipeCreateFlow", () => {
  const SPACE_A = "space-a";
  const IDENTITY = { spaceId: SPACE_A, userId: "user-1" };

  let config: ServerConfig | undefined;
  let createService: SourceRecipeCreateService | undefined;
  let dryRunService: SourceRecipeDryRunService | undefined;
  let artifactStorageRoot: string | undefined;
  let fixtureServer: Server | undefined;

  const db = useTestDatabase(`${import.meta.filename}#sourceRecipeCreateFlow`, { max: 10 });

  beforeEach(async () => {
    if (!db.available) return;
    await resetTables(
      db.pool,
      ["evolution_bundle_members", "evolution_bundles", "jobs", "retrieval_edges", "retrieval_chunks", "retrieval_aliases", "retrieval_objects", "policy_decision_records", "proposal_approvals", "proposals", "runs", "space_memberships", "source_handler_runs", "source_handler_versions", "source_recipe_versions", "source_channel_item_links", "source_channel_user_subscriptions", "source_channels", "source_connections", "source_connectors", "scheduler_tasks", "settings", "artifacts", "extraction_jobs", "source_items", "source_snapshots", "extracted_evidence", "credentials", "source_provider_connectors", "source_providers", "users", "spaces"],
      { cascade: true },
    );
    // The real schema enforces the connector/provider mapping and the
    // space/user chain that the hand-maintained schema copy this suite used to
    // load did not carry.
    await seedCustomSourceWorld(db.pool, IDENTITY);
    artifactStorageRoot = await mkdtemp(join(tmpdir(), "source-recipe-create-flow-artifacts-"));
    config = {
      ...loadConfig({}),
      databaseUrl: db.connectionUri,
      artifactStorageRoot,
    };
    createService = new SourceRecipeCreateService(db.pool, config);
    dryRunService = new SourceRecipeDryRunService(db.pool, config);
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

  describe("SourceRecipeCreateService (real Postgres)", () => {
    it("plans, creates, dry-runs, activates, and scans a recipe source into Source", async () => {
      if (!db.available) return;
      const endpointUrl = await startFixtureServer(RSS_FIXTURE);
      const { created, dryRun, activation } = await createDryRunActivatedRecipeSource(endpointUrl);

      const connectionRow = await db.pool.query<{
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

      const repo = new PgSourcesRepository(db.pool, config!);
      const queued = await repo.scanChannel(IDENTITY, created.connection.source_channel_id);
      expect(queued.metadata_json).toMatchObject({
        implementation: "recipe",
        recipe_version_id: dryRun.recipe_version.id,
      });
      const completed = await repo.runJob(IDENTITY, queued.id);
      expect(completed.status).toBe("succeeded");
      expect(completed.items_created).toBe(2);

      const items = await db.pool.query<{
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

      const sourceRuns = await listSourceRuns(db.pool, IDENTITY, created.connection.source_channel_id, { limit: 10, offset: 0 });
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

      const firstItem = await db.pool.query<{ id: string }>(
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
      if (!db.available) return;
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

      await upsertCustomSourceSpacePolicy(db.pool, SPACE_A, { allowed_domains: ["other.example"] });
      const activation = await createService!.activateRecipe(IDENTITY, created.connection.id, {
        recipe_version_id: dryRun.recipe_version.id,
        schedule_rule: HOURLY_SCHEDULE_RULE,
      });
      expect(activation.status).toBe("pending_approval");
      expect(activation.proposal_id).toEqual(expect.any(String));
      expect(activation.deltas[0]).toContain("not allowed by Space Custom Source policy");

      const pendingVersion = await db.pool.query<{ status: string; proposal_id: string | null }>(
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

      const activeConnection = await db.pool.query<{ active_recipe_version_id: string | null; status: string }>(
        `SELECT active_recipe_version_id, status FROM source_connections WHERE id = $1`,
        [created.connection.id],
      );
      expect(activeConnection.rows[0]).toMatchObject({
        active_recipe_version_id: dryRun.recipe_version.id,
        status: "active",
      });
    });
  });
});

describe("sourceRecipeDryRun", () => {
  // Real-Postgres integration tests for the Level 2 recipe dry-run: bounded,
  // side-effect-free preview of a draft recipe version. Skips without Docker.

  const SPACE_A = "space-a";
  const IDENTITY = { spaceId: SPACE_A, userId: "user-1" };
  const ORIGIN = "https://example.com";

  let config: ServerConfig | undefined;
  let service: SourceRecipeDryRunService | undefined;

  const db = useTestDatabase(`${import.meta.filename}#sourceRecipeDryRun`, { max: 10 });

  beforeEach(async () => {
    if (!db.available) return;
    await resetTables(
      db.pool,
      ["jobs", "retrieval_edges", "retrieval_chunks", "retrieval_aliases", "retrieval_objects", "policy_decision_records", "proposal_approvals", "proposals", "runs", "space_memberships", "source_handler_runs", "source_handler_versions", "source_recipe_versions", "source_channel_item_links", "source_channel_user_subscriptions", "source_channels", "source_connections", "source_connectors", "scheduler_tasks", "settings", "artifacts", "extraction_jobs", "source_items", "source_snapshots", "extracted_evidence", "credentials", "source_provider_connectors", "source_providers", "users", "spaces"],
      { cascade: true },
    );
    await seedCustomSourceWorld(db.pool, IDENTITY);
    config = { ...loadConfig({}), databaseUrl: db.connectionUri };
    service = new SourceRecipeDryRunService(db.pool, config);
  });

  const RSS_FIXTURE = `<?xml version="1.0"?>
  <rss version="2.0"><channel><title>Feed</title>
    <item><title>One</title><link>${ORIGIN}/one</link><guid>guid-1</guid><description>First body</description></item>
    <item><title>Two</title><link>${ORIGIN}/two</link><guid>guid-2</guid><description>Second body</description></item>
  </channel></rss>`;

  const FEED_RECIPE: SourceRecipeDefinition = {
    recipe_version: "source.recipe.v1",
    steps: [
      { type: "fetch_page", url: "$source.endpoint_url", bind: "feed" },
      { type: "parse_rss", input: "feed", bind: "items" },
    ],
    output: { items_var: "items" },
  };

  const ENVELOPE = sourcePolicyEnvelope({ allowed_network_origins: [ORIGIN] });

  async function seedRecipeConnection(handlerKind = "recipe"): Promise<string> {
    const connectionId = randomUUID();
    await db.pool.query(
      `INSERT INTO source_connections (
         id, space_id, provider_connector_id, owner_user_id, name, status,
         capture_policy, trust_level, consent_json, policy_json,
         config_json, handler_kind, created_at, updated_at
       ) VALUES ($1, $2, 'mapping-custom-source', $3, $5, 'paused',
         'extract_text', 'normal', '{}'::jsonb, '{}'::jsonb,
         '{}'::jsonb, $4, now(), now())`,
      [connectionId, SPACE_A, IDENTITY.userId, handlerKind, `Feed Source ${connectionId}`],
    );
    await db.pool.query(
      `INSERT INTO source_channels (
         id, space_id, source_connection_id, created_by_user_id, name, channel_type,
         endpoint_url, query_json, provider_query_json, query_fingerprint, status,
         fetch_frequency, schedule_rule_json, created_at, updated_at
       ) VALUES ($1,$2,$1,$3,'Feed Channel','feed',$4,'{}'::jsonb,'{}'::jsonb,$1,'paused','manual',NULL,now(),now())`,
      [connectionId, SPACE_A, IDENTITY.userId, `${ORIGIN}/feed.xml`],
    );
    return connectionId;
  }

  async function seedRecipeVersion(connectionId: string, recipe: SourceRecipeDefinition = FEED_RECIPE) {
    return insertSourceRecipeVersion(db.pool, {
      spaceId: SPACE_A,
      connectionId,
      recipe,
      policyEnvelope: ENVELOPE,
      primitiveVersions: { fetch_page: 1, parse_rss: 1 },
      createdByUserId: IDENTITY.userId,
    });
  }

  describe("SourceRecipeDryRunService (real Postgres)", () => {
    it("dry-runs a draft recipe against fixture content without writing any Source output", async () => {
      if (!db.available || !service) return;
      const connectionId = await seedRecipeConnection();
      const version = await seedRecipeVersion(connectionId);

      const result = await service.dryRunRecipeVersion(IDENTITY, connectionId, {
        recipe_version_id: version.id,
        fixture_content: RSS_FIXTURE,
      });

      expect(result.dry_run.status).toBe("succeeded");
      expect(result.dry_run.item_count).toBe(2);
      expect(result.dry_run.sample_items[0]).toMatchObject({ external_id: "guid-1", title: "One" });
      expect(result.dry_run.step_traces.map((trace) => trace.primitive)).toEqual(["fetch_page", "parse_rss"]);
      // Network, retention, and output limits are visible in the preview.
      expect(result.dry_run.policy_envelope.allowed_network_origins).toEqual([ORIGIN]);
      expect(result.dry_run.policy_envelope.retention_policy).toBe("full_text");
      expect(result.dry_run.policy_envelope.limits.max_output_bytes).toBe(1_000_000);
      expect(result.recipe_version.status).toBe("draft");

      const stored = await db.pool.query<{ test_result_json: { status: string } }>(
        `SELECT test_result_json FROM source_recipe_versions WHERE id = $1`,
        [version.id],
      );
      expect(stored.rows[0]!.test_result_json.status).toBe("succeeded");

      for (const table of ["source_items", "source_snapshots", "extracted_evidence", "artifacts", "extraction_jobs"]) {
        const rows = await db.pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${table}`);
        expect(rows.rows[0]!.n).toBe(0);
      }
    });

    it("is deterministic for the same fixture content", async () => {
      if (!db.available || !service) return;
      const connectionId = await seedRecipeConnection();
      const version = await seedRecipeVersion(connectionId);

      const first = await service.dryRunRecipeVersion(IDENTITY, connectionId, {
        recipe_version_id: version.id,
        fixture_content: RSS_FIXTURE,
      });
      const second = await service.dryRunRecipeVersion(IDENTITY, connectionId, {
        recipe_version_id: version.id,
        fixture_content: RSS_FIXTURE,
      });
      expect(second.dry_run.sample_items).toEqual(first.dry_run.sample_items);
      expect(second.dry_run.item_count).toBe(first.dry_run.item_count);
      expect(second.dry_run.step_traces.map((trace) => [trace.step_path, trace.status])).toEqual(
        first.dry_run.step_traces.map((trace) => [trace.step_path, trace.status]),
      );
    });

    it("marks the version test_failed and captures a failure fixture when the recipe fails", async () => {
      if (!db.available || !service) return;
      const connectionId = await seedRecipeConnection();
      const version = await seedRecipeVersion(connectionId, {
        recipe_version: "source.recipe.v1",
        steps: [{ type: "extract_list", input: "never_bound", selector: { css_class: "x" }, bind: "items" }],
        output: { items_var: "items" },
      });

      const result = await service.dryRunRecipeVersion(IDENTITY, connectionId, {
        recipe_version_id: version.id,
        fixture_content: RSS_FIXTURE,
      });
      expect(result.dry_run.status).toBe("failed");
      expect(result.recipe_version.status).toBe("test_failed");
      const fixture = (result.dry_run as { failure_fixture?: { content_sha256: string; content_excerpt: string } })
        .failure_fixture;
      expect(fixture?.content_sha256).toHaveLength(64);
      expect(fixture?.content_excerpt).toContain("<rss");
    });

    it("rejects a dry-run against a non-draft version and a non-recipe connection", async () => {
      if (!db.available || !service) return;
      const connectionId = await seedRecipeConnection();
      const version = await seedRecipeVersion(connectionId);
      await db.pool.query(`UPDATE source_recipe_versions SET status = 'active' WHERE id = $1`, [version.id]);
      await expect(
        service.dryRunRecipeVersion(IDENTITY, connectionId, {
          recipe_version_id: version.id,
          fixture_content: RSS_FIXTURE,
        }),
      ).rejects.toMatchObject({ statusCode: 409 });

      const builtInId = await seedRecipeConnection("built_in");
      await expect(
        service.dryRunRecipeVersion(IDENTITY, builtInId, {
          recipe_version_id: version.id,
          fixture_content: RSS_FIXTURE,
        }),
      ).rejects.toBeInstanceOf(HttpError);
    });
  });
});

describe("sourceRecipePrimitiveRegistry", () => {
  describe("source recipe primitive registry", () => {
    it("declares live network access only for fetching primitives and file writes only for snapshot-storing primitives", () => {
      expect(SOURCE_RECIPE_PRIMITIVE_REGISTRY.parse_rss.network_access).toBe("none");
      expect(SOURCE_RECIPE_PRIMITIVE_REGISTRY.extract_list.network_access).toBe("none");
      expect(SOURCE_RECIPE_PRIMITIVE_REGISTRY.follow_link.network_access).toBe("live_fetch");
      expect(SOURCE_RECIPE_PRIMITIVE_REGISTRY.follow_link.writes_files).toBe(true);
      expect(SOURCE_RECIPE_PRIMITIVE_REGISTRY.download_asset.writes_files).toBe(true);
      expect(SOURCE_RECIPE_PRIMITIVE_REGISTRY.dedupe.network_access).toBe("none");
      expect(SOURCE_RECIPE_PRIMITIVE_REGISTRY.dedupe.writes_files).toBe(false);
    });
  });

  describe("analyzeSourceRecipe", () => {
    it("reports primary_endpoint access for a sentinel-only feed recipe", () => {
      const recipe: SourceRecipeDefinition = {
        recipe_version: "source.recipe.v1",
        steps: [
          { type: "fetch_page", url: "$source.endpoint_url", bind: "feed" },
          { type: "parse_rss", input: "feed", bind: "items" },
          { type: "dedupe", input: "items", bind: "deduped" },
        ],
        output: { items_var: "deduped" },
      };
      const analysis = analyzeSourceRecipe(recipe);
      expect(analysis.network_access).toBe("primary_endpoint");
      expect(analysis.writes_files).toBe(false);
      expect(analysis.live_fetch_urls).toEqual([]);
      expect(analysis.primitives).toEqual(["fetch_page", "parse_rss", "dedupe"]);
      expect(analysis.primitive_versions).toMatchObject({ fetch_page: 1, parse_rss: 1, dedupe: 1 });
    });

    it("reports live_fetch, file writes, and literal URLs for a crawling recipe (including nested paginate steps)", () => {
      const recipe: SourceRecipeDefinition = {
        recipe_version: "source.recipe.v1",
        steps: [
          { type: "fetch_page", url: "$source.endpoint_url", bind: "page1" },
          {
            type: "paginate",
            input: "page1",
            max_pages: 3,
            next_page: { mode: "link_rel_next" },
            steps: [
              { type: "fetch_page", url: "https://sources.example/extra", bind: "extra" },
              { type: "extract_list", input: "page1", selector: { css_class: "article" }, bind: "page_items" },
            ],
            page_items_var: "page_items",
            bind: "items",
          },
          { type: "follow_link", items_var: "items", max_follow: 5 },
        ],
        output: { items_var: "items" },
      };
      const analysis = analyzeSourceRecipe(recipe);
      expect(analysis.network_access).toBe("live_fetch");
      expect(analysis.writes_files).toBe(true);
      expect(analysis.live_fetch_urls).toEqual(["https://sources.example/extra"]);
      expect(analysis.primitives).toEqual(
        expect.arrayContaining(["fetch_page", "paginate", "extract_list", "follow_link"]),
      );
    });
  });
});
