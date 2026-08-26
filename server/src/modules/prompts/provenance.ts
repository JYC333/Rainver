import type { PromptResolveResult } from "@rainver/protocol";

/**
 * The provenance shape runtime records (e.g. run_steps.metadata_json) should
 * store by default: references and hashes only. Deliberately excludes
 * rendered_messages/rendered_text — the plan requires raw rendered prompt
 * text to stay out of low-level logs; a full snapshot, if ever needed, is a
 * separately access-controlled artifact, not run metadata.
 */
export interface PromptProvenance {
  asset_key: string;
  version_id: string;
  content_hash: string | null;
  scope_type: string | null;
  scope_id: string | null;
  resolution_trace: string[];
}

export function promptProvenanceOf(result: PromptResolveResult): PromptProvenance {
  return {
    asset_key: result.asset_key,
    version_id: result.version_id,
    content_hash: result.content_hash,
    scope_type: result.scope_type,
    scope_id: result.scope_id,
    resolution_trace: result.resolution_trace,
  };
}

/**
 * Merges prompt provenance into an existing metadata_json object under
 * metadata.prompts[key], preserving any other metadata already present.
 * `key` distinguishes multiple prompts resolved within the same run/step
 * (e.g. "checkpoint_extract", "query_rewrite").
 */
export function withPromptProvenance(
  metadata: Record<string, unknown>,
  key: string,
  result: PromptResolveResult,
): Record<string, unknown> {
  const existingPrompts = isRecord(metadata.prompts) ? metadata.prompts : {};
  return {
    ...metadata,
    prompts: { ...existingPrompts, [key]: promptProvenanceOf(result) },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
