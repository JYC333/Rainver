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

function json(payload: Record<string, unknown>) {
  return {
    headers: { "content-type": "application/json" },
    payload: JSON.stringify(payload),
  };
}

function mockTransactionalPool(query: ReturnType<typeof vi.fn>) {
  return {
    query,
    connect: vi.fn(async () => ({ query, release: vi.fn() })),
  };
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

describe("publication routes", () => {
  it("publishes an owner-readable immutable snapshot to explicit member spaces", async () => {
    const query = vi.fn(async (sql: string) => {
      const normalized = sql.replace(/\s+/g, " ");
      if (normalized === "BEGIN" || normalized === "COMMIT") return { rows: [], rowCount: 0 };
      if (normalized.includes("AS effective_access_level")) {
        return { rows: [{ effective_access_level: "full" }], rowCount: 1 };
      }
      if (normalized.includes("SELECT 1 AS one")) return { rows: [{ one: 1 }], rowCount: 1 };
      if (normalized.includes("SELECT space_id FROM space_memberships")) {
        return { rows: [{ space_id: "space-2" }], rowCount: 1 };
      }
      if (normalized.includes("pg_advisory_xact_lock")) return { rows: [{}], rowCount: 1 };
      if (normalized.includes("FROM artifacts") && normalized.includes("FOR SHARE")) {
        return {
          rows: [{
            ...artifactSnapshot().payload,
            storage_ref: null,
            storage_path: null,
          }],
          rowCount: 1,
        };
      }
      if (normalized.includes("COALESCE(MAX(version)")) return { rows: [{ version: 1 }], rowCount: 1 };
      if (normalized.includes("INSERT INTO content_publications")) {
        return { rows: [publicationRow()], rowCount: 1 };
      }
      if (normalized.includes("INSERT INTO content_publication_targets")) return { rows: [], rowCount: 1 };
      throw new Error(`Unexpected query: ${normalized}`);
    });
    vi.mocked(getDbPool).mockReturnValue(mockTransactionalPool(query) as never);
    app = buildModuleServer(config(), [publicationsModule]);

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/publications",
      ...json({
        resource_type: "artifact",
        resource_id: "artifact-1",
        target_space_ids: ["space-2"],
      }),
    });

    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({
      id: "publication-1",
      target_space_ids: ["space-2"],
      snapshot: artifactSnapshot(),
    });
    expect(query.mock.calls.some(([sql]) => String(sql).includes("content_publication_targets"))).toBe(true);
  });

  it("fails closed when the publisher is not the source owner", async () => {
    const query = vi.fn(async (sql: string) => {
      const normalized = sql.replace(/\s+/g, " ");
      if (["BEGIN", "ROLLBACK"].includes(normalized)) return { rows: [], rowCount: 0 };
      if (normalized.includes("AS effective_access_level")) {
        return { rows: [{ effective_access_level: "full" }], rowCount: 1 };
      }
      if (normalized.includes("SELECT 1 AS one")) return { rows: [], rowCount: 0 };
      throw new Error(`Unexpected query: ${normalized}`);
    });
    vi.mocked(getDbPool).mockReturnValue(mockTransactionalPool(query) as never);
    app = buildModuleServer(config(), [publicationsModule]);

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/publications",
      ...json({
        resource_type: "artifact",
        resource_id: "artifact-1",
        target_space_ids: ["space-2"],
      }),
    });

    expect(response.statusCode).toBe(404);
    expect(query.mock.calls.some(([sql]) => String(sql).includes("INSERT INTO content_publications"))).toBe(false);
  });

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

  it("imports from the stored snapshot without reading the source resource", async () => {
    const snapshot = artifactSnapshot();
    const query = vi.fn(async (sql: string) => {
      const normalized = sql.replace(/\s+/g, " ");
      if (normalized === "BEGIN" || normalized === "COMMIT") return { rows: [], rowCount: 0 };
      if (normalized.includes("SELECT space_id FROM space_memberships")) {
        return { rows: [{ space_id: "space-1" }], rowCount: 1 };
      }
      if (normalized.includes("FROM content_publications cp") && normalized.includes("FOR UPDATE")) {
        return { rows: [publicationRow({ source_space_id: "source-space", snapshot_json: snapshot })], rowCount: 1 };
      }
      if (normalized.includes("FROM content_publication_imports")) return { rows: [], rowCount: 0 };
      if (normalized.includes("INSERT INTO artifacts")) return { rows: [], rowCount: 1 };
      if (normalized.includes("INSERT INTO content_publication_imports")) {
        return {
          rows: [{
            id: "import-1",
            publication_id: "publication-1",
            target_space_id: "space-1",
            publication_version: 1,
            snapshot_hash: snapshotHash(snapshot),
            imported_resource_type: "artifact",
            imported_resource_id: "artifact-copy",
            imported_by_user_id: "user-1",
            created_at: "2026-07-10T11:00:00.000Z",
          }],
          rowCount: 1,
        };
      }
      throw new Error(`Unexpected query: ${normalized}`);
    });
    vi.mocked(getDbPool).mockReturnValue(mockTransactionalPool(query) as never);
    app = buildModuleServer(config(), [publicationsModule]);

    const response = await app.inject({ method: "POST", url: "/api/v1/publications/publication-1/import" });

    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({
      imported_resource_type: "artifact",
      imported_resource_id: "artifact-copy",
      target_space_id: "space-1",
    });
    expect(query.mock.calls.some(([sql]) => String(sql).includes("FROM artifacts"))).toBe(false);
  });

  it("rejects a tampered snapshot before creating a target resource", async () => {
    const query = vi.fn(async (sql: string) => {
      const normalized = sql.replace(/\s+/g, " ");
      if (["BEGIN", "ROLLBACK"].includes(normalized)) return { rows: [], rowCount: 0 };
      if (normalized.includes("SELECT space_id FROM space_memberships")) {
        return { rows: [{ space_id: "space-1" }], rowCount: 1 };
      }
      if (normalized.includes("FROM content_publications cp") && normalized.includes("FOR UPDATE")) {
        return {
          rows: [publicationRow({ source_space_id: "source-space", snapshot_hash: "0".repeat(64) })],
          rowCount: 1,
        };
      }
      if (normalized.includes("FROM content_publication_imports")) return { rows: [], rowCount: 0 };
      throw new Error(`Unexpected query: ${normalized}`);
    });
    vi.mocked(getDbPool).mockReturnValue(mockTransactionalPool(query) as never);
    app = buildModuleServer(config(), [publicationsModule]);

    const response = await app.inject({ method: "POST", url: "/api/v1/publications/publication-1/import" });

    expect(response.statusCode).toBe(409);
    expect(response.json().detail).toContain("integrity");
    expect(query.mock.calls.some(([sql]) => String(sql).includes("INSERT INTO artifacts"))).toBe(false);
  });

  it("returns the existing import idempotently even after the publication was revoked", async () => {
    const snapshot = artifactSnapshot();
    const existingImport = {
      id: "import-1",
      publication_id: "publication-1",
      target_space_id: "space-1",
      publication_version: 1,
      snapshot_hash: snapshotHash(snapshot),
      imported_resource_type: "artifact",
      imported_resource_id: "artifact-copy",
      imported_by_user_id: "user-1",
      created_at: "2026-07-10T11:00:00.000Z",
    };
    const query = vi.fn(async (sql: string) => {
      const normalized = sql.replace(/\s+/g, " ");
      if (normalized === "BEGIN" || normalized === "COMMIT") return { rows: [], rowCount: 0 };
      if (normalized.includes("SELECT space_id FROM space_memberships")) {
        return { rows: [{ space_id: "space-1" }], rowCount: 1 };
      }
      if (normalized.includes("FROM content_publications cp") && normalized.includes("FOR UPDATE")) {
        return {
          rows: [publicationRow({
            source_space_id: "source-space",
            snapshot_json: snapshot,
            status: "revoked",
            revoked_at: "2026-07-10T12:00:00.000Z",
            revoked_by_user_id: "user-1",
          })],
          rowCount: 1,
        };
      }
      if (normalized.includes("FROM content_publication_imports")) return { rows: [existingImport], rowCount: 1 };
      throw new Error(`Unexpected query: ${normalized}`);
    });
    vi.mocked(getDbPool).mockReturnValue(mockTransactionalPool(query) as never);
    app = buildModuleServer(config(), [publicationsModule]);

    const response = await app.inject({ method: "POST", url: "/api/v1/publications/publication-1/import" });

    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({
      imported_resource_type: "artifact",
      imported_resource_id: "artifact-copy",
      target_space_id: "space-1",
    });
    expect(query.mock.calls.some(([sql]) => String(sql).includes("INSERT INTO artifacts"))).toBe(false);
  });

  it("rejects a fresh import once the publication has been revoked", async () => {
    const query = vi.fn(async (sql: string) => {
      const normalized = sql.replace(/\s+/g, " ");
      if (["BEGIN", "ROLLBACK"].includes(normalized)) return { rows: [], rowCount: 0 };
      if (normalized.includes("SELECT space_id FROM space_memberships")) {
        return { rows: [{ space_id: "space-1" }], rowCount: 1 };
      }
      if (normalized.includes("FROM content_publications cp") && normalized.includes("FOR UPDATE")) {
        return {
          rows: [publicationRow({
            source_space_id: "source-space",
            status: "revoked",
            revoked_at: "2026-07-10T12:00:00.000Z",
            revoked_by_user_id: "user-1",
          })],
          rowCount: 1,
        };
      }
      if (normalized.includes("FROM content_publication_imports")) return { rows: [], rowCount: 0 };
      throw new Error(`Unexpected query: ${normalized}`);
    });
    vi.mocked(getDbPool).mockReturnValue(mockTransactionalPool(query) as never);
    app = buildModuleServer(config(), [publicationsModule]);

    const response = await app.inject({ method: "POST", url: "/api/v1/publications/publication-1/import" });

    expect(response.statusCode).toBe(409);
    expect(response.json().detail).toContain("revoked");
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
      import: { imported_resource_id: "artifact-copy" },
    });
  });

  it("revokes future imports without deleting existing copies", async () => {
    const query = vi.fn(async (sql: string) => {
      const normalized = sql.replace(/\s+/g, " ");
      if (normalized === "BEGIN" || normalized === "COMMIT") return { rows: [], rowCount: 0 };
      if (normalized.includes("UPDATE content_publications")) {
        return {
          rows: [publicationRow({
            status: "revoked",
            revoked_at: "2026-07-10T12:00:00.000Z",
            revoked_by_user_id: "user-1",
          })],
          rowCount: 1,
        };
      }
      if (normalized.includes("SELECT target_space_id")) {
        return { rows: [{ target_space_id: "space-2" }], rowCount: 1 };
      }
      throw new Error(`Unexpected query: ${normalized}`);
    });
    vi.mocked(getDbPool).mockReturnValue(mockTransactionalPool(query) as never);
    app = buildModuleServer(config(), [publicationsModule]);

    const response = await app.inject({ method: "POST", url: "/api/v1/publications/publication-1/revoke" });

    expect(response.statusCode).toBe(200);
    expect(response.json().status).toBe("revoked");
    expect(query.mock.calls.some(([sql]) => /DELETE\s+FROM\s+content_publication_imports/i.test(String(sql)))).toBe(false);
  });
});
