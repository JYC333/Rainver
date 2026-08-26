import type {
  RetrievalBriefResponse,
  RetrievalObjectType,
  RetrievalSearchMode,
} from "@agent-space/protocol";
import type { Queryable } from "../../routeUtils/common.js";
import { insertArtifactRow } from "../../artifacts/reviewArtifactWriter.js";

export const RETRIEVAL_BRIEF_ARTIFACT_TYPE = "retrieval_brief";

export interface RetrievalBriefArtifactContext {
  spaceId: string;
  ownerUserId: string;
  runId?: string | null;
  projectId?: string | null;
  query: string;
  objectTypes?: RetrievalObjectType[];
  objectProfiles?: string[];
  maxResults: number;
  mode: RetrievalSearchMode;
  includeTrace: boolean;
  surface: string;
  response: RetrievalBriefResponse;
  persistTrace?: boolean;
  egressPolicySnapshot: {
    external_egress_enabled: boolean;
  };
  settingsSnapshot?: Record<string, unknown>;
}

export interface RetrievalBriefArtifactSpec {
  artifact_type: typeof RETRIEVAL_BRIEF_ARTIFACT_TYPE;
  visibility: "private";
  title: string;
  content: string;
  mime_type: string;
  metadata_json: Record<string, unknown>;
}

export function buildRetrievalBriefArtifactSpec(
  input: RetrievalBriefArtifactContext,
): RetrievalBriefArtifactSpec {
  const ownerUserId = input.ownerUserId.trim();
  if (!ownerUserId) {
    throw new Error("retrieval_brief artifacts require owner_user_id");
  }
  const payload = {
    kind: RETRIEVAL_BRIEF_ARTIFACT_TYPE,
    visibility: "private",
    query: input.query,
    object_types: input.objectTypes ?? null,
    object_profiles: input.objectProfiles ?? null,
    max_results: input.maxResults,
    mode: input.mode,
    include_trace: input.includeTrace,
    space_id: input.spaceId,
    owner_user_id: ownerUserId,
    run_id: input.runId ?? null,
    project_id: input.projectId ?? null,
    surface: input.surface,
    answer: input.response.brief.answer,
    synthesized: input.response.brief.synthesized,
    citations: input.response.brief.citations,
    gap_analysis: input.response.brief.gap_analysis,
    item_refs: input.response.items.map((item) => ({
      object_type: item.object_type,
      object_id: item.object_id,
      object_profile: item.object_profile ?? null,
      object_profile_label: item.object_profile_label ?? null,
      title: item.title,
      score: item.score,
      matched_fields: item.matched_fields,
      source_refs: item.source_refs ?? [],
    })),
    // Aggregate the distinct source connection ids the answer derived from, so a
    // non-creator attaching this artifact later can be re-gated against the
    // current source read policy (G3). Empty for non-source-derived briefs.
    source_connection_ids: sourceConnectionIdsFromItems(input.response.items),
    source_count: input.response.items.length,
    total: input.response.total,
    egress_policy_snapshot: input.egressPolicySnapshot,
    settings_snapshot: input.settingsSnapshot ?? {},
    trace: input.persistTrace === false ? null : input.response.trace ?? null,
  };

  return {
    artifact_type: RETRIEVAL_BRIEF_ARTIFACT_TYPE,
    visibility: "private",
    title: titleForBrief(input.query),
    content: JSON.stringify(payload, null, 2),
    mime_type: "application/json; charset=utf-8",
    metadata_json: payload,
  };
}

export async function persistRetrievalBriefArtifact(
  db: Queryable,
  input: RetrievalBriefArtifactContext,
): Promise<string> {
  const ownerUserId = input.ownerUserId.trim();
  const spec = buildRetrievalBriefArtifactSpec(input);
  return insertArtifactRow(db, {
    spaceId: input.spaceId,
    ownerUserId,
    artifactType: spec.artifact_type,
    title: spec.title,
    content: spec.content,
    metadata: spec.metadata_json,
    canonicalFormat: "retrieval_brief.v1",
    visibility: spec.visibility,
    mimeType: spec.mime_type,
    runId: input.runId ?? null,
    projectId: input.projectId ?? null,
  });
}

function sourceConnectionIdsFromItems(items: RetrievalBriefResponse["items"]): string[] {
  const ids = new Set<string>();
  for (const item of items) {
    for (const ref of item.source_refs ?? []) {
      const id = (ref as { source_connection_id?: unknown }).source_connection_id;
      if (typeof id === "string" && id.trim()) ids.add(id.trim());
    }
  }
  return [...ids];
}

function titleForBrief(query: string): string {
  const trimmed = query.trim().replace(/\s+/g, " ");
  const short = trimmed.length > 120 ? `${trimmed.slice(0, 117)}...` : trimmed;
  return short ? `Context Brief: ${short}` : "Context Brief";
}
