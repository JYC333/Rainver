import { createHash } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/config.js";
import { getDbPool } from "../src/db/pool.js";
import { buildModuleServer } from "./support/moduleServer.js";
import { publicationsModule } from "../src/modules/publications/index.js";
import { __setAuthIdentityForTests } from "../src/modules/auth/identity.js";

vi.mock("../src/db/pool.js", () => ({
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
  return loadConfig({ SERVER_DATABASE_URL: "postgresql://server@db:5432/rainver" });
}

function publicationRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "publication-1",
    source_space_id: "space-1",
    source_resource_type: "artifact",
    source_resource_id: "artifact-1",
    version: 1,
    snapshot_schema_version: 1,
    snapshot_json: artifactSnapshot(),
    snapshot_hash: snapshotHash(artifactSnapshot()),
    published_by_user_id: "user-1",
    status: "active",
    created_at: "2026-07-10T10:00:00.000Z",
    updated_at: "2026-07-10T10:00:00.000Z",
    revoked_at: null,
    revoked_by_user_id: null,
    ...overrides,
  };
}

function artifactSnapshot() {
  return {
    schema_version: 1,
    resource_type: "artifact",
    title: "Report",
    payload: {
      artifact_type: "markdown",
      title: "Report",
      content: "# Report",
      mime_type: "text/markdown",
      exportable: true,
      export_formats_json: ["markdown"],
      canonical_format: "markdown",
      preview: false,
      relevant_period_start: null,
      relevant_period_end: null,
      trust_level: "high",
    },
  };
}

function snapshotHash(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value as Record<string, unknown>).sort().map((key) =>
      `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

describe("publication read routes; commands are covered by publicationOperationsDb", () => {
  it("does not disclose other publication targets to a receiving space", async () => {
    const query = vi.fn(async (sql: string) => {
      const normalized = sql.replace(/\s+/g, " ");
      if (normalized.includes("FROM content_publications cp")) {
        expect(normalized).toContain("ARRAY[$1]::varchar[] AS target_space_ids");
        expect(normalized).not.toContain("cpt_all");
        return {
          rows: [{
            ...publicationRow({ source_space_id: "source-space" }),
            target_space_ids: ["space-1"],
            import_id: null,
            imported_resource_type: null,
            imported_resource_id: null,
            imported_by_user_id: null,
            imported_at: null,
          }],
          rowCount: 1,
        };
      }
      throw new Error(`Unexpected query: ${normalized}`);
    });
    vi.mocked(getDbPool).mockReturnValue({ query } as never);
    app = buildModuleServer(config(), [publicationsModule]);

    const response = await app.inject({
      method: "GET",
      url: "/api/v1/publications?view=received",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().items[0].target_space_ids).toEqual(["space-1"]);
  });

  it("keeps a revoked publication in the received list when already imported", async () => {
    const query = vi.fn(async (sql: string) => {
      const normalized = sql.replace(/\s+/g, " ");
      if (normalized.includes("FROM content_publications cp")) {
        expect(normalized).toContain("cp.status = 'active' OR cpi.id IS NOT NULL");
        return {
          rows: [{
            ...publicationRow({
              source_space_id: "source-space",
              status: "revoked",
              revoked_at: "2026-07-10T12:00:00.000Z",
              revoked_by_user_id: "publisher-1",
            }),
            target_space_ids: ["space-1"],
            import_id: "import-1",
            imported_resource_type: "artifact",
            imported_resource_id: "artifact-copy",
            imported_by_user_id: "user-1",
            imported_at: "2026-07-10T11:00:00.000Z",
          }],
          rowCount: 1,
        };
      }
      throw new Error(`Unexpected query: ${normalized}`);
    });
    vi.mocked(getDbPool).mockReturnValue({ query } as never);
    app = buildModuleServer(config(), [publicationsModule]);

    const response = await app.inject({
      method: "GET",
      url: "/api/v1/publications?view=received",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().items[0]).toMatchObject({
      status: "revoked",
      title: "Report",
      snapshot: {
        schema_version: 1,
        resource_type: "artifact",
        title: "Report",
        payload: {},
      },
      import: { imported_resource_id: "artifact-copy" },
    });
    expect(response.json().items[0].snapshot.payload).not.toHaveProperty("content");
    // Withheld with the body it hashes: a hash of content this reader may no
    // longer see still answers "is this the text?" for every guess.
    expect(response.json().items[0].snapshot_hash).toBeNull();
  });

  it("does not name someone else's imported copy", async () => {
    const query = vi.fn(async (sql: string) => {
      const normalized = sql.replace(/\s+/g, " ");
      if (normalized.includes("FROM content_publications cp")) {
        return {
          rows: [{
            ...publicationRow({ source_space_id: "source-space", status: "active" }),
            target_space_ids: ["space-1"],
            import_id: "import-1",
            imported_resource_type: "artifact",
            imported_resource_id: "artifact-copy",
            // Imported by a colleague, not by the person asking.
            imported_by_user_id: "user-2",
            imported_at: "2026-07-10T11:00:00.000Z",
          }],
          rowCount: 1,
        };
      }
      throw new Error(`Unexpected query: ${normalized}`);
    });
    vi.mocked(getDbPool).mockReturnValue({ query } as never);
    app = buildModuleServer(config(), [publicationsModule]);

    const response = await app.inject({ method: "GET", url: "/api/v1/publications?view=received" });

    expect(response.statusCode).toBe(200);
    expect(response.json().items[0].import).toMatchObject({
      imported_by_user_id: "user-2",
      imported_resource_id: null,
    });
  });

  it("does not return a revoked snapshot body to a target-space member on GET", async () => {
    const query = vi.fn(async (sql: string) => {
      const normalized = sql.replace(/\s+/g, " ");
      if (normalized.includes("FROM content_publications cp")) {
        return {
          rows: [{
            ...publicationRow({
              source_space_id: "source-space",
              status: "revoked",
              revoked_at: "2026-07-10T12:00:00.000Z",
              revoked_by_user_id: "publisher-1",
            }),
            target_space_ids: ["space-1"],
            import_id: "import-1",
            imported_resource_type: "artifact",
            imported_resource_id: "artifact-copy",
            imported_by_user_id: "user-1",
            imported_at: "2026-07-10T11:00:00.000Z",
          }],
          rowCount: 1,
        };
      }
      throw new Error(`Unexpected query: ${normalized}`);
    });
    vi.mocked(getDbPool).mockReturnValue({ query } as never);
    app = buildModuleServer(config(), [publicationsModule]);

    const response = await app.inject({
      method: "GET",
      url: "/api/v1/publications/publication-1",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      status: "revoked",
      snapshot: { payload: {} },
    });
    expect(response.json().snapshot.payload).not.toHaveProperty("content");
  });

});
