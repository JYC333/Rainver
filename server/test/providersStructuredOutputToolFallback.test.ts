import { afterEach, describe, expect, it } from "vitest";
import { __setProviderHttpClientForTests, completeProviderChat, ProviderInvocationError } from "../src/modules/providers/invocation/invocation.js";
import { type InvocationTarget, type PoolOutcome, type ProviderCommandStore } from "../src/modules/providers/commands/store.js";
import type { UsageObservation } from "../src/modules/usage/index.js";
import { openAiChatResponse } from "./support/piAiHttp.js";

// pi-ai expresses structured output as a constrained tool. Providers without
// strict-tool support can still return text, which the rainver scavenger
// validates at the boundary.

afterEach(() => {
  __setProviderHttpClientForTests(null);
});

function target(providerId: string): InvocationTarget {
  return {
    provider: {
      id: providerId,
      space_id: "space-1",
      name: providerId,
      provider_type: "openai_compatible",
      base_url: `https://api.${providerId}.test/v1`,
      network_profile_id: null,
      default_model: "test-model",
      available_models: [],
      enabled: true,
      is_default: false,
    },
    network_profile: null,
    rotation_strategy: "fill_first",
    fallback_provider_ids: [],
    candidates: [{ member_id: "m1", credential_id: "cred-m1", api_key: "k1" }],
  };
}

function makeStore(targets: Record<string, InvocationTarget>): ProviderCommandStore {
  const unsupported = () => {
    throw new Error("not used in this test");
  };
  return {
    createProvider: unsupported,
    updateProvider: unsupported,
    deleteProvider: unsupported,
    grantProviderToSpace: unsupported,
    revokeProviderGrant: unsupported,
    async getInvocationTarget(_spaceId, providerId) {
      const t = targets[providerId ?? "default"];
      if (!t) throw new ProviderInvocationError(404, `no provider ${providerId}`);
      return { ...t, candidates: [...t.candidates] };
    },
    async recordPoolOutcome(_memberId: string, _outcome: PoolOutcome) {},
    async resolveUsageAttribution() {
      return {
        owner_user_id: "user-1",
        visibility: "private" as const,
        access_level: "full" as const,
        source_resource_type: null,
        source_resource_id: null,
        project_folder_id: null,
        project_id: null,
        grant_snapshots: [],
      };
    },
    async recordUsageObservation(_input: UsageObservation) {},
    resolveProviderApiKey: unsupported,
    resolveCredentialApiKey: unsupported,
    async listConfiguredModels() {
      return [];
    },
    recordCliCredentialUsage: unsupported,
    listPool: unsupported,
    addPoolCredential: unsupported,
    removePoolCredential: unsupported,
    updatePoolConfig: unsupported,
    async getTaskChain() {
      return null;
    },
    listTaskPolicies: unsupported,
    putTaskPolicy: unsupported,
    deleteTaskPolicy: unsupported,
  };
}

interface Attempt {
  body: Record<string, unknown>;
}

function scriptedHttp(script: Array<{ status: number; body: unknown }>): Attempt[] {
  const attempts: Attempt[] = [];
  __setProviderHttpClientForTests({
    async fetch(_url, init) {
      const body = init?.body ? JSON.parse(String(init.body)) : {};
      attempts.push({ body });
      const step = script.shift() ?? { status: 500, body: { error: "script exhausted" } };
      return openAiChatResponse(step.body, step.status);
    },
  });
  return attempts;
}

const OUTPUT_FORMAT = {
  type: "json_schema" as const,
  schema_id: "test.schema.v1",
  schema: {
    type: "object",
    properties: { answer: { type: "string" } },
    required: ["answer"],
    additionalProperties: false,
  },
};

const EXPECTED_TOOL_NAME = "test_schema_v1";

const CHAT = {
  messages: [{ role: "user", content: "hi" }],
  max_tokens: 5,
  provider_id: "p1",
  metering: { subject_user_id: "user-1" },
};

