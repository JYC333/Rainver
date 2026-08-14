import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../src/server";
import { loadConfig } from "../src/config";
import {
  __setNetworkRetryDelayForTests,
  __setProviderCommandStoreForTests,
  __setProviderHttpClientForTests as setRawProviderHttpClientForTests,
  type ProviderCommandStore,
  type ProviderHttpClient,
} from "../src/modules/providers";
import { __setRuntimeHostDeliveryAuthorizerForTests, executeRuntimeHost } from "../src/modules/runtimeHost";
import type { UsageObservation } from "../src/modules/usage";
import { resolveTestUsageAttribution } from "./support/usageAttribution";
import { openAiChatResponse, piAiHttpClient } from "./support/piAiHttp";

function __setProviderHttpClientForTests(client: ProviderHttpClient | null): void {
  setRawProviderHttpClientForTests(client ? piAiHttpClient(client) : null);
}

let app: FastifyInstance;

// Network-error retries add a real delay between attempts (see
// NETWORK_ERROR_RETRY_DELAY_MS in invocation.ts) — skip it here so tests
// that exhaust retries don't take multiple real seconds.
beforeEach(() => {
  __setNetworkRetryDelayForTests(async () => {});
  __setRuntimeHostDeliveryAuthorizerForTests(async () => {});
});

afterEach(async () => {
  __setProviderCommandStoreForTests(null);
  __setProviderHttpClientForTests(null);
  __setNetworkRetryDelayForTests(null);
  __setRuntimeHostDeliveryAuthorizerForTests(null);
  await app?.close();
});

function config() {
  return loadConfig({
    SERVER_DATABASE_URL: "postgresql://server@db:5432/agent_space",
    SERVER_INTERNAL_TOKEN: "internal-token",
  });
}

function requestBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    run_input: {
      schema_version: "run_input.v1",
      run_id: "run-1",
      space_id: "space-1",
      instruction: null,
      task_goal: "Say hello",
      messages: [],
      inputs: { direct: null, workflow: null, upstream: null },
      attachments: [],
      project_folder_access: null,
      output_contract: {
        schema_version: "run_output_contract.v1",
        structured_output: null,
        required_outputs: [],
      },
      tool_grants: [],
      execution: {
        shape: "conversational",
        risk_level: "low",
        required_sandbox_level: "none",
        policy_ref: "run_permission_snapshot:run-1",
        budget_ref: "run_contract:run-1",
      },
    },
    run_id: "run-1",
    space_id: "space-1",
    model_provider_id: "provider-1",
    model: "gpt-4o-mini",
    system_prompt: "Be direct.",
    prompt: "Say hello",
    mode: "live",
    invocation_audit_refs: {
      delivery_id: "delivery-1",
      invocation_snapshot_id: "snapshot-1",
      execution_control_snapshot_id: "control-1",
      usage_source_id: "usage-1",
    },
    ...overrides,
  };
}

function fakeStore(
  calls: string[],
  providerType = "openai",
  usageObservations: UsageObservation[] = [],
  openAiCompatibleBaseUrl: string | null = null,
  defaultModel: string | null = "gpt-4o-mini",
  apiKey = "sk-test-provider",
  targetSubjects?: Array<string | null | undefined>,
): ProviderCommandStore {
  return {
    async getInvocationTarget(
      _spaceId: string,
      providerId?: string | null,
      subjectUserId?: string | null,
    ) {
      calls.push(`target:${providerId}`);
      targetSubjects?.push(subjectUserId);
      return {
        provider: {
          id: providerId ?? "provider-1",
          space_id: "space-1",
          name: "Main",
          provider_type: providerType,
          base_url: "https://api.example.test/v1",
          openai_compatible_base_url: openAiCompatibleBaseUrl,
          default_model: defaultModel,
          available_models: defaultModel ? [defaultModel] : [],
          enabled: true,
          is_default: true,
        },
        rotation_strategy: "fill_first",
        fallback_provider_ids: [],
        candidates: [
          {
            member_id: "member-1",
            credential_id: "credential-1",
            api_key: apiKey,
          },
        ],
      };
    },
    async recordPoolOutcome(memberId: string, outcome: { kind: string }) {
      calls.push(`outcome:${memberId}:${outcome.kind}`);
    },
    resolveUsageAttribution: resolveTestUsageAttribution,
    async recordUsageObservation(input: UsageObservation) {
      usageObservations.push(input);
    },
    async getTaskChain(_spaceId: string, task: string) {
      calls.push(`task:${task}`);
      return null;
    },
  } as unknown as ProviderCommandStore;
}

function codexAccessToken(accountId: string): string {
  const encoded = Buffer.from(JSON.stringify({
    "https://api.openai.com/auth": { chatgpt_account_id: accountId },
  })).toString("base64url");
  return `header.${encoded}.signature`;
}

function fakeHttpClient(calls: string[]): ProviderHttpClient {
  return {
    async fetch(_url, init) {
      calls.push(`fetch:${JSON.parse(String(init?.body)).model}`);
      return openAiChatResponse({
        choices: [{ message: { content: "host output" } }],
        model: "gpt-4o-mini",
        usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
      });
    },
  };
}

function fallbackStore(
  calls: string[],
  usageObservations: UsageObservation[] = [],
): ProviderCommandStore {
  return {
    async getInvocationTarget(_spaceId: string, providerId?: string | null) {
      const id = providerId ?? "provider-1";
      calls.push(`target:${id}`);
      const fallback = id === "provider-2";
      return {
        provider: {
          id,
          space_id: "space-1",
          name: fallback ? "Fallback" : "Primary",
          provider_type: "openai",
          base_url: fallback
            ? "https://fallback.example.test/v1"
            : "https://primary.example.test/v1",
          openai_compatible_base_url: null,
          default_model: fallback ? "fallback-model" : "primary-model",
          available_models: [fallback ? "fallback-model" : "primary-model"],
          enabled: true,
          is_default: !fallback,
        },
        rotation_strategy: "fill_first",
        fallback_provider_ids: fallback ? [] : ["provider-2"],
        candidates: [{
          member_id: fallback ? "member-2" : "member-1",
          credential_id: fallback ? "credential-2" : "credential-1",
          api_key: fallback ? "sk-test-fallback" : "sk-test-primary",
        }],
      };
    },
    async recordPoolOutcome(memberId: string, outcome: { kind: string }) {
      calls.push(`outcome:${memberId}:${outcome.kind}`);
    },
    resolveUsageAttribution: resolveTestUsageAttribution,
    async recordUsageObservation(input: UsageObservation) {
      usageObservations.push(input);
    },
    async getTaskChain(_spaceId: string, task: string) {
      calls.push(`task:${task}`);
      return [{ provider_id: "provider-2", model: "fallback-model" }];
    },
  } as unknown as ProviderCommandStore;
}

