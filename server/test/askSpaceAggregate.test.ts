import { describe, expect, it } from "vitest";
import type {
  AskSpaceDomainSection,
  RetrievalBrief,
} from "@rainver/protocol";
import {
  aggregateGaps,
  buildFollowUps,
  collectProvenance,
  dedupeDomains,
  PROVENANCE_CAP,
} from "../src/modules/askSpace/aggregate.js";
import { AskSpaceResponseSchema } from "@rainver/protocol";

function brief(partial: Partial<RetrievalBrief> & { gap?: Partial<RetrievalBrief["gap_analysis"]> }): RetrievalBrief {
  return {
    answer: partial.answer ?? null,
    synthesized: partial.synthesized ?? false,
    citations: partial.citations ?? [],
    gap_analysis: {
      stale: partial.gap?.stale ?? [],
      thin: partial.gap?.thin ?? [],
      low_coverage: partial.gap?.low_coverage ?? false,
      uncited_claims: partial.gap?.uncited_claims ?? [],
      contradictions: partial.gap?.contradictions ?? [],
      missing_topics: partial.gap?.missing_topics ?? [],
    },
  };
}

function section(over: Partial<AskSpaceDomainSection> & Pick<AskSpaceDomainSection, "domain">): AskSpaceDomainSection {
  return {
    domain: over.domain,
    object_types: over.object_types ?? [],
    brief: over.brief ?? null,
    items: over.items ?? [],
    total: over.total ?? 0,
    ...(over.artifact_id ? { artifact_id: over.artifact_id } : {}),
    ...(over.error_code ? { error_code: over.error_code } : {}),
  };
}

describe("askSpace aggregate", () => {
  it("dedupes domains and falls back to the default when empty", () => {
    expect(dedupeDomains(["knowledge", "memory", "knowledge"])).toEqual(["knowledge", "memory"]);
    expect(dedupeDomains([])).toEqual(["knowledge"]);
  });

  it("sums gap signals across domains and records low-coverage domains only", () => {
    const sections = [
      section({
        domain: "knowledge",
        brief: brief({
          gap: { stale: [{ object_type: "knowledge_item", object_id: "k1", title: "K1", reason: "old" }], uncited_claims: ["x"], low_coverage: true },
        }),
      }),
      section({
        domain: "memory",
        brief: brief({ gap: { thin: [{ object_type: "memory_entry", object_id: "m1", title: "M1", reason: "thin" }], contradictions: ["c"] } }),
      }),
      // A failed domain contributes nothing and must not throw.
      section({ domain: "project", brief: null, error_code: "domain_failed" }),
    ];
    const summary = aggregateGaps(sections);
    expect(summary).toMatchObject({
      stale_count: 1,
      thin_count: 1,
      uncited_claim_count: 1,
      contradiction_count: 1,
      missing_topic_count: 0,
      low_coverage_domains: ["knowledge"],
    });
  });

  it("collects deduped, domain-tagged provenance and caps the total", () => {
    const manyCitations = Array.from({ length: PROVENANCE_CAP + 10 }, (_, i) => ({
      object_type: "knowledge_item" as const,
      object_id: `k${i}`,
      title: `K${i}`,
      source_index: i,
    }));
    const sections = [
      section({
        domain: "knowledge",
        brief: brief({
          citations: [
            { object_type: "knowledge_item", object_id: "k1", title: "K1", source_index: 1 },
            { object_type: "knowledge_item", object_id: "k1", title: "K1", source_index: 1 },
            ...manyCitations,
          ],
        }),
      }),
    ];
    const provenance = collectProvenance(sections);
    expect(provenance.length).toBe(PROVENANCE_CAP);
    expect(provenance[0]).toEqual({ domain: "knowledge", object_type: "knowledge_item", object_id: "k1", title: "K1" });
    // The duplicate k1 is collapsed: k1 appears exactly once.
    expect(provenance.filter((p) => p.object_id === "k1")).toHaveLength(1);
  });

  it("offers a claim packet only when briefs were persisted, and a scan only on stale/thin gaps", () => {
    const gapWithStale = aggregateGaps([
      section({ domain: "knowledge", brief: brief({ gap: { stale: [{ object_type: "knowledge_item", object_id: "k1", title: "K1", reason: "old" }] } }) }),
    ]);
    const withArtifacts = buildFollowUps(["art-1", "art-2"], gapWithStale, true);
    expect(withArtifacts.map((f) => f.kind)).toEqual(["claim_candidate_packet", "maintenance_scan"]);
    expect(withArtifacts[0].source_artifact_ids).toEqual(["art-1", "art-2"]);

    const noArtifactsNoGaps = buildFollowUps([], aggregateGaps([]), true);
    expect(noArtifactsNoGaps).toEqual([]);
  });

  it("suppresses all follow-ups when the viewer lacks Context Ops scan authority", () => {
    const gapWithStale = aggregateGaps([
      section({ domain: "knowledge", brief: brief({ gap: { stale: [{ object_type: "knowledge_item", object_id: "k1", title: "K1", reason: "old" }] } }) }),
    ]);
    expect(buildFollowUps(["art-1"], gapWithStale, false)).toEqual([]);
  });

  it("caps claim-packet source artifact ids at the route maximum", () => {
    const ids = Array.from({ length: 20 }, (_, i) => `art-${i}`);
    const followUps = buildFollowUps(ids, aggregateGaps([]), true);
    expect(followUps[0].kind).toBe("claim_candidate_packet");
    expect(followUps[0].source_artifact_ids).toHaveLength(12);
  });
});

describe("AskSpaceResponseSchema", () => {
  it("accepts a well-formed read-only response and rejects a canonical-write claim", async () => {
    const base = {
      generated_at: "2026-06-26T00:00:00.000Z",
      space_id: "11111111-1111-4111-8111-111111111111",
      query: "what did we decide",
      requested_domains: ["knowledge"],
      domains: [],
      synthesized: false,
      gap_summary: {
        stale_count: 0,
        thin_count: 0,
        low_coverage_domains: [],
        uncited_claim_count: 0,
        contradiction_count: 0,
        missing_topic_count: 0,
      },
      provenance: [],
      follow_ups: [],
      canonical_write_performed: false,
    };
    expect(AskSpaceResponseSchema.safeParse(base).success).toBe(true);
    expect(AskSpaceResponseSchema.safeParse({ ...base, canonical_write_performed: true }).success).toBe(false);
  });
});
