import { afterEach, describe, expect, it } from "vitest";
import { mergeRewriteVariants, MAX_REWRITE_VARIANTS } from "../src/modules/retrieval/queryRewrite.js";
import { parseQueryRewriteVariants } from "../src/modules/retrieval/queryRewriteProvider/prompt.js";
import { ProviderQueryRewriter } from "../src/modules/retrieval/queryRewriteProvider/providerQueryRewriter.js";
import { __setProviderHttpClientForTests as setRawProviderHttpClientForTests } from "../src/modules/providers/invocation/invocation.js";
import type { ProviderCommandStore } from "../src/modules/providers/commands/store.js";
import { resolveTestUsageAttribution } from "./support/usageAttribution.js";
import { piAiHttpClient } from "./support/piAiHttp.js";

function __setProviderHttpClientForTests(client: Parameters<typeof setRawProviderHttpClientForTests>[0]): void {
  setRawProviderHttpClientForTests(client ? piAiHttpClient(client) : null);
}

describe("mergeRewriteVariants", () => {
  it("always keeps the original query first", () => {
    expect(mergeRewriteVariants("pg indexes", ["postgres indexing"])).toEqual([
      "pg indexes",
      "postgres indexing",
    ]);
  });

  it("drops empties and normalized duplicates of already-included queries", () => {
    expect(
      mergeRewriteVariants("RRF", ["  ", "rrf", "Reciprocal Rank Fusion", "reciprocal rank fusion"]),
    ).toEqual(["RRF", "Reciprocal Rank Fusion"]);
  });

  it("caps the number of variants", () => {
    const many = ["a", "b", "c", "d", "e", "f"];
    const merged = mergeRewriteVariants("orig", many);
    expect(merged.length).toBe(MAX_REWRITE_VARIANTS + 1);
    expect(merged[0]).toBe("orig");
  });

  it("returns just the original when there are no usable variants", () => {
    expect(mergeRewriteVariants("orig", [])).toEqual(["orig"]);
    expect(mergeRewriteVariants("orig", ["orig", " "])).toEqual(["orig"]);
  });
});

describe("query-rewrite prompt parsing", () => {
  it("parses a clean JSON array of strings", () => {
    expect(parseQueryRewriteVariants('["postgres indexing", "db indexes"]')).toEqual([
      "postgres indexing",
      "db indexes",
    ]);
  });

  it("tolerates prose/code fences and dedupes case-insensitively", () => {
    const text = 'Sure!\n```json\n["Postgres Indexing", "postgres indexing", "Index Tuning"]\n```';
    expect(parseQueryRewriteVariants(text)).toEqual(["Postgres Indexing", "Index Tuning"]);
  });

  it("ignores non-string entries and caps the count", () => {
    const parsed = parseQueryRewriteVariants('["a", 5, null, "b", "c", "d", "e"]');
    expect(parsed).toEqual(["a", "b", "c"]);
  });

  it("returns null on non-JSON or an empty result", () => {
    expect(parseQueryRewriteVariants("no json here")).toBeNull();
    expect(parseQueryRewriteVariants("[]")).toBeNull();
    expect(parseQueryRewriteVariants('["   "]')).toBeNull();
  });

});

