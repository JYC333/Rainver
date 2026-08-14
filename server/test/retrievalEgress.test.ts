import { afterEach, describe, expect, it } from "vitest";
import {
  retrievalEgressAllowed,
  ALLOW_ALL_EGRESS,
  retrievalProviderEgressDestination,
} from "../src/modules/retrieval/egress/egressPolicy";
import type { ProviderCommandStore } from "../src/modules/providers/commands/store";
import {
  __setProviderHttpClientForTests as setRawProviderHttpClientForTests,
  completeProviderText,
  type ProviderHttpClient,
} from "../src/modules/providers/invocation/invocation";
import { ProviderReranker } from "../src/modules/retrieval/rerankProvider/providerReranker";
import { ProviderSynthesizer } from "../src/modules/retrieval/synthesisProvider/providerSynthesizer";
import { resolveTestUsageAttribution } from "./support/usageAttribution";
import { piAiHttpClient } from "./support/piAiHttp";

function __setProviderHttpClientForTests(client: ProviderHttpClient | null): void {
  setRawProviderHttpClientForTests(client ? piAiHttpClient(client) : null);
}

// W9 egress governance. The per-space switch is enforced at the shared seam:
// when external egress is disabled, external model providers are blocked, while
// local providers and in-process handling can still be used.

// A store that fails the test if any provider interaction is attempted.
const throwingStore = new Proxy({ resolveUsageAttribution: resolveTestUsageAttribution }, {
  get(target, property) {
    if (property === "resolveUsageAttribution") return target.resolveUsageAttribution;
    return async () => {
      throw new Error("no provider call may happen when egress is disabled");
    };
  },
}) as unknown as ProviderCommandStore;

const DENY_EXTERNAL = { externalEgressEnabled: false };
const SOURCE_EXTERNAL_ALLOWED = {
  source_egress_class: "external_provider_allowed" as const,
  allow_local_provider_egress: true,
  allow_external_model_egress: true,
};
const SOURCE_LOCAL_ONLY = {
  source_egress_class: "local_provider_allowed" as const,
  allow_local_provider_egress: true,
  allow_external_model_egress: false,
};

afterEach(() => {
  __setProviderHttpClientForTests(null);
});

describe("retrievalEgressAllowed", () => {
  it("allows by default (no policy ⇒ pre-W9 behavior)", () => {
    expect(retrievalEgressAllowed({ object_type: "knowledge_item", object_id: "x" })).toBe(true);
    expect(retrievalEgressAllowed({ object_type: "memory_entry", object_id: "x" }, ALLOW_ALL_EGRESS)).toBe(true);
  });

  it("denies external-provider egress when the space disables external egress", () => {
    expect(retrievalEgressAllowed({ object_type: "knowledge_item", object_id: "a" }, DENY_EXTERNAL)).toBe(false);
    expect(
      retrievalEgressAllowed(
        { object_type: "memory_entry", object_id: "b" },
        { ...DENY_EXTERNAL, destination: "external_provider" },
      ),
    ).toBe(false);
  });

  it("still allows local providers and internal processing when external egress is disabled", () => {
    expect(
      retrievalEgressAllowed(
        { object_type: "knowledge_item", object_id: "a" },
        { ...DENY_EXTERNAL, destination: "local_provider" },
      ),
    ).toBe(true);
    expect(
      retrievalEgressAllowed(
        { object_type: "memory_entry", object_id: "b" },
        { ...DENY_EXTERNAL, destination: "internal_process" },
      ),
    ).toBe(true);
  });

  it("classifies local provider destinations by provider type or localhost URL", () => {
    expect(retrievalProviderEgressDestination({ provider_type: "ollama", base_url: null })).toBe("local_provider");
    expect(
      retrievalProviderEgressDestination({
        provider_type: "openai_compatible",
        base_url: "http://127.0.0.1:8080/v1",
      }),
    ).toBe("local_provider");
    expect(retrievalProviderEgressDestination({ provider_type: "openai", base_url: null })).toBe("external_provider");
  });

  it("fails closed when source-derived content lacks a source policy snapshot", () => {
    expect(
      retrievalEgressAllowed(
        { object_type: "knowledge_item", object_id: "a", source_connection_ids: ["source-1"] },
        { externalEgressEnabled: true },
      ),
    ).toBe(false);
  });

  it("applies source egress class by destination", () => {
    expect(
      retrievalEgressAllowed(
        { object_type: "knowledge_item", object_id: "a", source_connection_ids: ["source-1"] },
        {
          externalEgressEnabled: true,
          destination: "external_provider",
          sourcePolicies: { "source-1": SOURCE_EXTERNAL_ALLOWED },
        },
      ),
    ).toBe(true);
    expect(
      retrievalEgressAllowed(
        { object_type: "knowledge_item", object_id: "a", source_connection_ids: ["source-1"] },
        {
          externalEgressEnabled: true,
          destination: "external_provider",
          sourcePolicies: { "source-1": SOURCE_LOCAL_ONLY },
        },
      ),
    ).toBe(false);
    expect(
      retrievalEgressAllowed(
        { object_type: "knowledge_item", object_id: "a", source_connection_ids: ["source-1"] },
        {
          externalEgressEnabled: false,
          destination: "local_provider",
          sourcePolicies: { "source-1": SOURCE_LOCAL_ONLY },
        },
      ),
    ).toBe(true);
  });
});

