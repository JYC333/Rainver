import {describe,expect,it} from "vitest";
import {projectChatCapabilities} from "../src/modules/agents/routes";
import {proposalActionJsonSchema} from "../src/modules/systemActions/agentToolGateway";

describe("Project Chat tool permissions",()=>{
  it("does not expose proposal tools without AgentVersion permission",()=>{
    expect(projectChatCapabilities({})).toEqual([]);
  });
  it("declares only explicitly allowed tools for run grant provisioning",()=>{
    const permissions={allowed_tools:["project.source.propose_bind"]};
    expect(projectChatCapabilities(permissions)).toEqual(["project.source.propose_bind"]);
  });
  it("publishes required model fields for proposal tools",()=>{
    expect(proposalActionJsonSchema("project.source.propose_bind")).toMatchObject({required:["source_channel_id"]});
    expect(proposalActionJsonSchema("source.backfill.propose_start")).toMatchObject({required:["source_channel_id","source_backfill_plan_id"]});
  });
});
