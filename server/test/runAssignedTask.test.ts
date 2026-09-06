import { describe, expect, it } from "vitest";
import { runAssignedTask } from "../src/modules/runs/runAssignedTask.js";

/**
 * What a sibling Agent is shown of another Agent's Run.
 *
 * A Room turn's `runs.prompt` is the whole assembled prompt — Project state,
 * the conversation's recent messages, the execution rules, and that Agent's
 * own persona and notes. Handing it to a different Agent, which is what the
 * fan-out handover and `agent.wait_for_results` did, carries one Agent's
 * memory of itself into another's vendor session
 * ([ADR 0003](../../.agent/decisions/0003-memory-proposal-flow.md) §4, B68).
 */

const ROOM_TURN = {
  prompt: "[What you have learned about yourself]\nI answer briefly.\n\n[Assigned task]\nCompare the vendors",
  model_override_json: { chat_turn: { schema_version: "chat_turn.v1", assigned_task: "Compare the vendors" } },
};

describe("what a sibling Agent is told this Run was asked", () => {
  it("gives the task, never the prompt that carries another Agent's identity", () => {
    expect(runAssignedTask(ROOM_TURN)).toBe("Compare the vendors");
    expect(runAssignedTask(ROOM_TURN)).not.toContain("I answer briefly.");
  });

  it("gives a delegated child its own instruction, not the parent's task or its identity", () => {
    // A delegated child inherits its parent's `chat_turn` wholesale, so the
    // parent's task travels with it unless it is replaced — and then the
    // Manager's request would stand where every child's own instruction
    // belongs. Its prompt is no answer either: a delegated specialist runs in
    // the same vendor session as one that was @-mentioned, so its prompt opens
    // with its own identity block.
    const child = {
      prompt: "[What you have learned about yourself]\nI answer briefly.\n\nRead vendor A's SOC 2 report",
      model_override_json: {
        chat_turn: {
          schema_version: "chat_turn.v1",
          assigned_task: "Read vendor A's SOC 2 report",
          agent_id: "agent-child",
        },
      },
    };
    expect(runAssignedTask(child)).toBe("Read vendor A's SOC 2 report");
    expect(runAssignedTask(child)).not.toContain("I answer briefly.");
  });

  it("falls back to the prompt for a Run that was asked one thing", () => {
    // An Automation or an evolution run has no assembled prompt to separate
    // from: what it was asked *is* its prompt.
    expect(runAssignedTask({ prompt: "Run the weekly digest", model_override_json: null }))
      .toBe("Run the weekly digest");
    expect(runAssignedTask({ prompt: null, model_override_json: null })).toBeNull();
  });
});
