import { afterEach, describe, expect, it, vi } from "vitest";
import { fakeAuthRepository, retrievalSettingsRow } from "./support/routeFakes.js";
import type { FastifyInstance } from "fastify";
import { getDbPool } from "../src/db/pool.js";
import { buildModuleServer } from "./support/moduleServer.js";
import { knowledgeModule } from "../src/modules/knowledge/index.js";
import { loadConfig } from "../src/config.js";
import { __setAuthRepositoryForTests } from "../src/modules/auth/identity.js";

// HTTP route coverage for the Slice E/F review-loop endpoints: Context Ops scan
// gating, response shape, and artifact/proposal persistence wiring. The DB pool
// is mocked (the deeper SQL is covered by the *Db real-Postgres tests).

vi.mock("../src/db/pool.js", () => ({ getDbPool: vi.fn() }));

let app: FastifyInstance | undefined;

afterEach(async () => {
  __setAuthRepositoryForTests(null);
  vi.mocked(getDbPool).mockReset();
  await app?.close();
  app = undefined;
});

function config() {
  return loadConfig({ SERVER_DATABASE_URL: "postgresql://server@db:5432/rainver" });
}

interface Handler {
  (sql: string, params: readonly unknown[]): { rows: unknown[]; rowCount: number } | undefined;
}

// A pool mock that serves both direct .query and withDbTransaction's
// .connect()→client.query path from one handler.
function mockPool(handler: Handler): void {
  const calls: Array<{ sql: string; params: readonly unknown[] }> = [];
  const query = async (sql: string, params: readonly unknown[] = []) => {
    calls.push({ sql, params });
    if (sql.replace(/\s+/g, " ").trim().startsWith("INSERT INTO proposals")) {
      return {
        rows: [{
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
        }],
        rowCount: 1,
      };
    }
    return handler(sql, params) ?? { rows: [], rowCount: 1 };
  };
  const pool = {
    query,
    async connect() {
      return { query, release() {} };
    },
    __calls: calls,
  };
  vi.mocked(getDbPool).mockReturnValue(pool as never);
}

function claimRow(over: Record<string, unknown>) {
  return {
    id: "claim-x",
    space_id: "space-1",
    subject_object_id: "subject-1",
    subject_text: null,
    claim_kind: "fact",
    claim_text: "text",
    normalized_claim_hash: "h",
    holder_object_id: null,
    holder_type: null,
    holder_id: null,
    confidence: 0.5,
    confidence_method: "human_confirmed",
    resolution_state: "unreviewed",
    valid_from: null,
    valid_until: null,
    observed_at: null,
    metadata_json: {},
    status: "active",
    visibility: "space_shared",
    title: "Claim",
    excerpt: null,
    owner_user_id: "user-1",
    primary_project_id: null,
    project_folder_id: null,
    created_by_user_id: "user-1",
    created_by_agent_id: null,
    created_by_run_id: null,
    created_from_proposal_id: null,
    approved_by_user_id: null,
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    archived_at: null,
    ...over,
  };
}

describe("contradiction-scan route", () => {
  it("scans visible active claims and persists a report (admin)", async () => {
    __setAuthRepositoryForTests(fakeAuthRepository("admin"));
    mockPool((sql) => {
      if (/c\.status = 'active'/.test(sql)) {
        return {
          rows: [
            claimRow({ id: "a", claim_text: "The backup job runs every night.", title: "Job" }),
            claimRow({ id: "b", claim_text: "The backup job does not run every night.", title: "Job" }),
          ],
          rowCount: 2,
        };
      }
      return undefined;
    });
    app = buildModuleServer(config(), [knowledgeModule]);

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/knowledge/claims/contradiction-scan",
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({ create_packet: false }),
    });

    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.artifact_id).toMatch(/[0-9a-f-]{36}/);
    expect(body.canonical_write_performed).toBe(false);
    expect(body.report.findings).toHaveLength(1);
    expect(body.report.findings[0].signal).toBe("negation");
  });

  it("rejects a member without Context Ops scan access (403)", async () => {
    __setAuthRepositoryForTests(fakeAuthRepository("guest"));
    mockPool((sql) => {
      if (/FROM settings/.test(sql)) return { rows: [retrievalSettingsRow()], rowCount: 1 };
      if (/FROM space_memberships/.test(sql)) return { rows: [{ role: "guest" }], rowCount: 1 };
      return undefined;
    });
    app = buildModuleServer(config(), [knowledgeModule]);

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/knowledge/claims/contradiction-scan",
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({ create_packet: false }),
    });
    expect(res.statusCode).toBe(403);
  });

  it("rejects llm_judge_enabled until the provider adapter is wired", async () => {
    __setAuthRepositoryForTests(fakeAuthRepository("admin"));
    mockPool((sql) => {
      if (/FROM settings/.test(sql)) return { rows: [retrievalSettingsRow()], rowCount: 1 };
      if (/FROM space_memberships/.test(sql)) return { rows: [{ role: "admin" }], rowCount: 1 };
      return undefined;
    });
    app = buildModuleServer(config(), [knowledgeModule]);

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/knowledge/claims/contradiction-scan",
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({ create_packet: false, llm_judge_enabled: true }),
    });

    expect(res.statusCode).toBe(422);
    expect(res.json().detail).toContain("llm_judge_enabled");
  });
});

