import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useTestDatabase } from "./support/testDatabase";
import { resetTables } from "./support/resetTables";
import { EvolvableAssetRepository } from "../src/modules/evolution/assetRepository";
import { syncBuiltinPrompts } from "../src/modules/prompts/builtins";
import { resolvePrompt } from "../src/modules/prompts/resolver";
import { PromptRepository } from "../src/modules/prompts/repository";
import type { SpaceUserIdentity } from "../src/modules/routeUtils/common";

// Real-Postgres coverage for the built-in prompt sync + resolver: sync must
// be idempotent, must never overwrite an existing immutable version, and
// must add a new version + move current_system_version_id when manifest
// content changes. resolvePrompt must resolve a synced built-in and render
// it; the M1 read-only facade must surface what sync wrote.

const REAL_CATALOG_ROOT = resolve(process.cwd(), "..", "catalog");
const SPACE = "33333333-1111-4111-8111-111111111111";
const OWNER = "3baaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const PROJECT = "55555555-1111-4111-8111-555555555555";


const db = useTestDatabase(__filename);

beforeEach(async () => {
  if (!db.available) return;
  await resetTables(
    db.pool,
    ["evolvable_asset_pins", "evolvable_asset_versions", "evolvable_assets", "space_memberships", "users", "spaces"],
    { cascade: true },
  );
  const now = new Date().toISOString();
  await db.pool.query(`INSERT INTO spaces (id, name, type, created_at, updated_at) VALUES ($1,'Main','personal',$2,$2)`, [SPACE, now]);
  await db.pool.query(`INSERT INTO users (id, display_name, status, created_at, updated_at) VALUES ($1,$1,'active',$2,$2)`, [OWNER, now]);
  await db.pool.query(
    `INSERT INTO space_memberships (id, space_id, user_id, role, status, created_at, updated_at)
     VALUES ($1,$2,$3,'owner','active',$4,$4)`,
    [randomUUID(), SPACE, OWNER, now],
  );
});

const identity: SpaceUserIdentity = { spaceId: SPACE, userId: OWNER };

function evolvableRepo(): EvolvableAssetRepository {
  return new EvolvableAssetRepository(db.pool);
}

let tempCatalogRoot: string | undefined;

afterEach(async () => {
  if (tempCatalogRoot) {
    await rm(tempCatalogRoot, { recursive: true, force: true });
    tempCatalogRoot = undefined;
  }
});

async function singleManifestCatalog(assetKey: string, content: Record<string, unknown>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "prompt-sync-catalog-"));
  tempCatalogRoot = dir;
  const promptsDir = join(dir, "prompts");
  await mkdir(promptsDir, { recursive: true });
  const manifest = { asset_key: assetKey, display_name: assetKey, content };
  await writeFile(join(promptsDir, "asset.yaml"), yamlDump(manifest), "utf8");
  return dir;
}

// Minimal YAML dumper sufficient for the flat manifest shapes used in this
// test — avoids pulling in a YAML stringify dependency for a handful of
// string/object/array fields.
function yamlDump(value: unknown, indent = 0): string {
  const pad = "  ".repeat(indent);
  if (Array.isArray(value)) {
    if (value.length === 0) return "[]";
    return value.map((item) => `${pad}- ${yamlDump(item, indent + 1).trimStart()}`).join("\n");
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length === 0) return "{}";
    return entries
      .map(([key, val]) => {
        if (val && typeof val === "object") {
          return `${pad}${key}:\n${yamlDump(val, indent + 1)}`;
        }
        return `${pad}${key}: ${JSON.stringify(val)}`;
      })
      .join("\n");
  }
  return JSON.stringify(value);
}

