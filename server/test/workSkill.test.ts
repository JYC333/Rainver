import { describe, expect, it } from "vitest";
import { renderWorkSkill, workSkillPromptPointer } from "../src/modules/capabilities/workSkill.js";
import { workSkillOptionsForRun } from "../src/modules/runs/runWorkSurface.js";
import type { RunRecord } from "../src/modules/runs/repository.js";

// One Skill text was rendered for every remote run. For a Room turn it told
// the agent its reply reached nobody — when the reply *is* the Room message —
// and sent it to `artifact.submit`, which a conversation is never granted.
describe("the Skill a Run is given", () => {
  const run = (overrides: Partial<RunRecord>): RunRecord => ({
    id: "run-1",
    session_id: null,
    permission_snapshot_json: { tool_grants: [] },
    ...overrides,
  } as unknown as RunRecord);
  const grants = (...ids: string[]) => ({
    tool_grants: ids.map((action_id) => ({ action_id, capability_id: null, approval_behavior: "none", side_effecting: true })),
  });

  it("tells a conversation turn that its reply is the message the person reads", () => {
    const options = workSkillOptionsForRun(run({ session_id: "session-1", permission_snapshot_json: grants("task.create") }));
    expect(options).toEqual({ conversation: true, deliverOutputs: false });
    const skill = renderWorkSkill(options);
    expect(skill).toContain("Your reply is the message they read");
    expect(skill).toContain("project.propose_definition");
    expect(skill).not.toContain("reaches it");
    expect(skill).not.toContain("artifact.submit");
    const pointer = workSkillPromptPointer("/host/SKILL.md", options);
    expect(pointer).toContain("Your reply is the message they read");
    expect(pointer).not.toContain("reaches nobody");
  });

  it("keeps the dispatched-Task text, with output delivery only when artifact.submit was granted", () => {
    const dispatched = workSkillOptionsForRun(run({ permission_snapshot_json: grants("task.report", "artifact.submit") }));
    expect(dispatched).toEqual({ conversation: false, deliverOutputs: true });
    expect(renderWorkSkill(dispatched)).toContain("Nothing you write in your reply reaches it");
    expect(renderWorkSkill(dispatched)).toContain("artifact.submit");

    const ungranted = workSkillOptionsForRun(run({ permission_snapshot_json: grants("task.report") }));
    expect(ungranted.deliverOutputs).toBe(false);
    expect(renderWorkSkill(ungranted)).not.toContain("artifact.submit");
    expect(workSkillPromptPointer("/host/SKILL.md", ungranted)).not.toContain("artifact.submit");
  });
});
