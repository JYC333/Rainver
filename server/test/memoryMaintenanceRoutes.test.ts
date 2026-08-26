import { afterEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { getDbPool } from "../src/db/pool.js";
import { buildModuleServer } from "./support/moduleServer.js";
import { loadConfig } from "../src/config.js";
import { __setMemoryIdentityForTests } from "../src/modules/memory/routes.js";
import { memoryModule } from "../src/modules/memory/index.js";
import type { MemoryRow } from "../src/modules/memory/repository.js";

vi.mock("../src/db/pool.js", () => ({
  getDbPool: vi.fn(),
}));

let app: FastifyInstance | undefined;

interface CapturedQuery {
  sql: string;
  params: readonly unknown[];
}

afterEach(async () => {
  __setMemoryIdentityForTests(null);
  vi.mocked(getDbPool).mockReset();
  await app?.close();
  app = undefined;
});

function config() {
  return loadConfig({
    SERVER_DATABASE_URL: "postgresql://server@db:5432/rainver",
  });
}

function fakePool(
  rows: MemoryRow[],
  options: {
    failOnProposalInsert?: boolean;
    role?: "owner" | "admin" | "reviewer" | "member" | "guest";
    contextOpsScanMode?: "admins" | "members";
  } = {},
): { calls: CapturedQuery[]; pool: unknown } {
  const calls: CapturedQuery[] = [];
  const query = async (sql: string, params: readonly unknown[] = []) => {
    calls.push({ sql, params });
    const normalized = sql.replace(/\s+/g, " ").trim();
    if (options.failOnProposalInsert && normalized.startsWith("INSERT INTO proposals")) {
      throw new Error("proposal insert failed");
    }
    if (normalized.startsWith("INSERT INTO proposals")) {
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
    if (/FROM settings/.test(normalized)) {
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
            context_ops_scan_mode: options.contextOpsScanMode ?? "admins",
            embedding_dimensions: 2560,
            max_results_default: 50,
          },
          created_at: "2026-06-26T00:00:00.000Z",
          updated_at: "2026-06-26T00:00:00.000Z",
        }],
        rowCount: 1,
      };
    }
    if (/FROM space_memberships/.test(normalized) && !/FROM memory_entries/.test(normalized)) {
      return { rows: [{ role: options.role ?? "admin" }], rowCount: 1 };
    }
    if (normalized.startsWith("SELECT") && /FROM memory_entries/.test(normalized)) {
      return { rows, rowCount: rows.length };
    }
    return { rows: [], rowCount: 1 };
  };
  return {
    calls,
    pool: {
      query,
      async connect() {
        return {
          query,
          release() {},
        };
      },
    },
  };
}

function row(overrides: Partial<MemoryRow> = {}): MemoryRow {
  return {
    id: "memory-1",
    space_id: "space-1",
    subject_user_id: null,
    owner_user_id: "user-1",
    scope_type: "user",
    namespace: "user.default",
    memory_type: "fact",
    title: "Same",
    content: "Readable memory content",
    status: "active",
    visibility: "private",
    sensitivity_level: "normal",
    access_level: "full",
    last_confirmed_at: null,
    confidence: 1,
    importance: 0.5,
    source_id: null,
    created_by: "user-1",
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    deleted_at: null,
    version: 1,
    tags: [],
    memory_layer: "semantic",
    source_trust: "user_confirmed",
    created_from_proposal_id: null,
    root_memory_id: null,
    supersedes_memory_id: null,
    project_id: null,
    ...overrides,
  };
}