describe("egress-disabled provider stages", () => {
  it("ProviderReranker returns null when external provider egress is denied", async () => {
    const reranker = new ProviderReranker(throwingStore, { egressPolicy: DENY_EXTERNAL });
    const result = await reranker.rerank("space-1", "user-1", "alpha", [
      { objectType: "knowledge_item", objectId: "a", title: "A", text: "alpha text" },
    ]);
    expect(result).toBeNull();
  });

  it("ProviderSynthesizer returns null when external provider egress is denied", async () => {
    const synthesizer = new ProviderSynthesizer(throwingStore, { egressPolicy: DENY_EXTERNAL });
    const result = await synthesizer.synthesize("space-1", "user-1", "alpha", [
      { objectType: "knowledge_item", objectId: "a", title: "A", text: "alpha text", updatedAt: null },
    ]);
    expect(result).toBeNull();
  });

  it("blocks external provider HTTP but allows local provider HTTP", async () => {
    const calls: string[] = [];
    const store = providerStoreFor({
      external: {
        id: "external",
        provider_type: "openai",
        base_url: null,
        api_key: "external-key",
      },
      local: {
        id: "local",
        provider_type: "ollama",
        base_url: "http://localhost:11434",
        api_key: null,
      },
    });
    __setProviderHttpClientForTests({
      async fetch(url) {
        calls.push(String(url));
        return new Response(JSON.stringify({ message: { content: "local ok" }, model: "llama3" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    } satisfies ProviderHttpClient);

    await expect(
      completeProviderText(store, "space-1", {
        provider_id: "external",
        system: "s",
        user: "u",
        egressPolicy: DENY_EXTERNAL,
        metering: { subject_user_id: "user-1" },
      }),
    ).rejects.toMatchObject({ code: "retrieval_egress_denied" });
    expect(calls).toEqual([]);

    const local = await completeProviderText(store, "space-1", {
      provider_id: "local",
      system: "s",
      user: "u",
      egressPolicy: DENY_EXTERNAL,
      metering: { subject_user_id: "user-1" },
    });
    expect(local.text).toBe("local ok");
    expect(calls).toEqual(["http://localhost:11434/v1/chat/completions"]);
  });
});

function providerStoreFor(
  providers: Record<string, { id: string; provider_type: string; base_url: string | null; api_key: string | null }>,
): ProviderCommandStore {
  return {
    async getTaskChain() {
      return null;
    },
    async getInvocationTarget(_spaceId: string, providerId?: string | null) {
      const provider = providers[providerId ?? "external"];
      if (!provider) throw new Error(`unknown provider ${providerId ?? ""}`);
      return {
        provider: {
          id: provider.id,
          space_id: "space-1",
          name: provider.id,
          provider_type: provider.provider_type,
          base_url: provider.base_url,
          network_profile_id: null,
          default_model: provider.provider_type === "ollama" ? "llama3" : "gpt-4o-mini",
          available_models: [],
          enabled: true,
          is_default: false,
        },
        network_profile: null,
        rotation_strategy: "fill_first",
        fallback_provider_ids: [],
        candidates: [{ member_id: null, credential_id: null, api_key: provider.api_key }],
      };
    },
    resolveUsageAttribution: resolveTestUsageAttribution,
    async recordPoolOutcome() {},
    async recordUsageObservation() {},
  } as unknown as ProviderCommandStore;
}
