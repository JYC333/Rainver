import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config";
import type { ApplyProposal } from "../src/modules/memory/memoryApplyRepository";
import { createDefaultProposalApplierRegistry } from "../src/modules/proposals/applierRegistry";
import { validateProposalPayload } from "../src/modules/proposals/payloadSchemas";

class FakeApplyDb {
  readonly dirtyUpdates: Array<{ kind: string; params: readonly unknown[] }> = [];
  readonly jobs: Array<{
    job_type: string;
    workspace_id: unknown;
    agent_id: unknown;
    payload: Record<string, unknown>;
  }> = [];
  readonly policies: Array<{
    name: unknown;
    domain: unknown;
    rule_json: unknown;
    applies_to_json: unknown;
  }> = [];

  async query(sql: string, params: readonly unknown[] = []) {
    const norm = sql.replace(/\s+/g, " ").trim();
    if (norm.startsWith("INSERT INTO policies")) {
      this.policies.push({
        name: params[2],
        domain: params[3],
        rule_json: params[8],
        applies_to_json: params[9],
      });
      return { rows: [], rowCount: 1 };
    }
    if (norm.startsWith("UPDATE context_digests")) {
      const kind = norm.includes("digest_type = 'policy_bundle'")
        ? "policy_bundle"
        : norm.includes("digest_type = 'workspace'")
          ? "workspace"
          : "agent";
      this.dirtyUpdates.push({ kind, params });
      return { rows: [], rowCount: 1 };
    }
    if (norm.startsWith("INSERT INTO jobs")) {
      this.jobs.push({
        job_type: String(params[5]),
        workspace_id: params[3],
        agent_id: params[4],
        payload: JSON.parse(String(params[7])) as Record<string, unknown>,
      });
      return {
        rows: [{
          id: String(params[0]),
          space_id: params[1],
          user_id: params[2],
          workspace_id: params[3],
          agent_id: params[4],
          job_type: params[5],
          status: "pending",
          priority: params[6],
          payload_json: JSON.parse(String(params[7])),
          result_json: null,
          error: null,
          attempts: 0,
          max_attempts: params[8],
          scheduled_at: params[9],
          claimed_by: null,
          claimed_at: null,
          started_at: null,
          completed_at: null,
          heartbeat_at: null,
          created_at: params[10],
          updated_at: params[10],
        }],
        rowCount: 1,
      };
    }
    if (norm.startsWith("UPDATE proposals")) {
      return { rows: [], rowCount: 1 };
    }
    if (norm.startsWith("UPDATE policies SET status = 'superseded'")) {
      return { rows: [], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  }
}

class CapabilityVersionFakeDb {
  async query(sql: string, _params: readonly unknown[] = []) {
    const norm = sql.replace(/\s+/g, " ").trim();
    if (norm.startsWith("SELECT id, capability_key FROM capability_versions")) {
      // The requested version exists but belongs to a different capability_key.
      return { rows: [{ id: "v1", capability_key: "imported.other" }], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  }
}

function proposal(overrides: Partial<ApplyProposal> = {}): ApplyProposal {
  return {
    id: "proposal-1",
    space_id: "space-1",
    proposal_type: "policy_change",
    title: "Change policy",
    workspace_id: null,
    project_id: null,
    created_by_user_id: "user-1",
    payload_json: {
      name: "Scoped policy",
      domain: "runtime",
      policy_json: { rule: "Use safe defaults." },
      rule_json: { effect: "allow" },
      applies_to_json: {
        workspace_ids: ["ws-1", "ws-1"],
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

  it("registers capability lifecycle proposal appliers", () => {
    const registered = createDefaultProposalApplierRegistry().registeredTypes();
    expect(registered).toContain("skill_import_approve");
    expect(registered).toContain("capability_install");
    expect(registered).toContain("capability_update");
    expect(registered).toContain("capability_enable");
    expect(registered).toContain("capability_disable");
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
      "object_kind_create",
      "object_kind_update",
      "object_kind_deprecate",
      "object_kind_archive",
    ]));
  });

  it("registers the memory maintenance packet applier", () => {
    expect(createDefaultProposalApplierRegistry().registeredTypes()).toContain(
      "memory_maintenance_packet",
    );
  });

  it("blocks a project binding until its source activation dependency is accepted",async()=>{const db={query:async(sql:string)=>sql.includes("JOIN source_connections")?{rows:[],rowCount:0}:{rows:[],rowCount:0}};await expect(createDefaultProposalApplierRegistry().apply({config:loadConfig({SERVER_DATABASE_URL:"postgresql://server@db:5432/agent_space",SERVER_INTERNAL_TOKEN:"internal-token"}),db:db as never,proposal:proposal({proposal_type:"project_source_bind",project_id:"project-1",payload_json:{proposal_type:"project_source_bind",action_id:"project.source.propose_bind",project_id:"project-1",source_channel_id:"channel-1",depends_on_proposal_id:"activation-1"}}),userId:"user-1"})).rejects.toMatchObject({statusCode:409});});

  it("registers the Claim Candidate Packet applier", () => {
    expect(createDefaultProposalApplierRegistry().registeredTypes()).toContain(
      "claim_candidate_packet",
    );
  });

  it("refreshes only the policy_bundle digest, ignoring policy applies_to scopes", async () => {
    const db = new FakeApplyDb();

    const result = await createDefaultProposalApplierRegistry().apply({
      config: loadConfig({
        SERVER_DATABASE_URL: "postgresql://server@db:5432/agent_space",
        SERVER_INTERNAL_TOKEN: "internal-token",
      }),
      db: db as never,
      proposal: proposal(),
      userId: "user-1",
    });

    expect(result.result_type).toBe("policy_version");
    expect(db.policies[0]).toMatchObject({
      name: "Scoped policy",
      domain: "runtime",
      rule_json: JSON.stringify({ effect: "allow" }),
      applies_to_json: JSON.stringify({
        workspace_ids: ["ws-1", "ws-1"],
        agents: [{ id: "agent-1" }],
      }),
    });
    // Policies live only in the space-level policy_bundle. Even though this
    // policy's applies_to references ws-1 and agent-1, their memory-only digests
    // must NOT be invalidated (it would be a no-op refresh). Scoped policies are
    // surfaced per-run at consumption time, not folded into workspace/agent digests.
    expect(db.dirtyUpdates.map((u) => u.kind)).toEqual(["policy_bundle"]);
    expect(db.jobs.map((j) => j.payload)).toEqual([
      { space_id: "space-1", digest_type: "policy_bundle" },
    ]);
    expect(db.jobs.filter((j) => j.payload.digest_type === "workspace")).toHaveLength(0);
    expect(db.jobs.filter((j) => j.payload.digest_type === "agent")).toHaveLength(0);
  });

  it("rejects a capability_enable proposal whose version belongs to another capability", async () => {
    const db = new CapabilityVersionFakeDb();

    await expect(
      createDefaultProposalApplierRegistry().apply({
        config: loadConfig({
          SERVER_DATABASE_URL: "postgresql://server@db:5432/agent_space",
          SERVER_INTERNAL_TOKEN: "internal-token",
        }),
        db: db as never,
        proposal: proposal({
          proposal_type: "capability_enable",
          payload_json: {
            operation: "capability_enable",
            capability_key: "imported.mine",
            capability_version_id: "v1",
          },
        }),
        userId: "user-1",
      }),
    ).rejects.toThrow(/does not match capability_key/);
  });

  it("rejects non-built-in capability_enable proposals without an explicit version", async () => {
    await expect(
      createDefaultProposalApplierRegistry().apply({
        config: loadConfig({
          SERVER_DATABASE_URL: "postgresql://server@db:5432/agent_space",
          SERVER_INTERNAL_TOKEN: "internal-token",
        }),
        db: new FakeApplyDb() as never,
        proposal: proposal({
          proposal_type: "capability_enable",
          payload_json: {
            operation: "capability_enable",
            capability_key: "imported.mine",
          },
        }),
        userId: "user-1",
      }),
    ).rejects.toThrow(/capability_version_id is required/);
  });
});
