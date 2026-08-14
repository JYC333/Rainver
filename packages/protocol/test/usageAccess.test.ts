import { describe, expect, it } from "vitest";
import {
  UsageEventDTOSchema,
  UsageQuerySchema,
  UsageSummaryResponseSchema,
} from "../src/index";

describe("usage access contracts", () => {
  it("accepts only the unified dashboard views", () => {
    expect(UsageQuerySchema.parse({ view: "mine" })).toEqual({ view: "mine" });
    expect(UsageQuerySchema.parse({ view: "shared" })).toEqual({ view: "shared" });
    expect(UsageQuerySchema.parse({ view: "all_visible" })).toEqual({ view: "all_visible" });
    expect(() => UsageQuerySchema.parse({ view: "instance" })).toThrow();
    expect(() => UsageQuerySchema.parse({ scope: "instance", all_spaces: true })).toThrow();
  });

  it("requires content access attribution on event DTOs and summary responses", () => {
    const event = UsageEventDTOSchema.parse({
      id: "event-1",
      space_id: "space-1",
      owner_user_id: "user-1",
      visibility: "private",
      access_level: "full",
      event_type: "llm.generation",
      source_type: "local_run",
      source_resource_type: "run",
      source_resource_id: "run-1",
      execution_channel: "managed_api",
      meter_subject_type: "run",
      meter_subject_id: "run-1",
      provider_id: null,
      provider_type: null,
      provider_name_snapshot: null,
      vendor: null,
      model: null,
      task: null,
      run_id: "run-1",
      session_id: null,
      external_session_id: null,
      session_path: null,
      session_name: null,
      agent_id: null,
      project_id: null,
      project_folder_id: null,
      occurred_at: "2026-07-10T00:00:00.000Z",
      recorded_at: "2026-07-10T00:00:00.000Z",
      usage_details: { total: 3 },
      input_tokens: 1,
      output_tokens: 2,
      total_tokens: 3,
      cache_creation_input_tokens: 0,
      cache_creation_1h_input_tokens: 0,
      cache_read_input_tokens: 0,
      reasoning_tokens: 0,
      request_count: 1,
      estimated_cost_usd: null,
      usage_accuracy: "provider_reported",
      total_tokens_source: "provider_total",
      dimensions: {},
      metadata: {},
      created_at: "2026-07-10T00:00:00.000Z",
    });
    expect(event).toMatchObject({ owner_user_id: "user-1", visibility: "private" });

    expect(() => UsageSummaryResponseSchema.parse({
      view: "instance",
      from: "2026-07-01T00:00:00.000Z",
      to: "2026-07-10T00:00:00.000Z",
      group_by: "provider",
      totals: {},
      items: [],
    })).toThrow();
  });
});
