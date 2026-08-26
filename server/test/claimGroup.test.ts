import { beforeEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { buildClaimTrajectory, scanClaimContradictions } from "../src/modules/knowledge/claimReviewLoop.js";
import { registerKnowledgeProposalAppliers } from "../src/modules/knowledge/proposalApplier.js";
import type { ApplyProposal } from "../src/modules/memory/memoryApplyRepository.js";
import { ProposalApplierRegistry } from "../src/modules/proposals/applierRegistry.js";
import { handleSourceRetrievalTestSql } from "./support/sourceRetrievalTestSql.js";
import { resetTables } from "./support/resetTables.js";
import { useTestDatabase } from "./support/testDatabase.js";

describe("claimProposalApplier", () => {
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
});

describe("claimReviewLoopDb", () => {
  // Real-PostgreSQL coverage for the Slice E claim review loop. FakeDb unit tests
  // can't catch SQL-facing bugs in CLAIM_COLUMNS/CLAIM_FROM joins or the readable
  // space-object visibility gate, so this exercises the real queries.

  const SPACE = "11111111-1111-4111-8111-111111111111";
  const VIEWER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const OTHER = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const SUBJECT = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";


  const db = useTestDatabase(`${import.meta.filename}#claimReviewLoopDb`);

  beforeEach(async () => {
    if (!db.available) return;
    await resetTables(
      db.pool,
      ["claim_sources", "source_connections", "source_provider_connectors", "source_providers", "source_connectors", "claims", "space_objects", "users", "spaces"],
      { cascade: true },
    );
    for (const id of [VIEWER, OTHER]) {
      await db.pool.query(
        `INSERT INTO users (id, display_name, status, created_at, updated_at)
         VALUES ($1, 'User', 'active', now(), now())`,
        [id],
      );
    }
    await db.pool.query(
      `INSERT INTO spaces (id, name, type, created_by_user_id, created_at, updated_at)
       VALUES ($1, 'Claim Review Loop Space', 'household', $2, now(), now())`,
      [SPACE, VIEWER],
    );
    await db.pool.query(
      `INSERT INTO space_memberships (id, space_id, user_id, role, status, created_at, updated_at)
       VALUES (gen_random_uuid()::varchar, $1, $2, 'owner', 'active', now(), now())`,
      [SPACE, VIEWER],
    );
    // Subject the seeded claims point at (claims.subject_object_id has an FK to
    // space_objects).
    await db.pool.query(
      `INSERT INTO space_objects (id, space_id, object_type, title, summary, visibility, owner_user_id, created_by_user_id, created_at, updated_at) VALUES ($1, $2, 'knowledge_item', 'Subject', 'Subject', 'space_shared', $3, $3, now(), now())`,
      [SUBJECT, SPACE, VIEWER],
    );
  });

  interface InsertClaimInput {
    id: string;
    claimText: string;
    subjectObjectId?: string | null;
    subjectText?: string | null;
    claimKind?: string;
    status?: string;
    visibility?: string;
    ownerUserId?: string | null;
    confidence?: number;
    resolutionState?: string;
    createdAt?: string;
  }

  async function insertClaim(input: InsertClaimInput): Promise<void> {
    const createdAt = input.createdAt ?? "2026-01-01T00:00:00.000Z";
    const owner = input.ownerUserId === undefined ? VIEWER : input.ownerUserId;
    await db.pool.query(
      `INSERT INTO space_objects (id, space_id, object_type, title, summary, visibility, owner_user_id, created_by_user_id, created_at, updated_at) VALUES ($1, $2, 'claim', $3, left($4, 200), $5, $6, $6, $7::timestamptz, $7::timestamptz)`,
      [input.id, SPACE, input.claimText.slice(0, 60), input.claimText, input.visibility ?? "space_shared", owner, createdAt],
    );
    await db.pool.query(
      `INSERT INTO claims (
         object_id, space_id, status, subject_object_id, subject_text, claim_kind,
         claim_text, normalized_claim_hash, confidence, confidence_method,
         resolution_state, valid_from, metadata_json
       ) VALUES ($1, $2, $10, $3, $4, $5, $6, md5($6), $7, 'human_confirmed', $8, $9::timestamptz, '{}'::jsonb)`,
      [
        input.id,
        SPACE,
        input.subjectObjectId === undefined ? SUBJECT : input.subjectObjectId,
        input.subjectText ?? null,
        input.claimKind ?? "fact",
        input.claimText,
        input.confidence ?? 0.5,
        input.resolutionState ?? "unreviewed",
        createdAt,
        input.status ?? "active",
      ],
    );
  }

  async function insertSourceConnection(input: { id: string; connectorId: string; ownerUserId: string }): Promise<void> {
    await db.pool.query(
      `INSERT INTO source_connectors (
         id, connector_key, display_name, connector_type, ingestion_mode, status,
         capabilities_json, created_at, updated_at
       ) VALUES ($1, $2, 'Test connector', 'external_url', 'manual', 'active', '{}'::jsonb, now(), now())`,
      [input.connectorId, `test-${input.connectorId}`],
    );
    await db.pool.query(
      `INSERT INTO source_providers (id, provider_key, display_name, provider_kind, category, status, capabilities_json, created_at, updated_at)
       VALUES ($1, $2, 'Test provider', 'generic', 'test', 'active', '{}'::jsonb, now(), now())`,
      [input.connectorId, `test-${input.connectorId}`],
    );
    await db.pool.query(
      `INSERT INTO source_provider_connectors (id, provider_id, connector_id, status, priority, capabilities_json, created_at, updated_at)
       VALUES ($1,$1,$1,'active',0,'{}'::jsonb,now(),now())`,
      [input.connectorId],
    );
    const consent = {
      schema_version: 1,
      owner_user_id: input.ownerUserId,
      allowed_reader_user_ids: [],
      allowed_agent_ids: [],
      allow_space_admins: false,
      allow_local_provider_egress: true,
      allow_external_model_egress: true,
    };
    const policy = {
      schema_version: 1,
      source_egress_class: "external_provider_allowed",
    };
    await db.pool.query(
      `INSERT INTO source_connections (
         id, space_id, provider_connector_id, owner_user_id, name, status,
         capture_policy, trust_level, topic_hints_json, consent_json, policy_json,
         config_json, created_at, updated_at
       ) VALUES (
         $1, $2, $3, $4, 'Denied source', 'active',
         'reference_only', 'normal', '[]'::jsonb, $5::jsonb, $6::jsonb,
         '{}'::jsonb, now(), now()
       )`,
      [input.id, SPACE, input.connectorId, input.ownerUserId, JSON.stringify(consent), JSON.stringify(policy)],
    );
  }

  async function insertClaimSource(input: { id: string; claimId: string; sourceConnectionId: string }): Promise<void> {
    await db.pool.query(
      `INSERT INTO claim_sources (
         id, space_id, claim_id, source_connection_id, evidence_role,
         source_trust, confidence, metadata_json, created_by_user_id, created_at
       ) VALUES ($1, $2, $3, $4, 'supports', 'normal', 0.8, '{}'::jsonb, $5, now())`,
      [input.id, SPACE, input.claimId, input.sourceConnectionId, VIEWER],
    );
  }

  describe("Slice E claim review loop (real Postgres)", () => {
    it("builds trajectory signals over visible claims about a subject", async () => {
      if (!db.available) return;
      await insertClaim({ id: "c1", claimText: "Plan ships in Q1.", status: "superseded", confidence: 0.4, createdAt: "2026-01-01T00:00:00.000Z" });
      await insertClaim({ id: "c2", claimText: "Plan ships in Q2.", status: "active", confidence: 0.9, createdAt: "2026-02-01T00:00:00.000Z" });

      const result = await buildClaimTrajectory(db.pool, { spaceId: SPACE, userId: VIEWER, subjectObjectId: SUBJECT, limit: 100 });
      expect(result.points.map((p) => p.claim_id)).toEqual(["c1", "c2"]);
      const kinds = result.signals.map((s) => s.kind);
      expect(kinds).toContain("supersession");
      expect(kinds).toContain("confidence_shift");
    });

    it("filters trajectory claims whose source policy denies the viewer", async () => {
      if (!db.available) return;
      const connectionId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
      await insertClaim({ id: "c1", claimText: "Plan ships in Q1.", createdAt: "2026-01-01T00:00:00.000Z" });
      await insertClaim({ id: "c2", claimText: "Plan ships in Q2.", createdAt: "2026-02-01T00:00:00.000Z" });
      await insertSourceConnection({
        id: connectionId,
        connectorId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
        ownerUserId: OTHER,
      });
      await insertClaimSource({ id: "claim-source-denied", claimId: "c2", sourceConnectionId: connectionId });

      const result = await buildClaimTrajectory(db.pool, { spaceId: SPACE, userId: VIEWER, subjectObjectId: SUBJECT, limit: 100 });

      expect(result.points.map((point) => point.claim_id)).toEqual(["c1"]);
      expect(result.canonical_write_performed).toBe(false);
    });

    it("scan flags a negation contradiction and excludes claims the viewer cannot read", async () => {
      if (!db.available) return;
      await insertClaim({ id: "a", claimText: "The backup job runs every night." });
      await insertClaim({ id: "b", claimText: "The backup job does not run every night." });
      // Same subject + contradicting, but private to OTHER -> the viewer must not
      // see it, so no extra pairing leaks a hidden claim.
      await insertClaim({ id: "hidden", claimText: "The backup job never runs.", visibility: "private", ownerUserId: OTHER });

      const report = await scanClaimContradictions(db.pool, { spaceId: SPACE, userId: VIEWER, limit: 200, maxFindings: 40 });
      expect(report.candidates_examined).toBe(2);
      expect(report.findings).toHaveLength(1);
      expect(report.findings[0]!.signal).toBe("negation");
      expect(report.findings[0]!.proposed_action).toMatchObject({ link_type: "contradicts" });
    });
  });
});
