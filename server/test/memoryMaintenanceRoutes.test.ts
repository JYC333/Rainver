import { afterEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { getDbPool } from "../src/db/pool";
import { buildServer } from "../src/server";
import { loadConfig } from "../src/config";
import { __setMemoryIdentityForTests } from "../src/modules/memory";
import type { MemoryRow } from "../src/modules/memory/repository";

vi.mock("../src/db/pool", () => ({
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
    SERVER_DATABASE_URL: "postgresql://server@db:5432/agent_space",
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
    project_folder_id: null,
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
  it("lists only currently readable memory access-log entries", async () => {
    __setMemoryIdentityForTests({ spaceId: "space-1", userId: "user-1" });
    const visible = row({ id: "memory-visible", title: "Visible", owner_user_id: "user-1", project_id: "project-1" });
    const hidden = row({ id: "memory-hidden", title: "Hidden", owner_user_id: "user-2" });
    const query = vi.fn(async (sql: string, _params: readonly unknown[] = []) => {
      const normalized = sql.replace(/\s+/g, " ").trim();
      if (/FROM memory_access_logs/.test(normalized)) {
        return {
          rows: [
            {
              ...visible,
              log_id: "11111111-1111-4111-8111-111111111111",
              log_space_id: "space-1",
              log_memory_id: "memory-visible",
              log_user_id: "user-1",
              log_agent_id: null,
              log_run_id: null,
              log_access_type: "context_injection",
              log_reason: "context build",
              log_accessed_at: "2026-06-26T10:00:00.000Z",
            },
            {
              ...hidden,
              log_id: "22222222-2222-4222-8222-222222222222",
              log_space_id: "space-1",
              log_memory_id: "memory-hidden",
              log_user_id: "user-2",
              log_agent_id: null,
              log_run_id: null,
              log_access_type: "explicit_read",
              log_reason: "hidden read",
              log_accessed_at: "2026-06-26T09:00:00.000Z",
            },
          ],
          rowCount: 2,
        };
      }
      if (/FROM projects/.test(normalized)) {
        return { rows: [{ id: "project-1", owner_user_id: "user-1" }], rowCount: 1 };
      }
      if (/FROM spaces/.test(normalized)) {
        return { rows: [{ type: "household" }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    });
    vi.mocked(getDbPool).mockReturnValue({ query } as never);
    app = buildServer(config(), { logger: false });

    const res = await app.inject({
      method: "GET",
      url: "/api/v1/memory/access-logs?limit=20&project_id=project-1",
    });

    expect(res.statusCode, res.body).toBe(200);
    expect(String(query.mock.calls[0]?.[0] ?? "")).not.toContain("m.content");
    expect(String(query.mock.calls[0]?.[0] ?? "")).toContain("m.project_id");
    expect(query.mock.calls[0]?.[1]).toContain("project-1");
    expect(res.json()).toMatchObject({
      limit: 20,
      offset: 0,
      returned: 1,
      has_more: false,
      items: [
        {
          id: "11111111-1111-4111-8111-111111111111",
          memory_id: "memory-visible",
          memory_title: "Visible",
          access_type: "context_injection",
          reason: "context build",
        },
      ],
    });
    expect(JSON.stringify(res.json())).not.toContain("Readable memory content");
    expect(JSON.stringify(res.json())).not.toContain("Hidden");
  });

  it("offset-paginates currently readable memory access-log entries", async () => {
    __setMemoryIdentityForTests({ spaceId: "space-1", userId: "user-1" });
    const first = row({ id: "memory-1", title: "First", owner_user_id: "user-1" });
    const second = row({ id: "memory-2", title: "Second", owner_user_id: "user-1" });
    const third = row({ id: "memory-3", title: "Third", owner_user_id: "user-1" });
    const query = vi.fn(async (sql: string, params: readonly unknown[] = []) => {
      const normalized = sql.replace(/\s+/g, " ").trim();
      if (/FROM memory_access_logs/.test(normalized)) {
        return {
          rows: [
            {
              ...first,
              log_id: "11111111-1111-4111-8111-111111111111",
              log_space_id: "space-1",
              log_memory_id: "memory-1",
              log_user_id: "user-1",
              log_agent_id: null,
              log_run_id: null,
              log_access_type: "maintenance_scan",
              log_reason: "first",
              log_accessed_at: "2026-06-26T10:00:00.000Z",
            },
            {
              ...second,
              log_id: "22222222-2222-4222-8222-222222222222",
              log_space_id: "space-1",
              log_memory_id: "memory-2",
              log_user_id: "user-1",
              log_agent_id: null,
              log_run_id: null,
              log_access_type: "maintenance_scan",
              log_reason: "second",
              log_accessed_at: "2026-06-26T09:00:00.000Z",
            },
            {
              ...third,
              log_id: "33333333-3333-4333-8333-333333333333",
              log_space_id: "space-1",
              log_memory_id: "memory-3",
              log_user_id: "user-1",
              log_agent_id: null,
              log_run_id: null,
              log_access_type: "maintenance_scan",
              log_reason: "third",
              log_accessed_at: "2026-06-26T08:00:00.000Z",
            },
          ],
          rowCount: 3,
        };
      }
      return { rows: [], rowCount: params.length };
    });
    vi.mocked(getDbPool).mockReturnValue({ query } as never);
    app = buildServer(config(), { logger: false });

    const res = await app.inject({
      method: "GET",
      url: "/api/v1/memory/access-logs?limit=1&offset=1",
    });

    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({
      limit: 1,
      offset: 1,
      returned: 1,
      has_more: true,
      items: [{ memory_id: "memory-2", memory_title: "Second" }],
    });
  });

  it("includes workspace-scoped shared access-log entries only when workspace context is provided", async () => {
    __setMemoryIdentityForTests({ spaceId: "space-1", userId: "user-1" });
    const workspaceShared = row({
      id: "memory-workspace",
      title: "Workspace memory",
      owner_user_id: "user-2",
      visibility: "space_shared",
      project_folder_id: "workspace-1",
    });
    const query = vi.fn(async (sql: string) => {
      const normalized = sql.replace(/\s+/g, " ").trim();
      if (/FROM memory_access_logs/.test(normalized)) {
        return {
          rows: [
            {
              ...workspaceShared,
              log_id: "33333333-3333-4333-8333-333333333333",
              log_space_id: "space-1",
              log_memory_id: "memory-workspace",
              log_user_id: "user-1",
              log_agent_id: null,
              log_run_id: null,
              log_access_type: "context_injection",
              log_reason: "workspace context",
              log_accessed_at: "2026-06-26T10:00:00.000Z",
            },
          ],
          rowCount: 1,
        };
      }
      return { rows: [], rowCount: 0 };
    });
    vi.mocked(getDbPool).mockReturnValue({ query } as never);
    app = buildServer(config(), { logger: false });

    const withoutWorkspace = await app.inject({
      method: "GET",
      url: "/api/v1/memory/access-logs?limit=20",
    });
    const withWorkspace = await app.inject({
      method: "GET",
      url: "/api/v1/memory/access-logs?limit=20&project_folder_id=workspace-1",
    });

    expect(withoutWorkspace.statusCode).toBe(200);
    expect(withoutWorkspace.json().returned).toBe(0);
    expect(withWorkspace.statusCode).toBe(200);
    expect(withWorkspace.json()).toMatchObject({
      returned: 1,
      items: [{ memory_id: "memory-workspace", memory_title: "Workspace memory" }],
    });
  });

  it("creates a private report artifact and packet from a maintenance scan", async () => {
    __setMemoryIdentityForTests({ spaceId: "space-1", userId: "user-1" });
    const db = fakePool([
      row({ id: "memory-1", title: "Same" }),
      row({ id: "memory-2", title: "Same" }),
      row({ id: "memory-3", title: "Different" }),
    ]);
    vi.mocked(getDbPool).mockReturnValue(db.pool as never);
    app = buildServer(config(), { logger: false });

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

    const accessLog = db.calls.find((call) => /INSERT INTO memory_access_logs/.test(call.sql));
    expect(accessLog).toBeDefined();
    expect(accessLog!.params[2]).toBe("memory-1");
    expect(accessLog!.params[4]).toBe("maintenance_scan");
    expect(accessLog!.params[9]).toBe("memory-2");
    expect(accessLog!.params[11]).toBe("maintenance_scan");
    expect(accessLog!.params).not.toContain("memory-3");
  });

  it("rejects create_packet without persisted report", async () => {
    __setMemoryIdentityForTests({ spaceId: "space-1", userId: "user-1" });
    app = buildServer(config(), { logger: false });

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
    app = buildServer(config(), { logger: false });

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
    app = buildServer(config(), { logger: false });

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
    app = buildServer(config(), { logger: false });

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
    app = buildServer(config(), { logger: false });

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
    expect(db.calls.some((call) => /INSERT INTO memory_access_logs/.test(call.sql))).toBe(false);
  });
});
