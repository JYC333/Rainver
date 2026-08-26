import { describe, expect, it } from "vitest";
import {
  runRelationDiscoveryScan,
  type RelationDiscoveryLlmExtractor,
} from "../src/modules/knowledge/relationDiscovery.js";
import {
  RELATION_DISCOVERY_PACKET_PROPOSAL_TYPE,
  registerRelationDiscoveryProposalAppliers,
} from "../src/modules/knowledge/relationDiscoveryArtifacts.js";
import { ProposalApplierRegistry } from "../src/modules/proposals/applierRegistry.js";
import type { QueryResult, Queryable } from "../src/modules/routeUtils/common.js";

interface ItemRow {
  id: string;
  title: string;
  slug: string | null;
  aliases_json: unknown;
  object_profile_id: string | null;
  object_profile: string | null;
  object_profile_label: string | null;
  content: string | null;
  plain_text: string | null;
  visibility: string;
  status: string;
}

interface NoteRow {
  id: string
  title: string
  plain_text: string | null
  status: string
  object_profile_id?: string | null
  object_profile?: string | null
  object_profile_label?: string | null
}

interface ActivityRow {
  id: string
  title: string | null
  content: string | null
  visibility: string
  owner_user_id: string | null
  user_id: string | null
  subject_user_id: string | null
}

interface ArtifactRow {
  id: string
  title: string
  content: string | null
  visibility: string
  owner_user_id: string | null
  metadata_json: unknown
}

interface HintRow {
  id: string
  object_profile_id: string
  object_profile: string
  object_profile_label: string
  endpoint_object_type: string
  endpoint_object_profile_id: string | null
  endpoint_object_profile: string | null
  endpoint_object_profile_label: string | null
  link_type: string
  direction: string
  confidence_default: number
  required: boolean
}

class FakeDiscoveryDb implements Queryable {
  constructor(
    private readonly items: ItemRow[],
    private readonly notes: NoteRow[] = [],
    private readonly activities: ActivityRow[] = [],
    private readonly artifacts: ArtifactRow[] = [],
    private readonly hints: HintRow[] = [],
    private readonly existingRelations: Record<string, unknown>[] = [],
  ) {}
  async query<Row = Record<string, unknown>>(sql: string): Promise<QueryResult<Row>> {
    if (/FROM knowledge_items ki/.test(sql)) {
      return { rows: this.items as Row[], rowCount: this.items.length };
    }
    if (/FROM space_object_profile_relation_hints h/.test(sql)) {
      return { rows: this.hints as Row[], rowCount: this.hints.length };
    }
    if (/FROM object_relations r/.test(sql)) {
      return { rows: this.existingRelations as Row[], rowCount: this.existingRelations.length };
    }
    if (/FROM notes n/.test(sql)) {
      return { rows: this.notes as Row[], rowCount: this.notes.length };
    }
    if (/FROM activity_records/.test(sql)) {
      return { rows: this.activities as Row[], rowCount: this.activities.length };
    }
    if (/FROM artifacts/.test(sql)) {
      return { rows: this.artifacts as Row[], rowCount: this.artifacts.length };
    }
    return { rows: [] as Row[], rowCount: 0 };
  }
}

function item(overrides: Partial<ItemRow> = {}): ItemRow {
  return {
    id: "item-a",
    title: "Alpha",
    slug: "alpha",
    aliases_json: [],
    object_profile_id: null,
    object_profile: null,
    object_profile_label: null,
    content: "",
    plain_text: null,
    visibility: "space_shared",
    status: "active",
    ...overrides,
  };
}

