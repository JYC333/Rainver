import { describe, expect, it } from "vitest";
import {
  CustomSourceHandlerInputSchema,
  CustomSourceHandlerOutputSchema,
  CustomSourceHandlerVersionDTOSchema,
  CustomSourcePipelineDefinitionSchema,
  CustomSourcePolicyEnvelopeSchema,
  CustomSourceSpacePolicyDTOSchema,
} from "../src/index";

const policyEnvelope = {
  allowed_network_origins: ["https://example.com"],
  capture_policy: "extract_text",
  retention_policy: "full_text",
  credential_ref: null,
  language: "typescript_node",
  limits: {
    timeout_ms: 30000,
    max_download_bytes: 5242880,
    max_output_bytes: 1048576,
    max_files: 50,
    max_items: 100,
    max_evidence_items: 200,
    log_max_bytes: 65536,
  },
};

describe("CustomSourcePolicyEnvelopeSchema", () => {
  it("parses a minimal envelope and defaults sensitive flags closed", () => {
    const parsed = CustomSourcePolicyEnvelopeSchema.parse(policyEnvelope);
    expect(parsed.browser_automation_enabled).toBe(false);
    expect(parsed.shell_enabled).toBe(false);
    expect(parsed.dependency_installation_enabled).toBe(false);
    expect(parsed.log_redaction_enabled).toBe(true);
  });
});

describe("CustomSourcePipelineDefinitionSchema", () => {
  it("parses a minimal fetch_page + extract_list pipeline", () => {
    const parsed = CustomSourcePipelineDefinitionSchema.parse({
      pipeline_version: "custom_source.pipeline.v1",
      steps: [
        { type: "fetch_page", url: "$source.endpoint_url", bind: "list_page" },
        { type: "extract_list", input: "list_page", selector: { css_class: "article" }, bind: "items" },
      ],
      output: { items_var: "items" },
    });
    expect(parsed.steps).toHaveLength(2);
  });

  it("accepts a top-level paginate step", () => {
    expect(() =>
      CustomSourcePipelineDefinitionSchema.parse({
        pipeline_version: "custom_source.pipeline.v1",
        steps: [
          { type: "fetch_page", url: "$source.endpoint_url", bind: "page1" },
          {
            type: "paginate",
            input: "page1",
            max_pages: 3,
            next_page: { mode: "query_param", param: "page", start_page: 2 },
            steps: [{ type: "extract_list", input: "page1", selector: { css_class: "article" }, bind: "page_items" }],
            page_items_var: "page_items",
            bind: "items",
          },
        ],
        output: { items_var: "items" },
      }),
    ).not.toThrow();
  });

  it("rejects a paginate step nested inside another paginate step's steps", () => {
    expect(() =>
      CustomSourcePipelineDefinitionSchema.parse({
        pipeline_version: "custom_source.pipeline.v1",
        steps: [
          { type: "fetch_page", url: "$source.endpoint_url", bind: "page1" },
          {
            type: "paginate",
            input: "page1",
            max_pages: 3,
            next_page: { mode: "query_param", param: "page", start_page: 2 },
            steps: [
              {
                type: "paginate",
                input: "page1",
                max_pages: 2,
                next_page: { mode: "link_rel_next" },
                steps: [{ type: "extract_list", input: "page1", selector: { css_class: "article" }, bind: "page_items" }],
                page_items_var: "page_items",
                bind: "page_items",
              },
            ],
            page_items_var: "page_items",
            bind: "items",
          },
        ],
        output: { items_var: "items" },
      }),
    ).toThrow(/nested inside another paginate/);
  });
});

describe("CustomSourceHandlerInputSchema", () => {
  it("parses the example input.json", () => {
    const input = {
      contract_version: "custom_source.handler_input.v1",
      run: {
        mode: "scan",
        job_id: "job_123",
        connection_id: "conn_123",
        handler_version_id: "handler_v1",
        started_at: "2026-01-01T00:00:00.000Z",
      },
      source: {
        name: "Example Research Feed",
        endpoint_url: "https://example.com/research",
        config: { list_selector: ".article" },
        cursor: { etag: "abc", last_modified: "Wed, 01 Jan 2026 00:00:00 GMT" },
      },
      policy: {
        allowed_network_origins: ["https://example.com"],
        capture_policy: "extract_text",
        retention_policy: "full_text",
        credential_ref: null,
        limits: policyEnvelope.limits,
      },
    };
    expect(() => CustomSourceHandlerInputSchema.parse(input)).not.toThrow();
  });

  it("rejects an unknown contract version", () => {
    const input = {
      contract_version: "custom_source.handler_input.v2",
      run: {
        mode: "scan",
        job_id: "job_123",
        connection_id: "conn_123",
        handler_version_id: "handler_v1",
        started_at: "2026-01-01T00:00:00.000Z",
      },
      source: { name: "x", config: {} },
      policy: {
        allowed_network_origins: [],
        capture_policy: "extract_text",
        retention_policy: "full_text",
        limits: policyEnvelope.limits,
      },
    };
    expect(() => CustomSourceHandlerInputSchema.parse(input)).toThrow();
  });
});

