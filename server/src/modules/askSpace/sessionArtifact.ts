import type {
  AskSpaceDomain,
  AskSpaceGapSummary,
  AskSpaceProvenanceItem,
} from "@rainver/protocol";
import type { Queryable } from "../routeUtils/common.js";
import { insertArtifactRow } from "../artifacts/reviewArtifactWriter.js";
import { settleRetrievalArtifact } from "../retrieval/artifactRelease.js";

const ASK_SPACE_SESSION_ARTIFACT_TYPE = "ask_space_session";

interface AskSpaceSessionArtifactContext {
  spaceId: string;
  ownerUserId: string;
  query: string;
  requestedDomains: AskSpaceDomain[];
  /** Per-domain persisted brief artifact ids (only the domains that persisted). */
  briefArtifactRefs: Array<{ domain: AskSpaceDomain; artifact_id: string }>;
  /**
   * Every answering domain's complete contributing refs (items, citations,
   * gap refs), including a domain whose own Brief failed to save: the combined
   * answer, gap summary and provenance all derive from them.
   */
  contributions: Array<{ domain: AskSpaceDomain; refs: Array<{ object_type: string; object_id: string }> | null }>;
  gapSummary: AskSpaceGapSummary;
  provenance: AskSpaceProvenanceItem[];
  synthesized: boolean;
  combinedAnswer?: string | null;
}

/**
 * Persist an owner-private `ask_space_session` artifact that links the per-domain
 * brief artifacts the Think answer was built from, with the derived combined
 * answer, gap summary and provenance. Owner-private because the
 * answer can derive from the viewer's private/restricted readable scope.
 *
 * Settles after the combined synthesis in one short transaction: the owner's
 * current release closure over every recorded contribution (and nested Brief)
 * is rechecked before the INSERT; withdrawn authority throws
 * `RetrievalArtifactWithheld` and writes nothing. Reads re-run the same
 * closure (`retrievalArtifactWithheld`).
 */
export async function persistAskSpaceSessionArtifact(
  db: Queryable,
  input: AskSpaceSessionArtifactContext,
): Promise<string> {
  const ownerUserId = input.ownerUserId.trim();
  if (!ownerUserId) {
    throw new Error("ask_space_session artifacts require owner_user_id");
  }
  const payload = {
    kind: ASK_SPACE_SESSION_ARTIFACT_TYPE,
    visibility: "private",
    query: input.query,
    requested_domains: input.requestedDomains,
    brief_artifact_refs: input.briefArtifactRefs,
    contributions: input.contributions,
    gap_summary: input.gapSummary,
    provenance: input.provenance,
    synthesized: input.synthesized,
    combined_answer: input.combinedAnswer ?? null,
    space_id: input.spaceId,
    owner_user_id: ownerUserId,
  };
  return settleRetrievalArtifact(db, { spaceId: input.spaceId, userId: ownerUserId }, { artifact_type: ASK_SPACE_SESSION_ARTIFACT_TYPE, metadata_json: payload }, (tx) => insertArtifactRow(tx, {
    spaceId: input.spaceId,
    ownerUserId,
    artifactType: ASK_SPACE_SESSION_ARTIFACT_TYPE,
    title: titleForSession(input.query),
    content: JSON.stringify(payload, null, 2),
    metadata: payload,
    canonicalFormat: "ask_space_session.v1",
    visibility: "private",
  }));
}

function titleForSession(query: string): string {
  const trimmed = query.trim().replace(/\s+/g, " ");
  const short = trimmed.length > 120 ? `${trimmed.slice(0, 117)}...` : trimmed;
  return short ? `Ask Space: ${short}` : "Ask Space";
}
