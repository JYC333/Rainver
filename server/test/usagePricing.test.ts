import { describe, expect, it } from "vitest";
import { normalizeUsageObservation } from "../src/modules/usage/normalizer";
import {
  estimateUsageCost,
  type PricingRuleRecord,
} from "../src/modules/usage/pricing";

const baseRule: PricingRuleRecord = {
  id: "pricing-rule-1",
  scope_type: "system",
  space_id: null,
  provider_type: "openai",
  provider_id: null,
  model_pattern: "gpt-*",
  input_usd_per_million: "2",
  output_usd_per_million: "6",
  cache_write_usd_per_million: null,
  cache_read_usd_per_million: "0.5",
  reasoning_usd_per_million: "8",
  usage_type_prices_json: {},
  tier_conditions_json: {},
  priority: 0,
  pricing_normalization_version: 1,
  currency: "USD",
  effective_from: "2026-01-01T00:00:00.000Z",
  effective_until: null,
  source: "built_in",
  metadata_json: {},
  created_at: "2026-01-01T00:00:00.000Z",
  updated_at: "2026-01-01T00:00:00.000Z",
};

const privateAttribution = {
  owner_user_id: "user-1",
  visibility: "private" as const,
  access_level: "full" as const,
  source_resource_type: null,
  source_resource_id: null,
  project_folder_id: null,
  project_id: null,
  grant_snapshots: [],
};

describe("usage pricing", () => {
  it("prices normalized buckets without double-counting total", () => {
    const event = normalizeUsageObservation(
      {
        space_id: "space-1",
        event_type: "llm.generation",
        source_type: "local_run",
        execution_channel: "managed_api",
        provider_type: "openai",
        model: "gpt-4o",
        usage_details: {
          input: 1_000_000,
          output: 500_000,
          input_cache_read: 2_000_000,
          total: 3_500_000,
        },
      },
      "instance-1",
      privateAttribution,
      new Date("2026-07-09T12:00:00.000Z"),
    );

    const estimate = estimateUsageCost(event, baseRule);

    expect(estimate?.estimatedCostUsd).toBe(6);
    expect(estimate?.pricingRuleId).toBe("pricing-rule-1");
    expect(estimate?.costDetails).toMatchObject({
      currency: "USD",
      rule_id: "pricing-rule-1",
      bucket_costs: expect.arrayContaining([
        expect.objectContaining({ bucket: "input", units: 1_000_000, cost_usd: 2 }),
        expect.objectContaining({ bucket: "output", units: 500_000, cost_usd: 3 }),
        expect.objectContaining({ bucket: "input_cache_read", units: 2_000_000, cost_usd: 1 }),
      ]),
    });
  });

  it("selects tier overrides from trace-safe dimensions", () => {
    const event = normalizeUsageObservation(
      {
        space_id: "space-1",
        event_type: "llm.generation",
        source_type: "local_run",
        execution_channel: "managed_api",
        provider_type: "openai",
        model: "gpt-4o",
        usage_details: { input: 1_000_000, output: 1_000_000 },
        dimensions: { route: "batch" },
      },
      "instance-1",
      privateAttribution,
      new Date("2026-07-09T12:00:00.000Z"),
    );

    const estimate = estimateUsageCost(event, {
      ...baseRule,
      tier_conditions_json: {
        tiers: [{
          name: "batch",
          when: { dimension_equals: { route: "batch" } },
          prices: { output_usd_per_million: 3 },
        }],
      },
    });

    expect(estimate?.pricingTierName).toBe("batch");
    expect(estimate?.estimatedCostUsd).toBe(5);
  });
});
