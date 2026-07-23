import { describe, expect, it } from "vitest";
import { BraveWebSearchConnectorHandler, OpenAlexConnectorHandler, SemanticScholarConnectorHandler } from "../src/modules/sources/connectors/academicJson";
import { ResearchProviderCompiler } from "../src/modules/research/queryPlanning/providerCompiler";

describe("academic and web JSON source connectors", () => {
  const compiler = new ResearchProviderCompiler();

  it("compiles and normalizes an OpenAlex cursor response", () => {
    const handler = new OpenAlexConnectorHandler();
    const compiled = compiler.compileNative("openalex", { query: { search: "agent memory", per_page: 20, from_publication_date: "2025-01-01" } });
    const initial = handler.buildScanRequest({ endpoint_url: null, compiled_query: compiled.query }, {});
    expect(initial.url).toContain("api.openalex.org/works");
    expect(new URL(initial.url).searchParams.get("cursor")).toBe("*");
    const raw = JSON.stringify({ meta: { count: 12, next_cursor: "next-token" }, results: [{
      id: "https://openalex.org/W123", doi: "https://doi.org/10.1000/Example", title: "Agent Memory",
      publication_date: "2026-01-02", authorships: [{ author: { display_name: "Ada" } }],
      primary_location: { landing_page_url: "https://example.test/paper", source: { display_name: "Journal" } },
      type: "article", cited_by_count: 4, referenced_works_count: 9, ids: { arxiv: "https://arxiv.org/abs/2601.00001" },
      abstract_inverted_index: { Agent: [0], memory: [1] },
    }] });
    expect(handler.parseCursor(raw)).toEqual({ cursor: "next-token" });
    expect(handler.parseResponse(raw)[0]).toMatchObject({ externalId: "W123", title: "Agent Memory", metadata: { doi: "10.1000/example", arxiv_id: "2601.00001", openalex_id: "W123", authors: ["Ada"] } });
    const backfill = handler.buildBackfillRequest({ endpoint_url: null, compiled_query: compiled.query }, { cursor: 2, from: "2024-01-01", to: "2024-12-31" }, {});
    expect(new URL(backfill.url).searchParams.get("page")).toBe("3");
    expect(new URL(backfill.url).searchParams.has("cursor")).toBe(false);
  });

  it("compiles and normalizes a Semantic Scholar offset response", () => {
    const handler = new SemanticScholarConnectorHandler();
    const compiled = compiler.compileNative("semantic_scholar", { query: { query: "agent-memory", limit: 10 } });
    expect(new URL(handler.buildScanRequest({ endpoint_url: null, compiled_query: compiled.query }, {}).url).searchParams.get("query")).toBe("agent-memory");
    const raw = JSON.stringify({ total: 20, next: 10, data: [{ paperId: "s2-1", externalIds: { DOI: "10.1/X", ArXiv: "2601.1" }, url: "https://s2.test/1", title: "Paper", abstract: "Summary", authors: [{ name: "Lin" }], year: 2026, venue: "Conf", publicationTypes: ["Conference"], citationCount: 5, referenceCount: 8 }] });
    expect(handler.parseCursor(raw)).toEqual({ offset: 10 });
    expect(handler.parseResponse(raw)[0]).toMatchObject({ externalId: "s2-1", metadata: { semantic_scholar_id: "s2-1", doi: "10.1/x", paper_type: "conference_paper" } });
  });

  it("normalizes Brave results as explicitly untrusted web items", () => {
    const handler = new BraveWebSearchConnectorHandler();
    const item = handler.parseResponse(JSON.stringify({ query: { more_results_available: true }, web: { results: [{ title: "Policy", url: "https://example.test/policy", description: "Current policy" }] } }))[0];
    expect(item).toMatchObject({ itemType: "external_url", canonicalUri: "https://example.test/policy", metadata: { trust_tier: "web_untrusted" } });
    expect(handler.parseCursor(JSON.stringify({ query: { more_results_available: true } }))).toEqual({ more_results_available: true });
  });
});
