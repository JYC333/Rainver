import { afterEach, describe, expect, it, vi } from "vitest";
import { TWO_ARTICLE_HTML, customSourcePolicyEnvelope, runnerSettings } from "./support/customSourceFixtures.js";
import { rm } from "node:fs/promises";
import type {
  CustomSourceHandlerInput,
  CustomSourcePipelineDefinition,
  } from "@agent-space/protocol";
import { runCustomSourcePipeline } from "../src/modules/sources/customSources/customSourcePipelineInterpreter.js";
import type { CustomSourceRunnerSettings } from "../src/modules/sources/customSources/customSourceRunner.js";

const ORIGIN = "https://sources.example";

const policyEnvelope = (overrides: Parameters<typeof customSourcePolicyEnvelope>[0] = {}) =>
  customSourcePolicyEnvelope({ allowed_network_origins: [ORIGIN], language: "declarative_pipeline_v1", ...overrides });

const instanceSettings = (overrides: Partial<CustomSourceRunnerSettings> = {}) =>
  runnerSettings({ allowed_languages: ["declarative_pipeline_v1"], ...overrides });

function handlerInput(
  mode: "test" | "scan",
  fetchedHtml: string,
  overrides: Partial<CustomSourceHandlerInput> = {},
): CustomSourceHandlerInput {
  return {
    contract_version: "custom_source.handler_input.v1",
    run: {
      mode,
      job_id: "job-1",
      connection_id: "conn-1",
      handler_version_id: "version-1",
      started_at: new Date().toISOString(),
    },
    source: {
      name: "Example Source",
      endpoint_url: `${ORIGIN}/list`,
      config: { fetched_html: fetchedHtml },
      cursor: null,
    },
    policy: {
      allowed_network_origins: [ORIGIN],
      capture_policy: "extract_text",
      retention_policy: "full_text",
      credential_ref: null,
      limits: policyEnvelope().limits,
    },
    ...overrides,
  };
}

const LIST_HTML = TWO_ARTICLE_HTML;

afterEach(async () => {
  vi.restoreAllMocks();
});

async function cleanup(result: { sandbox_files_root: string }): Promise<void> {
  await rm(result.sandbox_files_root, { recursive: true, force: true }).catch(() => undefined);
}

