import type { ProposalTitleParts } from "@rainver/protocol";

/**
 * Structured title facts for proposal types whose title the web words per
 * locale. The stored English title remains the text for every other reader
 * and for proposals created before these facts were recorded.
 */
export function proposalTitleParts(
  proposalType: string,
  payload: Record<string, unknown>,
): ProposalTitleParts | null {
  if (proposalType !== "evolvable_asset_version_promote") return null;
  const { asset_key: assetKey, candidate_version: version, target_scope_type: scopeType, target_scope_id: scopeId } = payload;
  if (typeof assetKey !== "string" || typeof scopeType !== "string" || typeof version !== "number" || !Number.isInteger(version)) {
    return null;
  }
  return {
    kind: "asset_version_promote",
    asset_key: assetKey,
    version,
    target_scope_type: scopeType,
    target_scope_id: typeof scopeId === "string" ? scopeId : null,
  };
}

/** Selects only the payload fields `proposalTitleParts` reads, as `title_payload`. */
export function proposalTitlePayloadSql(alias: string): string {
  return `jsonb_build_object(
    'asset_key', ${alias}.payload_json->'asset_key',
    'candidate_version', ${alias}.payload_json->'candidate_version',
    'target_scope_type', ${alias}.payload_json->'target_scope_type',
    'target_scope_id', ${alias}.payload_json->'target_scope_id'
  ) AS title_payload`;
}
