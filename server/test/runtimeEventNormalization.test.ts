import { describe, expect, it } from "vitest";
import { normalizeVendorEvents } from "../src/modules/runs/runtimeEventNormalization";

// Runtime I/O Convergence requires semantic Run Events to never persist
// credentials or unbounded vendor payloads (see
// .agent/architecture/RUNS_AND_OUTPUTS.md). Codex-style command_execution
// events fall back to the raw shell command string for tool_name, which can
// carry secrets or arbitrarily long text — this must be redacted and bounded
// the same way `error.message` already is.

describe("normalizeVendorEvents tool_name redaction", () => {
  it("redacts a secret embedded in a raw command_execution command string", () => {
    const events = normalizeVendorEvents(
      "codex",
      [{
        type: "command_execution_started",
        item: { command: 'curl -H "Bearer sk-abcdefghijklmnop123456" https://example.com' },
      }],
      "2026-07-25T00:00:00.000Z",
    );
    expect(events).toHaveLength(1);
    const toolName = String((events[0]!.metadata_json as Record<string, unknown>).tool_name);
    expect(toolName).not.toContain("sk-abcdefghijklmnop123456");
    expect(toolName).toContain("[REDACTED_SECRET]");
  });

  it("truncates an oversized command string instead of persisting it unbounded", () => {
    const longCommand = `echo ${"a".repeat(5_000)}`;
    const events = normalizeVendorEvents(
      "codex",
      [{ type: "command_execution_started", item: { command: longCommand } }],
      "2026-07-25T00:00:00.000Z",
    );
    const toolName = String((events[0]!.metadata_json as Record<string, unknown>).tool_name);
    expect(toolName.length).toBeLessThan(longCommand.length);
    expect(toolName.endsWith("...[truncated]")).toBe(true);
  });

  it("keeps a short, safe tool name unchanged", () => {
    const events = normalizeVendorEvents(
      "claude_code",
      [{ type: "tool_use_started", item: { name: "read_file" } }],
      "2026-07-25T00:00:00.000Z",
    );
    expect((events[0]!.metadata_json as Record<string, unknown>).tool_name).toBe("read_file");
  });

  it("normalizes validated Codex app-server item lifecycle events", () => {
    const occurredAt = "2026-07-25T00:00:00.000Z";
    const events = normalizeVendorEvents("codex_cli", [
      {
        method: "item/started",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          item: { id: "item-1", type: "commandExecution", command: "npm test" },
        },
      },
      {
        method: "item/completed",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          item: { id: "item-1", type: "commandExecution", status: "completed" },
        },
      },
    ], occurredAt);

    expect(events.map((event) => event.type)).toEqual([
      "tool_call_started",
      "tool_call_completed",
    ]);
    expect(events.every((event) => event.call_id === "item-1")).toBe(true);
  });

  it("normalizes ACP tool lifecycle updates", () => {
    const events = normalizeVendorEvents("opencode", [
      {
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: "session-1",
          update: {
            sessionUpdate: "tool_call",
            toolCallId: "call-1",
            title: "Read file",
          },
        },
      },
      {
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: "session-1",
          update: {
            sessionUpdate: "tool_call_update",
            toolCallId: "call-1",
            status: "failed",
          },
        },
      },
    ], "2026-07-25T00:00:00.000Z");

    expect(events.map((event) => event.type)).toEqual([
      "tool_call_started",
      "tool_call_failed",
    ]);
  });
});
