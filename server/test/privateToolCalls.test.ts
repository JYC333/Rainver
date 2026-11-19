import { describe, expect, it } from "vitest";
import { createPrivateToolCallFilter, PRIVATE_TOOL_CALL_TRACKING_LIMIT } from "../src/modules/runtimeAdapters/privateToolCalls.js";

const event = (update: Record<string, unknown>) => ({ method: "session/update", params: { sessionId: "s", update } });
const privateStart = (id: string) => event({ sessionUpdate: "tool_call", toolCallId: id, status: "pending", title: "rainver call source.gmail.monitor.propose '{}'" });
const output = (id: string | undefined, status = "completed") =>
  event({ sessionUpdate: "tool_call_update", ...(id ? { toolCallId: id } : {}), status, rawOutput: { text: "out" } });
const updateOf = (value: Record<string, unknown>) => (value.params as { update: Record<string, unknown> }).update;

describe("createPrivateToolCallFilter tracking bounds", () => {
  it("keeps ordinary calls unchanged while tracking stays within its limit", () => {
    const filter = createPrivateToolCallFilter();
    for (let i = 0; i < PRIVATE_TOOL_CALL_TRACKING_LIMIT; i += 1) filter(privateStart(`p${i}`));
    expect(updateOf(filter(output("p0")))).toEqual({ sessionUpdate: "tool_call_update", toolCallId: "p0", status: "completed", title: "source.gmail.monitor.propose" });
    // No private id has been dropped: an update without a seen start is passed through.
    const unseen = output("never-started");
    expect(filter(unseen)).toBe(unseen);
    const ordinary = event({ sessionUpdate: "tool_call", toolCallId: "ls", title: "ls" });
    expect(filter(ordinary)).toBe(ordinary);
  });

  it("still reduces late updates after the oldest private id is dropped, while remembered ordinary calls keep their output", () => {
    const filter = createPrivateToolCallFilter();
    filter(event({ sessionUpdate: "tool_call", toolCallId: "ls", title: "ls" }));
    for (let i = 0; i <= PRIVATE_TOOL_CALL_TRACKING_LIMIT; i += 1) filter(privateStart(`p${i}`));
    // p0 was dropped at capacity; its late update cannot be confirmed ordinary.
    expect(updateOf(filter(output("p0")))).toEqual({ sessionUpdate: "tool_call_update", toolCallId: "p0", status: "completed" });
    expect(updateOf(filter(output(`p${PRIVATE_TOOL_CALL_TRACKING_LIMIT}`)))).toMatchObject({ title: "source.gmail.monitor.propose" });
    const ordinaryOutput = output("ls");
    expect(filter(ordinaryOutput)).toBe(ordinaryOutput);
    const freshStart = event({ sessionUpdate: "tool_call", toolCallId: "cat", title: "cat" });
    expect(filter(freshStart)).toBe(freshStart);
    const freshOutput = output("cat");
    expect(filter(freshOutput)).toBe(freshOutput);
  });

  it("keeps a private call reduced for updates after its terminal status", () => {
    const filter = createPrivateToolCallFilter();
    filter(privateStart("g"));
    filter(output("g", "failed"));
    expect(updateOf(filter(output("g", "completed")))).not.toHaveProperty("rawOutput");
  });

  it("reduces anonymous updates neutrally for the rest of the session once a private anonymous call was seen", () => {
    const filter = createPrivateToolCallFilter();
    const before = output(undefined);
    expect(filter(before)).toBe(before);
    expect(updateOf(filter(event({ sessionUpdate: "tool_call", status: "pending", title: "rainver call source.gmail.monitor.propose '{}'" }))))
      .toEqual({ sessionUpdate: "tool_call", status: "pending", title: "source.gmail.monitor.propose" });
    const neutral = { sessionUpdate: "tool_call_update", status: "completed" };
    expect(updateOf(filter(output(undefined)))).toEqual(neutral);
    // An ordinary anonymous start still passes through but does not clear the marker.
    const ordinaryStart = event({ sessionUpdate: "tool_call", title: "ls" });
    expect(filter(ordinaryStart)).toBe(ordinaryStart);
    expect(updateOf(filter(output(undefined)))).toEqual(neutral);
    expect(updateOf(filter(output(undefined, "failed")))).toEqual({ sessionUpdate: "tool_call_update", status: "failed" });
    // Calls with ids keep their own attribution.
    const withId = event({ sessionUpdate: "tool_call", toolCallId: "cat", title: "cat" });
    expect(filter(withId)).toBe(withId);
    const withIdOutput = output("cat");
    expect(filter(withIdOutput)).toBe(withIdOutput);
  });
});
