import { describe, expect, it } from "vitest";
import {
  CustomSourcePolicyEnvelopeSchema,
  ProjectSourceBindingDTOSchema,
  SOURCE_RECIPE_CONTRACT_VERSION,
  SOURCE_RECIPE_PRIMARY_ENDPOINT_URL,
  SOURCE_RECIPE_PRIMITIVE_NAMES,
  SOURCE_RECIPE_VERSION_STATUS_VALUES,
  SourcePolicyEnvelopeSchema,
  SourceRecipeDefinitionSchema,
  SourceRecipeDryRunResultSchema,
  SourceRecipePrimitiveDefinitionDTOSchema,
  SourceHealthDTOSchema,
  SourceRecipeVersionDTOSchema,
  SourceRunSummaryDTOSchema,
} from "../src/index";

describe("project source binding contracts", () => {
  it("names the bound channel the way the server returns it", () => {
    const binding = ProjectSourceBindingDTOSchema.parse({
      id: "binding-1",
      space_id: "space-1",
      project_id: "project-1",
      source_channel_id: "channel-1",
      binding_key: "channel-1",
      status: "active",
      priority: 0,
      delivery_scope: "project_members",
      collection_notifications_enabled: true,
      standing_comparison_enabled: false,
      filters_json: {},
      routing_policy_json: {},
      extraction_policy_json: {},
      created_by_user_id: "user-1",
      created_at: "2026-07-01T00:00:00.000Z",
      updated_at: "2026-07-01T00:00:00.000Z",
    });
    expect(binding.source_channel_id).toBe("channel-1");
    expect(SourceHealthDTOSchema.parse({
      binding_id: "binding-1",
      project_id: "project-1",
      source_connection_id: "connection-1",
      source_channel_id: "channel-1",
      source_name: "Feed",
      status: "healthy",
      queued_jobs: 0,
      running_jobs: 0,
      recent_new_items: 0,
      consecutive_failures: 0,
    }).source_channel_id).toBe("channel-1");
  });
});

const limits = {
  timeout_ms: 30000,
  max_download_bytes: 5242880,
  max_output_bytes: 1048576,
  max_files: 10,
  max_items: 50,
  max_evidence_items: 50,
  log_max_bytes: 65536,
};

const envelope = {
  allowed_network_origins: ["https://example.com"],
  capture_policy: "extract_text",
  retention_policy: "full_text",
  credential_ref: null,
  limits,
};

