import { afterEach, describe, expect, it, vi } from "vitest";
import { TWO_ARTICLE_HTML, runnerSettings, sourcePolicyEnvelope } from "./support/customSourceFixtures.js";
import { rm } from "node:fs/promises";
import type {
  CustomSourcePipelineDefinition,
  SourceRecipeDefinition,
} from "@rainver/protocol";
import {
  recipeFromPipelineDefinition,
  runSourceRecipe,
  type SourceRecipeRunInput,
} from "../src/modules/sources/sourceRecipes/recipeInterpreter.js";
import { validateCustomSourceHandlerOutput } from "../src/modules/sources/customSources/customSourceContractValidator.js";
import type { CustomSourceRunnerSettings } from "../src/modules/sources/customSources/customSourceRunner.js";

const ORIGIN = "https://sources.example";

const policyEnvelope = (overrides: Parameters<typeof sourcePolicyEnvelope>[0] = {}) =>
  sourcePolicyEnvelope({ allowed_network_origins: [ORIGIN], ...overrides });

const instanceSettings = (overrides: Partial<CustomSourceRunnerSettings> = {}) =>
  runnerSettings({ allowed_languages: ["declarative_pipeline_v1"], ...overrides });

function runInput(
  recipe: SourceRecipeDefinition,
  mode: "dry_run" | "scan",
  primaryEndpointContent: string,
  overrides: Partial<SourceRecipeRunInput> = {},
): SourceRecipeRunInput {
  return {
    policyEnvelope: policyEnvelope(),
    recipe,
    mode,
    endpointUrl: `${ORIGIN}/list`,
    sourceName: "Example Source",
    primaryEndpointContent,
    ...overrides,
  };
}

const LIST_HTML = TWO_ARTICLE_HTML;

const RSS_XML = `<?xml version="1.0"?>
<rss version="2.0"><channel><title>Feed</title>
  <item><title>RSS One</title><link>${ORIGIN}/one</link><guid>guid-1</guid><pubDate>Mon, 01 Jun 2026 00:00:00 GMT</pubDate><description>First body</description></item>
  <item><title>RSS Two</title><link>${ORIGIN}/two</link><guid>guid-2</guid><description>Second body</description></item>
  <item><title>RSS Dup</title><link>${ORIGIN}/one</link><guid>guid-3</guid><description>Duplicate link</description></item>
</channel></rss>`;

const ATOM_XML = `<?xml version="1.0"?>
<feed xmlns="http://www.w3.org/2005/Atom"><title>Feed</title>
  <entry><title>Atom One</title><id>atom-1</id><link rel="alternate" href="${ORIGIN}/a-one"/><updated>2026-06-01T00:00:00Z</updated><summary>Atom body</summary></entry>
</feed>`;

afterEach(() => {
  vi.restoreAllMocks();
});

async function cleanup(result: { sandbox_files_root: string }): Promise<void> {
  await rm(result.sandbox_files_root, { recursive: true, force: true }).catch(() => undefined);
}

