import { afterEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { getDbPool } from "../src/db/pool";
import { buildServer } from "../src/server";
import { loadConfig } from "../src/config";
import {
  __setAuthIdentityForTests,
  __setAuthRepositoryForTests,
  type AuthRepository,
} from "../src/modules/auth";

vi.mock("../src/db/pool", () => ({
  getDbPool: vi.fn(),
}));

let app: FastifyInstance | undefined;

afterEach(async () => {
  __setAuthIdentityForTests(null);
  __setAuthRepositoryForTests(null);
  vi.mocked(getDbPool).mockReset();
  await app?.close();
  app = undefined;
});

function config() {
  return loadConfig({
    SERVER_DATABASE_URL: "postgresql://server@db:5432/agent_space",
  });
}

function scanPermissionDb(role = "member", scanMode: "admins" | "members" = "admins") {
  return {
    async query(sql: string) {
      if (/FROM settings/.test(sql)) {
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
              context_ops_review_mode: "private_only",
              context_ops_scan_mode: scanMode,
              embedding_dimensions: 2560,
              max_results_default: 50,
            },
            created_at: "2026-06-26T00:00:00.000Z",
            updated_at: "2026-06-26T00:00:00.000Z",
          }],
          rowCount: 1,
        };
      }
      if (/FROM space_memberships/.test(sql)) {
        return { rows: [{ role }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    },
  };
}

function proposalRow(params: readonly unknown[]) {
  return {
    id: params[0],
    space_id: params[1],
    created_by_user_id: params[14],
    project_folder_id: params[12],
    created_by_run_id: params[2],
    proposal_type: params[3],
    status: params[4],
    risk_level: params[5],
    urgency: params[6],
    preview: params[7],
    title: params[8],
    payload_json: JSON.parse(String(params[10] ?? "{}")),
    rationale: params[13],
    visibility: params[15],
    review_deadline: null,
    expires_at: null,
    created_at: "2026-06-26T00:00:00.000Z",
    reviewed_at: null,
    project_id: params[16],
    egress_approval_id: null,
    egress_approval_status: null,
  };
}

