import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { getTestPostgres, isTestPostgresUnavailableError, type TestPostgresDatabase } from "./support/sharedPostgres";
import { resetTables } from "./support/resetTables";
import { MemoryMaintenanceService } from "../src/modules/memory/maintenance";
import {
  createMemoryMaintenanceProposalPacket,
  persistMemoryMaintenanceReportArtifact,
} from "../src/modules/memory/maintenanceArtifacts";
import { PgMemoryReadRepository } from "../src/modules/memory/repository";
import { withDbTransaction } from "../src/modules/routeUtils/common";

// Real-PostgreSQL coverage for Memory maintenance. The unit and route tests use
// FakeDb rows; this applies the committed baseline migration to a throwaway DB
// and locks the SQL-facing behavior that fakes cannot catch: grant visibility
// gates, stricter maintenance exclusions, artifact/proposal FKs, access logs,
// and transaction rollback.

const SPACE = "11111111-1111-4111-8111-111111111111";
const VIEWER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OTHER = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

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
      `[memory-maintenance-db] skipped — Docker/Postgres unavailable: ${
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
    ["content_access_logs", "memory_entries", "artifacts", "proposals", "project_members", "projects", "users", "spaces"],
    { cascade: true },
  );
  for (const id of [VIEWER, OTHER]) {
    await pool.query(
      `INSERT INTO users (id, display_name, status, created_at, updated_at)
       VALUES ($1, 'User', 'active', now(), now())`,
      [id],
    );
  }
  await pool.query(
    `INSERT INTO spaces (id, name, type, created_by_user_id, created_at, updated_at)
     VALUES ($1, 'Maintenance Space', 'household', $2, now(), now())`,
    [SPACE, VIEWER],
  );
  for (const id of [VIEWER, OTHER]) {
    await pool.query(
      `INSERT INTO space_memberships
         (id, space_id, user_id, role, status, created_at, updated_at)
       VALUES ($1, $2, $3, 'member', 'active', now(), now())`,
      [randomUUID(), SPACE, id],
    );
  }
});

interface InsertMemoryInput {
  id: string;
  title?: string | null;
  content?: string;
  status?: string;
  visibility?: string;
  access_level?: string;
  sensitivity_level?: string;
  owner_user_id?: string | null;
  scope_type?: string;
  supersedes_memory_id?: string | null;
  updated_at?: string;
}

async function insertMemory(input: InsertMemoryInput): Promise<void> {
  const row: Record<string, unknown> = {
    id: input.id,
    space_id: SPACE,
    scope_type: input.scope_type ?? "user",
    memory_type: "fact",
    title: "title" in input ? input.title : "Maintenance duplicate",
    content: input.content ?? "Readable content long enough for maintenance checks.",
    status: input.status ?? "active",
    visibility: input.visibility ?? "private",
    access_level: input.access_level ?? "full",
    sensitivity_level: input.sensitivity_level ?? "normal",
    confidence: 1,
    importance: 0.5,
    version: 1,
    access_count: 0,
    owner_user_id: input.owner_user_id ?? VIEWER,
    created_by: input.owner_user_id ?? VIEWER,
    created_at: input.updated_at ?? "2026-01-01T00:00:00.000Z",
    updated_at: input.updated_at ?? "2026-01-01T00:00:00.000Z",
    tags: [],
    memory_layer: "semantic",
    source_trust: "user_confirmed",
    supersedes_memory_id: input.supersedes_memory_id ?? null,
  };
  const names = Object.keys(row);
  const placeholders = names.map((name, index) =>
    name === "tags" ? `$${index + 1}::jsonb` : `$${index + 1}`,
  );
  const values = names.map((name) => {
    const value = row[name];
    return name === "tags" ? JSON.stringify(value) : value;
  });
  await pool!.query(
    `INSERT INTO memory_entries (${names.join(", ")})
     VALUES (${placeholders.join(", ")})`,
    values,
  );
}

async function scan(overrides: Partial<Parameters<MemoryMaintenanceService["scan"]>[0]> = {}) {
  return new MemoryMaintenanceService(pool!).scan({
    spaceId: SPACE,
    userId: VIEWER,
    limit: 100,
    staleAfterDays: 3650,
    thinContentChars: 10,
    maxFindings: 100,
    ...overrides,
  });
}

describe("Memory maintenance scan (real Postgres)", () => {
  it("respects selected-user grants and space-shared visibility", async () => {
    if (!available || !pool) return;
    await insertMemory({
      id: "selected-visible",
      owner_user_id: OTHER,
      visibility: "selected_users",
      title: "Shared maintenance title",
    });
    await insertMemory({
      id: "shared-visible",
      owner_user_id: OTHER,
      visibility: "space_shared",
      title: "Shared maintenance title",
    });
    await insertMemory({
      id: "selected-hidden",
      owner_user_id: OTHER,
      visibility: "selected_users",
      title: "Shared maintenance title",
    });
    await pool.query(
      `INSERT INTO content_access_grants
         (id, space_id, resource_type, resource_id, grantee_user_id, granted_by_user_id,
          access_level, created_at, updated_at)
       VALUES
         ($1, $2, 'memory', 'selected-visible', $3, $4, 'full', now(), now()),
         ($5, $2, 'memory', 'selected-hidden', $4, $4, 'full', now(), now())`,
      [randomUUID(), SPACE, VIEWER, OTHER, randomUUID()],
    );

    const result = await scan();
    const duplicate = result.report.findings.find((finding) => finding.kind === "duplicate");

    expect(result.report.candidate_limit).toBe(100);
    expect(result.report.candidates_examined).toBe(2);
    expect(result.report.scanned).toBe(2);
    expect(duplicate?.objects.map((object) => object.object_id).sort()).toEqual([
      "selected-visible",
      "shared-visible",
    ]);
    expect(JSON.stringify(result.report)).not.toContain("selected-hidden");
  });

  it("uses owner summary_only full content for thin checks without putting content in the report", async () => {
    if (!available || !pool) return;
    await insertMemory({
      id: "summary-owner",
      owner_user_id: VIEWER,
      visibility: "space_shared",
      access_level: "summary",
      title: null,
      content: "tiny",
    });

    const result = await scan();

    expect(result.report.findings).toEqual([
      expect.objectContaining({
        kind: "thin",
        objects: [{ object_type: "memory_entry", object_id: "summary-owner", title: null }],
      }),
    ]);
    expect(result.report.access_safety).toMatchObject({
      summary_access_full_content_used: true,
      raw_content_included: false,
      snippets_included: false,
    });
    expect(JSON.stringify(result.report)).not.toContain("tiny");
  });

  it("excludes highly_restricted rows from maintenance even for the owner", async () => {
    if (!available || !pool) return;
    await insertMemory({
      id: "high-1",
      owner_user_id: VIEWER,
      sensitivity_level: "highly_restricted",
      title: "Highly restricted duplicate",
    });
    await insertMemory({
      id: "high-2",
      owner_user_id: VIEWER,
      sensitivity_level: "highly_restricted",
      title: "Highly restricted duplicate",
    });

    const result = await scan();

    expect(result.report.candidates_examined).toBe(0);
    expect(result.report.scanned).toBe(0);
    expect(result.report.findings).toEqual([]);
    expect(result.contributingMemoryIds).toEqual([]);
  });

  it("rolls back report artifact, packet proposal, and maintenance access logs together", async () => {
    if (!available || !pool) return;
    await insertMemory({ id: "rollback-1", title: "Rollback duplicate" });
    await insertMemory({ id: "rollback-2", title: "Rollback duplicate" });

    await expect(
      withDbTransaction(pool, async (client) => {
        const result = await new MemoryMaintenanceService(client).scan({
          spaceId: SPACE,
          userId: VIEWER,
          limit: 100,
          staleAfterDays: 3650,
          thinContentChars: 10,
          maxFindings: 100,
        });
        const artifactId = await persistMemoryMaintenanceReportArtifact(client, {
          spaceId: SPACE,
          ownerUserId: VIEWER,
          report: result.report,
          scanOptions: { limit: 100 },
        });
        await createMemoryMaintenanceProposalPacket(client, {
          spaceId: SPACE,
          ownerUserId: VIEWER,
          report: result.report,
          scanOptions: { limit: 100 },
          artifactId,
        });
        await new PgMemoryReadRepository(client).recordMaintenanceReads(
          result.contributingMemoryIds,
          SPACE,
          VIEWER,
          artifactId,
        );
        throw new Error("force rollback");
      }),
    ).rejects.toThrow("force rollback");

    const counts = await pool.query<{ artifacts: string; proposals: string; access_logs: string }>(
      `SELECT
         (SELECT count(*) FROM artifacts) AS artifacts,
         (SELECT count(*) FROM proposals) AS proposals,
         (SELECT count(*) FROM content_access_logs) AS access_logs`,
    );
    expect(counts.rows[0]).toEqual({
      artifacts: "0",
      proposals: "0",
      access_logs: "0",
    });
    const memoryCounts = await pool.query<{ total_access_count: string }>(
      `SELECT COALESCE(sum(access_count), 0)::text AS total_access_count FROM memory_entries`,
    );
    expect(memoryCounts.rows[0]?.total_access_count).toBe("0");
  });
});
