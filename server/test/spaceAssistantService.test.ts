import { describe, expect, it } from "vitest";
import { setupTargetsForMissingBackend } from "../src/modules/agents/spaceAssistantService";

describe("managed Assistant backend setup targets", () => {
  it("does not advertise CLI credentials when no CLI runtime can be provisioned", () => {
    expect(setupTargetsForMissingBackend({ cliAdapters: [] })).toEqual(["model_providers"]);
  });

  it("advertises CLI credentials when a supported runtime is provisionable", () => {
    expect(setupTargetsForMissingBackend({
      cliAdapters: [{ adapterType: "codex_cli", version: "1.0.0" }],
    })).toEqual(["model_providers", "cli_credentials"]);
  });
});
