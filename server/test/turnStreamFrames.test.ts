import { describe, expect, it } from "vitest";
import type { RunTurn, TurnPart } from "@rainver/protocol";
import {
  fingerprintPart,
  turnDiffFrames,
} from "../src/modules/streaming/turnStream.js";

function turn(parts: TurnPart[], state: RunTurn["state"] = "working"): RunTurn {
  return {
    schema_version: "run_turn.v1",
    run_id: "run-1",
    state,
    source: "run_events",
    parts,
    blocked_on: null,
    cursor: parts.length,
    updated_at: null,
  };
}

const tool = (index: number, name: string, status: "running" | "succeeded" = "running"): TurnPart =>
  ({ type: "tool_call", index, call_id: `c${index}`, name, kind: null, status, input: null, output: null });

const preview = (index: number): TurnPart => ({
  type: "action_preview", index, action_id: "a1", tool_call_id: null, status: "proposed",
  proposal_id: "p1", proposal_type: "memory_create", title: "Remember it",
  summary: null, risk_level: "low", scope: null,
});

describe("turn stream frames", () => {
  it("appends what is new and updates what changed, in place", () => {
    const before = [tool(0, "read")].map(fingerprintPart);
    const frames = turnDiffFrames(before, turn([tool(0, "read", "succeeded"), tool(1, "write")]), "run-1", 2);
    expect(frames.map((frame) => frame.type)).toEqual(["turn.part_updated", "turn.part_appended"]);
    expect(frames[0]).toMatchObject({ part: { index: 0, status: "succeeded" } });
    expect(frames[1]).toMatchObject({ part: { index: 1, name: "write" } });
  });

  it("says nothing when nothing changed", () => {
    const parts = [tool(0, "read"), preview(1)];
    expect(turnDiffFrames(parts.map(fingerprintPart), turn(parts), "run-1", 2)).toEqual([]);
  });

  it("resends the whole turn when a Proposal is pushed along by a later step", () => {
    // Proposals are appended after the projection, so a tool call arriving
    // later shifts them. Reported as per-part updates, the client would see
    // index 1 turn from a Proposal into a tool call and could not tell that
    // the Proposal had moved rather than been replaced.
    const before = [tool(0, "read"), preview(1)].map(fingerprintPart);
    const frames = turnDiffFrames(before, turn([tool(0, "read"), tool(1, "write"), preview(2)]), "run-1", 3);
    expect(frames).toHaveLength(1);
    expect(frames[0]!.type).toBe("turn.snapshot");
    expect(frames[0]).toMatchObject({
      turn: { parts: [{ type: "tool_call" }, { type: "tool_call" }, { type: "action_preview" }] },
    });
  });

  it("never lets a client's index change type without a snapshot", () => {
    // The property the frame protocol has to hold: replaying frames onto what
    // a client already has must never put a part of one kind where a part of
    // another kind was.
    const steps: TurnPart[][] = [
      [tool(0, "read")],
      [tool(0, "read"), preview(1)],
      [tool(0, "read"), tool(1, "write"), preview(2)],
      [tool(0, "read"), tool(1, "write", "succeeded"), preview(2)],
    ];
    const held: Record<number, string> = {};
    let seen: string[] = [];
    for (const parts of steps) {
      for (const frame of turnDiffFrames(seen, turn(parts), "run-1", parts.length)) {
        if (frame.type === "turn.snapshot") {
          for (const key of Object.keys(held)) delete held[Number(key)];
          frame.turn.parts.forEach((part) => { held[part.index] = part.type; });
          continue;
        }
        if (frame.type === "turn.state_changed") continue;
        const before = held[frame.part.index];
        expect(before === undefined || before === frame.part.type).toBe(true);
        held[frame.part.index] = frame.part.type;
      }
      seen = parts.map(fingerprintPart);
    }
    expect(Object.values(held)).toEqual(["tool_call", "tool_call", "action_preview"]);
  });
});
