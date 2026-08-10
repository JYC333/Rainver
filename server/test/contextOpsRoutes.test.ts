import { afterEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { getDbPool } from "../src/db/pool";
import { buildServer } from "../src/server";
import { loadConfig } from "../src/config";
import {
  __setAuthRepositoryForTests,
  type AuthRepository,
} from "../src/modules/auth";

const reviewCycleMock = vi.hoisted(() => vi.fn());

vi.mock("../src/db/pool", () => ({
  getDbPool: vi.fn(),
}));

vi.mock("../src/modules/contextOps/reviewCycle", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/modules/contextOps/reviewCycle")>();
  return {
    ...actual,
    runContextReviewCycle: reviewCycleMock,
  };
});

let app: FastifyInstance | undefined;

afterEach(async () => {
  __setAuthRepositoryForTests(null);
  vi.mocked(getDbPool).mockReset();
  reviewCycleMock.mockReset();
  await app?.close();
  app = undefined;
});

function config() {
  return loadConfig({
    SERVER_DATABASE_URL: "postgresql://server@db:5432/agent_space",
  });
}

function auth(role: "owner" | "admin" | "reviewer" | "member" | "guest" = "admin"): AuthRepository {
  return {
    async resolveIdentity() {
      return { ok: true, spaceId: "space-1", userId: "user-1" };
    },
    async getCurrentUser() {
      throw new Error("not used");
    },
    async getUserSpaces() {
      throw new Error("not used");
    },
    async getSpaceForUser() {
      return {
        id: "space-1",
        name: "Team",
        type: "team",
        role,
        oversight_mode: "none",
        egress_notifications_enabled: true,
        created_by_user_id: "owner-1",
        created_at: "2026-06-18T00:00:00.000Z",
        updated_at: "2026-06-18T00:00:00.000Z",
      };
    },
    async logout() {
      throw new Error("not used");
    },
    async findOrCreateFromGoogle() {
      throw new Error("not used");
    },
    async createSession() {
      throw new Error("not used");
    },
  };
}

class EmptyContextOpsDb {
  calls: Array<{ sql: string; params: readonly unknown[] }> = [];
  contextOpsReviewMode: "private_only" | "admins" | "members" = "private_only";
  contextOpsScanMode: "admins" | "members" = "admins";

  async connect(): Promise<{ query: EmptyContextOpsDb["query"]; release(): void }> {
    return {
      query: this.query.bind(this),
      release() {
        return;
      },
    };
  }

  async query<Row = Record<string, unknown>>(
    sql: string,
    params: readonly unknown[] = [],
  ): Promise<{ rows: Row[]; rowCount: number | null }> {
    this.calls.push({ sql, params });
    const norm = sql.replace(/\s+/g, " ").trim();
    if (/FROM settings/.test(norm)) {
      return {
        rows: [{
          settings_json: {
            default_search_mode: "hybrid",
            rerank_enabled: false,
            query_rewrite_enabled: false,
            query_rewrite_default: false,
            use_query_cache: true,
            include_trace: false,
            external_egress_enabled: true,
            retrieval_tool_mode: "off",
            context_ops_review_mode: this.contextOpsReviewMode,
            context_ops_scan_mode: this.contextOpsScanMode,
            embedding_dimensions: 2560,
            max_results_default: 50,
          },
          created_at: "2026-06-18T00:00:00.000Z",
          updated_at: "2026-06-18T00:00:00.000Z",
        }] as Row[],
        rowCount: 1,
      };
    }
    if (norm === "BEGIN" || norm === "COMMIT" || norm === "ROLLBACK") {
      return { rows: [], rowCount: 0 };
    }
    if (/FROM retrieval_objects ro/.test(norm) && /JOIN retrieval_chunks rc/.test(norm)) {
      return { rows: [] as Row[], rowCount: 0 };
    }
    if (/FROM retrieval_chunks/.test(norm) && !/GROUP BY object_type/.test(norm)) {
      return {
        rows: [{
          total_chunks: 0,
          embedded_chunks: 0,
          missing_embedding_chunks: 0,
          claimed_chunks: 0,
          attempted_chunks: 0,
        }] as Row[],
        rowCount: 1,
      };
    }
    if (/FROM source_connections/.test(norm)) {
      return {
        rows: [{
          active_source_connections: 0,
          missing_consent_version_count: 0,
          reader_restricted_source_count: 0,
          external_egress_disabled_source_count: 0,
          derived_writes_disabled_source_count: 0,
        }] as Row[],
        rowCount: 1,
      };
    }
    if (/FROM content_access_logs/.test(norm)) {
      return {
        rows: [{
          recent_access_count: 0,
          context_injection_count: 0,
          maintenance_scan_count: 0,
        }] as Row[],
        rowCount: 1,
      };
    }
    return { rows: [], rowCount: 0 };
  }
}