describe("ProviderQueryRewriter", () => {
  afterEach(() => __setProviderHttpClientForTests(null));

  function fakeStore(): ProviderCommandStore {
    return {
      async getTaskChain() {
        return null;
      },
      async getInvocationTarget() {
        return {
          provider: {
            id: "p1",
            provider_type: "openai",
            base_url: "https://example.test/v1",
            default_model: "rewrite-model",
            available_models: [],
          },
          candidates: [{ api_key: "k" }],
          network_profile: null,
          rotation_strategy: "ordered",
          fallback_provider_ids: [],
        };
      },
      resolveUsageAttribution: resolveTestUsageAttribution,
      async recordUsageObservation() {},
    } as unknown as ProviderCommandStore;
  }

  function fakeLocalStore(): ProviderCommandStore {
    return {
      async getTaskChain() {
        return null;
      },
      async getInvocationTarget() {
        return {
          provider: {
            id: "local",
            provider_type: "ollama",
            base_url: "http://localhost:11434",
            default_model: "llama3",
            available_models: [],
          },
          candidates: [{ api_key: null }],
          network_profile: null,
          rotation_strategy: "ordered",
          fallback_provider_ids: [],
        };
      },
      resolveUsageAttribution: resolveTestUsageAttribution,
      async recordUsageObservation() {},
    } as unknown as ProviderCommandStore;
  }

  function chatResponse(content: string): Response {
    return new Response(
      JSON.stringify({ choices: [{ message: { content } }], model: "rewrite-model" }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }

  const registryPromptResolver = async (_spaceId: string, _viewerUserId: string, query: string) => ({
    system: "registry rewrite system: respond with a JSON array",
    user: `Query: ${query}\n\nReturn the JSON array now.`,
  });

  it("returns the parsed variants on a clean response", async () => {
    __setProviderHttpClientForTests({
      async fetch() {
        return chatResponse('["postgres indexing strategies", "db index tuning"]');
      },
    });
    const rewriter = new ProviderQueryRewriter(fakeStore(), { providerId: "p1", promptResolver: registryPromptResolver });
    expect(await rewriter.rewrite("space-1", "viewer-1", "pg indexes")).toEqual([
      "postgres indexing strategies",
      "db index tuning",
    ]);
  });

  it("sends the resolved registry prompt to the provider", async () => {
    let requestBody: Record<string, unknown> | null = null;
    __setProviderHttpClientForTests({
      async fetch(_url, init) {
        requestBody = init?.body ? JSON.parse(String(init.body)) : {};
        return chatResponse('["postgres indexing strategies"]');
      },
    });
    const rewriter = new ProviderQueryRewriter(fakeStore(), {
      providerId: "p1",
      promptResolver: async (_spaceId, _viewerUserId, query) => ({
        system: "custom rewrite system",
        user: `Rewrite query: ${query}`,
      }),
    });

    await rewriter.rewrite("space-1", "viewer-1", "pg indexes");

    expect(requestBody).toMatchObject({
      messages: [
        { role: "system", content: "custom rewrite system" },
        { role: "user", content: "Rewrite query: pg indexes" },
      ],
    });
  });

  it("degrades to null on a provider error", async () => {
    __setProviderHttpClientForTests({
      async fetch() {
        return new Response("upstream boom", { status: 500 });
      },
    });
    const rewriter = new ProviderQueryRewriter(fakeStore(), { providerId: "p1", promptResolver: registryPromptResolver });
    expect(await rewriter.rewrite("space-1", "viewer-1", "pg indexes")).toBeNull();
  });

  it("honors external egress policy before sending the query to the provider", async () => {
    let fetchCalls = 0;
    __setProviderHttpClientForTests({
      async fetch() {
        fetchCalls += 1;
        throw new Error("provider must not be called when egress is disabled");
      },
    });
    const rewriter = new ProviderQueryRewriter(fakeStore(), {
      providerId: "p1",
      promptResolver: registryPromptResolver,
      egressPolicy: { externalEgressEnabled: false },
    });

    expect(await rewriter.rewrite("space-1", "viewer-1", "pg indexes")).toBeNull();
    expect(fetchCalls).toBe(0);
  });

  it("still allows local provider query rewrite when external egress is disabled", async () => {
    const calls: string[] = [];
    __setProviderHttpClientForTests({
      async fetch(url) {
        calls.push(String(url));
        return new Response(
          JSON.stringify({ message: { content: '["postgres indexing strategies"]' }, model: "llama3" }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      },
    });
    const rewriter = new ProviderQueryRewriter(fakeLocalStore(), {
      providerId: "local",
      promptResolver: registryPromptResolver,
      egressPolicy: { externalEgressEnabled: false },
    });

    expect(await rewriter.rewrite("space-1", "viewer-1", "pg indexes")).toEqual([
      "postgres indexing strategies",
    ]);
    expect(calls).toEqual(["http://localhost:11434/v1/chat/completions"]);
  });

  it("degrades to null when the model returns no usable JSON", async () => {
    __setProviderHttpClientForTests({
      async fetch() {
        return chatResponse("I cannot rewrite this query.");
      },
    });
    const rewriter = new ProviderQueryRewriter(fakeStore(), { providerId: "p1", promptResolver: registryPromptResolver });
    expect(await rewriter.rewrite("space-1", "viewer-1", "pg indexes")).toBeNull();
  });

  it("returns null when the registry prompt cannot be resolved", async () => {
    let fetchCalls = 0;
    __setProviderHttpClientForTests({
      async fetch() {
        fetchCalls += 1;
        return chatResponse('["should not happen"]');
      },
    });
    const rewriter = new ProviderQueryRewriter(fakeStore(), {
      providerId: "p1",
      promptResolver: async () => null,
    });

    expect(await rewriter.rewrite("space-1", "viewer-1", "pg indexes")).toBeNull();
    expect(fetchCalls).toBe(0);
  });

  it("returns null for an empty query without calling the provider", async () => {
    __setProviderHttpClientForTests({
      async fetch() {
        throw new Error("provider must not be called for an empty query");
      },
    });
    const rewriter = new ProviderQueryRewriter(fakeStore(), { providerId: "p1" });
    expect(await rewriter.rewrite("space-1", "viewer-1", "   ")).toBeNull();
  });
});
