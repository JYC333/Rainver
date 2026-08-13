import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config";
import type { ApplyProposal } from "../src/modules/memory/memoryApplyRepository";
import { ProposalApplierRegistry } from "../src/modules/proposals/applierRegistry";
import { registerKnowledgeProposalAppliers } from "../src/modules/knowledge/proposalApplier";
import { handleSourceRetrievalTestSql } from "./helpers/sourceRetrievalTestSql";

const NOW = "2026-06-24T10:00:00.000Z";

class ClaimApplyFakeDb {
  readonly claims = new Map<string, Record<string, unknown>>();
  readonly objects = new Map<string, Record<string, unknown>>();
  readonly objectRelations = new Map<string, Record<string, unknown>>();
  readonly writes: string[] = [];

  constructor() {
    this.addClaim("claim-1", { status: "active", metadata_json: {} });
    this.addClaim("claim-2", { status: "active", title: "Replacement claim", metadata_json: {} });
    this.objects.set("project-1", spaceObject({ id: "project-1", object_type: "project", title: "Project" }));
    this.objects.set("task-1", spaceObject({ id: "task-1", object_type: "task", title: "Task" }));
  }

  addClaim(id: string, overrides: Record<string, unknown> = {}): void {
    const row = claimRow({ id, ...overrides });
    this.claims.set(id, row);
    this.objects.set(id, spaceObject({
      id,
      object_type: "claim",
      title: String(row.title),
      status: String(row.status),
      visibility: String(row.visibility),
      owner_user_id: row.owner_user_id,
      created_by_user_id: row.created_by_user_id,
    }));
  }

  async query(sql: string, params: readonly unknown[] = []) {
    const norm = sql.replace(/\s+/g, " ").trim();
    if (norm.startsWith("SAVEPOINT") || norm.startsWith("RELEASE SAVEPOINT") || norm.startsWith("ROLLBACK TO SAVEPOINT")) {
      return { rows: [], rowCount: 0 };
    }
    const retrievalResult = handleSourceRetrievalTestSql(sql, params);
    if (retrievalResult) return retrievalResult;
    if (norm.includes("AS effective_access_level")) {
      const row = this.objects.get(String(params[1]));
      return {
        rows: row ? [{ effective_access_level: "full" }] : [],
        rowCount: row ? 1 : 0,
      };
    }
    if (norm.includes("FROM claims c JOIN space_objects so")) {
      const row = this.claims.get(String(params[0]));
      return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
    }
    if (norm.includes("FROM claim_sources")) {
      return { rows: [], rowCount: 0 };
    }
    // Space-object lookup by id. `status` is no longer a column on
    // space_objects — it is derived from the ontology extension tables — so the
    // projection is alias-qualified. Match the query's shape rather than a
    // literal column-list prefix, which broke the moment the projection moved.
    if (/FROM space_objects so\b/.test(norm) && /WHERE so\.id = \$1/.test(norm)) {
      const row = this.objects.get(String(params[0]));
      return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
    }
    if (norm.startsWith("SELECT id FROM object_relations")) {
      return { rows: [], rowCount: 0 };
    }
    if (norm.startsWith("WITH obj AS ( UPDATE space_objects")) {
      this.writes.push("claim_update");
      const claimId = String(params[0]);
      const row = this.claims.get(claimId);
      if (row) {
        row.status = params[5];
        row.visibility = params[6];
        row.resolution_state = params[18];
        row.updated_at = params[23];
        if (params[26]) row.metadata_json = JSON.parse(String(params[27]));
      }
      const object = this.objects.get(claimId);
      if (object) {
        object.status = params[5];
        object.visibility = params[6];
        object.updated_at = params[23];
      }
      return { rows: [], rowCount: 1 };
    }
    if (norm.startsWith("UPDATE space_objects SET status = 'archived'")) {
      this.writes.push("claim_archive");
      const claimId = String(params[0]);
      const row = this.claims.get(claimId);
      if (row) {
        row.status = "archived";
        row.archived_at = params[2];
      }
      const object = this.objects.get(claimId);
      if (object) {
        object.status = "archived";
        object.archived_at = params[2];
      }
      return { rows: [], rowCount: 1 };
    }
    if (norm.startsWith("INSERT INTO object_relations")) {
      this.writes.push("object_relation_create");
      const id = String(params[0]);
      this.objectRelations.set(id, {
        id,
        space_id: params[1],
        from_object_id: params[2],
        to_object_id: params[3],
        link_type: params[4],
        status: params[5],
        confidence: params[6],
        evidence_summary: params[7],
        source_claim_id: params[8],
        source_object_id: params[9],
        source_proposal_id: params[10],
        metadata_json: JSON.parse(String(params[11])),
        created_by_user_id: params[12],
        created_by_agent_id: null,
        created_at: params[13],
        updated_at: params[13],
      });
      return { rows: [], rowCount: 1 };
    }
    if (norm.includes("FROM object_relations r JOIN space_objects from_so")) {
      const row = this.objectRelations.get(String(params[0]));
      if (!row) return { rows: [], rowCount: 0 };
      const from = this.objects.get(String(row.from_object_id));
      const to = this.objects.get(String(row.to_object_id));
      return {
        rows: [{
          ...row,
          from_object_type: from?.object_type ?? null,
          to_object_type: to?.object_type ?? null,
        }],
        rowCount: 1,
      };
    }
    if (norm.startsWith("DELETE FROM retrieval_edges") || norm.startsWith("DELETE FROM retrieval_objects")) {
      return { rows: [], rowCount: 0 };
    }
    return { rows: [], rowCount: 0 };
  }
}

