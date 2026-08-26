import { describe, expect, it } from "vitest";
import {
  CLAIM_CANDIDATE_PACKET_ARTIFACT_TYPE,
  CLAIM_CANDIDATE_PACKET_PROPOSAL_TYPE,
  createClaimCandidatePacketFromArtifacts,
  registerClaimCandidatePacketProposalAppliers,
} from "../src/modules/knowledge/claimCandidatePackets.js";
import { ProposalApplierRegistry } from "../src/modules/proposals/applierRegistry.js";
import type { QueryResult, Queryable } from "../src/modules/routeUtils/common.js";

interface ArtifactRow {
  id: string;
  artifact_type: string;
  title: string;
  visibility?: string;
  metadata_json: Record<string, unknown>;
}

interface StoredProposal {
  id: string;
  proposal_type: string;
  payload_json: Record<string, unknown>;
  visibility: string;
}

interface SourceConnectionRow {
  id: string;
  owner_user_id: string;
  consent_json: Record<string, unknown>;
  policy_json: Record<string, unknown>;
}

class ClaimCandidatePacketFakeDb implements Queryable {
  readonly calls: Array<{ sql: string; params: readonly unknown[] }> = [];
  readonly insertedArtifacts: Array<Record<string, unknown>> = [];
  readonly insertedProposals: StoredProposal[] = [];
  updatedProposalPayload: Record<string, unknown> | null = null;

  constructor(
    private readonly artifacts: ArtifactRow[],
    private readonly sourceConnections: SourceConnectionRow[] = [],
  ) {}

