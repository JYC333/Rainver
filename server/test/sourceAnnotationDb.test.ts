import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { useTestDatabase } from "./support/testDatabase";
import { resetTables } from "./support/resetTables";
import { PgSourceAnnotationRepository } from "../src/modules/sourceAnnotation/repository";
import { ANNOTATION_ENQUEUE_WINDOW_MS } from "../src/modules/sourceAnnotation/eventEmitter";

// Real-Postgres coverage for the system annotation queue: what gets enqueued,
// what the queue guarantees about not paying twice, how failures terminate, and
// the CHECK that stops a half-parsed annotation from looking usable.

const SPACE = "11111111-1111-4111-8111-111111111111";
const OTHER_SPACE = "99999999-9999-4999-8999-999999999999";
const OWNER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const READER = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const CONNECTOR = "33333333-3333-4333-8333-333333333333";
const CONNECTION = "44444444-4444-4444-8444-444444444444";
const CHANNEL = "44444444-4444-4444-8444-444444444444";


const db = useTestDatabase(__filename);

beforeEach(async () => {
  if (!db.available) return;
  await resetTables(
    db.pool,
    ["source_item_annotations", "source_item_user_states", "source_channel_item_links", "source_channels", "source_items", "source_connections", "source_provider_connectors", "source_providers", "source_connectors", "space_memberships", "users", "spaces"],
    { cascade: true },
  );
  const now = new Date().toISOString();
  for (const [id, name] of [[SPACE, "Main"], [OTHER_SPACE, "Other"]] as const) {
    await db.pool.query(`INSERT INTO spaces (id, name, type, created_at, updated_at) VALUES ($1,$2,'personal',$3,$3)`, [id, name, now]);
  }
  for (const user of [OWNER, READER]) {
    await db.pool.query(`INSERT INTO users (id, display_name, status, created_at, updated_at) VALUES ($1,$1,'active',$2,$2)`, [user, now]);
    await db.pool.query(
      `INSERT INTO space_memberships (id, space_id, user_id, role, status, created_at, updated_at)
       VALUES ($1,$2,$3,'owner','active',$4,$4)`,
      [randomUUID(), SPACE, user, now],
    );
  }
  await db.pool.query(
    `INSERT INTO source_connectors (id, connector_key, display_name, connector_type, ingestion_mode, status, capabilities_json, created_at, updated_at)
     VALUES ($1,'rss','RSS','external_feed','pull','active','{}'::jsonb,$2,$2)`,
    [CONNECTOR, now],
  );
  await db.pool.query(
    `INSERT INTO source_providers (id, provider_key, display_name, provider_kind, category, status, capabilities_json, created_at, updated_at)
     VALUES ($1,'rss','RSS','named','general','active','{}'::jsonb,$2,$2)`,
    [CONNECTOR, now],
  );
  const mappingId = randomUUID();
  await db.pool.query(
    `INSERT INTO source_provider_connectors (id, provider_id, connector_id, status, priority, capabilities_json, created_at, updated_at)
     VALUES ($1,$2,$3,'active',0,'{}'::jsonb,$4,$4)`,
    [mappingId, CONNECTOR, CONNECTOR, now],
  );
  await db.pool.query(
    `INSERT INTO source_connections (
       id, space_id, provider_connector_id, owner_user_id, name, status,
       capture_policy, trust_level, consent_json, policy_json, config_json, created_at, updated_at
     ) VALUES ($1,$2,$3,$4,'Feed','active','reference_only','normal',$5::jsonb,$6::jsonb,'{}'::jsonb,$7,$7)`,
    [
      CONNECTION,
      SPACE,
      mappingId,
      OWNER,
      JSON.stringify({
        schema_version: 1,
        owner_user_id: OWNER,
        allowed_reader_user_ids: [],
        allowed_agent_ids: [],
        allow_space_admins: true,
        allow_local_provider_egress: true,
        allow_external_model_egress: true,
      }),
      JSON.stringify({ schema_version: 1, source_egress_class: "external_provider_allowed" }),
      now,
    ],
  );
  await db.pool.query(
    `INSERT INTO source_channels (
       id, space_id, source_connection_id, created_by_user_id, name, channel_type, endpoint_url,
       query_json, provider_query_json, query_fingerprint, status, fetch_frequency, schedule_rule_json, created_at, updated_at
     ) VALUES ($1,$2,$1,$3,'Feed channel','feed','https://example.com/feed.xml','{}'::jsonb,'{}'::jsonb,$1,'active','daily','{"frequency":"daily","hour":0,"minute":0}'::jsonb,$4,$4)`,
    [CHANNEL, SPACE, OWNER, now],
  );
});

