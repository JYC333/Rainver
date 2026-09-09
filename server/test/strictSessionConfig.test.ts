import { describe, expect, it } from "vitest";
import { withStrictHostSelections } from "../src/modules/runs/cliConversationProtocol.js";
import { getLocalCliRuntimeAdapterSpec } from "../src/modules/runtimeAdapters/specs.js";

/**
 * ADR 0016 section 2: on the built-in host the daemon's namespace is the one
 * boundary, so the runtime's own sandbox has to be stood down inside it.
 * Measured 2026-09-08 on that host: left on, Codex stacks its policy and the
 * Run's own workspace comes back read-only, so the Run runs and silently
 * cannot write.
 */
describe("standing the vendor sandbox down on a strict host", () => {
  it("names the option Codex actually advertises, with its full-access value", () => {
    expect(getLocalCliRuntimeAdapterSpec("codex_cli")?.strict_session_config).toEqual([
      { id: "mode", type: "select", value: "agent-full-access", category: "mode" },
    ]);
  });

  it("leaves Claude alone, which has no vendor sandbox to stand down", () => {
    expect(getLocalCliRuntimeAdapterSpec("claude_code")?.strict_session_config).toBeUndefined();
  });

  it("overrides a caller who asked for the option itself", () => {
    const forced = getLocalCliRuntimeAdapterSpec("codex_cli")!.strict_session_config!;
    expect(withStrictHostSelections(
      [{ id: "mode", type: "select", value: "read-only", category: "mode" }],
      forced,
    )).toEqual([{ id: "mode", type: "select", value: "agent-full-access", category: "mode" }]);
  });

  it("keeps every other selection the caller made", () => {
    const forced = getLocalCliRuntimeAdapterSpec("codex_cli")!.strict_session_config!;
    expect(withStrictHostSelections(
      [{ id: "collaboration_mode", type: "select", value: "plan", category: "collaboration_mode" }],
      forced,
    )).toEqual([
      { id: "collaboration_mode", type: "select", value: "plan", category: "collaboration_mode" },
      { id: "mode", type: "select", value: "agent-full-access", category: "mode" },
    ]);
  });

  it("changes nothing when the host is not strict", () => {
    const asked = [{ id: "mode", type: "select" as const, value: "read-only", category: "mode" }];
    expect(withStrictHostSelections(asked, undefined)).toEqual(asked);
  });
});