describe("syncBuiltinPrompts (real Postgres)", () => {
  it("syncs the real catalog/prompts manifests into system-scope approved built-in versions", async () => {
    if (!db.available) return;
    const result = await syncBuiltinPrompts(db.pool, REAL_CATALOG_ROOT);
    expect(result.assetKeys).toContain("retrieval.query_rewrite");
    expect(result.versionsCreated).toContain("retrieval.query_rewrite");

    const row = await db.pool.query<{
      status: string;
      source: string;
      space_id: string | null;
      current_system_version_id: string | null;
    }>(
      `SELECT v.status, v.source, a.space_id, a.current_system_version_id
         FROM evolvable_assets a
         JOIN evolvable_asset_versions v ON v.id = a.current_system_version_id
        WHERE a.asset_key = 'retrieval.query_rewrite'`,
    );
    expect(row.rows[0]).toMatchObject({ status: "approved", source: "built_in", space_id: null });
    expect(row.rows[0]?.current_system_version_id).toBeTruthy();
  });

  it("is idempotent: re-running sync creates no new versions when content is unchanged", async () => {
    if (!db.available) return;
    await syncBuiltinPrompts(db.pool, REAL_CATALOG_ROOT);
    const second = await syncBuiltinPrompts(db.pool, REAL_CATALOG_ROOT);
    expect(second.versionsCreated).toEqual([]);

    const count = await db.pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM evolvable_asset_versions v
         JOIN evolvable_assets a ON a.id = v.asset_id
        WHERE a.asset_key = 'retrieval.query_rewrite'`,
    );
    expect(count.rows[0]?.count).toBe("1");
  });

  it("preserves out-of-band metadata_json keys on an asset across re-sync", async () => {
    if (!db.available) return;
    await syncBuiltinPrompts(db.pool, REAL_CATALOG_ROOT);
    await db.pool.query(
      `UPDATE evolvable_assets SET metadata_json = metadata_json || '{"allow_user_override": true}'::jsonb
        WHERE asset_key = 'retrieval.query_rewrite'`,
    );

    await syncBuiltinPrompts(db.pool, REAL_CATALOG_ROOT);

    const row = await db.pool.query<{ metadata_json: Record<string, unknown> }>(
      `SELECT metadata_json FROM evolvable_assets WHERE asset_key = 'retrieval.query_rewrite'`,
    );
    expect(row.rows[0]?.metadata_json).toEqual({ prompt_type: "retrieval_query", allow_user_override: true });
  });

  it("does not mutate a same-key non-prompt system asset when sync hits a key collision", async () => {
    if (!db.available) return;
    const assetKey = "test.conflicting_key";
    const dir = await singleManifestCatalog(assetKey, {
      schema_version: "prompt_asset.v1",
      prompt_type: "text",
      template: "hello",
    });
    const now = new Date().toISOString();
    await db.pool.query(
      `INSERT INTO evolvable_assets (
         id, space_id, asset_type, asset_key, display_name, description, owner_scope_type, owner_scope_id,
         status, metadata_json, created_at, updated_at
       ) VALUES ($1, NULL, 'workflow_template', $2, 'Existing Workflow', NULL, 'system', NULL, 'active', '{}'::jsonb, $3, $3)`,
      [randomUUID(), assetKey, now],
    );

    await expect(syncBuiltinPrompts(db.pool, dir)).rejects.toThrow(/was not created before version sync/);

    const row = await db.pool.query<{ asset_type: string; metadata_json: Record<string, unknown> }>(
      `SELECT asset_type, metadata_json FROM evolvable_assets WHERE asset_key = $1 AND space_id IS NULL`,
      [assetKey],
    );
    expect(row.rows[0]).toEqual({ asset_type: "workflow_template", metadata_json: {} });
  });

  it("adds a new immutable version and moves current_system_version_id when content changes, without touching the old version", async () => {
    if (!db.available) return;
    const assetKey = "test.changing_prompt";
    const v1Dir = await singleManifestCatalog(assetKey, {
      schema_version: "prompt_asset.v1",
      prompt_type: "text",
      template: "v1 text",
    });
    const first = await syncBuiltinPrompts(db.pool, v1Dir);
    expect(first.versionsCreated).toEqual([assetKey]);

    const v1 = await db.pool.query<{ id: string; content_json: { template: string } }>(
      `SELECT v.id, v.content_json FROM evolvable_asset_versions v
         JOIN evolvable_assets a ON a.id = v.asset_id WHERE a.asset_key = $1`,
      [assetKey],
    );
    expect(v1.rows).toHaveLength(1);
    expect(v1.rows[0]?.content_json.template).toBe("v1 text");

    await rm(v1Dir, { recursive: true, force: true });
    tempCatalogRoot = undefined;
    const v2Dir = await singleManifestCatalog(assetKey, {
      schema_version: "prompt_asset.v1",
      prompt_type: "text",
      template: "v2 text",
    });
    const second = await syncBuiltinPrompts(db.pool, v2Dir);
    expect(second.versionsCreated).toEqual([assetKey]);

    const versions = await db.pool.query<{ id: string; version: number; content_json: { template: string } }>(
      `SELECT v.id, v.version, v.content_json FROM evolvable_asset_versions v
         JOIN evolvable_assets a ON a.id = v.asset_id WHERE a.asset_key = $1 ORDER BY v.version ASC`,
      [assetKey],
    );
    expect(versions.rows).toHaveLength(2);
    expect(versions.rows[0]?.content_json.template).toBe("v1 text");
    expect(versions.rows[1]?.content_json.template).toBe("v2 text");

    const asset = await db.pool.query<{ current_system_version_id: string }>(
      `SELECT current_system_version_id FROM evolvable_assets WHERE asset_key = $1`,
      [assetKey],
    );
    expect(asset.rows[0]?.current_system_version_id).toBe(versions.rows[1]?.id);
  });

  it("re-points current_system_version_id back to a matching existing version instead of duplicating it", async () => {
    if (!db.available) return;
    const assetKey = "test.reverted_prompt";
    const v1Content = { schema_version: "prompt_asset.v1", prompt_type: "text", template: "v1 text" };
    const v2Content = { schema_version: "prompt_asset.v1", prompt_type: "text", template: "v2 text" };

    const v1Dir = await singleManifestCatalog(assetKey, v1Content);
    await syncBuiltinPrompts(db.pool, v1Dir);
    await rm(v1Dir, { recursive: true, force: true });
    tempCatalogRoot = undefined;

    const v2Dir = await singleManifestCatalog(assetKey, v2Content);
    await syncBuiltinPrompts(db.pool, v2Dir);
    await rm(v2Dir, { recursive: true, force: true });
    tempCatalogRoot = undefined;

    // Manifest content reverted to v1 (e.g. a bad edit got git-reverted).
    const v1AgainDir = await singleManifestCatalog(assetKey, v1Content);
    const third = await syncBuiltinPrompts(db.pool, v1AgainDir);
    expect(third.versionsCreated).toEqual([]); // no duplicate version for content that already has one

    const versions = await db.pool.query<{ id: string; content_json: { template: string } }>(
      `SELECT v.id, v.content_json FROM evolvable_asset_versions v
         JOIN evolvable_assets a ON a.id = v.asset_id WHERE a.asset_key = $1 ORDER BY v.version ASC`,
      [assetKey],
    );
    expect(versions.rows).toHaveLength(2); // still just v1 and v2 — no v3

    const asset = await db.pool.query<{ current_system_version_id: string }>(
      `SELECT current_system_version_id FROM evolvable_assets WHERE asset_key = $1`,
      [assetKey],
    );
    // the pointer must move back to v1's version id, not stay stuck on v2
    expect(asset.rows[0]?.current_system_version_id).toBe(versions.rows[0]?.id);
  });

  it("maintains system production deployment refs and rolls back to the previous built-in version", async () => {
    if (!db.available) return;
    const assetKey = "test.rollback_prompt";
    const v1Dir = await singleManifestCatalog(assetKey, {
      schema_version: "prompt_asset.v1",
      prompt_type: "text",
      template: "rollback v1",
    });
    await syncBuiltinPrompts(db.pool, v1Dir);
    await rm(v1Dir, { recursive: true, force: true });
    tempCatalogRoot = undefined;

    const v2Dir = await singleManifestCatalog(assetKey, {
      schema_version: "prompt_asset.v1",
      prompt_type: "text",
      template: "rollback v2",
    });
    await syncBuiltinPrompts(db.pool, v2Dir);

    const refsBefore = await db.pool.query<{ version_id: string; status: string }>(
      `SELECT d.version_id, d.status
         FROM prompt_deployment_refs d
         JOIN evolvable_assets a ON a.id = d.asset_id
        WHERE a.asset_key = $1 AND d.scope_type = 'system' AND d.label = 'production'
        ORDER BY d.status ASC, d.updated_at ASC`,
      [assetKey],
    );
    expect(refsBefore.rows.map((row) => row.status).sort()).toEqual(["active", "archived"]);
    const archivedVersionId = refsBefore.rows.find((row) => row.status === "archived")?.version_id;
    expect(archivedVersionId).toBeTruthy();

    const repo = new PromptRepository(db.pool);
    const rolledBack = await repo.rollbackDeployment(identity, assetKey, { scope_type: "system", label: "production" });
    expect(rolledBack).toMatchObject({ version_id: archivedVersionId, scope_type: "system", label: "production", status: "active" });

    const resolved = await resolvePrompt(db.pool, { spaceId: SPACE, userId: OWNER, assetKey });
    expect(resolved.resolution_trace[0]).toContain("production:system");
    expect(resolved.rendered_text).toBe("rollback v1");
  });
});

describe("resolvePrompt (real Postgres)", () => {
  it("resolves a synced built-in prompt and renders it with the supplied variables", async () => {
    if (!db.available) return;
    await syncBuiltinPrompts(db.pool, REAL_CATALOG_ROOT);

    const result = await resolvePrompt(db.pool, {
      spaceId: SPACE,
      userId: OWNER,
      assetKey: "retrieval.query_rewrite",
      variables: { query: "quantum computing" },
    });

    expect(result.validation_errors).toEqual([]);
    expect(result.resolution_trace[0]).toContain("production:system");
    expect(result.rendered_messages).not.toBeNull();
    const userMessage = result.rendered_messages?.find((m) => m.role === "user");
    expect(userMessage?.content).toContain("Query: quantum computing");
    expect(result.content_hash).toBeTruthy();
  });

  it("resolves structured built-in prompts through the central resolver", async () => {
    if (!db.available) return;
    await syncBuiltinPrompts(db.pool, REAL_CATALOG_ROOT);

    const synthesis = await resolvePrompt(db.pool, {
      spaceId: SPACE,
      userId: OWNER,
      projectId: PROJECT,
      assetKey: "project_research.synthesis",
      variables: {
        project_id: PROJECT,
        research_question: "test",
        research_scope: JSON.stringify({ sub_questions: [], in: [], out: [] }),
        report_depth: "full",
        critique_context: "none",
      },
    });
    expect(synthesis.validation_errors).toEqual([]);
    expect(synthesis.rendered_text).toContain("Research question: test");
    expect(synthesis.rendered_text).toContain('"status": "succeeded"');
    expect(synthesis.rendered_text).not.toContain('"status": "rejected"');
    expect(synthesis.content_hash).toBeTruthy();
  });

  it("reports a missing required variable as a validation error and leaves the placeholder unrendered", async () => {
    if (!db.available) return;
    await syncBuiltinPrompts(db.pool, REAL_CATALOG_ROOT);

    const result = await resolvePrompt(db.pool, { spaceId: SPACE, userId: OWNER, assetKey: "retrieval.query_rewrite", variables: {} });
    expect(result.validation_errors).toEqual(["Missing required variable 'query'"]);
    const userMessage = result.rendered_messages?.find((m) => m.role === "user");
    expect(userMessage?.content).toContain("{query}");
  });

  it("fails closed with 404 when the asset key is unknown", async () => {
    if (!db.available) return;
    await expect(resolvePrompt(db.pool, { spaceId: SPACE, userId: OWNER, assetKey: "does.not.exist" })).rejects.toMatchObject({
      statusCode: 404,
    });
  });

  it("ignores a same-key generic prompt_template row that is outside the prompt registry view", async () => {
    if (!db.available) return;
    await syncBuiltinPrompts(db.pool, REAL_CATALOG_ROOT);
    await evolvableRepo().createAsset(identity, {
      asset_type: "prompt_template",
      asset_key: "retrieval.query_rewrite",
      display_name: "Generic Shadow",
    });

    const repo = new PromptRepository(db.pool);
    const asset = await repo.getAsset(identity, "retrieval.query_rewrite");
    expect(asset).toMatchObject({ asset_key: "retrieval.query_rewrite", space_id: null, prompt_type: "retrieval_query" });

    const result = await resolvePrompt(db.pool, {
      spaceId: SPACE,
      userId: OWNER,
      assetKey: "retrieval.query_rewrite",
      variables: { query: "shadow test" },
    });
    expect(result.validation_errors).toEqual([]);
    expect(result.resolution_trace[0]).toContain("production:system");
    expect(result.rendered_messages?.find((m) => m.role === "user")?.content).toContain("shadow test");
  }, 15_000);

  it("rejects same-key prompt registry rows that would shadow a built-in prompt", async () => {
    if (!db.available) return;
    await syncBuiltinPrompts(db.pool, REAL_CATALOG_ROOT);

    await expect(
      evolvableRepo().createAsset(identity, {
        asset_type: "prompt_template",
        asset_key: "retrieval.query_rewrite",
        display_name: "Prompt Shadow",
        metadata_json: { prompt_type: "retrieval_query" },
      }),
    ).rejects.toMatchObject({ statusCode: 409 });
  });

  it("prefers the canonical built-in prompt asset over a same-key space prompt row", async () => {
    if (!db.available) return;
    await syncBuiltinPrompts(db.pool, REAL_CATALOG_ROOT);
    const now = new Date().toISOString();
    await db.pool.query(
      `INSERT INTO evolvable_assets (
         id, space_id, asset_type, asset_key, display_name, description, owner_scope_type, owner_scope_id,
         status, metadata_json, created_at, updated_at
       ) VALUES ($1, $2, 'prompt_template', 'retrieval.query_rewrite', 'Space Shadow', NULL,
         'space', NULL, 'active', '{"prompt_type":"retrieval_query"}'::jsonb, $3, $3)`,
      [randomUUID(), SPACE, now],
    );

    const repo = new PromptRepository(db.pool);
    const asset = await repo.getAsset(identity, "retrieval.query_rewrite");
    expect(asset).toMatchObject({ asset_key: "retrieval.query_rewrite", space_id: null, prompt_type: "retrieval_query" });
  });
});

describe("M1 facade surfaces what M2 sync wrote (real Postgres)", () => {
  it("lists and reads back a built-in prompt asset synced by syncBuiltinPrompts", async () => {
    if (!db.available) return;
    await syncBuiltinPrompts(db.pool, REAL_CATALOG_ROOT);

    const repo = new PromptRepository(db.pool);
    const list = await repo.listAssets(identity, { promptType: "retrieval_query" });
    expect(list.map((a) => a.asset_key)).toEqual(
      expect.arrayContaining([
        "retrieval.query_rewrite",
      ]),
    );

    const versions = await repo.listVersions(identity, "retrieval.query_rewrite");
    expect(versions).toHaveLength(1);
    expect(versions[0]).toMatchObject({ status: "approved", source: "built_in", scope_type: "system" });
  });
});
