import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { getTestPostgres, type TestPostgresDatabase } from "./support/sharedPostgres";
import { migrate } from "../src/db/migrator";
import { normalizeUsageObservation } from "../src/modules/usage/normalizer";
import { PgUsageRepository } from "../src/modules/usage/repository";
import type { OversightMode } from "../src/modules/access/contentAccessTypes";

const MIGRATIONS_DIR = join(process.cwd(), "migrations");
const SPACE = "77777777-7777-4777-8777-777777777777";
const OWNER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const MEMBER = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const ADMIN = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const OCCURRED_AT = new Date("2026-07-10T12:00:00.000Z");

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
    console.warn(
      `[usage-oversight] skipped — Docker/Postgres unavailable: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}, 180_000);

afterAll(async () => {
  await pool?.end();
  await container?.stop();
});

async function seed(mode: OversightMode): Promise<PgUsageRepository> {
  await pool!.query(
    "TRUNCATE content_access_grants, token_usage_events, space_memberships, users, spaces CASCADE",
  );
  for (const id of [OWNER, MEMBER, ADMIN]) {
    await pool!.query(
      `INSERT INTO users (id, display_name, status, created_at, updated_at)
       VALUES ($1, 'User', 'active', now(), now())`,
      [id],
    );
  }
  await pool!.query(
    `INSERT INTO spaces (id, name, type, created_by_user_id, oversight_mode, created_at, updated_at)
     VALUES ($1, 'Usage Space', 'team', $2, $3, now(), now())`,
    [SPACE, OWNER, mode],
  );
  for (const [userId, role] of [[OWNER, "owner"], [MEMBER, "member"], [ADMIN, "admin"]] as const) {
    await pool!.query(
      `INSERT INTO space_memberships (id, space_id, user_id, role, status, created_at, updated_at)
       VALUES ($1, $2, $3, $4, 'active', now(), now())`,
      [randomUUID(), SPACE, userId, role],
    );
  }

  const repository = new PgUsageRepository(pool!);
  const event = normalizeUsageObservation(
    {
      space_id: SPACE,
      event_type: "llm.generation",
      source_type: "local_run",
      execution_channel: "managed_api",
      provider_type: "openai",
      provider_usage: { prompt_tokens: 7, completion_tokens: 5, total_tokens: 12 },
      idempotency_key: `oversight-${mode}`,
    },
    "instance-1",
    {
      owner_user_id: MEMBER,
      visibility: "private",
      access_level: "full",
      source_resource_type: null,
      source_resource_id: null,
      project_folder_id: null,
      project_id: null,
      grant_snapshots: [],
    },
    OCCURRED_AT,
  );
  await repository.appendEvent(event);
  return repository;
}

describe("usage oversight visibility", () => {
  it.each<[OversightMode, number, number]>([
    ["none", 0, 0],
    ["summary", 1, 0],
    ["content", 1, 1],
    ["full", 1, 1],
  ])(
    "oversight_mode=%s exposes member-private usage to an admin as %i aggregate event(s) and %i detail event(s)",
    async (mode, aggregateCount, detailCount) => {
      if (!available || !pool) return;
      const repository = await seed(mode);
      const filters = {
        activeSpaceId: SPACE,
        userId: ADMIN,
        view: "all_visible" as const,
        from: "2026-07-01T00:00:00.000Z",
        to: "2026-08-01T00:00:00.000Z",
      };

      const aggregate = await repository.aggregate(filters);
      const details = await repository.listEvents(filters);

      expect(aggregate.totals.event_count).toBe(aggregateCount);
      expect(details.total).toBe(detailCount);
      if (mode === "summary") {
        expect(aggregate.items).toHaveLength(1);
        expect(aggregate.items[0]).toMatchObject({ group_key: "summary", group_label: "Shared summary" });
      }
    },
  );
});