describe("Memory maintenance routes", () => {
  it("returns 404 for the retired memory-specific access-log endpoint", async () => {
    __setMemoryIdentityForTests({ spaceId: "space-1", userId: "user-1" });
    vi.mocked(getDbPool).mockReturnValue({
      query: vi.fn(async () => ({ rows: [], rowCount: 0 })),
    } as never);
    app = buildModuleServer(config(), [memoryModule]);

    const response = await app.inject({
      method: "GET",
      url: "/api/v1/memory/access-logs",
    });

    expect(response.statusCode, response.body).toBe(404);
  });

  it("creates a private report artifact and packet from a maintenance scan", async () => {
    __setMemoryIdentityForTests({ spaceId: "space-1", userId: "user-1" });
    const db = fakePool([
      row({ id: "memory-1", title: "Same" }),
      row({ id: "memory-2", title: "Same" }),
      row({ id: "memory-3", title: "Different" }),
    ]);
    vi.mocked(getDbPool).mockReturnValue(db.pool as never);
    app = buildModuleServer(config(), [memoryModule]);

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/memory/maintenance/scan",
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({
        create_packet: true,
        stale_after_days: 3650,
        thin_content_chars: 1,
      }),
    });

    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({
      counts: expect.objectContaining({ duplicate: 1 }),
      candidate_limit: 500,
      candidates_examined: 3,
      scanned: 3,
      truncated: false,
      artifact_id: expect.stringMatching(/[0-9a-f-]{36}/),
      proposal_id: expect.stringMatching(/[0-9a-f-]{36}/),
    });
    expect(db.calls.map((call) => call.sql.replace(/\s+/g, " ").trim())).toEqual(
      expect.arrayContaining(["BEGIN", "COMMIT"]),
    );
    const artifactInsert = db.calls.find((call) => /INSERT INTO artifacts/.test(call.sql));
    expect(artifactInsert).toBeDefined();
    const artifactPayload = JSON.parse(String(artifactInsert!.params[13]));
    expect(artifactPayload).toMatchObject({
      kind: "memory_maintenance_report",
      visibility: "private",
      owner_user_id: "user-1",
      candidate_limit: 500,
      candidates_examined: 3,
      counts: expect.objectContaining({ duplicate: 1 }),
      access_safety: {
        owner_private: true,
        raw_content_included: false,
        snippets_included: false,
      },
    });

    const proposalInsert = db.calls.find((call) => /INSERT INTO proposals/.test(call.sql));
    expect(proposalInsert).toBeDefined();
    expect(proposalInsert!.params[3]).toBe("memory_maintenance_packet");
    expect(proposalInsert!.params[14]).toBe("user-1");
    const proposalPayload = JSON.parse(String(proposalInsert!.params[10]));
    expect(proposalPayload).toMatchObject({
      operation: "memory_maintenance_packet",
      report_artifact_id: res.json().artifact_id,
      candidate_limit: 500,
      candidates_examined: 3,
      canonical_write_performed: false,
    });

    const accessLog = db.calls.find((call) => /INSERT INTO content_access_logs/.test(call.sql));
    expect(accessLog).toBeDefined();
    expect(accessLog!.params[1]).toEqual(["memory-1", "memory-2"]);
    expect(accessLog!.params[2]).toBe("memory");
    expect(accessLog!.params[6]).toBe("maintenance_scan");
    expect(accessLog!.params).not.toContain("memory-3");
  });

  it("rejects create_packet without persisted report", async () => {
    __setMemoryIdentityForTests({ spaceId: "space-1", userId: "user-1" });
    app = buildModuleServer(config(), [memoryModule]);

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/memory/maintenance/scan",
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({ create_packet: true, persist_report: false }),
    });

    expect(res.statusCode).toBe(422);
    expect(res.json().detail).toContain("create_packet requires persist_report");
    expect(getDbPool).not.toHaveBeenCalled();
  });

  it("rejects member scans unless Context Ops member scan initiation is enabled", async () => {
    __setMemoryIdentityForTests({ spaceId: "space-1", userId: "user-1" });
    const db = fakePool([row()], { role: "member", contextOpsScanMode: "admins" });
    vi.mocked(getDbPool).mockReturnValue(db.pool as never);
    app = buildModuleServer(config(), [memoryModule]);

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/memory/maintenance/scan",
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({ persist_report: false }),
    });

    expect(res.statusCode).toBe(403);
    expect(db.calls.some((call) => /FROM memory_entries/.test(call.sql))).toBe(false);
  });

  it("allows member scans when Context Ops member scan initiation is enabled", async () => {
    __setMemoryIdentityForTests({ spaceId: "space-1", userId: "user-1" });
    const db = fakePool([row()], { role: "member", contextOpsScanMode: "members" });
    vi.mocked(getDbPool).mockReturnValue(db.pool as never);
    app = buildModuleServer(config(), [memoryModule]);

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/memory/maintenance/scan",
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({ persist_report: false }),
    });

    expect(res.statusCode).toBe(200);
    expect(db.calls.some((call) => /FROM memory_entries/.test(call.sql))).toBe(true);
  });

  it("passes project filters into the maintenance scan query", async () => {
    __setMemoryIdentityForTests({ spaceId: "space-1", userId: "user-1" });
    const projectId = "11111111-1111-4111-8111-111111111111";
    const db = fakePool([row({ project_id: projectId })]);
    vi.mocked(getDbPool).mockReturnValue(db.pool as never);
    app = buildModuleServer(config(), [memoryModule]);

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/memory/maintenance/scan",
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({ persist_report: false, project_id: projectId }),
    });

    expect(res.statusCode, res.body).toBe(200);
    const memorySelect = db.calls.find((call) => /FROM memory_entries/.test(call.sql));
    expect(memorySelect?.sql).toContain("project_id");
    expect(memorySelect?.params).toContain(projectId);
  });

  it("rolls back the transaction when packet persistence fails", async () => {
    __setMemoryIdentityForTests({ spaceId: "space-1", userId: "user-1" });
    const db = fakePool(
      [
        row({ id: "memory-1", title: "Same" }),
        row({ id: "memory-2", title: "Same" }),
      ],
      { failOnProposalInsert: true },
    );
    vi.mocked(getDbPool).mockReturnValue(db.pool as never);
    app = buildModuleServer(config(), [memoryModule]);

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/memory/maintenance/scan",
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({ create_packet: true }),
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().detail).toContain("proposal insert failed");
    const statements = db.calls.map((call) => call.sql.replace(/\s+/g, " ").trim());
    expect(statements).toContain("BEGIN");
    expect(statements).toContain("ROLLBACK");
    expect(statements).not.toContain("COMMIT");
    expect(db.calls.some((call) => /INSERT INTO content_access_logs/.test(call.sql))).toBe(false);
  });
});
