import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { loadConfig } from "../src/config";
import { getDbPool } from "../src/db/pool";
import { buildServer } from "../src/server";
import { __setAuthIdentityForTests } from "../src/modules/auth";

vi.mock("../src/db/pool", () => ({
  getDbPool: vi.fn(),
}));

let app: FastifyInstance | undefined;

beforeEach(() => {
  vi.clearAllMocks();
  __setAuthIdentityForTests({ spaceId: "space-1", userId: "user-1" });
});

afterEach(async () => {
  __setAuthIdentityForTests(null);
  await app?.close();
  app = undefined;
});

function config() {
  return loadConfig({
    SERVER_DATABASE_URL: "postgresql://server@db:5432/agent_space",
  });
}

interface ProfileRow {
  id: string;
  space_id: string;
  scope_type: "space" | "project" | "project_folder" | "agent" | "user";
  scope_id: string | null;
  status: "active" | "archived";
  version: number;
  context_pack_json: Record<string, unknown>;
  routing_manifest_json: Record<string, unknown>;
  created_by_user_id: string | null;
  created_at: string;
  updated_at: string;
}

class ContextProfileDb {
  readonly profiles: ProfileRow[] = [];
  readonly calls: string[] = [];

  async query<Row = Record<string, unknown>>(
    sql: string,
    params: readonly unknown[] = [],
  ): Promise<{ rows: Row[]; rowCount: number | null }> {
    const norm = sql.replace(/\s+/g, " ").trim();
    this.calls.push(norm);

    if (/FROM project_folders/.test(norm)) {
      const [projectFolderId, spaceId] = params;
      const found = projectFolderId === "workspace-1" && spaceId === "space-1";
      return { rows: (found ? [{ id: "workspace-1" }] : []) as Row[], rowCount: found ? 1 : 0 };
    }

    if (/UPDATE context_profiles SET status = 'archived'/.test(norm)) {
      const [spaceId, scopeType, scopeId] = params;
      const current = this.profiles.find(profile =>
        profile.space_id === spaceId &&
        profile.scope_type === scopeType &&
        (profile.scope_id ?? "") === String(scopeId ?? "") &&
        profile.status === "active");
      if (!current) return { rows: [], rowCount: 0 };
      current.status = "archived";
      current.updated_at = String(params[3]);
      return { rows: [current] as Row[], rowCount: 1 };
    }

    if (/UPDATE context_profiles SET version =/.test(norm)) {
      const [spaceId, scopeType, scopeId, version, contextPack, routingManifest, updatedAt] = params;
      const current = this.profiles.find(profile =>
        profile.space_id === spaceId &&
        profile.scope_type === scopeType &&
        (profile.scope_id ?? "") === String(scopeId ?? "") &&
        profile.status === "active");
      if (!current) return { rows: [], rowCount: 0 };
      current.version = Number(version);
      current.context_pack_json = JSON.parse(String(contextPack)) as Record<string, unknown>;
      current.routing_manifest_json = JSON.parse(String(routingManifest)) as Record<string, unknown>;
      current.updated_at = String(updatedAt);
      return { rows: [current] as Row[], rowCount: 1 };
    }

    if (/INSERT INTO context_profiles/.test(norm)) {
      const [id, spaceId, scopeType, scopeId, version, contextPack, routingManifest, userId, now] = params;
      const row: ProfileRow = {
        id: String(id),
        space_id: String(spaceId),
        scope_type: scopeType as ProfileRow["scope_type"],
        scope_id: scopeId === null ? null : String(scopeId),
        status: "active",
        version: Number(version),
        context_pack_json: JSON.parse(String(contextPack)) as Record<string, unknown>,
        routing_manifest_json: JSON.parse(String(routingManifest)) as Record<string, unknown>,
        created_by_user_id: String(userId),
        created_at: String(now),
        updated_at: String(now),
      };
      this.profiles.push(row);
      return { rows: [row] as Row[], rowCount: 1 };
    }

    if (/FROM context_profiles/.test(norm)) {
      const spaceId = String(params[0]);
      const rows = this.profiles.filter(profile => profile.space_id === spaceId && profile.status === "active");
      return { rows: rows as Row[], rowCount: rows.length };
    }

    return { rows: [] as Row[], rowCount: 0 };
  }
}

describe("context profile routes", () => {
  it("creates workspace routing profiles and returns effective docs", async () => {
    const db = new ContextProfileDb();
    vi.mocked(getDbPool).mockReturnValue(db as never);
    app = buildServer(config(), { logger: false });

    const put = await app.inject({
      method: "PUT",
      url: "/api/v1/context/project-folders/workspace-1/routing",
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({
        context_pack_json: {
          title: "Workspace pack",
          observation_policy: "manual",
          skill_index_enabled: true,
        },
        routing_manifest_json: {
          version: 1,
          default_agent_doc_paths: [".agent/custom.md"],
          rules: [
            {
              id: "custom-context",
              path_glob: "server/src/modules/context/**",
              agent_doc_paths: [".agent/modules/context-compiler.md"],
              priority: 1,
            },
          ],
        },
      }),
    });

    expect(put.statusCode).toBe(200);
    expect(put.json()).toMatchObject({
      project_folder_id: "workspace-1",
      profiles: [
        {
          scope_type: "project_folder",
          scope_id: "workspace-1",
          context_pack_json: { title: "Workspace pack" },
        },
      ],
    });
    expect(put.json().effective_manifest.default_agent_doc_paths).toContain(".agent/custom.md");
    expect(put.json().selected_agent_doc_paths).toContain(".agent/custom.md");

    const list = await app.inject({
      method: "GET",
      url: "/api/v1/context/profiles?scope_type=project_folder&scope_id=workspace-1",
    });
    expect(list.statusCode).toBe(200);
    expect(list.json().items).toHaveLength(1);
  });

  it("enforces workspace ownership for profile routing", async () => {
    __setAuthIdentityForTests({ spaceId: "space-2", userId: "user-1" });
    const db = new ContextProfileDb();
    vi.mocked(getDbPool).mockReturnValue(db as never);
    app = buildServer(config(), { logger: false });

    const res = await app.inject({
      method: "GET",
      url: "/api/v1/context/project-folders/workspace-1/routing",
    });

    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ detail: "project_folder not found" });
  });

  it("rejects non-object context profile JSON with 422", async () => {
    const db = new ContextProfileDb();
    vi.mocked(getDbPool).mockReturnValue(db as never);
    app = buildServer(config(), { logger: false });

    const res = await app.inject({
      method: "PUT",
      url: "/api/v1/context/profiles",
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({
        scope_type: "space",
        context_pack_json: [],
        routing_manifest_json: { version: 1, rules: [], default_agent_doc_paths: [] },
      }),
    });

    expect(res.statusCode).toBe(422);
    expect(db.calls).toHaveLength(0);
  });

  it("rejects unsafe routing manifest doc paths before persistence", async () => {
    const db = new ContextProfileDb();
    vi.mocked(getDbPool).mockReturnValue(db as never);
    app = buildServer(config(), { logger: false });

    const res = await app.inject({
      method: "PUT",
      url: "/api/v1/context/project-folders/workspace-1/routing",
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({
        context_pack_json: {},
        routing_manifest_json: {
          version: 1,
          default_agent_doc_paths: ["../secret.md"],
          rules: [],
        },
      }),
    });

    expect(res.statusCode).toBe(422);
    expect(res.json().detail).toContain("routing_manifest_json contains invalid");
    expect(db.profiles).toHaveLength(0);
  });
});
