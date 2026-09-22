import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { __setNetworkRetryDelayForTests, __setProviderHttpClientForTests, completeProviderChat, completeProviderEmbedding, completeProviderRerank, completeProviderText, ProviderInvocationError } from "../src/modules/providers/invocation/invocation.js";
import { orderPoolMembers, type InvocationTarget, type PoolOutcome, type ProviderCommandStore, type ProviderTaskChainEntry } from "../src/modules/providers/commands/store.js";
import type { UsageObservation } from "../src/modules/usage/index.js";
import { anthropicChatResponse, openAiChatResponse } from "./support/piAiHttp.js";
import { CredentialSpendDeniedError } from "../src/modules/policy/credentialSpend.js";

// Network-error retries add a real delay between attempts (see
// NETWORK_ERROR_RETRY_DELAY_MS in invocation.ts) — skip it here so tests
// that exhaust retries don't take multiple real seconds.
beforeEach(() => {
  __setNetworkRetryDelayForTests(async () => {});
});

afterEach(() => {
  __setProviderHttpClientForTests(null);
  __setNetworkRetryDelayForTests(null);
});

function target(
  providerId: string,
  keys: Array<{ member: string; key: string | null }>,
  overrides: Partial<InvocationTarget["provider"]> & {
    fallback_provider_ids?: string[];
  } = {},
): InvocationTarget {
  const { fallback_provider_ids = [], ...provider } = overrides;
  return {
    provider: {
      id: providerId,
      space_id: "space-1",
      name: providerId,
      provider_type: "openai",
      base_url: `https://api.${providerId}.test/v1`,
      network_profile_id: null,
      default_model: `default-of-${providerId}`,
      available_models: [],
      enabled: true,
      is_default: false,
      ...provider,
    },
    network_profile: null,
    rotation_strategy: "fill_first",
    fallback_provider_ids,
    candidates: keys.map(({ member, key }) => ({
      member_id: member,
      credential_id: `cred-${member}`,
      api_key: key,
    })),
  };
}

function makeStore(
  targets: Record<string, InvocationTarget>,
  outcomes: Array<{ member: string; outcome: PoolOutcome }>,
  taskChains: Record<string, ProviderTaskChainEntry[]> = {},
  usageObservations: UsageObservation[] = [],
  usageRecorder?: (input: UsageObservation) => Promise<void>,
): ProviderCommandStore {
  const unsupported = () => {
    throw new Error("not used in this test");
  };
  return {
    createProvider: unsupported,
    updateProvider: unsupported,
    deleteProvider: unsupported,
    grantProviderToSpace: unsupported,
    revokeProviderGrant: unsupported,
    async authorizeCredentialSpend() {
      return {} as never;
    },
    async getInvocationTarget(_spaceId, providerId) {
      const t = targets[providerId ?? "default"];
      if (!t) throw new ProviderInvocationError(404, `no provider ${providerId}`);
      // Fresh candidate array per call: per-turn restarts must not see
      // mutations from a previous walk.
      return { ...t, candidates: [...t.candidates] };
    },
    async recordPoolOutcome(memberId, outcome) {
      outcomes.push({ member: memberId, outcome });
    },
    async resolveUsageAttribution(input) {
      return {
        owner_user_id: input.subject_user_id ?? "user-1",
        visibility: "private",
        access_level: "full",
        source_resource_type: input.source_resource_type ?? (input.run_id ? "run" : null),
        source_resource_id: input.source_resource_id ?? input.run_id ?? null,
        project_folder_id: null,
        project_id: null,
        grant_snapshots: [],
      };
    },
    async recordUsageObservation(input) {
      if (usageRecorder) return usageRecorder(input);
      usageObservations.push(input);
    },
    resolveProviderApiKey: unsupported,
    resolveCredentialApiKey: unsupported,
    async listConfiguredModels() {
      return [];
    },
    listPool: unsupported,
    addPoolCredential: unsupported,
    removePoolCredential: unsupported,
    updatePoolConfig: unsupported,
    async getTaskChain(_spaceId, task) {
      return taskChains[task] ?? null;
    },
    listTaskPolicies: unsupported,
    putTaskPolicy: unsupported,
    deleteTaskPolicy: unsupported,
  };
}

interface Attempt {
  url: string;
  key: string | null;
  model: string | null;
  body: Record<string, unknown>;
}

/** Scripted provider HTTP client: pops one response per fetch call. */
function scriptedHttp(script: Array<{ status: number; body?: unknown }>): Attempt[] {
  const attempts: Attempt[] = [];
  __setProviderHttpClientForTests({
    async fetch(url, init) {
      const headers = new Headers(init?.headers);
      const body = init?.body ? JSON.parse(String(init.body)) : {};
      attempts.push({
        url,
        key: headers.get("authorization")?.replace("Bearer ", "") ?? headers.get("x-api-key"),
        model: body.model ?? null,
        body,
      });
      const step = script.shift() ?? { status: 500, body: { error: "script exhausted" } };
      const payload =
        step.body ??
        (String(url).endsWith("/embeddings")
          ? {
              data: (body.input ?? []).map((_input: string, index: number) => ({
                embedding: [index + 1],
                index,
              })),
              model: body.model,
            }
          : {
              choices: [{ message: { content: "ok" } }],
              model: body.model,
              usage: {},
            });
      return String(url).endsWith("/embeddings") || String(url).includes("/models/") || String(url).includes("/v2/")
        ? new Response(JSON.stringify(payload), {
            status: step.status,
            headers: { "content-type": "application/json" },
          })
        : openAiChatResponse(payload, step.status);
    },
  });
  return attempts;
}

/**
 * A response the provider committed to with 200 headers and then failed to
 * deliver — undici's `terminated`, reproduced at the only layer that can see
 * it. The opening chunk carries no text, so this is the structured-output
 * shape: nothing has been handed to the caller that a retry would duplicate.
 */
