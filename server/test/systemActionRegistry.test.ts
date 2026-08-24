import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as Protocol from "@agent-space/protocol" with { "resolution-mode": "import" };
import type { SystemActionDefinition } from "@agent-space/protocol" with { "resolution-mode": "import" };

type RegistryProtocolModule = Pick<
  typeof Protocol,
  "POLICY_ACTION_REGISTRY" | "SystemActionDefinitionSchema"
> & {
  readonly SYSTEM_ACTION_REGISTRY: readonly SystemActionDefinition[];
};

const protocolState = vi.hoisted(() => ({
  module: null as RegistryProtocolModule | null,
}));

vi.mock("../src/modules/providers/protocolRuntime", () => ({
  loadProtocol: async () => {
    if (!protocolState.module) throw new Error("Protocol test module was not initialized");
    return protocolState.module;
  },
}));

import {
  loadSystemActionRegistry,
  resetSystemActionRegistryForTests,
} from "../src/modules/systemActions/registry";

describe("system action registry loading", () => {
  let actualProtocol: typeof Protocol;

  beforeEach(async () => {
    actualProtocol = await vi.importActual<typeof Protocol>("@agent-space/protocol");
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
});
