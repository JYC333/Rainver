import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildModuleServer } from "./support/moduleServer.js";
import { capabilitiesModule } from "../src/modules/capabilities/index.js";
import { loadConfig } from "../src/config.js";
import type { SpaceUserIdentity } from "../src/modules/routeUtils/common.js";
import { __setCapabilitiesIdentityForTests, __setCapabilitiesRepositoryFactoryForTests, __setCapabilitiesSkillFetcherForTests } from "../src/modules/capabilities/routes.js";

let app: FastifyInstance | undefined;

afterEach(async () => {
  __setCapabilitiesIdentityForTests(null);
  __setCapabilitiesRepositoryFactoryForTests(null);
  __setCapabilitiesSkillFetcherForTests(null);
  await app?.close();
  app = undefined;
});

function config() {
  return loadConfig({
    SERVER_DATABASE_URL: "postgresql://server@db:5432/rainver",
  });
}

describe("skill local overlays", () => {
  it("stores local overlay config without changing the imported skill snapshot", async () => {
    __setCapabilitiesIdentityForTests({ spaceId: "space-1", userId: "user-1" });
    const repo = fakeOverlayRepository();
    __setCapabilitiesRepositoryFactoryForTests(() => repo);
    app = buildModuleServer(config(), [capabilitiesModule]);

    const before = await app.inject({
      method: "GET",
      url: "/api/v1/capabilities/skills/index",
    });
    expect(before.statusCode).toBe(200);
    expect(before.json().items[0]).toMatchObject({
      effective_name: "Public Skill",
      overlay: null,
      skill_package: {
        normalized_json: {
          name: "Public Skill",
        },
      },
    });

    const saved = await app.inject({
      method: "PUT",
      url: "/api/v1/capabilities/skills/pkg-1/local-overlay",
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({
        scope_type: "space",
        overlay_json: {
          alias: "pub",
          display_name: "Team Public Skill",
          endpoint_defaults: { base_url: "https://skill.internal" },
          credential_ref: "credential_profile:skill-runtime",
          default_scope: "project_folder",
          runtime_preference: "codex_cli",
        },
      }),
    });
    expect(saved.statusCode).toBe(200);
    expect(saved.json()).toMatchObject({
      skill_package_id: "pkg-1",
      overlay_json: {
        alias: "pub",
        display_name: "Team Public Skill",
        credential_ref: "credential_profile:skill-runtime",
      },
    });

    const after = await app.inject({
      method: "GET",
      url: "/api/v1/capabilities/skills/index",
    });
    expect(after.statusCode).toBe(200);
    const item = after.json().items[0];
    expect(item).toMatchObject({
      effective_name: "Team Public Skill",
      effective_alias: "pub",
      skill_package: {
        normalized_json: {
          name: "Public Skill",
          requested_permissions: ["network"],
        },
      },
    });
    expect(item.skill_package.normalized_json).not.toHaveProperty("alias");
    expect(JSON.stringify(item)).not.toContain("sk-live-secret");
  });

  it("rejects embedded credential secrets in overlay defaults", async () => {
    __setCapabilitiesIdentityForTests({ spaceId: "space-1", userId: "user-1" });
    const repo = fakeOverlayRepository();
    __setCapabilitiesRepositoryFactoryForTests(() => repo);
    app = buildModuleServer(config(), [capabilitiesModule]);

    const res = await app.inject({
      method: "PUT",
      url: "/api/v1/capabilities/skills/pkg-1/local-overlay",
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({
        scope_type: "space",
        overlay_json: {
          endpoint_defaults: {
            api_key: "sk-live-secret",
          },
        },
      }),
    });

    expect(res.statusCode).toBe(422);
    expect(res.json()).toEqual({
      detail: "skill overlay must reference credentials instead of embedding secrets",
    });
  });
});

function fakeOverlayRepository() {
  let overlay: Record<string, unknown> | null = null;
  const skillPackage = {
    id: "pkg-1",
    source_id: "source-1",
    package_name: "public-skill",
    version: "1.0.0",
    license: null,
    raw_storage_ref: null,
    manifest_json: { package_hash: "hash-1" },
    normalized_json: {
      name: "Public Skill",
      description: "Imported source material.",
      version: "1.0.0",
      requested_permissions: ["network"],
    },
    risk_level: "low",
    status: "reviewed",
    created_at: "2026-06-20T00:00:00.000Z",
    updated_at: "2026-06-20T00:00:00.000Z",
  };

  return {
    async listConvertedCapabilityDefinitions() {
      return [];
    },
    async listSkillLibraryIndex() {
      const overlayJson = (overlay?.overlay_json ?? {}) as Record<string, unknown>;
      return {
        items: [
          {
            skill_package: skillPackage,
            overlay,
            effective_name: typeof overlayJson.display_name === "string" ? overlayJson.display_name : "Public Skill",
            effective_alias: typeof overlayJson.alias === "string" ? overlayJson.alias : null,
            requested_permissions: ["network"],
          },
        ],
      };
    },
    async getSkillLocalOverlay() {
      return overlay;
    },
    async upsertSkillLocalOverlay(
      identity: SpaceUserIdentity,
      skillPackageId: string,
      body: {
        scope_type: string;
        scope_id?: string | null;
        overlay_json?: Record<string, unknown>;
      },
    ) {
      overlay = {
        id: "overlay-1",
        space_id: identity.spaceId,
        skill_package_id: skillPackageId,
        scope_type: body.scope_type,
        scope_id: body.scope_id ?? null,
        overlay_json: {
          endpoint_defaults: {},
          user_preferences: {},
          ...(body.overlay_json ?? {}),
        },
        status: "active",
        created_by_user_id: identity.userId,
        created_at: "2026-06-20T00:00:00.000Z",
        updated_at: "2026-06-20T00:00:00.000Z",
      };
      return overlay;
    },
  } as never;
}
