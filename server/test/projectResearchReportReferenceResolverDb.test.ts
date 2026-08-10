import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { getTestPostgres, isTestPostgresUnavailableError, type TestPostgresDatabase } from "./support/sharedPostgres";
import { migrate } from "../src/db/migrator";
import { resolveResearchReportReferences } from "../src/modules/projectResearch/reportReferenceResolver";
import { assignReportReferenceIds } from "../src/modules/projectResearch/reportReferenceNumbering";
import type { SpaceUserIdentity } from "../src/modules/routeUtils/common";

// Real-Postgres coverage for evidence_id reference resolution: synthesis
// models cite extracted_evidence rows (sometimes by a truncated id prefix),
// and the resolver must surface readable metadata without leaking rows the
// viewer cannot access.

const MIGRATIONS_DIR = join(process.cwd(), "migrations");
const SPACE = "11111111-1111-4111-8111-111111111111";
const OWNER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OTHER = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

let container: TestPostgresDatabase | undefined;
let pool: Pool | undefined;
let available = false;

beforeAll(async () => {
  try {
    container = await getTestPostgres(__filename);
    pool = new Pool({ connectionString: container.getConnectionUri(), max: 3 });
    await migrate(pool, MIGRATIONS_DIR);
    available = true;
  } catch (err) {
    if (!isTestPostgresUnavailableError(err)) throw err;
    console.warn(`[report-reference-resolver-db] skipped — Docker/Postgres unavailable: ${err instanceof Error ? err.message : String(err)}`);
  }
}, 180_000);

afterAll(async () => {
  await pool?.end();
  await container?.stop();
});

beforeEach(async () => {
  if (!available || !pool) return;
  await pool.query(`TRUNCATE extracted_evidence, source_items, space_memberships, users, spaces CASCADE`);
  const now = new Date().toISOString();
  await pool.query(`INSERT INTO spaces (id, name, type, created_at, updated_at) VALUES ($1,'Main','personal',$2,$2)`, [SPACE, now]);
  for (const user of [OWNER, OTHER]) {
    await pool.query(`INSERT INTO users (id, display_name, status, created_at, updated_at) VALUES ($1,$1,'active',$2,$2)`, [user, now]);
    await pool.query(
      `INSERT INTO space_memberships (id, space_id, user_id, role, status, created_at, updated_at)
       VALUES ($1,$2,$3,'member','active',$4,$4)`,
      [randomUUID(), SPACE, user, now],
    );
  }
});

const identity: SpaceUserIdentity = { spaceId: SPACE, userId: OWNER };

async function insertSourceItem(input: { id: string; createdBy: string; visibility?: string; owner?: string }): Promise<void> {
  const now = new Date().toISOString();
  await pool!.query(
    `INSERT INTO source_items (
       id, space_id, owner_user_id, created_by_user_id, visibility, item_type, title, metadata_json,
       first_seen_at, last_seen_at, content_state, retention_policy, created_at, updated_at
     ) VALUES ($1,$2,$3,$4,$5,'feed_entry','Paper A',$6::jsonb,$7,$7,'excerpt_saved','summary_only',$7,$7)`,
    [input.id, SPACE, input.owner ?? input.createdBy, input.createdBy, input.visibility ?? "space_shared", JSON.stringify({ authors: ["Ada"], year: 2025 }), now],
  );
}

async function insertEvidence(input: { id: string; sourceItemId?: string | null; visibility?: string; owner?: string; sourceAuthor?: string; title?: string }): Promise<void> {
  const now = new Date().toISOString();
  await pool!.query(
    `INSERT INTO extracted_evidence (
       id, space_id, owner_user_id, visibility, source_item_id, source_object_type, evidence_type, title,
       source_author, extraction_method, trust_level, status, created_at, updated_at
     ) VALUES ($1,$2,$3,$4,$5,'source_item','excerpt',$6,$7,'full_text','normal','candidate',$8,$8)`,
    [input.id, SPACE, input.owner ?? OWNER, input.visibility ?? "space_shared", input.sourceItemId ?? null, input.title ?? "Key finding", input.sourceAuthor ?? null, now],
  );
}

function referenceContent(evidenceId: string): Record<string, unknown> {
  return { findings: [{ references: [{ evidence_id: evidenceId }] }], sources: [], ideas: [] };
}