describe("CustomSourceHandlerOutputSchema", () => {
  it("parses the example output.json", () => {
    const output = {
      contract_version: "custom_source.handler_output.v1",
      cursor: { etag: "def", last_modified: "Thu, 02 Jan 2026 00:00:00 GMT" },
      items: [
        {
          external_id: "article-1",
          title: "Article title",
          source_uri: "https://example.com/research/article-1",
          published_at: "2026-01-02T00:00:00.000Z",
          author: "Example author",
          excerpt: "Short excerpt",
          metadata: { tags: ["research"] },
          snapshots: [
            { snapshot_type: "raw_html", file_path: "article-1.html", mime_type: "text/html" },
          ],
          evidence: [
            { evidence_type: "quote", title: "Relevant quote", content_excerpt: "A short citable passage.", confidence: 0.8 },
          ],
        },
      ],
      diagnostics: { warnings: [] },
    };
    const parsed = CustomSourceHandlerOutputSchema.parse(output);
    expect(parsed.items).toHaveLength(1);
    expect(parsed.items[0]?.snapshots).toHaveLength(1);
  });

  it("rejects an unknown contract version", () => {
    expect(() =>
      CustomSourceHandlerOutputSchema.parse({ contract_version: "wrong", items: [] }),
    ).toThrow();
  });

  it("defaults items and diagnostics when absent", () => {
    const parsed = CustomSourceHandlerOutputSchema.parse({
      contract_version: "custom_source.handler_output.v1",
    });
    expect(parsed.items).toEqual([]);
    expect(parsed.diagnostics.warnings).toEqual([]);
  });
});

describe("CustomSourceHandlerVersionDTOSchema", () => {
  it("parses a full handler version row shape", () => {
    const version = {
      id: "v1",
      space_id: "space1",
      source_connection_id: "conn1",
      version_number: 1,
      language: "typescript_node",
      entrypoint: "index.js",
      handler_artifact_id: null,
      manifest_json: {},
      input_schema_json: null,
      output_schema_json: null,
      policy_envelope_json: policyEnvelope,
      requested_capabilities_json: null,
      checksum: "sha256:abc",
      status: "draft",
      created_by_user_id: "user1",
      created_by_run_id: null,
      proposal_id: null,
      test_result_json: null,
      created_at: "2026-01-01T00:00:00.000Z",
      activated_at: null,
      superseded_at: null,
    };
    expect(() => CustomSourceHandlerVersionDTOSchema.parse(version)).not.toThrow();
  });
});

describe("CustomSourceSpacePolicyDTOSchema", () => {
  it("parses the not-yet-configured system-default response, where created_at/updated_at are null", () => {
    const defaults = {
      space_id: "space1",
      creator_roles: ["owner", "admin"],
      default_capture_policy: "extract_text",
      default_retention_policy: "full_text",
      allowed_domains: [],
      download_bytes_max: 5242880,
      credentialed_sources_allowed: false,
      same_envelope_repair_auto_apply: false,
      created_at: null,
      updated_at: null,
    };
    expect(() => CustomSourceSpacePolicyDTOSchema.parse(defaults)).not.toThrow();
  });

  it("parses a configured row with real timestamps", () => {
    const configured = {
      space_id: "space1",
      creator_roles: ["owner"],
      default_capture_policy: "reference_only",
      default_retention_policy: "full_text",
      allowed_domains: ["example.com"],
      download_bytes_max: 2097152,
      credentialed_sources_allowed: true,
      same_envelope_repair_auto_apply: true,
      created_at: "2026-01-01T00:00:00.000Z",
      updated_at: "2026-01-02T00:00:00.000Z",
    };
    expect(() => CustomSourceSpacePolicyDTOSchema.parse(configured)).not.toThrow();
  });
});