describe("claims trajectory route", () => {
  it("returns advisory trajectory signals for a subject (no scan gate)", async () => {
    __setAuthRepositoryForTests(fakeAuthRepository("member"));
    mockPool((sql) => {
      if (/c\.subject_object_id = \$3/.test(sql)) {
        return {
          rows: [
            claimRow({ id: "c1", status: "superseded", confidence: 0.3, created_at: "2026-01-01T00:00:00.000Z", valid_from: "2026-01-01T00:00:00.000Z" }),
            claimRow({ id: "c2", status: "active", confidence: 0.9, created_at: "2026-02-01T00:00:00.000Z", valid_from: "2026-02-01T00:00:00.000Z" }),
          ],
          rowCount: 2,
        };
      }
      return undefined;
    });
    app = buildModuleServer(config(), [knowledgeModule]);

    const res = await app.inject({
      method: "GET",
      url: "/api/v1/knowledge/claims/trajectory?subject_object_id=subject-1",
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.points).toHaveLength(2);
    expect(body.signals.map((s: { kind: string }) => s.kind)).toContain("supersession");
    expect(body.canonical_write_performed).toBe(false);
  });
});

describe("relation discovery-scan route", () => {
  it("discovers a relation candidate and creates a packet (admin)", async () => {
    __setAuthRepositoryForTests(fakeAuthRepository("admin"));
    mockPool((sql) => {
      if (/FROM knowledge_items ki/.test(sql)) {
        return {
          rows: [
            { id: "item-a", title: "Alpha", slug: "alpha", aliases_json: [], content: "Alpha depends on [[Beta]].", plain_text: null, visibility: "space_shared", status: "active" },
            { id: "item-b", title: "Beta", slug: "beta", aliases_json: [], content: "Beta.", plain_text: null, visibility: "space_shared", status: "active" },
          ],
          rowCount: 2,
        };
      }
      return undefined;
    });
    app = buildModuleServer(config(), [knowledgeModule]);

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/knowledge/relations/discovery-scan",
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({ create_packet: true }),
    });

    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.candidate_count).toBe(1);
    expect(body.artifact_id).toMatch(/[0-9a-f-]{36}/);
    expect(body.proposal_id).toMatch(/[0-9a-f-]{36}/);
    expect(body.proposal_candidate_count).toBe(1);
    expect(body.review_only_candidate_count).toBe(0);
    expect(body.canonical_write_performed).toBe(false);
  });

  it("rejects llm_extraction_enabled until the provider adapter is wired", async () => {
    __setAuthRepositoryForTests(fakeAuthRepository("admin"));
    mockPool((sql) => {
      if (/FROM settings/.test(sql)) return { rows: [retrievalSettingsRow()], rowCount: 1 };
      if (/FROM space_memberships/.test(sql)) return { rows: [{ role: "admin" }], rowCount: 1 };
      return undefined;
    });
    app = buildModuleServer(config(), [knowledgeModule]);

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/knowledge/relations/discovery-scan",
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({ create_packet: false, llm_extraction_enabled: true }),
    });

    expect(res.statusCode).toBe(422);
    expect(res.json().detail).toContain("llm_extraction_enabled");
  });
});
