import { describe, expect, it } from "vitest";
import {
  appendActionPreviewParts,
  projectHostThreadTurn,
  projectRunEventTurn,
  type HostThreadEventRow,
  type RunEventRow,
} from "../src/modules/runs/turnProjection.js";

function hostRow(row: Partial<HostThreadEventRow> & { event_index: number; event_type: string }): HostThreadEventRow {
  return {
    text: null, tool_call_id: null, tool_name: null, tool_input_summary: null,
    tool_kind: null, tool_result_summary: null, status: null, ...row,
  };
}

function runRow(row: Partial<RunEventRow> & { event_index: number; event_type: string }): RunEventRow {
  return { status: "succeeded", summary: null, error_code: null, error_message: null, metadata_json: null, ...row };
}

describe("turn projection", () => {
  it("coalesces consecutive prose into one part, and keeps reasoning separate", () => {
    const { parts } = projectHostThreadTurn([
      hostRow({ event_index: 0, event_type: "assistant_thought", text: "Let me look." }),
      hostRow({ event_index: 1, event_type: "assistant_text", text: "The file " }),
      hostRow({ event_index: 2, event_type: "assistant_text", text: "is empty." }),
    ]);
    expect(parts).toEqual([
      { type: "reasoning", index: 0, text: "Let me look." },
      { type: "text", index: 1, text: "The file is empty." },
    ]);
  });

  it("builds one tool part from the started/finished pair, keeping its place in the turn", () => {
    const { parts } = projectHostThreadTurn([
      hostRow({ event_index: 0, event_type: "tool_activity_started", tool_call_id: "c1", tool_name: "read", tool_kind: "read", tool_input_summary: "src/a.ts" }),
      hostRow({ event_index: 1, event_type: "assistant_text", text: "Reading." }),
      hostRow({ event_index: 2, event_type: "tool_activity_finished", tool_call_id: "c1", status: "succeeded", tool_result_summary: "42 lines" }),
    ]);
    expect(parts).toEqual([
      { type: "tool_call", index: 0, call_id: "c1", name: "read", kind: "read", status: "succeeded", input: "src/a.ts", output: "42 lines" },
      { type: "text", index: 1, text: "Reading." },
    ]);
  });

  it("reports an update without its tool call as a protocol error", () => {
    const { parts } = projectHostThreadTurn([
      hostRow({ event_index: 7, event_type: "tool_activity_finished", tool_call_id: "c9", status: "failed", tool_result_summary: "exit 1" }),
    ]);
    expect(parts).toMatchObject([{
      type: "tool_call", call_id: "c9", name: "Tool call not found",
      status: "failed", output: "Tool call not found",
    }]);
  });

  it("replaces the plan rather than accumulating one part per revision", () => {
    const { parts } = projectHostThreadTurn([
      hostRow({ event_index: 0, event_type: "plan_updated", text: JSON.stringify([{ content: "Look", status: "in_progress" }]) }),
      hostRow({ event_index: 1, event_type: "plan_updated", text: JSON.stringify([{ content: "Look", status: "completed" }, { content: "Fix", status: "pending" }]) }),
    ]);
    expect(parts).toEqual([{
      type: "plan", index: 0,
      entries: [{ content: "Look", status: "completed" }, { content: "Fix", status: "pending" }],
    }]);
  });

  it("reports the same turn from either log, to each backend's own detail", () => {
    // The same turn: one tool call that succeeded, then a reply. A host Run
    // records the tool's input and output; a managed Run records only that
    // the tool ran, and its prose survives as the stored reply.
    const host = projectHostThreadTurn([
      hostRow({ event_index: 0, event_type: "tool_activity_started", tool_call_id: "c1", tool_name: "search", tool_input_summary: "rainver" }),
      hostRow({ event_index: 1, event_type: "tool_activity_finished", tool_call_id: "c1", status: "succeeded", tool_result_summary: "3 hits" }),
      hostRow({ event_index: 2, event_type: "assistant_text", text: "Found three." }),
      hostRow({ event_index: 3, event_type: "status", status: "run_succeeded" }),
    ]);
    const managed = projectRunEventTurn([
      runRow({ event_index: 0, event_type: "tool_call_started", status: "running", metadata_json: { call_id: "c1", tool_name: "search" } }),
      runRow({ event_index: 1, event_type: "tool_call_completed", metadata_json: { call_id: "c1", tool_name: "search" } }),
      // `chat_completed` is the turn's terminal, because it is appended after
      // the assistant message the reply comes from. Nothing earlier is.
      runRow({ event_index: 2, event_type: "chat_completed", status: "succeeded" }),
    ], { replyText: "Found three." });

    // Same shape, same order, same states.
    expect(host.parts.map((part) => part.type)).toEqual(["tool_call", "text"]);
    expect(managed.parts.map((part) => part.type)).toEqual(["tool_call", "text"]);
    // Neither backend calls the turn finished on its own say-so: the host
    // writes `run_succeeded` from inside the adapter and the managed side
    // writes `state_transition`, both before the reply is written. Only
    // `chat_completed` ends a chat turn, and it lives in `run_events` for
    // both — so the host projection alone cannot see it (`loadRunTurn` reads
    // it separately) and the managed one here does.
    expect(host.state).toBe("working");
    expect(managed.state).toBe("done");
    expect(host.parts[1]).toMatchObject({ type: "text", text: "Found three." });
    expect(managed.parts[1]).toMatchObject({ type: "text", text: "Found three." });

    // And the difference is stated, not hidden: the managed backend reported
    // no tool input or output, so those are null rather than invented.
    expect(host.parts[0]).toMatchObject({ name: "search", status: "succeeded", input: "rainver", output: "3 hits" });
    expect(managed.parts[0]).toMatchObject({ name: "search", status: "succeeded", input: null, output: null });
  });

  it("stays working until the reply exists, whatever the adapter already said", () => {
    // The adapter returning and the Run going terminal both happen before
    // the assistant message is written. A turn that called itself done there
    // would send a reader to fetch a reply that is not there yet.
    const midway = projectRunEventTurn([
      runRow({ event_index: 0, event_type: "tool_call_started", status: "running", metadata_json: { call_id: "c", tool_name: "t" } }),
      runRow({ event_index: 1, event_type: "state_transition", metadata_json: { state: "succeeded" } }),
    ]);
    expect(midway.state).toBe("working");

    const finished = projectRunEventTurn([
      runRow({ event_index: 1, event_type: "state_transition", metadata_json: { state: "succeeded" } }),
      runRow({ event_index: 2, event_type: "chat_completed", status: "succeeded" }),
    ], { replyText: "Done." });
    expect(finished.state).toBe("done");
  });

  it("upserts repeated tool calls with the same id, as ACP defines", () => {
    const duplicated = projectHostThreadTurn([
      hostRow({ event_index: 0, event_type: "tool_activity_started", tool_call_id: "c1", tool_name: "one" }),
      hostRow({ event_index: 1, event_type: "tool_activity_started", tool_call_id: "c1", tool_name: "two" }),
      hostRow({ event_index: 2, event_type: "tool_activity_finished", tool_call_id: "c1", status: "succeeded" }),
    ]);
    expect(duplicated.parts).toHaveLength(1);
    expect(duplicated.parts[0]).toMatchObject({ name: "two", status: "succeeded" });
  });

  it("keeps every status update on one tool-call entry", () => {
    const projected = projectHostThreadTurn([
      hostRow({ event_index: 0, event_type: "tool_activity_started", tool_call_id: "c1", tool_name: "task", tool_kind: "think", status: "pending" }),
      hostRow({ event_index: 1, event_type: "tool_activity_finished", tool_call_id: "c1", status: "in_progress" }),
      hostRow({ event_index: 2, event_type: "tool_activity_finished", tool_call_id: "c1", status: "in_progress" }),
      hostRow({ event_index: 3, event_type: "tool_activity_finished", tool_call_id: "c1", status: "succeeded", tool_result_summary: "done" }),
    ]);
    expect(projected.parts).toEqual([{
      type: "tool_call", index: 0, call_id: "c1", name: "task", kind: "think",
      status: "succeeded", input: null, output: "done",
    }]);
  });

  it("carries a managed failure as a diagnostic and fails the turn", () => {
    const { parts, state } = projectRunEventTurn([
      runRow({ event_index: 0, event_type: "error", status: "failed", error_code: "provider_unavailable", error_message: "Upstream refused." }),
    ]);
    expect(state).toBe("failed");
    expect(parts).toEqual([{
      type: "diagnostic", index: 0, level: "error",
      text: "Upstream refused.", error_code: "provider_unavailable",
    }]);
  });

  it("reports the cursor it consumed so a stream resumes instead of replaying", () => {
    expect(projectHostThreadTurn([
      hostRow({ event_index: 4, event_type: "assistant_text", text: "a" }),
      hostRow({ event_index: 9, event_type: "assistant_text", text: "b" }),
    ]).cursor).toBe(9);
    expect(projectRunEventTurn([]).cursor).toBe(0);
  });

  it("appends Proposals after the steps that raised them", () => {
    const projected = appendActionPreviewParts(
      projectHostThreadTurn([hostRow({ event_index: 0, event_type: "assistant_text", text: "Done." })]),
      [{
        action_id: "a1", tool_call_id: "c1", status: "proposed", proposal_id: "p1",
        proposal_type: "memory_create", title: "Remember it", summary: null,
        risk_level: "low", scope: null,
      }],
    );
    expect(projected.parts.map((part) => part.type)).toEqual(["text", "action_preview"]);
    expect(projected.parts[1]).toMatchObject({ index: 1, action_id: "a1", proposal_id: "p1" });
  });
});
