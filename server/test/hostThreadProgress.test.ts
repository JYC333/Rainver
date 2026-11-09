import { describe, expect, it } from "vitest";
import { createThreadEventNormalizer } from "../src/modules/hosts/threadEventNormalization.js";
import { createVendorEventNormalizer } from "../src/modules/runs/runtimeEventNormalization.js";
import { projectRunEventTurn } from "../src/modules/runs/turnProjection.js";

const frame = (sessionUpdate: string, fields: Record<string, unknown>) => ({
  method: "session/update", params: { sessionId: "session", update: { sessionUpdate, toolCallId: "tool-1", ...fields } },
});

describe("repeated ACP progress", () => {
  it("records only completed parent compaction once, without treating child compaction as parent context loss", () => {
    const normalizer = createVendorEventNormalizer("codex_cli"), at = "2026-11-05T00:00:00Z";
    expect(normalizer.push(frame("compaction_update", { status: "in_progress", compactionId: "c1" }), at)).toEqual([]);
    const completed = frame("compaction_update", { status: "completed", compactionId: "c1" });
    expect(normalizer.push(completed, at).map(event => event.type)).toEqual(["provider_compacted"]);
    expect(normalizer.push(completed, at)).toEqual([]);
    expect(normalizer.push({ ...completed, params: { ...completed.params, _rainverChildSession: true } }, at)).toEqual([]);
  });
  it.each(["completed", "failed"] as const)("keeps a %s tool terminal when full frames and old starts are replayed", status => {
    const normalizer = createVendorEventNormalizer("codex_cli");
    const updates = [
      frame("tool_call", { status: "pending" }),
      frame("tool_call", { status: "pending" }),
      frame("tool_call", { status }),
      frame("tool_call", { status }),
      frame("tool_call", { status: "in_progress" }),
      frame("tool_call_update", { status }),
    ];
    const events = updates.flatMap(update => normalizer.push(update, "2026-11-05T00:00:00Z"));
    expect(events.map(event => event.type)).toEqual(["tool_call_started", status === "failed" ? "tool_call_failed" : "tool_call_completed"]);
    const projected = projectRunEventTurn(events.map((event, event_index) => ({
      event_index, event_type: event.type, status: "succeeded", summary: event.summary ?? null,
      error_code: null, error_message: null, metadata_json: { call_id: event.call_id },
    })));
    expect(projected.parts).toMatchObject([{ type: "tool_call", status: status === "failed" ? "failed" : "succeeded" }]);
  });

  it("does not restart an inferred call when its full frame arrives late, and retains a corrected terminal state", () => {
    const normalizer = createVendorEventNormalizer("claude_code");
    const events = [
      frame("tool_call_update", { status: "completed" }),
      frame("tool_call", { status: "in_progress" }),
      frame("tool_call", { status: "failed" }),
      frame("tool_call", { status: "failed" }),
      frame("tool_call", { toolCallId: "tool-2", status: "pending" }),
    ].flatMap(update => normalizer.push(update, "2026-11-05T00:00:00Z"));
    expect(events.map(event => [event.call_id, event.type])).toEqual([
      ["tool-1", "tool_call_started"], ["tool-1", "tool_call_completed"],
      ["tool-1", "tool_call_failed"], ["tool-2", "tool_call_started"],
    ]);
  });

  it("keeps changed progress and final output while suppressing identical cumulative snapshots", () => {
    const normalizer = createThreadEventNormalizer();
    const events = normalizer.pushAcpProtocolEvent(frame("tool_call", { title: "test", status: "pending" }));
    const progress = frame("tool_call_update", { title: "test", status: "in_progress", rawOutput: "running tests" });
    for (let index = 0; index < 1000; index++) events.push(...normalizer.pushAcpProtocolEvent(progress));
    events.push(...normalizer.pushAcpProtocolEvent(frame("tool_call_update", { title: "test", status: "completed", rawOutput: "42 passed" })));
    console.info(`ACP progress: 1002 input frames, ${events.length} stored tool events`);
    expect(events).toHaveLength(3);
    expect(events.at(-1)).toMatchObject({ status: "succeeded", tool_result_summary: "42 passed" });
    expect(normalizer.pushAcpProtocolEvent(progress)).toHaveLength(0); // late progress cannot reopen a completed call
  });

  it("publishes each terminal semantic transition once even when the runtime repeats it", () => {
    const normalizer = createVendorEventNormalizer("codex_cli");
    const terminal = frame("tool_call_update", { status: "completed" });
    const events = Array.from({ length: 1000 }, () => normalizer.push(terminal, "2026-11-05T00:00:00Z")).flat();
    expect(events.map(event => event.type)).toEqual(["tool_call_started", "tool_call_completed"]);
    expect(normalizer.push(frame("tool_call_update", { status: "failed" }), "2026-11-05T00:00:01Z").map(event => event.type)).toEqual(["tool_call_failed"]);
  });

  it("keeps identical-looking calls with different ids and does not drop intervening prose", () => {
    const normalizer = createThreadEventNormalizer();
    const first = frame("tool_call_update", { status: "in_progress" });
    expect(normalizer.pushAcpProtocolEvent(first)).toHaveLength(2);
    normalizer.pushAcpTextDelta("still running");
    expect(normalizer.pushAcpProtocolEvent(first)).toMatchObject([{ event_type: "assistant_text", text: "still running" }]);
    expect(normalizer.pushAcpProtocolEvent(frame("tool_call_update", { toolCallId: "tool-2", status: "in_progress" }))).toHaveLength(2);
  });
});
