import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type {
  AskSpaceDomain,
  RetrievalBriefResponse,
} from "@agent-space/protocol";
import type { ServerConfig } from "../src/config.js";
import { AskSpaceService } from "../src/modules/askSpace/service.js";
import { __setProviderCommandStoreForTests } from "../src/modules/providers/commands/store.js";
import type { BriefCandidate } from "../src/modules/retrieval/index.js";

const CONFIG = { databaseUrl: "postgres://test", agentSpaceHome: "/tmp" } as unknown as ServerConfig;

beforeAll(() => {
  // The injected runDomainBrief never touches the store, but think() resolves one
  // while building ctx; hand it a dummy so no real pool is created.
  __setProviderCommandStoreForTests({} as never);
});
afterAll(() => {
  __setProviderCommandStoreForTests(null);
});

/** Captures writes; returns defaults for settings (no row ⇒ DEFAULT settings). */
class FakeDb {
  queries: Array<{ sql: string; params: readonly unknown[] }> = [];
  async query<Row = Record<string, unknown>>(
    sql: string,
    params: readonly unknown[] = [],
  ): Promise<{ rows: Row[]; rowCount: number | null }> {
    this.queries.push({ sql, params });
    if (/FROM source_connections/.test(sql)) {
      const ids = Array.isArray(params[1]) ? params[1] as string[] : [];
      const rows = ids.map((id) => ({
        id,
        owner_user_id: "user-1",
        consent_json: {
          schema_version: 1,
          owner_user_id: "user-1",
          allow_local_provider_egress: true,
          allow_external_model_egress: true,
        },
        policy_json: {
          schema_version: 1,
          source_egress_class: "external_provider_allowed",
        },
      }));
      return { rows: rows as Row[], rowCount: rows.length };
    }
    return { rows: [] as Row[], rowCount: 0 };
  }
  artifactInserts(): Array<{ sql: string; params: readonly unknown[] }> {
    return this.queries.filter((q) => /INSERT INTO artifacts/.test(q.sql));
  }
}

function cannedBrief(domain: AskSpaceDomain, opts: { stale?: boolean; itemId?: string; sourceId?: string } = {}): RetrievalBriefResponse {
  const itemId = opts.itemId ?? `${domain}-1`;
  return {
    brief: {
      answer: `answer for ${domain}`,
      synthesized: true,
      citations: [{ object_type: typeFor(domain), object_id: itemId, title: `Source ${itemId}` }],
      gap_analysis: {
        stale: opts.stale ? [{ object_type: typeFor(domain), object_id: itemId, title: `Source ${itemId}`, reason: "old" }] : [],
        thin: [],
        low_coverage: false,
        uncited_claims: [],
        contradictions: [],
        missing_topics: [],
      },
    },
    items: [
      {
        object_type: typeFor(domain),
        object_id: itemId,
        title: `Source ${itemId}`,
        snippet: null,
        score: 1,
        evidence: { kind: "lexical_match" },
        matched_fields: [],
        ...(opts.sourceId ? { source_refs: [{ source_connection_id: opts.sourceId }] } : {}),
      },
    ],
    total: 1,
  } as unknown as RetrievalBriefResponse;
}

function typeFor(domain: AskSpaceDomain) {
  if (domain === "memory") return "memory_entry";
  if (domain === "project") return "project_public_summary";
  if (domain === "source") return "source_item";
  if (domain === "inquiry") return "inquiry_thread";
  return "knowledge_item";
}

