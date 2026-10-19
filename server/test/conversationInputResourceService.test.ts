import { describe, expect, it, vi } from "vitest";
import type { Queryable, QueryResult } from "../src/modules/routeUtils/common.js";
import { INPUT_RESOURCE_MAX_READ_BYTES } from "@rainver/protocol";
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
      resource_id: "resource-1", start_line: 2, start_byte_offset: 0, end_line: 3, next_line: 4, next_byte_offset: 0,
      total_lines: 4, sha256: "a".repeat(64), content: "two\nthree", truncated: true, eof: false,
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

  it("continues a line longer than one read by byte offset, never splitting a character, and joins back to the original", async () => {
    // 70,000 three-byte characters: 210,000 bytes on one line, more than three reads.
    const longLine = "\u4e2d".repeat(70_000);
    const content = `first\n${longLine}\nlast`;
    const db = fakeDb({ id: "resource-1", sha256: "c".repeat(64), content });
    const service = new ConversationInputResourceService(db);
    const read = (start_line: number, start_byte_offset: number) => service.read({
      spaceId: "space-1", runId: "run-1", messageId: "message-1",
      request: { resource_id: "resource-1", start_line, line_count: 50, start_byte_offset, sha256: "c".repeat(64) },
    });

    // A line that does not fit after shorter lines is left whole for the next read.
    const first = await read(1, 0);
    expect(first).toMatchObject({ start_line: 1, end_line: 1, next_line: 2, next_byte_offset: 0, content: "first", truncated: true, eof: false });

    const second = await read(2, 0);
    expect(second).toMatchObject({ start_line: 2, end_line: 2, next_line: 2, truncated: true, eof: false });
    expect(second.next_byte_offset).toBeGreaterThan(0);
    expect(second.next_byte_offset! % 3).toBe(0);
    expect(Buffer.byteLength(second.content, "utf8")).toBeLessThanOrEqual(INPUT_RESOURCE_MAX_READ_BYTES);
    expect(second.content).not.toContain("\ufffd");

    let joined = first.content;
    let previous = first;
    let reads = 1;
    while (!previous.eof) {
      const chunk = await read(previous.next_line!, previous.next_byte_offset!);
      reads += 1;
      expect(chunk.start_line).toBe(previous.next_line);
      expect(chunk.start_byte_offset).toBe(previous.next_byte_offset);
      expect(chunk.content).not.toContain("\ufffd");
      // A cursor at byte 0 starts a new line; a cursor inside a line continues it.
      joined += (previous.next_byte_offset === 0 ? "\n" : "") + chunk.content;
      previous = chunk;
    }
    expect(previous).toMatchObject({ next_line: null, next_byte_offset: null, truncated: false, eof: true, end_line: 3 });
    expect(reads).toBeGreaterThan(4);
    expect(joined).toBe(content);
  });

  it("rejects an offset inside a multi-byte character, past the line end, or a mismatched sha256", async () => {
    const db = fakeDb({ id: "resource-1", sha256: "d".repeat(64), content: "\u4e2dabc" });
    const service = new ConversationInputResourceService(db);
    const read = (request: Record<string, unknown>) => service.read({
      spaceId: "space-1", runId: "run-1", messageId: "message-1",
      request: { resource_id: "resource-1", start_line: 1, line_count: 1, ...request },
    });
    await expect(read({ start_byte_offset: 1 })).rejects.toMatchObject({ code: "invalid_resource_request" });
    await expect(read({ start_byte_offset: 7 })).rejects.toMatchObject({ code: "invalid_resource_request" });
    await expect(read({ sha256: "e".repeat(64) })).rejects.toMatchObject({ code: "invalid_resource_request" });
    await expect(read({ start_byte_offset: 3 })).resolves.toMatchObject({ content: "abc", eof: true, next_byte_offset: null });
    await expect(read({ start_byte_offset: 6 })).resolves.toMatchObject({ content: "", eof: true });
    await expect(read({ start_line: 2 })).rejects.toMatchObject({ code: "invalid_resource_request" });
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