  async query<Row = Record<string, unknown>>(
    sql: string,
    params: readonly unknown[] = [],
  ): Promise<QueryResult<Row>> {
    this.calls.push({ sql, params });
    const norm = sql.replace(/\s+/g, " ").trim();
    if (norm.startsWith("SELECT a.id, a.artifact_type, a.title, a.visibility, a.metadata_json FROM artifacts a")) {
      const requested = Array.isArray(params[2]) ? params[2].map(String) : [];
      const visibilityFilter = /AND a\.visibility (?:= '[^']+'|IN \([^)]+\)) AND a\.id/.exec(norm)?.[0] ?? "";
      const allowedVisibilities = [...visibilityFilter.matchAll(/'(private|space_shared|selected_users)'/g)]
        .map((match) => match[1]);
      const rows = requested
        .map((id) => this.artifacts.find((artifact) => artifact.id === id))
        .filter((row): row is ArtifactRow => Boolean(row))
        .filter((row) => allowedVisibilities.includes(row.visibility ?? "private"))
        .map((row) => ({ ...row, visibility: row.visibility ?? "private" }))
      return { rows: rows as Row[], rowCount: rows.length };
    }
    if (norm.startsWith("SELECT id, owner_user_id, consent_json, policy_json FROM source_connections")) {
      const requested = Array.isArray(params[1]) ? params[1].map(String) : [];
      const rows = this.sourceConnections.filter((row) => requested.includes(row.id));
      return { rows: rows as Row[], rowCount: rows.length };
    }
    if (norm.startsWith("INSERT INTO artifacts")) {
      const metadata = JSON.parse(String(params[13]));
      this.insertedArtifacts.push({
        id: params[0],
        space_id: params[1],
        artifact_type: params[4],
        title: params[5],
        metadata_json: metadata,
        visibility: params[14],
        owner_user_id: params[15],
      });
      return { rows: [], rowCount: 1 };
    }
    if (norm.startsWith("INSERT INTO proposals")) {
      const payload = JSON.parse(String(params[10]));
      const row: StoredProposal = {
        id: String(params[0]),
        proposal_type: String(params[3]),
        payload_json: payload,
        visibility: String(params[15] ?? "private"),
      };
      this.insertedProposals.push(row);
      return { rows: [row] as unknown as Row[], rowCount: 1 };
    }
    if (norm.startsWith("UPDATE proposals")) {
      this.updatedProposalPayload = JSON.parse(String(params[2]));
      return { rows: [], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  }
}

function retrievalBriefArtifact(): ArtifactRow {
  return {
    id: "artifact-brief",
    artifact_type: "retrieval_brief",
    title: "Context Brief",
    metadata_json: {
      gap_analysis: {
        uncited_claims: ["The vector index is stale for source-backed claims."],
        contradictions: [
          "Claim A conflicts with Claim B.",
          {
            claim_ids: [
              "11111111-1111-4111-8111-111111111111",
              "22222222-2222-4222-8222-222222222222",
            ],
            reason: "Claim A contradicts Claim B.",
            confidence: 0.72,
          },
        ],
        missing_topics: ["Source policy freshness"],
        stale: [
          {
            object_type: "knowledge_item",
            object_id: "33333333-3333-4333-8333-333333333333",
            title: "Old source",
            reason: "Source content is older than the connected source.",
          },
        ],
        thin: [
          {
            object_type: "knowledge_item",
            object_id: "44444444-4444-4444-8444-444444444444",
            title: "Thin source",
            reason: "Source has too little reviewable text.",
          },
        ],
      },
    },
  };
}

function enrichedClaimBriefArtifact(): ArtifactRow {
  return {
    id: "artifact-enriched-brief",
    artifact_type: "retrieval_brief",
    title: "Context Brief",
    metadata_json: {
      source_connection_ids: ["source-1"],
      gap_analysis: {
        uncited_claims: [
          {
            claim_text: "Alice believes the migration is stable as of 2026-06-01.",
            source_connection_ids: ["source-1"],
          },
        ],
      },
    },
  };
}

function readableSourceConnection(): SourceConnectionRow {
  return {
    id: "source-1",
    owner_user_id: "user-1",
    consent_json: {
      schema_version: 1,
      owner_user_id: "user-1",
      allowed_reader_user_ids: ["user-1"],
      allowed_agent_ids: [],
      allow_space_admins: false,
      allow_local_provider_egress: true,
      allow_external_model_egress: true,
    },
    policy_json: {
      schema_version: 1,
      source_egress_class: "external_provider_allowed",
    },
  };
}

function maintenanceArtifact(): ArtifactRow {
  return {
    id: "artifact-maintenance",
    artifact_type: "retrieval_maintenance_report",
    title: "Maintenance Report",
    metadata_json: {
      findings: [
        {
          kind: "stale",
          reason: "Object is stale.",
          objects: [{ object_type: "knowledge_item", object_id: "33333333-3333-4333-8333-333333333333", title: "Old source" }],
        },
        {
          kind: "thin",
          reason: "Object is thin.",
          objects: [{ object_type: "knowledge_item", object_id: "44444444-4444-4444-8444-444444444444", title: "Thin source" }],
        },
        {
          kind: "orphan",
          reason: "Object has no retrieval edges.",
          objects: [{ object_type: "knowledge_item", object_id: "55555555-5555-4555-8555-555555555555", title: "Orphan source" }],
        },
        {
          kind: "duplicate",
          reason: "Objects look equivalent.",
          objects: [
            { object_type: "knowledge_item", object_id: "33333333-3333-4333-8333-333333333333", title: "Old source" },
            { object_type: "knowledge_item", object_id: "44444444-4444-4444-8444-444444444444", title: "Thin source" },
          ],
        },
        {
          kind: "relation_suggestion",
          reason: "Objects are related.",
          objects: [
            { object_type: "knowledge_item", object_id: "44444444-4444-4444-8444-444444444444", title: "Thin source" },
            { object_type: "knowledge_item", object_id: "55555555-5555-4555-8555-555555555555", title: "Orphan source" },
          ],
        },
      ],
    },
  };
}

function memoryMaintenanceArtifact(): ArtifactRow {
  return {
    id: "artifact-memory-maintenance",
    artifact_type: "memory_maintenance_report",
    title: "Memory Maintenance Report",
    metadata_json: {
      findings: [
        {
          kind: "stale",
          reason: "Memory has not been reviewed recently.",
          memories: [{ memory_id: "memory-1", summary: "Old preference" }],
        },
      ],
    },
  };
}

describe("Claim Candidate Packets", () => {
  it("creates packet artifacts and proposals from retrieval brief gap analysis", async () => {
    const db = new ClaimCandidatePacketFakeDb([retrievalBriefArtifact()]);
    const result = await createClaimCandidatePacketFromArtifacts(db, {
      spaceId: "space-1",
      ownerUserId: "user-1",
      request: {
        source_artifact_ids: ["artifact-brief"],
        max_candidates: 10,
        review_scope: "private",
        promote_private_sources_to_space_ops: false,
      },
    });

    expect(result.candidateCount).toBe(6);
    expect(db.insertedArtifacts[0]).toMatchObject({
      artifact_type: CLAIM_CANDIDATE_PACKET_ARTIFACT_TYPE,
      visibility: "private",
      owner_user_id: "user-1",
    });
    expect(db.insertedProposals[0]).toMatchObject({
      id: result.proposalId,
      proposal_type: CLAIM_CANDIDATE_PACKET_PROPOSAL_TYPE,
      visibility: "private",
    });
    expect(db.insertedProposals[0]?.payload_json).toMatchObject({
      operation: "claim_candidate_packet",
      packet_artifact_id: result.artifactId,
      candidate_count: 6,
      generated_child_proposal_count: 0,
      canonical_write_performed: false,
    });
    const candidates = db.insertedProposals[0]?.payload_json.candidates as Array<Record<string, unknown>>;
    expect(candidates.map((candidate) => candidate.origin as Record<string, unknown>)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ source_section: "gap_analysis.stale" }),
        expect.objectContaining({ source_section: "gap_analysis.thin" }),
        expect.objectContaining({ source_section: "gap_analysis.contradictions" }),
      ]),
    );
    expect(candidates.some((candidate) =>
      (candidate.proposed_action as Record<string, unknown> | null)?.proposal_type === "object_relation_create")).toBe(true);
  });

  it("enriches brief claim candidates with holder, validity, and governed source refs", async () => {
    const db = new ClaimCandidatePacketFakeDb([enrichedClaimBriefArtifact()], [readableSourceConnection()]);
    const result = await createClaimCandidatePacketFromArtifacts(db, {
      spaceId: "space-1",
      ownerUserId: "user-1",
      request: {
        source_artifact_ids: ["artifact-enriched-brief"],
        max_candidates: 10,
        review_scope: "private",
        promote_private_sources_to_space_ops: false,
      },
    });

    expect(result.candidateCount).toBe(1);
    const candidates = db.insertedProposals[0]?.payload_json.candidates as Array<Record<string, unknown>>;
    const candidate = candidates[0]!;
    expect(candidate).toMatchObject({
      kind: "claim_candidate",
      source_connection_ids: ["source-1"],
      source_policy_snapshots: {
        "source-1": expect.objectContaining({
          ownerUserId: "user-1",
          sourceEgressClass: "external_provider_allowed",
        }),
      },
    });
    const proposedAction = candidate.proposed_action as Record<string, unknown>;
    expect(proposedAction.proposal_type).toBe("claim_create");
    expect(proposedAction.payload).toMatchObject({
      claim_kind: "belief",
      holder_type: "actor",
      holder_id: "alice",
      observed_at: "2026-06-01T00:00:00.000Z",
      sources: [
        expect.objectContaining({
          source_connection_id: "source-1",
          evidence_role: "mentions",
          source_policy_snapshot: expect.objectContaining({ id: "source-1" }),
        }),
      ],
      metadata: {
        claim_enrichment: expect.objectContaining({
          holder_type: "actor",
          holder_id: "alice",
          observed_at: "2026-06-01T00:00:00.000Z",
        }),
      },
    });
  });

  it("requires explicit opt-in and confirmation before promoting private source artifacts into space_ops packets", async () => {
    const privateBrief = retrievalBriefArtifact();
    const blockedDb = new ClaimCandidatePacketFakeDb([privateBrief]);

    await expect(createClaimCandidatePacketFromArtifacts(blockedDb, {
      spaceId: "space-1",
      ownerUserId: "user-1",
      request: {
        source_artifact_ids: ["artifact-brief"],
        max_candidates: 10,
        review_scope: "space_ops",
        promote_private_sources_to_space_ops: false,
      },
    })).rejects.toMatchObject({ statusCode: 404 });

    await expect(createClaimCandidatePacketFromArtifacts(new ClaimCandidatePacketFakeDb([privateBrief]), {
      spaceId: "space-1",
      ownerUserId: "user-1",
      request: {
        source_artifact_ids: ["artifact-brief"],
        max_candidates: 10,
        review_scope: "space_ops",
        promote_private_sources_to_space_ops: true,
      },
    })).rejects.toMatchObject({ statusCode: 422 });

    const promotedDb = new ClaimCandidatePacketFakeDb([privateBrief]);
    const result = await createClaimCandidatePacketFromArtifacts(promotedDb, {
      spaceId: "space-1",
      ownerUserId: "user-1",
      request: {
        source_artifact_ids: ["artifact-brief"],
        max_candidates: 10,
        review_scope: "space_ops",
        promote_private_sources_to_space_ops: true,
        private_source_promotion_confirmed: true,
      },
    });

    expect(result.sourceArtifactCount).toBe(1);
    expect(promotedDb.insertedArtifacts[0]).toMatchObject({
      visibility: "space_shared",
      metadata_json: expect.objectContaining({
        private_source_promotion: true,
        promoted_source_artifact_ids: ["artifact-brief"],
      }),
    });
    expect(promotedDb.insertedProposals[0]).toMatchObject({
      visibility: "space_shared",
      payload_json: expect.objectContaining({
        review_scope: "space_ops",
        private_source_promotion: true,
        promoted_source_artifact_ids: ["artifact-brief"],
      }),
    });
  });

  it("accepting a packet creates child proposals without canonical claim writes", async () => {
    const db = new ClaimCandidatePacketFakeDb([retrievalBriefArtifact()]);
    const createResult = await createClaimCandidatePacketFromArtifacts(db, {
      spaceId: "space-1",
      ownerUserId: "user-1",
      request: {
        source_artifact_ids: ["artifact-brief"],
        max_candidates: 3,
        review_scope: "private",
        promote_private_sources_to_space_ops: false,
      },
    });
    const packetProposal = db.insertedProposals.find((proposal) =>
      proposal.proposal_type === CLAIM_CANDIDATE_PACKET_PROPOSAL_TYPE);
    expect(packetProposal).toBeDefined();

    const registry = new ProposalApplierRegistry();
    registerClaimCandidatePacketProposalAppliers(registry);
    const result = await registry.apply({
      config: {} as never,
      db,
      userId: "user-1",
      proposal: {
        id: createResult.proposalId,
        space_id: "space-1",
        proposal_type: CLAIM_CANDIDATE_PACKET_PROPOSAL_TYPE,
        title: "Claim candidate packet",
        payload_json: packetProposal!.payload_json,
        project_folder_id: null,
        visibility: "private",
        created_by_user_id: "user-1",
        created_by_run_id: null,
        project_id: null,
      },
    });

    expect(result).toMatchObject({
      result_type: "claim_candidate_packet",
      result: {
        generated_child_proposal_count: 2,
        skipped_child_proposal_count: 0,
        canonical_write_performed: false,
      },
    });
    expect(db.insertedProposals.filter((proposal) => proposal.proposal_type === "claim_create")).toHaveLength(1);
    expect(db.insertedProposals.filter((proposal) => proposal.proposal_type === "object_relation_create")).toHaveLength(1);
    expect(db.calls.some((call) => /INSERT INTO claims/.test(call.sql))).toBe(false);
    expect(db.calls.some((call) => /INSERT INTO object_relations/.test(call.sql))).toBe(false);
    expect(result.proposalPayloadPatch).toMatchObject({
      generated_child_proposal_count: 2,
      skipped_child_proposal_count: 0,
      canonical_write_performed: false,
      accepted_by_user_id: "user-1",
    });
  });

  it("creates review notes and object relation candidates from maintenance findings", async () => {
    const db = new ClaimCandidatePacketFakeDb([maintenanceArtifact(), memoryMaintenanceArtifact()]);
    const result = await createClaimCandidatePacketFromArtifacts(db, {
      spaceId: "space-1",
      ownerUserId: "user-1",
      request: {
        source_artifact_ids: ["artifact-maintenance", "artifact-memory-maintenance"],
        max_candidates: 10,
        review_scope: "private",
        promote_private_sources_to_space_ops: false,
      },
    });

    expect(result.candidateCount).toBe(6);
    const packet = db.insertedProposals.find((proposal) =>
      proposal.proposal_type === CLAIM_CANDIDATE_PACKET_PROPOSAL_TYPE);
    const candidates = packet?.payload_json.candidates as Array<Record<string, unknown>>;
    expect(candidates.filter((candidate) => candidate.kind === "review_note")).toHaveLength(4);
    expect(candidates.filter((candidate) => candidate.kind === "object_relation_candidate")).toHaveLength(2);
    expect(candidates.map((candidate) => candidate.origin as Record<string, unknown>)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ source_section: "maintenance.orphan" }),
        expect.objectContaining({ source_section: "memory_maintenance.stale" }),
      ]),
    );
  });

  it("accepting a maintenance packet creates object relation child proposals only", async () => {
    const db = new ClaimCandidatePacketFakeDb([maintenanceArtifact()]);
    const createResult = await createClaimCandidatePacketFromArtifacts(db, {
      spaceId: "space-1",
      ownerUserId: "user-1",
      request: {
        source_artifact_ids: ["artifact-maintenance"],
        max_candidates: 10,
        review_scope: "private",
        promote_private_sources_to_space_ops: false,
      },
    });
    const packetProposal = db.insertedProposals.find((proposal) =>
      proposal.proposal_type === CLAIM_CANDIDATE_PACKET_PROPOSAL_TYPE);

    const registry = new ProposalApplierRegistry();
    registerClaimCandidatePacketProposalAppliers(registry);
    const result = await registry.apply({
      config: {} as never,
      db,
      userId: "user-1",
      proposal: {
        id: createResult.proposalId,
        space_id: "space-1",
        proposal_type: CLAIM_CANDIDATE_PACKET_PROPOSAL_TYPE,
        title: "Claim candidate packet",
        payload_json: packetProposal!.payload_json,
        project_folder_id: null,
        visibility: "private",
        created_by_user_id: "user-1",
        created_by_run_id: null,
        project_id: null,
      },
    });

    expect(result.result.generated_child_proposal_count).toBe(2);
    expect(db.insertedProposals.filter((proposal) => proposal.proposal_type === "object_relation_create")).toHaveLength(2);
    expect(db.insertedProposals.filter((proposal) => proposal.proposal_type === "claim_create")).toHaveLength(0);
  });

  it("records skipped child proposals when candidate payload validation fails", async () => {
    const db = new ClaimCandidatePacketFakeDb([]);
    const registry = new ProposalApplierRegistry();
    registerClaimCandidatePacketProposalAppliers(registry);

    const result = await registry.apply({
      config: {} as never,
      db,
      userId: "user-1",
      proposal: {
        id: "proposal-packet",
        space_id: "space-1",
        proposal_type: CLAIM_CANDIDATE_PACKET_PROPOSAL_TYPE,
        title: "Claim candidate packet",
        payload_json: {
          operation: "claim_candidate_packet",
          packet_artifact_id: "artifact-packet",
          candidates: [
            {
              id: "candidate-bad",
              title: "Bad candidate",
              proposed_action: {
                proposal_type: "claim_create",
                title: "Bad child",
                payload: {
                  operation: "claim_create",
                  claim_kind: "fact",
                },
              },
            },
          ],
        },
        project_folder_id: null,
        visibility: "private",
        created_by_user_id: "user-1",
        created_by_run_id: null,
        project_id: null,
      },
    });

    expect(result).toMatchObject({
      result_type: "claim_candidate_packet",
      result: {
        generated_child_proposal_count: 0,
        skipped_child_proposal_count: 1,
      },
    });
    expect(result.proposalPayloadPatch).toMatchObject({
      generated_child_proposal_count: 0,
      skipped_child_proposal_count: 1,
      skipped_child_proposals: [
        expect.objectContaining({
          candidate_id: "candidate-bad",
          proposal_type: "claim_create",
        }),
      ],
    });
  });

  it("records skipped child proposals when action type and payload operation differ", async () => {
    const db = new ClaimCandidatePacketFakeDb([]);
    const registry = new ProposalApplierRegistry();
    registerClaimCandidatePacketProposalAppliers(registry);

    const result = await registry.apply({
      config: {} as never,
      db,
      userId: "user-1",
      proposal: {
        id: "proposal-packet",
        space_id: "space-1",
        proposal_type: CLAIM_CANDIDATE_PACKET_PROPOSAL_TYPE,
        title: "Claim candidate packet",
        payload_json: {
          operation: "claim_candidate_packet",
          packet_artifact_id: "artifact-packet",
          candidates: [
            {
              id: "candidate-mismatch",
              title: "Mismatched candidate",
              proposed_action: {
                proposal_type: "claim_create",
                title: "Mismatched child",
                payload: {
                  operation: "object_relation_create",
                  from_object_id: "33333333-3333-4333-8333-333333333333",
                  to_object_id: "44444444-4444-4444-8444-444444444444",
                  link_type: "related_to",
                },
              },
            },
          ],
        },
        project_folder_id: null,
        visibility: "private",
        created_by_user_id: "user-1",
        created_by_run_id: null,
        project_id: null,
      },
    });

    expect(result.result).toMatchObject({
      generated_child_proposal_count: 0,
      skipped_child_proposal_count: 1,
    });
    expect(db.insertedProposals).toHaveLength(0);
    expect(result.proposalPayloadPatch).toMatchObject({
      skipped_child_proposals: [
        expect.objectContaining({
          candidate_id: "candidate-mismatch",
          proposal_type: "claim_create",
        }),
      ],
    });
  });

  it("does not create a space_ops packet from private source artifacts", async () => {
    const db = new ClaimCandidatePacketFakeDb([retrievalBriefArtifact()]);

    await expect(createClaimCandidatePacketFromArtifacts(db, {
      spaceId: "space-1",
      ownerUserId: "user-1",
      request: {
        source_artifact_ids: ["artifact-brief"],
        max_candidates: 10,
        review_scope: "space_ops",
        promote_private_sources_to_space_ops: false,
      },
    })).rejects.toThrow(/source artifact not found or not visible/);
    expect(db.insertedArtifacts).toHaveLength(0);
    expect(db.insertedProposals).toHaveLength(0);
  });
});
