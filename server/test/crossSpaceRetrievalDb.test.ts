import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { migrate } from "../src/db/migrator";
import { CrossSpaceRetrievalService } from "../src/modules/crossSpaceRetrieval/service";
import { RetrievalProjectionService } from "../src/modules/retrieval";
import { personalAggregatedRetrievalRegistry } from "../src/modules/crossSpaceRetrieval/service";
import { insertKnowledgeItem } from "./support/knowledgeFixtures";
import {
  getTestPostgres,
  isTestPostgresUnavailableError,
  type TestPostgresDatabase,
} from "./support/sharedPostgres";

const MIGRATIONS_DIR = join(process.cwd(), "migrations");
const USER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OTHER = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const PERSONAL = "11111111-1111-4111-8111-111111111111";
const SPACE_A = "22222222-2222-4222-8222-222222222222";
const SPACE_B = "33333333-3333-4333-8333-333333333333";
const A_SHARED = "44444444-4444-4444-8444-444444444444";
const A_PRIVATE = "55555555-5555-4555-8555-555555555555";
const B_SHARED = "66666666-6666-4666-8666-666666666666";
const B_PRIVATE = "77777777-7777-4777-8777-777777777777";

let database: TestPostgresDatabase | undefined;
let pool: Pool | undefined;
let available = false;

beforeAll(async () => {
  try {
    database = await getTestPostgres(__filename);
    pool = new Pool({ connectionString: database.getConnectionUri(), max: 4 });
    await migrate(pool, MIGRATIONS_DIR);
    available = true;
  } catch (error) {
    if (!isTestPostgresUnavailableError(error)) throw error;
    console.warn(`[cross-space-retrieval-db] skipped: ${error instanceof Error ? error.message : String(error)}`);
  }
}, 180_000);

afterAll(async () => {
  await pool?.end();
  await database?.stop();
});

beforeEach(async () => {
  if (!available || !pool) return;
  await pool.query(
    `TRUNCATE cross_space_retrieval_sessions, cross_space_egress_disclosures,
              content_egress_records, space_member_notifications,
              retrieval_objects, retrieval_aliases, retrieval_chunks, retrieval_edges,
              artifacts, knowledge_items, space_objects, space_memberships, users, spaces CASCADE`,
  );
  await pool.query(
    `INSERT INTO users (id, display_name, status, created_at, updated_at)
     VALUES ($1, 'Viewer', 'active', now(), now()),
            ($2, 'Other', 'active', now(), now())`,
    [USER, OTHER],
  );
  await pool.query(
    `INSERT INTO spaces
       (id, name, type, created_by_user_id, egress_notifications_enabled,
        created_at, updated_at)
     VALUES ($1, 'Personal', 'personal', $4, false, now(), now()),
            ($2, 'Space A', 'team', $4, true, now(), now()),
            ($3, 'Space B', 'team', $5, true, now(), now())`,
    [PERSONAL, SPACE_A, SPACE_B, USER, OTHER],
  );
  await pool.query(
    `INSERT INTO space_memberships
       (id, space_id, user_id, role, status, created_at, updated_at)
     VALUES
       ('personal-viewer', $1, $4, 'owner', 'active', now(), now()),
       ('a-viewer', $2, $4, 'admin', 'active', now(), now()),
       ('a-other', $2, $5, 'member', 'active', now(), now()),
       ('b-viewer', $3, $4, 'member', 'active', now(), now()),
       ('b-other', $3, $5, 'member', 'active', now(), now())`,
    [PERSONAL, SPACE_A, SPACE_B, USER, OTHER],
  );
  await seedKnowledge(A_SHARED, SPACE_A, "Boundary alpha shared", "boundary alpha shared material", "space_shared", null);
  await seedKnowledge(A_PRIVATE, SPACE_A, "Boundary alpha private", "boundary alpha private material", "private", OTHER);
  await seedKnowledge(B_SHARED, SPACE_B, "Boundary beta shared", "boundary beta shared material", "space_shared", null);
  await seedKnowledge(B_PRIVATE, SPACE_B, "Boundary beta private", "boundary beta private material", "private", USER);
});

async function seedKnowledge(
  id: string,
  spaceId: string,
  title: string,
  content: string,
  visibility: string,
  ownerUserId: string | null,
): Promise<void> {
  await insertKnowledgeItem(pool!, {
    id,
    spaceId,
    title,
    content,
    slug: id,
    visibility,
    ownerUserId,
    createdByUserId: ownerUserId ?? USER,
  });
  await new RetrievalProjectionService(pool!, personalAggregatedRetrievalRegistry)
    .reindex(spaceId, "knowledge_item", id);
}

function service(): CrossSpaceRetrievalService {
  return new CrossSpaceRetrievalService(pool!);
}