describe("runSourceRecipe", () => {
  it("parses an RSS feed into items and dedupes by source_uri", async () => {
    const recipe: SourceRecipeDefinition = {
      recipe_version: "source.recipe.v1",
      steps: [
        { type: "fetch_page", url: "$source.endpoint_url", bind: "feed" },
        { type: "parse_rss", input: "feed", bind: "entries" },
        { type: "dedupe", input: "entries", bind: "items", by: "source_uri" },
      ],
      output: { items_var: "items" },
    };
    const result = await runSourceRecipe(instanceSettings(), runInput(recipe, "dry_run", RSS_XML));
    expect(result.status).toBe("succeeded");
    expect(result.items).toHaveLength(2);
    expect(result.items[0]).toMatchObject({
      external_id: "guid-1",
      title: "RSS One",
      source_uri: `${ORIGIN}/one`,
    });
    expect(result.items[0]!.published_at).toBe("2026-06-01T00:00:00.000Z");
    const dedupeTrace = result.step_traces.find((trace) => trace.primitive === "dedupe");
    expect(dedupeTrace).toMatchObject({ status: "succeeded", item_count: 2 });
    expect(dedupeTrace!.detail).toContain("dropped 1 duplicate");
    await cleanup(result);
  });

  it("parses an Atom feed into items", async () => {
    const recipe: SourceRecipeDefinition = {
      recipe_version: "source.recipe.v1",
      steps: [
        { type: "fetch_page", url: "$source.endpoint_url", bind: "feed" },
        { type: "parse_atom", input: "feed", bind: "items" },
      ],
      output: { items_var: "items" },
    };
    const result = await runSourceRecipe(instanceSettings(), runInput(recipe, "dry_run", ATOM_XML));
    expect(result.status).toBe("succeeded");
    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({
      external_id: "atom-1",
      title: "Atom One",
      source_uri: `${ORIGIN}/a-one`,
    });
    await cleanup(result);
  });

  it("respects parse step max_items", async () => {
    const recipe: SourceRecipeDefinition = {
      recipe_version: "source.recipe.v1",
      steps: [
        { type: "fetch_page", url: "$source.endpoint_url", bind: "feed" },
        { type: "parse_rss", input: "feed", bind: "items", max_items: 1 },
      ],
      output: { items_var: "items" },
    };
    const result = await runSourceRecipe(instanceSettings(), runInput(recipe, "dry_run", RSS_XML));
    expect(result.items).toHaveLength(1);
    await cleanup(result);
  });

  it("emits a step trace for every step, including nested paginate paths", async () => {
    const recipe: SourceRecipeDefinition = {
      recipe_version: "source.recipe.v1",
      steps: [
        { type: "fetch_page", url: "$source.endpoint_url", bind: "page1" },
        {
          type: "paginate",
          input: "page1",
          max_pages: 2,
          next_page: { mode: "query_param", param: "page", start_page: 2 },
          steps: [{ type: "extract_list", input: "page1", selector: { css_class: "article" }, bind: "page_items" }],
          page_items_var: "page_items",
          bind: "items",
        },
      ],
      output: { items_var: "items" },
    };
    const result = await runSourceRecipe(instanceSettings(), runInput(recipe, "dry_run", LIST_HTML));
    expect(result.status).toBe("succeeded");
    const paths = result.step_traces.map((trace) => trace.step_path);
    expect(paths).toContain("steps[0]");
    expect(paths).toContain("steps[1]");
    expect(paths).toContain("steps[1].steps[0]");
    expect(result.step_traces.every((trace) => trace.duration_ms >= 0)).toBe(true);
    // dry-run: page 2 is never fetched, but the would-be URL is reported.
    expect(result.skipped_urls.some((url) => url.includes("page=2"))).toBe(true);
    await cleanup(result);
  });

  it("dry-run never performs a live fetch and reports skipped URLs for follow_link/download_asset/literal fetch_page", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");
    const recipe: SourceRecipeDefinition = {
      recipe_version: "source.recipe.v1",
      steps: [
        { type: "fetch_page", url: `${ORIGIN}/secondary`, bind: "secondary" },
        { type: "fetch_page", url: "$source.endpoint_url", bind: "list_page" },
        { type: "extract_list", input: "list_page", selector: { css_class: "article" }, bind: "items" },
        { type: "follow_link", items_var: "items", max_follow: 20 },
        { type: "download_asset", items_var: "items" },
      ],
      output: { items_var: "items" },
    };
    const result = await runSourceRecipe(instanceSettings(), runInput(recipe, "dry_run", LIST_HTML));
    expect(result.status).toBe("succeeded");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.followed_urls).toHaveLength(0);
    expect(result.skipped_urls).toContain(`${ORIGIN}/secondary`);
    expect(result.skipped_urls).toContain(`${ORIGIN}/a1`);
    const skippedTraces = result.step_traces.filter((trace) => trace.status === "skipped");
    expect(skippedTraces.map((trace) => trace.primitive)).toEqual(
      expect.arrayContaining(["fetch_page", "follow_link", "download_asset"]),
    );
    await cleanup(result);
  });

  it("scan mode follows item links, stores snapshots, and records followed URLs", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
      return new Response(`<title>Detail ${String(url).slice(-2)}</title><body>Detail body.</body>`, { status: 200 });
    });
    const recipe: SourceRecipeDefinition = {
      recipe_version: "source.recipe.v1",
      steps: [
        { type: "fetch_page", url: "$source.endpoint_url", bind: "list_page" },
        { type: "extract_list", input: "list_page", selector: { css_class: "article" }, bind: "items" },
        { type: "follow_link", items_var: "items", max_follow: 20 },
      ],
      output: { items_var: "items" },
    };
    const result = await runSourceRecipe(instanceSettings(), runInput(recipe, "scan", LIST_HTML));
    expect(result.status).toBe("succeeded");
    expect(result.followed_urls).toEqual([`${ORIGIN}/a1`, `${ORIGIN}/a2`]);
    expect(result.items[0]!.snapshots).toHaveLength(1);
    await cleanup(result);
  });

  it("rejects a live fetch outside the policy envelope's allowed origins", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");
    const recipe: SourceRecipeDefinition = {
      recipe_version: "source.recipe.v1",
      steps: [{ type: "fetch_page", url: "https://evil.example/x", bind: "page" }],
      output: { items_var: "page" },
    };
    const result = await runSourceRecipe(instanceSettings(), runInput(recipe, "scan", LIST_HTML));
    expect(result.status).toBe("failed");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.step_traces[0]).toMatchObject({ primitive: "fetch_page", status: "failed" });
    await cleanup(result);
  });

  it("fails closed with a failed trace when a variable is unbound or the output binding is missing", async () => {
    const recipe: SourceRecipeDefinition = {
      recipe_version: "source.recipe.v1",
      steps: [{ type: "extract_list", input: "never_bound", selector: { css_class: "article" }, bind: "items" }],
      output: { items_var: "items" },
    };
    const result = await runSourceRecipe(instanceSettings(), runInput(recipe, "dry_run", LIST_HTML));
    expect(result.status).toBe("failed");
    expect(result.error).toContain('recipe variable "never_bound" is not bound');
    expect(result.step_traces[0]!.status).toBe("failed");
    await cleanup(result);

    const unboundOutput: SourceRecipeDefinition = {
      recipe_version: "source.recipe.v1",
      steps: [{ type: "fetch_page", url: "$source.endpoint_url", bind: "page" }],
      output: { items_var: "never_bound" },
    };
    const result2 = await runSourceRecipe(instanceSettings(), runInput(unboundOutput, "dry_run", LIST_HTML));
    expect(result2.status).toBe("failed");
    expect(result2.raw_output_json).toBeNull();
    await cleanup(result2);
  });

  it("produces output that passes the shared source output contract validator", async () => {
    const recipe: SourceRecipeDefinition = {
      recipe_version: "source.recipe.v1",
      steps: [
        { type: "fetch_page", url: "$source.endpoint_url", bind: "feed" },
        { type: "parse_rss", input: "feed", bind: "items" },
      ],
      output: { items_var: "items" },
    };
    const result = await runSourceRecipe(instanceSettings(), runInput(recipe, "dry_run", RSS_XML));
    expect(result.status).toBe("succeeded");
    const validation = await validateCustomSourceHandlerOutput({
      raw: JSON.parse(result.raw_output_json!),
      limits: policyEnvelope().limits,
      allowedNetworkOrigins: [ORIGIN],
      sandboxFilesRoot: result.sandbox_files_root,
    });
    expect(validation.ok).toBe(true);
    await cleanup(result);
  });

  it("runs an existing declarative pipeline definition through the compatibility wrapper", async () => {
    const pipeline: CustomSourcePipelineDefinition = {
      pipeline_version: "custom_source.pipeline.v1",
      steps: [
        { type: "fetch_page", url: "$source.endpoint_url", bind: "list_page" },
        { type: "extract_list", input: "list_page", selector: { css_class: "article" }, bind: "items" },
      ],
      output: { items_var: "items" },
    };
    const recipe = recipeFromPipelineDefinition(pipeline);
    const result = await runSourceRecipe(instanceSettings(), runInput(recipe, "scan", LIST_HTML));
    expect(result.status).toBe("succeeded");
    expect(result.items).toHaveLength(2);
    expect(result.items[0]).toMatchObject({ title: "First Title", source_uri: `${ORIGIN}/a1` });
    await cleanup(result);
  });

  it("reports output_too_large instead of truncated output", async () => {
    const recipe: SourceRecipeDefinition = {
      recipe_version: "source.recipe.v1",
      steps: [
        { type: "fetch_page", url: "$source.endpoint_url", bind: "feed" },
        { type: "parse_rss", input: "feed", bind: "items" },
      ],
      output: { items_var: "items" },
    };
    const result = await runSourceRecipe(
      instanceSettings(),
      runInput(recipe, "dry_run", RSS_XML, {
        policyEnvelope: policyEnvelope({ limits: { ...policyEnvelope().limits, max_output_bytes: 10 } }),
      }),
    );
    expect(result.status).toBe("succeeded");
    expect(result.output_too_large).toBe(true);
    expect(result.raw_output_json).toBeNull();
    await cleanup(result);
  });
});