describe("SourceRecipeDefinitionSchema", () => {
  it("represents current declarative-pipeline behavior without handler terminology", () => {
    const parsed = SourceRecipeDefinitionSchema.parse({
      recipe_version: SOURCE_RECIPE_CONTRACT_VERSION,
      steps: [
        { type: "fetch_page", url: SOURCE_RECIPE_PRIMARY_ENDPOINT_URL, bind: "page1" },
        {
          type: "paginate",
          input: "page1",
          max_pages: 3,
          next_page: { mode: "link_rel_next" },
          steps: [{ type: "extract_list", input: "page1", selector: { css_class: "article" }, bind: "page_items" }],
          page_items_var: "page_items",
          bind: "raw_items",
        },
        { type: "follow_link", items_var: "raw_items", max_follow: 5 },
        { type: "download_asset", items_var: "raw_items", mime_allowlist: ["application/pdf"] },
        { type: "dedupe", input: "raw_items", bind: "items" },
      ],
      output: { items_var: "items" },
    });
    expect(parsed.steps).toHaveLength(5);
  });

  it("represents an RSS feed source through parse_rss", () => {
    const parsed = SourceRecipeDefinitionSchema.parse({
      recipe_version: SOURCE_RECIPE_CONTRACT_VERSION,
      steps: [
        { type: "fetch_page", url: SOURCE_RECIPE_PRIMARY_ENDPOINT_URL, bind: "feed" },
        { type: "parse_rss", input: "feed", bind: "entries", max_items: 40 },
        { type: "dedupe", input: "entries", bind: "items", by: "source_uri" },
      ],
      output: { items_var: "items" },
    });
    expect(parsed.steps[1]).toMatchObject({ type: "parse_rss", max_items: 40 });
  });

  it("represents an Atom feed and a single web page source", () => {
    expect(() =>
      SourceRecipeDefinitionSchema.parse({
        recipe_version: SOURCE_RECIPE_CONTRACT_VERSION,
        steps: [
          { type: "fetch_page", url: SOURCE_RECIPE_PRIMARY_ENDPOINT_URL, bind: "feed" },
          { type: "parse_atom", input: "feed", bind: "items" },
        ],
        output: { items_var: "items" },
      }),
    ).not.toThrow();
    expect(() =>
      SourceRecipeDefinitionSchema.parse({
        recipe_version: SOURCE_RECIPE_CONTRACT_VERSION,
        steps: [
          { type: "fetch_page", url: SOURCE_RECIPE_PRIMARY_ENDPOINT_URL, bind: "page" },
          { type: "extract_single", input: "page", bind: "items" },
        ],
        output: { items_var: "items" },
      }),
    ).not.toThrow();
  });

  it("rejects a paginate step nested inside another paginate step", () => {
    const result = SourceRecipeDefinitionSchema.safeParse({
      recipe_version: SOURCE_RECIPE_CONTRACT_VERSION,
      steps: [
        { type: "fetch_page", url: SOURCE_RECIPE_PRIMARY_ENDPOINT_URL, bind: "page1" },
        {
          type: "paginate",
          input: "page1",
          max_pages: 2,
          next_page: { mode: "query_param", param: "page", start_page: 2 },
          steps: [
            {
              type: "paginate",
              input: "page1",
              max_pages: 2,
              next_page: { mode: "link_rel_next" },
              steps: [],
              page_items_var: "inner",
              bind: "inner_items",
            },
          ],
          page_items_var: "page_items",
          bind: "items",
        },
      ],
      output: { items_var: "items" },
    });
    expect(result.success).toBe(false);
  });

  it("rejects unknown primitives and a missing output binding", () => {
    expect(
      SourceRecipeDefinitionSchema.safeParse({
        recipe_version: SOURCE_RECIPE_CONTRACT_VERSION,
        steps: [{ type: "run_shell", command: "curl" }],
        output: { items_var: "items" },
      }).success,
    ).toBe(false);
    expect(
      SourceRecipeDefinitionSchema.safeParse({
        recipe_version: SOURCE_RECIPE_CONTRACT_VERSION,
        steps: [{ type: "fetch_page", url: SOURCE_RECIPE_PRIMARY_ENDPOINT_URL, bind: "page" }],
        output: {},
      }).success,
    ).toBe(false);
  });
});

describe("SourcePolicyEnvelopeSchema", () => {
  it("parses the shared envelope and defaults log redaction on", () => {
    const parsed = SourcePolicyEnvelopeSchema.parse(envelope);
    expect(parsed.log_redaction_enabled).toBe(true);
    expect(parsed.allowed_network_origins).toEqual(["https://example.com"]);
  });

  it("accepts a Level 3 handler envelope as a structural superset", () => {
    const handlerEnvelope = CustomSourcePolicyEnvelopeSchema.parse({
      ...envelope,
      language: "typescript_node",
    });
    expect(() => SourcePolicyEnvelopeSchema.parse(handlerEnvelope)).not.toThrow();
  });

  it("keeps selector changes out of the policy envelope (recipe change is not a permission delta)", () => {
    const recipeA = SourceRecipeDefinitionSchema.parse({
      recipe_version: SOURCE_RECIPE_CONTRACT_VERSION,
      steps: [
        { type: "fetch_page", url: SOURCE_RECIPE_PRIMARY_ENDPOINT_URL, bind: "page" },
        { type: "extract_list", input: "page", selector: { css_class: "article" }, bind: "items" },
      ],
      output: { items_var: "items" },
    });
    const recipeB = SourceRecipeDefinitionSchema.parse({
      ...recipeA,
      steps: [
        recipeA.steps[0]!,
        { type: "extract_list", input: "page", selector: { css_class: "post" }, bind: "items" },
      ],
    });
    expect(recipeA).not.toEqual(recipeB);
    expect(SourcePolicyEnvelopeSchema.parse(envelope)).toEqual(SourcePolicyEnvelopeSchema.parse(envelope));
  });
});

