import { beforeEach, describe, expect, it } from "vitest";
import { knowledgeRetrievalRegistry } from "../src/modules/knowledge/retrievalAdapter.js";
import { ProposalApplierRegistry } from "../src/modules/proposals/applierRegistry.js";
import { type MaintenanceReport, RetrievalMaintenanceService } from "../src/modules/retrieval/maintenance/service.js";
import { RetrievalProjectionService } from "../src/modules/retrieval/projectionService.js";
import { createRetrievalMaintenanceProposalPacket, persistRetrievalMaintenanceReportArtifact, registerRetrievalMaintenanceProposalAppliers, RETRIEVAL_MAINTENANCE_PACKET_PROPOSAL_TYPE, RETRIEVAL_MAINTENANCE_REPORT_ARTIFACT_TYPE } from "../src/modules/retrieval/maintenance/artifacts.js";
import type { Queryable } from "../src/modules/routeUtils/common.js";
import { insertKnowledgeItem } from "./support/knowledgeFixtures.js";
import { resetTables } from "./support/resetTables.js";
import { useTestDatabase } from "./support/testDatabase.js";

describe("retrievalMaintenanceDb", () => {
  // W7 maintenance scan over real Postgres. Proves the scan finds the batched
  // review-candidate kinds (duplicate / orphan / thin / relation_suggestion),
  // clusters duplicates, is access-safe (a private object owned by another user is
  // never surfaced — and a duplicate cluster that loses a member to revalidation is
  // discarded), and writes NOTHING canonical.

  const SPACE = "11111111-1111-4111-8111-111111111111";
  const VIEWER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const OTHER = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

  const LONG = "This page has more than enough searchable content to clear the thin threshold comfortably here.";


  const db = useTestDatabase(`${import.meta.filename}#retrievalMaintenanceDb`);

  beforeEach(async () => {
    if (!db.available) return;
    await resetTables(
      db.pool,
      ["retrieval_objects", "retrieval_aliases", "retrieval_chunks", "retrieval_edges", "knowledge_items", "space_objects", "users", "spaces"],
      { cascade: true },
    );
    await db.pool.query(`INSERT INTO spaces (id, name, type, created_at, updated_at) VALUES ($1, 'Maint', 'personal', now(), now())`, [SPACE]);
    for (const id of [VIEWER, OTHER]) {
      await db.pool.query(`INSERT INTO users (id, display_name, status, created_at, updated_at) VALUES ($1, 'U', 'active', now(), now())`, [id]);
    }
    await db.pool.query(
      `INSERT INTO space_memberships (id, space_id, user_id, role, status, created_at, updated_at)
       VALUES ('maintenance-viewer', $1, $2, 'owner', 'active', now(), now())`,
      [SPACE, VIEWER],
    );
  });

  async function seed(doc: {
    id: string;
    title: string;
    content: string;
    visibility?: string;
    owner?: string | null;
  }): Promise<void> {
    await insertKnowledgeItem(db.pool, {
      id: doc.id,
      spaceId: SPACE,
      title: doc.title,
      content: doc.content,
      slug: doc.id,
      visibility: doc.visibility ?? "space_shared",
      ownerUserId: doc.owner ?? null,
      createdByUserId: doc.owner ?? null,
    });
  }

  async function seedAll(): Promise<void> {
    // Duplicate cluster with TWO readable members.
    await seed({ id: "alpha-1", title: "Alpha Concept", content: `Alpha one. ${LONG}` });
    await seed({ id: "alpha-2", title: "Alpha Concept", content: `Alpha two. ${LONG}` });
    // Duplicate cluster where one member is private and owned by OTHER (must be
    // dropped, leaving < 2 readable ⇒ no finding, and never surfaced).
    await seed({ id: "beta-public", title: "Beta Concept", content: `Beta public. ${LONG}` });
    await seed({ id: "beta-secret", title: "Beta Concept", content: `Beta secret. ${LONG}`, visibility: "private", owner: OTHER });
    // Orphan (no links) and thin (sparse content).
    await seed({ id: "orphan-x", title: "Lonely Orphan Page", content: `Orphan. ${LONG}` });
    await seed({ id: "thin-y", title: "Tiny", content: "x" });
    // Relation suggestion via an extracted wikilink (linker → target), so neither
    // is an orphan and a suggested edge is projected.
    await seed({ id: "linker", title: "Linker Page", content: `See [[Target Page]] for details. ${LONG}` });
    await seed({ id: "target", title: "Target Page", content: `Target. ${LONG}` });
    await new RetrievalProjectionService(db.pool, knowledgeRetrievalRegistry).reindexAll(SPACE);
  }

  describe("Retrieval maintenance scan (real Postgres)", () => {
    it("emits batched review candidates and clusters duplicates", async () => {
      if (!db.available) return;
      await seedAll();
      const report = await new RetrievalMaintenanceService(db.pool, knowledgeRetrievalRegistry).scan(SPACE, VIEWER);

      const duplicates = report.findings.filter((f) => f.kind === "duplicate");
      const alpha = duplicates.find((f) => f.objects.some((o) => o.object_id === "alpha-1"));
      expect(alpha).toBeDefined();
      expect(alpha!.objects.map((o) => o.object_id).sort()).toEqual(["alpha-1", "alpha-2"]);

      expect(report.findings.some((f) => f.kind === "orphan" && f.objects[0]!.object_id === "orphan-x")).toBe(true);
      expect(report.findings.some((f) => f.kind === "thin" && f.objects[0]!.object_id === "thin-y")).toBe(true);

      const relation = report.findings.find((f) => f.kind === "relation_suggestion");
      expect(relation).toBeDefined();
      expect(relation!.objects.map((o) => o.object_id).sort()).toEqual(["linker", "target"]);

      expect(report.truncated).toBe(false);
      expect(report.counts.duplicate).toBeGreaterThanOrEqual(1);
    });

    it("is access-safe: a private object owned by another user never appears, and its cluster collapses", async () => {
      if (!db.available) return;
      await seedAll();
      const report = await new RetrievalMaintenanceService(db.pool, knowledgeRetrievalRegistry).scan(SPACE, VIEWER);

      const allIds = report.findings.flatMap((f) => f.objects.map((o) => o.object_id));
      expect(allIds).not.toContain("beta-secret"); // never surfaced in any finding
      // The Beta duplicate cluster had one readable + one private member ⇒ no finding.
      const betaDup = report.findings.find(
        (f) => f.kind === "duplicate" && f.objects.some((o) => o.object_id === "beta-public"),
      );
      expect(betaDup).toBeUndefined();
    });

    it("writes nothing canonical (read-only over the derived projection)", async () => {
      if (!db.available) return;
      await seedAll();
      const before = await db.pool.query<{ n: string }>(`SELECT count(*) AS n FROM knowledge_items`);
      await new RetrievalMaintenanceService(db.pool, knowledgeRetrievalRegistry).scan(SPACE, VIEWER);
      const after = await db.pool.query<{ n: string }>(`SELECT count(*) AS n FROM knowledge_items`);
      expect(after.rows[0]!.n).toBe(before.rows[0]!.n);
      // No relations were accepted; the suggested edge stays suggested, not canonical.
      const rels = await db.pool.query<{ n: string }>(`SELECT count(*) AS n FROM object_relations`);
      expect(rels.rows[0]!.n).toBe("0");
    });

    it("respects the per-kind cap and reports truncation", async () => {
      if (!db.available) return;
      // 4 thin pages with a per-kind cap of 2 ⇒ truncated, only 2 thin findings.
      for (let i = 0; i < 4; i++) await seed({ id: `t-${i}`, title: `T${i}`, content: "x" });
      await new RetrievalProjectionService(db.pool, knowledgeRetrievalRegistry).reindexAll(SPACE);
      const report = await new RetrievalMaintenanceService(db.pool, knowledgeRetrievalRegistry, {
        thinTextChars: 120,
        staleAfterDays: 365,
        perKindLimit: 2,
      }).scan(SPACE, VIEWER);
      expect(report.findings.filter((f) => f.kind === "thin")).toHaveLength(2);
      expect(report.truncated).toBe(true);
    });

    it("flags stale objects by CANONICAL content age, not reindex time", async () => {
      if (!db.available) return;
      // `old` was edited long ago; `recent` just now. Both are reindexed together
      // (same projection/indexed time), so only the canonical source_updated_at can
      // tell them apart — `old` is stale, `recent` is not.
      const longAgo = new Date(Date.now() - 800 * 86_400_000).toISOString();
      await seed({ id: "old-doc", title: "Ancient runbook", content: "Ancient but substantial runbook content here." });
      await seed({ id: "recent-doc", title: "Fresh runbook", content: "Freshly written runbook content here." });
      // Force the canonical timestamps after seed (seed() sets root created_at/updated_at to now()).
      await db.pool.query(
        `UPDATE space_objects
            SET updated_at = $2
          WHERE id = $1 AND object_type = 'knowledge_item'`,
        ["old-doc", longAgo],
      );
      await new RetrievalProjectionService(db.pool, knowledgeRetrievalRegistry).reindexAll(SPACE);

      const report = await new RetrievalMaintenanceService(db.pool, knowledgeRetrievalRegistry, {
        thinTextChars: 120,
        staleAfterDays: 365,
        perKindLimit: 50,
      }).scan(SPACE, VIEWER);
      const staleIds = report.findings.filter((f) => f.kind === "stale").map((f) => f.objects[0]!.object_id);
      expect(staleIds).toContain("old-doc");
      expect(staleIds).not.toContain("recent-doc"); // reindexed at the same time, but canonically fresh
    });
  });
});

