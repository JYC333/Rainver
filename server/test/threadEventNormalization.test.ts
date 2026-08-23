import { describe, expect, it } from "vitest";
import { createThreadEventNormalizer } from "../src/modules/hosts/threadEventNormalization";

describe("createThreadEventNormalizer (control-center-phase2-plan.md P1, C2/C5; ACP runtime replatform P1-P5)", () => {
  it("streams stderr lines as diagnostic events, one per line", () => {
    const normalizer = createThreadEventNormalizer();
    const drafts = normalizer.pushStderr("permission denied\nretrying\n");
    expect(drafts).toEqual([
      { event_type: "diagnostic", text: "permission denied" },
      { event_type: "diagnostic", text: "retrying" },
    ]);
  });

  it("finish() flushes a trailing partial text segment and stderr line", () => {
    const normalizer = createThreadEventNormalizer();
    // No trailing newline on either buffer — both are left pending.
    normalizer.pushAcpTextDelta("no newline yet");
    normalizer.pushStderr("partial stderr line");
    const drafts = normalizer.finish();
    expect(drafts).toContainEqual({ event_type: "assistant_text", text: "no newline yet" });
    expect(drafts).toContainEqual({ event_type: "diagnostic", text: "partial stderr line" });
  });

  it("coalesces ACP text deltas into one assistant_text event per completed line", () => {
    const normalizer = createThreadEventNormalizer();
    expect(normalizer.pushAcpTextDelta("Hel")).toEqual([]);
    expect(normalizer.pushAcpTextDelta("lo wor")).toEqual([]);
    expect(normalizer.pushAcpTextDelta("ld\n")).toEqual([{ event_type: "assistant_text", text: "Hello world" }]);
  });

  it("emits tool_activity_started with tool_kind from an ACP tool_call update (ACP runtime replatform P3, A9)", () => {
    const normalizer = createThreadEventNormalizer();
    const drafts = normalizer.pushAcpProtocolEvent({
      method: "session/update",
      params: {
        update: { sessionUpdate: "tool_call", toolCallId: "call-1", title: "Read file", kind: "read" },
      },
    });
    expect(drafts).toEqual([{
      event_type: "tool_activity_started",
      tool_call_id: "call-1",
      tool_name: "Read file",
      tool_input_summary: null,
      tool_kind: "read",
    }]);
  });

  it("flushes a pending text segment as a boundary before a tool activity event, even mid-line", () => {
    const normalizer = createThreadEventNormalizer();
    normalizer.pushAcpTextDelta("Reading the file");
    const drafts = normalizer.pushAcpProtocolEvent({
      method: "session/update",
      params: {
        update: { sessionUpdate: "tool_call", toolCallId: "tool-1", title: "Read" },
      },
    });
    expect(drafts).toEqual([
      { event_type: "assistant_text", text: "Reading the file" },
      { event_type: "tool_activity_started", tool_call_id: "tool-1", tool_name: "Read", tool_input_summary: null, tool_kind: null },
    ]);
  });

  it("maps ACP tool_call_update's in_progress status through as a non-terminal update, not just completed/failed", () => {
    const normalizer = createThreadEventNormalizer();
    const drafts = normalizer.pushAcpProtocolEvent({
      method: "session/update",
      params: {
        update: { sessionUpdate: "tool_call_update", toolCallId: "call-1", status: "in_progress" },
      },
    });
    expect(drafts).toEqual([{
      event_type: "tool_activity_finished",
      tool_call_id: "call-1",
      status: "in_progress",
      tool_result_summary: null,
    }]);
  });

  it("marks a failed tool_result as status failed", () => {
    const normalizer = createThreadEventNormalizer();
    const drafts = normalizer.pushAcpProtocolEvent({
      method: "session/update",
      params: {
        update: { sessionUpdate: "tool_call_update", toolCallId: "call-1", status: "failed" },
      },
    });
    expect(drafts).toEqual([{
      event_type: "tool_activity_finished",
      tool_call_id: "call-1",
      status: "failed",
      tool_result_summary: null,
    }]);
  });

  it("absorbs bounded tool-result content but ignores the declined diff variant (A9)", () => {
    const normalizer = createThreadEventNormalizer();
    const drafts = normalizer.pushAcpProtocolEvent({
      method: "session/update",
      params: {
        update: {
          sessionUpdate: "tool_call_update",
          toolCallId: "call-1",
          status: "completed",
          content: [
            { type: "content", content: { type: "text", text: "command output" } },
            { type: "diff", path: "/a.ts", oldText: "old", newText: "new" },
          ],
        },
      },
    });
    expect(drafts).toEqual([{
      event_type: "tool_activity_finished",
      tool_call_id: "call-1",
      status: "succeeded",
      tool_result_summary: "command output",
    }]);
  });

  it("bounds an oversized ACP tool result instead of persisting it unbounded", () => {
    const normalizer = createThreadEventNormalizer();
    const longText = "x".repeat(5_000);
    const drafts = normalizer.pushAcpProtocolEvent({
      method: "session/update",
      params: {
        update: {
          sessionUpdate: "tool_call_update",
          toolCallId: "call-1",
          status: "completed",
          content: [{ type: "content", content: { type: "text", text: longText } }],
        },
      },
    });
    const summary = drafts[0]?.tool_result_summary ?? "";
    expect(summary.length).toBeLessThan(longText.length);
    expect(summary.endsWith("…")).toBe(true);
  });

  it("appends an ACP plan update as a JSON snapshot event", () => {
    const normalizer = createThreadEventNormalizer();
    const entries = [{ content: "Write tests", priority: "high", status: "in_progress" }];
    const drafts = normalizer.pushAcpProtocolEvent({
      method: "session/update",
      params: { update: { sessionUpdate: "plan", entries } },
    });
    expect(drafts).toEqual([{ event_type: "plan_updated", text: JSON.stringify(entries) }]);
  });
});