describe("Claim proposal applier", () => {
  it("rejects invalid Claim status transitions", async () => {
    const db = new ClaimApplyFakeDb();

    await expect(apply(db, proposal("claim_create", {
      operation: "claim_create",
      claim_kind: "fact",
      subject_text: "Subject",
      claim_text: "Archived create is invalid.",
      status: "archived",
    }))).rejects.toThrow(/claim_create status must be active, disputed, or rejected/);

    await expect(apply(db, proposal("claim_update", {
      operation: "claim_update",
      target_claim_id: "claim-1",
      status: "rejected",
    }))).rejects.toThrow(/invalid Claim status transition: active -> rejected/);

    await expect(apply(db, proposal("claim_update", {
      operation: "claim_update",
      target_claim_id: "claim-1",
      status: "disputed",
      resolution_state: "confirmed",
    }))).rejects.toThrow(/disputed Claims require resolution_state contradicted or needs_source/);

    await expect(apply(db, proposal("claim_update", {
      operation: "claim_update",
      target_claim_id: "claim-1",
      status: "superseded",
    }))).rejects.toThrow(/superseded Claims require superseded_by_claim_id or an active supersedes relation/);

    expect(db.writes).toEqual([]);
  });

  it("applies Claim supersession only with a successor pointer", async () => {
    const db = new ClaimApplyFakeDb();

    const result = await apply(db, proposal("claim_update", {
      operation: "claim_update",
      target_claim_id: "claim-1",
      status: "superseded",
      superseded_by_claim_id: "claim-2",
    }));

    expect(result.result_type).toBe("claim");
    const claim = result.result.claim as Record<string, unknown>;
    expect(claim).toMatchObject({
      id: "claim-1",
      status: "superseded",
      metadata: { superseded_by_claim_id: "claim-2" },
    });
    expect(db.writes).toContain("claim_update");
  });

  it("returns retrieval projection visibility for wide object relations", async () => {
    const db = new ClaimApplyFakeDb();

    const result = await apply(db, proposal("object_relation_create", {
      operation: "object_relation_create",
      from_object_id: "project-1",
      to_object_id: "task-1",
      link_type: "related_to",
    }));

    expect(result.result_type).toBe("object_relation");
    const objectRelation = result.result.object_relation as Record<string, unknown>;
    expect(objectRelation).toMatchObject({
      from_object_id: "project-1",
      to_object_id: "task-1",
      retrieval_projected: false,
    });
  });

  it("rejects relation metadata that would break typed read models", async () => {
    const db = new ClaimApplyFakeDb();

    await expect(apply(db, proposal("object_relation_create", {
      operation: "object_relation_create",
      from_object_id: "project-1",
      to_object_id: "task-1",
      link_type: "affiliated_with",
      metadata: { start_date: "not-a-date" },
    }))).rejects.toThrow(/invalid timestamp value/);

    await expect(apply(db, proposal("object_relation_create", {
      operation: "object_relation_create",
      from_object_id: "project-1",
      to_object_id: "task-1",
      link_type: "authored_by",
      metadata: { author_position: "first", is_corresponding: "yes" },
    }))).rejects.toThrow(/author_position must be a positive integer or null/);

    expect(db.writes).toEqual([]);
  });

  it("rejects typed relations whose endpoint object types do not match", async () => {
    const db = new ClaimApplyFakeDb();

    await expect(apply(db, proposal("object_relation_create", {
      operation: "object_relation_create",
      from_object_id: "project-1",
      to_object_id: "task-1",
      link_type: "affiliated_with",
      metadata: {},
    }))).rejects.toThrow(/affiliated_with does not accept/);

    await expect(apply(db, proposal("object_relation_create", {
      operation: "object_relation_create",
      from_object_id: "project-1",
      to_object_id: "task-1",
      link_type: "authored_by",
      metadata: { author_position: 1, is_corresponding: false },
    }))).rejects.toThrow(/authored_by does not accept/);

    expect(db.writes).toEqual([]);
  });
});