function terminatedStreamResponse(): Response {
  const chunk = {
    id: "chatcmpl_test",
    object: "chat.completion.chunk",
    created: 1,
    model: "test-model",
    choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }],
  };
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(chunk)}\n\n`));
      controller.error(new TypeError("terminated"));
    },
  });
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

const CHAT = {
  messages: [{ role: "user", content: "hi" }],
  max_tokens: 5,
  metering: { subject_user_id: "user-1" },
};

describe("provider invocation resilience", () => {
  it("binds formal ProviderTask Runs to each physical attempt and usage observation", async () => {
    const usage: UsageObservation[] = [];
    const lifecycleEvents: string[] = [];
    let attemptNumber = 0;
    const store: ProviderCommandStore = {
      ...makeStore({ p1: target("p1", [{ member: "m1", key: "k1" }]) }, [], {}, usage),
      async beginProviderTaskAttempt(input) {
        attemptNumber += 1;
        const refs = {
          invocation_id: `invocation-${attemptNumber}`,
          control_id: `control-${attemptNumber}`,
          delivery_id: `delivery-${attemptNumber}`,
          invocation_snapshot_id: `snapshot-${attemptNumber}`,
          usage_source_id: `usage-${attemptNumber}`,
          attempt: 1,
          provider_id: input.provider_id,
          model: input.model,
        };
        const runId = await input.on_started?.({
          async query<Row>() { return { rows: [] as Row[], rowCount: 0 }; },
        }, refs);
        lifecycleEvents.push(`started:${runId}`);
        return { ...refs, ...(runId ? { run_id: runId } : {}) };
      },
      async completeProviderTaskAttempt(_refs, outcome) {
        lifecycleEvents.push(`ledger:${outcome.status}`);
      },
    };
    scriptedHttp([{
      status: 200,
      body: { choices: [{ message: { content: "report" } }], model: "gpt-4o", usage: { prompt_tokens: 1, completion_tokens: 1 } },
    }]);

    await completeProviderText(store, "space-1", {
      spend: { kind: "person", user_id: "user-1" },
      provider_id: "p1",
      system: "system",
      user: "bounded report",
      task: "daily_report",
      metering: { subject_user_id: "user-1" },
      providerTaskRunLifecycle: {
        async onAttemptStarted(_db, refs) {
          lifecycleEvents.push(`run-start:${refs.delivery_id}`);
          return "provider-run-1";
        },
        async onAttemptCompleted(refs, outcome) {
          lifecycleEvents.push(`run-${outcome.status}:${refs.run_id}`);
        },
      },
    });

    expect(lifecycleEvents).toEqual([
      "run-start:delivery-1",
      "started:provider-run-1",
      "ledger:accepted",
      "run-accepted:provider-run-1",
    ]);
    expect(usage[0]).toMatchObject({
      run_id: "provider-run-1",
      source_resource_type: "run",
      source_resource_id: "provider-run-1",
    });
  });

  it("rejects missing usage attribution before any provider request", async () => {
    const store = makeStore(
      { p1: target("p1", [{ member: "m1", key: "k1" }]) },
      [],
    );
    const attempts = scriptedHttp([{ status: 200 }]);

    await expect(completeProviderChat(store, "space-1", {
      spend: { kind: "person", user_id: "user-1" },
      ...CHAT,
      provider_id: "p1",
      metering: {},
    })).rejects.toMatchObject({ code: "usage_attribution_required", statusCode: 422 });
    expect(attempts).toHaveLength(0);
  });

  it("rejects unavailable source attribution before any provider request", async () => {
    const store = makeStore(
      { p1: target("p1", [{ member: "m1", key: "k1" }]) },
      [],
    );
    store.resolveUsageAttribution = async () => {
      throw Object.assign(new Error("Usage source resource is unavailable"), { statusCode: 422 });
    };
    const attempts = scriptedHttp([{ status: 200 }]);

    await expect(completeProviderChat(store, "space-1", {
      spend: { kind: "person", user_id: "user-1" },
      ...CHAT,
      provider_id: "p1",
      metering: { source_resource_type: "run", source_resource_id: "missing-run" },
    })).rejects.toMatchObject({ code: "usage_attribution_required", statusCode: 422 });

    expect(attempts).toHaveLength(0);
  });

  it("retries the same key once on a transient 429, then succeeds", async () => {
    const outcomes: Array<{ member: string; outcome: PoolOutcome }> = [];
    const store = makeStore(
      { p1: target("p1", [{ member: "m1", key: "k1" }]) },
      outcomes,
    );
    const attempts = scriptedHttp([
      { status: 429, body: { error: { message: "slow down" } } },
      { status: 200 },
    ]);

    const result = await completeProviderChat(store, "space-1", { spend: { kind: "person", user_id: "user-1" }, ...CHAT, provider_id: "p1" });

    expect(result.content).toBe("ok");
    expect(attempts.map((a) => a.key)).toEqual(["k1", "k1"]);
    expect(outcomes).toEqual([{ member: "m1", outcome: { kind: "success" } }]);
  });

  it("rotates to the next key with a 24h cooldown on quota exhaustion", async () => {
    const outcomes: Array<{ member: string; outcome: PoolOutcome }> = [];
    const store = makeStore(
      {
        p1: target("p1", [
          { member: "m1", key: "k1" },
          { member: "m2", key: "k2" },
        ]),
      },
      outcomes,
    );
    const attempts = scriptedHttp([
      { status: 429, body: { error: { message: "You exceeded your current quota" } } },
      { status: 200 },
    ]);

    const result = await completeProviderChat(store, "space-1", { spend: { kind: "person", user_id: "user-1" }, ...CHAT, provider_id: "p1" });

    expect(result.content).toBe("ok");
    expect(attempts.map((a) => a.key)).toEqual(["k1", "k2"]);
    expect(outcomes[0]).toEqual({
      member: "m1",
      outcome: {
        kind: "failure",
        failure_class: "quota_exhausted",
        cooldown_seconds: 24 * 60 * 60,
        unhealthy: false,
      },
    });
    expect(outcomes[1]).toEqual({ member: "m2", outcome: { kind: "success" } });
  });

  it("marks a key unhealthy on 401 and rotates without retry", async () => {
    const outcomes: Array<{ member: string; outcome: PoolOutcome }> = [];
    const store = makeStore(
      {
        p1: target("p1", [
          { member: "m1", key: "bad" },
          { member: "m2", key: "good" },
        ]),
      },
      outcomes,
    );
    const attempts = scriptedHttp([{ status: 401 }, { status: 200 }]);

    await completeProviderChat(store, "space-1", { spend: { kind: "person", user_id: "user-1" }, ...CHAT, provider_id: "p1" });

    expect(attempts.map((a) => a.key)).toEqual(["bad", "good"]);
    expect(outcomes[0].outcome).toMatchObject({
      kind: "failure",
      failure_class: "unauthorized",
      unhealthy: true,
    });
  });

  it("falls back to the next provider with ITS default model after 402 exhausts the pool", async () => {
    const outcomes: Array<{ member: string; outcome: PoolOutcome }> = [];
    const store = makeStore(
      {
        p1: target("p1", [{ member: "m1", key: "k1" }], { fallback_provider_ids: ["p2"] }),
        p2: target("p2", [{ member: "m2", key: "k2" }]),
      },
      outcomes,
    );
    const attempts = scriptedHttp([{ status: 402 }, { status: 200 }]);

    const result = await completeProviderChat(store, "space-1", {
      spend: { kind: "person", user_id: "user-1" },
      ...CHAT,
      provider_id: "p1",
      model: "explicit-model-for-p1",
    });

    expect(result.content).toBe("ok");
    expect(attempts[0]).toMatchObject({ key: "k1", model: "explicit-model-for-p1" });
    // The explicit model bound to p1 must not leak onto the fallback provider.
    expect(attempts[1]).toMatchObject({ key: "k2", model: "default-of-p2" });
  });

  it("never reaches a configured fallback provider when the caller forbids provider fallback", async () => {
    // `allow_provider_fallback: false` is a contract, not a hint: the caller
    // (today the Room conversation summarizer) asked for *this* provider and
    // will take the failure rather than a silently different model's answer.
    const usage: UsageObservation[] = [];
    const attributions: Array<Record<string, unknown>> = [];
    const store: ProviderCommandStore = {
      ...makeStore(
        {
          p1: target("p1", [{ member: "m1", key: "k1" }], { fallback_provider_ids: ["p2"] }),
          p2: target("p2", [{ member: "m2", key: "k2" }]),
        },
        [],
      ),
      async recordUsageObservation(observation, attribution) {
        usage.push(observation);
        attributions.push(attribution as unknown as Record<string, unknown>);
      },
    };
    // Two scripted responses: the second one is never reached, which is what
    // the single recorded attempt below proves.
    const attempts = scriptedHttp([{ status: 402 }, { status: 200 }]);

    await expect(completeProviderChat(store, "space-1", {
      spend: { kind: "person", user_id: "user-1" },
      ...CHAT,
      provider_id: "p1",
      allow_provider_fallback: false,
    })).rejects.toBeInstanceOf(ProviderInvocationError);

    expect(attempts.map((attempt) => attempt.key)).toEqual(["k1"]);
    // The failed attempt is still metered, and against the provider that was
    // actually called — suppressing fallback must not also suppress the spend
    // record the caller's Space is charged by.
    expect(usage).toEqual([expect.objectContaining({
      space_id: "space-1",
      provider_id: "p1",
      event_type: "llm.generation",
      dimensions: expect.objectContaining({ provider_attempt_status: "failed" }),
    })]);
    expect(attributions[0]).toMatchObject({ owner_user_id: "user-1" });
  });

  it("records usage as unknown when an OpenAI-compatible gateway omits it", async () => {
    // A gateway that answers 200 with no `usage` block has told us nothing
    // about tokens. Reporting zero would look like a free call in the Space's
    // spend view; `unknown` is what the number actually is.
    const usage: UsageObservation[] = [];
    const store = makeStore({ p1: target("p1", [{ member: "m1", key: "k1" }]) }, [], {}, usage);
    scriptedHttp([{
      status: 200,
      body: { choices: [{ message: { content: "ok" }, finish_reason: "stop" }], model: "gpt-4o-mini" },
    }]);

    const result = await completeProviderChat(store, "space-1", {
      spend: { kind: "person", user_id: "user-1" },
      ...CHAT,
      provider_id: "p1",
    });

    expect(result.content).toBe("ok");
    expect(usage).toEqual([expect.objectContaining({ usage_accuracy: "unknown" })]);
  });

  it("preserves a raw provider finish reason the vendor SDK would normalize", async () => {
    // `content_filter` is why the answer is empty. Mapping it onto `stop`
    // would make a refusal indistinguishable from a complete reply.
    const store = makeStore({ p1: target("p1", [{ member: "m1", key: "k1" }]) }, []);
    scriptedHttp([{
      status: 200,
      body: {
        choices: [{ message: { content: "" }, finish_reason: "content_filter" }],
        model: "gpt-4o-mini",
        usage: { prompt_tokens: 3, completion_tokens: 0, total_tokens: 3 },
      },
    }]);

    const result = await completeProviderChat(store, "space-1", {
      spend: { kind: "person", user_id: "user-1" },
      ...CHAT,
      provider_id: "p1",
    });

    expect(result.finish_reason).toBe("content_filter");
  });

  it("keeps an Ollama request on the original Chat Completions fields", async () => {
    // A local server implements the fields the API had when it was written.
    // Detecting modern OpenAI features from an arbitrary base URL would send
    // a body it answers 400 to.
    const store = makeStore({
      p1: target("p1", [{ member: "m1", key: "k1" }], {
        provider_type: "ollama",
        base_url: "http://127.0.0.1:11434/v1",
        default_model: "llama3",
      }),
    }, []);
    const attempts = scriptedHttp([{
      status: 200,
      body: { choices: [{ message: { content: "local reply" }, finish_reason: "stop" }], model: "llama3" },
    }]);

    const result = await completeProviderChat(store, "space-1", {
      spend: { kind: "person", user_id: "user-1" },
      ...CHAT,
      provider_id: "p1",
      max_tokens: 321,
    });

    expect(result.content).toBe("local reply");
    expect(attempts[0]?.body).toMatchObject({ model: "llama3", max_tokens: 321 });
    expect(attempts[0]?.body.max_completion_tokens).toBeUndefined();
    expect(attempts[0]?.body.store).toBeUndefined();
  });

  it("sends a catalog-valid DeepSeek model when the provider configures none", async () => {
    // With no configured model the request still has to name one the vendor
    // accepts; the generic OpenAI default would be rejected by DeepSeek.
    const store = makeStore({
      p1: target("p1", [{ member: "m1", key: "k1" }], {
        provider_type: "deepseek",
        base_url: "https://api.deepseek.test/v1",
        default_model: null,
      }),
    }, []);
    const attempts = scriptedHttp([{
      status: 200,
      body: { choices: [{ message: { content: "deep reply" }, finish_reason: "stop" }], model: "deepseek-v4-flash" },
    }]);

    const result = await completeProviderChat(store, "space-1", {
      spend: { kind: "person", user_id: "user-1" },
      ...CHAT,
      provider_id: "p1",
    });

    expect(result.content).toBe("deep reply");
    expect(attempts[0]?.body).toMatchObject({ model: "deepseek-v4-flash" });
  });

  it("carries Anthropic's 1-hour cache bucket through to the usage observation", async () => {
    // The two cache-creation buckets are billed differently, and the vendor
    // reports the 1h one nested inside the total. Losing the nested number
    // makes every 1h write look like a 5m write in the Space's spend view.
    const usage: UsageObservation[] = [];
    const store = makeStore({
      p1: target("p1", [{ member: "m1", key: "k1" }], {
        provider_type: "anthropic",
        base_url: "https://api.anthropic.test/v1",
        default_model: "claude-test",
      }),
    }, [], {}, usage);
    __setProviderHttpClientForTests({
      async fetch() {
        return anthropicChatResponse({
          content: [{ type: "text", text: "cached reply" }],
          model: "claude-test",
          stop_reason: "end_turn",
          usage: {
            input_tokens: 3,
            output_tokens: 2,
            cache_creation_input_tokens: 40,
            cache_creation: { ephemeral_1h_input_tokens: 30 },
          },
        });
      },
    });

    const result = await completeProviderChat(store, "space-1", {
      spend: { kind: "person", user_id: "user-1" },
      ...CHAT,
      system: "Be direct.",
      provider_id: "p1",
      cache_strategy: "conversation",
    });

    expect(result.content).toBe("cached reply");
    expect(usage).toHaveLength(1);
    expect(usage[0]?.provider_usage).toMatchObject({
      cache_creation_input_tokens: 40,
      cache_creation_1h_input_tokens: 30,
    });
  });

  it("keeps the vendor protocol authoritative over an advertised compatibility endpoint", async () => {
    // A provider may advertise an OpenAI-shaped bridge, but the Space
    // registered it as Anthropic. Following the advertised endpoint would let
    // the provider choose the wire format its own credential is spent on.
    const store = makeStore({
      p1: target("p1", [{ member: "m1", key: "k1" }], {
        provider_type: "anthropic",
        base_url: "https://api.example.test/v1",
        openai_compatible_base_url: "https://api.example.test/openai/v1",
        default_model: "claude-test",
      }),
    }, []);
    const urls: string[] = [];
    __setProviderHttpClientForTests({
      async fetch(url) {
        urls.push(String(url));
        return anthropicChatResponse({
          content: [{ type: "text", text: "vendor reply" }],
          model: "claude-test",
          stop_reason: "end_turn",
          usage: { input_tokens: 1, output_tokens: 1 },
        });
      },
    });

    const result = await completeProviderChat(store, "space-1", {
      spend: { kind: "person", user_id: "user-1" },
      ...CHAT,
      provider_id: "p1",
    });

    expect(result.content).toBe("vendor reply");
    expect(urls).toEqual(["https://api.example.test/v1/messages"]);
  });

  it("refuses the spend before any provider is reached", async () => {
    // Ordering, not the decision: a denial that arrives after the request has
    // gone out has already spent the credential it was refusing.
    const store: ProviderCommandStore = {
      ...makeStore({ p1: target("p1", [{ member: "m1", key: "k1" }]) }, []),
      async authorizeCredentialSpend() {
        throw new CredentialSpendDeniedError("This Automation has no standing credential grant.");
      },
    };
    const attempts = scriptedHttp([{ status: 200 }]);

    await expect(completeProviderChat(store, "space-1", {
      spend: { kind: "person", user_id: "user-1" },
      ...CHAT,
      provider_id: "p1",
    })).rejects.toBeInstanceOf(CredentialSpendDeniedError);

    expect(attempts).toEqual([]);
  });

  it("refuses structured output for a provider type that cannot honour it, before any request", async () => {
    // The alternative is a request whose schema the provider silently ignores
    // and a reply the caller then fails to parse, after paying for it.
    const store = makeStore({
      p1: target("p1", [{ member: "m1", key: "k1" }], { provider_type: "cohere" }),
    }, []);
    const attempts = scriptedHttp([{ status: 200 }]);

    await expect(completeProviderChat(store, "space-1", {
      spend: { kind: "person", user_id: "user-1" },
      ...CHAT,
      provider_id: "p1",
      output_format: {
        type: "json_schema",
        schema_id: "research.test.v1",
        schema: { type: "object" },
        strict: true,
      },
    })).rejects.toMatchObject({ code: "structured_output_unsupported" });

    expect(attempts).toEqual([]);
  });

  it("treats fetch failures as transient provider network errors and falls back", async () => {
    const outcomes: Array<{ member: string; outcome: PoolOutcome }> = [];
    const store = makeStore(
      {
        p1: target("p1", [{ member: "m1", key: "k1" }], { fallback_provider_ids: ["p2"] }),
        p2: target("p2", [{ member: "m2", key: "k2" }]),
      },
      outcomes,
    );
    const attempts: Attempt[] = [];
    __setProviderHttpClientForTests({
      async fetch(url, init) {
        const headers = new Headers(init?.headers);
        const body = init?.body ? JSON.parse(String(init.body)) : {};
        attempts.push({
          url: String(url),
          key: headers.get("authorization")?.replace("Bearer ", "") ?? null,
          model: body.model ?? null,
          body,
        });
        // A pure network failure gets a larger same-key retry budget than a
        // provider-classified transient response (MAX_NETWORK_ERROR_RETRIES
        // = 3 retries, so 4 attempts on k1 before falling back to p2).
        if (attempts.length <= 4) {
          const error = new Error("fetch failed") as Error & { cause?: Error };
          error.cause = new Error("getaddrinfo ENOTFOUND api.p1.test");
          throw error;
        }
        return openAiChatResponse({
          choices: [{ message: { content: "fallback ok" } }],
          model: body.model,
          usage: {},
        });
      },
    });

    const result = await completeProviderChat(store, "space-1", {
      spend: { kind: "person", user_id: "user-1" },
      ...CHAT,
      provider_id: "p1",
      model: "explicit-model-for-p1",
    });

    expect(result.content).toBe("fallback ok");
    expect(attempts.map((a) => a.key)).toEqual(["k1", "k1", "k1", "k1", "k2"]);
    expect(attempts.map((a) => a.model)).toEqual([
      "explicit-model-for-p1",
      "explicit-model-for-p1",
      "explicit-model-for-p1",
      "explicit-model-for-p1",
      "default-of-p2",
    ]);
    expect(outcomes[0]).toEqual({
      member: "m1",
      outcome: {
        kind: "failure",
        failure_class: "transient",
        cooldown_seconds: undefined,
        unhealthy: false,
      },
    });
    expect(outcomes[1]).toEqual({ member: "m2", outcome: { kind: "success" } });
  });

  it("retries and falls back when the stream dies after the provider already answered 200", async () => {
    // undici reports a response body torn off mid-flight as a bare
    // `terminated`. Classifying that from the 200 already in hand called it
    // permanent, so the call failed with no retry and no fallback — fatal
    // every time for the longest generation on the platform, a whole research
    // report returned in one structured response.
    const outcomes: Array<{ member: string; outcome: PoolOutcome }> = [];
    const store = makeStore(
      {
        p1: target("p1", [{ member: "m1", key: "k1" }], { fallback_provider_ids: ["p2"] }),
        p2: target("p2", [{ member: "m2", key: "k2" }]),
      },
      outcomes,
    );
    const keys: Array<string | null> = [];
    __setProviderHttpClientForTests({
      async fetch(url, init) {
        const headers = new Headers(init?.headers);
        const body = init?.body ? JSON.parse(String(init.body)) : {};
        keys.push(headers.get("authorization")?.replace("Bearer ", "") ?? null);
        if (keys.length <= 2) return terminatedStreamResponse();
        return openAiChatResponse({
          choices: [{ message: { content: "fallback ok" } }],
          model: body.model,
          usage: {},
        });
      },
    });

    const result = await completeProviderChat(store, "space-1", { spend: { kind: "person", user_id: "user-1" }, ...CHAT, provider_id: "p1" });

    expect(result.content).toBe("fallback ok");
    // One same-key retry — the ordinary transient budget, not the larger one
    // for failures that never started a response — then the fallback provider.
    expect(keys).toEqual(["k1", "k1", "k2"]);
    expect(outcomes[0]).toMatchObject({ member: "m1", outcome: { failure_class: "transient" } });
  });

  it("names a mid-stream death rather than reporting it as a generic invocation failure", async () => {
    const store = makeStore({ p1: target("p1", [{ member: "m1", key: "k1" }]) }, []);
    let calls = 0;
    __setProviderHttpClientForTests({
      async fetch() {
        calls += 1;
        return terminatedStreamResponse();
      },
    });

    await expect(completeProviderChat(store, "space-1", { spend: { kind: "person", user_id: "user-1" }, ...CHAT, provider_id: "p1" }))
      .rejects.toMatchObject({ code: "provider_stream_terminated" });
    expect(calls).toBe(2);
  });

  it("waits an increasing delay between network-error retries instead of hammering the endpoint instantly", async () => {
    // A connection reset that recurs is exactly as likely to hit the same
    // narrow failure window again if retried instantly (see
    // PROVIDER_KEEPALIVE_INITIAL_DELAY_MS's own note about MiniMax
    // specifically) — each retry should wait longer than the last.
    const delays: number[] = [];
    __setNetworkRetryDelayForTests(async (ms) => {
      delays.push(ms);
    });
    const store = makeStore({ p1: target("p1", [{ member: "m1", key: "k1" }]) }, []);
    let calls = 0;
    __setProviderHttpClientForTests({
      async fetch() {
        calls += 1;
        if (calls <= 3) {
          const error = new Error("fetch failed") as Error & { cause?: Error };
          error.cause = new Error("read ECONNRESET");
          throw error;
        }
        return openAiChatResponse({ choices: [{ message: { content: "ok" } }], model: "m", usage: {} });
      },
    });

    const result = await completeProviderChat(store, "space-1", { spend: { kind: "person", user_id: "user-1" }, ...CHAT, provider_id: "p1" });

    expect(result.content).toBe("ok");
    expect(delays).toEqual([500, 1000, 1500]);
  });

  it("uses MiniMax's Anthropic-compatible endpoint and retries a transient network reset", async () => {
    const outcomes: Array<{ member: string; outcome: PoolOutcome }> = [];
    const store = makeStore(
      {
        minimax: target("minimax", [{ member: "m1", key: "k1" }], {
          provider_type: "minimax",
          base_url: "https://api.minimaxi.com/anthropic",
          openai_compatible_base_url: "https://api.minimaxi.com/v1",
          default_model: "MiniMax-M3",
        }),
      },
      outcomes,
    );
    const attempts: Attempt[] = [];
    __setProviderHttpClientForTests({
      async fetch(url, init) {
        const headers = new Headers(init?.headers);
        const body = init?.body ? JSON.parse(String(init.body)) : {};
        attempts.push({
          url: String(url),
          key: headers.get("authorization")?.replace("Bearer ", "") ?? headers.get("x-api-key"),
          model: body.model ?? null,
          body,
        });
        if (attempts.length === 1) {
          const error = new Error("fetch failed") as Error & { cause?: Error };
          error.cause = new Error("read ECONNRESET");
          throw error;
        }
        return anthropicChatResponse({
          content: [{ type: "text", text: "anthropic compatible ok" }],
          model: body.model,
          usage: {},
          stop_reason: "end_turn",
        });
      },
    });

    const result = await completeProviderChat(store, "space-1", {
      spend: { kind: "person", user_id: "user-1" },
      ...CHAT,
      provider_id: "minimax",
      system: "Return JSON only.",
      model: "MiniMax-M3",
    });

    expect(result.content).toBe("anthropic compatible ok");
    expect(attempts.map((a) => a.url)).toEqual([
      "https://api.minimaxi.com/anthropic/v1/messages",
      "https://api.minimaxi.com/anthropic/v1/messages",
    ]);
    expect(attempts.map((a) => a.key)).toEqual(["k1", "k1"]);
    expect(attempts[0].body).toMatchObject({
      system: [{ type: "text", text: "Return JSON only." }],
      messages: [
        { role: "user", content: "hi" },
      ],
    });
    expect(attempts[1].body).toMatchObject({
      system: [{ type: "text", text: "Return JSON only." }],
      messages: [
        { role: "user", content: "hi" },
      ],
    });
    expect(outcomes).toEqual([{ member: "m1", outcome: { kind: "success" } }]);
  });

  it("lets Pi's catalog maxTokens govern Anthropic requests without a local recommendation", async () => {
    const store = makeStore({
      minimax: target("minimax", [{ member: "m1", key: "k1" }], {
        provider_type: "minimax",
        base_url: "https://api.minimaxi.com/anthropic",
        default_model: "MiniMax-M2.7",
      }),
    }, []);
    const attempts: Attempt[] = [];
    __setProviderHttpClientForTests({
      async fetch(url, init) {
        const body = init?.body ? JSON.parse(String(init.body)) : {};
        attempts.push({ url: String(url), key: null, model: body.model ?? null, body });
        return anthropicChatResponse({
          content: [{ type: "text", text: "ok" }],
          model: body.model,
          usage: {},
          stop_reason: "end_turn",
        });
      },
    });
    const { max_tokens: _unused, ...chatWithoutMaxTokens } = CHAT;

    await completeProviderChat(store, "space-1", {
      spend: { kind: "person", user_id: "user-1" },
      ...chatWithoutMaxTokens,
      provider_id: "minimax",
      model: "MiniMax-M2.7",
    });

    expect(attempts[0]?.body.max_tokens).toBe(131_072);
  });

  it("does not rotate keys on permanent request errors", async () => {
    const outcomes: Array<{ member: string; outcome: PoolOutcome }> = [];
    const store = makeStore(
      {
        p1: target("p1", [
          { member: "m1", key: "k1" },
          { member: "m2", key: "k2" },
        ]),
      },
      outcomes,
    );
    const attempts = scriptedHttp([{ status: 400, body: { error: "bad request" } }]);

    await expect(
      completeProviderChat(store, "space-1", { spend: { kind: "person", user_id: "user-1" }, ...CHAT, provider_id: "p1" }),
    ).rejects.toThrow(ProviderInvocationError);
    expect(attempts).toHaveLength(1);
  });

  it("fails with 503 when every key is cooling down", async () => {
    const store = makeStore({ p1: target("p1", []) }, []);
    // No HTTP script: nothing should be called.
    const attempts = scriptedHttp([]);

    await expect(
      completeProviderChat(store, "space-1", { spend: { kind: "person", user_id: "user-1" }, ...CHAT, provider_id: "p1" }),
    ).rejects.toMatchObject({ statusCode: 503 });
    expect(attempts).toHaveLength(0);
  });

  it("walks the task chain first and uses the caller provider as the safety net", async () => {
    const outcomes: Array<{ member: string; outcome: PoolOutcome }> = [];
    const store = makeStore(
      {
        chain1: target("chain1", [{ member: "mc", key: "kc" }]),
        net: target("net", [{ member: "mn", key: "kn" }]),
      },
      outcomes,
      { reflector: [{ provider_id: "chain1", model: "chain-model" }] },
    );
    const attempts = scriptedHttp([
      { status: 503, body: { error: "down" } }, // chain1 attempt 1
      { status: 503, body: { error: "down" } }, // chain1 transient retry
      { status: 200 }, // safety net
    ]);

    const result = await completeProviderText(store, "space-1", {
      spend: { kind: "person", user_id: "user-1" },
      provider_id: "net",
      system: "sys",
      user: "hello",
      task: "reflector",
      metering: { subject_user_id: "user-1" },
    });

    expect(result.text).toBe("ok");
    expect(attempts.map((a) => a.key)).toEqual(["kc", "kc", "kn"]);
    expect(attempts[0].model).toBe("chain-model");
  });

  it("meters bounded provider invocation without Agent runtime attribution", async () => {
    const outcomes: Array<{ member: string; outcome: PoolOutcome }> = [];
    const usageObservations: UsageObservation[] = [];
    const store = makeStore(
      { p1: target("p1", [{ member: "m1", key: "k1" }], { default_model: "gpt-4o" }) },
      outcomes,
      {},
      usageObservations,
    );
    scriptedHttp([
      {
        status: 200,
        body: {
          choices: [{ message: { content: "metered" } }],
          model: "gpt-4o",
          usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 },
        },
      },
    ]);

    await completeProviderText(store, "space-1", {
      spend: { kind: "person", user_id: "user-1" },
      provider_id: "p1",
      system: "sys",
      user: "hello",
      task: "reflector",
      metering: {
        subject_user_id: "user-1",
        dimensions: { mode: "live" },
      },
    });

    expect(usageObservations).toEqual([
      expect.objectContaining({
        space_id: "space-1",
        event_type: "llm.generation",
        source_type: "local_run",
        execution_channel: "managed_api",
        subject_user_id: "user-1",
        provider_id: "p1",
        provider_type: "openai",
        provider_name_snapshot: "p1",
        vendor: "openai",
        model: "gpt-4o",
        task: "reflector",
        provider_usage: {
          input_tokens: 11,
          output_tokens: 7,
          total_tokens: 18,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
          reasoning_tokens: 0,
        },
        estimated_cost_usd: 0.0000975,
        cost_accuracy: "catalog",
        cost_details: {
          source: "pi_ai_catalog",
          input: 0.0000275,
          output: 0.00007,
          cacheRead: 0,
          cacheWrite: 0,
          total: 0.0000975,
        },
        usage_accuracy: "provider_reported",
        dimensions: { mode: "live" },
      }),
    ]);
  });

  it("leaves catalog-less compatible chat usage uncosted", async () => {
    const usageObservations: UsageObservation[] = [];
    const store = makeStore(
      {
        p1: target("p1", [{ member: "m1", key: "k1" }], {
          provider_type: "openai_compatible",
          default_model: "custom-model",
        }),
      },
      [],
      {},
      usageObservations,
    );
    scriptedHttp([{
      status: 200,
      body: {
        choices: [{ message: { content: "ok" } }],
        model: "custom-model",
        usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 },
      },
    }]);

    await completeProviderText(store, "space-1", {
      spend: { kind: "person", user_id: "user-1" },
      provider_id: "p1",
      system: "",
      user: "hello",
      metering: { subject_user_id: "user-1" },
    });

    expect(usageObservations).toEqual([
      expect.objectContaining({
        usage_accuracy: "provider_reported",
        estimated_cost_usd: null,
        cost_accuracy: "unknown",
        cost_details: null,
      }),
    ]);
  });

  it("allows a keyless OpenAI-compatible chat endpoint without inventing authorization", async () => {
    const store = makeStore(
      {
        p1: target("p1", [{ member: "none", key: null }], {
          provider_type: "openai_compatible",
          default_model: "local-chat",
        }),
      },
      [],
    );
    const attempts = scriptedHttp([{ status: 200 }]);

    const result = await completeProviderText(store, "space-1", {
      spend: { kind: "person", user_id: "user-1" },
      provider_id: "p1",
      system: "",
      user: "hello",
      metering: { subject_user_id: "user-1" },
    });

    expect(result).toMatchObject({ text: "ok", provider: "openai_compatible" });
    expect(attempts).toEqual([
      expect.objectContaining({ key: null, model: "local-chat" }),
    ]);
  });

  it("keeps a catalog-priced zero distinct from an unknown cost", async () => {
    const usageObservations: UsageObservation[] = [];
    const store = makeStore(
      { p1: target("p1", [{ member: "m1", key: "k1" }], { default_model: "gpt-4o" }) },
      [],
      {},
      usageObservations,
    );
    scriptedHttp([{
      status: 200,
      body: {
        choices: [{ message: { content: "zero" } }],
        model: "gpt-4o",
        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      },
    }]);

    await completeProviderText(store, "space-1", {
      spend: { kind: "person", user_id: "user-1" },
      provider_id: "p1",
      system: "",
      user: "hello",
      metering: { subject_user_id: "user-1" },
    });

    expect(usageObservations).toEqual([
      expect.objectContaining({
        estimated_cost_usd: 0,
        cost_accuracy: "catalog",
        cost_details: expect.objectContaining({ source: "pi_ai_catalog", total: 0 }),
      }),
    ]);
    expect(usageObservations[0]?.cost_details).not.toHaveProperty("accuracy");
  });

  it("does not call a fallback chat provider when usage metering fails", async () => {
    const store = makeStore(
      {
        p1: target("p1", [{ member: "m1", key: "k1" }], { fallback_provider_ids: ["p2"] }),
        p2: target("p2", [{ member: "m2", key: "k2" }]),
      },
      [],
      {},
      [],
      async () => { throw new Error("metering unavailable"); },
    );
    const attempts = scriptedHttp([{ status: 200 }, { status: 200 }]);

    await expect(completeProviderChat(store, "space-1", {
      spend: { kind: "person", user_id: "user-1" },
      ...CHAT,
      provider_id: "p1",
    })).rejects.toMatchObject({ code: "usage_metering_failed", statusCode: 502 });

    expect(attempts.map((attempt) => attempt.key)).toEqual(["k1"]);
  });

  it("embedding rotates keys using the same quota taxonomy as chat", async () => {
    const outcomes: Array<{ member: string; outcome: PoolOutcome }> = [];
    const store = makeStore(
      {
        p1: target("p1", [
          { member: "m1", key: "k1" },
          { member: "m2", key: "k2" },
        ]),
      },
      outcomes,
    );
    const attempts = scriptedHttp([
      { status: 429, body: { error: { message: "You exceeded your current quota" } } },
      { status: 200 },
    ]);

    const result = await completeProviderEmbedding(store, "space-1", {
      spend: { kind: "person", user_id: "user-1" },
      provider_id: "p1",
      model: "embed-model",
      inputs: ["alpha"],
      metering: { subject_user_id: "user-1" },
    });

    expect(result.vectors).toEqual([[1]]);
    expect(attempts.map((a) => a.key)).toEqual(["k1", "k2"]);
    expect(attempts.map((a) => a.url)).toEqual([
      "https://api.p1.test/v1/embeddings",
      "https://api.p1.test/v1/embeddings",
    ]);
    expect(outcomes[0]).toEqual({
      member: "m1",
      outcome: {
        kind: "failure",
        failure_class: "quota_exhausted",
        cooldown_seconds: 24 * 60 * 60,
        unhealthy: false,
      },
    });
    expect(outcomes[1]).toEqual({ member: "m2", outcome: { kind: "success" } });
  });

  it("allows a keyless OpenAI-compatible embedding endpoint without authorization", async () => {
    const store = makeStore(
      {
        p1: target("p1", [{ member: "none", key: null }], {
          provider_type: "openai_compatible",
          default_model: "local-embed",
        }),
      },
      [],
    );
    const attempts = scriptedHttp([{ status: 200 }]);

    const result = await completeProviderEmbedding(store, "space-1", {
      spend: { kind: "person", user_id: "user-1" },
      provider_id: "p1",
      inputs: ["alpha"],
      metering: { subject_user_id: "user-1" },
    });

    expect(result.vectors).toEqual([[1]]);
    expect(attempts).toEqual([
      expect.objectContaining({ key: null, model: "local-embed" }),
    ]);
  });

  it("meters embedding usage from provider responses", async () => {
    const outcomes: Array<{ member: string; outcome: PoolOutcome }> = [];
    const usageObservations: UsageObservation[] = [];
    const store = makeStore(
      { p1: target("p1", [{ member: "m1", key: "k1" }]) },
      outcomes,
      {},
      usageObservations,
    );
    scriptedHttp([
      {
        status: 200,
        body: {
          data: [{ embedding: [0.1, 0.2], index: 0 }],
          model: "embed-metered",
          usage: { prompt_tokens: 4, total_tokens: 4 },
        },
      },
    ]);

    const result = await completeProviderEmbedding(store, "space-1", {
      spend: { kind: "person", user_id: "user-1" },
      provider_id: "p1",
      inputs: ["alpha"],
      task: "retrieval_embedding",
      metering: { run_id: "run-embed" },
    });

    expect(result).toMatchObject({
      vectors: [[0.1, 0.2]],
      model: "embed-metered",
      usage: { prompt_tokens: 4, total_tokens: 4 },
    });
    expect(usageObservations).toEqual([
      expect.objectContaining({
        space_id: "space-1",
        event_type: "llm.embedding",
        execution_channel: "managed_api",
        run_id: "run-embed",
        provider_id: "p1",
        model: "embed-metered",
        task: "retrieval_embedding",
        provider_usage: { prompt_tokens: 4, total_tokens: 4 },
        usage_accuracy: "provider_reported",
      }),
    ]);
  });

  it("does not call a fallback embedding provider when usage metering fails", async () => {
    const store = makeStore(
      {
        p1: target("p1", [{ member: "m1", key: "k1" }], { fallback_provider_ids: ["p2"] }),
        p2: target("p2", [{ member: "m2", key: "k2" }]),
      },
      [],
      {},
      [],
      async () => { throw new Error("metering unavailable"); },
    );
    const attempts = scriptedHttp([{ status: 200 }, { status: 200 }]);

    await expect(completeProviderEmbedding(store, "space-1", {
      spend: { kind: "person", user_id: "user-1" },
      provider_id: "p1",
      inputs: ["alpha"],
      metering: { subject_user_id: "user-1" },
    })).rejects.toMatchObject({ code: "usage_metering_failed", statusCode: 502 });

    expect(attempts.map((attempt) => attempt.key)).toEqual(["k1"]);
  });

  it("embedding falls back to provider fallback with the fallback provider default model", async () => {
    const outcomes: Array<{ member: string; outcome: PoolOutcome }> = [];
    const store = makeStore(
      {
        p1: target("p1", [{ member: "m1", key: "k1" }], { fallback_provider_ids: ["p2"] }),
        p2: target("p2", [{ member: "m2", key: "k2" }]),
      },
      outcomes,
    );
    const attempts = scriptedHttp([{ status: 402 }, { status: 200 }]);

    await completeProviderEmbedding(store, "space-1", {
      spend: { kind: "person", user_id: "user-1" },
      provider_id: "p1",
      model: "explicit-embed-model",
      inputs: ["alpha"],
      metering: { subject_user_id: "user-1" },
    });

    expect(attempts[0]).toMatchObject({ key: "k1", model: "explicit-embed-model" });
    expect(attempts[1]).toMatchObject({ key: "k2", model: "default-of-p2" });
  });

  it("embedding uses the default provider when no task policy or provider id is supplied", async () => {
    const outcomes: Array<{ member: string; outcome: PoolOutcome }> = [];
    const store = makeStore(
      {
        default: target("default", [{ member: "md", key: "kd" }]),
      },
      outcomes,
    );
    const attempts = scriptedHttp([{ status: 200 }]);

    await completeProviderEmbedding(store, "space-1", {
      spend: { kind: "person", user_id: "user-1" },
      inputs: ["alpha"],
      task: "retrieval_embedding",
      metering: { subject_user_id: "user-1" },
    });

    expect(attempts[0]).toMatchObject({ key: "kd", model: "default-of-default" });
    expect(outcomes).toEqual([{ member: "md", outcome: { kind: "success" } }]);
  });

  it("embedding supports ZeroEntropy /models/embed with input_type and dimensions", async () => {
    const outcomes: Array<{ member: string; outcome: PoolOutcome }> = [];
    const store = makeStore(
      {
        ze: target("ze", [{ member: "mz", key: "kz" }], {
          provider_type: "zeroentropy",
          base_url: "https://api.zeroentropy.dev/v1",
          default_model: "zembed-1",
        }),
      },
      outcomes,
    );
    const attempts = scriptedHttp([
      { status: 200, body: { results: [{ embedding: [0.1, 0.2] }] } },
    ]);

    const result = await completeProviderEmbedding(store, "space-1", {
      spend: { kind: "person", user_id: "user-1" },
      provider_id: "ze",
      inputs: ["alpha"],
      dimensions: 2560,
      inputType: "query",
      task: "retrieval_embedding",
      metering: { subject_user_id: "user-1" },
    });

    expect(result).toEqual({ vectors: [[0.1, 0.2]], model: "zembed-1", usage: {} });
    expect(attempts[0]).toMatchObject({
      url: "https://api.zeroentropy.dev/v1/models/embed",
      key: "kz",
      model: "zembed-1",
    });
    expect(attempts[0]?.body).toMatchObject({
      input: ["alpha"],
      input_type: "query",
      dimensions: 2560,
      encoding_format: "float",
    });
  });

  it("embedding supports Cohere v2 embed with retrieval input types and output dimensions", async () => {
    const outcomes: Array<{ member: string; outcome: PoolOutcome }> = [];
    const store = makeStore(
      {
        co: target("co", [{ member: "mc", key: "kc" }], {
          provider_type: "cohere",
          base_url: "https://api.cohere.com",
          default_model: "embed-v4.0",
        }),
      },
      outcomes,
    );
    const attempts = scriptedHttp([
      { status: 200, body: { embeddings: { float: [[0.1, 0.2], [0.3, 0.4]] } } },
    ]);

    const result = await completeProviderEmbedding(store, "space-1", {
      spend: { kind: "person", user_id: "user-1" },
      provider_id: "co",
      inputs: ["alpha", "beta"],
      dimensions: 1536,
      inputType: "query",
      task: "retrieval_embedding",
      metering: { subject_user_id: "user-1" },
    });

    expect(result).toEqual({
      vectors: [[0.1, 0.2], [0.3, 0.4]],
      model: "embed-v4.0",
      usage: {},
    });
    expect(attempts[0]).toMatchObject({
      url: "https://api.cohere.com/v2/embed",
      key: "kc",
      model: "embed-v4.0",
    });
    expect(attempts[0]?.body).toMatchObject({
      texts: ["alpha", "beta"],
      input_type: "search_query",
      output_dimension: 1536,
      embedding_types: ["float"],
    });
  });

  it("does not call a fallback rerank provider when usage metering fails", async () => {
    const store = makeStore(
      {
        p1: target("p1", [{ member: "m1", key: "k1" }], {
          provider_type: "cohere",
          base_url: "https://api.p1.test",
          fallback_provider_ids: ["p2"],
        }),
        p2: target("p2", [{ member: "m2", key: "k2" }], {
          provider_type: "cohere",
          base_url: "https://api.p2.test",
        }),
      },
      [],
      {},
      [],
      async () => { throw new Error("metering unavailable"); },
    );
    const attempts = scriptedHttp([{
      status: 200,
      body: { results: [{ index: 0, relevance_score: 0.9 }] },
    }, { status: 200 }]);

    await expect(completeProviderRerank(store, "space-1", {
      spend: { kind: "person", user_id: "user-1" },
      provider_id: "p1",
      query: "alpha",
      documents: ["alpha result"],
      metering: { subject_user_id: "user-1" },
    })).rejects.toMatchObject({ code: "usage_metering_failed", statusCode: 502 });

    expect(attempts.map((attempt) => attempt.key)).toEqual(["k1"]);
  });

  it("rerank supports ZeroEntropy /models/rerank with a task-specific default model", async () => {
    const outcomes: Array<{ member: string; outcome: PoolOutcome }> = [];
    const store = makeStore(
      {
        ze: target("ze", [{ member: "mz", key: "kz" }], {
          provider_type: "zeroentropy",
          base_url: "https://api.zeroentropy.dev/v1",
          default_model: "zembed-1",
        }),
      },
      outcomes,
    );
    const attempts = scriptedHttp([
      {
        status: 200,
        body: {
          results: [
            { index: 1, relevance_score: 0.9 },
            { index: 0, relevance_score: 0.2 },
          ],
          total_tokens: 14,
        },
      },
    ]);

    const result = await completeProviderRerank(store, "space-1", {
      spend: { kind: "person", user_id: "user-1" },
      provider_id: "ze",
      query: "alpha",
      documents: ["doc a", "doc b"],
      task: "retrieval_rerank",
      metering: { subject_user_id: "user-1" },
    });

    expect(result).toMatchObject({
      scores: [
        { index: 1, score: 0.9 },
        { index: 0, score: 0.2 },
      ],
      model: "zerank-2",
      usage: { total_tokens: 14 },
    });
    expect(attempts[0]).toMatchObject({
      url: "https://api.zeroentropy.dev/v1/models/rerank",
      key: "kz",
      model: "zerank-2",
    });
    expect(attempts[0]?.body).toMatchObject({
      query: "alpha",
      documents: ["doc a", "doc b"],
      top_n: 2,
    });
  });

  it("rerank supports Cohere v2 rerank with a task-specific default model", async () => {
    const outcomes: Array<{ member: string; outcome: PoolOutcome }> = [];
    const usageObservations: UsageObservation[] = [];
    const store = makeStore(
      {
        co: target("co", [{ member: "mc", key: "kc" }], {
          provider_type: "cohere",
          base_url: "https://api.cohere.com",
          default_model: "embed-v4.0",
        }),
      },
      outcomes,
      {},
      usageObservations,
    );
    const attempts = scriptedHttp([
      {
        status: 200,
        body: {
          results: [
            { index: 1, relevance_score: 0.91 },
            { index: 0, relevance_score: 0.18 },
          ],
          meta: { billed_units: { search_units: 1 } },
        },
      },
    ]);

    const result = await completeProviderRerank(store, "space-1", {
      spend: { kind: "person", user_id: "user-1" },
      provider_id: "co",
      query: "alpha",
      documents: ["doc a", "doc b"],
      task: "retrieval_rerank",
      metering: { subject_user_id: "user-1" },
    });

    expect(result).toMatchObject({
      scores: [
        { index: 1, score: 0.91 },
        { index: 0, score: 0.18 },
      ],
      model: "rerank-v4.0-pro",
      usage: { billed_units: { search_units: 1 } },
    });
    expect(usageObservations).toEqual([
      expect.objectContaining({
        space_id: "space-1",
        event_type: "llm.rerank",
        execution_channel: "managed_api",
        provider_id: "co",
        provider_type: "cohere",
        model: "rerank-v4.0-pro",
        task: "retrieval_rerank",
        provider_usage: { billed_units: { search_units: 1 } },
        usage_accuracy: "provider_reported",
      }),
    ]);
    expect(attempts[0]).toMatchObject({
      url: "https://api.cohere.com/v2/rerank",
      key: "kc",
      model: "rerank-v4.0-pro",
    });
    expect(attempts[0]?.body).toMatchObject({
      query: "alpha",
      documents: ["doc a", "doc b"],
      top_n: 2,
    });
  });
});

describe("rotation strategy ordering", () => {
  const member = (
    position: number,
    requestCount: number,
    lastUsed: string | null,
  ) => ({
    position,
    request_count: requestCount,
    last_used_at: lastUsed ? new Date(lastUsed) : null,
  });

  it("fill_first orders by position", () => {
    const ordered = orderPoolMembers(
      [member(2, 0, null), member(0, 9, null), member(1, 1, null)],
      "fill_first",
    );
    expect(ordered.map((m) => m.position)).toEqual([0, 1, 2]);
  });

  it("round_robin orders least-recently-used first", () => {
    const ordered = orderPoolMembers(
      [
        member(0, 5, "2026-06-11T10:00:00Z"),
        member(1, 5, "2026-06-11T08:00:00Z"),
        member(2, 5, null),
      ],
      "round_robin",
    );
    expect(ordered.map((m) => m.position)).toEqual([2, 1, 0]);
  });

  it("least_used orders by request count", () => {
    const ordered = orderPoolMembers(
      [member(0, 7, null), member(1, 2, null), member(2, 4, null)],
      "least_used",
    );
    expect(ordered.map((m) => m.position)).toEqual([1, 2, 0]);
  });
});