async function seedItem(options: { title?: string; firstSeenAt?: string; linkToChannel?: boolean; spaceId?: string } = {}): Promise<string> {
  const itemId = randomUUID();
  const now = new Date().toISOString();
  const firstSeen = options.firstSeenAt ?? now;
  const spaceId = options.spaceId ?? SPACE;
  await db.pool.query(
    `INSERT INTO source_items (
       id, space_id, owner_user_id, visibility, connection_id, item_type, title, source_uri, excerpt,
       first_seen_at, last_seen_at, content_state, retention_policy, created_at, updated_at
     ) VALUES ($1,$2,$3,'space_shared',$4,'feed_entry',$5,$6,'An excerpt.',$7,$7,'excerpt_saved','summary_only',$8,$8)`,
    [
      itemId,
      spaceId,
      OWNER,
      spaceId === SPACE ? CONNECTION : null,
      options.title ?? `Item ${itemId.slice(0, 8)}`,
      `https://example.com/${itemId}`,
      firstSeen,
      now,
    ],
  );
  if (options.linkToChannel !== false && spaceId === SPACE) {
    await db.pool.query(
      `INSERT INTO source_channel_item_links (id, space_id, source_channel_id, source_item_id, status, matched_at, created_at, updated_at)
       VALUES ($1,$2,$3,$4,'active',$5,$5,$5)`,
      [randomUUID(), spaceId, CHANNEL, itemId, now],
    );
  }
  return itemId;
}

const repo = () => new PgSourceAnnotationRepository(db.pool);

