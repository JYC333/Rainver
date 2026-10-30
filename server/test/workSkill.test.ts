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

it.each([null,'goal-session'])('gives a Sources goal Run only its actual actions with Session %s',sessionId=>{
 const options=workSkillOptionsForRun({id:'domain',session_id:sessionId,contract_snapshot_json:{workflow_input_json:{source_goal:{goal_id:'goal',purpose:'explore'}}},permission_snapshot_json:{tool_grants:['source.goal.read','source.goal.write_version'].map(action_id=>({action_id,capability_id:null,approval_behavior:'none',side_effecting:true}))}} as unknown as RunRecord);
 const skill=renderWorkSkill(options);expect(skill).toContain('source.goal.write_version');expect(skill).not.toContain('call task.list');expect(skill).not.toContain('task.report');expect(workSkillPromptPointer('/skill',options)).not.toContain('task.request_review');
});

it('keeps unrelated headless, Task, conversation and artifact skill consumers unchanged',()=>{
 const grants=['source.goal.read','artifact.submit'].map(action_id=>({action_id,capability_id:null,approval_behavior:'none',side_effecting:true}));
 const base={id:'other',session_id:null,permission_snapshot_json:{tool_grants:grants}};
 expect(workSkillOptionsForRun(base as unknown as RunRecord)).toEqual({conversation:false,deliverOutputs:true});
 const source={...base,contract_snapshot_json:{workflow_input_json:{source_goal:{goal_id:'goal',purpose:'repair'}}}};
 expect(renderWorkSkill(workSkillOptionsForRun(source as unknown as RunRecord))).toMatch(/^---\nname: rainver-work\ndescription: .+\n---\n/);
 expect(workSkillOptionsForRun({...base,session_id:'session'} as unknown as RunRecord).domainActions).toBeUndefined();
 expect(workSkillOptionsForRun({...source,permission_snapshot_json:{tool_grants:[...grants,{action_id:'task.report'}]}} as unknown as RunRecord).domainActions).toBeUndefined();
});
it('a collection skill describes actual grants and refuses to invent a missing submission action',()=>{
 const render=(domainActions:string[])=>renderWorkSkill({materialProcessing:true,domainActions,deliverOutputs:false});expect(render([])).toContain('No result submission action is granted');expect(render(['source.material.submit'])).toContain('Only source.material.submit is granted');expect(render(['source.material.submit'])).toContain('NOT independently verified');expect(render(['source.material.submit'])).not.toContain('native tool evidence');
});