describe("research report evidence reference resolution (real Postgres)", () => {
  it("resolves a full evidence id to its source item metadata", async () => {
    if (!available) return;
    const sourceItemId = randomUUID();
    const evidenceId = randomUUID();
    await insertSourceItem({ id: sourceItemId, createdBy: OWNER });
    await insertEvidence({ id: evidenceId, sourceItemId });

    const result = await resolveResearchReportReferences(pool!, identity, referenceContent(evidenceId));
    expect(result.resolved).toEqual([{
      id: "ref-1", availability: "available", title: "Paper A", authors: ["Ada"], year: 2025,
      library_path: `/library/items/${sourceItemId}`,
    }]);
  });

  it("resolves a truncated evidence id prefix when it is unambiguous", async () => {
    if (!available) return;
    const sourceItemId = randomUUID();
    const evidenceId = "7dd00364-3232-4a62-a147-48afc68c9354";
    await insertSourceItem({ id: sourceItemId, createdBy: OWNER });
    await insertEvidence({ id: evidenceId, sourceItemId });

    const result = await resolveResearchReportReferences(pool!, identity, referenceContent("7dd00364"));
    expect(result.resolved[0]).toMatchObject({ availability: "available", title: "Paper A" });
  });

  it("reports an ambiguous evidence id prefix as unavailable", async () => {
    if (!available) return;
    await insertEvidence({ id: "9a9a9a9a-0000-4000-8000-000000000001" });
    await insertEvidence({ id: "9a9a9a9a-0000-4000-8000-000000000002" });

    const result = await resolveResearchReportReferences(pool!, identity, referenceContent("9a9a9a9a"));
    expect(result.resolved).toEqual([{ id: "ref-1", availability: "unavailable" }]);
  });

  it("does not disclose evidence the viewer cannot read", async () => {
    if (!available) return;
    const evidenceId = randomUUID();
    await insertEvidence({ id: evidenceId, visibility: "private", owner: OTHER });

    const result = await resolveResearchReportReferences(pool!, identity, {
      findings: [{ references: [{ evidence_id: evidenceId, doi: "10.0000/private" }] }], sources: [], ideas: [],
    });
    expect(result.resolved).toEqual([{ id: "ref-1", availability: "unavailable" }]);
    expect(JSON.stringify(result)).not.toContain("Key finding");
    expect(JSON.stringify(result)).not.toContain("10.0000/private");
  });

  it("numbers references per article with lettered excerpts and resolves them grouped", async () => {
    if (!available) return;
    const sourceA = randomUUID();
    const sourceB = randomUUID();
    await insertSourceItem({ id: sourceA, createdBy: OWNER });
    await insertSourceItem({ id: sourceB, createdBy: OWNER });
    const evidenceA1 = "11111111-aaaa-4aaa-8aaa-000000000001";
    const evidenceA2 = "22222222-aaaa-4aaa-8aaa-000000000002";
    const evidenceB1 = randomUUID();
    await insertEvidence({ id: evidenceA1, sourceItemId: sourceA, title: "Excerpt A1" });
    await insertEvidence({ id: evidenceA2, sourceItemId: sourceA, title: "Excerpt A2" });
    await insertEvidence({ id: evidenceB1, sourceItemId: sourceB, title: "Excerpt B1" });

    const numbered = await assignReportReferenceIds(pool!, SPACE, {
      findings: [
        // "11111111" is a truncated model citation; numbering must normalize it.
        { claim: "c1", support: "s", references: [{ evidence_id: "11111111" }, { evidence_id: evidenceA2 }] },
        { claim: "c2", support: "s", references: [{ evidence_id: evidenceB1 }, { evidence_id: evidenceA2 }] },
      ],
      sources: [], ideas: [],
    });
    const findings = numbered.findings as { references: Record<string, unknown>[] }[];
    expect(findings[0]!.references).toEqual([
      { evidence_id: evidenceA1, reference_id: "ref-1a" },
      { evidence_id: evidenceA2, reference_id: "ref-1b" },
    ]);
    expect(findings[1]!.references).toEqual([
      { evidence_id: evidenceB1, reference_id: "ref-2" },
      { evidence_id: evidenceA2, reference_id: "ref-1b" },
    ]);

    const result = await resolveResearchReportReferences(pool!, identity, numbered);
    expect(result.resolved).toEqual([
      {
        id: "ref-1", availability: "available", title: "Paper A", authors: ["Ada"], year: 2025,
        library_path: `/library/items/${sourceA}`,
        excerpts: [{ id: "ref-1a", title: "Excerpt A1" }, { id: "ref-1b", title: "Excerpt A2" }],
      },
      {
        id: "ref-2", availability: "available", title: "Paper A", authors: ["Ada"], year: 2025,
        library_path: `/library/items/${sourceB}`,
      },
    ]);
    expect((result.content.findings as { references: unknown }[])[0]!.references).toEqual([
      { reference_id: "ref-1a" }, { reference_id: "ref-1b" },
    ]);
  });

  it("does not fall back to evidence metadata when its source item is not readable", async () => {
    if (!available) return;
    const sourceItemId = randomUUID();
    const evidenceId = randomUUID();
    await insertSourceItem({ id: sourceItemId, createdBy: OTHER, visibility: "private", owner: OTHER });
    await insertEvidence({ id: evidenceId, sourceItemId, sourceAuthor: "Grace" });

    const result = await resolveResearchReportReferences(pool!, identity, referenceContent(evidenceId));
    expect(result.resolved).toEqual([{ id: "ref-1", availability: "unavailable" }]);
    expect(JSON.stringify(result)).not.toContain("Key finding");
    expect(JSON.stringify(result)).not.toContain("Grace");
    expect(JSON.stringify(result)).not.toContain("Paper A");
  });
});
