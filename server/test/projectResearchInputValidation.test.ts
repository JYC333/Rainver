import { describe, expect, it } from "vitest";
import { rejectLegacyResearchRuntimeFields } from "../src/modules/projectResearch/inputValidation.js";

describe("Project Research execution input", () => {
  it("accepts a selected managed provider when the model is left for provider default resolution", () => {
    expect(() => rejectLegacyResearchRuntimeFields({
      execution: { model_provider_id: "provider-1" },
    })).not.toThrow();
  });

  it("accepts an explicit model under the managed execution block", () => {
    expect(() => rejectLegacyResearchRuntimeFields({
      execution: { model_provider_id: "provider-1", model_name: "model-1" },
    })).not.toThrow();
  });

  it("rejects runtime and credential fields at the public boundary", () => {
    expect(() => rejectLegacyResearchRuntimeFields({
      adapter_type: "model_api",
    })).toThrow(/managed Model Provider/);
    expect(() => rejectLegacyResearchRuntimeFields({
      execution: { runtime_profile_id: "profile-1" },
    })).toThrow(/managed Model Provider/);
    expect(() => rejectLegacyResearchRuntimeFields({
      model_provider_id: "provider-1",
    })).toThrow(/managed Model Provider/);
  });
});
