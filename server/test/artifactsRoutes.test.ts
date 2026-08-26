import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildModuleServer } from "./support/moduleServer.js";
import { artifactsModule } from "../src/modules/artifacts/index.js";
import { loadConfig } from "../src/config.js";
import { __setArtifactIdentityForTests, __setArtifactRepositoryFactoryForTests } from "../src/modules/artifacts/routes.js";
import {
  ArtifactNotExportableError,
  PgArtifactRepository,
  type ArtifactOut,
  type ArtifactPage,
} from "../src/modules/artifacts/repository.js";

let app: FastifyInstance;

afterEach(async () => {
  __setArtifactIdentityForTests(null);
  __setArtifactRepositoryFactoryForTests(null);
  await app?.close();
});

function config() {
  return loadConfig({
    SERVER_DATABASE_URL: "postgresql://server@db:5432/rainver",
  });
}

function artifact(overrides: Partial<ArtifactOut> = {}): ArtifactOut {
  return {
    id: "artifact-1",
    space_id: "space-1",
    run_id: "run-1",
    proposal_id: null,
    artifact_type: "summary",
    surface_role: "user_output",
    title: "Summary",
    mime_type: "text/plain",
    exportable: true,
    preview: false,
    storage_ref: null,
    storage_path: null,
    metadata_json: null,
    has_inline_content: true,
    visibility: "space_shared",
    access_level: "full",
    owner_user_id: null,
    content: null,
    created_at: "2026-06-16T10:00:00.000Z",
    updated_at: "2026-06-16T10:00:00.000Z",
    project_id: null,
    project_folder_id: null,
    ...overrides,
  };
}

