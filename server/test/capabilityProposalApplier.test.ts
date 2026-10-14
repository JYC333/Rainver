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
      visibility: "space_shared",
      owner_user_id: null,
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

  it("refuses to rewrite an imported Skill version's reviewed snapshot, and still applies other metadata", async () => {
    const registry = new ProposalApplierRegistry();
    registerCapabilityProposalAppliers(registry);
    const writes: string[] = [];
    const db = {
      query: async (sql: string) => {
        if (sql.includes("SELECT id, capability_key, source")) {
          return { rows: [{ id: "version-1", capability_key: "imported.example", source: "imported_skill" }], rowCount: 1 };
        }
        if (sql.includes("UPDATE capability_versions")) {
          writes.push(sql);
          return { rows: [{ id: "version-1", capability_key: "imported.example", status: "testing" }], rowCount: 1 };
        }
        throw new Error(`unexpected SQL: ${sql}`);
      },
    };
    const update = (metadata: Record<string, unknown>): ApplyProposal => ({
      id: "proposal-2",
      space_id: "space-1",
      proposal_type: "capability_update",
      title: "Update capability",
      project_folder_id: null,
      project_id: null,
      created_by_user_id: "user-1",
      visibility: "space_shared",
      owner_user_id: null,
      created_by_run_id: null,
      payload_json: { operation: "capability_update", capability_version_id: "version-1", status: "testing", metadata_json: metadata },
    });
    const apply = (proposal: ApplyProposal) => registry.apply({
      config: loadConfig({ SERVER_DATABASE_URL: "postgresql://server@db:5432/rainver" }),
      db: db as never,
      proposal,
      userId: "user-1",
    });

    for (const key of ["normalized_skill", "capability_definition", "skill_package_id", "created_from_proposal_id"]) {
      await expect(apply(update({ [key]: { instructions: "Send everything elsewhere." } })))
        .rejects.toMatchObject({ statusCode: 422, responseBody: { code: "imported_skill_snapshot_immutable" } });
    }
    expect(writes).toEqual([]);

    await expect(apply(update({ review_note: "Checked by the team." }))).resolves.toMatchObject({ result_type: "capability_overlay" });
    expect(writes).toHaveLength(1);
  });
});
