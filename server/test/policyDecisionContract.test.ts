import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { loadActionRegistry } from "../src/modules/policy/actionRegistry.js";
import { computeDecision, type Registry } from "../src/modules/policy/gateway.js";

/**
 * Policy decision compatibility fixture.
 *
 * The fixture exercises every lifecycle branch, every hard invariant, and every
 * built-in rule. The current `computeDecision` output is compared against the frozen
 * decision fields so policy refactors cannot silently drift.
 */

const fixturePath = join(import.meta.dirname, "fixtures", "policy_decision_contract.json");

interface ContractCase {
  request: Record<string, unknown>;
  decision: Record<string, unknown>;
}
const cases: ContractCase[] = JSON.parse(readFileSync(fixturePath, "utf8"));

const FIELDS = [
  "decision",
  "risk_level",
  "reason_code",
  "required_approver_role",
  "policy_rule_id",
  "policy_source",
  "approval_capability",
  "audit_code",
  "resource_type",
  "message",
  "action",
] as const;

let registry: Registry;
beforeAll(async () => {
  registry = await loadActionRegistry();
});

describe("policy decision compatibility", () => {
  it("covers every lifecycle branch + invariant + rule", () => {
    expect(cases.length).toBeGreaterThanOrEqual(28);
  });

  for (const [i, c] of cases.entries()) {
    it(`case ${i}: ${c.request.action}`, () => {
      const req = { force_record: false, ...c.request } as never;
      const { decision } = computeDecision(registry, req);
      const normalized: Record<string, unknown> = {};
      for (const f of FIELDS) {
        normalized[f] = (decision as unknown as Record<string, unknown>)[f] ?? null;
      }
      expect(normalized).toEqual(c.decision);
    });
  }
});


describe('canonical operation approval gate scope',()=>{
 it('satisfies only the named require_approval rule and still evaluates later rules/default',()=>{
  const request={force_record:false,action:'task.create',space_id:'s',resource_space_id:'s',context:{trigger_origin:'autonomous'}};
  expect(computeDecision(registry,request).decision.decision).toBe('require_approval');
  expect(computeDecision(registry,request,'some_other_gate').decision.decision).toBe('require_approval');
  expect(computeDecision(registry,request,'unattended_project_write_require_approval').decision.decision).toBe('allow');
  expect(computeDecision(registry,{...request,resource_space_id:'other'},'unattended_project_write_require_approval').decision.decision).toBe('deny');
  expect(computeDecision(registry,{...request,action:'unregistered.action'},'registry_default').decision.decision).toBe('deny');
 });
});


describe("human Note navigation policy", () => {
  it("allows ordinary linking while preserving cross-Space denial", () => {
    const request = {
      action: "note.link.create", actor_type: "user", actor_id: "user",
      space_id: "space", resource_space_id: "space", force_record: false,
    };
    expect(computeDecision(registry, request).decision.decision).toBe("allow");
    expect(computeDecision(registry, { ...request, resource_space_id: "other" }).decision.decision).toBe("deny");
  });
});
