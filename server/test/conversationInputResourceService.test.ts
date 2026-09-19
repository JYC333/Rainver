import { describe, expect, it, vi } from "vitest";
import type { Queryable, QueryResult } from "../src/modules/routeUtils/common.js";
import { ConversationInputResourceService, ConversationInputResourceToolError } from "../src/modules/sessions/conversationInputResourceService.js";

function fakeDb(row: Record<string, unknown> | null): Queryable {
  return {
    query: vi.fn(async <Row = Record<string, unknown>>(_sql: string, _params: readonly unknown[] = []) => ({
      rows: (row ? [row] : []) as Row[],
      rowCount: row ? 1 : 0,
    } satisfies QueryResult<Row>)) as Queryable["query"],
  };
}

describe("ConversationInputResourceService", () => {
  it("reads bounded lines only from the Run's exact message resource", async () => {
    const db = fakeDb({ id: "resource-1", sha256: "a".repeat(64), content: "one\ntwo\nthree\nfour" });
    const service = new ConversationInputResourceService(db);

    await expect(service.read({
      spaceId: "space-1", runId: "run-1", messageId: "message-1",
      request: { resource_id: "resource-1", start_line: 2, line_count: 2 },
    })).resolves.toEqual({
      resource_id: "resource-1", start_line: 2, end_line: 3, next_line: 4,
      total_lines: 4, sha256: "a".repeat(64), content: "two\nthree", truncated: true,
    });
    const [sql, params] = (db.query as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(sql).toContain("resource.message_id = $4");
    expect(sql).toContain("JOIN sessions session_row");
    expect(sql).toContain("room_user_members resource_room_member");
    expect(sql).toContain("content_project.deleted_at IS NULL");
    expect(sql).toContain("run_row.instructed_by_user_id");
    expect(params).toEqual(["run-1", "resource-1", "space-1", "message-1"]);
  });

  it("rejects a guessed, cross-message, cross-space, or stopped-Run resource", async () => {
    const service = new ConversationInputResourceService(fakeDb(null));
    await expect(service.read({
      spaceId: "space-1", runId: "stopped-run", messageId: "message-1",
      request: { resource_id: "resource-guess", start_line: 1, line_count: 1 },
    })).rejects.toBeInstanceOf(ConversationInputResourceToolError);
  });

  it("searches literally, bounds result count, and keeps the body out of the query contract", async () => {
    const content = Array.from({ length: 25 }, (_, index) => `needle ${index + 1}`).join("\n");
    const db = fakeDb({ id: "resource-1", sha256: "b".repeat(64), content });
    const service = new ConversationInputResourceService(db);
    const output = await service.search({
      spaceId: "space-1", runId: "run-1", messageId: "message-1",
      request: { resource_id: "resource-1", query: "needle", case_sensitive: false, max_results: 2 },
    });
    expect(output.matches).toEqual([
      { line: 1, excerpt: "needle 1" },
      { line: 2, excerpt: "needle 2" },
    ]);
    expect(output.truncated).toBe(true);
    expect(JSON.stringify(output)).toContain("needle 1");
    const sql = (db.query as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as string;
    expect(sql).not.toContain("audit");
  });
});
