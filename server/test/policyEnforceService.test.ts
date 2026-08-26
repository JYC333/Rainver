import { beforeAll, describe, expect, it } from "vitest";
import { loadActionRegistry, type PolicyActionDefinition } from "../src/modules/policy/actionRegistry.js";
import { enforce, enforceProposalApply } from "../src/modules/policy/service.js";
import type { ServerConfig } from "../src/config.js";

/**
 * Service-level result mapping for the enforce port. The durable-audit write
 * targets an unreachable DB (ECONNREFUSED resolves immediately), which lets us
 * verify the fail-closed / best-effort branches without a live Postgres:
 *   - blocked decisions swallow a failed audit write and still return blocked;
 *   - a fail-closed ALLOW whose audit write fails returns `error`;
 *   - an allow that is NOT audit-required never touches the DB and returns allow.
 *
 * Real DB persistence is covered by integration tests once the P4 grants land.
 */

// Unreachable DB so writePolicyAudit rejects fast.
const config = {
  databaseUrl: "postgres://u:p@127.0.0.1:1/db",
} as unknown as ServerConfig;

let registry: ReadonlyMap<string, PolicyActionDefinition>;
beforeAll(async () => {
  registry = await loadActionRegistry();
});

function req(action: string, extra: Record<string, unknown> = {}) {
  return { action, force_record: false, ...extra } as never;
}

describe("policy enforce service result mapping", () => {
  it("blocked decision returns blocked even when the audit write fails", async () => {
    const res = await enforce(config, registry, req("memory.create"));
    expect(res.status).toBe("blocked");
    expect(res.error_code).toBe("policy_denied");
    expect(res.decision?.audit_code).toBe("policy_action_via_proposal_only");
  });

  it("require_approval maps to blocked / policy_requires_approval", async () => {
    const res = await enforce(
      config,
      registry,
      req("runtime.use_credential", {
        space_id: "s1",
        resource_space_id: "s1",
        context: { trigger_origin: "automation" },
      }),
    );
    expect(res.status).toBe("blocked");
    expect(res.error_code).toBe("policy_requires_approval");
  });

  it("fail-closed ALLOW with a failed audit write returns error", async () => {
    const res = await enforce(
      config,
      registry,
      req("runtime.use_credential", {
        space_id: "s1",
        resource_space_id: "s1",
        context: { trigger_origin: "manual" },
      }),
    );
    expect(res.status).toBe("error");
    expect(res.error_code).toBe("policy_audit_persist_failed");
  });

  it("same-space delegated credential use is allowed before fail-closed audit handling", async () => {
    const res = await enforce(
      config,
      registry,
      req("runtime.use_credential", {
        space_id: "s1",
        resource_space_id: "s1",
        context: { trigger_origin: "delegation" },
      }),
    );
    expect(res.status).toBe("error");
    expect(res.error_code).toBe("policy_audit_persist_failed");
  });

  it("allow that is not audit-required returns allow without touching the DB", async () => {
    const res = await enforce(
      config,
      registry,
      req("context.inject_memory", { space_id: "s1" }),
    );
    expect(res.status).toBe("allow");
    expect(res.decision?.decision).toBe("allow");
  });
});

describe("policy proposal-apply service result mapping", () => {
  it("blocked proposal.apply returns blocked even when the audit write fails", async () => {
    const res = await enforceProposalApply(
      config,
      {
        user_id: "u1",
        space_id: "s1",
        proposal_id: "p1",
        proposal_type: "memory_create",
        declared_risk: "medium",
        proposal_payload: {},
      },
      null,
      new Set(["memory_create"]),
    );
    expect(res.status).toBe("blocked");
    expect(res.error_code).toBe("policy_requires_approval");
    expect(res.decision?.policy_rule_id).toBe("proposal_apply_no_membership");
  });

  it("fail-closed ALLOW proposal.apply with a failed audit write returns error", async () => {
    const res = await enforceProposalApply(
      config,
      {
        user_id: "u1",
        space_id: "s1",
        proposal_id: "p1",
        proposal_type: "memory_create",
        declared_risk: "medium",
        proposal_payload: {},
      },
      "owner",
      new Set(["memory_create"]),
    );
    expect(res.status).toBe("error");
    expect(res.error_code).toBe("policy_audit_persist_failed");
  });
});
