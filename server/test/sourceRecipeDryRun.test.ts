import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { seedCustomSourceWorld } from "./support/customSourceWorld";
import { useTestDatabase } from "./support/testDatabase";
import { resetTables } from "./support/resetTables";
import type { SourcePolicyEnvelope, SourceRecipeDefinition } from "@agent-space/protocol" with { "resolution-mode": "import" };
import { loadConfig, type ServerConfig } from "../src/config";
import { SourceRecipeDryRunService } from "../src/modules/sources/sourceRecipes/recipeDryRunService";
import { insertSourceRecipeVersion } from "../src/modules/sources/sourceRecipes/recipeVersionStore";
import { HttpError } from "../src/modules/routeUtils/common";

// Real-Postgres integration tests for the Level 2 recipe dry-run: bounded,
// side-effect-free preview of a draft recipe version. Skips without Docker.

const SPACE_A = "space-a";
const IDENTITY = { spaceId: SPACE_A, userId: "user-1" };
const ORIGIN = "https://example.com";

let config: ServerConfig | undefined;
let service: SourceRecipeDryRunService | undefined;

const db = useTestDatabase(__filename, { max: 10 });

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

const ENVELOPE: SourcePolicyEnvelope = {
  allowed_network_origins: [ORIGIN],
  capture_policy: "extract_text",
  retention_policy: "full_text",
  credential_ref: null,
  log_redaction_enabled: true,
  limits: {
    timeout_ms: 5000,
    max_download_bytes: 1_000_000,
    max_output_bytes: 1_000_000,
    max_files: 5,
    max_items: 20,
    max_evidence_items: 20,
    log_max_bytes: 65536,
  },
};

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