function reviewCycleResponse() {
  return {
    artifact_id: "artifact-review-cycle",
    review_scope: "private",
    retrieval_maintenance: {
      artifact_id: "artifact-maintenance",
      proposal_id: null,
      finding_count: 0,
      counts: {},
      scanned: 0,
      truncated: false,
    },
    diagnostics: {
      artifact_id: "artifact-diagnostics",
      proposal_id: null,
      diagnostic_codes: [],
      counts: {},
    },
    memory_maintenance: {
      artifact_id: null,
      proposal_id: null,
      finding_count: 0,
      counts: {},
      scanned: 0,
      truncated: false,
    },
    claim_candidates: {
      artifact_id: "artifact-claims",
      proposal_id: "proposal-claims",
      candidate_count: 0,
      generated_child_proposal_count: 0,
    },
    source_health: {
      active_source_connections: 0,
      missing_consent_version_count: 0,
      reader_restricted_source_count: 0,
      external_egress_disabled_source_count: 0,
      derived_writes_disabled_source_count: 0,
      warning_counts: {},
    },
    projection_freshness: {
      object_counts: {},
      stale_projection_count: 0,
      source_connected_object_count: 0,
      oldest_indexed_at: null,
      newest_indexed_at: null,
      newest_source_updated_at: null,
    },
    embedding_backlog: {
      total_chunks: 0,
      embedded_chunks: 0,
      missing_embedding_chunks: 0,
      claimed_chunks: 0,
      attempted_chunks: 0,
      missing_by_object_type: {},
    },
    canonical_write_performed: false,
  };
}

