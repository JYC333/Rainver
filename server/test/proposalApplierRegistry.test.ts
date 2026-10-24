import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import type { ApplyProposal } from "../src/modules/memory/memoryApplyRepository.js";
import { createDefaultProposalApplierRegistry } from "../src/modules/proposals/applierRegistry.js";
import { validateProposalPayload } from "../src/modules/proposals/payloadSchemas.js";

function proposal(overrides: Partial<ApplyProposal> = {}): ApplyProposal {
  return {
    id: "proposal-1",
    space_id: "space-1",
    proposal_type: "memory_create",
    title: "Remember something",
    project_folder_id: null,
    project_id: null,
    visibility: "space_shared",
    created_by_user_id: "user-1",
    owner_user_id: null,
    payload_json: {
      name: "Scoped policy",
      domain: "runtime",
      policy_json: { rule: "Use safe defaults." },
      rule_json: { effect: "allow" },
      applies_to_json: {
        project_folder_ids: ["ws-1", "ws-1"],
        agents: [{ id: "agent-1" }],
      },
    },
    ...overrides,
  };
}

describe("proposal applier registry", () => {
  it("registers the code_patch proposal applier", () => {
    expect(createDefaultProposalApplierRegistry().registeredTypes()).toContain("code_patch");
  });

  it("registers plan review and checkpoint appliers", () => {
    const registered = Array.from(createDefaultProposalApplierRegistry().registeredTypes());
    expect(registered).toEqual(expect.arrayContaining(["plan_review", "plan_checkpoint"]));
  });

  it("registers the audited evolution bundle rollback applier", () => {
    expect(createDefaultProposalApplierRegistry().registeredTypes()).toContain(
      "evolution_bundle_rollback",
    );
  });

  it("registers and validates monitored research query activation proposals", () => {
    expect(createDefaultProposalApplierRegistry().registeredTypes()).toContain("research_query_strategy_activation");
    expect(() => validateProposalPayload("research_query_strategy_activation", {
      proposal_type: "research_query_strategy_activation",
      project_id: "55555555-5555-4555-8555-555555555555",
      source_strategy_id: "11111111-1111-4111-8111-111111111111",
      candidate_strategy_id: "22222222-2222-4222-8222-222222222222",
      direction: "broaden",
      observation_count: 3,
      metrics: { average_new_candidates: 2 },
    })).not.toThrow();
  });

  it("registers Skill review and binding proposal appliers", () => {
    const registered = createDefaultProposalApplierRegistry().registeredTypes();
    expect(registered).toContain("skill_import_approve");
    expect(registered).not.toContain("capability_install");
    expect(() => validateProposalPayload("capability_install", { proposal_type: "capability_install" })).toThrow();
    expect(registered).not.toContain("capability_update");
    expect(registered).not.toContain("capability_enable");
    expect(registered).not.toContain("capability_disable");
    expect(registered).toContain("runtime_skill_binding_update");
  });

  it("registers ClaimFact and object-relation proposal appliers", () => {
    const registered = Array.from(createDefaultProposalApplierRegistry().registeredTypes());
    expect(registered).toEqual(expect.arrayContaining([
      "claim_create",
      "claim_update",
      "claim_archive",
      "object_relation_create",
      "object_relation_delete",
    ]));
  });

  it("registers object kind registry proposal appliers", () => {
    const registered = Array.from(createDefaultProposalApplierRegistry().registeredTypes());
    expect(registered).toEqual(expect.arrayContaining([
      "object_profile_create",
      "object_profile_update",
      "object_profile_deprecate",
      "object_profile_archive",
    ]));
  });

  it("registers the memory maintenance packet applier", () => {
    expect(createDefaultProposalApplierRegistry().registeredTypes()).toContain(
      "memory_maintenance_packet",
    );
  });

  it("has no applier for the Inquiry writes that became direct", () => {
    // ADR 0017 §5: opening a question and recording a conclusion are
    // origin-gated and bounded, not reviewed. Do not register an applier for
    // either. It would be a second way to make the write.
    const types = createDefaultProposalApplierRegistry().registeredTypes();
    expect(types).not.toContain("inquiry_thread_create");
    expect(types).not.toContain("inquiry_conclusion");
    expect(() => validateProposalPayload("inquiry_thread_create", { project_id: "project-1" }))
      .toThrow();
  });

  it("registers and validates Project definition proposals", () => {
    expect(createDefaultProposalApplierRegistry().registeredTypes()).toContain(
      "project_brief_publish",
    );
    expect(() => validateProposalPayload("project_brief_publish", {
      proposal_type: "project_brief_publish",
      action_id: "project.propose_definition",
      project_id: "project-1",
      goal: "Build a reliable personal memory MVP",
    })).not.toThrow();
  });

  it("blocks a project binding until its source activation dependency is accepted",async()=>{const db={query:async(sql:string)=>sql.includes("JOIN source_connections")?{rows:[],rowCount:0}:{rows:[],rowCount:0}};await expect(createDefaultProposalApplierRegistry().apply({config:loadConfig({SERVER_DATABASE_URL:"postgresql://server@db:5432/rainver",SERVER_INTERNAL_TOKEN:"internal-token"}),db:db as never,proposal:proposal({proposal_type:"project_source_bind",project_id:"project-1",payload_json:{proposal_type:"project_source_bind",action_id:"project.source.propose_bind",project_id:"project-1",source_channel_id:"channel-1",depends_on_proposal_id:"activation-1"}}),userId:"user-1"})).rejects.toMatchObject({statusCode:409});});

  it("registers the Claim Candidate Packet applier", () => {
    expect(createDefaultProposalApplierRegistry().registeredTypes()).toContain(
      "claim_candidate_packet",
    );
  });

  it("has no applier for a generic policy change, which nothing would enforce", () => {
    // `policy_change` wrote `policies` rows no decision ever read. It is not a
    // proposal type: accepting one is refused rather than recorded as applied.
    expect(createDefaultProposalApplierRegistry().registeredTypes().has("policy_change")).toBe(false);
  });

});