describe("AskSpaceService.think (orchestration)", () => {
  it("includes Inquiry as a first-class cross-domain retrieval section", async () => {
    const service = new AskSpaceService(new FakeDb(), CONFIG, {
      runDomainBrief: async ({ domain }) => cannedBrief(domain),
      canRunActions: async () => false,
    });

    const result = await service.think({
      spaceId: "space-1",
      userId: "user-1",
      query: "what hypotheses changed",
      domains: ["knowledge", "inquiry"],
    });

    expect(result.requested_domains).toEqual(["knowledge", "inquiry"]);
    expect(result.domains[1]).toMatchObject({
      domain: "inquiry",
      object_types: ["inquiry_thread"],
      total: 1,
    });
    expect(result.provenance[1]).toMatchObject({
      domain: "inquiry",
      object_type: "inquiry_thread",
    });
  });

  it("fans across domains, aggregates gaps/provenance, and gates follow-ups", async () => {
    const db = new FakeDb();
    const service = new AskSpaceService(db, CONFIG, {
      runDomainBrief: async ({ domain }) => cannedBrief(domain, { stale: domain === "knowledge" }),
      canRunActions: async () => true,
    });

    const result = await service.think({
      spaceId: "space-1",
      userId: "user-1",
      query: "what did we decide",
      domains: ["knowledge", "memory", "project"],
      persist: true,
    });

    // Domain order is canonical and all three answered.
    expect(result.domains.map((d) => d.domain)).toEqual(["knowledge", "memory", "project"]);
    expect(result.synthesized).toBe(true);
    expect(result.gap_summary.stale_count).toBe(1);
    expect(result.provenance).toHaveLength(3);
    expect(result.canonical_write_performed).toBe(false);

    // Persist wrote 3 brief artifacts + 1 session artifact.
    const inserts = db.artifactInserts();
    expect(inserts).toHaveLength(4);
    expect(inserts.filter((q) => q.params.includes("ask_space_session"))).toHaveLength(1);
    expect(result.session_artifact_id).toBeTruthy();
    expect(result.domains.every((d) => typeof d.artifact_id === "string")).toBe(true);

    // Follow-ups: a claim packet (artifacts persisted) + a maintenance scan (stale gap).
    expect(result.follow_ups.map((f) => f.kind).sort()).toEqual(["claim_candidate_packet", "maintenance_scan"]);
    expect(result.follow_ups.find((f) => f.kind === "claim_candidate_packet")?.source_artifact_ids).toHaveLength(3);
  });

  it("combines synthesized domain answers while excluding Memory from the combined prompt by default", async () => {
    const db = new FakeDb();
    const runCombinedSynthesis = vi.fn(async ({ candidates }) => ({
      answer: candidates.map((candidate: BriefCandidate) => candidate.title).join(" + "),
      citations: [],
      uncitedClaims: [],
      contradictions: [],
      missingTopics: [],
    }));
    const service = new AskSpaceService(db, CONFIG, {
      runDomainBrief: async ({ domain }) => cannedBrief(domain, { sourceId: `source-${domain}` }),
      runCombinedSynthesis,
      canRunActions: async () => true,
    });

    const result = await service.think({
      spaceId: "space-1",
      userId: "user-1",
      query: "q",
      domains: ["knowledge", "memory", "project"],
      combine: true,
    });

    expect(result.combined_answer).toBe("Knowledge answer + Project summaries answer");
    expect(runCombinedSynthesis).toHaveBeenCalledTimes(1);
    const args = runCombinedSynthesis.mock.calls[0]![0];
    expect(args.candidates.map((candidate: BriefCandidate) => candidate.title)).toEqual([
      "Knowledge answer",
      "Project summaries answer",
    ]);
    expect(args.egressPolicy.payloadSourceConnectionIds).toEqual(["source-knowledge", "source-project"]);
    expect(args.egressPolicy.sourcePolicies).toHaveProperty("source-knowledge");
    expect(args.egressPolicy.sourcePolicies).not.toHaveProperty("source-memory");
  });

  it("includes Memory in combined synthesis only when explicitly requested", async () => {
    const db = new FakeDb();
    const runCombinedSynthesis = vi.fn(async ({ candidates }) => ({
      answer: candidates.map((candidate: BriefCandidate) => candidate.title).join(" + "),
      citations: [],
      uncitedClaims: [],
      contradictions: [],
      missingTopics: [],
    }));
    const service = new AskSpaceService(db, CONFIG, {
      runDomainBrief: async ({ domain }) => cannedBrief(domain, { sourceId: `source-${domain}` }),
      runCombinedSynthesis,
      canRunActions: async () => true,
    });

    const result = await service.think({
      spaceId: "space-1",
      userId: "user-1",
      query: "q",
      domains: ["knowledge", "memory", "project"],
      combine: true,
      combineIncludeMemory: true,
    });

    expect(result.combined_answer).toBe("Knowledge answer + Memory answer + Project summaries answer");
    const args = runCombinedSynthesis.mock.calls[0]![0];
    expect(args.candidates.map((candidate: BriefCandidate) => candidate.title)).toEqual([
      "Knowledge answer",
      "Memory answer",
      "Project summaries answer",
    ]);
    expect(args.egressPolicy.payloadSourceConnectionIds).toEqual([
      "source-knowledge",
      "source-memory",
      "source-project",
    ]);
  });

  it("does not run combined synthesis when fewer than two eligible non-memory answers remain", async () => {
    const db = new FakeDb();
    const runCombinedSynthesis = vi.fn(async () => null);
    const service = new AskSpaceService(db, CONFIG, {
      runDomainBrief: async ({ domain }) => cannedBrief(domain),
      runCombinedSynthesis,
      canRunActions: async () => true,
    });

    const result = await service.think({
      spaceId: "space-1",
      userId: "user-1",
      query: "q",
      domains: ["knowledge", "memory"],
      combine: true,
    });

    expect(result.combined_answer).toBeNull();
    expect(runCombinedSynthesis).not.toHaveBeenCalled();
  });

  it("isolates a single failing domain without sinking the others", async () => {
    const db = new FakeDb();
    const service = new AskSpaceService(db, CONFIG, {
      runDomainBrief: async ({ domain }) => {
        if (domain === "project") throw new Error("adapter boom");
        return cannedBrief(domain);
      },
      canRunActions: async () => true,
    });

    const result = await service.think({
      spaceId: "space-1",
      userId: "user-1",
      query: "q",
      domains: ["knowledge", "project"],
    });

    const project = result.domains.find((d) => d.domain === "project");
    const knowledge = result.domains.find((d) => d.domain === "knowledge");
    expect(project).toMatchObject({ brief: null, error_code: "domain_failed", total: 0 });
    expect(knowledge?.brief?.answer).toBe("answer for knowledge");
  });

  it("suppresses follow-ups when the viewer lacks Context Ops scan authority", async () => {
    const db = new FakeDb();
    const service = new AskSpaceService(db, CONFIG, {
      runDomainBrief: async ({ domain }) => cannedBrief(domain, { stale: true }),
      canRunActions: async () => false,
    });

    const result = await service.think({
      spaceId: "space-1",
      userId: "user-1",
      query: "q",
      domains: ["knowledge"],
      persist: true,
    });

    expect(result.follow_ups).toEqual([]);
    // Persistence still happens; only the scan-gated actions are withheld.
    expect(result.session_artifact_id).toBeTruthy();
  });

  it("defaults to the knowledge domain", async () => {
    const db = new FakeDb();
    const service = new AskSpaceService(db, CONFIG, {
      runDomainBrief: async ({ domain }) => cannedBrief(domain),
      canRunActions: async () => true,
    });

    const result = await service.think({ spaceId: "space-1", userId: "user-1", query: "q" });

    expect(result.requested_domains).toEqual(["knowledge"]);
  });

  it("attaches advisory claim trajectory for cited claims only when opted in (Slice E)", async () => {
    const db = new FakeDb();
    const loadClaimTrajectory = vi.fn(async (claimId: string) => ({
      claim_id: claimId,
      subject_object_id: "subject-1",
      subject_text: null,
      signals: [
        { kind: "supersession" as const, from_claim_id: "old", to_claim_id: claimId, summary: "superseded", confidence_tier: "high" as const },
      ],
    }));
    const claimBrief = (): RetrievalBriefResponse => ({
      brief: {
        answer: "answer for knowledge",
        synthesized: true,
        citations: [{ object_type: "claim", object_id: "claim-7", title: "Claim 7" }],
        gap_analysis: { stale: [], thin: [], low_coverage: false, uncited_claims: [], contradictions: [], missing_topics: [] },
      },
      items: [
        {
          object_type: "claim",
          object_id: "claim-7",
          title: "Claim 7",
          snippet: null,
          score: 1,
          evidence: { kind: "lexical_match" },
          matched_fields: [],
        },
      ],
      total: 1,
    } as unknown as RetrievalBriefResponse);

    const service = new AskSpaceService(db, CONFIG, {
      runDomainBrief: async () => claimBrief(),
      canRunActions: async () => true,
      loadClaimTrajectory,
    });

    const withoutFlag = await service.think({ spaceId: "space-1", userId: "user-1", query: "q" });
    expect(withoutFlag.claim_trajectories).toEqual([]);
    expect(loadClaimTrajectory).not.toHaveBeenCalled();

    const withFlag = await service.think({
      spaceId: "space-1",
      userId: "user-1",
      query: "q",
      includeClaimTrajectory: true,
    });
    expect(loadClaimTrajectory).toHaveBeenCalledWith("claim-7", "space-1", "user-1");
    expect(withFlag.claim_trajectories).toHaveLength(1);
    expect(withFlag.claim_trajectories[0]?.signals[0]?.kind).toBe("supersession");
  });
});
