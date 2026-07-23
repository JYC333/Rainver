import { describe, expect, it } from "vitest";
import type { ResearchProviderKey, ResearchSemanticQuery } from "@agent-space/protocol" with { "resolution-mode": "import" };
import { ResearchProviderCompiler } from "../src/modules/research/queryPlanning/providerCompiler";
import { SearchExecutionAdapter } from "../src/modules/sources/search/searchExecutionAdapter";

const LONG_QUESTION = "How can retrieval augmented memory help an LLM agent preserve useful context across many separate user sessions without accumulating stale information?";

describe("ResearchProviderCompiler", () => {
  it.each([
    ["arxiv", "search_query", "(all:agent AND all:memory)"],
    ["openalex", "search", "agent memory retrieval evaluation long-term context"],
    ["semantic_scholar", "query", "agent memory retrieval evaluation long term context"],
    ["web_search", "q", "(\"agent memory\" OR \"memory-augmented agents\")"],
  ] as const)("compiles %s from semantic roles", (provider, field, expected) => {
    const result = new ResearchProviderCompiler().compile(provider, semanticQuery(), { pageSize: 15 });
    expect(String(result.query[field])).toContain(expected);
    expect(JSON.stringify(result.query)).not.toContain(LONG_QUESTION);
    expect(result.fingerprint).toMatch(/^[a-f0-9]{64}$/);
  });

  it("uses stable fingerprints and changes them when the executable query changes", () => {
    const compiler = new ResearchProviderCompiler();
    const first = compiler.compile("openalex", semanticQuery(), { pageSize: 15 });
    const same = compiler.compile("openalex", semanticQuery(), { pageSize: 15 });
    const changed = compiler.compile("openalex", semanticQuery(), { pageSize: 20 });
    expect(first.fingerprint).toBe(same.fingerprint);
    expect(first.fingerprint).not.toBe(changed.fingerprint);
  });

  it.each(["arxiv", "openalex", "semantic_scholar", "web_search"] as ResearchProviderKey[])(
    "builds an executable %s request without invoking semantic compilation",
    (provider) => {
      const compiled = new ResearchProviderCompiler().compile(provider, semanticQuery(), { pageSize: 10 });
      const request = new SearchExecutionAdapter().buildScanRequest({ compiledQuery: compiled });
      const url = new URL(request.url);
      expect(url.protocol).toBe("https:");
      expect([...url.searchParams.values()].join(" ")).toContain(provider === "arxiv" ? "all:agent AND all:memory" : "agent");
    },
  );

  it("rejects a malformed compiled query at the execution boundary", () => {
    const compiled = new ResearchProviderCompiler().compile("openalex", semanticQuery());
    expect(() => new SearchExecutionAdapter().buildScanRequest({
      compiledQuery: { ...compiled, query: {} },
    })).toThrow("requires query.search");
  });
});

function semanticQuery(): ResearchSemanticQuery {
  return {
    schema_version: "research_semantic_query.v1",
    core: [
      { value: "agent memory", synonyms: ["memory-augmented agents"], weight: 1 },
      { value: "retrieval", synonyms: ["memory retrieval"], weight: 0.9 },
    ],
    expansions: [{ value: "long-term context", synonyms: [], weight: 0.8 }],
    qualifiers: [{ value: "evaluation", synonyms: ["benchmark"], weight: 0.85 }],
    exclusions: [{ value: "human memory", synonyms: [], weight: 0.7 }],
    time_window: { from: "2020-01-01", to: null },
  };
}
