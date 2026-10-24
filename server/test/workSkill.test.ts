import { describe, expect, it } from "vitest";
import { renderWorkSkill, workSkillPromptPointer } from "../src/modules/skills/workSkill.js";
import { selectToolBridgeProtocol, workSkillOptionsForRun } from "../src/modules/runs/runWorkSurface.js";
import type { RunRecord } from "../src/modules/runs/repository.js";

// Do not render one Skill text for every remote run. A Room turn's reply
// is the Room message. Do not tell the agent it reached nobody, and do not
// send it to `artifact.submit`. A conversation is never granted that tool.
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
    expect(skill).toContain("Artifact type labels");
    expect(skill).toContain("RAINVER_TOOL_BRIDGE");
    expect(skill).toContain("ordinary command sandbox");
    expect(skill).toContain("rather than retrying with broader permissions");
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

// Every Run with tool grants failed on a macOS Host while `file-v1` was sent
// unconditionally; a Host that cannot pin the bridge keeps direct HTTP.
describe("the tool channel a Host is offered", () => {
  const capabilities = (tool_bridge_protocols?: string[]) => ({
    runtimes: [], versions: {}, installations: {}, ...(tool_bridge_protocols ? { tool_bridge_protocols } : {}),
  });

  it("follows what the daemon advertises, on any platform", () => {
    expect(selectToolBridgeProtocol({ platform: "darwin", capabilities_json: capabilities(["file-v1"]) })).toBe("file-v1");
    expect(selectToolBridgeProtocol({ platform: "linux", capabilities_json: capabilities(["file-v1"]) })).toBe("file-v1");
    expect(selectToolBridgeProtocol({ platform: "win32", capabilities_json: capabilities([]) })).toBeNull();
  });

  it("assumes file-v1 only on Linux for daemons that predate the report", () => {
    expect(selectToolBridgeProtocol({ platform: "linux", capabilities_json: capabilities() })).toBe("file-v1");
    expect(selectToolBridgeProtocol({ platform: "darwin", capabilities_json: capabilities() })).toBeNull();
    expect(selectToolBridgeProtocol({ platform: null, capabilities_json: null })).toBeNull();
  });
});
