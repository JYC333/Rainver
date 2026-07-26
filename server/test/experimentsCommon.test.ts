import { describe, expect, it } from "vitest";
import { normalizeExecutorConfig } from "../src/modules/experiments/common";

describe("Experiment executor configuration", () => {
  const base = {
    project_folder_id: "workspace-1",
    editable_scope: ["src/variants"],
    protected_scope: ["src/core"],
  };

  it.each([
    ["zero time budget", { ...base, time_budget_seconds: 0 }],
    ["negative timeout", { ...base, timeout_seconds: -1 }],
    ["fractional timeout", { ...base, timeout_seconds: 1.5 }],
    ["infinite budget", { ...base, time_budget_seconds: Number.POSITIVE_INFINITY }],
  ])("rejects %s", (_label, config) => {
    expect(() => normalizeExecutorConfig("managed_code_comparison", config))
      .toThrow(/positive integer/);
  });

  it("keeps positive integer budgets in the immutable normalized config", () => {
    expect(normalizeExecutorConfig("managed_code_comparison", {
      ...base,
      time_budget_seconds: 600,
      timeout_seconds: 120,
    })).toMatchObject({
      time_budget_seconds: 600,
      timeout_seconds: 120,
    });
  });
});
