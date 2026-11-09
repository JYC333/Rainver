import { describe, expect, it } from "vitest";
import {
  CLAIM_CANDIDATE_PACKET_ARTIFACT_TYPE,
  CLAIM_CANDIDATE_PACKET_PROPOSAL_TYPE,
  createClaimCandidatePacketFromArtifacts,
  registerClaimCandidatePacketProposalAppliers,
} from "../src/modules/knowledge/claimCandidatePackets.js";
import { ProposalApplierRegistry } from "../src/modules/proposals/applierRegistry.js";
import { seedSourceConnection, useReviewPacketDatabase } from "./support/reviewPacketDatabase.js";

// Packet creation and acceptance run on the shared real PostgreSQL: the source
// artifacts and Source connection are real rows, and every packet/child proposal
// is read back from the database rather than from a scripted query fake.

interface ArtifactRow {
  id: string;
  artifact_type: string;
  title: string;
  visibility?: string;
  metadata_json: Record<string, unknown>;
}

interface SourceConnectionRow {
  id: string;
  owner_user_id: string;
  consent_json: Record<string, unknown>;
  policy_json: Record<string, unknown>;
}

const packetDatabase = useReviewPacketDatabase(import.meta.url);

async function seedWorld(artifacts: ArtifactRow[], sources: SourceConnectionRow[] = []) {
  const pool = packetDatabase.database.pool;
  for (const artifact of artifacts) {
    await pool.query(
      `INSERT INTO artifacts(id,space_id,owner_user_id,artifact_type,title,visibility,metadata_json,export_formats_json,created_at,updated_at)
       VALUES($1,'space-1','user-1',$2,$3,$4,$5::jsonb,'[]',now(),now())`,
      [artifact.id, artifact.artifact_type, artifact.title, artifact.visibility ?? "private", JSON.stringify(artifact.metadata_json)],
    );
  }
  for (const source of sources) {
    await seedSourceConnection(pool, { id: source.id, space: "space-1", owner: source.owner_user_id, consent: source.consent_json, policy: source.policy_json });
  }
  return packetDatabase.observe();
}

async function storedProposals(type?: string) {
  return (await packetDatabase.database.pool.query<{ id: string; proposal_type: string; status: string; visibility: string; payload_json: Record<string, unknown> }>(
    `SELECT id, proposal_type, status, visibility, payload_json FROM proposals
      WHERE space_id = 'space-1' AND ($1::text IS NULL OR proposal_type = $1) ORDER BY created_at, id`,
    [type ?? null],
  )).rows;
}

async function storedArtifact(id: string) {
  return (await packetDatabase.database.pool.query(
    "SELECT artifact_type, visibility, owner_user_id, metadata_json FROM artifacts WHERE id = $1 AND space_id = 'space-1'",
    [id],
  )).rows[0];
}

