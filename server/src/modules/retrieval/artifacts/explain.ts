import { createHash } from "node:crypto";
import type { RetrievalExplainResponse } from "@agent-space/protocol";
import type { Queryable } from "../../routeUtils/common.js";
import { insertArtifactRow } from "../../artifacts/reviewArtifactWriter.js";

export const RETRIEVAL_EXPLAIN_REPORT_ARTIFACT_TYPE = "retrieval_explain_report";

export interface RetrievalExplainReportArtifactContext {
  spaceId: string;
  ownerUserId: string;
  query: string;
  mode?: string | null;
  maxResults: number;
  response: RetrievalExplainResponse;
  settingsSnapshot?: Record<string, unknown>;
}

export async function persistRetrievalExplainReportArtifact(
  db: Queryable,
  input: RetrievalExplainReportArtifactContext,
): Promise<string> {
  const ownerUserId = normalizedOwner(input.ownerUserId);
  const now = new Date().toISOString();
  const payload = explainReportPayload(input, ownerUserId, now);
  return insertArtifactRow(db, {
    spaceId: input.spaceId,
    ownerUserId,
    artifactType: RETRIEVAL_EXPLAIN_REPORT_ARTIFACT_TYPE,
    title: titleForReport(input.response),
    content: JSON.stringify(payload, null, 2),
    metadata: payload,
    canonicalFormat: "retrieval_explain_report.v1",
    visibility: "private",
    createdAt: now,
  });
}

function explainReportPayload(
  input: RetrievalExplainReportArtifactContext,
  ownerUserId: string,
  generatedAt: string,
): Record<string, unknown> {
  return {
    kind: RETRIEVAL_EXPLAIN_REPORT_ARTIFACT_TYPE,
    version: 1,
    visibility: "private",
    space_id: input.spaceId,
    owner_user_id: ownerUserId,
    generated_at: generatedAt,
    query_sha256: sha256(input.query),
    query_chars: input.query.length,
    mode: input.mode ?? null,
    max_results: input.maxResults,
    target: input.response.target,
    match: input.response.match,
    trace: input.response.trace,
    diagnostic_codes: input.response.diagnostic_codes,
    settings_snapshot: input.settingsSnapshot ?? {},
    access_safety: {
      target_revalidated: true,
      visible_target_title_included: true,
      aggregate_trace_only: true,
      content_included: false,
      snippets_included: false,
      dropped_candidate_ids_included: false,
      hidden_object_counts_included: false,
    },
    retention_policy: {
      class: "targeted_private_artifact",
      owner_scoped: true,
      raw_private_content_included: false,
    },
  };
}

function titleForReport(response: RetrievalExplainResponse): string {
  return `Retrieval Explain Report: ${response.target.object_type}`;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function normalizedOwner(ownerUserId: string): string {
  const owner = ownerUserId.trim();
  if (!owner) throw new Error("retrieval explain artifacts require owner_user_id");
  return owner;
}
