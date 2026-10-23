import { describe, expect, it } from "vitest";
import { acpRuntimeProbe } from "../src/modules/hosts/runtimeProbes.js";
import {
  getAgentRuntimeDefinition,
  isRunnableAgentRuntime,
  listAgentRuntimeDefinitions,
  supportsRuntimeBackendMode,
} from "../src/modules/runtimeAdapters/runtimeDefinitions.js";

describe("ACP runtime authority registry", () => {
  it("declares Claude login as a non-updating process with a runnable-program check", () => {
    expect(acpRuntimeProbe("claude_code")?.login).toMatchObject({
      env: { DISABLE_AUTOUPDATER: "1" }, verification_command: ["claude", "--version"],
      managed_verification_command: [expect.stringContaining("{tree}"), "--version"],
    });
  });
  it("exposes OpenCode, Claude and Codex as ACP definitions", () => {
    expect(getAgentRuntimeDefinition("opencode")).toMatchObject({ runtime_key: "opencode", protocol: "acp" });
    expect(getAgentRuntimeDefinition("claude_code")).toMatchObject({ runtime_key: "claude_code", protocol: "acp" });
    expect(getAgentRuntimeDefinition("codex_cli")).toMatchObject({ runtime_key: "codex_cli", protocol: "acp" });
  });

  it("fails closed for unknown and non-ACP catalog entries", () => {
    expect(getAgentRuntimeDefinition("does-not-exist")).toBeNull();
    expect(getAgentRuntimeDefinition("model_api")).toBeNull();
    expect(listAgentRuntimeDefinitions().map((entry) => entry.runtime_key)).toEqual(
      expect.arrayContaining(["opencode", "claude_code", "codex_cli"]),
    );
    expect(isRunnableAgentRuntime("opencode")).toBe(true);
    expect(isRunnableAgentRuntime("model_api")).toBe(false);
    expect(isRunnableAgentRuntime("does-not-exist")).toBe(false);
  });

  it("uses the runtime registry as the source of backend-mode support", () => {
    expect(supportsRuntimeBackendMode("opencode", "runtime_native")).toBe(true);
    expect(supportsRuntimeBackendMode("opencode", "model_provider")).toBe(true);
    expect(supportsRuntimeBackendMode("claude_code", "runtime_native")).toBe(true);
    expect(supportsRuntimeBackendMode("claude_code", "model_provider")).toBe(false);
    expect(supportsRuntimeBackendMode("unknown", "runtime_native")).toBe(false);
  });
});