describe("openai-compatible structured output forced-tool fallback", () => {
  it("offers the schema as a forced constrained tool when the request has no runtime tools", async () => {
    const store = makeStore({ p1: target("p1") });
    const attempts = scriptedHttp([
      { status: 200, body: { choices: [{ message: { content: '{"answer":"ok"}' } }], model: "test-model", usage: {} } },
    ]);

    const result = await completeProviderChat(store, "space-1", { ...CHAT, output_format: OUTPUT_FORMAT });

    expect(result.structured_output).toEqual({ answer: "ok" });
    const request = attempts[0]!.body;
    expect(request.max_tokens).toBe(5);
    expect(request.max_completion_tokens).toBeUndefined();
    expect(request.store).toBeUndefined();
    expect(request.tools).toEqual([
      {
        type: "function",
        function: {
          name: EXPECTED_TOOL_NAME,
          description: "Return the test.schema.v1 structured result.",
          parameters: OUTPUT_FORMAT.schema,
          strict: true,
        },
      },
    ]);
    expect(request.tool_choice).toEqual({ type: "function", function: { name: EXPECTED_TOOL_NAME } });
    expect(request.response_format).toBeUndefined();
  });

  it("does not infer transport quirks from the model name", async () => {
    const store = makeStore({ p1: target("p1") });
    const attempts = scriptedHttp([
      { status: 200, body: { choices: [{ message: { content: '<think>plan</think>\n```json\n{"answer":"ok"}\n```' } }], model: "MiniMax-M3", usage: {} } },
    ]);

    const result = await completeProviderChat(store, "space-1", { ...CHAT, model: "MiniMax-M3", output_format: OUTPUT_FORMAT });

    expect(result.structured_output).toEqual({ answer: "ok" });
    const request = attempts[0]!.body;
    expect((request.tools as Array<{ function: { name: string } }>)[0]?.function.name).toBe(EXPECTED_TOOL_NAME);
    expect(request.tool_choice).toEqual({ type: "function", function: { name: EXPECTED_TOOL_NAME } });
  });

  it("parses the structured payload from forced tool-call arguments when the provider ignores response_format", async () => {
    const store = makeStore({ p1: target("p1") });
    scriptedHttp([
      {
        status: 200,
        body: {
          choices: [{
            finish_reason: "tool_calls",
            message: {
              content: "<think>reasoning</think>Sure, calling the tool.",
              tool_calls: [{ id: "call-1", type: "function", function: { name: EXPECTED_TOOL_NAME, arguments: '{"answer":"ok"}' } }],
            },
          }],
          model: "test-model",
          usage: {},
        },
      },
    ]);

    const result = await completeProviderChat(store, "space-1", { ...CHAT, output_format: OUTPUT_FORMAT });

    expect(result.structured_output).toEqual({ answer: "ok" });
  });

  it("carries the offending tool-call arguments on the failure's responseText, not only the message prose", async () => {
    const store = makeStore({ p1: target("p1") });
    const badToolCallResponse = {
      status: 200,
      body: {
        choices: [{
          finish_reason: "tool_calls",
          message: {
            content: "<think>long reasoning</think>I'll call the tool now.",
            tool_calls: [{ id: "call-1", type: "function", function: { name: EXPECTED_TOOL_NAME, arguments: '{"wrong":"shape"}' } }],
          },
        }],
        model: "test-model",
        usage: {},
      },
    };
    // The corrective retry gets one more chance; both attempts stay invalid.
    scriptedHttp([badToolCallResponse, badToolCallResponse]);

    let caught: unknown;
    try {
      await completeProviderChat(store, "space-1", { ...CHAT, output_format: OUTPUT_FORMAT });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ProviderInvocationError);
    const failure = caught as ProviderInvocationError;
    expect(failure.code).toBe("structured_output_invalid");
    // Without the tool-call arguments the failure logger only ever showed the
    // reasoning prose, leaving the payload that actually failed the schema
    // unrecorded anywhere.
    expect(failure.responseText).toContain('{"wrong":"shape"}');
    expect(failure.responseText).toContain("I'll call the tool now.");
  });

  it("does not force the schema tool when the request carries its own runtime tools", async () => {
    const store = makeStore({ p1: target("p1") });
    const attempts = scriptedHttp([
      { status: 200, body: { choices: [{ message: { content: '{"answer":"ok"}' } }], model: "test-model", usage: {} } },
    ]);

    await completeProviderChat(store, "space-1", {
      ...CHAT,
      output_format: OUTPUT_FORMAT,
      tools: [{ name: "runtime_tool", description: "a runtime tool", input_schema: { type: "object", properties: {} } }],
    });

    const request = attempts[0]!.body;
    expect(request.tool_choice).toBeUndefined();
    expect((request.tools as Array<{ function: { name: string } }>).map((tool) => tool.function.name)).toEqual(["runtime_tool"]);
  });

  it("keeps requests without output_format unchanged (no tools, no response_format)", async () => {
    const store = makeStore({ p1: target("p1") });
    const attempts = scriptedHttp([
      { status: 200, body: { choices: [{ message: { content: "ok" } }], model: "test-model", usage: {} } },
    ]);

    const result = await completeProviderChat(store, "space-1", { ...CHAT });

    expect(result.content).toBe("ok");
    const request = attempts[0]!.body;
    expect(request.tools).toBeUndefined();
    expect(request.tool_choice).toBeUndefined();
    expect(request.response_format).toBeUndefined();
  });

  it("retries once with the validation failure quoted back when structured output fails the schema", async () => {
    const store = makeStore({ p1: target("p1") });
    const attempts = scriptedHttp([
      { status: 200, body: { choices: [{ message: { content: '{"plan":{"wrong":1},"notes":"x"}' } }], model: "MiniMax-M3", usage: {} } },
      { status: 200, body: { choices: [{ message: { content: '{"answer":"ok"}' } }], model: "MiniMax-M3", usage: {} } },
    ]);

    const result = await completeProviderChat(store, "space-1", { ...CHAT, model: "MiniMax-M3", output_format: OUTPUT_FORMAT });

    expect(result.structured_output).toEqual({ answer: "ok" });
    expect(attempts).toHaveLength(2);
    const correction = attempts[1]!.body.messages as Array<{ role: string; content: string }>;
    expect(correction.at(-2)?.role).toBe("assistant");
    expect(correction.at(-1)?.content).toContain("failed JSON schema validation for 'test.schema.v1'");
    expect(correction.at(-1)?.content).toContain("exactly these keys: answer");
  });

  it("fails permanently when the corrective retry still violates the schema", async () => {
    const store = makeStore({ p1: target("p1") });
    const attempts = scriptedHttp([
      { status: 200, body: { choices: [{ message: { content: '{"wrong":1}' } }], model: "MiniMax-M3", usage: {} } },
      { status: 200, body: { choices: [{ message: { content: '{"still_wrong":1}' } }], model: "MiniMax-M3", usage: {} } },
    ]);

    await expect(completeProviderChat(store, "space-1", { ...CHAT, model: "MiniMax-M3", output_format: OUTPUT_FORMAT }))
      .rejects.toMatchObject({ code: "structured_output_invalid" });
    expect(attempts).toHaveLength(2);
  });

  it("uses model output guidance only when the caller leaves the budget unset", async () => {
    const store = makeStore({ p1: target("p1") });
    const attempts = scriptedHttp([
      { status: 200, body: { choices: [{ message: { content: "ok" } }], model: "MiniMax-M3", usage: {} } },
      { status: 200, body: { choices: [{ message: { content: "ok" } }], model: "MiniMax-M3", usage: {} } },
      { status: 200, body: { choices: [{ message: { content: "ok" } }], model: "MiniMax-M3", usage: {} } },
      { status: 200, body: { choices: [{ message: { content: "ok" } }], model: "test-model", usage: {} } },
    ]);

    const { max_tokens: _unused, ...chatWithoutMaxTokens } = CHAT as typeof CHAT & { max_tokens?: number };
    await completeProviderChat(store, "space-1", { ...chatWithoutMaxTokens, model: "MiniMax-M3" });
    await completeProviderChat(store, "space-1", { ...CHAT, model: "MiniMax-M3" });
    await completeProviderChat(store, "space-1", { ...CHAT, max_tokens: 200_000, model: "MiniMax-M3" });
    await completeProviderChat(store, "space-1", { ...chatWithoutMaxTokens });

    // Known model without an explicit budget gets the recommendation.
    expect(attempts[0]!.body.max_completion_tokens ?? attempts[0]!.body.max_tokens).toBe(131_072);
    // Explicit request budgets remain authoritative.
    expect(attempts[1]!.body.max_completion_tokens ?? attempts[1]!.body.max_tokens).toBe(5);
    // A larger caller budget still wins.
    expect(attempts[2]!.body.max_completion_tokens ?? attempts[2]!.body.max_tokens).toBe(200_000);
    // Unknown models keep the previous behavior (provider default).
    expect(attempts[3]!.body.max_tokens).toBeUndefined();
  });
});
