import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { getTestPostgres, isTestPostgresUnavailableError, type TestPostgresDatabase } from "./support/sharedPostgres";
import { migrate } from "../src/db/migrator";
import { EvolvableAssetRepository } from "../src/modules/evolution/assetRepository";
import { resolveEvolvableAssetVersion } from "../src/modules/evolution/assetResolutionService";
import type { SpaceUserIdentity } from "../src/modules/routeUtils/common";

// Real-Postgres coverage for generic prompt/workflow template evolution:
// asset/version/pin CRUD, immutability
// after candidate/testing begins, stale-parent detection, and the scoped
// runtime resolution fallback chain (explicit -> project pin -> agent pin ->
// user pin (gated) -> space pin -> space approved -> system baseline).

const MIGRATIONS_DIR = join(process.cwd(), "migrations");
const SPACE = "11111111-1111-4111-8111-111111111111";
const OWNER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const PROJECT = "55555555-5555-4555-8555-555555555555";
const PROJECT_B = "77777777-7777-4777-8777-777777777777";
const AGENT = "66666666-6666-4666-8666-666666666666";
const OUTSIDER = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const OTHER_SPACE = "22222222-2222-4222-8222-222222222222";

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
    console.warn(`[evolvable-asset-db] skipped — Docker/Postgres unavailable: ${err instanceof Error ? err.message : String(err)}`);
  }
}, 180_000);

afterAll(async () => {
  await pool?.end();
  await container?.stop();
});

beforeEach(async () => {
  if (!available || !pool) return;
  await pool.query(
    `TRUNCATE evolvable_asset_pins, evolvable_asset_versions, evolvable_assets, agents, projects,
       space_memberships, users, spaces CASCADE`,
  );
  const now = new Date().toISOString();
  await pool.query(`INSERT INTO spaces (id, name, type, created_at, updated_at) VALUES ($1,'Main','personal',$2,$2)`, [SPACE, now]);
  await pool.query(`INSERT INTO users (id, display_name, status, created_at, updated_at) VALUES ($1,$1,'active',$2,$2)`, [OWNER, now]);
  await pool.query(
    `INSERT INTO space_memberships (id, space_id, user_id, role, status, created_at, updated_at)
     VALUES ($1,$2,$3,'owner','active',$4,$4)`,
    [randomUUID(), SPACE, OWNER, now],
  );
  await pool.query(
    `INSERT INTO projects (id, space_id, owner_user_id, name, status, created_at, updated_at)
     VALUES ($1,$2,$3,'Research','active',$4,$4), ($5,$2,$3,'Second','active',$4,$4)`,
    [PROJECT, SPACE, OWNER, now, PROJECT_B],
  );
  await pool.query(
    `INSERT INTO agents (id, space_id, owner_user_id, name, status, created_at, updated_at, visibility)
     VALUES ($1,$2,$3,'Screening Agent','active',$4,$4,'space_shared')`,
    [AGENT, SPACE, OWNER, now],
  );
  await pool.query(`INSERT INTO users (id, display_name, status, created_at, updated_at) VALUES ($1,$1,'active',$2,$2)`, [OUTSIDER, now]);
  await pool.query(
    `INSERT INTO space_memberships (id, space_id, user_id, role, status, created_at, updated_at)
     VALUES ($1,$2,$3,'member','active',$4,$4)`,
    [randomUUID(), SPACE, OUTSIDER, now],
  );
});

function repo(): EvolvableAssetRepository {
  return new EvolvableAssetRepository(pool!);
}

const identity: SpaceUserIdentity = { spaceId: SPACE, userId: OWNER };

async function createAsset(
  assetKey = "academic.paper_screening_assistant",
  overrides: Record<string, unknown> = {},
): Promise<Record<string, unknown>> {
  return repo().createAsset(identity, {
    asset_type: "prompt_template",
    asset_key: assetKey,
    display_name: "Paper Screening Assistant",
    ...overrides,
  });
}

function defaultScopeId(scopeType: string): string | undefined {
  if (scopeType === "space") return SPACE;
  if (scopeType === "project") return PROJECT;
  if (scopeType === "user") return OWNER;
  if (scopeType === "agent") return AGENT;
  return undefined;
}

