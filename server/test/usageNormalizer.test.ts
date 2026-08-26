import { describe, expect, it } from "vitest";
import {
  normalizeUsageObservation,
  safeTraceObject,
  sumUsageBuckets,
} from "../src/modules/usage/normalizer.js";

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

describe("usage normalizer", () => {
  it("normalizes OpenAI-style usage into exclusive token buckets without raw payload metadata", () => {
    const event = normalizeUsageObservation(
      {
        space_id: "space-1",
        event_type: "llm.generation",
        source_type: "local_run",
        execution_channel: "managed_api",
        provider_id: "provider-1",
        provider_type: "openai",
        provider_name_snapshot: "OpenAI",
        model: "gpt-4o",
        task: "chat",
        run_id: "run-1",
        subject_user_id: "user-1",
        provider_usage: {
          prompt_tokens: 100,
          completion_tokens: 40,
          total_tokens: 140,
          prompt_tokens_details: {
            cached_tokens: 25,
            audio_tokens: 5,
            content: "raw prompt text must not be stored",
          },
          completion_tokens_details: {
            reasoning_tokens: 10,
            audio_tokens: 2,
          },
          request: { messages: [{ content: "hello" }] },
        },
        metadata: {
          prompt: "hello",
          request_body: { messages: [] },
          retry_count: 1,
        },
        dimensions: {
          workflow: "daily",
          "bad key": "ignored",
          tags: ["a", "b", { unsafe: true }],
        },
        idempotency_key: "  stable-key  ",
        dedupe_confidence: "invalid" as "high",
      },
      "instance-1",
      privateAttribution,
      new Date("2026-07-09T12:00:00.000Z"),
    );

    expect(event.meter_subject_type).toBe("run");
    expect(event.meter_subject_id).toBe("run-1");
    expect(event.vendor).toBe("openai");
    expect(event.idempotency_key).toBe("stable-key");
    expect(event.usage_details_json).toEqual({
      input: 70,
      input_cache_read: 25,
      input_audio: 5,
      output: 28,
      output_reasoning: 10,
      output_audio: 2,
      total: 140,
    });
    expect(event.input_tokens).toBe(70);
    expect(event.output_tokens).toBe(28);
    expect(event.total_tokens).toBe(140);
    expect(event.total_tokens_source).toBe("provider_total");
    expect(event.usage_accuracy).toBe("provider_reported");
    expect(event.cost_accuracy).toBe("unknown");
    expect(event.dedupe_confidence).toBe("high");
    expect(event.provider_usage_json).toMatchObject({
      prompt_tokens: 100,
      prompt_tokens_details: { cached_tokens: 25, audio_tokens: 5 },
    });
    expect(event.provider_usage_json).not.toHaveProperty("request");
    expect(event.provider_usage_json.prompt_tokens_details).not.toHaveProperty("content");
    expect(event.metadata_json).toEqual({ retry_count: 1 });
    expect(event.dimensions_json).toEqual({ workflow: "daily", tags: ["a", "b"] });
  });

  it("preserves catalog provenance for a genuine zero cost", () => {
    const event = normalizeUsageObservation(
      {
        space_id: "space-1",
        event_type: "llm.generation",
        source_type: "local_run",
        execution_channel: "managed_api",
        estimated_cost_usd: 0,
        cost_accuracy: "catalog",
        cost_details: { source: "pi_ai_catalog", total: 0 },
      },
      "instance-1",
      privateAttribution,
      new Date("2026-07-09T12:00:00.000Z"),
    );

    expect(event.estimated_cost_usd).toBe(0);
    expect(event.cost_accuracy).toBe("catalog");
    expect(event.cost_details_json).toEqual({ source: "pi_ai_catalog", total: 0 });
  });

  it("removes duplicate accuracy from catalog cost details", () => {
    const event = normalizeUsageObservation(
      {
        space_id: "space-1",
        event_type: "llm.generation",
        source_type: "local_run",
        execution_channel: "managed_api",
        estimated_cost_usd: 1,
        cost_accuracy: "catalog",
        cost_details: {
          source: "pi_ai_catalog",
          accuracy: "catalog_estimated",
          total: 1,
        },
      },
      "instance-1",
      privateAttribution,
      new Date("2026-07-09T12:00:00.000Z"),
    );

    expect(event.cost_details_json).toEqual({ source: "pi_ai_catalog", total: 1 });
  });

  it("normalizes Anthropic cache buckets and lower-bound transcript usage", () => {
    const event = normalizeUsageObservation(
      {
        space_id: "space-1",
        event_type: "llm.generation",
        source_type: "cli_history_import",
        execution_channel: "local_cli_transcript",
        provider_type: "anthropic",
        external_session_id: "claude-session-1",
        provider_usage: {
          input_tokens: 300,
          cache_creation_input_tokens: 50,
          cache_creation_1h_input_tokens: 40,
          cache_read_input_tokens: 25,
          output_tokens: 60,
        },
        usage_accuracy: "transcript_lower_bound",
      },
      "instance-1",
      privateAttribution,
      new Date("2026-07-09T12:00:00.000Z"),
    );

    expect(event.meter_subject_type).toBe("session");
    expect(event.meter_subject_id).toBe("claude-session-1");
    expect(event.input_tokens).toBe(300);
    expect(event.cache_creation_input_tokens).toBe(50);
    expect(event.cache_creation_1h_input_tokens).toBe(40);
    expect(event.cache_read_input_tokens).toBe(25);
    expect(event.output_tokens).toBe(60);
    expect(event.total_tokens).toBe(435);
    expect(event.usage_details_json.input_cache_creation_1h).toBe(40);
    expect(event.total_tokens_source).toBe("sum_of_buckets");
    expect(event.usage_accuracy).toBe("transcript_lower_bound");
  });

  it("keeps embedding input separate from chat input tokens", () => {
    const event = normalizeUsageObservation(
      {
        space_id: "space-1",
        event_type: "llm.embedding",
        source_type: "local_run",
        execution_channel: "managed_api",
        provider_type: "openai",
        model: "text-embedding-3-large",
        provider_usage: { prompt_tokens: 812 },
      },
      "instance-1",
      privateAttribution,
      new Date("2026-07-09T12:00:00.000Z"),
    );

    expect(event.usage_details_json).toEqual({ embedding_input: 812, total: 812 });
    expect(event.input_tokens).toBe(0);
    expect(event.total_tokens).toBe(812);
  });

  it("sums non-total buckets and strips trace-unsafe keys", () => {
    expect(sumUsageBuckets({ input: 4, output: 6, total: 100 })).toBe(10);
    expect(
      safeTraceObject({
        status: "ok",
        authorization: "Bearer secret",
        nested: { stderr: "raw", retry: 2 },
      }),
    ).toEqual({ status: "ok", nested: { retry: 2 } });
  });
});
