import { afterEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { getDbPool } from "../src/db/pool.js";
import { buildModuleServer } from "./support/moduleServer.js";
import { knowledgeModule } from "../src/modules/knowledge/index.js";
import { loadConfig } from "../src/config.js";
import { useReviewPacketDatabase } from "./support/reviewPacketDatabase.js";
import { updateSpaceRetrievalSettings } from "../src/modules/retrieval/settings.js";
import { __setAuthIdentityForTests, __setAuthRepositoryForTests, type AuthRepository } from "../src/modules/auth/identity.js";

vi.mock("../src/db/pool.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../src/db/pool.js")>(),
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
    SERVER_DATABASE_URL: "postgresql://server@db:5432/rainver",
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
  };
}

describe("Knowledge retrieval routes", () => {
  it("rejects search bodies that do not match the protocol contract", async () => {
    __setAuthIdentityForTests({ spaceId: "space-1", userId: "user-1" });
    app = buildModuleServer(config(), [knowledgeModule]);

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
    app = buildModuleServer(config(), [knowledgeModule]);

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
    app = buildModuleServer(config(), [knowledgeModule]);

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
    app = buildModuleServer(config(), [knowledgeModule]);

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
    app = buildModuleServer(config(), [knowledgeModule]);

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
    app = buildModuleServer(config(), [knowledgeModule]);

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
    app = buildModuleServer(config(), [knowledgeModule]);

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
    app = buildModuleServer(config(), [knowledgeModule]);

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/knowledge/retrieval/maintenance/scan",
    });

    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ detail: "Requires space owner/admin role or enabled Context Ops member scan access" });
  });

  describe("persisted claim candidate packets", () => {
    const packetDatabase = useReviewPacketDatabase(import.meta.url);
    const sourceArtifactId = "11111111-1111-4111-8111-111111111111";
    const seedBrief = (claim: string) => packetDatabase.database.pool.query(
      `INSERT INTO artifacts(id,space_id,owner_user_id,artifact_type,title,visibility,metadata_json,export_formats_json,created_at,updated_at)
       VALUES($1,'space-1','user-1','retrieval_brief','Context Brief','private',$2::jsonb,'[]',now(),now())`,
      [sourceArtifactId, JSON.stringify({ gap_analysis: { uncited_claims: [claim] } })],
    );
    const packet = async (proposalId: string) => (await packetDatabase.database.pool.query(
      "SELECT proposal_type, status, visibility, payload_json FROM proposals WHERE id = $1 AND space_id = 'space-1'",
      [proposalId],
    )).rows[0];

    it("creates claim candidate packets through the HTTP route", async () => {
      __setAuthRepositoryForTests(authWithRole("admin"));
      const pool = packetDatabase.database.pool;
      await seedBrief("A route-level claim candidate.");
      vi.mocked(getDbPool).mockReturnValue(pool);
      app = buildModuleServer(config(), [knowledgeModule]);

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

      expect(res.statusCode, res.body).toBe(201);
      const body = res.json();
      expect(body).toMatchObject({
        artifact_id: expect.stringMatching(/[0-9a-f-]{36}/),
        proposal_id: expect.stringMatching(/[0-9a-f-]{36}/),
        candidate_count: 1,
        source_artifact_count: 1,
        generated_child_proposal_count: 0,
      });
      expect(await packet(body.proposal_id)).toMatchObject({ status: "pending", visibility: "private" });
      expect((await pool.query("SELECT 1 FROM artifacts WHERE id = $1", [body.artifact_id])).rowCount).toBe(1);
      expect((await pool.query("SELECT 1 FROM claims")).rowCount).toBe(0);
    });

    it("allows explicit private source promotion when creating a space_ops claim candidate packet", async () => {
      __setAuthRepositoryForTests(authWithRole("admin"));
      const pool = packetDatabase.database.pool;
      await seedBrief("A promoted route-level claim candidate.");
      await updateSpaceRetrievalSettings(pool, "space-1", { context_ops_review_mode: "admins" });
      vi.mocked(getDbPool).mockReturnValue(pool);
      app = buildModuleServer(config(), [knowledgeModule]);

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

      expect(res.statusCode, res.body).toBe(201);
      const body = res.json();
      expect(body).toMatchObject({
        artifact_id: expect.stringMatching(/[0-9a-f-]{36}/),
        proposal_id: expect.stringMatching(/[0-9a-f-]{36}/),
        candidate_count: 1,
        source_artifact_count: 1,
      });
      // The private brief was read only because promotion was explicit and confirmed.
      expect(await packet(body.proposal_id)).toMatchObject({ status: "pending", visibility: "space_shared" });
    });
  });

  it("requires owner or admin role for retrieval eval report persistence", async () => {
    __setAuthRepositoryForTests(authWithRole("member"));
    app = buildModuleServer(config(), [knowledgeModule]);

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
    app = buildModuleServer(config(), [knowledgeModule]);

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
    app = buildModuleServer(config(), [knowledgeModule]);

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
    app = buildModuleServer(config(), [knowledgeModule]);

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
      app = buildModuleServer(config(), [knowledgeModule]);

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
