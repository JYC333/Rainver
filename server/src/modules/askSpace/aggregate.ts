import type {
  AskSpaceDomain,
  AskSpaceDomainSection,
  AskSpaceFollowUp,
  AskSpaceGapSummary,
  AskSpaceProvenanceItem,
} from "@rainver/protocol";

export const DEFAULT_DOMAINS: AskSpaceDomain[] = ["knowledge"];

/** Bound how many cited sources cross into the provenance list. */
export const PROVENANCE_CAP = 60;

export function dedupeDomains(domains: AskSpaceDomain[]): AskSpaceDomain[] {
  const seen = new Set<AskSpaceDomain>();
  const out: AskSpaceDomain[] = [];
  for (const domain of domains) {
    if (seen.has(domain)) continue;
    seen.add(domain);
    out.push(domain);
  }
  return out.length > 0 ? out : [...DEFAULT_DOMAINS];
}

/** Roll the per-domain deterministic + LLM gap signals into one count summary. */
export function aggregateGaps(sections: AskSpaceDomainSection[]): AskSpaceGapSummary {
  let stale = 0;
  let thin = 0;
  let uncited = 0;
  let contradictions = 0;
  let missing = 0;
  const lowCoverage: AskSpaceDomain[] = [];
  for (const section of sections) {
    const gap = section.brief?.gap_analysis;
    if (!gap) continue;
    stale += gap.stale.length;
    thin += gap.thin.length;
    uncited += gap.uncited_claims.length;
    contradictions += gap.contradictions.length;
    missing += gap.missing_topics.length;
    if (gap.low_coverage) lowCoverage.push(section.domain);
  }
  return {
    stale_count: stale,
    thin_count: thin,
    low_coverage_domains: lowCoverage,
    uncited_claim_count: uncited,
    contradiction_count: contradictions,
    missing_topic_count: missing,
  };
}

/** Collect deduped, domain-tagged citations (already viewer-visible) up to the cap. */
export function collectProvenance(sections: AskSpaceDomainSection[]): AskSpaceProvenanceItem[] {
  const out: AskSpaceProvenanceItem[] = [];
  const seen = new Set<string>();
  for (const section of sections) {
    for (const citation of section.brief?.citations ?? []) {
      const key = `${section.domain}:${citation.object_type}:${citation.object_id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        domain: section.domain,
        object_type: citation.object_type,
        object_id: citation.object_id,
        title: citation.title,
      });
      if (out.length >= PROVENANCE_CAP) return out;
    }
  }
  return out;
}

/** The Claim Candidate Packet route caps `source_artifact_ids` at 12. */
export const FOLLOW_UP_ARTIFACT_CAP = 12;

/**
 * Proposal-first next steps. Each reuses an existing route — Think never adds a
 * canonical write path. Both the Claim Candidate Packet and the maintenance scan
 * routes require Context Ops scan authority, so follow-ups are only offered when
 * `canRunActions` is true (otherwise the buttons would 403 for the viewer). A
 * Claim Candidate Packet needs persisted brief artifacts; a maintenance scan is
 * offered when stale/thin sources were cited.
 */
export function buildFollowUps(
  briefArtifactIds: string[],
  gap: AskSpaceGapSummary,
  canRunActions: boolean,
): AskSpaceFollowUp[] {
  if (!canRunActions) return [];
  const followUps: AskSpaceFollowUp[] = [];
  if (briefArtifactIds.length > 0) {
    followUps.push({
      kind: "claim_candidate_packet",
      label: "Create Claim Candidate Packet",
      reason: "Turn the saved briefs into reviewable claim/relation candidates.",
      source_artifact_ids: briefArtifactIds.slice(0, FOLLOW_UP_ARTIFACT_CAP),
    });
  }
  if (gap.stale_count + gap.thin_count > 0) {
    followUps.push({
      kind: "maintenance_scan",
      label: "Run maintenance scan",
      reason: "Stale or thin sources were cited; a scan can batch review candidates.",
      source_artifact_ids: [],
    });
  }
  return followUps;
}