describe("runtime host internal route", () => {
  it("propagates run cancellation to the provider HTTP request", async () => {
    const calls: string[] = [];
    let observedSignal = false;
    let markFetchStarted!: () => void;
    const fetchStarted = new Promise<void>((resolve) => { markFetchStarted = resolve; });
    __setProviderCommandStoreForTests(fakeStore(calls));
    __setProviderHttpClientForTests({
      fetch(_url, init) {
        observedSignal = init?.signal instanceof AbortSignal;
        markFetchStarted();
        return new Promise((_resolve, reject) => {
          const rejectAbort = () => reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
          if (init?.signal?.aborted) rejectAbort();
          else init?.signal?.addEventListener("abort", rejectAbort, { once: true });
        });
      },
    });
    const controller = new AbortController();
    const pending = executeRuntimeHost(
      config(),
      requestBody() as Parameters<typeof executeRuntimeHost>[1],
      undefined,
      { signal: controller.signal },
    );

    await fetchStarted;
    controller.abort();

    await expect(pending).resolves.toMatchObject({
      success: false,
      error_code: "provider_request_aborted",
    });
    expect(observedSignal).toBe(true);
  });

  it("streams OpenAI-compatible conversation deltas while retaining the canonical result", async () => {
    const calls: string[] = [];
    const bodies: Array<Record<string, unknown>> = [];
    const deltas: string[] = [];
    let acceptEncoding: string | null = null;
    __setProviderCommandStoreForTests(fakeStore(calls));
    __setProviderHttpClientForTests({
      async fetch(_url, init) {
        acceptEncoding = new Headers(init?.headers).get("accept-encoding");
        bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return new Response([
          'data: {"model":"gpt-4o-mini","choices":[{"delta":{"content":"hello "}}]}',
          "",
          'data: {"choices":[{"delta":{"content":"world"},"finish_reason":"stop"}]}',
          "",
          'data: {"choices":[],"usage":{"prompt_tokens":3,"completion_tokens":2,"total_tokens":5}}',
          "",
          "data: [DONE]",
          "",
        ].join("\n"), {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        });
      },
    });

    const result = await executeRuntimeHost(
      config(),
      requestBody({
        cache_strategy: "conversation",
      }) as Parameters<typeof executeRuntimeHost>[1],
      undefined,
      { onTextDelta: (delta) => deltas.push(delta) },
    );

    expect(bodies[0]).toMatchObject({
      stream: true,
      stream_options: { include_usage: true },
    });
    expect(deltas).toEqual(["hello ", "world"]);
    expect(acceptEncoding).toBe("identity");
    expect(result).toMatchObject({
      success: true,
      output_text: "hello world",
      usage: { input_tokens: 3, output_tokens: 2, total_tokens: 5 },
    });
  });

  it("keeps usage unknown when an OpenAI-compatible gateway omits usage", async () => {
    const calls: string[] = [];
    const usageObservations: UsageObservation[] = [];
    __setProviderCommandStoreForTests(fakeStore(calls, "openai", usageObservations));
    __setProviderHttpClientForTests({
      async fetch() {
        return openAiChatResponse({
          choices: [{ message: { content: "ok" }, finish_reason: "stop" }],
          model: "gpt-4o-mini",
        });
      },
    });

    const result = await executeRuntimeHost(
      config(),
      requestBody() as Parameters<typeof executeRuntimeHost>[1],
    );

    expect(result.success).toBe(true);
    expect(usageObservations).toEqual([
      expect.objectContaining({ usage_accuracy: "unknown" }),
    ]);
  });

  it("preserves raw provider finish reasons that pi-ai normalizes", async () => {
    const calls: string[] = [];
    __setProviderCommandStoreForTests(fakeStore(calls));
    __setProviderHttpClientForTests({
      async fetch() {
        return openAiChatResponse({
          choices: [{ message: { content: "" }, finish_reason: "content_filter" }],
          model: "gpt-4o-mini",
          usage: { prompt_tokens: 3, completion_tokens: 0, total_tokens: 3 },
        });
      },
    });

    const result = await executeRuntimeHost(
      config(),
      requestBody() as Parameters<typeof executeRuntimeHost>[1],
    );

    expect(result).toMatchObject({ success: true, output_text: "" });
    expect(result.events.at(-1)).toMatchObject({
      type: "model.message_stop",
      finish_reason: "content_filter",
    });
  });

  it("carries every billed token bucket into the Run envelope, not just input and output", async () => {
    // Cache-creation, cache-read and reasoning tokens are billed at their own
    // rates. An envelope reporting only input/output/total cannot be
    // reconciled against the usage ledger for the same generation, and cost
    // cannot be recomputed from it afterwards.
    const calls: string[] = [];
    __setProviderCommandStoreForTests(fakeStore(calls));
    __setProviderHttpClientForTests({
      async fetch() {
        return new Response(
          JSON.stringify({
            model: "gpt-4o-mini",
            choices: [{ message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
            usage: {
              prompt_tokens: 100,
              completion_tokens: 40,
              total_tokens: 140,
              prompt_tokens_details: { cached_tokens: 60 },
              completion_tokens_details: { reasoning_tokens: 15 },
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      },
    });

    const result = await executeRuntimeHost(
      config(),
      requestBody({}) as Parameters<typeof executeRuntimeHost>[1],
    );

    expect(result.success).toBe(true);
    expect(result.usage).toMatchObject({
      // OpenAI reports cached and reasoning tokens inside the totals, so the
      // shared ledger extraction subtracts them out rather than double-counting.
      input_tokens: 40,
      cache_read_input_tokens: 60,
      output_tokens: 25,
      reasoning_tokens: 15,
      total_tokens: 140,
    });
  });

  it("does not widen a managed Delivery to a fallback provider", async () => {
    const calls: string[] = [];
    const usageObservations: UsageObservation[] = [];
    __setProviderCommandStoreForTests(fallbackStore(calls, usageObservations));
    __setProviderHttpClientForTests({
      async fetch(url) {
        if (String(url).includes("primary.example.test")) {
          return new Response(JSON.stringify({ error: "temporarily unavailable" }), {
            status: 503,
            headers: { "content-type": "application/json" },
          });
        }
        return new Response(JSON.stringify({
          choices: [{ message: { content: "fallback output" } }],
          model: "fallback-model",
          usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 },
        }), { status: 200, headers: { "content-type": "application/json" } });
      },
    });

    const result = await executeRuntimeHost(
      config(),
      requestBody({ model: "primary-model" }) as Parameters<typeof executeRuntimeHost>[1],
    );

    expect(result).toMatchObject({ success: false, error_code: expect.any(String) });
    expect(calls).not.toContain("target:provider-2");
    expect(usageObservations).toEqual(expect.arrayContaining([
      expect.objectContaining({
        provider_id: "provider-1",
        usage_accuracy: "unknown",
        dimensions: expect.objectContaining({ provider_attempt_status: "failed" }),
      }),
    ]));
  });

  it("fails a truncated provider stream instead of persisting partial output as success", async () => {
    const calls: string[] = [];
    const deltas: string[] = [];
    __setProviderCommandStoreForTests(fakeStore(calls));
    __setProviderHttpClientForTests({
      async fetch() {
        return new Response([
          'data: {"id":"chatcmpl_test","object":"chat.completion.chunk","created":1,"model":"gpt-4o-mini","choices":[{"index":0,"delta":{"role":"assistant","content":"partial"},"finish_reason":null}]}',
          "",
          "",
        ].join("\n"), {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        });
      },
    });

    const result = await executeRuntimeHost(
      config(),
      requestBody({ cache_strategy: "conversation" }) as Parameters<typeof executeRuntimeHost>[1],
      undefined,
      { onTextDelta: (delta) => deltas.push(delta) },
    );

    expect(deltas).toEqual(["partial"]);
    expect(result).toMatchObject({
      success: false,
      error_code: "provider_stream_interrupted",
    });
  });

  it("marks Anthropic conversation system context as ephemeral-cacheable", async () => {
    const calls: string[] = [];
    const bodies: Array<Record<string, unknown>> = [];
    const usageObservations: UsageObservation[] = [];
    __setProviderCommandStoreForTests(fakeStore(calls, "anthropic", usageObservations));
    __setProviderHttpClientForTests({
      async fetch(_url, init) {
        bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return new Response(JSON.stringify({
          content: [{ type: "text", text: "cached reply" }],
          model: "claude-test",
          usage: {
            input_tokens: 3,
            output_tokens: 2,
            cache_creation_input_tokens: 40,
            cache_creation: { ephemeral_1h_input_tokens: 30 },
          },
          stop_reason: "end_turn",
        }), { status: 200, headers: { "content-type": "application/json" } });
      },
    });

    const result = await executeRuntimeHost(
      config(),
      requestBody({
        model: "claude-test",
        cache_strategy: "conversation",
      }) as Parameters<typeof executeRuntimeHost>[1],
    );

    expect(result.success).toBe(true);
    expect(result.usage).toMatchObject({
      cache_creation_input_tokens: 40,
      cache_creation_1h_input_tokens: 30,
    });
    expect(usageObservations).toHaveLength(1);
    expect(usageObservations[0]?.provider_usage).toMatchObject({
      cache_creation_input_tokens: 40,
      cache_creation_1h_input_tokens: 30,
    });
    // No request or independent model-spec cap is present, so the resolved Pi
    // model (or its fallback) is the sole output-token authority.
    expect(bodies[0]?.max_tokens).toBe(16_384);
    expect(bodies[0]?.system).toEqual([{
      type: "text",
      text: "Be direct.",
      cache_control: { type: "ephemeral" },
    }]);
  });

  it("runs Codex Responses over the injected SSE fetch transport", async () => {
    const calls: string[] = [];
    const requests: Array<{ url: string; headers: Headers }> = [];
    const targetSubjects: Array<string | null | undefined> = [];
    __setProviderCommandStoreForTests(fakeStore(
      calls,
      "openai_codex",
      [],
      null,
      "gpt-5.6-sol",
      codexAccessToken("account-1"),
      targetSubjects,
    ));
    __setProviderHttpClientForTests({
      async fetch(url, init) {
        requests.push({ url: String(url), headers: new Headers(init?.headers) });
        const events = [
          {
            type: "response.output_item.added",
            output_index: 0,
            item: { id: "message-1", type: "message", role: "assistant", content: [] },
          },
          { type: "response.output_text.delta", output_index: 0, content_index: 0, delta: "codex reply" },
          {
            type: "response.completed",
            response: {
              id: "response-1",
              status: "completed",
              output: [],
              usage: { input_tokens: 3, output_tokens: 2, total_tokens: 5 },
            },
          },
        ];
        return new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(""), {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        });
      },
    });

    const result = await executeRuntimeHost(
      config(),
      requestBody({
        subject_user_id: "user-1",
        model: "gpt-5.6-sol",
      }) as Parameters<typeof executeRuntimeHost>[1],
    );

    expect(result).toMatchObject({ success: true, output_text: "codex reply" });
    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toContain("/responses");
    expect(requests[0]?.headers.get("chatgpt-account-id")).toBe("account-1");
    expect(requests[0]?.headers.get("authorization")).toMatch(/^Bearer /);
    expect(targetSubjects).toEqual(["user-1"]);
  });

  it("requires the internal service token", async () => {
    const calls: string[] = [];
    __setProviderCommandStoreForTests(fakeStore(calls));
    __setProviderHttpClientForTests(fakeHttpClient(calls));
    app = buildServer(config(), { logger: false });

    const res = await app.inject({
      method: "POST",
      url: "/internal/runtime-host/execute",
      payload: requestBody(),
    });

    expect(res.statusCode).toBe(401);
    expect(calls).toEqual([]);
  });

  it("rejects direct Runtime Host execution without Delivery audit refs", async () => {
    const calls: string[] = [];
    __setProviderCommandStoreForTests(fakeStore(calls));
    __setProviderHttpClientForTests(fakeHttpClient(calls));
    app = buildServer(config(), { logger: false });

    const res = await app.inject({
      method: "POST",
      url: "/internal/runtime-host/execute",
      headers: { "x-agent-space-internal-token": "internal-token" },
      payload: requestBody({ invocation_audit_refs: undefined }),
    });

    expect(res.statusCode).toBe(409);
    expect(calls).toEqual([]);
  });

  it("executes a provider-backed tool-disabled host turn", async () => {
    const calls: string[] = [];
    const usageObservations: UsageObservation[] = [];
    __setProviderCommandStoreForTests(fakeStore(calls, "openai", usageObservations));
    __setProviderHttpClientForTests(fakeHttpClient(calls));
    app = buildServer(config(), { logger: false });

    const res = await app.inject({
      method: "POST",
      url: "/internal/runtime-host/execute",
      headers: { "x-agent-space-internal-token": "internal-token" },
      payload: requestBody({
        max_tokens: 64,
        session_id: "session-1",
        root_run_id: "root-1",
        parent_run_id: "parent-1",
        run_group_id: "group-1",
        agent_id: "agent-1",
        project_id: "project-1",
        project_folder_id: "workspace-1",
        trigger_origin: "manual",
      }),
    });

    expect(res.statusCode).toBe(200);
    expect(res.payload).not.toContain("sk-test-provider");
    expect(res.json()).toMatchObject({
      success: true,
      stdout: "host output",
      output_text: "host output",
      model: "gpt-4o-mini",
      usage: { input_tokens: 3, output_tokens: 2, total_tokens: 5 },
      adapter_metadata: {
        adapter_type: "ts_agent_host",
        model_provider_id: "provider-1",
        tool_mode: "disabled",
      },
    });
    expect(res.json().events.map((event: { type: string }) => event.type)).toEqual([
      "model.message_start",
      "model.text_delta",
      "model.usage",
      "model.message_stop",
    ]);
    expect(calls).toEqual([
      "target:provider-1",
      "fetch:gpt-4o-mini",
      "outcome:member-1:success",
    ]);
    expect(usageObservations).toEqual([
      expect.objectContaining({
        space_id: "space-1",
        event_type: "llm.generation",
        source_type: "local_run",
        execution_channel: "managed_api",
        meter_subject_type: "run",
        meter_subject_id: "run-1",
        run_id: "run-1",
        root_run_id: "root-1",
        parent_run_id: "parent-1",
        run_group_id: "group-1",
        session_id: "session-1",
        agent_id: "agent-1",
        project_id: "project-1",
        project_folder_id: "workspace-1",
        trigger_origin: "manual",
        adapter_type: "ts_agent_host",
        provider_id: "provider-1",
        provider_type: "openai",
        provider_name_snapshot: "Main",
        model: "gpt-4o-mini",
        task: "runtime_host",
        provider_usage: {
          input_tokens: 3,
          output_tokens: 2,
          total_tokens: 5,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
          reasoning_tokens: 0,
        },
        usage_accuracy: "provider_reported",
        dimensions: expect.objectContaining({ mode: "live", tool_mode: "disabled" }),
      }),
    ]);
  });

  it("requests native JSON Schema output and exposes the parsed object", async () => {
    const calls: string[] = [];
    const bodies: Array<Record<string, unknown>> = [];
    __setProviderCommandStoreForTests(fakeStore(calls));
    __setProviderHttpClientForTests({
      async fetch(_url, init) {
        bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return new Response(JSON.stringify({
          choices: [{ message: { content: '{"schema":"research.test.v1","value":"ok"}' } }],
          model: "gpt-4o-mini",
          usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
        }), { status: 200, headers: { "content-type": "application/json" } });
      },
    });
    app = buildServer(config(), { logger: false });

    const res = await app.inject({
      method: "POST",
      url: "/internal/runtime-host/execute",
      headers: { "x-agent-space-internal-token": "internal-token" },
      payload: requestBody({
        output_format: {
          type: "json_schema",
          schema_id: "research.test.v1",
          schema: { type: "object", properties: { value: { type: "string" } }, required: ["value"] },
          strict: true,
        },
      }),
    });

    expect(res.statusCode).toBe(200);
    expect(bodies[0]).toMatchObject({
      tool_choice: { type: "function", function: { name: "research_test_v1" } },
      tools: [{ type: "function", function: { name: "research_test_v1", strict: true } }],
    });
    expect(res.json()).toMatchObject({
      success: true,
      output_json: { schema: "research.test.v1", value: "ok" },
    });
  });

  it("removes a leading reasoning envelope before parsing structured output", async () => {
    const calls: string[] = [];
    __setProviderCommandStoreForTests(fakeStore(calls));
    __setProviderHttpClientForTests({
      async fetch() {
        return new Response(JSON.stringify({
          choices: [{
            finish_reason: "stop",
            message: {
              content: '<think>internal reasoning</think>\n{"schema":"research.test.v1","value":"ok"}',
            },
          }],
          model: "gpt-4o-mini",
        }), { status: 200, headers: { "content-type": "application/json" } });
      },
    });
    app = buildServer(config(), { logger: false });

    const res = await app.inject({
      method: "POST",
      url: "/internal/runtime-host/execute",
      headers: { "x-agent-space-internal-token": "internal-token" },
      payload: requestBody({
        output_format: {
          type: "json_schema",
          schema_id: "research.test.v1",
          schema: { type: "object", properties: { value: { type: "string" } }, required: ["value"] },
          strict: true,
        },
      }),
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      success: true,
      output_json: { schema: "research.test.v1", value: "ok" },
    });
  });

  it("fails structured-output runs when the provider returns plain text", async () => {
    const calls: string[] = [];
    __setProviderCommandStoreForTests(fakeStore(calls));
    __setProviderHttpClientForTests({
      async fetch() {
        return new Response(JSON.stringify({
          choices: [{ message: { content: "not json" } }],
          model: "gpt-4o-mini",
        }), { status: 200, headers: { "content-type": "application/json" } });
      },
    });
    app = buildServer(config(), { logger: false });

    const res = await app.inject({
      method: "POST",
      url: "/internal/runtime-host/execute",
      headers: { "x-agent-space-internal-token": "internal-token" },
      payload: requestBody({
        output_format: {
          type: "json_schema",
          schema_id: "research.test.v1",
          schema: { type: "object" },
          strict: true,
        },
      }),
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      success: false,
      error_code: "structured_output_invalid",
      output_json: {
        structured_output_diagnostics: {
          transport: "openai_completions",
          response_kind: "message_content",
          content_length: 8,
          first_non_whitespace: "n",
          last_non_whitespace: "n",
          parse_result: "invalid_json",
        },
      },
    });
    expect(res.json().error_text).toContain("stage=managed_api schema=research.test.v1 provider=provider-1 model=gpt-4o-mini attempt=1");
  });

  it("does not publish structured-output prose before validation", async () => {
    const calls: string[] = [];
    const deltas: string[] = [];
    __setProviderCommandStoreForTests(fakeStore(calls));
    __setProviderHttpClientForTests({
      async fetch() {
        return openAiChatResponse({
          choices: [{ message: { content: "not json" }, finish_reason: "stop" }],
          model: "gpt-4o-mini",
        });
      },
    });

    const result = await executeRuntimeHost(
      config(),
      requestBody({
        output_format: {
          type: "json_schema",
          schema_id: "research.test.v1",
          schema: { type: "object" },
          strict: true,
        },
      }) as Parameters<typeof executeRuntimeHost>[1],
      undefined,
      { onTextDelta: (delta) => deltas.push(delta) },
    );

    expect(deltas).toEqual([]);
    expect(result).toMatchObject({ success: false, error_code: "structured_output_invalid" });
  });

  it("logs the complete structured-output response with secret patterns redacted", async () => {
    const calls: string[] = [];
    const providerText = "line one\napi_key=secret-value\nline three";
    __setProviderCommandStoreForTests(fakeStore(calls));
    __setProviderHttpClientForTests({
      async fetch() {
        return new Response(JSON.stringify({
          choices: [{ message: { content: providerText } }],
          model: "gpt-4o-mini",
        }), { status: 200, headers: { "content-type": "application/json" } });
      },
    });
    const logs: Array<{ details: Record<string, unknown>; message: string }> = [];

    const result = await executeRuntimeHost(
      config(),
      requestBody({
        output_format: {
          type: "json_schema",
          schema_id: "research.test.v1",
          schema: { type: "object" },
          strict: true,
        },
      }) as Parameters<typeof executeRuntimeHost>[1],
      {
        error(details, message) {
          logs.push({ details, message });
        },
      },
    );

    expect(result.success).toBe(false);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({ message: "managed API structured output failed" });
    expect(logs[0]!.details.provider_response_text).toBe("line one\n[REDACTED_SECRET]\nline three");
  });

  it("rejects structured objects that violate the declared schema", async () => {
    const calls: string[] = [];
    __setProviderCommandStoreForTests(fakeStore(calls));
    __setProviderHttpClientForTests({
      async fetch() {
        return new Response(JSON.stringify({
          choices: [{ message: { content: JSON.stringify({ value: 7 }) } }],
          model: "gpt-4o-mini",
        }), { status: 200, headers: { "content-type": "application/json" } });
      },
    });
    app = buildServer(config(), { logger: false });

    const res = await app.inject({
      method: "POST",
      url: "/internal/runtime-host/execute",
      headers: { "x-agent-space-internal-token": "internal-token" },
      payload: requestBody({
        output_format: {
          type: "json_schema",
          schema_id: "research.test.v1",
          stage: "synthesis",
          schema: {
            type: "object",
            properties: { value: { type: "string" } },
            required: ["value"],
            additionalProperties: false,
          },
          strict: true,
        },
      }),
    });

    expect(res.json()).toMatchObject({
      success: false,
      error_code: "structured_output_invalid",
    });
    expect(res.json().error_text).toContain("stage=synthesis");
    expect(res.json().error_text).toContain("at $.value:type:string");
  });

  it("uses a forced Anthropic tool for structured output", async () => {
    const calls: string[] = [];
    const bodies: Array<Record<string, unknown>> = [];
    __setProviderCommandStoreForTests(fakeStore(calls, "anthropic"));
    __setProviderHttpClientForTests({
      async fetch(_url, init) {
        bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return new Response(JSON.stringify({
          content: [{ type: "tool_use", id: "structured-1", name: "research_test_v1", input: { value: "ok" } }],
          model: "claude-3-5-sonnet-latest",
          usage: { input_tokens: 3, output_tokens: 2 },
          stop_reason: "tool_use",
        }), { status: 200, headers: { "content-type": "application/json" } });
      },
    });
    app = buildServer(config(), { logger: false });

    const res = await app.inject({
      method: "POST",
      url: "/internal/runtime-host/execute",
      headers: { "x-agent-space-internal-token": "internal-token" },
      payload: requestBody({
        output_format: {
          type: "json_schema",
          schema_id: "research.test.v1",
          schema: { type: "object", properties: { value: { type: "string" } }, required: ["value"] },
          strict: true,
        },
      }),
    });

    expect(res.statusCode).toBe(200);
    expect(bodies[0]).toMatchObject({
      // Structured output no longer installs an Anthropic-only cap; it follows
      // the same request -> modelSpecs -> Pi model authority order.
      max_tokens: 16_384,
      tool_choice: { type: "tool", name: "research_test_v1" },
      tools: [{ name: "research_test_v1" }],
    });
    expect(res.json()).toMatchObject({
      success: true,
      output_json: { value: "ok" },
    });
  });

  it("keeps vendor protocol authoritative over an advertised bridge endpoint", async () => {
    const calls: string[] = [];
    const bodies: Array<Record<string, unknown>> = [];
    __setProviderCommandStoreForTests(fakeStore(calls, "anthropic", [], "https://api.example.test/openai/v1"));
    __setProviderHttpClientForTests({
      async fetch(url, init) {
        calls.push(`url:${url}`);
        bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return new Response(JSON.stringify({
          content: [{ type: "tool_use", id: "structured-1", name: "research_test_v1", input: { value: "ok" } }],
          model: "gpt-4o-mini",
          stop_reason: "tool_use",
          usage: {},
        }), { status: 200, headers: { "content-type": "application/json" } });
      },
    });
    app = buildServer(config(), { logger: false });

    const res = await app.inject({
      method: "POST",
      url: "/internal/runtime-host/execute",
      headers: { "x-agent-space-internal-token": "internal-token" },
      payload: requestBody({
        output_format: {
          type: "json_schema",
          schema_id: "research.test.v1",
          schema: { type: "object", properties: { value: { type: "string" } }, required: ["value"] },
          strict: true,
        },
      }),
    });

    expect(res.statusCode).toBe(200);
    expect(calls).toContain("url:https://api.example.test/v1/messages");
    expect(bodies[0]).toMatchObject({
      tool_choice: { type: "tool", name: "research_test_v1" },
    });
    expect(res.json()).toMatchObject({
      success: true,
      output_json: { value: "ok" },
    });
  });

  it("normalizes a single structured Anthropic tool block from a compatible gateway", async () => {
    const calls: string[] = [];
    __setProviderCommandStoreForTests(fakeStore(calls, "anthropic"));
    __setProviderHttpClientForTests({
      async fetch() {
        return new Response(JSON.stringify({
          content: [{ type: "tool_use", id: "structured-1", name: "json_schema", input: { value: "ok" } }],
          model: "compatible-anthropic-model",
          stop_reason: "tool_use",
        }), { status: 200, headers: { "content-type": "application/json" } });
      },
    });
    app = buildServer(config(), { logger: false });

    const res = await app.inject({
      method: "POST",
      url: "/internal/runtime-host/execute",
      headers: { "x-agent-space-internal-token": "internal-token" },
      payload: requestBody({
        output_format: {
          type: "json_schema",
          schema_id: "research.test.v1",
          schema: { type: "object", properties: { value: { type: "string" } }, required: ["value"] },
          strict: true,
        },
      }),
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      success: true,
      output_json: { value: "ok" },
    });
  });

  it("reports safe Anthropic structured-output diagnostics when no tool block is returned", async () => {
    const calls: string[] = [];
    __setProviderCommandStoreForTests(fakeStore(calls, "anthropic"));
    __setProviderHttpClientForTests({
      async fetch() {
        return new Response(JSON.stringify({
          content: [{ type: "text", text: "I cannot provide that format." }],
          model: "claude-test",
          stop_reason: "end_turn",
        }), { status: 200, headers: { "content-type": "application/json" } });
      },
    });
    app = buildServer(config(), { logger: false });

    const res = await app.inject({
      method: "POST",
      url: "/internal/runtime-host/execute",
      headers: { "x-agent-space-internal-token": "internal-token" },
      payload: requestBody({
        output_format: {
          type: "json_schema",
          schema_id: "research.test.v1",
          schema: { type: "object" },
          strict: true,
        },
      }),
    });

    expect(res.json()).toMatchObject({
      success: false,
      error_code: "structured_output_invalid",
    });
    expect(res.json().error_text).toContain("finish_reason=end_turn");
    // No tool_use block was returned, so the Anthropic path falls back to
    // parsing the plain-text answer (same fallback the OpenAI-compatible path
    // already has) instead of failing outright; the diagnostics record where
    // the value came from without echoing the model's actual words.
    expect(res.json().error_text).toContain("response_kind=message_content");
    expect(res.json().error_text).toContain("transport=anthropic");
    expect(res.json().error_text).not.toContain("I cannot provide");
  });

  it("rejects structured output before network access for unsupported providers", async () => {
    const calls: string[] = [];
    __setProviderCommandStoreForTests(fakeStore(calls, "cohere"));
    __setProviderHttpClientForTests(fakeHttpClient(calls));
    app = buildServer(config(), { logger: false });

    const res = await app.inject({
      method: "POST",
      url: "/internal/runtime-host/execute",
      headers: { "x-agent-space-internal-token": "internal-token" },
      payload: requestBody({
        output_format: {
          type: "json_schema",
          schema_id: "research.test.v1",
          schema: { type: "object" },
          strict: true,
        },
      }),
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      success: false,
      error_code: "structured_output_unsupported",
    });
    expect(calls).toEqual(["target:provider-1"]);
  });

  it("returns provider network errors instead of a generic runtime host failure", async () => {
    const calls: string[] = [];
    __setProviderCommandStoreForTests(fakeStore(calls));
    __setProviderHttpClientForTests({
      async fetch(_url, init) {
        calls.push(`fetch:${JSON.parse(String(init?.body)).model}`);
        const error = new Error("fetch failed") as Error & { cause?: Error };
        error.cause = new Error("getaddrinfo ENOTFOUND api.example.test");
        throw error;
      },
    });
    app = buildServer(config(), { logger: false });

    const res = await app.inject({
      method: "POST",
      url: "/internal/runtime-host/execute",
      headers: { "x-agent-space-internal-token": "internal-token" },
      payload: requestBody(),
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      success: false,
      error_code: "provider_network_error",
      exit_code: 1,
    });
    expect(res.json().error_text).toContain("Connection error");
    expect(res.json().error_text).not.toContain("server runtime host provider invocation failed");
    expect(calls).toEqual([
      "target:provider-1",
      "fetch:gpt-4o-mini",
      "fetch:gpt-4o-mini",
      "fetch:gpt-4o-mini",
      "fetch:gpt-4o-mini",
      "outcome:member-1:failure",
    ]);
    // Report the real attempt count instead of a hardcoded "attempt=1" —
    // this request has no output_format, so it isn't in the message text,
    // but the structured fields must still be accurate.
    expect(res.json().output_json).toMatchObject({ attempt: 4 });
  });

  it("reports the real retry count in a structured-output failure instead of a hardcoded attempt=1", async () => {
    const calls: string[] = [];
    __setProviderCommandStoreForTests(fakeStore(calls));
    __setProviderHttpClientForTests({
      async fetch(_url, init) {
        calls.push(`fetch:${JSON.parse(String(init?.body)).model}`);
        const error = new Error("fetch failed") as Error & { cause?: Error };
        error.cause = new Error("read ECONNRESET");
        throw error;
      },
    });
    app = buildServer(config(), { logger: false });

    const res = await app.inject({
      method: "POST",
      url: "/internal/runtime-host/execute",
      headers: { "x-agent-space-internal-token": "internal-token" },
      payload: requestBody({
        output_format: {
          type: "json_schema",
          schema_id: "research.test.v1",
          schema: { type: "object" },
          strict: true,
        },
      }),
    });

    expect(res.statusCode).toBe(200);
    // Same-key retries for a pure network failure (no response ever
    // received): 1 initial attempt + 3 retries (see MAX_NETWORK_ERROR_RETRIES
    // in invocation.ts) = 4 real requests before the provider fallback layer
    // gives up — a genuine connection reset is unrelated to which key is
    // used and often clears up within a few attempts, unlike a
    // provider-classified transient *response* (e.g. 503).
    expect(res.json().error_text).toContain("attempt=4");
    expect(res.json().output_json).toMatchObject({ attempt: 4 });
  });

  it("forwards native messages to the provider when supplied", async () => {
    const calls: string[] = [];
    const bodies: Array<Record<string, unknown>> = [];
    __setProviderCommandStoreForTests(fakeStore(calls));
    __setProviderHttpClientForTests({
      async fetch(_url, init) {
        bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return new Response(
          JSON.stringify({
            choices: [{ message: { content: "native output" } }],
            model: "gpt-4o-mini",
            usage: { prompt_tokens: 7, completion_tokens: 2, total_tokens: 9 },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      },
    });
    app = buildServer(config(), { logger: false });

    const res = await app.inject({
      method: "POST",
      url: "/internal/runtime-host/execute",
      headers: { "x-agent-space-internal-token": "internal-token" },
      payload: requestBody({
        prompt: "fallback prompt",
        messages: [
          { role: "system", content: "Keep prior system context." },
          { role: "user", content: "Earlier question" },
          { role: "assistant", content: "Earlier answer" },
          { role: "user", content: "Continue" },
        ],
      }),
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ success: true, output_text: "native output" });
    expect(bodies[0]).toMatchObject({
      messages: [
        { role: "system", content: "Be direct.\n\nKeep prior system context." },
        { role: "user", content: "Earlier question" },
        { role: "assistant", content: "Earlier answer" },
        { role: "user", content: "Continue" },
      ],
    });
    expect(JSON.stringify(bodies[0])).not.toContain("fallback prompt");
  });

  it("rejects tool definitions when tool mode is disabled", async () => {
    const calls: string[] = [];
    __setProviderCommandStoreForTests(fakeStore(calls));
    __setProviderHttpClientForTests(fakeHttpClient(calls));
    app = buildServer(config(), { logger: false });

    const res = await app.inject({
      method: "POST",
      url: "/internal/runtime-host/execute",
      headers: { "x-agent-space-internal-token": "internal-token" },
      payload: requestBody({
        tool_mode: "disabled",
        tools: [{ name: "retrieval.search", input_schema: { type: "object" } }],
      }),
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      success: false,
      error_code: "runtime_tools_disabled",
      exit_code: 1,
    });
    expect(calls).toEqual([]);
  });

  it("passes authorized tool definitions to OpenAI-compatible providers and returns tool calls", async () => {
    const calls: string[] = [];
    const bodies: Array<Record<string, unknown>> = [];
    __setProviderCommandStoreForTests(fakeStore(calls));
    __setProviderHttpClientForTests({
      async fetch(_url, init) {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        bodies.push(body);
        return new Response(
          JSON.stringify({
            choices: [
              {
                finish_reason: "tool_calls",
                message: {
                  content: null,
                  tool_calls: [
                    {
                      id: "call-1",
                      type: "function",
                      function: {
                        name: "retrieval_search",
                        arguments: "{\"query\":\"alpha\"}",
                      },
                    },
                  ],
                },
              },
            ],
            model: "gpt-4o-mini",
            usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      },
    });
    app = buildServer(config(), { logger: false });

    const res = await app.inject({
      method: "POST",
      url: "/internal/runtime-host/execute",
      headers: { "x-agent-space-internal-token": "internal-token" },
      payload: requestBody({
        tool_mode: "authorized_bindings",
        tools: [
          {
            name: "retrieval.search",
            description: "Search knowledge",
            input_schema: { type: "object", properties: { query: { type: "string" } } },
          },
        ],
      }),
    });

    expect(res.statusCode).toBe(200);
    expect(bodies[0]).toMatchObject({
      tools: [
        {
          type: "function",
          function: { name: "retrieval_search" },
        },
      ],
    });
    expect(res.json()).toMatchObject({
      success: true,
      output_json: {
        tool_calls: [
          {
            id: "call-1",
            name: "retrieval.search",
            arguments_json: "{\"query\":\"alpha\"}",
          },
        ],
      },
      adapter_metadata: {
        tool_mode: "authorized_bindings",
        tool_count: 1,
      },
    });
    expect(res.json().events.map((event: { type: string }) => event.type)).toEqual([
      "model.message_start",
      "model.tool_call_delta",
      "model.usage",
      "model.message_stop",
    ]);
  });

  it("returns unadvertised tool calls to the owned dispatch boundary", async () => {
    const calls: string[] = [];
    __setProviderCommandStoreForTests(fakeStore(calls));
    __setProviderHttpClientForTests({
      async fetch() {
        return openAiChatResponse({
          choices: [{
            finish_reason: "tool_calls",
            message: {
              content: null,
              tool_calls: [{
                id: "call-unknown",
                type: "function",
                function: { name: "unadvertised_tool", arguments: "{}" },
              }],
            },
          }],
          model: "gpt-4o-mini",
          usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
        });
      },
    });

    const result = await executeRuntimeHost(
      config(),
      requestBody({
        tool_mode: "authorized_bindings",
        tools: [{ name: "retrieval.search", input_schema: { type: "object" } }],
      }) as Parameters<typeof executeRuntimeHost>[1],
    );

    expect(result.output_json).toMatchObject({
      tool_calls: [{ id: "call-unknown", name: "unadvertised_tool", arguments_json: "{}" }],
    });
  });

  it("passes authorized tool definitions to Anthropic providers and returns tool_use calls", async () => {
    const calls: string[] = [];
    __setProviderCommandStoreForTests(fakeStore(calls, "anthropic"));
    const bodies: Array<Record<string, unknown>> = [];
    __setProviderHttpClientForTests({
      async fetch(_url, init) {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        bodies.push(body);
        return new Response(
          JSON.stringify({
            content: [
              { type: "text", text: "I should search first." },
              {
                type: "tool_use",
                id: "toolu_1",
                name: "retrieval_search",
                input: { query: "alpha" },
              },
            ],
            model: "claude-3-5-sonnet-latest",
            stop_reason: "tool_use",
            usage: { input_tokens: 3, output_tokens: 2 },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      },
    });
    app = buildServer(config(), { logger: false });

    const res = await app.inject({
      method: "POST",
      url: "/internal/runtime-host/execute",
      headers: { "x-agent-space-internal-token": "internal-token" },
      payload: requestBody({
        model: "claude-3-5-sonnet-latest",
        tool_mode: "authorized_bindings",
        tools: [
          {
            name: "retrieval.search",
            description: "Search knowledge",
            input_schema: { type: "object", properties: { query: { type: "string" } } },
          },
        ],
      }),
    });

    expect(res.statusCode).toBe(200);
    expect(bodies[0]).toMatchObject({
      model: "claude-3-5-sonnet-latest",
      tools: [
        {
          name: "retrieval_search",
          input_schema: { type: "object", properties: { query: { type: "string" } } },
        },
      ],
      messages: [{ role: "user", content: "Say hello" }],
    });
    expect(res.json()).toMatchObject({
      success: true,
      output_text: "I should search first.",
      output_json: {
        tool_calls: [
          {
            id: "toolu_1",
            name: "retrieval.search",
            arguments_json: "{\"query\":\"alpha\"}",
          },
        ],
      },
      adapter_metadata: {
        tool_mode: "authorized_bindings",
        tool_count: 1,
      },
    });
    expect(res.json().events.map((event: { type: string }) => event.type)).toEqual([
      "model.message_start",
      "model.text_delta",
      "model.tool_call_delta",
      "model.usage",
      "model.message_stop",
    ]);
  });

  it("formats Anthropic tool results as immediately-following user tool_result blocks", async () => {
    const calls: string[] = [];
    const bodies: Array<Record<string, unknown>> = [];
    __setProviderCommandStoreForTests(fakeStore(calls, "anthropic"));
    __setProviderHttpClientForTests({
      async fetch(_url, init) {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        bodies.push(body);
        return new Response(
          JSON.stringify({
            content: [{ type: "text", text: "final answer" }],
            model: "claude-3-5-sonnet-latest",
            stop_reason: "end_turn",
            usage: { input_tokens: 8, output_tokens: 3 },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      },
    });
    app = buildServer(config(), { logger: false });

    const res = await app.inject({
      method: "POST",
      url: "/internal/runtime-host/execute",
      headers: { "x-agent-space-internal-token": "internal-token" },
      payload: requestBody({
        model: "claude-3-5-sonnet-latest",
        messages: [
          { role: "user", content: "Find alpha" },
          {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: "toolu_1",
                name: "retrieval.search",
                arguments_json: "{\"query\":\"alpha\"}",
              },
            ],
          },
          {
            role: "tool",
            tool_call_id: "toolu_1",
            name: "retrieval.search",
            content: "{\"ok\":true}",
          },
        ],
        tool_mode: "authorized_bindings",
        tools: [
          {
            name: "retrieval.search",
            description: "Search knowledge",
            input_schema: { type: "object", properties: { query: { type: "string" } } },
          },
        ],
      }),
    });

    expect(res.statusCode).toBe(200);
    expect(bodies[0]).toMatchObject({
      messages: [
        { role: "user", content: "Find alpha" },
        {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "toolu_1",
              name: "retrieval_search",
              input: { query: "alpha" },
            },
          ],
        },
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "toolu_1",
              content: "{\"ok\":true}",
            },
          ],
        },
      ],
    });
    expect(res.json()).toMatchObject({
      success: true,
      output_text: "final answer",
      output_json: {},
    });
  });

  it("fails explicitly when authorized tools target an unsupported provider type", async () => {
    const calls: string[] = [];
    __setProviderCommandStoreForTests(fakeStore(calls, "ollama"));
    __setProviderHttpClientForTests({
      async fetch() {
        throw new Error("unsupported provider should not receive tool request");
      },
    });
    app = buildServer(config(), { logger: false });

    const res = await app.inject({
      method: "POST",
      url: "/internal/runtime-host/execute",
      headers: { "x-agent-space-internal-token": "internal-token" },
      payload: requestBody({
        tool_mode: "authorized_bindings",
        tools: [
          {
            name: "retrieval.search",
            description: "Search knowledge",
            input_schema: { type: "object", properties: { query: { type: "string" } } },
          },
        ],
      }),
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      success: false,
      // Specific code so the managed-run tool loop can degrade to a no-tool turn.
      error_code: "runtime_tool_provider_unsupported",
      exit_code: 1,
    });
    expect(res.json().error_text).toContain("does not support runtime-host tools");
    expect(calls).toEqual([
      "target:provider-1",
      "outcome:member-1:failure",
    ]);
  });

  it("uses conservative Chat Completions fields for Ollama", async () => {
    const calls: string[] = [];
    const bodies: Array<Record<string, unknown>> = [];
    __setProviderCommandStoreForTests(fakeStore(calls, "ollama", [], null, "llama3"));
    __setProviderHttpClientForTests({
      async fetch(_url, init) {
        bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return openAiChatResponse({
          choices: [{ message: { content: "local reply" }, finish_reason: "stop" }],
          model: "llama3",
        });
      },
    });

    const result = await executeRuntimeHost(
      config(),
      requestBody({ model: "llama3", max_tokens: 321 }) as Parameters<typeof executeRuntimeHost>[1],
    );

    expect(result).toMatchObject({ success: true, output_text: "local reply" });
    expect(bodies[0]).toMatchObject({ model: "llama3", max_tokens: 321 });
    expect(bodies[0]?.max_completion_tokens).toBeUndefined();
    expect(bodies[0]?.store).toBeUndefined();
  });

  it("uses a catalog-valid DeepSeek model when none is configured", async () => {
    const calls: string[] = [];
    const bodies: Array<Record<string, unknown>> = [];
    __setProviderCommandStoreForTests(fakeStore(calls, "deepseek", [], null, null));
    __setProviderHttpClientForTests({
      async fetch(_url, init) {
        bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return openAiChatResponse({
          choices: [{ message: { content: "deep reply" }, finish_reason: "stop" }],
          model: "deepseek-v4-flash",
        });
      },
    });

    const result = await executeRuntimeHost(
      config(),
      requestBody({ model: undefined }) as Parameters<typeof executeRuntimeHost>[1],
    );

    expect(result).toMatchObject({ success: true, output_text: "deep reply", model: "deepseek-v4-flash" });
    expect(bodies[0]).toMatchObject({ model: "deepseek-v4-flash" });
  });

  it("advertises the runtime host only with server credential authority", async () => {
    app = buildServer(config(), { logger: false });

    const res = await app.inject({ method: "GET", url: "/api/v1/server/features" });

    expect(res.statusCode).toBe(200);
    expect((res.json() as { features: string[] }).features).toContain(
      "server_agent_runtime_host",
    );
  });
});
