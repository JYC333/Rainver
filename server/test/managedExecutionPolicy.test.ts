import { describe, expect, it } from "vitest";
import {
  allowsManagedCredentialUse,
  createManagedExecutionPolicy,
  credentialPolicyMetadata,
  isManagedFailFastRun,
  managedExecutionPolicyFromContract,
} from "../src/modules/policy/managedExecutionPolicy.js";

describe("managed execution policy", () => {
  it("round-trips a server-managed policy through the run contract", () => {
    const policy = createManagedExecutionPolicy("project_research", true);
    expect(managedExecutionPolicyFromContract({ policy_context_json: policy })).toEqual(policy);
    expect(isManagedFailFastRun({
      trigger_origin: "system",
      contract_snapshot_json: { policy_context_json: policy },
    })).toBe(true);
  });

  it("matches credential authorization only to its owning trigger origin", () => {
    const context = createManagedExecutionPolicy("source_post_processing", true);
    expect(allowsManagedCredentialUse("job", context)).toBe(true);
    expect(allowsManagedCredentialUse("automation", context)).toBe(false);
    expect(allowsManagedCredentialUse("system", context)).toBe(false);
  });

  it("preserves the complete policy context when building a credential request", () => {
    expect(credentialPolicyMetadata(createManagedExecutionPolicy("project_research", true))).toEqual({
      managed_execution: "project_research",
      credential_pre_authorized: true,
      failure_policy: "fail_fast",
    });
  });

  it("does not treat an unapproved or malformed context as managed", () => {
    const policy = createManagedExecutionPolicy("source_post_processing", false);
    expect(allowsManagedCredentialUse("job", policy)).toBe(false);
    expect(isManagedFailFastRun({
      trigger_origin: "job",
      contract_snapshot_json: {
        policy_context_json: {
          managed_execution: "source_post_processing",
          credential_pre_authorized: true,
          supervisor_mode: "fail_fast",
        },
      },
    })).toBe(false);
  });
});
