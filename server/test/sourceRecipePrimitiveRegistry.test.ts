import { describe, expect, it } from "vitest";
import type { SourceRecipeDefinition } from "@agent-space/protocol" with { "resolution-mode": "import" };
import {
  SOURCE_RECIPE_PRIMITIVE_REGISTRY,
  analyzeSourceRecipe,
  } from "../src/modules/sources/sourceRecipes/primitiveRegistry";

describe("source recipe primitive registry", () => {
  it("declares live network access only for fetching primitives and file writes only for snapshot-storing primitives", () => {
    expect(SOURCE_RECIPE_PRIMITIVE_REGISTRY.parse_rss.network_access).toBe("none");
    expect(SOURCE_RECIPE_PRIMITIVE_REGISTRY.extract_list.network_access).toBe("none");
    expect(SOURCE_RECIPE_PRIMITIVE_REGISTRY.follow_link.network_access).toBe("live_fetch");
    expect(SOURCE_RECIPE_PRIMITIVE_REGISTRY.follow_link.writes_files).toBe(true);
    expect(SOURCE_RECIPE_PRIMITIVE_REGISTRY.download_asset.writes_files).toBe(true);
    expect(SOURCE_RECIPE_PRIMITIVE_REGISTRY.dedupe.network_access).toBe("none");
    expect(SOURCE_RECIPE_PRIMITIVE_REGISTRY.dedupe.writes_files).toBe(false);
  });
});

describe("analyzeSourceRecipe", () => {
  it("reports primary_endpoint access for a sentinel-only feed recipe", () => {
    const recipe: SourceRecipeDefinition = {
      recipe_version: "source.recipe.v1",
      steps: [
        { type: "fetch_page", url: "$source.endpoint_url", bind: "feed" },
        { type: "parse_rss", input: "feed", bind: "items" },
        { type: "dedupe", input: "items", bind: "deduped" },
      ],
      output: { items_var: "deduped" },
    };
    const analysis = analyzeSourceRecipe(recipe);
    expect(analysis.network_access).toBe("primary_endpoint");
    expect(analysis.writes_files).toBe(false);
    expect(analysis.live_fetch_urls).toEqual([]);
    expect(analysis.primitives).toEqual(["fetch_page", "parse_rss", "dedupe"]);
    expect(analysis.primitive_versions).toMatchObject({ fetch_page: 1, parse_rss: 1, dedupe: 1 });
  });

  it("reports live_fetch, file writes, and literal URLs for a crawling recipe (including nested paginate steps)", () => {
    const recipe: SourceRecipeDefinition = {
      recipe_version: "source.recipe.v1",
      steps: [
        { type: "fetch_page", url: "$source.endpoint_url", bind: "page1" },
        {
          type: "paginate",
          input: "page1",
          max_pages: 3,
          next_page: { mode: "link_rel_next" },
          steps: [
            { type: "fetch_page", url: "https://sources.example/extra", bind: "extra" },
            { type: "extract_list", input: "page1", selector: { css_class: "article" }, bind: "page_items" },
          ],
          page_items_var: "page_items",
          bind: "items",
        },
        { type: "follow_link", items_var: "items", max_follow: 5 },
      ],
      output: { items_var: "items" },
    };
    const analysis = analyzeSourceRecipe(recipe);
    expect(analysis.network_access).toBe("live_fetch");
    expect(analysis.writes_files).toBe(true);
    expect(analysis.live_fetch_urls).toEqual(["https://sources.example/extra"]);
    expect(analysis.primitives).toEqual(
      expect.arrayContaining(["fetch_page", "paginate", "extract_list", "follow_link"]),
    );
  });
});
