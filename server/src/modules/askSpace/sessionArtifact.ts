import type {
  AskSpaceDomain,
  AskSpaceGapSummary,
  AskSpaceProvenanceItem,
} from "@rainver/protocol";
import type { Queryable } from "../routeUtils/common.js";
import { insertArtifactRow } from "../artifacts/reviewArtifactWriter.js";

export const ASK_SPACE_SESSION_ARTIFACT_TYPE = "ask_space_session";

export interface AskSpaceSessionArtifactContext {
  spaceId: string;
  ownerUserId: string;
  query: string;
  requestedDomains: AskSpaceDomain[];
  /** Per-domain persisted brief artifact ids (only the domains that persisted). */
  briefArtifactRefs: Array<{ domain: AskSpaceDomain; artifact_id: string }>;
  gapSummary: AskSpaceGapSummary;
  provenance: AskSpaceProvenanceItem[];
  synthesized: boolean;
  combinedAnswer?: string | null;
}

/**
 * Persist an owner-private `ask_space_session` artifact that links the per-domain
 * brief artifacts the Think answer was built from. It is a durable, ref-only
 * record (no raw snippets/content beyond the already-private brief refs) so the
 * session can later seed a Claim Candidate Packet. Owner-private because the
 * answer can derive from the viewer's private/restricted readable scope.
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
    gap_summary: input.gapSummary,
    provenance: input.provenance,
    synthesized: input.synthesized,
    combined_answer: input.combinedAnswer ?? null,
    space_id: input.spaceId,
    owner_user_id: ownerUserId,
  };
  return insertArtifactRow(db, {
    spaceId: input.spaceId,
    ownerUserId,
    artifactType: ASK_SPACE_SESSION_ARTIFACT_TYPE,
    title: titleForSession(input.query),
    content: JSON.stringify(payload, null, 2),
    metadata: payload,
    canonicalFormat: "ask_space_session.v1",
    visibility: "private",
  });
}

function titleForSession(query: string): string {
  const trimmed = query.trim().replace(/\s+/g, " ");
  const short = trimmed.length > 120 ? `${trimmed.slice(0, 117)}...` : trimmed;
  return short ? `Ask Space: ${short}` : "Ask Space";
}
