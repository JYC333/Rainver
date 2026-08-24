import {describe,expect,it} from "vitest";
import {projectChatCapabilities} from "../src/modules/agents/routes";
import {loadProtocol} from "../src/modules/providers/protocolRuntime";

describe("Project Chat tool permissions",()=>{
  it("does not expose proposal tools without AgentVersion permission",()=>{
    expect(projectChatCapabilities({})).toEqual([]);
  });
  it("declares only explicitly allowed tools for run grant provisioning",()=>{
    const permissions={allowed_tools:["project.source.propose_bind"]};
    expect(projectChatCapabilities(permissions)).toEqual(["project.source.propose_bind"]);
  });
  it("publishes required model fields for proposal tools, derived from the Zod that validates them",async ()=>{
    const {SYSTEM_ACTION_REGISTRY,systemActionInputJsonSchema}=await loadProtocol();
    const definitionFor=(id:string)=>{
      const found=SYSTEM_ACTION_REGISTRY.find((definition)=>definition.id===id);
      if(!found) throw new Error(`Missing system action definition: ${id}`);
      return found;
    };
    expect(systemActionInputJsonSchema(definitionFor("project.source.propose_bind"))).toMatchObject({required:["source_channel_id"]});
    expect(systemActionInputJsonSchema(definitionFor("source.backfill.propose_start"))).toMatchObject({required:["source_channel_id","source_backfill_plan_id"]});
  });
});
