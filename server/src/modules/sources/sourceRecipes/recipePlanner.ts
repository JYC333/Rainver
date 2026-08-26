import type { SourceRecipeDefinition } from "@rainver/protocol";

/**
 * Deterministic Source planning rules for the conversation-first Create
 * Source flow. No LLM is involved in v1: the planner sniffs the (trusted,
 * origin-guarded) endpoint content and maps it onto one of four fixed recipe
 * shapes built only from catalog primitives. If LLM assistance is added
 * later it may only propose recipe JSON that validates against
 * `SourceRecipeDefinitionSchema` — never code.
 */

export const PLANNED_SOURCE_TYPES = ["rss", "atom", "web_list", "web_page"] as const;
export type PlannedSourceType = (typeof PLANNED_SOURCE_TYPES)[number];

export function detectPlannedSourceType(input: {
  /** Explicit user/caller choice; wins over sniffing. */
  requested?: string | null;
  /** Fetched (or fixture) endpoint content; may be empty when the fetch failed. */
  contentSample: string;
  url: string;
  listSelector?: string | null;
}): PlannedSourceType {
  if (input.requested && (PLANNED_SOURCE_TYPES as readonly string[]).includes(input.requested)) {
    return input.requested as PlannedSourceType;
  }
  const head = input.contentSample.slice(0, 2048).toLowerCase();
  if (head.includes("<feed")) return "atom";
  if (head.includes("<rss") || head.includes("<rdf:rdf")) return "rss";
  if (head.length === 0) {
    const url = input.url.toLowerCase();
    if (url.includes("atom")) return "atom";
    if (url.includes("rss") || url.includes("feed") || url.endsWith(".xml")) return "rss";
  }
  return input.listSelector ? "web_list" : "web_page";
}

export function buildRecipeForSourceType(
  sourceType: PlannedSourceType,
  options: { listSelector?: string | null } = {},
): SourceRecipeDefinition {
  switch (sourceType) {
    case "rss":
      return {
        recipe_version: "source.recipe.v1",
        steps: [
          { type: "fetch_page", url: "$source.endpoint_url", bind: "feed" },
          { type: "parse_rss", input: "feed", bind: "entries" },
          { type: "dedupe", input: "entries", bind: "items" },
        ],
        output: { items_var: "items" },
      };
    case "atom":
      return {
        recipe_version: "source.recipe.v1",
        steps: [
          { type: "fetch_page", url: "$source.endpoint_url", bind: "feed" },
          { type: "parse_atom", input: "feed", bind: "entries" },
          { type: "dedupe", input: "entries", bind: "items" },
        ],
        output: { items_var: "items" },
      };
    case "web_list": {
      const cssClass = options.listSelector?.replace(/^\./, "").trim();
      if (!cssClass) throw new Error("web_list source type requires a list selector");
      return {
        recipe_version: "source.recipe.v1",
        steps: [
          { type: "fetch_page", url: "$source.endpoint_url", bind: "page" },
          { type: "extract_list", input: "page", selector: { css_class: cssClass }, bind: "entries" },
          { type: "dedupe", input: "entries", bind: "items" },
        ],
        output: { items_var: "items" },
      };
    }
    case "web_page":
      return {
        recipe_version: "source.recipe.v1",
        steps: [
          { type: "fetch_page", url: "$source.endpoint_url", bind: "page" },
          { type: "extract_single", input: "page", bind: "items" },
        ],
        output: { items_var: "items" },
      };
  }
}