describe("runCustomSourcePipeline", () => {
  it("fetch_page (primary sentinel) + extract_list produces items from the pre-fetched HTML", async () => {
    const pipeline: CustomSourcePipelineDefinition = {
      pipeline_version: "custom_source.pipeline.v1",
      steps: [
        { type: "fetch_page", url: "$source.endpoint_url", bind: "list_page" },
        { type: "extract_list", input: "list_page", selector: { css_class: "article" }, bind: "items" },
      ],
      output: { items_var: "items" },
    };

    const result = await runCustomSourcePipeline(instanceSettings(), {
      policyEnvelope: policyEnvelope(),
      handlerInput: handlerInput("scan", LIST_HTML),
      pipeline,
    });
    expect(result.status).toBe("completed");
    if (result.status !== "completed") throw new Error("unreachable");
    expect(result.exit_code).toBe(0);
    const output = JSON.parse(result.raw_output_json!);
    expect(output.items).toHaveLength(2);
    expect(output.items[0].title).toBe("First Title");
    expect(output.items[0].source_uri).toBe("https://sources.example/a1");
    await cleanup(result);
  });

  it("extract_single produces one item from the whole page", async () => {
    const pipeline: CustomSourcePipelineDefinition = {
      pipeline_version: "custom_source.pipeline.v1",
      steps: [
        { type: "fetch_page", url: "$source.endpoint_url", bind: "page" },
        { type: "extract_single", input: "page", bind: "items" },
      ],
      output: { items_var: "items" },
    };
    const result = await runCustomSourcePipeline(instanceSettings(), {
      policyEnvelope: policyEnvelope(),
      handlerInput: handlerInput("scan", `<html><head><title>My Page</title></head><body>Hello world</body></html>`),
      pipeline,
    });
    expect(result.status).toBe("completed");
    if (result.status !== "completed") throw new Error("unreachable");
    const output = JSON.parse(result.raw_output_json!);
    expect(output.items).toHaveLength(1);
    expect(output.items[0].title).toBe("My Page");
    await cleanup(result);
  });

  it("follow_link fetches each item's own page, enriches title/excerpt, and stores a raw_html snapshot", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
      if (String(url) === "https://sources.example/a1") {
        return new Response(`<title>Detail A1</title><body>Full detail text for A1.</body>`, { status: 200 });
      }
      return new Response(`<title>Detail A2</title><body>Full detail text for A2.</body>`, { status: 200 });
    });

    const pipeline: CustomSourcePipelineDefinition = {
      pipeline_version: "custom_source.pipeline.v1",
      steps: [
        { type: "fetch_page", url: "$source.endpoint_url", bind: "list_page" },
        { type: "extract_list", input: "list_page", selector: { css_class: "article" }, bind: "items" },
        { type: "follow_link", items_var: "items", max_follow: 20 },
      ],
      output: { items_var: "items" },
    };

    const result = await runCustomSourcePipeline(instanceSettings(), {
      policyEnvelope: policyEnvelope(),
      handlerInput: handlerInput("scan", LIST_HTML),
      pipeline,
    });
    expect(result.status).toBe("completed");
    if (result.status !== "completed") throw new Error("unreachable");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const output = JSON.parse(result.raw_output_json!);
    expect(output.items[0].title).toBe("Detail A1");
    expect(output.items[0].excerpt).toContain("Full detail text for A1");
    expect(output.items[0].snapshots).toHaveLength(1);
    expect(output.items[0].snapshots[0]).toMatchObject({ snapshot_type: "raw_html", mime_type: "text/html" });
    await cleanup(result);
  });

  it("injects the resolved credential header into every one of the interpreter's own live fetches (follow_link, download_asset, a non-sentinel fetch_page, and paginate's next-page fetch)", async () => {
    const seenAuthHeaders: (string | null)[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
      const headers = new Headers((init as RequestInit | undefined)?.headers);
      seenAuthHeaders.push(headers.get("Authorization"));
      if (String(url) === "https://sources.example/a1") {
        return new Response(`<title>Detail</title><body>Detail body.</body>`, { status: 200 });
      }
      if (String(url) === "https://sources.example/asset") {
        return new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { "content-type": "application/pdf" } });
      }
      if (String(url).includes("page=2")) {
        return new Response(`<div class="article"><a href="/b1">Page2</a><p>Page 2 excerpt.</p></div>`, { status: 200 });
      }
      return new Response(LIST_HTML, { status: 200 });
    });

    const pipeline: CustomSourcePipelineDefinition = {
      pipeline_version: "custom_source.pipeline.v1",
      steps: [
        { type: "fetch_page", url: "https://sources.example/other-page", bind: "other_page" },
        { type: "fetch_page", url: "$source.endpoint_url", bind: "list_page" },
        { type: "extract_list", input: "list_page", selector: { css_class: "article" }, bind: "items" },
        { type: "follow_link", items_var: "items", max_follow: 1 },
        { type: "download_asset", items_var: "items" },
        {
          type: "paginate",
          input: "list_page",
          max_pages: 2,
          next_page: { mode: "query_param", param: "page", start_page: 2 },
          steps: [{ type: "extract_list", input: "list_page", selector: { css_class: "article" }, bind: "page_items" }],
          page_items_var: "page_items",
          bind: "items",
        },
      ],
      output: { items_var: "items" },
    };

    // download_asset needs a source_uri it can fetch as a raw asset — reuse
    // the first extracted item's link by pointing items[0].source_uri at the
    // asset URL via a fixture with a single, asset-linking article block.
    const ASSET_LIST_HTML = `<div class="article"><a href="https://sources.example/asset">Asset</a><p>x</p></div>`;

    const result = await runCustomSourcePipeline(instanceSettings(), {
      policyEnvelope: policyEnvelope(),
      handlerInput: handlerInput("scan", ASSET_LIST_HTML),
      pipeline,
      credential: { header_name: "Authorization", header_value: "Bearer s3cr3t" },
    });
    expect(result.status).toBe("completed");
    if (result.status !== "completed") throw new Error("unreachable");
    expect(seenAuthHeaders.length).toBeGreaterThan(0);
    expect(seenAuthHeaders.every((header) => header === "Bearer s3cr3t")).toBe(true);
    await cleanup(result);
  });

  it("follow_link respects max_follow and never exceeds max_files snapshots", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(`<title>Detail</title><body>Detail body.</body>`, { status: 200 }));

    const pipeline: CustomSourcePipelineDefinition = {
      pipeline_version: "custom_source.pipeline.v1",
      steps: [
        { type: "fetch_page", url: "$source.endpoint_url", bind: "list_page" },
        { type: "extract_list", input: "list_page", selector: { css_class: "article" }, bind: "items" },
        { type: "follow_link", items_var: "items", max_follow: 1 },
      ],
      output: { items_var: "items" },
    };
    const result = await runCustomSourcePipeline(instanceSettings(), {
      policyEnvelope: policyEnvelope({ limits: { ...policyEnvelope().limits, max_files: 1 } }),
      handlerInput: handlerInput("scan", LIST_HTML),
      pipeline,
    });
    expect(result.status).toBe("completed");
    if (result.status !== "completed") throw new Error("unreachable");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await cleanup(result);
  });

  it("download_asset stores a snapshot with the response mime type and rejects a mime not in the allowlist", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
      if (String(url) === "https://sources.example/a1") {
        return new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { "content-type": "application/pdf" } });
      }
      return new Response(new Uint8Array([4, 5, 6]), { status: 200, headers: { "content-type": "image/png" } });
    });

    const pipeline: CustomSourcePipelineDefinition = {
      pipeline_version: "custom_source.pipeline.v1",
      steps: [
        { type: "fetch_page", url: "$source.endpoint_url", bind: "list_page" },
        { type: "extract_list", input: "list_page", selector: { css_class: "article" }, bind: "items" },
        { type: "download_asset", items_var: "items", mime_allowlist: ["application/pdf"] },
      ],
      output: { items_var: "items" },
    };
    const result = await runCustomSourcePipeline(instanceSettings(), {
      policyEnvelope: policyEnvelope(),
      handlerInput: handlerInput("scan", LIST_HTML),
      pipeline,
    });
    expect(result.status).toBe("completed");
    if (result.status !== "completed") throw new Error("unreachable");
    const output = JSON.parse(result.raw_output_json!);
    expect(output.items[0].snapshots).toHaveLength(1);
    expect(output.items[0].snapshots[0]).toMatchObject({ snapshot_type: "download", mime_type: "application/pdf" });
    expect(output.items[1].snapshots).toHaveLength(0);
    expect(output.diagnostics.warnings.some((w: string) => w.includes("not in mime_allowlist"))).toBe(true);
    await cleanup(result);
  });

  it("paginate (query_param mode) merges items across pages up to max_pages", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
      const parsed = new URL(String(url));
      const page = parsed.searchParams.get("page");
      if (page === "2") {
        return new Response(
          `<div class="article"><a href="/b1">Page2 Title</a><p>Page 2 excerpt.</p></div>`,
          { status: 200 },
        );
      }
      throw new Error(`unexpected fetch to ${url}`);
    });

    const pipeline: CustomSourcePipelineDefinition = {
      pipeline_version: "custom_source.pipeline.v1",
      steps: [
        { type: "fetch_page", url: "$source.endpoint_url", bind: "page1" },
        {
          type: "paginate",
          input: "page1",
          max_pages: 2,
          next_page: { mode: "query_param", param: "page", start_page: 2 },
          steps: [{ type: "extract_list", input: "page1", selector: { css_class: "article" }, bind: "page_items" }],
          page_items_var: "page_items",
          bind: "all_items",
        },
      ],
      output: { items_var: "all_items" },
    };
    const result = await runCustomSourcePipeline(instanceSettings(), {
      policyEnvelope: policyEnvelope(),
      handlerInput: handlerInput("scan", LIST_HTML),
      pipeline,
    });
    expect(result.status).toBe("completed");
    if (result.status !== "completed") throw new Error("unreachable");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const output = JSON.parse(result.raw_output_json!);
    expect(output.items).toHaveLength(3);
    expect(output.items[2].title).toBe("Page2 Title");
    await cleanup(result);
  });

  it("test mode never performs a live fetch for follow_link/download_asset/paginate/secondary fetch_page", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");
    const pipeline: CustomSourcePipelineDefinition = {
      pipeline_version: "custom_source.pipeline.v1",
      steps: [
        { type: "fetch_page", url: "$source.endpoint_url", bind: "list_page" },
        { type: "extract_list", input: "list_page", selector: { css_class: "article" }, bind: "items" },
        { type: "follow_link", items_var: "items", max_follow: 20 },
        { type: "download_asset", items_var: "items" },
        {
          type: "paginate",
          input: "list_page",
          max_pages: 3,
          next_page: { mode: "query_param", param: "page", start_page: 2 },
          steps: [{ type: "extract_list", input: "list_page", selector: { css_class: "article" }, bind: "page_items" }],
          page_items_var: "page_items",
          bind: "items",
        },
      ],
      output: { items_var: "items" },
    };
    const result = await runCustomSourcePipeline(instanceSettings(), {
      policyEnvelope: policyEnvelope(),
      handlerInput: handlerInput("test", LIST_HTML),
      pipeline,
    });
    expect(result.status).toBe("completed");
    if (result.status !== "completed") throw new Error("unreachable");
    expect(fetchMock).not.toHaveBeenCalled();
    const output = JSON.parse(result.raw_output_json!);
    expect(output.diagnostics.warnings.length).toBeGreaterThan(0);
    await cleanup(result);
  });

  it("rejects a fetch_page target outside the policy envelope's allowed_network_origins", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");
    const pipeline: CustomSourcePipelineDefinition = {
      pipeline_version: "custom_source.pipeline.v1",
      steps: [{ type: "fetch_page", url: "https://evil.example/x", bind: "page" }],
      output: { items_var: "page" },
    };
    const result = await runCustomSourcePipeline(instanceSettings(), {
      policyEnvelope: policyEnvelope(),
      handlerInput: handlerInput("scan", LIST_HTML),
      pipeline,
    });
    expect(result.status).toBe("completed");
    if (result.status !== "completed") throw new Error("unreachable");
    expect(result.exit_code).toBe(1);
    expect(result.raw_output_json).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
    await cleanup(result);
  });

  it("times out when the wall-clock budget is exceeded", async () => {
    // Real (unmocked) setTimeout genuinely advances wall-clock time so the
    // *next* step's pre-flight `checkDeadline()` reliably observes the
    // timeout — this avoids racing the mock against `AbortSignal.timeout`.
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, 30));
      return new Response("slow content", { status: 200 });
    });
    const pipeline: CustomSourcePipelineDefinition = {
      pipeline_version: "custom_source.pipeline.v1",
      steps: [
        { type: "fetch_page", url: "https://sources.example/slow", bind: "page1" },
        { type: "fetch_page", url: "$source.endpoint_url", bind: "page2" },
      ],
      output: { items_var: "page2" },
    };
    const result = await runCustomSourcePipeline(instanceSettings(), {
      policyEnvelope: policyEnvelope({ limits: { ...policyEnvelope().limits, timeout_ms: 10 } }),
      handlerInput: handlerInput("scan", LIST_HTML),
      pipeline,
    });
    expect(result.status).toBe("completed");
    if (result.status !== "completed") throw new Error("unreachable");
    expect(result.timed_out).toBe(true);
    expect(result.exit_code).toBeNull();
    expect(result.raw_output_json).toBeNull();
    await cleanup(result);
  });

  it("reports output_too_large instead of a truncated/corrupt raw_output_json", async () => {
    const pipeline: CustomSourcePipelineDefinition = {
      pipeline_version: "custom_source.pipeline.v1",
      steps: [
        { type: "fetch_page", url: "$source.endpoint_url", bind: "list_page" },
        { type: "extract_list", input: "list_page", selector: { css_class: "article" }, bind: "items" },
      ],
      output: { items_var: "items" },
    };
    const result = await runCustomSourcePipeline(instanceSettings(), {
      policyEnvelope: policyEnvelope({ limits: { ...policyEnvelope().limits, max_output_bytes: 10 } }),
      handlerInput: handlerInput("scan", LIST_HTML),
      pipeline,
    });
    expect(result.status).toBe("completed");
    if (result.status !== "completed") throw new Error("unreachable");
    expect(result.output_too_large).toBe(true);
    expect(result.raw_output_json).toBeNull();
    await cleanup(result);
  });

  it("fails closed when output.items_var was never bound", async () => {
    const pipeline: CustomSourcePipelineDefinition = {
      pipeline_version: "custom_source.pipeline.v1",
      steps: [{ type: "fetch_page", url: "$source.endpoint_url", bind: "page" }],
      output: { items_var: "never_bound" },
    };
    const result = await runCustomSourcePipeline(instanceSettings(), {
      policyEnvelope: policyEnvelope(),
      handlerInput: handlerInput("scan", LIST_HTML),
      pipeline,
    });
    expect(result.status).toBe("completed");
    if (result.status !== "completed") throw new Error("unreachable");
    expect(result.exit_code).toBe(1);
    expect(result.raw_output_json).toBeNull();
    await cleanup(result);
  });
});