describe("source annotation queue", () => {
  it("enqueues a channel's recent items exactly once", async () => {
    if (!db.available) return;
    const first = await seedItem();
    const second = await seedItem();
    const since = new Date(Date.now() - ANNOTATION_ENQUEUE_WINDOW_MS).toISOString();

    const queued = await repo().enqueueRecentItems(SPACE, { sourceChannelId: CHANNEL, sourceConnectionId: CONNECTION }, since);
    expect(queued).toBe(2);

    // A rescan covering the same items must not create a second row or pay for
    // the same annotation twice.
    const requeued = await repo().enqueueRecentItems(SPACE, { sourceChannelId: CHANNEL, sourceConnectionId: CONNECTION }, since);
    expect(requeued).toBe(0);

    const rows = await db.pool.query(`SELECT source_item_id, status FROM source_item_annotations WHERE space_id = $1`, [SPACE]);
    expect(rows.rows).toHaveLength(2);
    expect(rows.rows.every((row) => row.status === "pending")).toBe(true);
    expect(rows.rows.map((row) => row.source_item_id).sort()).toEqual([first, second].sort());
  });

  it("does not reach back past the window and turn a scan into a backfill", async () => {
    if (!db.available) return;
    const old = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    await seedItem({ firstSeenAt: old, title: "Ancient history" });
    const recent = await seedItem({ title: "Today" });

    const since = new Date(Date.now() - ANNOTATION_ENQUEUE_WINDOW_MS).toISOString();
    const queued = await repo().enqueueRecentItems(SPACE, { sourceChannelId: CHANNEL, sourceConnectionId: CONNECTION }, since);

    expect(queued).toBe(1);
    const rows = await db.pool.query(`SELECT source_item_id FROM source_item_annotations WHERE space_id = $1`, [SPACE]);
    expect(rows.rows.map((row) => row.source_item_id)).toEqual([recent]);
  });

  it("falls back to the connection when a scan has no channel", async () => {
    if (!db.available) return;
    await seedItem({ linkToChannel: false });
    const since = new Date(Date.now() - ANNOTATION_ENQUEUE_WINDOW_MS).toISOString();

    const viaChannel = await repo().enqueueRecentItems(SPACE, { sourceChannelId: CHANNEL, sourceConnectionId: null }, since);
    expect(viaChannel).toBe(0);

    const viaConnection = await repo().enqueueRecentItems(SPACE, { sourceChannelId: null, sourceConnectionId: CONNECTION }, since);
    expect(viaConnection).toBe(1);
  });

  it("hands out the oldest pending items with the fields the prompt needs", async () => {
    if (!db.available) return;
    const older = await seedItem({ title: "First" });
    const newer = await seedItem({ title: "Second" });
    await repo().enqueueItems(SPACE, [older], CHANNEL);
    await new Promise((resolve) => setTimeout(resolve, 10));
    await repo().enqueueItems(SPACE, [newer], CHANNEL);

    const batch = await repo().loadPendingBatch(SPACE, 10);
    expect(batch.map((row) => row.id)).toEqual([older, newer]);
    expect(batch[0].title).toBe("First");
    expect(batch[0].excerpt).toBe("An excerpt.");
  });

  it("does not offer deleted items to a model", async () => {
    if (!db.available) return;
    const itemId = await seedItem();
    await repo().enqueueItems(SPACE, [itemId], CHANNEL);
    await db.pool.query(`UPDATE source_items SET deleted_at = now() WHERE id = $1`, [itemId]);

    expect(await repo().loadPendingBatch(SPACE, 10)).toEqual([]);
  });

  it("keeps spaces isolated", async () => {
    if (!db.available) return;
    const mine = await seedItem();
    const theirs = await seedItem({ spaceId: OTHER_SPACE });
    await repo().enqueueItems(SPACE, [mine], CHANNEL);
    await repo().enqueueItems(OTHER_SPACE, [theirs], null);

    const batch = await repo().loadPendingBatch(SPACE, 10);
    expect(batch.map((row) => row.id)).toEqual([mine]);
  });
});

