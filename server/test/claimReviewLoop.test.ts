import { describe, expect, it } from "vitest";
import {
  buildClaimTrajectory,
  scanClaimContradictions,
  type ClaimContradictionLlmJudge,
} from "../src/modules/knowledge/claimReviewLoop";
import type { ClaimRow } from "../src/modules/knowledge/knowledgeRepositoryRows";
import type { QueryResult, Queryable } from "../src/modules/routeUtils/common";

function claimRow(overrides: Partial<ClaimRow> = {}): ClaimRow {
  return {
    id: "claim-1",
    space_id: "space-1",
    subject_object_id: "subject-1",
    subject_text: null,
    claim_kind: "fact",
    claim_text: "The deploy pipeline runs nightly.",
    normalized_claim_hash: "hash",
    holder_object_id: null,
    holder_type: null,
    holder_id: null,
    confidence: 0.5,
    confidence_method: "human_confirmed",
    resolution_state: "unreviewed",
    valid_from: null,
    valid_until: null,
    observed_at: null,
    metadata_json: {},
    status: "active",
    visibility: "space_shared",
    title: "Deploy pipeline",
    excerpt: null,
    owner_user_id: "user-1",
    primary_project_id: null,
    project_folder_id: null,
    created_by_user_id: "user-1",
    created_by_agent_id: null,
    created_by_run_id: null,
    created_from_proposal_id: null,
    approved_by_user_id: null,
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    archived_at: null,
    ...overrides,
  };
}

class FakeClaimDb implements Queryable {
  readonly calls: Array<{ sql: string; params: readonly unknown[] }> = [];
  constructor(
    private readonly opts: {
      seed?: ClaimRow | null;
      subjectClaims?: ClaimRow[];
      activeClaims?: ClaimRow[];
      holderObjects?: Array<{ id: string; title: string | null }>;
    },
  ) {}

  async query<Row = Record<string, unknown>>(
    sql: string,
    params: readonly unknown[] = [],
  ): Promise<QueryResult<Row>> {
    this.calls.push({ sql, params });
    if (/FROM space_objects so/.test(sql) && /so\.id = ANY\(\$3::varchar\[\]\)/.test(sql)) {
      const ids = Array.isArray(params[2]) ? params[2] : [];
      const rows = (this.opts.holderObjects ?? []).filter((row) => ids.includes(row.id));
      return { rows: rows as Row[], rowCount: rows.length };
    }
    if (/c\.object_id = \$3/.test(sql) && /LIMIT 1/.test(sql)) {
      const seed = this.opts.seed ? [this.opts.seed] : [];
      return { rows: seed as Row[], rowCount: seed.length };
    }
    if (/c\.subject_object_id = \$3/.test(sql)) {
      const rows = this.opts.subjectClaims ?? [];
      return { rows: rows as Row[], rowCount: rows.length };
    }
    if (/c\.status = 'active'/.test(sql)) {
      const rows = this.opts.activeClaims ?? [];
      return { rows: rows as Row[], rowCount: rows.length };
    }
    return { rows: [] as Row[], rowCount: 0 };
  }
}

describe("buildClaimTrajectory", () => {
  it("orders points by time and emits supersession + confidence signals", async () => {
    const subjectClaims = [
      claimRow({ id: "c1", status: "superseded", confidence: 0.4, created_at: "2026-01-01T00:00:00.000Z", valid_from: "2026-01-01T00:00:00.000Z" }),
      claimRow({ id: "c2", status: "active", confidence: 0.9, created_at: "2026-02-01T00:00:00.000Z", valid_from: "2026-02-01T00:00:00.000Z" }),
    ];
    const db = new FakeClaimDb({ subjectClaims });
    const result = await buildClaimTrajectory(db, {
      spaceId: "space-1",
      userId: "user-1",
      subjectObjectId: "subject-1",
      limit: 100,
    });

    expect(result.canonical_write_performed).toBe(false);
    expect(result.access_safety.advisory_only).toBe(true);
    expect(result.points.map((p) => p.claim_id)).toEqual(["c1", "c2"]);
    const kinds = result.signals.map((s) => s.kind);
    expect(kinds).toContain("supersession");
    expect(kinds).toContain("confidence_shift");
  });

  it("resolves the subject from a seed claim when only claim_id is given", async () => {
    const seed = claimRow({ id: "seed", subject_object_id: "subject-9" });
    const subjectClaims = [seed, claimRow({ id: "c2", subject_object_id: "subject-9", claim_kind: "belief" })];
    const db = new FakeClaimDb({ seed, subjectClaims });
    const result = await buildClaimTrajectory(db, {
      spaceId: "space-1",
      userId: "user-1",
      claimId: "seed",
      limit: 100,
    });
    expect(result.subject_object_id).toBe("subject-9");
    expect(result.points).toHaveLength(2);
    expect(result.signals.map((s) => s.kind)).toContain("kind_divergence");
  });

  it("resolves visible holder object labels for trajectory points", async () => {
    const subjectClaims = [
      claimRow({
        id: "c1",
        holder_object_id: "holder-1",
        holder_type: "person",
      }),
    ];
    const db = new FakeClaimDb({
      subjectClaims,
      holderObjects: [{ id: "holder-1", title: "Ada Lovelace" }],
    });
    const result = await buildClaimTrajectory(db, {
      spaceId: "space-1",
      userId: "user-1",
      subjectObjectId: "subject-1",
      limit: 100,
    });

    expect(result.points[0]!.holder_label).toBe("Ada Lovelace");
  });
});

