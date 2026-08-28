import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as Protocol from "@rainver/protocol";
import type { SystemActionDefinition } from "@rainver/protocol";

type RegistryProtocolModule = Pick<
  typeof Protocol,
  "POLICY_ACTION_REGISTRY" | "SystemActionDefinitionSchema"
> & {
  readonly SYSTEM_ACTION_REGISTRY: readonly SystemActionDefinition[];
};

const protocolState = vi.hoisted(() => ({
  module: null as RegistryProtocolModule | null,
}));

vi.mock("@rainver/protocol", async (importOriginal) => {
  const actual = await importOriginal<typeof Protocol>();
  const live = <K extends keyof RegistryProtocolModule>(key: K) =>
    (protocolState.module ?? (actual as unknown as RegistryProtocolModule))[key];
  return {
    ...actual,
    get POLICY_ACTION_REGISTRY() { return live("POLICY_ACTION_REGISTRY"); },
    get SYSTEM_ACTION_REGISTRY() { return live("SYSTEM_ACTION_REGISTRY"); },
    get SystemActionDefinitionSchema() { return live("SystemActionDefinitionSchema"); },
  };
});

import {
  loadSystemActionRegistry,
  resetSystemActionRegistryForTests,
} from "../src/modules/systemActions/registry.js";

describe("system action registry loading", () => {
  let actualProtocol: typeof Protocol;

  beforeEach(async () => {
    actualProtocol = await vi.importActual<typeof Protocol>("@rainver/protocol");
    protocolState.module = actualProtocol;
    resetSystemActionRegistryForTests();
  });

  it("validates definitions before exposing the registry", async () => {
    const valid = actualProtocol.SYSTEM_ACTION_REGISTRY.find(
      (definition) => definition.id === "project.propose_definition",
    )!;
    protocolState.module = {
      ...actualProtocol,
      SYSTEM_ACTION_REGISTRY: [{ ...valid, policy_resource: undefined }],
    };

    await expect(loadSystemActionRegistry()).rejects.toThrow(
      /Invalid system action definition project\.propose_definition.*policy_resource/,
    );
  });

  it("rejects duplicate action ids instead of silently overwriting one", async () => {
    const valid = actualProtocol.SYSTEM_ACTION_REGISTRY[0]!;
    protocolState.module = {
      ...actualProtocol,
      SYSTEM_ACTION_REGISTRY: [valid, valid],
    };

    await expect(loadSystemActionRegistry()).rejects.toThrow(
      `Duplicate system action id: ${valid.id}`,
    );
  });

  it("rejects a definition whose policy action is not registered", async () => {
    const valid = actualProtocol.SYSTEM_ACTION_REGISTRY[0]!;
    protocolState.module = {
      ...actualProtocol,
      SYSTEM_ACTION_REGISTRY: [{
        ...valid,
        policy_action: "missing.policy.action",
      } as unknown as SystemActionDefinition],
    };

    await expect(loadSystemActionRegistry()).rejects.toThrow(
      `Unknown policy action missing.policy.action for system action ${valid.id}`,
    );
  });

  it("declares one resource type per action across both registries", () => {
    // The dispatcher passes the System Action's declared resource, so a
    // mismatch is silent: the policy registry's entry is documentation that
    // has drifted, and drifted documentation about authorization is worse
    // than none. `task.create` was declared `task` in one and `project` in the
    // other — a Task has no id yet when it is created, so `project` is right.
    const policyResources = new Map(
      actualProtocol.POLICY_ACTION_REGISTRY.map((entry) => [entry.action, entry.resource_type]),
    );
    const mismatches: string[] = [];
    let compared = 0;
    for (const action of actualProtocol.SYSTEM_ACTION_REGISTRY) {
      const declared = action.policy_resource?.resource_type;
      const policyAction = action.policy_action;
      if (!declared || !policyAction) continue;
      const expected = policyResources.get(policyAction);
      if (!expected) continue;
      compared += 1;
      if (expected !== declared) {
        mismatches.push(`${action.id}: system=${declared} policy=${expected} (${policyAction})`);
      }
    }
    expect(mismatches).toEqual([]);
    // A guard that compares nothing passes forever. `server/test` is outside
    // this package's `tsconfig` include, so a misspelled property is not a
    // compile error — the count is what makes the guard real.
    expect(compared).toBeGreaterThan(5);
  });
});