describe("SourceRecipeVersionDTOSchema", () => {
  it("parses a draft recipe version with the full status lifecycle available", () => {
    expect(SOURCE_RECIPE_VERSION_STATUS_VALUES).toEqual([
      "draft",
      "test_failed",
      "pending_approval",
      "active",
      "superseded",
      "disabled",
    ]);
    const parsed = SourceRecipeVersionDTOSchema.parse({
      id: "11111111-1111-4111-8111-111111111111",
      space_id: "22222222-2222-4222-8222-222222222222",
      source_connection_id: "33333333-3333-4333-8333-333333333333",
      version_number: 1,
      recipe_json: {
        recipe_version: SOURCE_RECIPE_CONTRACT_VERSION,
        steps: [
          { type: "fetch_page", url: SOURCE_RECIPE_PRIMARY_ENDPOINT_URL, bind: "feed" },
          { type: "parse_rss", input: "feed", bind: "items" },
        ],
        output: { items_var: "items" },
      },
      policy_envelope_json: envelope,
      primitive_versions_json: { fetch_page: 1, parse_rss: 1 },
      status: "draft",
      created_by_user_id: null,
      proposal_id: null,
      test_result_json: null,
      created_at: "2026-07-01T00:00:00.000Z",
      activated_at: null,
      superseded_at: null,
    });
    expect(parsed.status).toBe("draft");
  });
});

describe("SourceRecipeDryRunResultSchema", () => {
  it("parses a dry-run result exposing sample items, traces, and the policy envelope", () => {
    const parsed = SourceRecipeDryRunResultSchema.parse({
      status: "succeeded",
      item_count: 2,
      sample_items: [
        {
          external_id: "abc",
          title: "Item one",
          source_uri: "https://example.com/one",
          snapshots: [],
          evidence: [],
        },
      ],
      followed_urls: ["https://example.com/one"],
      skipped_urls: ["https://other.example.net/x"],
      warnings: ["follow_link: live fetch skipped in dry-run"],
      errors: [],
      step_traces: [
        { step_path: "steps[0]", primitive: "fetch_page", status: "succeeded", duration_ms: 12 },
        { step_path: "steps[1]", primitive: "parse_rss", status: "succeeded", item_count: 2, duration_ms: 3 },
      ],
      policy_envelope: envelope,
      started_at: "2026-07-01T00:00:00.000Z",
      completed_at: "2026-07-01T00:00:01.000Z",
    });
    expect(parsed.step_traces).toHaveLength(2);
    expect(parsed.policy_envelope.limits.max_items).toBe(50);
  });
});

describe("SourceRunSummaryDTOSchema", () => {
  it("parses read-model rows projected from jobs, handler runs, and recipe dry-runs", () => {
    for (const row of [
      {
        id: "job:44444444-4444-4444-8444-444444444444",
        run_kind: "scan",
        implementation: "built_in",
        status: "succeeded",
        extraction_job_id: "44444444-4444-4444-8444-444444444444",
      },
      {
        id: "handler_run:55555555-5555-4555-8555-555555555555",
        run_kind: "scan",
        implementation: "generated_handler",
        status: "blocked",
        handler_run_id: "55555555-5555-4555-8555-555555555555",
      },
      {
        id: "recipe_dry_run:66666666-6666-4666-8666-666666666666",
        run_kind: "dry_run",
        implementation: "recipe",
        status: "succeeded",
        recipe_version_id: "66666666-6666-4666-8666-666666666666",
      },
    ]) {
      expect(() =>
        SourceRunSummaryDTOSchema.parse({
          space_id: "22222222-2222-4222-8222-222222222222",
          source_connection_id: "33333333-3333-4333-8333-333333333333",
          created_at: "2026-07-01T00:00:00.000Z",
          ...row,
        }),
      ).not.toThrow();
    }
  });
});

describe("SourceRecipePrimitiveDefinitionDTOSchema", () => {
  it("describes a primitive with permission declarations", () => {
    const parsed = SourceRecipePrimitiveDefinitionDTOSchema.parse({
      name: "follow_link",
      version: 1,
      description: "Fetch each item's own link and enrich the item",
      input_kind: "items",
      output_kind: "items",
      network_access: "live_fetch",
      writes_files: true,
    });
    expect(parsed.network_access).toBe("live_fetch");
    expect(SOURCE_RECIPE_PRIMITIVE_NAMES).toContain(parsed.name);
  });
});
