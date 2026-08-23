import { describe, expect, it } from "vitest";
import { normalizeVendorEvents } from "../src/modules/runs/runtimeEventNormalization";

// Runtime I/O Convergence requires semantic Run Events to never persist
// credentials or unbounded vendor payloads (see
// .agent/architecture/RUNS_AND_OUTPUTS.md). Codex-style command_execution
// events fall back to the raw shell command string for tool_name, which can
// carry secrets or arbitrarily long text — this must be redacted and bounded
// the same way `error.message` already is.

describe("normalizeVendorEvents tool_name redaction", () => {
  it("redacts a secret embedded in an ACP tool_call title", () => {
    const events = normalizeVendorEvents("codex_cli", [{
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "session-1",
        update: {
          sessionUpdate: "tool_call",
          toolCallId: "call-1",
          title: 'curl -H "Bearer sk-abcdefghijklmnop123456" https://example.com',
        },
      },
    }], "2026-07-25T00:00:00.000Z");
    expect(events).toHaveLength(1);
    const toolName = String((events[0]!.metadata_json as Record<string, unknown>).tool_name);
    expect(toolName).not.toContain("sk-abcdefghijklmnop123456");
    expect(toolName).toContain("[REDACTED_SECRET]");
  });

  it("truncates an oversized tool_call title instead of persisting it unbounded", () => {
    const longTitle = `echo ${"a".repeat(5_000)}`;
    const events = normalizeVendorEvents("codex_cli", [{
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "session-1",
        update: { sessionUpdate: "tool_call", toolCallId: "call-1", title: longTitle },
      },
    }], "2026-07-25T00:00:00.000Z");
    const toolName = String((events[0]!.metadata_json as Record<string, unknown>).tool_name);
    expect(toolName.length).toBeLessThan(longTitle.length);
    expect(toolName.endsWith("...[truncated]")).toBe(true);
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
    expect((events[0]!.metadata_json as Record<string, unknown>).tool_name).toBe("Read file");
  });

  it("normalizes ACP tool lifecycle updates for codex_cli too (ACP runtime replatform P3)", () => {
    const events = normalizeVendorEvents("codex_cli", [
      {
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: "session-1",
          update: {
            sessionUpdate: "tool_call",
            toolCallId: "call-1",
            title: "npm test",
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
            status: "completed",
          },
        },
      },
    ], "2026-07-25T00:00:00.000Z");

    expect(events.map((event) => event.type)).toEqual([
      "tool_call_started",
      "tool_call_completed",
    ]);
    expect(events.every((event) => event.call_id === "call-1")).toBe(true);
  });

  it("produces no normalized event for an ACP initialize response echoed for diagnostics", () => {
    const events = normalizeVendorEvents("opencode", [
      {
        jsonrpc: "2.0",
        id: 1,
        result: {
          protocolVersion: 1,
          agentCapabilities: { sessionCapabilities: ["close", "fork", "list", "resume"] },
        },
      },
    ], "2026-07-25T00:00:00.000Z");

    expect(events).toEqual([]);
  });
});
