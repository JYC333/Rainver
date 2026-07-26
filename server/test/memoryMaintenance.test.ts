import { describe, expect, it } from "vitest";
import { MemoryMaintenanceService } from "../src/modules/memory/maintenance";
import type { MemoryRow, Queryable } from "../src/modules/memory/repository";

interface CapturedQuery {
  sql: string;
  params: readonly unknown[];
}

interface FakeDb extends Queryable {
  calls: CapturedQuery[];
}

function fakeDb(rows: MemoryRow[], accessibleProjects: readonly string[] = []): FakeDb {
  const calls: CapturedQuery[] = [];
  return {
    calls,
    async query<Row = Record<string, unknown>>(sql: string, params: readonly unknown[] = []) {
      calls.push({ sql, params });
      if (/FROM memory_entries/.test(sql)) {
        const limit = typeof params[2] === "number" ? params[2] : rows.length;
        const cursorUpdatedAt = typeof params[4] === "string" ? params[4] : null;
        const cursorId = typeof params[5] === "string" ? params[5] : null;
        const page = rows
          .filter((entry) => {
            if (!cursorUpdatedAt || !cursorId) return true;
            const updatedAt = String(entry.updated_at);
            return updatedAt < cursorUpdatedAt || (updatedAt === cursorUpdatedAt && entry.id < cursorId);
          })
          .slice(0, limit);
        return { rows: page as Row[], rowCount: page.length };
      }
      if (/FROM projects/.test(sql) && /id = ANY/.test(sql)) {
        const ids = params[1] as string[];
        const projectRows = ids.map((id) => ({
          id,
          owner_user_id: accessibleProjects.includes(id) ? "user-1" : "other-user",
        }));
        return {
          rows: projectRows as Row[],
          rowCount: ids.length,
        };
      }
      if (/FROM spaces/.test(sql)) return { rows: [{ type: "team" }] as Row[], rowCount: 1 };
      if (/FROM project_members/.test(sql)) {
        const memberRows = accessibleProjects.map((project_id) => ({ project_id }));
        return {
          rows: memberRows as Row[],
          rowCount: accessibleProjects.length,
        };
      }
      return { rows: [] as Row[], rowCount: 0 };
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
    title: "Memory",
    content: "Readable memory content",
    status: "active",
    visibility: "private",
    access_level: "full",
    sensitivity_level: "normal",
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

function scan(
  db: Queryable,
  overrides: Partial<Parameters<MemoryMaintenanceService["scan"]>[0]> = {},
) {
  return new MemoryMaintenanceService(db).scan({
    spaceId: "space-1",
    userId: "user-1",
    limit: 100,
    staleAfterDays: 365,
    thinContentChars: 12,
    maxFindings: 100,
    ...overrides,
  });
}

describe("Memory maintenance scan", () => {
  it("detects duplicate, stale, thin, and lifecycle findings without raw content", async () => {
    const db = fakeDb([
      row({
        id: "memory-1",
        title: "Shared title",
        content: "tiny",
        updated_at: "2020-01-01T00:00:00.000Z",
      }),
      row({ id: "memory-2", title: "Shared title", content: "This content is long enough." }),
      row({
        id: "memory-3",
        title: "Superseded without target",
        status: "superseded",
        content: "Historical memory",
        supersedes_memory_id: null,
      }),
    ]);

    const result = await scan(db);

    expect(result.report.counts).toMatchObject({
      duplicate: 1,
      stale: 1,
      thin: 1,
      lifecycle_drift: 1,
    });
    expect(result.report.candidate_limit).toBe(100);
    expect(result.report.candidates_examined).toBe(3);
    expect(result.report.scanned).toBe(3);
    expect(result.contributingMemoryIds).toEqual(["memory-1", "memory-2", "memory-3"]);
    expect(JSON.stringify(result.report)).not.toContain("tiny");
    expect(JSON.stringify(result.report)).not.toContain("This content is long enough.");
    expect(result.report.access_safety).toMatchObject({
      owner_private: true,
      raw_content_included: false,
      snippets_included: false,
    });
    expect(result.report.findings.find((finding) => finding.kind === "duplicate")).toMatchObject({
      confidence_tier: "high",
      proposed_action: {
        proposal_type: "memory_archive",
        target_memory_ids: ["memory-2"],
      },
    });
  });

  it("excludes unsafe scopes and project-inaccessible rows before reporting", async () => {
    const db = fakeDb([
      row({ id: "visible", title: "Same" }),
      row({ id: "restricted", title: "Same", sensitivity_level: "highly_restricted" }),
      row({ id: "system", title: "Same", scope_type: "system" }),
      row({ id: "template", title: "Same", scope_type: "system" }),
      row({
        id: "project-hidden",
        title: "Same",
        visibility: "space_shared",
        owner_user_id: "other-user",
        project_id: "project-secret",
      }),
    ]);

    const result = await scan(db);

    expect(result.report.scanned).toBe(1);
    expect(result.report.candidates_examined).toBe(1);
    expect(result.report.findings).toEqual([]);
    expect(result.contributingMemoryIds).toEqual([]);
  });

  it("does not use summary-only content for non-owner duplicate or thin findings", async () => {
    const db = fakeDb([
      row({
        id: "summary-1",
        owner_user_id: "owner-1",
        visibility: "space_shared",
        access_level: "summary",
        title: null,
        content: "same private content that should not be inspected",
      }),
      row({
        id: "summary-2",
        owner_user_id: "owner-2",
        visibility: "space_shared",
        access_level: "summary",
        title: null,
        content: "same private content that should not be inspected",
      }),
    ]);

    const result = await scan(db);

    expect(result.report.scanned).toBe(2);
    expect(result.report.findings).toEqual([]);
    expect(result.contributingMemoryIds).toEqual([]);
    expect(result.report.access_safety).toMatchObject({
      summary_access_full_content_used: false,
    });
  });

  it("marks owner-readable summary-only content use when content checks inspect it", async () => {
    const db = fakeDb([
      row({
        id: "summary-owner",
        owner_user_id: "user-1",
        visibility: "space_shared",
        access_level: "summary",
        title: null,
        content: "tiny",
      }),
    ]);

    const result = await scan(db);

    expect(result.report.findings).toEqual([
      expect.objectContaining({
        kind: "thin",
        objects: [{ object_type: "memory_entry", object_id: "summary-owner", title: null }],
      }),
    ]);
    expect(result.report.access_safety).toMatchObject({
      summary_access_full_content_used: true,
      raw_content_included: false,
    });
    expect(JSON.stringify(result.report)).not.toContain("tiny");
  });

  it("detects project, source-policy, archived-state, and contradiction drift without content", async () => {
    const db = fakeDb([
      row({
        id: "project-drift",
        title: "Project-scoped fact",
        scope_type: "user",
        project_id: "project-1",
        content: "Project memory has enough content for the maintenance threshold.",
      }),
      row({
        id: "source-policy-drift",
        title: "External source fact",
        source_trust: "trusted_external",
        source_id: null,
        content: "External source fact has enough content for the maintenance threshold.",
      }),
      row({
        id: "archived-drift",
        title: "Archived lifecycle fact",
        status: "archived",
        root_memory_id: "root-memory",
        content: "Archived content should not appear in the report.",
      }),
      row({
        id: "feature-yes",
        title: "Feature state",
        content: "Feature state is enabled for the workspace.",
      }),
      row({
        id: "feature-no",
        title: "Feature state",
        content: "Feature state is not enabled for the workspace.",
      }),
    ], ["project-1"]);

    const result = await scan(db);

    expect(result.report.counts).toMatchObject({
      project_drift: 1,
      source_policy_drift: 1,
      archived_state_drift: 1,
      contradiction: 1,
    });
    expect(result.report.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: "project_drift",
        confidence_tier: "medium",
        proposed_action: expect.objectContaining({
          proposal_type: "memory_update",
          target_memory_id: "project-drift",
          target_scope: "project",
          project_id: "project-1",
        }),
      }),
      expect.objectContaining({
        kind: "source_policy_drift",
        confidence_tier: "low",
        proposed_action: expect.objectContaining({
          proposal_type: "memory_update",
          target_memory_id: "source-policy-drift",
          requires_operator_edit: true,
        }),
      }),
      expect.objectContaining({
        kind: "archived_state_drift",
        confidence_tier: "low",
        proposed_action: expect.objectContaining({
          proposal_type: "memory_update",
          target_memory_id: "archived-drift",
          requires_operator_edit: true,
        }),
      }),
      expect.objectContaining({
        kind: "contradiction",
        confidence_tier: "low",
        proposed_action: expect.objectContaining({
          proposal_type: "memory_update",
          target_memory_id: "feature-yes",
          related_memory_ids: ["feature-no"],
          requires_operator_edit: true,
        }),
      }),
    ]));
    const serialized = JSON.stringify(result.report);
    expect(serialized).not.toContain("Feature state is enabled");
    expect(serialized).not.toContain("Feature state is not enabled");
    expect(serialized).not.toContain("Archived content should not appear");
  });

  it("returns and accepts a visible-boundary cursor for full scans", async () => {
    const db = fakeDb([
      row({
        id: "memory-b",
        title: "B",
        updated_at: "2026-02-01T00:00:00.000Z",
      }),
      row({
        id: "memory-a",
        title: "A",
        updated_at: "2026-01-01T00:00:00.000Z",
      }),
    ]);

    const result = await scan(db, { limit: 2, scanMode: "full" });

    expect(result.report.scan_mode).toBe("full");
    expect(result.report.next_cursor).toEqual(expect.any(String));
    const cursor = JSON.parse(
      Buffer.from(result.report.next_cursor!, "base64url").toString("utf8"),
    ) as Record<string, string>;
    expect(cursor).toMatchObject({
      id: "memory-a",
      updated_at: "2026-01-01T00:00:00.000Z",
    });

    await scan(db, { limit: 2, scanMode: "full", cursor: result.report.next_cursor });
    const secondSelect = db.calls.filter((call) => /FROM memory_entries/.test(call.sql)).at(-1);
    expect(secondSelect?.params[4]).toBe("2026-01-01T00:00:00.000Z");
    expect(secondSelect?.params[5]).toBe("memory-a");
    expect(result.report.access_safety).toMatchObject({
      cursor_uses_visible_boundary: true,
    });
  });

  it("continues full scans across hidden-only candidate pages without exposing hidden ids", async () => {
    const db = fakeDb([
      row({
        id: "visible-new",
        title: "New visible",
        updated_at: "2026-04-01T00:00:00.000Z",
      }),
      row({
        id: "hidden-b",
        title: "Hidden B",
        owner_user_id: "other-user",
        visibility: "private",
        updated_at: "2026-03-01T00:00:00.000Z",
      }),
      row({
        id: "hidden-a",
        title: "Hidden A",
        owner_user_id: "other-user",
        visibility: "private",
        updated_at: "2026-02-01T00:00:00.000Z",
      }),
      row({
        id: "visible-old",
        title: "Old visible",
        updated_at: "2026-01-01T00:00:00.000Z",
      }),
    ]);

    const first = await scan(db, { limit: 2, scanMode: "full" });
    const second = await scan(db, { limit: 2, scanMode: "full", cursor: first.report.next_cursor });

    expect(first.report.next_cursor).toEqual(expect.any(String));
    expect(JSON.stringify(first.report)).not.toContain("hidden-a");
    expect(JSON.stringify(first.report)).not.toContain("hidden-b");
    expect(second.report.scanned).toBe(1);
    expect(second.report.findings).toEqual([]);
    expect(second.report.next_cursor).toBeNull();
    expect(JSON.stringify(second.report)).not.toContain("hidden-a");
    expect(JSON.stringify(second.report)).not.toContain("hidden-b");
    const memorySelects = db.calls.filter((call) => /FROM memory_entries/.test(call.sql));
    expect(memorySelects.length).toBeGreaterThanOrEqual(3);
    expect(memorySelects.at(-1)?.params[4]).toBe("2026-02-01T00:00:00.000Z");
    expect(memorySelects.at(-1)?.params[5]).toBe("hidden-a");
  });
});