describe("personal cross-Space aggregated retrieval", () => {
  it("applies every contributing Space's live content predicate independently", async () => {
    if (!available || !pool) return;
    const result = await service().search({
      userId: USER,
      query: "boundary",
      resourceTypes: ["knowledge_item"],
      maxResults: 20,
    });

    const refs = result.items.map((item) => `${item.pointer.space_id}:${item.pointer.id}`);
    expect(refs).toContain(`${SPACE_A}:${A_SHARED}`);
    expect(refs).not.toContain(`${SPACE_A}:${A_PRIVATE}`);
    expect(refs).toContain(`${SPACE_B}:${B_SHARED}`);
    expect(refs).toContain(`${SPACE_B}:${B_PRIVATE}`);
    expect(result.fused_conclusion).toBeNull();
    expect(result.canonical_write_performed).toBe(false);

    const stored = await pool.query<{ row: Record<string, unknown> }>(
      `SELECT to_jsonb(p) AS row FROM cross_space_retrieval_pointers p`,
    );
    expect(stored.rows).toHaveLength(3);
    for (const row of stored.rows) {
      expect(Object.keys(row.row).sort()).toEqual([
        "created_at", "id", "resource_id", "resource_space_id", "resource_type", "session_id", "user_id",
      ]);
      expect(JSON.stringify(row.row)).not.toContain("boundary");
    }
  });

  it("makes a stored pointer unresolvable immediately after membership revocation", async () => {
    if (!available || !pool) return;
    const result = await service().search({
      userId: USER,
      query: "alpha shared",
      resourceTypes: ["knowledge_item"],
    });
    const pointer = result.items.find((item) => item.pointer.space_id === SPACE_A)!.pointer;

    const otherUserResolution = await service().resolve(OTHER, [pointer.pointer_id]);
    expect(otherUserResolution.items).toEqual([]);
    expect(otherUserResolution.unresolved_pointer_ids).toEqual([pointer.pointer_id]);

    await pool.query(
      `UPDATE space_memberships SET status = 'revoked', updated_at = now()
        WHERE space_id = $1 AND user_id = $2`,
      [SPACE_A, USER],
    );
    const resolved = await service().resolve(USER, [pointer.pointer_id]);
    expect(resolved.items).toEqual([]);
    expect(resolved.unresolved_pointer_ids).toEqual([pointer.pointer_id]);
    expect((await pool.query(`SELECT 1 FROM cross_space_retrieval_pointers WHERE id = $1`, [pointer.pointer_id])).rowCount).toBe(1);
  });

  it("persists no fused conclusion until disclosure and an explicit user store", async () => {
    if (!available || !pool) return;
    const result = await service().search({
      userId: USER,
      query: "boundary shared",
      resourceTypes: ["knowledge_item"],
      maxResults: 20,
    });
    const pointerIds = [SPACE_A, SPACE_B].map((spaceId) =>
      result.items.find((item) => item.pointer.space_id === spaceId)!.pointer.pointer_id);

    expect((await pool.query(`SELECT 1 FROM artifacts`)).rowCount).toBe(0);
    expect((await pool.query(`SELECT 1 FROM content_egress_records`)).rowCount).toBe(0);

    await expect(service().storeFusedConclusion({
      userId: USER,
      disclosureId: "99999999-9999-4999-8999-999999999999",
      pointerIds,
      conclusion: "must not persist without prior disclosure",
    })).rejects.toMatchObject({ statusCode: 404 });
    expect((await pool.query(`SELECT 1 FROM artifacts`)).rowCount).toBe(0);

    const disclosure = await service().discloseEgress(USER, pointerIds);
    expect(disclosure.source_spaces.map((space) => space.space_id).sort()).toEqual([SPACE_A, SPACE_B]);
    expect(disclosure.source_spaces.every((space) => space.egress_notifications_enabled)).toBe(true);
    expect((await pool.query(`SELECT 1 FROM artifacts`)).rowCount).toBe(0);

    const conclusion = "A private fused conclusion that must never enter source-Space egress rows.";
    const stored = await service().storeFusedConclusion({
      userId: USER,
      disclosureId: disclosure.disclosure_id,
      pointerIds,
      conclusion,
    });
    expect(stored.egress_record_ids).toHaveLength(2);
    const artifact = await pool.query<{ space_id: string; visibility: string; content: string }>(
      `SELECT space_id, visibility, content FROM artifacts WHERE id = $1`,
      [stored.artifact_id],
    );
    expect(artifact.rows[0]).toMatchObject({ space_id: PERSONAL, visibility: "private", content: conclusion });
    const egress = await pool.query<{ source_space_id: string; source_pointers_json: unknown }>(
      `SELECT source_space_id, source_pointers_json FROM content_egress_records ORDER BY source_space_id`,
    );
    expect(egress.rows.map((row) => row.source_space_id)).toEqual([SPACE_A, SPACE_B]);
    expect(JSON.stringify(egress.rows)).not.toContain(conclusion);
    const notifications = await pool.query<{ pointer_metadata_json: unknown }>(
      `SELECT pointer_metadata_json FROM space_member_notifications WHERE event_type = 'content_egress'`,
    );
    expect(notifications.rowCount).toBe(4);
    expect(JSON.stringify(notifications.rows)).not.toContain(conclusion);

    const staleDisclosure = await service().discloseEgress(USER, pointerIds);
    await service().updateEgressNotificationSetting(USER, SPACE_A, false);
    await expect(service().storeFusedConclusion({
      userId: USER,
      disclosureId: staleDisclosure.disclosure_id,
      pointerIds,
      conclusion: "must not use a stale disclosure",
    })).rejects.toMatchObject({ statusCode: 409 });
    expect((await pool.query(
      `SELECT 1 FROM artifacts WHERE content = 'must not use a stale disclosure'`,
    )).rowCount).toBe(0);
    const prior = await pool.query<{ notification_enabled: boolean }>(
      `SELECT notification_enabled FROM content_egress_records
        WHERE target_artifact_id = $1 AND source_space_id = $2`,
      [stored.artifact_id, SPACE_A],
    );
    expect(prior.rows[0]?.notification_enabled).toBe(true);
    const disclosedAfterChange = await service().discloseEgress(USER, pointerIds);
    expect(disclosedAfterChange.source_spaces.find((space) => space.space_id === SPACE_A))
      .toMatchObject({ egress_notifications_enabled: false });
    const beforeSecondNoticeCount = Number((await pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM space_member_notifications
        WHERE space_id = $1 AND event_type = 'content_egress'`,
      [SPACE_A],
    )).rows[0]?.count ?? 0);
    const second = await service().storeFusedConclusion({
      userId: USER,
      disclosureId: disclosedAfterChange.disclosure_id,
      pointerIds,
      conclusion: "second explicit conclusion",
    });
    const secondA = await pool.query<{ notification_enabled: boolean }>(
      `SELECT notification_enabled FROM content_egress_records
        WHERE target_artifact_id = $1 AND source_space_id = $2`,
      [second.artifact_id, SPACE_A],
    );
    expect(secondA.rows[0]?.notification_enabled).toBe(false);
    const afterSecondNoticeCount = Number((await pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM space_member_notifications
        WHERE space_id = $1 AND event_type = 'content_egress'`,
      [SPACE_A],
    )).rows[0]?.count ?? 0);
    expect(afterSecondNoticeCount).toBe(beforeSecondNoticeCount);
  });

  it("writes single-source summaries back to that Space and broadcasts setting changes forward-only", async () => {
    if (!available || !pool) return;
    const result = await service().search({
      userId: USER,
      query: "alpha shared",
      resourceTypes: ["knowledge_item"],
    });
    const pointerId = result.items.find((item) => item.pointer.space_id === SPACE_A)!.pointer.pointer_id;
    await expect(service().updateEgressNotificationSetting(OTHER, SPACE_A, false))
      .rejects.toMatchObject({ statusCode: 403 });
    const summary = await service().storeSingleSourceSummary(USER, [pointerId], "Personal summary of A");
    const artifact = await pool.query<{ space_id: string; owner_user_id: string; visibility: string }>(
      `SELECT space_id, owner_user_id, visibility FROM artifacts WHERE id = $1`,
      [summary.artifact_id],
    );
    expect(artifact.rows[0]).toEqual({ space_id: SPACE_A, owner_user_id: USER, visibility: "private" });

    const changed = await service().updateEgressNotificationSetting(USER, SPACE_A, false);
    expect(changed.egress_notifications_enabled).toBe(false);
    const notices = await pool.query<{ pointer_metadata_json: Record<string, unknown> }>(
      `SELECT pointer_metadata_json FROM space_member_notifications
        WHERE space_id = $1 AND event_type = 'egress_notification_setting_changed'`,
      [SPACE_A],
    );
    expect(notices.rowCount).toBe(2);
    expect(notices.rows.every((row) => row.pointer_metadata_json.egress_notifications_enabled === false)).toBe(true);
    expect(JSON.stringify(notices.rows)).not.toContain("Personal summary of A");

    const unchanged = await service().updateEgressNotificationSetting(USER, SPACE_A, false);
    expect(unchanged.updated_at).toBe(changed.updated_at);
    expect((await pool.query(
      `SELECT 1 FROM space_member_notifications
        WHERE space_id = $1 AND event_type = 'egress_notification_setting_changed'`,
      [SPACE_A],
    )).rowCount).toBe(2);
  });
});
