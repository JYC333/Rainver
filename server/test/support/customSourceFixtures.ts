import type { CustomSourcePolicyEnvelope, SourcePolicyEnvelope } from "@rainver/protocol";
import type { SourceExecutionSettings } from "../../src/modules/sources/sourceExecutionPolicy.js";

/**
 * Shared execution settings, policy envelopes and listing-page fixtures for
 * Sources interpreters, materialization and create-flow tests. Pass only what
 * a test needs to differ; `limits` merges.
 */

export function runnerSettings(overrides: Partial<SourceExecutionSettings> = {}): SourceExecutionSettings {
  return {
    runner_enabled: true,
    allowed_languages: ["typescript_node"],
    network_hard_deny_rules: [],
    timeout_ms_max: 30_000,
    output_bytes_max: 1_048_576,
    download_bytes_max: 5_242_880,
    log_bytes_max: 65_536,
    max_files: 50,
    browser_automation_available: false,
    shell_available: false,
    dependency_installation_available: false,
    ...overrides,
  };
}

const ENVELOPE_LIMITS = {
  timeout_ms: 5000,
  max_download_bytes: 1_000_000,
  max_output_bytes: 1_000_000,
  max_files: 5,
  max_items: 20,
  max_evidence_items: 20,
  log_max_bytes: 65536,
};

type EnvelopeOverrides<T extends { limits: object }> = Omit<Partial<T>, "limits"> & { limits?: Partial<T["limits"]> };

export function customSourcePolicyEnvelope(
  overrides: EnvelopeOverrides<CustomSourcePolicyEnvelope> = {},
): CustomSourcePolicyEnvelope {
  const { limits, ...rest } = overrides;
  return {
    allowed_network_origins: [],
    capture_policy: "extract_text",
    retention_policy: "full_text",
    credential_ref: null,
    language: "typescript_node",
    browser_automation_enabled: false,
    shell_enabled: false,
    dependency_installation_enabled: false,
    log_redaction_enabled: true,
    ...rest,
    limits: { ...ENVELOPE_LIMITS, ...limits },
  } as CustomSourcePolicyEnvelope;
}

export function sourcePolicyEnvelope(overrides: EnvelopeOverrides<SourcePolicyEnvelope> = {}): SourcePolicyEnvelope {
  const { limits, ...rest } = overrides;
  return {
    allowed_network_origins: [],
    capture_policy: "extract_text",
    retention_policy: "full_text",
    credential_ref: null,
    log_redaction_enabled: true,
    ...rest,
    limits: { ...ENVELOPE_LIMITS, ...limits },
  } as SourcePolicyEnvelope;
}

/** A listing page with two articles for declarative extraction tests. */
export const TWO_ARTICLE_HTML = `<html><body>
  <div class="article"><a href="/a1">First Title</a><p>First excerpt text.</p></div>
  <div class="article"><a href="/a2">Second Title</a><p>Second excerpt text.</p></div>
</body></html>`;

export const ONE_ARTICLE_HTML = `<html><body>
  <div class="article"><a href="/a1">First Title</a><p>First excerpt text.</p></div>
</body></html>`;

export const CUSTOM_SOURCE_LIST_PIPELINE = {
  pipeline_version: "custom_source.pipeline.v1",
  steps: [
    { type: "fetch_page", url: "$source.endpoint_url", bind: "list_page" },
    { type: "extract_list", input: "list_page", selector: { css_class: "article" }, bind: "items" },
  ],
  output: { items_var: "items" },
};