describe("retrievalMaintenancePersistence", () => {
  interface CapturedQuery {
    sql: string;
    params: readonly unknown[];
  }

  function fakeDb(): Queryable & { calls: CapturedQuery[] } {
    const calls: CapturedQuery[] = [];
    return {
      calls,
      async query<Row = Record<string, unknown>>(sql: string, params: readonly unknown[] = []) {
        calls.push({ sql, params });
        // Every INSERT this fake handles (proposals, artifacts) puts the
        // generated id first; echo it back so callers relying on
        // `RETURNING id` (e.g. insertProposalRow) get a usable row. The
        // lineage-key lookup SELECT must keep returning "not found" so
        // create-packet calls don't short-circuit on a fake match.
        if (/^\s*INSERT/i.test(sql)) {
          return { rows: [{ id: params[0] }] as Row[], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      },
    };
  }

  function report(): MaintenanceReport {
    return {
      findings: [
        {
          kind: "relation_suggestion",
          objects: [
            { object_type: "knowledge_item", object_id: "item-a", title: "A" },
            { object_type: "knowledge_item", object_id: "item-b", title: "B" },
          ],
          reason: "suggested related_to relation from extracted links",
          proposed_action: {
            proposal_type: "object_relation_create",
            title: "Relate: A -> B",
            payload: {
              operation: "object_relation_create",
              from_object_id: "item-a",
              to_object_id: "item-b",
              link_type: "related_to",
              status: "candidate",
              confidence: null,
              evidence_summary: "suggested related_to relation from extracted links",
            },
          },
        },
        {
          kind: "thin",
          objects: [{ object_type: "knowledge_item", object_id: "item-c", title: "C" }],
          reason: "sparse searchable content",
        },
      ],
      counts: { duplicate: 0, orphan: 0, thin: 1, stale: 0, relation_suggestion: 1 },
      scanned: 3,
      truncated: false,
    };
  }

  describe("retrieval maintenance persistence", () => {
    it("persists maintenance reports as owner-private artifacts", async () => {
      const db = fakeDb();
      const artifactId = await persistRetrievalMaintenanceReportArtifact(db, {
        spaceId: "space-1",
        ownerUserId: "user-1",
        report: report(),
        source: "knowledge_retrieval_maintenance",
      });

      expect(artifactId).toMatch(/[0-9a-f-]{36}/);
      expect(db.calls).toHaveLength(1);
      const params = db.calls[0]!.params;
      expect(params[1]).toBe("space-1");
      expect(params[4]).toBe(RETRIEVAL_MAINTENANCE_REPORT_ARTIFACT_TYPE);
      expect(params[15]).toBe("user-1");
      expect(params[2]).toBeNull();
      const metadata = JSON.parse(String(params[13]));
      expect(metadata).toMatchObject({
        kind: RETRIEVAL_MAINTENANCE_REPORT_ARTIFACT_TYPE,
        visibility: "private",
        owner_user_id: "user-1",
        scanned: 3,
      });
    });

    it("can link maintenance reports and packets to the automation run that produced them", async () => {
      const db = fakeDb();
      const artifactId = await persistRetrievalMaintenanceReportArtifact(db, {
        spaceId: "space-1",
        ownerUserId: "user-1",
        runId: "run-1",
        report: report(),
        source: "automation_knowledge_retrieval_maintenance",
      });
      const proposalId = await createRetrievalMaintenanceProposalPacket(db, {
        spaceId: "space-1",
        ownerUserId: "user-1",
        runId: "run-1",
        artifactId,
        report: report(),
        source: "automation_knowledge_retrieval_maintenance",
      });

      expect(proposalId).toMatch(/[0-9a-f-]{36}/);
      const artifactParams = db.calls[0]!.params;
      // db.calls[1] is createRetrievalMaintenanceProposalPacket's internal
      // lineage-key dedup lookup (a SELECT); the INSERT is [2].
      const proposalParams = db.calls[2]!.params;
      expect(artifactParams[2]).toBe("run-1");
      expect(proposalParams[2]).toBe("run-1");
      expect(JSON.parse(String(artifactParams[13]))).toMatchObject({ run_id: "run-1" });
      expect(JSON.parse(String(proposalParams[10]))).toMatchObject({ run_id: "run-1" });
    });

    it("creates a private batched maintenance packet proposal", async () => {
      const db = fakeDb();
      const proposalId = await createRetrievalMaintenanceProposalPacket(db, {
        spaceId: "space-1",
        ownerUserId: "user-1",
        artifactId: "artifact-1",
        report: report(),
        source: "knowledge_retrieval_maintenance",
      });

      expect(proposalId).toMatch(/[0-9a-f-]{36}/);
      // db.calls[0] is the internal lineage-key dedup lookup (a SELECT).
      expect(db.calls).toHaveLength(2);
      const params = db.calls[1]!.params;
      expect(params[1]).toBe("space-1");
      expect(params[3]).toBe(RETRIEVAL_MAINTENANCE_PACKET_PROPOSAL_TYPE);
      expect(params[14]).toBe("user-1");
      const payload = JSON.parse(String(params[10]));
      expect(payload).toMatchObject({
        operation: "retrieval_maintenance_packet",
        report_artifact_id: "artifact-1",
        findings: expect.any(Array),
        generated_child_proposal_ids: [],
      });
    });

    it("accepting a packet creates child proposals, not canonical Knowledge rows", async () => {
      const db = fakeDb();
      const registry = new ProposalApplierRegistry();
      registerRetrievalMaintenanceProposalAppliers(registry);
      const applier = registry.get(RETRIEVAL_MAINTENANCE_PACKET_PROPOSAL_TYPE);
      expect(applier).not.toBeNull();

      const result = await applier!({
        config: {} as never,
        db,
        userId: "user-1",
        proposal: {
          id: "packet-1",
          space_id: "space-1",
          proposal_type: RETRIEVAL_MAINTENANCE_PACKET_PROPOSAL_TYPE,
          title: "Maintenance packet",
          payload_json: {
            operation: "retrieval_maintenance_packet",
            report_artifact_id: "artifact-1",
            findings: report().findings,
          },
          project_folder_id: null,
          created_by_user_id: "user-1",
          created_by_run_id: null,
          project_id: null,
        },
      });

      expect(result).toMatchObject({
        result_type: "retrieval_maintenance_packet",
        result: {
          report_artifact_id: "artifact-1",
          generated_child_proposal_count: 1,
        },
      });
      expect(db.calls.some((call) => /INSERT INTO knowledge_items/.test(call.sql))).toBe(false);
      expect(db.calls.some((call) => /INSERT INTO object_relations/.test(call.sql))).toBe(false);
      // The applier only returns proposalPayloadPatch; ProposalApplyService
      // is the layer that actually issues `UPDATE proposals` from that patch,
      // and is covered by its own tests — this test exercises the applier in
      // isolation.
      expect(result.proposalPayloadPatch?.generated_child_proposal_ids).toHaveLength(1);
    });
  });
});