describe("runRelationDiscoveryScan", () => {
  it("creates a relation candidate from a resolved wikilink between two visible items", async () => {
    const items = [
      item({ id: "item-a", title: "Alpha", content: "Alpha depends on [[Beta]] for deploys." }),
      item({ id: "item-b", title: "Beta", slug: "beta" }),
    ];
    const db = new FakeDiscoveryDb(items);
    const { report } = await runRelationDiscoveryScan(db, {
      spaceId: "space-1",
      userId: "user-1",
      request: {
        limit: 200,
        max_candidates: 40,
        review_scope: "private",
        include_unresolved_item_candidates: false,
        llm_extraction_enabled: false,
        llm_max_sources: 8,
        create_packet: true,
      },
    });

    expect(report.access_safety.deterministic_extraction).toBe(true);
    expect(report.candidates).toHaveLength(1);
    const candidate = report.candidates[0]!;
    expect(candidate.kind).toBe("object_relation_candidate");
    expect(candidate.proposed_action).toMatchObject({
      proposal_type: "object_relation_create",
      from_object_id: "item-a",
      to_object_id: "item-b",
      link_type: "related_to",
    });
  });

  it("uses a typed wikilink prefix when it is a known relation type", async () => {
    const items = [
      item({ id: "item-a", title: "Alpha", content: "See [[depends_on::Beta]]." }),
      item({ id: "item-b", title: "Beta", slug: "beta" }),
    ];
    const db = new FakeDiscoveryDb(items);
    const { report } = await runRelationDiscoveryScan(db, {
      spaceId: "space-1",
      userId: "user-1",
      request: { limit: 200, max_candidates: 40, review_scope: "private", include_unresolved_item_candidates: false, llm_extraction_enabled: false, llm_max_sources: 8, create_packet: true },
    });
    expect(report.candidates[0]!.proposed_action).toMatchObject({ link_type: "depends_on", to_object_id: "item-b" });
  });

  it("supports richer typed-link syntax beyond relation double-colon prefixes", async () => {
    const items = [
      item({ id: "item-a", title: "Alpha", content: "Alpha has [[Beta#supports]] and depends_on -> [[Gamma]]." }),
      item({ id: "item-b", title: "Beta", slug: "beta" }),
      item({ id: "item-c", title: "Gamma", slug: "gamma" }),
    ];
    const db = new FakeDiscoveryDb(items);
    const { report } = await runRelationDiscoveryScan(db, {
      spaceId: "space-1",
      userId: "user-1",
      request: { limit: 200, max_candidates: 40, review_scope: "private", include_unresolved_item_candidates: false, llm_extraction_enabled: false, llm_max_sources: 8, create_packet: true },
    });

    expect(report.candidates.map((candidate) => candidate.proposed_action)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ link_type: "supports", to_object_id: "item-b" }),
        expect.objectContaining({ link_type: "depends_on", to_object_id: "item-c" }),
      ]),
    );
  });

  it("a note source emits an object_relation_create candidate for a resolved link", async () => {
    const items = [item({ id: "item-b", title: "Beta", slug: "beta" })]
    const notes: NoteRow[] = [{ id: "note-a", title: "Daily note", plain_text: "Discussed [[Beta]] today.", status: "active" }]
    const db = new FakeDiscoveryDb(items, notes)
    const { report } = await runRelationDiscoveryScan(db, {
      spaceId: "space-1",
      userId: "user-1",
      request: { source_object_types: ["knowledge_item", "note"], limit: 200, max_candidates: 40, review_scope: "private", include_unresolved_item_candidates: false, llm_extraction_enabled: false, llm_max_sources: 8, create_packet: true },
    })

    const noteCandidate = report.candidates.find((c) => c.kind === "object_relation_candidate")
    expect(noteCandidate).toBeDefined()
    expect(noteCandidate!.proposed_action).toMatchObject({
      proposal_type: "object_relation_create",
      from_object_id: "note-a",
      to_object_id: "item-b",
      link_type: "related_to",
    })
  })

  it("scans activity and artifact text as review-only relation evidence", async () => {
    const items = [item({ id: "item-b", title: "Beta", slug: "beta" })]
    const activities: ActivityRow[] = [{ id: "activity-a", title: "Inbox", content: "Captured [[supports::Beta]].", visibility: "space_shared", owner_user_id: "user-1", user_id: "user-1", subject_user_id: null }]
    const artifacts: ArtifactRow[] = [{ id: "artifact-a", title: "Report", content: "Report says depends_on -> [[Beta]].", visibility: "space_shared", owner_user_id: "user-1", metadata_json: {} }]
    const db = new FakeDiscoveryDb(items, [], activities, artifacts)
    const { report } = await runRelationDiscoveryScan(db, {
      spaceId: "space-1",
      userId: "user-1",
      request: { source_object_types: ["activity", "artifact"], limit: 200, max_candidates: 40, review_scope: "private", include_unresolved_item_candidates: false, llm_extraction_enabled: false, llm_max_sources: 8, create_packet: true },
    })

    expect(report.candidates).toHaveLength(2)
    expect(report.candidates.every((candidate) => candidate.kind === "relation_review_candidate")).toBe(true)
    expect(report.candidates.every((candidate) => candidate.proposed_action === null)).toBe(true)
    expect(report.counts.proposal_candidate).toBe(0)
    expect(report.counts.review_only_candidate).toBe(2)
    expect(report.access_safety.source_policy_enforced).toBe(true)
  })

  it("runs an injected LLM relation extractor only when explicitly requested", async () => {
    const items = [
      item({
        id: "item-a",
        title: "Alpha",
        object_profile_id: "kind-decision",
        object_profile: "decision",
        object_profile_label: "Decision",
        content: "Alpha mentions deploy shape without a typed link.",
      }),
      item({ id: "item-b", title: "Beta", slug: "beta" }),
    ]
    const hints: HintRow[] = [{
      id: "hint-1",
      object_profile_id: "kind-decision",
      object_profile: "decision",
      object_profile_label: "Decision",
      endpoint_object_type: "knowledge_item",
      endpoint_object_profile_id: null,
      endpoint_object_profile: null,
      endpoint_object_profile_label: null,
      link_type: "depends_on",
      direction: "from",
      confidence_default: 0.7,
      required: false,
    }]
    const extractor: RelationDiscoveryLlmExtractor = {
      async extract(input) {
        expect(input.sources).toHaveLength(1)
        expect(input.visibleTargets.map((target) => target.itemId)).toEqual(expect.arrayContaining(["item-a", "item-b"]))
        expect(input.relationHints).toEqual([
          expect.objectContaining({
            id: "hint-1",
            object_profile: "decision",
            link_type: "depends_on",
            confidence_default: 0.7,
          }),
        ])
        return [
          {
            id: "llm-candidate-1",
            kind: "relation_review_candidate",
            cluster_key: "source:item-a",
            title: "Review relation evidence: Alpha -> Beta",
            reason: "Injected extractor identified a relation candidate.",
            confidence_tier: "low",
            evidence_refs: [
              { object_type: "knowledge_item", object_id: "item-a", title: "Alpha", link_origin: "llm", link_text: null },
              { object_type: "knowledge_item", object_id: "item-b", title: "Beta", link_origin: null, link_text: null },
            ],
            markers: { link_type: "related_to", llm_extracted: true },
            proposed_action: null,
          },
        ]
      },
    }
    const db = new FakeDiscoveryDb(items, [], [], [], hints)
    const { report } = await runRelationDiscoveryScan(db, {
      spaceId: "space-1",
      userId: "user-1",
      llmExtractor: extractor,
      request: { source_object_types: ["knowledge_item"], limit: 200, max_candidates: 40, review_scope: "private", include_unresolved_item_candidates: false, llm_extraction_enabled: true, llm_max_sources: 1, create_packet: true },
    })

    expect(report.access_safety).toMatchObject({
      source_policy_enforced: true,
      llm_extraction_requested: true,
      llm_extraction_used: true,
    })
    expect(report.llm_extraction).toMatchObject({ requested: true, used: true, candidate_count: 1, source_count: 1, relation_hint_count: 1 })
    expect(report.candidates[0]!.kind).toBe("relation_review_candidate")
  })

  it("emits review-only gaps for required relation hints using visible graph state", async () => {
    const items = [
      item({
        id: "item-a",
        title: "Alpha Decision",
        object_profile_id: "kind-decision",
        object_profile: "decision",
        object_profile_label: "Decision",
        content: "No explicit relation links here.",
      }),
    ]
    const hints: HintRow[] = [{
      id: "hint-required",
      object_profile_id: "kind-decision",
      object_profile: "decision",
      object_profile_label: "Decision",
      endpoint_object_type: "knowledge_item",
      endpoint_object_profile_id: "kind-summary",
      endpoint_object_profile: "summary",
      endpoint_object_profile_label: "Summary",
      link_type: "supports",
      direction: "from",
      confidence_default: 0.55,
      required: true,
    }]
    const db = new FakeDiscoveryDb(items, [], [], [], hints)

    const { report } = await runRelationDiscoveryScan(db, {
      spaceId: "space-1",
      userId: "user-1",
      request: { source_object_types: ["knowledge_item"], limit: 200, max_candidates: 40, review_scope: "private", include_unresolved_item_candidates: false, llm_extraction_enabled: false, llm_max_sources: 8, create_packet: true },
    })

    expect(report.candidates).toHaveLength(1)
    expect(report.candidates[0]).toMatchObject({
      kind: "relation_review_candidate",
      proposed_action: null,
      markers: {
        schema_relation_hint_id: "hint-required",
        required_hint_gap: true,
        link_type: "supports",
        endpoint_object_profile: "summary",
      },
    })
    expect(report.counts.review_only_candidate).toBe(1)
  })

  it("emits required relation hint gaps for note sources with the canonical note kind", async () => {
    const notes: NoteRow[] = [{
      id: "note-a",
      title: "Daily note",
      plain_text: "No explicit relation links here.",
      status: "active",
      object_profile_id: "kind-note",
      object_profile: "note",
      object_profile_label: "Note",
    }]
    const hints: HintRow[] = [{
      id: "hint-note-required",
      object_profile_id: "kind-note",
      object_profile: "note",
      object_profile_label: "Note",
      endpoint_object_type: "knowledge_item",
      endpoint_object_profile_id: null,
      endpoint_object_profile: null,
      endpoint_object_profile_label: null,
      link_type: "references",
      direction: "from",
      confidence_default: 0.55,
      required: true,
    }]
    const db = new FakeDiscoveryDb([], notes, [], [], hints)

    const { report } = await runRelationDiscoveryScan(db, {
      spaceId: "space-1",
      userId: "user-1",
      request: { source_object_types: ["note"], limit: 200, max_candidates: 40, review_scope: "private", include_unresolved_item_candidates: false, llm_extraction_enabled: false, llm_max_sources: 8, create_packet: true },
    })

    expect(report.candidates).toHaveLength(1)
    expect(report.candidates[0]).toMatchObject({
      kind: "relation_review_candidate",
      proposed_action: null,
      markers: {
        schema_relation_hint_id: "hint-note-required",
        object_profile: "note",
        object_profile_label: "Note",
        link_type: "references",
        required_hint_gap: true,
      },
    })
  })

  it("emits a low-confidence item stub only when unresolved candidates are opted in", async () => {
    const items = [item({ id: "item-a", title: "Alpha", content: "Alpha links to [[Ghost Page]]." })];
    const db = new FakeDiscoveryDb(items);

    const off = await runRelationDiscoveryScan(db, {
      spaceId: "space-1",
      userId: "user-1",
      request: { limit: 200, max_candidates: 40, review_scope: "private", include_unresolved_item_candidates: false, llm_extraction_enabled: false, llm_max_sources: 8, create_packet: true },
    });
    expect(off.report.candidates).toHaveLength(0);

    const on = await runRelationDiscoveryScan(db, {
      spaceId: "space-1",
      userId: "user-1",
      request: { limit: 200, max_candidates: 40, review_scope: "private", include_unresolved_item_candidates: true, llm_extraction_enabled: false, llm_max_sources: 8, create_packet: true },
    });
    expect(on.report.candidates).toHaveLength(1);
    expect(on.report.candidates[0]!.kind).toBe("knowledge_item_candidate");
    expect(on.report.candidates[0]!.confidence_tier).toBe("low");
  });
});

