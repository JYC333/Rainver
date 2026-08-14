import { describe, expect, it } from "vitest";
import { providerSupportsTask } from "../src/modules/providers/commands/store";
import { piCatalogForVendor, piCatalogVendorIds, piStructuredToolChoice } from "../src/modules/providers/invocation/piAiChat";
import { providerSupportsStructuredOutput } from "../src/modules/providers/structuredOutputCapabilities";
import { listProviderVendors, providerVendor } from "../src/modules/providers/vendors";

describe("provider vendor capabilities", () => {
  it("uses the vendor registry for OpenAI Codex managed capabilities", () => {
    expect(providerVendor("openai_codex")).toMatchObject({
      supportsChat: true,
      supportsRuntimeTools: true,
      supportsStructuredOutput: true,
    });
    expect(providerSupportsStructuredOutput("openai_codex")).toBe(true);
    expect(piStructuredToolChoice("openai_codex_responses", "structured_output")).toBe("required");
    expect(providerSupportsTask("retrieval_query_rewrite", "openai_codex")).toBe(false);
    expect(providerSupportsTask("retrieval_synthesis", "openai_codex")).toBe(false);
  });

  it("records vendor identity and capability, and nothing about a chat implementation", () => {
    // The registry once carried the pi-ai catalog name each vendor's models are
    // described by. That is a fact about the chat adapter, not about the
    // vendor, and it now lives with the adapter. Nothing implementation-shaped
    // may grow back here: a rate table, a compat flag, or a library-specific
    // model id would make swapping the chat implementation an edit to the
    // server's own vendor vocabulary.
    //
    // What the registry does carry is everything agent-space knows about a
    // vendor independently of who talks to it — including the published
    // endpoint and what it can be asked to do, which the web client and the
    // provider-task table used to keep their own copies of.
    for (const vendor of listProviderVendors()) {
      expect(Object.keys(vendor).sort()).toEqual([
        "apiKeyRequired",
        "defaultBaseUrl",
        "displayName",
        "id",
        "protocol",
        "subscriptionOnly",
        "supportsChat",
        "supportsEmbedding",
        "supportsRerank",
        "supportsRuntimeTools",
        "supportsStructuredOutput",
      ]);
    }
  });

  it("keeps the adapter's catalog map aligned with the vendors it must price", () => {
    // The catalog name used to be a required field on every VendorDescriptor,
    // so adding a vendor without deciding its catalog was a compile error. A
    // map cannot enforce that: an omitted vendor silently resolves to no
    // catalog, pi computes a zero cost from absent rates, and the call is
    // recorded as unpriced with nothing failing. Name the deliberate omissions
    // so a new one has to be added here on purpose.
    const uncatalogued = listProviderVendors()
      .filter((vendor) => piCatalogForVendor(vendor.id) === null)
      .map((vendor) => vendor.id)
      .sort();
    expect(uncatalogued).toEqual([
      // pi-ai does not cover the embedding and rerank vendors at all.
      "cohere",
      // Locally served models: genuinely unpriced here. Whether they cost the
      // operator anything is the router's funding dimension, not this ledger's.
      "ollama",
      // Whatever the operator points it at.
      "openai_compatible",
      "zeroentropy",
    ]);

    // A key naming a vendor that no longer exists is as silent as a missing
    // one, and outlives the vendor it was written for.
    const vendorIds = new Set(listProviderVendors().map((vendor) => vendor.id));
    expect(piCatalogVendorIds().filter((id) => !vendorIds.has(id))).toEqual([]);
  });

  it("fails closed for unknown provider types", () => {
    expect(providerSupportsStructuredOutput("unknown_vendor")).toBe(false);
  });
});
