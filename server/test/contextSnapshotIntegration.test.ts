import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { getTestPostgres, type TestPostgresDatabase } from "./support/sharedPostgres";
import { PgContextSnapshotRepository } from "../src/modules/memory/contextSnapshotRepository";

// Real-PostgreSQL integration tests for the server context snapshot repository.
// The route/unit suites use fakes that never run SQL, so they cannot catch the
// defects that only surface on the real stack: the required audit columns
// (id/metadata_json/created_at), the ck_context_snapshot_items_item_type CHECK,
// jsonb param binding, the space-scoped snapshot UPDATE, and the multi-row
// VALUES insert. These run the actual SQL against a throwaway Postgres
// (testcontainers) loaded with test/fixtures/contextSnapshotSchema.sql.
//
// Skips gracefully when Docker is unavailable so `npm test` runs everywhere.

const SCHEMA = readFileSync(
  join(process.cwd(), "test/fixtures/contextSnapshotSchema.sql"),
  "utf8",
);

let container: TestPostgresDatabase | undefined;
let pool: Pool | undefined;
let repo: PgContextSnapshotRepository | undefined;
let available = false;

beforeAll(async () => {
  try {
    container = await getTestPostgres(__filename, { empty: true });
    pool = new Pool({ connectionString: container.getConnectionUri() });
    await pool.query(SCHEMA);
    repo = new PgContextSnapshotRepository(pool);
    available = true;
  } catch (err) {
    console.warn(
      `[context-snapshot-integration] skipped — Docker/Postgres unavailable: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}, 120_000);

afterAll(async () => {
  await pool?.end();
  await container?.stop();
});

const SNAPSHOT = "snapshot-1";
const SPACE = "space-1";

beforeEach(async () => {
  if (!available || !pool) return;
  await pool.query(
    "TRUNCATE context_snapshots, context_snapshot_items, memory_entries, memory_access_logs CASCADE",
  );
  // Seed the empty snapshot normally created by run creation.
  await pool.query(
    `INSERT INTO context_snapshots (id, space_id, source_refs_json, created_at)
     VALUES ($1, $2, '[]'::jsonb, now())`,
    [SNAPSHOT, SPACE],
  );
  await pool.query(
    `INSERT INTO memory_entries (id, space_id, access_count)
     VALUES ($1, $2, 0)`,
    ["11111111-1111-1111-1111-111111111111", SPACE],
  );
});

describe("PgContextSnapshotRepository against real Postgres", () => {
  it("updates the run snapshot and inserts selected items", async () => {
    if (!available || !repo || !pool) return;
    await repo.persistChatSnapshot({
      contextSnapshotId: SNAPSHOT,
      spaceId: SPACE,
      runId: "run-1",
      userId: "user-1",
      agentId: "agent-1",
      tokenEstimate: 10,
      requestJson: { user_message: "hi", max_tokens: 4000 },
      items: [
        {
          item_type: "memory",
          item_id: "11111111-1111-1111-1111-111111111111",
          title: "A memory",
          excerpt: "remember this",
          score: 0.8,
          reason: "approved_memory",
          token_count: 7,
          metadata: { k: "v" },
        },
        {
          item_type: "project_folder",
          item_id: null,
          title: "WS",
          excerpt: null,
          score: 0.9,
          reason: "current_workspace",
          token_count: 3,
          metadata: {},
        },
      ],
    });

    const snap = await pool.query<{
      token_estimate: number;
      request_json: Record<string, unknown>;
    }>(
      "SELECT token_estimate, request_json FROM context_snapshots WHERE id = $1",
      [SNAPSHOT],
    );
    expect(snap.rows[0]?.token_estimate).toBe(10);
    expect(snap.rows[0]?.request_json).toMatchObject({ user_message: "hi" });

    const items = await pool.query<{
      item_type: string;
      item_id: string | null;
      metadata_json: Record<string, unknown>;
    }>(
      "SELECT item_type, item_id, metadata_json FROM context_snapshot_items WHERE context_snapshot_id = $1 ORDER BY item_type",
      [SNAPSHOT],
    );
    expect(items.rows).toHaveLength(2);
    expect(items.rows[0]).toMatchObject({ item_type: "memory", metadata_json: { k: "v" } });
    expect(items.rows[1]).toMatchObject({ item_type: "project_folder", item_id: null });

    const access = await pool.query<{ memory_id: string; run_id: string | null; access_type: string }>(
      "SELECT memory_id, run_id, access_type FROM memory_access_logs",
    );
    expect(access.rows).toEqual([
      {
        memory_id: "11111111-1111-1111-1111-111111111111",
        run_id: "run-1",
        access_type: "context_injection",
      },
    ]);
  });

  it("persists token_estimate with no items (empty selection skips the insert)", async () => {
    if (!available || !repo || !pool) return;
    await repo.persistChatSnapshot({
      contextSnapshotId: SNAPSHOT,
      spaceId: SPACE,
      runId: "run-empty",
      userId: "user-1",
      agentId: null,
      tokenEstimate: 0,
      requestJson: { user_message: "hi" },
      items: [],
    });

    const count = await pool.query<{ n: string }>(
      "SELECT count(*)::text AS n FROM context_snapshot_items",
    );
    expect(count.rows[0]?.n).toBe("0");
    const snap = await pool.query<{ token_estimate: number }>(
      "SELECT token_estimate FROM context_snapshots WHERE id = $1",
      [SNAPSHOT],
    );
    expect(snap.rows[0]?.token_estimate).toBe(0);
  });

  it("does not update a snapshot in another space", async () => {
    if (!available || !repo || !pool) return;
    await repo.persistChatSnapshot({
      contextSnapshotId: SNAPSHOT,
      spaceId: "space-2",
      runId: "run-2",
      userId: "user-1",
      agentId: null,
      tokenEstimate: 99,
      requestJson: {},
      items: [],
    });
    const snap = await pool.query<{ token_estimate: number | null }>(
      "SELECT token_estimate FROM context_snapshots WHERE id = $1",
      [SNAPSHOT],
    );
    expect(snap.rows[0]?.token_estimate).toBeNull();
  });

  it("rejects an invalid item_type via the CHECK constraint", async () => {
    if (!available || !repo) return;
    await expect(
      repo.persistChatSnapshot({
        contextSnapshotId: SNAPSHOT,
        spaceId: SPACE,
        runId: "run-invalid",
        userId: "user-1",
        agentId: null,
        tokenEstimate: 1,
        requestJson: {},
        items: [
          {
            item_type: "not_a_valid_type",
            item_id: null,
            title: null,
            excerpt: null,
            score: null,
            reason: null,
            token_count: 1,
            metadata: {},
          },
        ],
      }),
    ).rejects.toThrow();
  });
});