describe("scanClaimContradictions", () => {
  it("flags a negation contradiction with a contradicts proposed_action", async () => {
    const activeClaims = [
      claimRow({ id: "a", claim_text: "The backup job runs every night." }),
      claimRow({ id: "b", claim_text: "The backup job does not run every night." }),
    ];
    const db = new FakeClaimDb({ activeClaims });
    const report = await scanClaimContradictions(db, {
      spaceId: "space-1",
      userId: "user-1",
      limit: 200,
      maxFindings: 40,
    });

    expect(report.access_safety.only_visible_claims).toBe(true);
    expect(report.findings).toHaveLength(1);
    const finding = report.findings[0]!;
    expect(finding.signal).toBe("negation");
    expect(finding.proposed_action).toMatchObject({
      proposal_type: "object_relation_create",
      link_type: "contradicts",
      from_object_id: "a",
      to_object_id: "b",
    });
  });

  it("flags numeric opposition and does not pair claims about different subjects", async () => {
    const activeClaims = [
      claimRow({ id: "a", subject_object_id: "s1", claim_text: "The cluster has 3 nodes." }),
      claimRow({ id: "b", subject_object_id: "s1", claim_text: "The cluster has 5 nodes." }),
      claimRow({ id: "c", subject_object_id: "s2", claim_text: "The cluster has 9 nodes." }),
    ];
    const db = new FakeClaimDb({ activeClaims });
    const report = await scanClaimContradictions(db, {
      spaceId: "space-1",
      userId: "user-1",
      limit: 200,
      maxFindings: 40,
    });
    expect(report.findings).toHaveLength(1);
    expect(report.findings[0]!.signal).toBe("numeric_opposition");
    expect(report.findings[0]!.from_claim.claim_id).toBe("a");
    expect(report.findings[0]!.to_claim.claim_id).toBe("b");
  });

  it("returns no findings when claims agree", async () => {
    const activeClaims = [
      claimRow({ id: "a", claim_text: "The backup job runs every night." }),
      claimRow({ id: "b", claim_text: "The backup job runs every night reliably." }),
    ];
    const db = new FakeClaimDb({ activeClaims });
    const report = await scanClaimContradictions(db, {
      spaceId: "space-1",
      userId: "user-1",
      limit: 200,
      maxFindings: 40,
    });
    expect(report.findings).toHaveLength(0);
  });

  it("runs an injected LLM judge only when explicitly requested", async () => {
    const activeClaims = [
      claimRow({ id: "a", claim_text: "The launch banner is blue." }),
      claimRow({ id: "b", claim_text: "The launch banner is red." }),
    ];
    const judge: ClaimContradictionLlmJudge = {
      async judge(input) {
        expect(input.claims.map((claim) => claim.claim_id)).toEqual(["a", "b"]);
        expect(input.deterministicFindings).toHaveLength(0);
        return [
          {
            cluster_key: "obj:subject-1",
            signal: "llm_supported",
            confidence_tier: "low",
            from_claim: { claim_id: "a", title: "Deploy pipeline" },
            to_claim: { claim_id: "b", title: "Deploy pipeline" },
            reason: "Injected judge identified a semantic contradiction.",
            proposed_action: {
              proposal_type: "object_relation_create",
              from_object_id: "a",
              to_object_id: "b",
              link_type: "contradicts",
              confidence: 0.3,
            },
          },
        ];
      },
    };
    const db = new FakeClaimDb({ activeClaims });
    const report = await scanClaimContradictions(db, {
      spaceId: "space-1",
      userId: "user-1",
      limit: 200,
      maxFindings: 40,
      llmJudgeEnabled: true,
      llmJudge: judge,
    });

    expect(report.access_safety).toMatchObject({
      source_policy_enforced: true,
      llm_judge_requested: true,
      llm_judge_used: true,
    });
    expect(report.llm_judge).toMatchObject({ requested: true, used: true, finding_count: 1 });
    expect(report.findings[0]!.signal).toBe("llm_supported");
  });
});
