import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  POLICY_ACTION_REGISTRY,
  POLICY_APPROVER_MAX_RISK,
  PolicyActionDefinitionSchema,
  PolicyAuditEnvelopeSchema,
  PolicyCheckRequestSchema,
  PolicyDecisionSchema,
  PolicyEnforceResultSchema,
  PolicyProposalApplyRequestSchema,
} from "../src/policy.js";

/**
 * Frozen canonical action registry fixture. It pins count, order, and public
 * metadata so registry edits are deliberate.
 */
const fixturePath = fileURLToPath(
  new URL("./fixtures/policy_action_registry.json", import.meta.url),
);
const registryFixture = JSON.parse(readFileSync(fixturePath, "utf8"));

describe("policy action registry", () => {
  it("keeps the shared approval ceilings at owner critical, admin high and reviewer medium", () => {
    expect(POLICY_APPROVER_MAX_RISK).toEqual({ owner: "critical", admin: "high", reviewer: "medium" });
  });
  it("every registry entry validates against the definition schema", () => {
    for (const def of POLICY_ACTION_REGISTRY) {
      expect(() => PolicyActionDefinitionSchema.parse(def)).not.toThrow();
    }
  });

  it("action names are unique", () => {
    const names = POLICY_ACTION_REGISTRY.map((d) => d.action);
    expect(new Set(names).size).toBe(names.length);
  });

  it("registers run.spawn_child as the canonical wired delegation action only", () => {
    const names = POLICY_ACTION_REGISTRY.map((d) => d.action);
    expect(names).toContain("run.spawn_child");
    expect(names).not.toContain("agent.delegate");
    const spawnChild = POLICY_ACTION_REGISTRY.find(
      (d) => d.action === "run.spawn_child",
    );
    expect(spawnChild?.lifecycle_status).toBe("wired_direct");
    expect(spawnChild?.default_decision).not.toBe("allow");
    expect(spawnChild?.record_failure_mode).toBe("fail_closed");
  });

  it("matches the frozen registry fixture 1:1 (count, order, and every field)", () => {
    expect(POLICY_ACTION_REGISTRY.length).toBe(registryFixture.length);
    // Deep, order-sensitive equality — registries must be byte-identical data.
    expect(POLICY_ACTION_REGISTRY.map((d) => ({ ...d }))).toEqual(
      registryFixture,
    );
  });

  it("reserved actions never default to allow", () => {
    for (const def of POLICY_ACTION_REGISTRY) {
      if (def.lifecycle_status === "reserved") {
        expect(def.default_decision).not.toBe("allow");
      }
    }
  });
});

describe("policy enforcement request/decision contracts", () => {
  it("accepts a minimal enforce request", () => {
    const req = PolicyCheckRequestSchema.parse({ action: "runtime.execute" });
    expect(req.force_record).toBe(false);
  });

  it("rejects unknown top-level fields (strict)", () => {
    expect(() =>
      PolicyCheckRequestSchema.parse({
        action: "runtime.execute",
        approved_by_user: true,
      }),
    ).toThrow();
  });

  it("decision defaults match the public policy contract", () => {
    const dec = PolicyDecisionSchema.parse({
      decision: "allow",
      message: "ok",
    });
    expect(dec.risk_level).toBe("low");
    expect(dec.policy_source).toBe("builtin");
  });

  it("proposal-apply request requires user/space/proposal identity", () => {
    expect(() =>
      PolicyProposalApplyRequestSchema.parse({
        space_id: "s1",
        proposal_id: "p1",
        proposal_type: "memory_create",
      }),
    ).toThrow();
    const ok = PolicyProposalApplyRequestSchema.parse({
      user_id: "u1",
      space_id: "s1",
      proposal_id: "p1",
      proposal_type: "memory_create",
      membership_role: "owner",
      supported_proposal_types: ["memory_create"],
    });
    expect(ok.user_id).toBe("u1");
    expect(ok.supported_proposal_types).toEqual(["memory_create"]);
  });

  it("audit envelope requires a created_at timestamp", () => {
    expect(() =>
      PolicyAuditEnvelopeSchema.parse({
        action: "runtime.use_credential",
        decision: "allow",
        risk_level: "high",
      }),
    ).toThrow();
  });

  it("enforce result models allow / blocked / error", () => {
    expect(
      PolicyEnforceResultSchema.parse({
        status: "blocked",
        error_code: "policy_requires_approval",
        policy_decision_record_id: "decision-1",
      }).status,
    ).toBe("blocked");
  });
});