function authWithRole(role: string): AuthRepository {
  return {
    async resolveIdentity() {
      return { ok: true, spaceId: "space-1", userId: "user-1" };
    },
    async getSpaceForUser() {
      return {
        id: "space-1",
        name: "Team",
        type: "team",
        role,
        oversight_mode: "none",
        egress_notifications_enabled: true,
        member_count: 1,
        created_by_user_id: "user-1",
        created_at: "2026-06-18T00:00:00.000Z",
        updated_at: "2026-06-18T00:00:00.000Z",
      };
    },
    async getCurrentUser() {
      throw new Error("not used");
    },
    async getUserSpaces() {
      throw new Error("not used");
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

describe("Knowledge retrieval routes", () => {
  it("rejects search bodies that do not match the protocol contract", async () => {
    __setAuthIdentityForTests({ spaceId: "space-1", userId: "user-1" });
    app = buildServer(config(), { logger: false });

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/knowledge/search",
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({
        query: "alpha",
        object_types: ["not_a_type"],
      }),
    });

    expect(res.statusCode).toBe(422);
    expect(res.json().detail).toContain("object_types.0");
  });

  it("rejects an unknown search mode", async () => {
    __setAuthIdentityForTests({ spaceId: "space-1", userId: "user-1" });
    app = buildServer(config(), { logger: false });

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/knowledge/search",
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({ query: "alpha", mode: "turbo" }),
    });

    expect(res.statusCode).toBe(422);
    expect(res.json().detail).toContain("mode");
  });

  it("rejects a brief request with an empty query", async () => {
    __setAuthIdentityForTests({ spaceId: "space-1", userId: "user-1" });
    app = buildServer(config(), { logger: false });

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/knowledge/retrieval/brief",
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({ query: "" }),
    });

    expect(res.statusCode).toBe(422);
    expect(res.json().detail).toContain("query");
  });

  it("rejects an unknown brief search mode", async () => {
    __setAuthIdentityForTests({ spaceId: "space-1", userId: "user-1" });
    app = buildServer(config(), { logger: false });

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/knowledge/retrieval/brief",
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({ query: "alpha", mode: "turbo" }),
    });

    expect(res.statusCode).toBe(422);
    expect(res.json().detail).toContain("mode");
  });

  it("rejects create-safety max_results above the protocol limit", async () => {
    __setAuthIdentityForTests({ spaceId: "space-1", userId: "user-1" });
    app = buildServer(config(), { logger: false });

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/knowledge/create-safety",
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({
        object_type: "knowledge_item",
        title: "Alpha",
        max_results: 500,
      }),
    });

    expect(res.statusCode).toBe(422);
    expect(res.json().detail).toContain("max_results");
  });

  it("rejects negative retrieval feedback signals", async () => {
    __setAuthIdentityForTests({ spaceId: "space-1", userId: "user-1" });
    app = buildServer(config(), { logger: false });

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/knowledge/retrieval/feedback",
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({
        query: "alpha",
        object_type: "knowledge_item",
        object_id: "33333333-3333-4333-8333-333333333333",
        signal_type: "skipped",
      }),
    });

    expect(res.statusCode).toBe(422);
    expect(res.json().detail).toContain("signal_type");
  });

  it("requires owner or admin role for full-space retrieval reindex", async () => {
    __setAuthRepositoryForTests(authWithRole("member"));
    app = buildServer(config(), { logger: false });

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/knowledge/retrieval/reindex",
    });

    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ detail: "Requires space owner or admin role" });
  });

  it("requires owner/admin or enabled member scan access for the maintenance scan", async () => {
    __setAuthRepositoryForTests(authWithRole("member"));
    vi.mocked(getDbPool).mockReturnValue(scanPermissionDb("member", "admins") as never);
    app = buildServer(config(), { logger: false });

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/knowledge/retrieval/maintenance/scan",
    });

    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ detail: "Requires space owner/admin role or enabled Context Ops member scan access" });
  });

  it("creates claim candidate packets through the HTTP route", async () => {
    __setAuthRepositoryForTests(authWithRole("admin"));
    const sourceArtifactId = "11111111-1111-4111-8111-111111111111";
    const calls: Array<{ sql: string; params: readonly unknown[] }> = [];
    const client = {
      async query(sql: string, params: readonly unknown[] = []) {
        calls.push({ sql, params });
        const norm = sql.replace(/\s+/g, " ").trim();
        if (norm === "BEGIN" || norm === "COMMIT" || norm === "ROLLBACK") return { rows: [], rowCount: 0 };
        if (norm.startsWith("INSERT INTO proposals")) return { rows: [proposalRow(params)], rowCount: 1 };
        if (norm.startsWith("SELECT a.id, a.artifact_type, a.title, a.visibility, a.metadata_json FROM artifacts a")) {
          return {
            rows: [{
              id: sourceArtifactId,
              artifact_type: "retrieval_brief",
              title: "Context Brief",
              visibility: "private",
              metadata_json: {
                gap_analysis: {
                  uncited_claims: ["A route-level claim candidate."],
                },
              },
            }],
            rowCount: 1,
          };
        }
        return { rows: [], rowCount: 1 };
      },
      release() {},
    };
    vi.mocked(getDbPool).mockReturnValue({
      async connect() {
        return client;
      },
    } as never);
    app = buildServer(config(), { logger: false });

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/knowledge/claims/candidate-packets",
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({
        source_artifact_ids: [sourceArtifactId],
        max_candidates: 10,
        review_scope: "private",
      }),
    });

    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({
      artifact_id: expect.stringMatching(/[0-9a-f-]{36}/),
      proposal_id: expect.stringMatching(/[0-9a-f-]{36}/),
      candidate_count: 1,
      source_artifact_count: 1,
      generated_child_proposal_count: 0,
    });
    expect(calls.some((call) => call.sql === "BEGIN")).toBe(true);
    expect(calls.some((call) => /INSERT INTO artifacts/.test(call.sql))).toBe(true);
    expect(calls.some((call) => /INSERT INTO proposals/.test(call.sql))).toBe(true);
    expect(calls.some((call) => call.sql === "COMMIT")).toBe(true);
  });

  it("allows explicit private source promotion when creating a space_ops claim candidate packet", async () => {
    __setAuthRepositoryForTests(authWithRole("admin"));
    const sourceArtifactId = "11111111-1111-4111-8111-111111111111";
    const calls: Array<{ sql: string; params: readonly unknown[] }> = [];
    const client = {
      async query(sql: string, params: readonly unknown[] = []) {
        calls.push({ sql, params });
        const norm = sql.replace(/\s+/g, " ").trim();
        if (norm === "BEGIN" || norm === "COMMIT" || norm === "ROLLBACK") return { rows: [], rowCount: 0 };
        if (norm.startsWith("INSERT INTO proposals")) return { rows: [proposalRow(params)], rowCount: 1 };
        if (norm.startsWith("SELECT a.id, a.artifact_type, a.title, a.visibility, a.metadata_json FROM artifacts a")) {
          return {
            rows: [{
              id: sourceArtifactId,
              artifact_type: "retrieval_brief",
              title: "Context Brief",
              visibility: "private",
              metadata_json: {
                gap_analysis: {
                  uncited_claims: ["A promoted route-level claim candidate."],
                },
              },
            }],
            rowCount: 1,
          };
        }
        return { rows: [], rowCount: 1 };
      },
      release() {},
    };
    vi.mocked(getDbPool).mockReturnValue({
      async query(sql: string) {
        if (/FROM settings/.test(sql)) {
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
                context_ops_review_mode: "admins",
                context_ops_scan_mode: "admins",
                embedding_dimensions: 2560,
                max_results_default: 50,
              },
              created_at: "2026-06-26T00:00:00.000Z",
              updated_at: "2026-06-26T00:00:00.000Z",
            }],
            rowCount: 1,
          };
        }
        if (/FROM space_memberships/.test(sql)) return { rows: [{ role: "admin" }], rowCount: 1 };
        return { rows: [], rowCount: 0 };
      },
      async connect() {
        return client;
      },
    } as never);
    app = buildServer(config(), { logger: false });

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/knowledge/claims/candidate-packets",
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({
        source_artifact_ids: [sourceArtifactId],
        max_candidates: 10,
        review_scope: "space_ops",
        promote_private_sources_to_space_ops: true,
        private_source_promotion_confirmed: true,
      }),
    });

    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({
      artifact_id: expect.stringMatching(/[0-9a-f-]{36}/),
      proposal_id: expect.stringMatching(/[0-9a-f-]{36}/),
      candidate_count: 1,
      source_artifact_count: 1,
    });
    expect(calls.find((call) =>
      /SELECT a\.id, a\.artifact_type, a\.title, a\.visibility, a\.metadata_json/.test(call.sql))?.sql)
      .toContain("a.visibility IN ('space_shared', 'private')");
  });

  it("requires owner or admin role for retrieval eval report persistence", async () => {
    __setAuthRepositoryForTests(authWithRole("member"));
    app = buildServer(config(), { logger: false });

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/knowledge/retrieval/eval/report",
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({ suite: "golden", metrics: { recall: 1 } }),
    });

    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ detail: "Requires space owner or admin role" });
  });

  it("requires owner or admin role for retrieval explain", async () => {
    __setAuthRepositoryForTests(authWithRole("member"));
    app = buildServer(config(), { logger: false });

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/knowledge/retrieval/explain",
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({
        query: "alpha",
        object_type: "knowledge_item",
        object_id: "33333333-3333-4333-8333-333333333333",
      }),
    });

    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ detail: "Requires space owner or admin role" });
  });

  it("rejects non-Knowledge object types for retrieval explain", async () => {
    __setAuthRepositoryForTests(authWithRole("admin"));
    app = buildServer(config(), { logger: false });

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/knowledge/retrieval/explain",
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({
        query: "alpha",
        object_type: "memory_entry",
        object_id: "33333333-3333-4333-8333-333333333333",
      }),
    });

    expect(res.statusCode).toBe(422);
    expect(res.json().detail).toContain("knowledge retrieval explain only supports");
  });

  it("validates maintenance scan persistence flags before scanning", async () => {
    __setAuthRepositoryForTests(authWithRole("admin"));
    app = buildServer(config(), { logger: false });

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/knowledge/retrieval/maintenance/scan",
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({ persist_report: "yes" }),
    });

    expect(res.statusCode).toBe(422);
    expect(res.json().detail).toContain("persist_report");
  });

  const unsafeEvalReportPayloads = [
    [
      "top-level candidate_id",
      {
        suite: "golden",
        metrics: { recall: 1 },
        candidate_id: "secret-id",
      },
    ],
    [
      "top-level candidate_ids",
      {
        suite: "golden",
        metrics: { recall: 1 },
        candidate_ids: ["secret-id"],
      },
    ],
    [
      "top-level title",
      {
        suite: "golden",
        metrics: { recall: 1 },
        title: "Secret title",
      },
    ],
    [
      "top-level snippet",
      {
        suite: "golden",
        metrics: { recall: 1 },
        snippet: "Secret snippet",
      },
    ],
    [
      "top-level content",
      {
        suite: "golden",
        metrics: { recall: 1 },
        content: "Secret content",
      },
    ],
    [
      "case object_id",
      {
        suite: "golden",
        metrics: { recall: 1 },
        cases: [
          {
            case_label: "case-1",
            metrics: { recall: 0 },
            object_id: "secret-id",
          },
        ],
      },
    ],
    [
      "case title",
      {
        suite: "golden",
        metrics: { recall: 1 },
        cases: [
          {
            case_label: "case-1",
            metrics: { recall: 0 },
            title: "Secret title",
          },
        ],
      },
    ],
    [
      "case snippet",
      {
        suite: "golden",
        metrics: { recall: 1 },
        cases: [
          {
            case_label: "case-1",
            metrics: { recall: 0 },
            snippet: "Secret snippet",
          },
        ],
      },
    ],
    [
      "case content",
      {
        suite: "golden",
        metrics: { recall: 1 },
        cases: [
          {
            case_label: "case-1",
            metrics: { recall: 0 },
            content: "Secret content",
          },
        ],
      },
    ],
  ] as const;

  it.each(unsafeEvalReportPayloads)(
    "rejects eval reports that include %s",
    async (_label, payload) => {
      __setAuthRepositoryForTests(authWithRole("admin"));
      app = buildServer(config(), { logger: false });

      const res = await app.inject({
        method: "POST",
        url: "/api/v1/knowledge/retrieval/eval/report",
        headers: { "content-type": "application/json" },
        payload: JSON.stringify(payload),
      });

      expect(res.statusCode).toBe(422);
      expect(res.json().detail).toContain("Unrecognized key");
    },
  );
});
