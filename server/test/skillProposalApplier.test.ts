import { describe, expect, it } from "vitest";
import { registerSkillProposalAppliers } from "../src/modules/skills/proposalApplier.js";
import { ProposalApplierRegistry } from "../src/modules/proposals/applierRegistry.js";

describe("Skill proposal authority", () => {
  it("registers review and original-package binding appliers", () => {
    const registry = new ProposalApplierRegistry();
    registerSkillProposalAppliers(registry);
    expect(registry.get("skill_import_approve")).not.toBeNull();
    expect(registry.get("runtime_skill_binding_update")).not.toBeNull();
  });
});
