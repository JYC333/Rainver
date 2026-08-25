import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { getTestPostgres, isTestPostgresUnavailableError, type TestPostgresDatabase } from "./support/sharedPostgres";
import { resetTables } from "./support/resetTables";
import { RetrievalMaintenanceService, RetrievalProjectionService } from "../src/modules/retrieval";
import { knowledgeRetrievalRegistry } from "../src/modules/knowledge/retrievalAdapter";
import { insertKnowledgeItem } from "./support/knowledgeFixtures";

// W7 maintenance scan over real Postgres. Proves the scan finds the batched
// review-candidate kinds (duplicate / orphan / thin / relation_suggestion),
// clusters duplicates, is access-safe (a private object owned by another user is
// never surfaced — and a duplicate cluster that loses a member to revalidation is
// discarded), and writes NOTHING canonical.

const SPACE = "11111111-1111-4111-8111-111111111111";
const VIEWER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OTHER = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

const LONG = "This page has more than enough searchable content to clear the thin threshold comfortably here.";

let container: TestPostgresDatabase | undefined;
let pool: Pool | undefined;
let available = false;

beforeAll(async () => {
  try {
    container = await getTestPostgres(__filename);
    pool = new Pool({ connectionString: container.getConnectionUri(), max: 3 });
    available = true;
  } catch (err) {
    if (!isTestPostgresUnavailableError(err)) throw err;
    console.warn(
      `[retrieval-maintenance-db] skipped — Docker/Postgres unavailable: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}, 180_000);

afterAll(async () => {
  await pool?.end();
  await container?.stop();
});

beforeEach(async () => {
  if (!available || !pool) return;
  await resetTables(
    pool,
    ["retrieval_objects", "retrieval_aliases", "retrieval_chunks", "retrieval_edges", "knowledge_items", "space_objects", "users", "spaces"],
    { cascade: true },
  );
  await pool.query(`INSERT INTO spaces (id, name, type, created_at, updated_at) VALUES ($1, 'Maint', 'personal', now(), now())`, [SPACE]);
  for (const id of [VIEWER, OTHER]) {
    await pool.query(`INSERT INTO users (id, display_name, status, created_at, updated_at) VALUES ($1, 'U', 'active', now(), now())`, [id]);
  }
  await pool.query(
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
  await insertKnowledgeItem(pool!, {
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
  await new RetrievalProjectionService(pool!, knowledgeRetrievalRegistry).reindexAll(SPACE);
}

describe("Retrieval maintenance scan (real Postgres)", () => {
  it("emits batched review candidates and clusters duplicates", async () => {
    if (!available || !pool) return;
    await seedAll();
    const report = await new RetrievalMaintenanceService(pool, knowledgeRetrievalRegistry).scan(SPACE, VIEWER);

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
    if (!available || !pool) return;
    await seedAll();
    const report = await new RetrievalMaintenanceService(pool, knowledgeRetrievalRegistry).scan(SPACE, VIEWER);

    const allIds = report.findings.flatMap((f) => f.objects.map((o) => o.object_id));
    expect(allIds).not.toContain("beta-secret"); // never surfaced in any finding
    // The Beta duplicate cluster had one readable + one private member ⇒ no finding.
    const betaDup = report.findings.find(
      (f) => f.kind === "duplicate" && f.objects.some((o) => o.object_id === "beta-public"),
    );
    expect(betaDup).toBeUndefined();
  });

  it("writes nothing canonical (read-only over the derived projection)", async () => {
    if (!available || !pool) return;
    await seedAll();
    const before = await pool.query<{ n: string }>(`SELECT count(*) AS n FROM knowledge_items`);
    await new RetrievalMaintenanceService(pool, knowledgeRetrievalRegistry).scan(SPACE, VIEWER);
    const after = await pool.query<{ n: string }>(`SELECT count(*) AS n FROM knowledge_items`);
    expect(after.rows[0]!.n).toBe(before.rows[0]!.n);
    // No relations were accepted; the suggested edge stays suggested, not canonical.
    const rels = await pool.query<{ n: string }>(`SELECT count(*) AS n FROM object_relations`);
    expect(rels.rows[0]!.n).toBe("0");
  });

  it("respects the per-kind cap and reports truncation", async () => {
    if (!available || !pool) return;
    // 4 thin pages with a per-kind cap of 2 ⇒ truncated, only 2 thin findings.
    for (let i = 0; i < 4; i++) await seed({ id: `t-${i}`, title: `T${i}`, content: "x" });
    await new RetrievalProjectionService(pool, knowledgeRetrievalRegistry).reindexAll(SPACE);
    const report = await new RetrievalMaintenanceService(pool, knowledgeRetrievalRegistry, {
      thinTextChars: 120,
      staleAfterDays: 365,
      perKindLimit: 2,
    }).scan(SPACE, VIEWER);
    expect(report.findings.filter((f) => f.kind === "thin")).toHaveLength(2);
    expect(report.truncated).toBe(true);
  });

  it("flags stale objects by CANONICAL content age, not reindex time", async () => {
    if (!available || !pool) return;
    // `old` was edited long ago; `recent` just now. Both are reindexed together
    // (same projection/indexed time), so only the canonical source_updated_at can
    // tell them apart — `old` is stale, `recent` is not.
    const longAgo = new Date(Date.now() - 800 * 86_400_000).toISOString();
    await seed({ id: "old-doc", title: "Ancient runbook", content: "Ancient but substantial runbook content here." });
    await seed({ id: "recent-doc", title: "Fresh runbook", content: "Freshly written runbook content here." });
    // Force the canonical timestamps after seed (seed() sets root created_at/updated_at to now()).
    await pool.query(
      `UPDATE space_objects
          SET updated_at = $2
        WHERE id = $1 AND object_type = 'knowledge_item'`,
      ["old-doc", longAgo],
    );
    await new RetrievalProjectionService(pool, knowledgeRetrievalRegistry).reindexAll(SPACE);

    const report = await new RetrievalMaintenanceService(pool, knowledgeRetrievalRegistry, {
      thinTextChars: 120,
      staleAfterDays: 365,
      perKindLimit: 50,
    }).scan(SPACE, VIEWER);
    const staleIds = report.findings.filter((f) => f.kind === "stale").map((f) => f.objects[0]!.object_id);
    expect(staleIds).toContain("old-doc");
    expect(staleIds).not.toContain("recent-doc"); // reindexed at the same time, but canonically fresh
  });
});