/** Creates a version and walks it through candidate -> testing, then manually approves it because this suite does not exercise promotion proposals. */
async function createApprovedVersion(
  assetId: string,
  scopeType: string,
  content: Record<string, unknown>,
  scopeId = defaultScopeId(scopeType),
): Promise<string> {
  const version = await repo().createVersion(identity, assetId, { scope_type: scopeType, scope_id: scopeId, content_json: content });
  await repo().transitionVersionStatus(identity, assetId, version.id as string, { status: "candidate" });
  await repo().transitionVersionStatus(identity, assetId, version.id as string, { status: "testing" });
  const now = new Date().toISOString();
  await pool!.query(`UPDATE evolvable_asset_versions SET status = 'approved', updated_at = $3 WHERE asset_id = $1 AND id = $2`, [
    assetId,
    version.id,
    now,
  ]);
  return version.id as string;
}

async function createSystemAsset(assetKey: string): Promise<string> {
  const id = randomUUID();
  const now = new Date().toISOString();
  await pool!.query(
    `INSERT INTO evolvable_assets (
       id, space_id, asset_type, asset_key, display_name, description, owner_scope_type, owner_scope_id,
       status, metadata_json, created_at, updated_at
     ) VALUES ($1, NULL, 'prompt_template', $2, $2, NULL, 'system', NULL, 'active', '{}'::jsonb, $3, $3)`,
    [id, assetKey, now],
  );
  return id;
}

async function insertApprovedVersion(
  assetId: string,
  version: number,
  spaceId: string | null,
  scopeType: string,
  scopeId: string | null,
  content: Record<string, unknown>,
): Promise<string> {
  const id = randomUUID();
  const now = new Date().toISOString();
  await pool!.query(
    `INSERT INTO evolvable_asset_versions (
       id, asset_id, space_id, scope_type, scope_id, version, status, source,
       content_json, created_at, updated_at
     ) VALUES ($1, $2, $3, $4, $5, $6, 'approved', 'built_in', $7::jsonb, $8, $8)`,
    [id, assetId, spaceId, scopeType, scopeId, version, JSON.stringify(content), now],
  );
  return id;
}