describe("Context Ops routes", () => {
  it("returns an aggregate summary for the authenticated space/user", async () => {
    __setAuthRepositoryForTests(auth());
    const db = new EmptyContextOpsDb();
    vi.mocked(getDbPool).mockReturnValue(db as never);
    app = buildServer(config(), { logger: false });

    const res = await app.inject({
      method: "GET",
      url: "/api/v1/context-ops/summary?window_days=30&limit=7",
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      space_id: "space-1",
      owner_user_id: "user-1",
      window_days: 30,
      embedding_backlog: {
        total_chunks: 0,
      },
      memory_provenance: {
        inspector_available: true,
      },
    });
    const artifactQuery = db.calls.find((call) => /FROM artifacts/.test(call.sql));
    expect(artifactQuery?.params).toEqual(expect.arrayContaining(["space-1", "user-1", 7]));
  });

  it("rejects invalid windows before querying the read model", async () => {
    __setAuthRepositoryForTests(auth());
    const db = new EmptyContextOpsDb();
    vi.mocked(getDbPool).mockReturnValue(db as never);
    app = buildServer(config(), { logger: false });

    const res = await app.inject({
      method: "GET",
      url: "/api/v1/context-ops/summary?window_days=0",
    });

    expect(res.statusCode).toBe(422);
    expect(res.json()).toEqual({ detail: "window_days must be between 1 and 90" });
    expect(db.calls).toHaveLength(0);
  });

  it("requires owner/admin or enabled member Context Ops access", async () => {
    __setAuthRepositoryForTests(auth("member"));
    const db = new EmptyContextOpsDb();
    vi.mocked(getDbPool).mockReturnValue(db as never);
    app = buildServer(config(), { logger: false });

    const res = await app.inject({
      method: "GET",
      url: "/api/v1/context-ops/summary",
    });

    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ detail: "Requires space owner/admin role or enabled Context Ops member review/scan access" });
    expect(db.calls).toHaveLength(1);
  });

  it("allows members when Context Ops member review is enabled", async () => {
    __setAuthRepositoryForTests(auth("member"));
    const db = new EmptyContextOpsDb();
    db.contextOpsReviewMode = "members";
    vi.mocked(getDbPool).mockReturnValue(db as never);
    app = buildServer(config(), { logger: false });

    const res = await app.inject({
      method: "GET",
      url: "/api/v1/context-ops/summary",
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      space_id: "space-1",
      owner_user_id: "user-1",
    });
    const sharedQueries = db.calls.filter((call) => call.sql.includes("$6::boolean"));
    expect(sharedQueries.length).toBeGreaterThanOrEqual(3);
    expect(sharedQueries.every((call) => call.params[5] === true)).toBe(true);
  });

  it("allows members with scan access without aggregating shared space_ops reports", async () => {
    __setAuthRepositoryForTests(auth("member"));
    const db = new EmptyContextOpsDb();
    db.contextOpsScanMode = "members";
    vi.mocked(getDbPool).mockReturnValue(db as never);
    app = buildServer(config(), { logger: false });

    const res = await app.inject({
      method: "GET",
      url: "/api/v1/context-ops/summary",
    });

    expect(res.statusCode).toBe(200);
    const sharedQueries = db.calls.filter((call) => call.sql.includes("$6::boolean"));
    expect(sharedQueries.length).toBeGreaterThanOrEqual(3);
    expect(sharedQueries.every((call) => call.params[5] === false)).toBe(true);
  });

  it("allows reviewers and rejects guests when Context Ops member review is enabled", async () => {
    __setAuthRepositoryForTests(auth("reviewer"));
    const reviewerDb = new EmptyContextOpsDb();
    reviewerDb.contextOpsReviewMode = "members";
    vi.mocked(getDbPool).mockReturnValue(reviewerDb as never);
    app = buildServer(config(), { logger: false });

    const reviewerRes = await app.inject({
      method: "GET",
      url: "/api/v1/context-ops/summary",
    });
    expect(reviewerRes.statusCode).toBe(200);
    await app.close();
    app = undefined;

    __setAuthRepositoryForTests(auth("guest"));
    const guestDb = new EmptyContextOpsDb();
    guestDb.contextOpsReviewMode = "members";
    vi.mocked(getDbPool).mockReturnValue(guestDb as never);
    app = buildServer(config(), { logger: false });

    const guestRes = await app.inject({
      method: "GET",
      url: "/api/v1/context-ops/summary",
    });
    expect(guestRes.statusCode).toBe(403);
  });

  it("serves a drill-down section for an authorized operator", async () => {
    __setAuthRepositoryForTests(auth("admin"));
    const db = new EmptyContextOpsDb();
    vi.mocked(getDbPool).mockReturnValue(db as never);
    app = buildServer(config(), { logger: false });

    const res = await app.inject({
      method: "GET",
      url: "/api/v1/context-ops/drilldown?section=index_freshness&limit=10",
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      space_id: "space-1",
      section: "index_freshness",
      limit: 10,
      objects: [],
      sources: [],
    });
  });

  it("serves the embedding backlog drill-down section for an authorized operator", async () => {
    __setAuthRepositoryForTests(auth("admin"));
    const db = new EmptyContextOpsDb();
    vi.mocked(getDbPool).mockReturnValue(db as never);
    app = buildServer(config(), { logger: false });

    const res = await app.inject({
      method: "GET",
      url: "/api/v1/context-ops/drilldown?section=embedding_backlog&limit=10",
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      space_id: "space-1",
      section: "embedding_backlog",
      limit: 10,
      objects: [],
      sources: [],
    });
  });

  it("runs Context Review Cycle for an authorized scanner", async () => {
    __setAuthRepositoryForTests(auth("admin"));
    const db = new EmptyContextOpsDb();
    reviewCycleMock.mockResolvedValue(reviewCycleResponse());
    vi.mocked(getDbPool).mockReturnValue(db as never);
    app = buildServer(config(), { logger: false });

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/context-ops/review-cycle/run",
      payload: { create_packets: true },
    });

    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({
      artifact_id: "artifact-review-cycle",
      canonical_write_performed: false,
      claim_candidates: {
        proposal_id: "proposal-claims",
      },
    });
    expect(reviewCycleMock).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      spaceId: "space-1",
      userId: "user-1",
      request: expect.objectContaining({
        create_packets: true,
        review_scope: "private",
      }),
    }));
  });

  it("blocks Context Review Cycle space_ops scope when review mode is private-only", async () => {
    __setAuthRepositoryForTests(auth("admin"));
    const db = new EmptyContextOpsDb();
    vi.mocked(getDbPool).mockReturnValue(db as never);
    app = buildServer(config(), { logger: false });

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/context-ops/review-cycle/run",
      payload: { review_scope: "space_ops" },
    });

    expect(res.statusCode).toBe(403);
    expect(reviewCycleMock).not.toHaveBeenCalled();
  });

  it("rejects an unknown drill-down section before querying", async () => {
    __setAuthRepositoryForTests(auth("admin"));
    const db = new EmptyContextOpsDb();
    vi.mocked(getDbPool).mockReturnValue(db as never);
    app = buildServer(config(), { logger: false });

    const res = await app.inject({
      method: "GET",
      url: "/api/v1/context-ops/drilldown?section=secret_dump",
    });

    expect(res.statusCode).toBe(422);
    expect(db.calls).toHaveLength(0);
  });

  it("denies drill-down to members without Context Ops access", async () => {
    __setAuthRepositoryForTests(auth("member"));
    const db = new EmptyContextOpsDb();
    vi.mocked(getDbPool).mockReturnValue(db as never);
    app = buildServer(config(), { logger: false });

    const res = await app.inject({
      method: "GET",
      url: "/api/v1/context-ops/drilldown?section=source_warnings",
    });

    expect(res.statusCode).toBe(403);
  });

  it("keeps admins mode restricted to owners and admins", async () => {
    __setAuthRepositoryForTests(auth("admin"));
    const adminDb = new EmptyContextOpsDb();
    adminDb.contextOpsReviewMode = "admins";
    vi.mocked(getDbPool).mockReturnValue(adminDb as never);
    app = buildServer(config(), { logger: false });

    const adminRes = await app.inject({
      method: "GET",
      url: "/api/v1/context-ops/summary",
    });
    expect(adminRes.statusCode).toBe(200);
    await app.close();
    app = undefined;

    __setAuthRepositoryForTests(auth("member"));
    const memberDb = new EmptyContextOpsDb();
    memberDb.contextOpsReviewMode = "admins";
    vi.mocked(getDbPool).mockReturnValue(memberDb as never);
    app = buildServer(config(), { logger: false });

    const memberRes = await app.inject({
      method: "GET",
      url: "/api/v1/context-ops/summary",
    });
    expect(memberRes.statusCode).toBe(403);
  });
});