interface StoredProposal {
  id: string;
  proposal_type: string;
  payload_json: Record<string, unknown>;
}

class FakeApplyDb implements Queryable {
  readonly inserted: StoredProposal[] = [];
  updatedPayload: Record<string, unknown> | null = null;
  async query<Row = Record<string, unknown>>(sql: string, params: readonly unknown[] = []): Promise<QueryResult<Row>> {
    const norm = sql.replace(/\s+/g, " ").trim();
    if (norm.startsWith("INSERT INTO proposals")) {
      this.inserted.push({
        id: String(params[0]),
        proposal_type: String(params[3]),
        payload_json: JSON.parse(String(params[10])),
      });
      // insertProposalRow relies on RETURNING id.
      return { rows: [{ id: params[0] }] as Row[], rowCount: 1 };
    }
    if (norm.startsWith("UPDATE proposals")) {
      this.updatedPayload = JSON.parse(String(params[2]));
      return { rows: [] as Row[], rowCount: 1 };
    }
    return { rows: [] as Row[], rowCount: 0 };
  }
}

describe("relation_discovery_packet applier", () => {
  it("creates child knowledge proposals and writes nothing canonical", async () => {
    const db = new FakeApplyDb();
    const registry = new ProposalApplierRegistry();
    registerRelationDiscoveryProposalAppliers(registry);
    const result = await registry.apply({
      config: {} as never,
      db,
      userId: "user-1",
      proposal: {
        id: "packet-1",
        space_id: "space-1",
        proposal_type: RELATION_DISCOVERY_PACKET_PROPOSAL_TYPE,
        payload_json: {
          operation: "relation_discovery_packet",
          report_artifact_id: "artifact-1",
          candidates: [
            {
              id: "cand-1",
              kind: "object_relation_candidate",
              cluster_key: "source:item-a",
              confidence_tier: "high",
              proposed_action: {
                proposal_type: "object_relation_create",
                from_object_id: "item-a",
                to_object_id: "item-b",
                link_type: "related_to",
                confidence: 0.6,
                evidence_summary: "From wikilink.",
              },
            },
            {
              id: "cand-obj",
              kind: "object_relation_candidate",
              cluster_key: "source:note-a",
              confidence_tier: "high",
              proposed_action: {
                proposal_type: "object_relation_create",
                from_object_id: "note-a",
                to_object_id: "item-b",
                link_type: "related_to",
                confidence: 0.6,
                evidence_summary: "From wikilink.",
              },
            },
            {
              id: "cand-2",
              kind: "knowledge_item_candidate",
              cluster_key: "source:item-a",
              confidence_tier: "low",
              proposed_action: {
                proposal_type: "knowledge_create",
                title: "Ghost Page",
                knowledge_kind: "concept",
                content: "Stub.",
                content_format: "markdown",
                visibility: "space_shared",
              },
            },
            {
              id: "cand-review-only",
              kind: "relation_review_candidate",
              cluster_key: "source:artifact-a",
              confidence_tier: "medium",
              proposed_action: null,
            },
          ],
        },
        visibility: "private",
        created_by_user_id: "user-1",
        project_folder_id: null,
        project_id: null,
      } as never,
    });

    expect(result.result_type).toBe("relation_discovery_packet");
    expect(result.result.canonical_write_performed).toBe(false);
    expect(db.inserted).toHaveLength(3);
    expect(db.inserted[0]!.proposal_type).toBe("object_relation_create");
    expect(db.inserted[0]!.payload_json).toMatchObject({ operation: "object_relation_create", from_object_id: "item-a", to_object_id: "item-b" });
    expect(db.inserted[1]!.proposal_type).toBe("object_relation_create");
    expect(db.inserted[1]!.payload_json).toMatchObject({ operation: "object_relation_create", from_object_id: "note-a", to_object_id: "item-b" });
    expect(db.inserted[2]!.proposal_type).toBe("knowledge_create");
    expect(db.inserted[2]!.payload_json).toMatchObject({ operation: "create", title: "Ghost Page" });
    // The applier/registry only return proposalPayloadPatch;
    // ProposalApplyService is the layer that actually issues
    // `UPDATE proposals` from that patch, and is covered by its own tests.
    expect(result.proposalPayloadPatch?.generated_child_proposal_count).toBe(3);
    expect(result.proposalPayloadPatch?.review_only_candidate_count).toBe(1);
    expect(result.proposalPayloadPatch?.skipped_child_proposals).toEqual([
      expect.objectContaining({ candidate_id: "cand-review-only", reason: "review_only_candidate" }),
    ]);
  });

  it("keeps review-only skips visible even after the child proposal cap", async () => {
    const db = new FakeApplyDb();
    const registry = new ProposalApplierRegistry();
    registerRelationDiscoveryProposalAppliers(registry);
    const cappedProposalCandidates = Array.from({ length: 40 }, (_, index) => ({
      id: `cand-${index}`,
      kind: "object_relation_candidate",
      cluster_key: `source:item-${index}`,
      confidence_tier: "high",
      proposed_action: {
        proposal_type: "object_relation_create",
        from_object_id: `item-a-${index}`,
        to_object_id: `item-b-${index}`,
        link_type: "related_to",
        confidence: 0.6,
        evidence_summary: "From wikilink.",
      },
    }));

    const result = await registry.apply({
      config: {} as never,
      db,
      userId: "user-1",
      proposal: {
        id: "packet-1",
        space_id: "space-1",
        proposal_type: RELATION_DISCOVERY_PACKET_PROPOSAL_TYPE,
        payload_json: {
          operation: "relation_discovery_packet",
          report_artifact_id: "artifact-1",
          candidates: [
            ...cappedProposalCandidates,
            {
              id: "cand-review-only-after-cap",
              kind: "relation_review_candidate",
              cluster_key: "source:artifact-a",
              confidence_tier: "medium",
              proposed_action: null,
            },
          ],
          review_only_candidate_count: 1,
        },
        visibility: "private",
        created_by_user_id: "user-1",
        project_folder_id: null,
        project_id: null,
      } as never,
    });

    expect(result.result.review_only_candidate_count).toBe(1);
    expect(db.inserted).toHaveLength(40);
    expect(result.proposalPayloadPatch?.review_only_candidate_count).toBe(1);
    expect(result.proposalPayloadPatch?.skipped_child_proposals).toEqual([
      expect.objectContaining({
        candidate_id: "cand-review-only-after-cap",
        reason: "review_only_candidate",
      }),
    ]);
  });
});
