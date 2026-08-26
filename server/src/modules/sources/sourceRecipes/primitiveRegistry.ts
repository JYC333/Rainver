import type {
  SourceRecipeDefinition,
  SourceRecipeNetworkAccess,
  SourceRecipePrimitiveDefinitionDTO,
  SourceRecipePrimitiveName,
  SourceRecipeStep,
} from "@rainver/protocol";

/**
 * Fixed, server-owned catalog of Level 2 Source recipe primitives. The
 * interpreter (`recipeInterpreter.ts`) dispatches only on these names; a
 * recipe cannot reference anything else (the recipe schema rejects unknown
 * step types before this registry is ever consulted). Each entry declares
 * the primitive's dataflow kinds and permissions so plan/policy review can
 * summarize what a recipe is allowed to do without reading interpreter code.
 *
 * Step parameter schemas live in `SourceRecipeStepSchema`
 * (packages/protocol/src/sourceRecipes.ts); failure shape is a failed
 * `SourceRecipeStepTrace` (step_path + detail) plus the run-level error.
 */
export const SOURCE_RECIPE_PRIMITIVE_REGISTRY: Readonly<
  Record<SourceRecipePrimitiveName, SourceRecipePrimitiveDefinitionDTO>
> = {
  fetch_page: {
    name: "fetch_page",
    version: 1,
    description:
      "Fetch one URL into an html variable. The primary-endpoint sentinel uses pre-fetched/fixture content; a literal URL is a live, origin-guarded fetch.",
    input_kind: "none",
    output_kind: "html",
    network_access: "live_fetch",
    writes_files: false,
  },
  parse_rss: {
    name: "parse_rss",
    version: 1,
    description: "Parse an RSS/RDF feed document into items.",
    input_kind: "html",
    output_kind: "items",
    network_access: "none",
    writes_files: false,
  },
  parse_atom: {
    name: "parse_atom",
    version: 1,
    description: "Parse an Atom feed document into items.",
    input_kind: "html",
    output_kind: "items",
    network_access: "none",
    writes_files: false,
  },
  extract_list: {
    name: "extract_list",
    version: 1,
    description: "Split an html variable into repeated items by one CSS class name.",
    input_kind: "html",
    output_kind: "items",
    network_access: "none",
    writes_files: false,
  },
  extract_single: {
    name: "extract_single",
    version: 1,
    description: "Extract one item from a whole html variable.",
    input_kind: "html",
    output_kind: "items",
    network_access: "none",
    writes_files: false,
  },
  follow_link: {
    name: "follow_link",
    version: 1,
    description:
      "Fetch each item's own source_uri (bounded by max_follow), enrich title/excerpt, and store a raw_html snapshot.",
    input_kind: "items",
    output_kind: "items",
    network_access: "live_fetch",
    writes_files: true,
  },
  download_asset: {
    name: "download_asset",
    version: 1,
    description: "Download each item's source_uri and store the bytes as a snapshot, subject to an optional mime allowlist.",
    input_kind: "items",
    output_kind: "items",
    network_access: "live_fetch",
    writes_files: true,
  },
  paginate: {
    name: "paginate",
    version: 1,
    description: "Re-run nested steps against successive pages (query_param or link_rel_next), merging each page's items.",
    input_kind: "html",
    output_kind: "items",
    network_access: "live_fetch",
    writes_files: false,
  },
  dedupe: {
    name: "dedupe",
    version: 1,
    description: "Drop duplicate items by external_id or source_uri, keeping the first occurrence.",
    input_kind: "items",
    output_kind: "items",
    network_access: "none",
    writes_files: false,
  },
};

export function listSourceRecipePrimitives(): SourceRecipePrimitiveDefinitionDTO[] {
  return Object.values(SOURCE_RECIPE_PRIMITIVE_REGISTRY);
}

export interface SourceRecipeAnalysis {
  /** Distinct primitives the recipe uses, in first-use order. */
  primitives: SourceRecipePrimitiveName[];
  /** Registry version of each used primitive (persisted on the recipe version). */
  primitive_versions: Record<string, number>;
  /** Highest network access any used step actually requires. */
  network_access: SourceRecipeNetworkAccess;
  writes_files: boolean;
  /** Literal (non-sentinel) fetch_page URLs — these need their origins in the policy envelope. */
  live_fetch_urls: string[];
}

const PRIMARY_ENDPOINT_SENTINEL = "$source.endpoint_url";

/**
 * Static permission summary for a recipe. `fetch_page` targeting only the
 * primary-endpoint sentinel needs `primary_endpoint` access, not `live_fetch`
 * — the registry entry declares the primitive's maximum capability, this
 * reports what the concrete recipe uses.
 */
export function analyzeSourceRecipe(recipe: SourceRecipeDefinition): SourceRecipeAnalysis {
  const primitives: SourceRecipePrimitiveName[] = [];
  const liveFetchUrls: string[] = [];
  let networkAccess: SourceRecipeNetworkAccess = "none";
  let writesFiles = false;

  const raiseNetwork = (level: SourceRecipeNetworkAccess) => {
    const rank: Record<SourceRecipeNetworkAccess, number> = { none: 0, primary_endpoint: 1, live_fetch: 2 };
    if (rank[level] > rank[networkAccess]) networkAccess = level;
  };

  const visit = (steps: SourceRecipeStep[]) => {
    for (const step of steps) {
      if (!primitives.includes(step.type)) primitives.push(step.type);
      if (SOURCE_RECIPE_PRIMITIVE_REGISTRY[step.type].writes_files) writesFiles = true;
      switch (step.type) {
        case "fetch_page":
          if (step.url === PRIMARY_ENDPOINT_SENTINEL) raiseNetwork("primary_endpoint");
          else {
            raiseNetwork("live_fetch");
            liveFetchUrls.push(step.url);
          }
          break;
        case "follow_link":
        case "download_asset":
        case "paginate":
          raiseNetwork("live_fetch");
          if (step.type === "paginate") visit(step.steps);
          break;
        default:
          break;
      }
    }
  };
  visit(recipe.steps);

  const primitiveVersions: Record<string, number> = {};
  for (const name of primitives) {
    primitiveVersions[name] = SOURCE_RECIPE_PRIMITIVE_REGISTRY[name].version;
  }
  return {
    primitives,
    primitive_versions: primitiveVersions,
    network_access: networkAccess,
    writes_files: writesFiles,
    live_fetch_urls: liveFetchUrls,
  };
}
