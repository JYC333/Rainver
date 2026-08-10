import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { getTestPostgres, isTestPostgresUnavailableError, type TestPostgresDatabase } from "./support/sharedPostgres";
import { migrate } from "../src/db/migrator";
import { EvolvableAssetRepository } from "../src/modules/evolution/assetRepository";
import { PromptRepository } from "../src/modules/prompts/repository";
import type { SpaceUserIdentity } from "../src/modules/routeUtils/common";

// Real-Postgres coverage for the prompts facade (server/src/modules/prompts):
// it must only surface 'prompt_template' evolvable assets that carry a
// metadata_json.prompt_type marker (generic evolution-asset callers can
// create 'prompt_template' rows with unrelated content shapes), and it must
// project asset/version fields into the prompt-specific shape. The
// underlying scope/pin resolution matrix is already covered by
// evolvableAssetDb.test.ts and is not re-tested here.

const MIGRATIONS_DIR = join(process.cwd(), "migrations");
const SPACE = "31111111-1111-4111-8111-111111111111";
const OWNER = "3aaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OUTSIDER = "3bbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const OTHER_SPACE = "32222222-2222-4222-8222-222222222222";

let container: TestPostgresDatabase | undefined;
let pool: Pool | undefined;
let available = false;

beforeAll(async () => {
  try {
    container = await getTestPostgres(__filename);
    pool = new Pool({ connectionString: container.getConnectionUri(), max: 3 });
    await migrate(pool, MIGRATIONS_DIR);
    available = true;
  } catch (err) {
    if (!isTestPostgresUnavailableError(err)) throw err;
    console.warn(`[prompt-registry-db] skipped — Docker/Postgres unavailable: ${err instanceof Error ? err.message : String(err)}`);
  }
}, 180_000);

afterAll(async () => {
  await pool?.end();
  await container?.stop();
});

beforeEach(async () => {
  if (!available || !pool) return;
  await pool.query(
    `TRUNCATE evolvable_asset_pins, evolvable_asset_versions, evolvable_assets, space_memberships, users, spaces CASCADE`,
  );
  const now = new Date().toISOString();
  await pool.query(
    `INSERT INTO spaces (id, name, type, created_at, updated_at) VALUES ($1,'Main','personal',$3,$3), ($2,'Other','personal',$3,$3)`,
    [SPACE, OTHER_SPACE, now],
  );
  await pool.query(
    `INSERT INTO users (id, display_name, status, created_at, updated_at)
     VALUES ($1,$1,'active',$3,$3), ($2,$2,'active',$3,$3)`,
    [OWNER, OUTSIDER, now],
  );
  await pool.query(
    `INSERT INTO space_memberships (id, space_id, user_id, role, status, created_at, updated_at)
     VALUES ($1,$2,$3,'owner','active',$5,$5), ($4,$2,$6,'member','active',$5,$5)`,
    [randomUUID(), SPACE, OWNER, randomUUID(), now, OUTSIDER],
  );
});

function repo(): PromptRepository {
  return new PromptRepository(pool!);
}

function evolvableRepo(): EvolvableAssetRepository {
  return new EvolvableAssetRepository(pool!);
}

const identity: SpaceUserIdentity = { spaceId: SPACE, userId: OWNER };

async function createPromptAsset(
  assetKey: string,
  promptType: string,
  overrides: Record<string, unknown> = {},
): Promise<Record<string, unknown>> {
  return evolvableRepo().createAsset(identity, {
    asset_type: "prompt_template",
    asset_key: assetKey,
    display_name: assetKey,
    metadata_json: { prompt_type: promptType },
    ...overrides,
  });
}

async function approvedVersion(assetId: string, content: Record<string, unknown>): Promise<string> {
  const version = await evolvableRepo().createVersion(identity, assetId, { scope_type: "space", content_json: content });
  await evolvableRepo().transitionVersionStatus(identity, assetId, version.id as string, { status: "candidate" });
  await evolvableRepo().transitionVersionStatus(identity, assetId, version.id as string, { status: "testing" });
  const now = new Date().toISOString();
  await pool!.query(`UPDATE evolvable_asset_versions SET status = 'approved', updated_at = $3 WHERE asset_id = $1 AND id = $2`, [
    assetId,
    version.id,
    now,
  ]);
  return version.id as string;
}

describe("Prompt registry facade (real Postgres)", () => {
  it("hides generic evolvable_assets rows that have no prompt_type marker", async () => {
    if (!available) return;
    await evolvableRepo().createAsset(identity, {
      asset_type: "prompt_template",
      asset_key: "academic.paper_screening_assistant",
      display_name: "Paper Screening Assistant",
    });

    const list = await repo().listAssets(identity, {});
    expect(list).toHaveLength(0);
    await expect(repo().getAsset(identity, "academic.paper_screening_assistant")).rejects.toMatchObject({ statusCode: 404 });
  });

  it("lists prompt-registry assets and filters by prompt_type", async () => {
    if (!available) return;
    await createPromptAsset("custom.text", "text");
    await createPromptAsset("retrieval.query_rewrite", "retrieval_query");

    const all = await repo().listAssets(identity, {});
    expect(all.map((a) => a.asset_key)).toEqual(
      expect.arrayContaining(["custom.text", "retrieval.query_rewrite"]),
    );

    const filtered = await repo().listAssets(identity, { promptType: "retrieval_query" });
    expect(filtered.map((a) => a.asset_key)).toEqual(["retrieval.query_rewrite"]);
  });

  it("rejects an invalid prompt_type filter", async () => {
    if (!available) return;
    await expect(repo().listAssets(identity, { promptType: "not_a_type" })).rejects.toMatchObject({ statusCode: 422 });
  });

  it("returns asset detail with metadata_json and projects version content", async () => {
    if (!available) return;
    const asset = await createPromptAsset("custom.general", "text");
    await approvedVersion(asset.id as string, {
      schema_version: "prompt_asset.v1",
      prompt_type: "text",
      template: "Hello {{name}}",
    });

    const detail = await repo().getAsset(identity, "custom.general");
    expect(detail).toMatchObject({ asset_key: "custom.general", prompt_type: "text" });
    expect(detail.metadata_json).toEqual({ prompt_type: "text" });

    const versions = await repo().listVersions(identity, "custom.general");
    expect(versions).toHaveLength(1);
    expect(versions[0]).toMatchObject({ status: "approved", source: "user_authored" });
    expect((versions[0].content as Record<string, unknown>).prompt_type).toBe("text");
  });

  it("rejects unknown asset keys and cross-space asset keys with 404", async () => {
    if (!available) return;
    await expect(repo().getAsset(identity, "does.not.exist")).rejects.toMatchObject({ statusCode: 404 });

    await createPromptAsset("custom.private", "text");
    const otherIdentity: SpaceUserIdentity = { spaceId: OTHER_SPACE, userId: OWNER };
    await expect(repo().getAsset(otherIdentity, "custom.private")).rejects.toMatchObject({ statusCode: 404 });
  });

  it("does not expose user-owned prompt assets to other users in the same space", async () => {
    if (!available) return;
    await createPromptAsset("private.owner_prompt", "text", { owner_scope_type: "user" });

    const outsiderIdentity: SpaceUserIdentity = { spaceId: SPACE, userId: OUTSIDER };
    await expect(repo().getAsset(outsiderIdentity, "private.owner_prompt")).rejects.toMatchObject({ statusCode: 404 });
    const outsiderList = await repo().listAssets(outsiderIdentity, {});
    expect(outsiderList.map((asset) => asset.asset_key)).not.toContain("private.owner_prompt");
  });
});