describe("artifact routes", () => {
  it("lists and reads artifacts with public response shapes", async () => {
    __setArtifactIdentityForTests({ spaceId: "space-1", userId: "user-1" });
    const calls: Array<{ kind: "list" | "get"; projectFolderId: string | null | undefined; includeSystemArchives?: boolean }> = [];
    __setArtifactRepositoryFactoryForTests(() => ({
      async listVisible(spaceId, userId, filters) {
        calls.push({ kind: "list", projectFolderId: filters.projectFolderId, includeSystemArchives: filters.includeSystemArchives });
        return {
          items: [
            artifact({
              id: `${spaceId}:${userId}:${filters.artifactType ?? "all"}`,
            }),
          ],
          total: 1,
          limit: filters.limit,
          offset: filters.offset,
        } satisfies ArtifactPage;
      },
      async getVisible(_spaceId, _userId, artifactId, includeContent, projectFolderId) {
        calls.push({ kind: "get", projectFolderId });
        return artifact({ id: artifactId, content: includeContent ? "inline" : null });
      },
      async exportVisible() {
        throw new Error("export should not run");
      },
    }));
    app = buildModuleServer(config(), [artifactsModule]);

    const list = await app.inject({
      method: "GET",
      url: "/api/v1/artifacts?limit=25&offset=5&artifact_type=summary&project_folder_id=ws-1",
    });
    const get = await app.inject({ method: "GET", url: "/api/v1/artifacts/artifact-1?project_folder_id=ws-1" });

    expect(list.statusCode).toBe(200);
    expect(list.json()).toMatchObject({
      items: [{ id: "space-1:user-1:summary" }],
      total: 1,
      limit: 25,
      offset: 5,
    });
    expect(get.statusCode).toBe(200);
    expect(get.json()).toMatchObject({ id: "artifact-1", content: "inline" });
    expect(calls).toEqual([
      { kind: "list", projectFolderId: "ws-1", includeSystemArchives: false },
      { kind: "get", projectFolderId: "ws-1" },
    ]);
  });

  it("excludes system archives from ordinary lists and allows an explicit audit list", async () => {
    const calls: string[] = [];
    const fakeDb = {
      async query(sql: string) {
        calls.push(sql);
        if (sql.includes("count(a.id)")) return { rows: [{ total: "0" }], rowCount: 1 };
        return { rows: [], rowCount: 0 };
      },
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const repo = new PgArtifactRepository(fakeDb as any, { artifactStorageRoot: "/tmp/artifacts", sandboxRoot: "/tmp/artifacts/sandbox" });
    await repo.listVisible("space-1", "user-1", { limit: 10, offset: 0 });
    expect(calls.every(sql => sql.includes("a.surface_role <> 'system_archive'"))).toBe(true);
    calls.length = 0;
    await repo.listVisible("space-1", "user-1", { limit: 10, offset: 0, includeSystemArchives: true });
    expect(calls.every(sql => !sql.includes("a.surface_role <> 'system_archive'"))).toBe(true);
  });

  it("exports inline artifact content with an attachment disposition", async () => {
    __setArtifactIdentityForTests({ spaceId: "space-1", userId: "user-1" });
    const calls: Array<{ projectFolderId: string | null | undefined }> = [];
    __setArtifactRepositoryFactoryForTests(() => ({
      async listVisible() {
        throw new Error("list should not run");
      },
      async getVisible() {
        throw new Error("get should not run");
      },
      async exportVisible(_spaceId, _userId, artifactId, projectFolderId) {
        calls.push({ projectFolderId });
        return {
          artifact: artifact({ id: artifactId, content: "download" }),
          filename: "Summary",
          mediaType: "text/plain",
          body: Buffer.from("download", "utf8"),
        };
      },
    }));
    app = buildModuleServer(config(), [artifactsModule]);

    const res = await app.inject({
      method: "GET",
      url: "/api/v1/artifacts/artifact-1/export?project_folder_id=ws-1",
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers["content-disposition"]).toBe('attachment; filename="Summary"');
    expect(res.payload).toBe("download");
    expect(calls).toEqual([{ projectFolderId: "ws-1" }]);
  });

  it("uses canonical access for workspace-scoped shared artifacts", async () => {
    const calls: Array<{ sql: string; params: readonly unknown[] }> = [];
    const row = artifact({
      id: "workspace-artifact",
      visibility: "space_shared",
      owner_user_id: "other-user",
      project_folder_id: "ws-1",
    });
    const fakeDb = {
      async query(sql: string, params: readonly unknown[] = []) {
        calls.push({ sql, params });
        return { rows: [row], rowCount: 1 };
      },
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const repo = new PgArtifactRepository(fakeDb as any, {
      artifactStorageRoot: "/tmp/artifacts",
      sandboxRoot: "/tmp/artifacts/sandbox",
    });

    await expect(repo.getVisible("space-1", "user-1", "workspace-artifact", false)).resolves.toMatchObject({
      id: "workspace-artifact",
      visibility: "space_shared",
      project_folder_id: "ws-1",
    });
    // The read is followed by a cross-person audit write (ADR 0013 decision 18),
    // so assert on the SELECT that gated the read rather than on call order.
    const readCall = calls.find((call) => call.sql.includes("FROM artifacts"));
    expect(readCall?.sql).toContain("visibility = 'space_shared'");
    expect(readCall?.sql).toContain("content_access_grants");
    expect(readCall?.sql).toContain("project_folders");
    expect(readCall?.sql).toContain("project_members");
    expect(calls.some((call) => call.sql.includes("INSERT INTO content_access_logs"))).toBe(true);
  });

  it("rejects path traversal, absolute paths, null bytes, and sandbox paths in file-backed export", async () => {
    const baseRow = {
      id: "art-1",
      space_id: "space-1",
      run_id: null,
      proposal_id: null,
      artifact_type: "file",
      surface_role: "user_output",
      title: "Export Me",
      content: null,
      storage_ref: null,
      storage_path: "TBD",
      mime_type: "application/octet-stream",
      exportable: true,
      preview: false,
      metadata_json: null,
      visibility: "space_shared",
      owner_user_id: null,
      created_at: new Date("2026-06-16"),
      updated_at: new Date("2026-06-16"),
      project_id: null,
    };
    const config = {
      artifactStorageRoot: "/tmp/artifacts",
      sandboxRoot: "/tmp/artifacts/sandbox",
    };
    const badPaths = [
      "../../etc/passwd",        // path traversal
      "/absolute/path/file.txt", // absolute path
      "sub\0null",               // null byte
      "sandbox/secret.txt",      // resolves inside sandboxRoot
    ];
    for (const storagePath of badPaths) {
      const fakeDb = {
        query: async () => ({ rows: [{ ...baseRow, storage_path: storagePath }], rowCount: 1 }),
      };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const repo = new PgArtifactRepository(fakeDb as any, config);
      await expect(
        repo.exportVisible("space-1", "user-1", "art-1"),
      ).rejects.toBeInstanceOf(ArtifactNotExportableError);
    }
  });
});