async function apply(db: ClaimApplyFakeDb, p: ApplyProposal) {
  const registry = new ProposalApplierRegistry();
  registerKnowledgeProposalAppliers(registry);
  return registry.apply({
    config: loadConfig({
      SERVER_DATABASE_URL: "postgresql://server@db:5432/agent_space",
      SERVER_INTERNAL_TOKEN: "internal-token",
    }),
    db: db as never,
    proposal: p,
    userId: "user-1",
  });
}

function proposal(proposalType: string, payload: Record<string, unknown>): ApplyProposal {
  return {
    id: "proposal-1",
    space_id: "space-1",
    proposal_type: proposalType,
    title: proposalType,
    project_folder_id: null,
    project_id: null,
    created_by_user_id: "user-1",
    created_by_run_id: null,
    payload_json: payload,
  };
}

function claimRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "claim-1",
    space_id: "space-1",
    subject_object_id: null,
    subject_text: "Subject",
    claim_kind: "fact",
    claim_text: "Claim text.",
    normalized_claim_hash: "hash-1",
    holder_object_id: null,
    holder_type: null,
    holder_id: null,
    confidence: 0.9,
    confidence_method: "human_confirmed",
    resolution_state: "confirmed",
    valid_from: null,
    valid_until: null,
    observed_at: null,
    metadata_json: {},
    status: "active",
    visibility: "space_shared",
    title: "Claim",
    excerpt: null,
    owner_user_id: "user-1",
    project_id: null,
    project_folder_id: null,
    created_by_user_id: "user-1",
    created_by_agent_id: null,
    created_by_run_id: null,
    created_from_proposal_id: "proposal-source",
    approved_by_user_id: "user-1",
    archived_at: null,
    created_at: NOW,
    updated_at: NOW,
    ...overrides,
  };
}

function spaceObject(overrides: Record<string, unknown> = {}) {
  return {
    id: "object-1",
    space_id: "space-1",
    object_type: "claim",
    title: "Object",
    status: "active",
    visibility: "space_shared",
    owner_user_id: "user-1",
    primary_project_id: null,
    project_folder_id: null,
    created_by_user_id: "user-1",
    ...overrides,
  };
}
