import { describe, expect, it } from "vitest";
import { sourceConnectorRegistry } from "../src/modules/sources/catalog/sourceConnectorRegistry";
import { ResearchProviderCompiler } from "../src/modules/research/queryPlanning/providerCompiler";

describe("central arXiv provider compilation", () => {
  const handler = sourceConnectorRegistry.get("arxiv_api");
  const compiler = new ResearchProviderCompiler();

  it("compiles an explicit all-papers scope without a user query", () => {
    const compiled = compiler.compileNative("arxiv", { query: { mode: "all" } });

    expect(compiled.query).toMatchObject({ mode: "all", search_query: "all:*" });
    expect(new URL(handler.buildScanRequest({ endpoint_url: null, compiled_query: compiled.query }, {}).url).searchParams.get("search_query")).toBe("all:*");
  });

  it("still rejects an unscoped arXiv source", () => {
    expect(() => compiler.compileNative("arxiv", { query: {} })).toThrow("requires search_query");
  });

  it("auto-wraps plain-language search text as an all: field search", () => {
    const compiled = compiler.compileNative("arxiv", { query: { search_query: "agent memory systems" } });

    expect(compiled.query).toMatchObject({ search_query: 'all:"agent memory systems"' });
  });

  it("strips surrounding quotes and escapes embedded quotes before wrapping", () => {
    const compiled = compiler.compileNative("arxiv", { query: { search_query: '"agent \'memory" systems"' } });

    expect(compiled.query.search_query).toBe('all:"agent \'memory\' systems"');
  });

  it("leaves an already field-prefixed query untouched", () => {
    const compiled = compiler.compileNative("arxiv", { query: { search_query: 'cat:cs.AI AND abs:"agent memory"' } });

    expect(compiled.query).toMatchObject({ search_query: 'cat:cs.AI AND abs:"agent memory"' });
  });
});
