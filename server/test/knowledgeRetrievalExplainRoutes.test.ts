import { afterEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { getDbPool } from "../src/db/pool";
import { buildServer } from "../src/server";
import { loadConfig } from "../src/config";
import {
  __setAuthRepositoryForTests,
  type AuthRepository,
} from "../src/modules/auth";
import { RETRIEVAL_EXPLAIN_REPORT_ARTIFACT_TYPE } from "../src/modules/retrieval";

vi.mock("../src/db/pool", () => ({
  getDbPool: vi.fn(),
}));

let app: FastifyInstance | undefined;

afterEach(async () => {
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

function adminAuth(): AuthRepository {
  return {
    async resolveIdentity() {
      return { ok: true, spaceId: "space-1", userId: "user-1" };
    },
    async getSpaceForUser() {
      return {
        id: "space-1",
        name: "Team",
        type: "team",
        role: "admin",
        oversight_mode: "none",
        egress_notifications_enabled: true,
        created_by_user_id: "owner-1",
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

function settingsRow() {
  return {
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
      context_ops_scan_mode: "admins",
      embedding_dimensions: 2560,
      max_results_default: 10,
    },
    created_at: "2026-06-12T10:00:00.000Z",
    updated_at: "2026-06-12T10:00:00.000Z",
  };
}

describe("Knowledge retrieval explain route", () => {
  it("returns and persists a safe explain report for an admin-visible Knowledge target", async () => {
    __setAuthRepositoryForTests(adminAuth());
    const calls: Array<{ sql: string; params: readonly unknown[] }> = [];
    vi.mocked(getDbPool).mockReturnValue({
      async query(sql: string, params: readonly unknown[] = []) {
        calls.push({ sql, params });
        if (/FROM settings/.test(sql)) return { rows: [settingsRow()], rowCount: 1 };
        if (/FROM retrieval_objects ro/.test(sql) && /ro.object_type = \$2/.test(sql)) {
          return {
            rows: [
              {
                object_type: "knowledge_item",
                object_id: "knowledge-item-1",
                title: "Alpha",
                source_connection_ids_json: [],
                snippet: "Visible excerpt",
                updated_at: "2026-06-18T00:00:00.000Z",
                rank: 1,
              },
            ],
            rowCount: 1,
          };
        }
        if (/FROM retrieval_aliases ra/.test(sql)) {
          return {
            rows: [
              {
                object_type: "knowledge_item",
                object_id: "knowledge-item-1",
                title: "Alpha",
                source_connection_ids_json: [],
                snippet: "Visible excerpt",
                matched_text: "alpha",
                matched_field: "title",
                updated_at: "2026-06-18T00:00:00.000Z",
                rank: 1,
              },
            ],
            rowCount: 1,
          };
        }
        if (/FROM knowledge_items ki/.test(sql)) {
          return {
            rows: [
              {
                id: "knowledge-item-1",
                title: "Alpha",
                visibility: "space_shared",
                owner_user_id: "owner-1",
                created_by_user_id: "user-1",
                excerpt: "Visible excerpt",
                plain_text: "Visible excerpt",
                content: "Visible excerpt",
              },
            ],
            rowCount: 1,
          };
        }
        if (/INSERT INTO artifacts/.test(sql)) return { rows: [], rowCount: 1 };
        return { rows: [], rowCount: 0 };
      },
    } as never);
    app = buildServer(config(), { logger: false });

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/knowledge/retrieval/explain",
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({
        query: "alpha",
        object_type: "knowledge_item",
        object_id: "knowledge-item-1",
        object_types: ["knowledge_item"],
        mode: "exact",
        max_results: 5,
        persist_artifact: true,
      }),
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      artifact_id: expect.stringMatching(/[0-9a-f-]{36}/),
      target: {
        object_type: "knowledge_item",
        object_id: "knowledge-item-1",
        title: "Alpha",
        visible: true,
        returned: true,
        rank: 1,
      },
    });
    expect(res.json().match.matched_fields).toEqual(expect.arrayContaining(["title"]));

    const insert = calls.find((call) => /INSERT INTO artifacts/.test(call.sql));
    expect(insert).toBeDefined();
    expect(insert!.params[4]).toBe(RETRIEVAL_EXPLAIN_REPORT_ARTIFACT_TYPE);
    expect(insert!.params[15]).toBe("user-1");
    const metadata = JSON.parse(String(insert!.params[13]));
    expect(metadata).toMatchObject({
      kind: RETRIEVAL_EXPLAIN_REPORT_ARTIFACT_TYPE,
      query_chars: 5,
      access_safety: {
        target_revalidated: true,
        visible_target_title_included: true,
        aggregate_trace_only: true,
        content_included: false,
        snippets_included: false,
        dropped_candidate_ids_included: false,
      },
    });
    expect(metadata.query_sha256).toMatch(/[0-9a-f]{64}/);
    expect(JSON.stringify(metadata)).not.toContain("\"query\":\"alpha\"");
    expect(JSON.stringify(metadata)).not.toContain("Visible excerpt");
  });
});