describe("annotation outcomes", () => {
  it("stores a succeeded annotation and reads it back", async () => {
    if (!db.available) return;
    const itemId = await seedItem();
    await repo().enqueueItems(SPACE, [itemId], CHANNEL);

    await repo().markSucceeded(SPACE, {
      source_item_id: itemId,
      domain_key: "artificial_intelligence",
      depth: "analysis",
      genre: "explainer",
      summary: "Explains retrieval augmentation.",
      topic_candidates: ["retrieval-augmented generation", "vector search"],
      stance_target: "retrieval augmentation improves factual accuracy",
      stance_target_key: "retrieval augmentation improves factual accuracy",
      stance_polarity: "supports",
      stance_confidence: 82,
    }, null);

    const row = await repo().getByItemId(SPACE, itemId);
    expect(row?.status).toBe("succeeded");
    expect(row?.domain_key).toBe("artificial_intelligence");
    expect(row?.topic_candidates).toEqual(["retrieval-augmented generation", "vector search"]);
    expect(row).toMatchObject({ stance_polarity: "supports", stance_confidence: 82 });
    expect(row?.annotated_at).not.toBeNull();
    // Succeeded rows leave the queue.
    expect(await repo().loadPendingBatch(SPACE, 10)).toEqual([]);
  });

  it("retries a failed attempt until the budget is spent, then parks it", async () => {
    if (!db.available) return;
    const itemId = await seedItem();
    await repo().enqueueItems(SPACE, [itemId], CHANNEL);

    await repo().markAttemptFailed(SPACE, [itemId], { error_code: "provider_timeout" }, 3, null);
    expect((await repo().getByItemId(SPACE, itemId))?.status).toBe("pending");
    expect(await repo().loadPendingBatch(SPACE, 10)).toHaveLength(1);

    await repo().markAttemptFailed(SPACE, [itemId], { error_code: "provider_timeout" }, 3, null);
    await repo().markAttemptFailed(SPACE, [itemId], { error_code: "provider_timeout" }, 3, null);

    const row = await repo().getByItemId(SPACE, itemId);
    expect(row?.status).toBe("failed");
    expect(row?.attempt_count).toBe(3);
    // A permanently failed row is what makes "this never reached the digest"
    // answerable; the queue must not keep growing instead.
    expect(await repo().loadPendingBatch(SPACE, 10)).toEqual([]);
  });

  it("parks an unanswered item without retrying it", async () => {
    if (!db.available) return;
    const itemId = await seedItem();
    await repo().enqueueItems(SPACE, [itemId], CHANNEL);

    await repo().markSkipped(SPACE, [itemId], "no_usable_annotation", null);

    expect((await repo().getByItemId(SPACE, itemId))?.status).toBe("skipped");
    expect(await repo().loadPendingBatch(SPACE, 10)).toEqual([]);
  });

  it("refuses a succeeded row missing the fields ranking reads", async () => {
    if (!db.available) return;
    const itemId = await seedItem();
    await repo().enqueueItems(SPACE, [itemId], CHANNEL);

    // Without this constraint a partially parsed result looks usable and then
    // ranks against a NULL domain.
    await expect(db.pool.query(
      `UPDATE source_item_annotations SET status = 'succeeded' WHERE space_id = $1 AND source_item_id = $2`,
      [SPACE, itemId],
    )).rejects.toThrow(/ck_source_item_annotations_succeeded_complete/);
  });

  it("returns parked rows to the queue when the blocking condition changes", async () => {
    if (!db.available) return;
    const denied = await seedItem();
    const brokeDown = await seedItem();
    const unanswerable = await seedItem();
    await repo().enqueueItems(SPACE, [denied, brokeDown, unanswerable], CHANNEL);

    await repo().markSkipped(SPACE, [denied], "source_egress_denied", null);
    await repo().markSkipped(SPACE, [unanswerable], "no_usable_annotation", null);
    for (let i = 0; i < 3; i += 1) {
      await repo().markAttemptFailed(SPACE, [brokeDown], { error_code: "provider_timeout" }, 3, null);
    }
    expect(await repo().loadPendingBatch(SPACE, 10)).toEqual([]);

    // Relaxing the consent setting must reach the material that arrived while
    // it was denied, and only that material.
    const requeued = await repo().requeueParked(SPACE, { reason: "source_egress_denied" });
    expect(requeued).toBe(1);
    const pending = await repo().loadPendingBatch(SPACE, 10);
    expect(pending.map((row) => row.id)).toEqual([denied]);
    expect((await repo().getByItemId(SPACE, denied))?.attempt_count).toBe(0);

    // Everything parked, when the operator wants a blanket retry.
    const all = await repo().requeueParked(SPACE);
    expect(all).toBe(2);
    expect((await repo().loadPendingBatch(SPACE, 10)).map((row) => row.id).sort())
      .toEqual([denied, brokeDown, unanswerable].sort());
  });

  it("leaves succeeded annotations alone when requeueing", async () => {
    if (!db.available) return;
    const done = await seedItem();
    await repo().enqueueItems(SPACE, [done], CHANNEL);
    await repo().markSucceeded(SPACE, {
      source_item_id: done,
      domain_key: "cooking",
      depth: "overview",
      genre: "tutorial",
      summary: "s",
      topic_candidates: [],
      stance_target: null,
      stance_target_key: null,
      stance_polarity: "neutral",
      stance_confidence: 0,
    }, null);

    expect(await repo().requeueParked(SPACE)).toBe(0);
    expect((await repo().getByItemId(SPACE, done))?.status).toBe("succeeded");
  });

  it("rejects an unknown status", async () => {
    if (!db.available) return;
    const itemId = await seedItem();
    await repo().enqueueItems(SPACE, [itemId], CHANNEL);
    await expect(db.pool.query(
      `UPDATE source_item_annotations SET status = 'maybe' WHERE space_id = $1 AND source_item_id = $2`,
      [SPACE, itemId],
    )).rejects.toThrow(/ck_source_item_annotations_status/);
  });
});
