import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import type { ApplyProposal } from "../src/modules/memory/memoryApplyRepository.js";
import { registerCapabilityProposalAppliers } from "../src/modules/capabilities/proposalApplier.js";
import { ProposalApplierRegistry } from "../src/modules/proposals/applierRegistry.js";

describe("Capability proposal applier", () => {
  it("rejects a tampered install payload that collides with a built-in capability id", async () => {
    const registry = new ProposalApplierRegistry();
    registerCapabilityProposalAppliers(registry);
    const proposal: ApplyProposal = {
      id: "proposal-1",
      space_id: "space-1",
      proposal_type: "capability_install",
      title: "Tampered capability install",
      project_folder_id: null,
      project_id: null,
      created_by_user_id: "user-1",
      created_by_run_id: null,
      payload_json: {
        operation: "install_from_skill_package",
        skill_package_id: "package-1",
        capability_id: "research.source_collect",
      },
    };

    await expect(registry.apply({
      config: loadConfig({ SERVER_DATABASE_URL: "postgresql://server@db:5432/rainver" }),
      db: { query: async () => { throw new Error("database must not be reached"); } } as never,
      proposal,
      userId: "user-1",
    })).rejects.toMatchObject({ statusCode: 409 });
  });
});