async function canonicalRowCount() {
  const pool = packetDatabase.database.pool;
  const claims = (await pool.query("SELECT count(*)::int AS n FROM claims")).rows[0].n as number;
  const relations = (await pool.query("SELECT count(*)::int AS n FROM object_relations")).rows[0].n as number;
  return claims + relations;
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
  const privateRequest = (ids: string[], max = 10) => ({
    source_artifact_ids: ids,
    max_candidates: max,
    review_scope: "private" as const,
    promote_private_sources_to_space_ops: false,
  });
  const acceptPacket = async (db: Awaited<ReturnType<typeof seedWorld>>, proposalId: string) => {
    const packet = (await storedProposals(CLAIM_CANDIDATE_PACKET_PROPOSAL_TYPE)).find((row) => row.id === proposalId);
    expect(packet).toBeDefined();
    const registry = new ProposalApplierRegistry();
    registerClaimCandidatePacketProposalAppliers(registry);
    return registry.apply({
      config: {} as never,
      db,
      userId: "user-1",
      proposal: {
        id: proposalId,
        space_id: "space-1",
        proposal_type: CLAIM_CANDIDATE_PACKET_PROPOSAL_TYPE,
        title: "Claim candidate packet",
        payload_json: packet!.payload_json,
        project_folder_id: null,
        visibility: "private",
        created_by_user_id: "user-1",
        owner_user_id: null,
        created_by_run_id: null,
        project_id: null,
      },
    });
  };
  const applyLiteralPacket = async (candidate: Record<string, unknown>) => {
    const db = await seedWorld([]);
    const registry = new ProposalApplierRegistry();
    registerClaimCandidatePacketProposalAppliers(registry);
    return registry.apply({
      config: {} as never,
      db,
      userId: "user-1",
      proposal: {
        id: "proposal-packet",
        space_id: "space-1",
        proposal_type: CLAIM_CANDIDATE_PACKET_PROPOSAL_TYPE,
        title: "Claim candidate packet",
        payload_json: { operation: "claim_candidate_packet", packet_artifact_id: "artifact-packet", candidates: [candidate] },
        project_folder_id: null,
        visibility: "private",
        created_by_user_id: "user-1",
        owner_user_id: null,
        created_by_run_id: null,
        project_id: null,
      },
    });
  };

  it("creates packet artifacts and proposals from retrieval brief gap analysis", async () => {
    const db = await seedWorld([retrievalBriefArtifact()]);
    const result = await createClaimCandidatePacketFromArtifacts(db, {
      spaceId: "space-1",
      ownerUserId: "user-1",
      request: privateRequest(["artifact-brief"]),
    });

    expect(result.candidateCount).toBe(6);
    expect(await storedArtifact(result.artifactId)).toMatchObject({
      artifact_type: CLAIM_CANDIDATE_PACKET_ARTIFACT_TYPE,
      visibility: "private",
      owner_user_id: "user-1",
    });
    const [packet, ...others] = await storedProposals();
    expect(others).toHaveLength(0);
    expect(packet).toMatchObject({
      id: result.proposalId,
      proposal_type: CLAIM_CANDIDATE_PACKET_PROPOSAL_TYPE,
      status: "pending",
      visibility: "private",
    });
    expect(packet!.payload_json).toMatchObject({
      operation: "claim_candidate_packet",
      packet_artifact_id: result.artifactId,
      candidate_count: 6,
      generated_child_proposal_count: 0,
      canonical_write_performed: false,
    });
    const candidates = packet!.payload_json.candidates as Array<Record<string, unknown>>;
    expect(candidates.map((candidate) => candidate.origin as Record<string, unknown>)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ source_section: "gap_analysis.stale" }),
        expect.objectContaining({ source_section: "gap_analysis.thin" }),
        expect.objectContaining({ source_section: "gap_analysis.contradictions" }),
      ]),
    );
    expect(candidates.some((candidate) =>
      (candidate.proposed_action as Record<string, unknown> | null)?.proposal_type === "object_relation_create")).toBe(true);
    expect(await canonicalRowCount()).toBe(0);
  });

  it("enriches brief claim candidates with holder, validity, and governed source refs", async () => {
    const db = await seedWorld([enrichedClaimBriefArtifact()], [readableSourceConnection()]);
    const result = await createClaimCandidatePacketFromArtifacts(db, {
      spaceId: "space-1",
      ownerUserId: "user-1",
      request: privateRequest(["artifact-enriched-brief"]),
    });

    expect(result.candidateCount).toBe(1);
    const [packet] = await storedProposals(CLAIM_CANDIDATE_PACKET_PROPOSAL_TYPE);
    const candidate = (packet!.payload_json.candidates as Array<Record<string, unknown>>)[0]!;
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
    const db = await seedWorld([retrievalBriefArtifact()]);

    await expect(createClaimCandidatePacketFromArtifacts(db, {
      spaceId: "space-1",
      ownerUserId: "user-1",
      request: { ...privateRequest(["artifact-brief"]), review_scope: "space_ops" },
    })).rejects.toMatchObject({ statusCode: 404 });

    await expect(createClaimCandidatePacketFromArtifacts(db, {
      spaceId: "space-1",
      ownerUserId: "user-1",
      request: { ...privateRequest(["artifact-brief"]), review_scope: "space_ops", promote_private_sources_to_space_ops: true },
    })).rejects.toMatchObject({ statusCode: 422 });
    expect(await storedProposals()).toHaveLength(0);
    expect((await packetDatabase.database.pool.query("SELECT 1 FROM artifacts WHERE id <> 'artifact-brief'")).rowCount).toBe(0);

    const result = await createClaimCandidatePacketFromArtifacts(db, {
      spaceId: "space-1",
      ownerUserId: "user-1",
      request: {
        ...privateRequest(["artifact-brief"]),
        review_scope: "space_ops",
        promote_private_sources_to_space_ops: true,
        private_source_promotion_confirmed: true,
      },
    });

    expect(result.sourceArtifactCount).toBe(1);
    expect(await storedArtifact(result.artifactId)).toMatchObject({
      visibility: "space_shared",
      metadata_json: expect.objectContaining({
        private_source_promotion: true,
        promoted_source_artifact_ids: ["artifact-brief"],
      }),
    });
    expect(await storedProposals()).toEqual([expect.objectContaining({
      id: result.proposalId,
      visibility: "space_shared",
      payload_json: expect.objectContaining({
        review_scope: "space_ops",
        private_source_promotion: true,
        promoted_source_artifact_ids: ["artifact-brief"],
      }),
    })]);
  });

  it("accepting a packet creates child proposals without canonical claim writes", async () => {
    const db = await seedWorld([retrievalBriefArtifact()]);
    const createResult = await createClaimCandidatePacketFromArtifacts(db, {
      spaceId: "space-1",
      ownerUserId: "user-1",
      request: privateRequest(["artifact-brief"], 3),
    });

    const result = await acceptPacket(db, createResult.proposalId);

    expect(result).toMatchObject({
      result_type: "claim_candidate_packet",
      result: {
        generated_child_proposal_count: 2,
        skipped_child_proposal_count: 0,
        canonical_write_performed: false,
      },
    });
    expect(await storedProposals("claim_create")).toEqual([expect.objectContaining({ status: "pending" })]);
    expect(await storedProposals("object_relation_create")).toEqual([expect.objectContaining({ status: "pending" })]);
    expect(await canonicalRowCount()).toBe(0);
    expect(result.proposalPayloadPatch).toMatchObject({
      generated_child_proposal_count: 2,
      skipped_child_proposal_count: 0,
      canonical_write_performed: false,
      accepted_by_user_id: "user-1",
    });
  });

  it("creates review notes and object relation candidates from maintenance findings", async () => {
    const db = await seedWorld([maintenanceArtifact(), memoryMaintenanceArtifact()]);
    const result = await createClaimCandidatePacketFromArtifacts(db, {
      spaceId: "space-1",
      ownerUserId: "user-1",
      request: privateRequest(["artifact-maintenance", "artifact-memory-maintenance"]),
    });

    expect(result.candidateCount).toBe(6);
    const [packet] = await storedProposals(CLAIM_CANDIDATE_PACKET_PROPOSAL_TYPE);
    const candidates = packet!.payload_json.candidates as Array<Record<string, unknown>>;
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
    const db = await seedWorld([maintenanceArtifact()]);
    const createResult = await createClaimCandidatePacketFromArtifacts(db, {
      spaceId: "space-1",
      ownerUserId: "user-1",
      request: privateRequest(["artifact-maintenance"]),
    });

    const result = await acceptPacket(db, createResult.proposalId);

    expect(result.result.generated_child_proposal_count).toBe(2);
    expect(await storedProposals("object_relation_create")).toHaveLength(2);
    expect(await storedProposals("claim_create")).toHaveLength(0);
    expect(await canonicalRowCount()).toBe(0);
  });

  it("records skipped child proposals when candidate payload validation fails", async () => {
    const result = await applyLiteralPacket({
      id: "candidate-bad",
      title: "Bad candidate",
      proposed_action: {
        proposal_type: "claim_create",
        title: "Bad child",
        payload: { operation: "claim_create", claim_kind: "fact" },
      },
    });

    expect(result).toMatchObject({
      result_type: "claim_candidate_packet",
      result: { generated_child_proposal_count: 0, skipped_child_proposal_count: 1 },
    });
    expect(result.proposalPayloadPatch).toMatchObject({
      generated_child_proposal_count: 0,
      skipped_child_proposal_count: 1,
      skipped_child_proposals: [
        expect.objectContaining({ candidate_id: "candidate-bad", proposal_type: "claim_create" }),
      ],
    });
    expect(await storedProposals()).toHaveLength(0);
  });

  it("records skipped child proposals when action type and payload operation differ", async () => {
    const result = await applyLiteralPacket({
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
    });

    expect(result.result).toMatchObject({ generated_child_proposal_count: 0, skipped_child_proposal_count: 1 });
    expect(await storedProposals()).toHaveLength(0);
    expect(result.proposalPayloadPatch).toMatchObject({
      skipped_child_proposals: [
        expect.objectContaining({ candidate_id: "candidate-mismatch", proposal_type: "claim_create" }),
      ],
    });
  });

  it("does not create a space_ops packet from private source artifacts", async () => {
    const db = await seedWorld([retrievalBriefArtifact()]);

    await expect(createClaimCandidatePacketFromArtifacts(db, {
      spaceId: "space-1",
      ownerUserId: "user-1",
      request: { ...privateRequest(["artifact-brief"]), review_scope: "space_ops" },
    })).rejects.toThrow(/source artifact not found or not visible/);
    expect((await packetDatabase.database.pool.query("SELECT 1 FROM artifacts WHERE id <> 'artifact-brief'")).rowCount).toBe(0);
    expect(await storedProposals()).toHaveLength(0);
  });
});
