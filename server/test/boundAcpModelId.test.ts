import { describe, expect, it } from "vitest";
import { boundAcpModelId } from "../src/modules/runs/remoteProviderBinding.js";
import { codexModelCatalog } from "../src/modules/runs/codexProviderConfig.js";
import { openCodeModelId } from "../src/modules/runs/opencodeProviderConfig.js";

// Which model a bound remote run asks its runtime for over ACP. Nothing
// threaded a model into a remote run before, so the identifier spaces could
// not diverge; once a user can pick one, a value in the wrong space either
// names nothing the runtime knows or — worse, for Claude — resolves to
// whatever it was already on.

describe("the bound model in each runtime's identifier space", () => {
  it("addresses an OpenCode model through the provider the binding declares", () => {
    // Not a bare name: `agent_space_provider` is the id
    // `applyOpenCodeProviderConfig` writes into the profile's opencode.json,
    // and OpenCode resolves `<provider>/<model>`. Built by the same function
    // that writes the config, so the two cannot drift.
    expect(boundAcpModelId("opencode", "MiniMax-M3")).toBe(openCodeModelId("MiniMax-M3"));
    expect(boundAcpModelId("opencode", "MiniMax-M3")).toBe("agent_space_provider/MiniMax-M3");
  });

  it("uses the provider's own model name for Codex", () => {
    expect(boundAcpModelId("codex_cli", "MiniMax-M3")).toBe("MiniMax-M3");
    // Codex resolves against the catalog the binding writes, and its entries
    // really are keyed by that name — so the config channel and the ACP
    // channel agree.
    const catalog = codexModelCatalog("MiniMax", "MiniMax-M3", []) as { models: { slug: string }[] };
    expect(catalog.models[0]!.slug).toBe(boundAcpModelId("codex_cli", "MiniMax-M3"));
  });

  it("tells Claude nothing, because its model is settled by the environment", () => {
    // ACP's model options are Claude's own alias space (`default`, `sonnet`,
    // `opus`, …), where a third-party provider's model name does not exist.
    // Reconciling against it falls through to the session's current value:
    // `default` on a fresh session, and on a resumed one the model the
    // previous turn used — so asking for a new model would re-assert the old
    // one while ANTHROPIC_MODEL and every record named the new one.
    expect(boundAcpModelId("claude_code", "MiniMax-M3")).toBeNull();
    expect(boundAcpModelId("claude_code", "MiniMax-M2.7")).toBeNull();
  });

  it("lets the provider's endpoint decide how much its model reasons", () => {
    // Codex resolves a bound model's effort from the catalog the binding
    // writes and sends it upstream as a request parameter — it is the model's
    // reasoning, not the harness's. Declaring only "none" decided on the
    // endpoint's behalf that its model cannot reason at all.
    const catalog = codexModelCatalog("MiniMax", "MiniMax-M3", []) as {
      models: { default_reasoning_level: string; supported_reasoning_levels: { effort: string }[] }[];
    };
    expect(catalog.models[0]!.supported_reasoning_levels.map((l) => l.effort)).toEqual(["low", "medium", "high"]);
    // Codex's own fallback, so an endpoint that ignores the parameter behaves
    // exactly as it did before.
    expect(catalog.models[0]!.default_reasoning_level).toBe("medium");
  });

  it("says nothing when the binding named no model", () => {
    expect(boundAcpModelId("opencode", null)).toBeNull();
    expect(boundAcpModelId("codex_cli", null)).toBeNull();
  });
});
