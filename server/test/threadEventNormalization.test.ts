import { describe, expect, it } from "vitest";
import { createThreadEventNormalizer } from "../src/modules/hosts/threadEventNormalization.js";

describe("createThreadEventNormalizer", () => {
  it("keeps Claude permission-check metadata out of the conversation across stderr chunks", () => {
    const normalizer = createThreadEventNormalizer("claude_code");
    const metadata = 'Unexpected case: {"type":"system","subtype":"permission_check_status","status":"checking"}';
    expect(normalizer.pushStderr(metadata.slice(0, 40))).toEqual([]);
    expect(normalizer.pushStderr(metadata.slice(40) + "\r\n" + metadata + "\npermission denied\n")).toEqual([
      { event_type: "diagnostic", text: "permission denied" },
    ]);
    normalizer.pushStderr(metadata);
    expect(normalizer.finish()).toEqual([]);
  });

  it.each([undefined, "codex_cli", "opencode"])("preserves other runtimes' diagnostics (%s)", (runtimeKey) => {
    const normalizer = createThreadEventNormalizer(runtimeKey);
    const text = 'Unexpected case: {"type":"system","subtype":"permission_check_status"}';
    expect(normalizer.pushStderr(text + "\n")).toEqual([{ event_type: "diagnostic", text }]);
  });

  it.each([
    'Unexpected case: {"type":"system","subtype":"unknown_new_event"}',
    'Unexpected case: {"type":"error","subtype":"permission_check_status"}',
    'Unexpected case: {"type":"system","subtype":"permission_check_status"',
    'Error: permission_check_status failed',
    "You've reached your Fable limit",
  ])("preserves errors and unknown Claude diagnostics: %s", (text) => {
    const normalizer = createThreadEventNormalizer("claude_code");
    expect(normalizer.pushStderr(text + "\n")).toEqual([{ event_type: "diagnostic", text }]);
    normalizer.pushStderr(text);
    expect(normalizer.finish()).toEqual([{ event_type: "diagnostic", text }]);
  });

  it.each(["completed", "failed"])("retains exit metadata and the output tail without classifying warnings (%s)", (status) => {
    const normalizer = createThreadEventNormalizer();
    const text = "[WARN] engine mismatch\n" + "log line\n".repeat(1000) + "test failure at the end";
    const rows = normalizer.pushAcpProtocolEvent({ method: "session/update", params: { update: {
      sessionUpdate: "tool_call_update", toolCallId: "exec", status,
      rawOutput: { formatted_output: text, exit_code: status === "failed" ? "1" : 0 },
    } } });
    const event = rows.at(-1)!;
    expect(event.status).toBe(status === "failed" ? "failed" : "succeeded");
    const result = JSON.parse(event.tool_result_summary!);
    expect(result.exit_code).toBe(status === "failed" ? 1 : 0);
    expect(result.truncated).toBe(true);
    expect(result.formatted_output).toHaveLength(4000);
    expect(result.formatted_output).toContain("[WARN] engine mismatch");
    expect(result.formatted_output).toContain("test failure at the end");
  });

  it("retains an exit code when command output was redirected", () => {
    const normalizer = createThreadEventNormalizer();
    const rows = normalizer.pushAcpProtocolEvent({ method: "session/update", params: { update: {
      sessionUpdate: "tool_call_update", toolCallId: "exec", status: "failed",
      rawOutput: { formatted_output: "", exit_code: "1" },
    } } });
    expect(JSON.parse(rows.at(-1)!.tool_result_summary!)).toEqual({ formatted_output: "", exit_code: 1, truncated: false });
  });
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
    expect(normalizer.pushAcpTextDelta("ld\n")).toEqual([{ event_type: "assistant_text", text: "Hello world\n" }]);
  });

  it("emits tool_activity_started with tool_kind from an ACP tool_call update", () => {
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
      tool_result_summary: null,
      status: "pending",
    }]);
  });

  it("redacts and bounds an ACP command title while preserving its opaque call id", () => {
    const normalizer = createThreadEventNormalizer();
    const callId = `provider:${"id".repeat(100)}`;
    const secret = "sk-abcdefghijklmnop123456";
    const drafts = normalizer.pushAcpProtocolEvent({
      method: "session/update",
      params: {
        update: {
          sessionUpdate: "tool_call",
          toolCallId: callId,
          title: `curl -H 'Bearer ${secret}' https://example.test/${"x".repeat(5_000)}`,
        },
      },
    });
    expect(drafts[0]?.tool_call_id).toBe(callId);
    expect(drafts[0]?.tool_name).not.toContain(secret);
    expect(drafts[0]?.tool_name).toContain("[REDACTED_SECRET]");
    expect(drafts[0]?.tool_name?.endsWith("...[truncated]")).toBe(true);
    expect(drafts[0]?.tool_name?.length).toBeLessThan(256);
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
      {
        event_type: "tool_activity_started", tool_call_id: "tool-1", tool_name: "Read",
        tool_input_summary: null, tool_kind: null, tool_result_summary: null, status: "pending",
      },
    ]);
  });

  it("maps ACP tool_call_update's in_progress status through as a non-terminal update, not just completed/failed", () => {
    const normalizer = createThreadEventNormalizer();
    normalizer.pushAcpProtocolEvent({
      method: "session/update",
      params: { update: { sessionUpdate: "tool_call", toolCallId: "call-1" } },
    });
    const drafts = normalizer.pushAcpProtocolEvent({
      method: "session/update",
      params: {
        update: { sessionUpdate: "tool_call_update", toolCallId: "call-1", status: "in_progress" },
      },
    });
    expect(drafts).toEqual([{
      event_type: "tool_activity_finished",
      tool_call_id: "call-1",
      tool_name: null,
      tool_input_summary: null,
      tool_kind: null,
      status: "in_progress",
      tool_result_summary: null,
    }]);
  });

  it("marks a failed tool_result as status failed", () => {
    const normalizer = createThreadEventNormalizer();
    normalizer.pushAcpProtocolEvent({
      method: "session/update",
      params: { update: { sessionUpdate: "tool_call", toolCallId: "call-1" } },
    });
    const drafts = normalizer.pushAcpProtocolEvent({
      method: "session/update",
      params: {
        update: { sessionUpdate: "tool_call_update", toolCallId: "call-1", status: "failed" },
      },
    });
    expect(drafts).toEqual([{
      event_type: "tool_activity_finished",
      tool_call_id: "call-1",
      tool_name: null,
      tool_input_summary: null,
      tool_kind: null,
      status: "failed",
      tool_result_summary: null,
    }]);
  });

  it("absorbs bounded tool-result content but ignores the declined diff variant (A9)", () => {
    const normalizer = createThreadEventNormalizer();
    normalizer.pushAcpProtocolEvent({
      method: "session/update",
      params: { update: { sessionUpdate: "tool_call", toolCallId: "call-1" } },
    });
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
      tool_name: null,
      tool_input_summary: null,
      tool_kind: null,
      status: "succeeded",
      tool_result_summary: "command output",
    }]);
  });

  it("bounds an oversized ACP tool result instead of persisting it unbounded", () => {
    const normalizer = createThreadEventNormalizer();
    normalizer.pushAcpProtocolEvent({
      method: "session/update",
      params: { update: { sessionUpdate: "tool_call", toolCallId: "call-1" } },
    });
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
    expect(summary).toContain("[output truncated; middle omitted]");
    expect(summary.endsWith("x")).toBe(true);
  });

  it("redacts credentials from persisted tool input and result summaries", () => {
    const token = "ghp_" + "A1b2C3d4".repeat(4);
    const update = (rawOutput: unknown, content?: unknown) => {
      const normalizer = createThreadEventNormalizer();
      normalizer.pushAcpProtocolEvent({ method: "session/update", params: { update: { sessionUpdate: "tool_call", toolCallId: "call-1" } } });
      return normalizer.pushAcpProtocolEvent({
        method: "session/update",
        params: { update: { sessionUpdate: "tool_call_update", toolCallId: "call-1", status: "completed",
          rawInput: { command: `curl -H 'Authorization: Bearer ${token}'` }, rawOutput, ...(content ? { content } : {}) } },
      })[0]!;
    };
    for (const draft of [
      update(`GITHUB_TOKEN=${token}`),
      update({ formatted_output: `${"x".repeat(5_000)} ${token}`, exit_code: 0 }),
      update(undefined, [{ type: "content", content: { type: "text", text: `token: ${token}` } }]),
      update(`${token} ${"y".repeat(200_000)}`),
    ]) {
      expect(draft.tool_result_summary).not.toContain(token);
      expect(draft.tool_result_summary).toContain("[REDACTED_SECRET]");
      expect(draft.tool_input_summary).not.toContain(token);
    }
  });

  it("repairs an update whose ACP start event is missing", () => {
    const normalizer = createThreadEventNormalizer();
    const drafts = normalizer.pushAcpProtocolEvent({
      method: "session/update",
      params: {
        update: {
          sessionUpdate: "tool_call_update",
          toolCallId: "call-1",
          title: "Search",
          status: "completed",
        },
      },
    });
    expect(drafts.map((draft) => [draft.event_type, draft.tool_call_id])).toEqual([
      ["tool_activity_started", "call-1"],
      ["tool_activity_finished", "call-1"],
    ]);
  });

  it("assigns one stable local id to an anonymous ACP tool lifecycle", () => {
    const normalizer = createThreadEventNormalizer();
    const started = normalizer.pushAcpProtocolEvent({
      method: "session/update",
      params: { update: { sessionUpdate: "tool_call", title: "task.create" } },
    });
    const finished = normalizer.pushAcpProtocolEvent({
      method: "session/update",
      params: { update: { sessionUpdate: "tool_call_update", title: "task.create", status: "completed" } },
    });
    expect(started[0]?.tool_call_id).toMatch(/^rainver:acp:anonymous:/);
    expect(finished[0]?.tool_call_id).toBe(started[0]?.tool_call_id);
  });

  it("keeps one lifecycle when only the update supplies the provider id", () => {
    const normalizer = createThreadEventNormalizer();
    const started = normalizer.pushAcpProtocolEvent({
      method: "session/update",
      params: { update: { sessionUpdate: "tool_call", title: "task.create" } },
    });
    const finished = normalizer.pushAcpProtocolEvent({
      method: "session/update",
      params: {
        update: {
          sessionUpdate: "tool_call_update",
          toolCallId: "provider-call-1",
          title: "task.create",
          status: "completed",
        },
      },
    });
    expect(finished).toHaveLength(1);
    expect(finished[0]?.event_type).toBe("tool_activity_finished");
    expect(finished[0]?.tool_call_id).toBe(started[0]?.tool_call_id);
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

  describe("reasoning", () => {
    it("keeps a runtime's own reasoning channel apart from its answer", () => {
      const normalizer = createThreadEventNormalizer();
      expect(normalizer.pushAcpThoughtDelta("weighing options\n")).toEqual([
        { event_type: "assistant_thought", text: "weighing options\n" },
      ]);
      expect(normalizer.pushAcpTextDelta("the answer\n")).toEqual([
        { event_type: "assistant_text", text: "the answer\n" },
      ]);
    });

    it("preserves channel arrival order across partial chunks", () => {
      const normalizer = createThreadEventNormalizer();
      const drafts = [
        ...normalizer.pushAcpTextDelta("I will inspect"),
        ...normalizer.pushAcpThoughtDelta("considering"),
        ...normalizer.pushAcpTextDelta("The answer"),
        ...normalizer.finish(),
      ];
      expect(drafts).toEqual([
        { event_type: "assistant_text", text: "I will inspect" },
        { event_type: "assistant_thought", text: "considering" },
        { event_type: "assistant_text", text: "The answer" },
      ]);
    });

    it("does not infer thought from message text", () => {
      const normalizer = createThreadEventNormalizer();
      const drafts = [
        ...normalizer.pushAcpTextDelta("<thi"),
        ...normalizer.pushAcpTextDelta("nk>reasoning"),
        ...normalizer.pushAcpTextDelta("</thin"),
        ...normalizer.pushAcpTextDelta("k>answer"),
        ...normalizer.finish(),
      ];
      expect(drafts).toEqual([
        { event_type: "assistant_text", text: "<think>reasoning</think>answer" },
      ]);
    });

    it("emits an unterminated tag as the text it literally is", () => {
      // A model writing about the tag, or a turn cut off mid-tag: losing the
      // characters would be worse than showing them.
      const normalizer = createThreadEventNormalizer();
      const drafts = [...normalizer.pushAcpTextDelta("use <thi"), ...normalizer.finish()];
      expect(drafts).toEqual([{ event_type: "assistant_text", text: "use <thi" }]);
    });

    it("leaves text with no reasoning in it completely untouched", () => {
      const normalizer = createThreadEventNormalizer();
      expect(normalizer.pushAcpTextDelta("a < b and c > d\n")).toEqual([
        { event_type: "assistant_text", text: "a < b and c > d\n" },
      ]);
    });
  });
});