describe("Evolvable asset/version/pin (real Postgres)", () => {
  it("rejects capability rows because CapabilityVersion is the canonical model", async () => {
    if (!available) return;
    await expect(repo().createAsset(identity, {
      asset_type: "capability",
      asset_key: "research.search",
      display_name: "Research search",
    })).rejects.toMatchObject({ statusCode: 422 });
  });

  it("rejects a duplicate asset_key in the same space", async () => {
    if (!available) return;
    await createAsset();
    await expect(createAsset()).rejects.toMatchObject({ statusCode: 409 });
  });

  it("requires space owner/admin for public assets but allows member-owned private assets", async () => {
    if (!available) return;
    const outsiderIdentity: SpaceUserIdentity = { spaceId: SPACE, userId: OUTSIDER };

    await expect(
      repo().createAsset(outsiderIdentity, {
        asset_type: "prompt_template",
        asset_key: "public.member_denied",
        display_name: "Member Denied",
      }),
    ).rejects.toMatchObject({ statusCode: 403 });

    const privateAsset = await repo().createAsset(outsiderIdentity, {
      asset_type: "prompt_template",
      asset_key: "private.member_prompt",
      display_name: "Member Private Prompt",
      owner_scope_type: "user",
    });
    expect(privateAsset).toMatchObject({ owner_scope_type: "user", owner_scope_id: OUTSIDER });

    await expect(repo().getAsset(identity, privateAsset.id as string)).rejects.toMatchObject({ statusCode: 404 });
    await expect(repo().getAsset(outsiderIdentity, privateAsset.id as string)).resolves.toMatchObject({
      id: privateAsset.id,
      owner_scope_id: OUTSIDER,
    });
    const ownerAssetIds = (await repo().listAssets(identity, { assetType: "prompt_template" })).map((asset) => asset.id);
    expect(ownerAssetIds).not.toContain(privateAsset.id);
  });

  it("only lets the owner evolve a user-owned private asset", async () => {
    if (!available) return;
    const outsiderIdentity: SpaceUserIdentity = { spaceId: SPACE, userId: OUTSIDER };
    const privateAsset = await repo().createAsset(outsiderIdentity, {
      asset_type: "prompt_template",
      asset_key: "private.owner_only",
      display_name: "Owner Only",
      owner_scope_type: "user",
    });
    const draft = await repo().createVersion(outsiderIdentity, privateAsset.id as string, {
      scope_type: "user",
      scope_id: OUTSIDER,
      content_json: { system_prompt: "private" },
    });

    await expect(
      repo().updateVersionContent(identity, privateAsset.id as string, draft.id as string, {
        content_json: { system_prompt: "stolen" },
      }),
    ).rejects.toMatchObject({ statusCode: 404 });
    await expect(
      repo().transitionVersionStatus(identity, privateAsset.id as string, draft.id as string, { status: "candidate" }),
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  it("allows editing a draft version but rejects edits once it is a candidate", async () => {
    if (!available) return;
    const asset = await createAsset();
    const version = await repo().createVersion(identity, asset.id as string, {
      scope_type: "space",
      content_json: { system_prompt: "v1" },
    });
    const updated = await repo().updateVersionContent(identity, asset.id as string, version.id as string, {
      content_json: { system_prompt: "v1-edited" },
    });
    expect(updated.content_json).toEqual({ system_prompt: "v1-edited" });

    await repo().transitionVersionStatus(identity, asset.id as string, version.id as string, { status: "candidate" });
    await expect(
      repo().updateVersionContent(identity, asset.id as string, version.id as string, { content_json: { system_prompt: "v2" } }),
    ).rejects.toMatchObject({ statusCode: 422 });
  });

  it("enforces scope authority and normalizes space scope when creating versions", async () => {
    if (!available) return;
    const asset = await createAsset();
    const outsiderIdentity: SpaceUserIdentity = { spaceId: SPACE, userId: OUTSIDER };

    await expect(
      repo().createVersion(outsiderIdentity, asset.id as string, { scope_type: "space", content_json: {} }),
    ).rejects.toMatchObject({ statusCode: 403 });
    await expect(
      repo().createVersion(identity, asset.id as string, { scope_type: "project", content_json: {} }),
    ).rejects.toMatchObject({ statusCode: 422 });
    await expect(
      repo().createVersion(outsiderIdentity, asset.id as string, { scope_type: "project", scope_id: PROJECT, content_json: {} }),
    ).rejects.toMatchObject({ statusCode: 403 });
    await expect(
      repo().createVersion(identity, asset.id as string, { scope_type: "user", scope_id: OUTSIDER, content_json: {} }),
    ).rejects.toMatchObject({ statusCode: 403 });
    await expect(
      repo().createVersion(outsiderIdentity, asset.id as string, { scope_type: "agent", scope_id: AGENT, content_json: {} }),
    ).rejects.toMatchObject({ statusCode: 403 });

    const version = await repo().createVersion(identity, asset.id as string, { scope_type: "space", content_json: {} });
    expect(version).toMatchObject({ scope_type: "space", scope_id: SPACE });
  });

  it("only lists scoped versions visible to the caller", async () => {
    if (!available) return;
    const asset = await createAsset("academic.visible_scopes", { metadata_json: { allow_user_override: true } });
    const spaceVersion = await repo().createVersion(identity, asset.id as string, { scope_type: "space", content_json: { prompt: "space" } });
    const projectVersion = await repo().createVersion(identity, asset.id as string, {
      scope_type: "project",
      scope_id: PROJECT,
      content_json: { prompt: "project" },
    });
    const userVersion = await repo().createVersion(identity, asset.id as string, {
      scope_type: "user",
      scope_id: OWNER,
      content_json: { prompt: "user" },
    });
    const agentVersion = await repo().createVersion(identity, asset.id as string, {
      scope_type: "agent",
      scope_id: AGENT,
      content_json: { prompt: "agent" },
    });

    const ownerVersions = await repo().listVersions(identity, asset.id as string);
    expect(ownerVersions.map((version) => version.id)).toEqual(expect.arrayContaining([
      spaceVersion.id,
      projectVersion.id,
      userVersion.id,
      agentVersion.id,
    ]));

    const outsiderIdentity: SpaceUserIdentity = { spaceId: SPACE, userId: OUTSIDER };
    const outsiderVersionIds = (await repo().listVersions(outsiderIdentity, asset.id as string)).map((version) => version.id);
    expect(outsiderVersionIds).toContain(spaceVersion.id);
    expect(outsiderVersionIds).not.toEqual(expect.arrayContaining([
      projectVersion.id,
      userVersion.id,
      agentVersion.id,
    ]));
  });

  it("rejects transitioning a version directly to approved or deprecated", async () => {
    if (!available) return;
    const asset = await createAsset();
    const version = await repo().createVersion(identity, asset.id as string, { scope_type: "space", content_json: {} });
    await expect(
      repo().transitionVersionStatus(identity, asset.id as string, version.id as string, { status: "approved" }),
    ).rejects.toMatchObject({ statusCode: 422 });
  });

  it("allows two candidates to share a parent without merging (no automatic conflict)", async () => {
    if (!available) return;
    const asset = await createAsset();
    const parentId = await createApprovedVersion(asset.id as string, "space", { system_prompt: "base" });
    const childA = await repo().createVersion(identity, asset.id as string, {
      scope_type: "space",
      parent_version_id: parentId,
      content_json: { system_prompt: "variant A" },
    });
    const childB = await repo().createVersion(identity, asset.id as string, {
      scope_type: "space",
      parent_version_id: parentId,
      content_json: { system_prompt: "variant B" },
    });
    expect(childA.id).not.toBe(childB.id);
    expect(childA.parent_version_id).toBe(parentId);
    expect(childB.parent_version_id).toBe(parentId);
  });

  it("marks a candidate stale once another version becomes the current approved version for its scope", async () => {
    if (!available) return;
    const asset = await createAsset();
    const parentId = await createApprovedVersion(asset.id as string, "space", { system_prompt: "base" });
    const stale = await repo().createVersion(identity, asset.id as string, {
      scope_type: "space",
      parent_version_id: parentId,
      content_json: { system_prompt: "stale variant" },
    });
    await repo().transitionVersionStatus(identity, asset.id as string, stale.id as string, { status: "candidate" });

    // A different version becomes the new approved version for scope 'space'.
    await createApprovedVersion(asset.id as string, "space", { system_prompt: "newer base" });

    const versions = await repo().listVersions(identity, asset.id as string);
    const staleRow = versions.find((v) => v.id === stale.id);
    expect(staleRow?.stale_parent).toBe(true);
  });

  it("only allows pinning an approved version", async () => {
    if (!available) return;
    const asset = await createAsset();
    const draft = await repo().createVersion(identity, asset.id as string, { scope_type: "project", scope_id: PROJECT, content_json: {} });
    await expect(
      repo().setPin(identity, asset.id as string, "project", PROJECT, { version_id: draft.id }),
    ).rejects.toMatchObject({ statusCode: 422 });
  });

  it("archives the previous active pin when a new pin is set for the same scope", async () => {
    if (!available) return;
    const asset = await createAsset();
    const v1 = await createApprovedVersion(asset.id as string, "project", { system_prompt: "v1" });
    const v2 = await createApprovedVersion(asset.id as string, "project", { system_prompt: "v2" });
    await repo().setPin(identity, asset.id as string, "project", PROJECT, { version_id: v1 });
    await repo().setPin(identity, asset.id as string, "project", PROJECT, { version_id: v2 });

    const pins = await repo().listPins(identity, asset.id as string);
    expect(pins).toHaveLength(1);
    expect(pins[0]).toMatchObject({ version_id: v2, status: "active" });
  });

  it("pinning one project does not archive a different project's active pin on the same asset", async () => {
    if (!available) return;
    const asset = await createAsset();
    const vA = await createApprovedVersion(asset.id as string, "project", { system_prompt: "for project A" });
    const vB = await createApprovedVersion(asset.id as string, "project", { system_prompt: "for project B" }, PROJECT_B);
    await repo().setPin(identity, asset.id as string, "project", PROJECT, { version_id: vA });
    await repo().setPin(identity, asset.id as string, "project", PROJECT_B, { version_id: vB });

    const pins = await repo().listPins(identity, asset.id as string);
    expect(pins).toHaveLength(2);
    expect(pins.find((p) => p.scope_id === PROJECT)).toMatchObject({ version_id: vA, status: "active" });
    expect(pins.find((p) => p.scope_id === PROJECT_B)).toMatchObject({ version_id: vB, status: "active" });
  });

  it("rejects setting a project pin without project writer authority, a space pin without space owner/admin, and user/agent pins without ownership", async () => {
    if (!available) return;
    const asset = await createAsset();
    const version = await createApprovedVersion(asset.id as string, "project", { system_prompt: "v1" });
    const outsiderIdentity: SpaceUserIdentity = { spaceId: SPACE, userId: OUTSIDER };

    await expect(
      repo().setPin(outsiderIdentity, asset.id as string, "project", PROJECT, { version_id: version }),
    ).rejects.toMatchObject({ statusCode: 403 });
    await expect(
      repo().setPin(outsiderIdentity, asset.id as string, "space", SPACE, { version_id: version }),
    ).rejects.toMatchObject({ statusCode: 403 });
    await expect(
      repo().setPin(identity, asset.id as string, "space", PROJECT, { version_id: version }),
    ).rejects.toMatchObject({ statusCode: 422 });
    await expect(
      repo().setPin(identity, asset.id as string, "user", OUTSIDER, { version_id: version }),
    ).rejects.toMatchObject({ statusCode: 403 });
    await expect(
      repo().setPin(outsiderIdentity, asset.id as string, "agent", AGENT, { version_id: version }),
    ).rejects.toMatchObject({ statusCode: 403 });
  });

  it("rejects user-scoped versions and pins on public assets unless user override is enabled", async () => {
    if (!available) return;
    const asset = await createAsset("public.no_user_override");
    await expect(
      repo().createVersion(identity, asset.id as string, {
        scope_type: "user",
        scope_id: OWNER,
        content_json: { system_prompt: "personal" },
      }),
    ).rejects.toMatchObject({ statusCode: 403 });

    const overridable = await createAsset("public.allow_user_override", { metadata_json: { allow_user_override: true } });
    const userVersion = await createApprovedVersion(overridable.id as string, "user", { system_prompt: "personal" });
    await expect(repo().setPin(identity, overridable.id as string, "user", OWNER, { version_id: userVersion })).resolves.toMatchObject({
      scope_type: "user",
      scope_id: OWNER,
      version_id: userVersion,
    });

    const outsiderIdentity: SpaceUserIdentity = { spaceId: SPACE, userId: OUTSIDER };
    await expect(repo().listPins(outsiderIdentity, overridable.id as string)).resolves.toHaveLength(0);
  });

  it("resolves project pin over space-approved version, and space-approved over system baseline", async () => {
    if (!available) return;
    const asset = await createAsset();
    // A system baseline also exists, to prove space-approved is preferred over it.
    await createApprovedVersion(asset.id as string, "system", { system_prompt: "system baseline" });
    const spaceVersion = await createApprovedVersion(asset.id as string, "space", { system_prompt: "space approved" });
    const projectVersion = await createApprovedVersion(asset.id as string, "project", { system_prompt: "project pinned" });

    const systemOnlyResult = await resolveEvolvableAssetVersion(pool!, {
      spaceId: SPACE,
      assetKey: asset.asset_key as string,
    });
    expect(systemOnlyResult.versionId).toBe(spaceVersion);
    expect(systemOnlyResult.resolutionTrace[0]).toContain("space_approved");

    await repo().setPin(identity, asset.id as string, "project", PROJECT, { version_id: projectVersion });
    const projectResult = await resolveEvolvableAssetVersion(pool!, {
      spaceId: SPACE,
      assetKey: asset.asset_key as string,
      projectId: PROJECT,
    });
    expect(projectResult.versionId).toBe(projectVersion);
    expect(projectResult.resolutionTrace[0]).toContain("project_pin");
  });

  it("falls back to the system baseline when there is no pin or space-approved version, and records a fallback reason", async () => {
    if (!available) return;
    const asset = await createAsset();
    const systemVersion = await createApprovedVersion(asset.id as string, "system", { system_prompt: "system baseline" });

    const result = await resolveEvolvableAssetVersion(pool!, { spaceId: SPACE, assetKey: asset.asset_key as string });
    expect(result.versionId).toBe(systemVersion);
    expect(result.fallbackReason).toBeTruthy();
  });

  it("does not expose another space's versions on a shared system asset", async () => {
    if (!available) return;
    await pool!.query(`INSERT INTO spaces (id, name, type, created_at, updated_at) VALUES ($1,'Other','personal',now(),now())`, [
      OTHER_SPACE,
    ]);
    const assetKey = "shared.system.prompt";
    const assetId = await createSystemAsset(assetKey);
    const systemVersion = await insertApprovedVersion(assetId, 1, null, "system", null, {
      system_prompt: "system baseline",
    });
    await pool!.query(`UPDATE evolvable_assets SET current_system_version_id = $2 WHERE id = $1`, [assetId, systemVersion]);
    const otherSpaceVersion = await insertApprovedVersion(assetId, 2, OTHER_SPACE, "space", OTHER_SPACE, {
      system_prompt: "other space override",
    });

    const listed = await repo().listVersions(identity, assetId);
    expect(listed.map((version) => version.id)).toContain(systemVersion);
    expect(listed.map((version) => version.id)).not.toContain(otherSpaceVersion);

    const resolved = await resolveEvolvableAssetVersion(pool!, { spaceId: SPACE, assetKey });
    expect(resolved.versionId).toBe(systemVersion);
    expect(resolved.resolutionTrace[0]).toContain("system_baseline");

    await expect(
      resolveEvolvableAssetVersion(pool!, {
        spaceId: SPACE,
        assetKey,
        explicitVersionId: otherSpaceVersion,
      }),
    ).rejects.toMatchObject({ statusCode: 422 });

    await expect(
      repo().setPin(identity, assetId, "space", SPACE, { version_id: otherSpaceVersion }),
    ).rejects.toMatchObject({ statusCode: 422 });
  });

  it("uses a space pin before the latest space-approved version", async () => {
    if (!available) return;
    const asset = await createAsset();
    const pinnedVersion = await createApprovedVersion(asset.id as string, "space", { system_prompt: "pinned space default" });
    const latestSpaceVersion = await createApprovedVersion(asset.id as string, "space", { system_prompt: "latest space default" });

    const unpinned = await resolveEvolvableAssetVersion(pool!, { spaceId: SPACE, assetKey: asset.asset_key as string });
    expect(unpinned.versionId).toBe(latestSpaceVersion);

    await repo().setPin(identity, asset.id as string, "space", SPACE, { version_id: pinnedVersion });
    const pinned = await resolveEvolvableAssetVersion(pool!, { spaceId: SPACE, assetKey: asset.asset_key as string });
    expect(pinned.versionId).toBe(pinnedVersion);
    expect(pinned.resolutionTrace[0]).toContain("space_pin");
  });

  it("rejects explicit runtime resolution to a non-approved version", async () => {
    if (!available) return;
    const asset = await createAsset();
    await createApprovedVersion(asset.id as string, "system", { system_prompt: "system baseline" });
    const draft = await repo().createVersion(identity, asset.id as string, { scope_type: "space", content_json: { system_prompt: "draft" } });

    await expect(
      resolveEvolvableAssetVersion(pool!, {
        spaceId: SPACE,
        assetKey: asset.asset_key as string,
        explicitVersionId: draft.id as string,
      }),
    ).rejects.toMatchObject({ statusCode: 422 });
  });

  it("ignores a user pin unless allowUserPin is explicitly set", async () => {
    if (!available) return;
    const asset = await createAsset("academic.user_pin_resolution", { metadata_json: { allow_user_override: true } });
    const systemVersion = await createApprovedVersion(asset.id as string, "system", { system_prompt: "system baseline" });
    const userVersion = await createApprovedVersion(asset.id as string, "user", { system_prompt: "user personal" });
    await repo().setPin(identity, asset.id as string, "user", OWNER, { version_id: userVersion });

    const defaultResult = await resolveEvolvableAssetVersion(pool!, {
      spaceId: SPACE,
      assetKey: asset.asset_key as string,
      userId: OWNER,
    });
    expect(defaultResult.versionId).toBe(systemVersion);

    const allowedResult = await resolveEvolvableAssetVersion(pool!, {
      spaceId: SPACE,
      assetKey: asset.asset_key as string,
      userId: OWNER,
      allowUserPin: true,
    });
    expect(allowedResult.versionId).toBe(userVersion);
  });

  it("resolves an agent pin", async () => {
    if (!available) return;
    const asset = await createAsset();
    const agentVersion = await createApprovedVersion(asset.id as string, "agent", { system_prompt: "agent specific" });
    await repo().setPin(identity, asset.id as string, "agent", AGENT, { version_id: agentVersion });

    const result = await resolveEvolvableAssetVersion(pool!, {
      spaceId: SPACE,
      assetKey: asset.asset_key as string,
      agentId: AGENT,
    });
    expect(result.versionId).toBe(agentVersion);
  });

  it("rejects cross-space asset access", async () => {
    if (!available) return;
    const asset = await createAsset();
    await pool!.query(`INSERT INTO spaces (id, name, type, created_at, updated_at) VALUES ($1,'Other','personal',now(),now())`, [
      OTHER_SPACE,
    ]);
    const otherIdentity: SpaceUserIdentity = { spaceId: OTHER_SPACE, userId: OWNER };
    await expect(repo().getAsset(otherIdentity, asset.id as string)).rejects.toMatchObject({ statusCode: 404 });
  });
});
