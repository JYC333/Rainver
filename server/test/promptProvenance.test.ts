import { describe, expect, it } from "vitest";
import { promptProvenanceOf, withPromptProvenance } from "../src/modules/prompts/provenance.js";
import type { PromptResolveResult } from "@rainver/protocol";

function resolveResult(overrides: Partial<PromptResolveResult> = {}): PromptResolveResult {
  return {
    asset_key: "runtime.context.checkpoint",
    version_id: "version-1",
    content_hash: "hash-1",
    scope_type: "system",
    scope_id: null,
    resolution_trace: ["system_baseline:version-1"],
    fallback_reason: null,
    rendered_messages: [{ role: "system", content: "rendered system text" }],
    rendered_text: null,
    rendered_hash: "rendered-hash",
    validation_warnings: [],
    validation_errors: [],
    ...overrides,
  };
}

describe("promptProvenanceOf", () => {
  it("keeps references and hashes but drops rendered content", () => {
    const provenance = promptProvenanceOf(resolveResult());
    expect(provenance).toEqual({
      asset_key: "runtime.context.checkpoint",
      version_id: "version-1",
      content_hash: "hash-1",
      scope_type: "system",
      scope_id: null,
      resolution_trace: ["system_baseline:version-1"],
    });
    expect(provenance).not.toHaveProperty("rendered_messages");
    expect(provenance).not.toHaveProperty("rendered_text");
  });
});

describe("withPromptProvenance", () => {
  it("nests provenance under metadata.prompts[key] and preserves other metadata", () => {
    const metadata = withPromptProvenance({ existing: "value" }, "checkpoint_extract", resolveResult());
    expect(metadata).toEqual({
      existing: "value",
      prompts: {
        checkpoint_extract: {
          asset_key: "runtime.context.checkpoint",
          version_id: "version-1",
          content_hash: "hash-1",
          scope_type: "system",
          scope_id: null,
          resolution_trace: ["system_baseline:version-1"],
        },
      },
    });
  });

  it("preserves previously recorded prompt provenance under other keys", () => {
    const withFirst = withPromptProvenance({}, "checkpoint_extract", resolveResult());
    const withSecond = withPromptProvenance(
      withFirst,
      "query_rewrite",
      resolveResult({ asset_key: "retrieval.query_rewrite", version_id: "version-2" }),
    );
    expect(Object.keys(withSecond.prompts as Record<string, unknown>)).toEqual(["checkpoint_extract", "query_rewrite"]);
  });
});
