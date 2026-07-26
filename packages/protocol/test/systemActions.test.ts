import { describe, expect, it } from "vitest";
import { POLICY_ACTION_REGISTRY, SYSTEM_ACTION_REGISTRY, SystemActionDefinitionSchema } from "../src/index.js";

describe("SYSTEM_ACTION_REGISTRY", () => {
  const policyById = new Map(POLICY_ACTION_REGISTRY.map((definition) => [definition.action, definition]));

  it("has unique normalized ids and valid policy links", () => {
    const ids = SYSTEM_ACTION_REGISTRY.map((definition) => definition.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const definition of SYSTEM_ACTION_REGISTRY) {
      expect(definition.id).toMatch(/^[a-z][a-z0-9]*(?:\.[a-z][a-z0-9_]*)+$/);
      expect(policyById.has(definition.policy_action)).toBe(true);
      expect(SystemActionDefinitionSchema.safeParse(definition).success).toBe(true);
      if(!["authorization.request","source.channel.propose_activation","project.source.propose_bind","source.backfill.propose_start","task.plan.propose"].includes(definition.id))expect(definition.input_schema.safeParse({}).success).toBe(true);
    }
  });

  it("defines concrete contracts for Project Chat proposal actions",()=>{
    const byId=new Map(SYSTEM_ACTION_REGISTRY.map(action=>[action.id,action]));
    expect(byId.get("project.source.propose_bind")!.input_schema.safeParse({}).success).toBe(false);
    expect(byId.get("project.source.propose_bind")!.input_schema.safeParse({source_channel_id:"channel-1"}).success).toBe(true);
    expect(byId.get("source.backfill.propose_start")!.input_schema.safeParse({source_channel_id:"channel-1"}).success).toBe(false);
  });

  it("keeps agent tools audited and high-risk direct writes hidden", () => {
    for (const definition of SYSTEM_ACTION_REGISTRY) {
      if (!definition.visibility.has("agent_tool")) continue;
      const policy = policyById.get(definition.policy_action)!;
      expect(policy.audit_required).toBe(true);
      if (policy.default_risk_level === "high" || policy.default_risk_level === "critical") {
        expect(["none", "draft", "proposal"]).toContain(definition.side_effects);
      }
    }
  });

  it("keeps proposal metadata and visibility internally coherent", () => {
    for (const definition of SYSTEM_ACTION_REGISTRY) {
      expect(definition.side_effects === "proposal").toBe(definition.proposal_type !== null);
      if (definition.visibility.has("internal_only")) {
        expect(definition.visibility.has("public_api")).toBe(false);
      }
      if (definition.id === "source.recipe.activate" || definition.id === "project.source.bind") {
        expect(definition.visibility.has("agent_tool")).toBe(false);
      }
    }
  });
});
