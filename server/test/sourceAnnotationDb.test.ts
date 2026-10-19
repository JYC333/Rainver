import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { useTestDatabase } from "./support/testDatabase.js";
import { updateSpaceRetrievalSettings } from "../src/modules/retrieval/settings.js";
import { resetTables } from "./support/resetTables.js";
import { PgSourceAnnotationRepository } from "../src/modules/sourceAnnotation/repository.js";
import { ANNOTATION_ENQUEUE_WINDOW_MS } from "../src/modules/sourceAnnotation/eventEmitter.js";
import { ensureSourceAnnotatorAgent } from "../src/modules/sourceAnnotation/agent.js";
import { SOURCE_ANNOTATION_SCHEMA_ID } from "../src/modules/sourceAnnotation/resultParser.js";
import { SourceAnnotationService } from "../src/modules/sourceAnnotation/service.js";
import { SourceAnnotationRecoveryNotifier } from "../src/modules/sourceAnnotation/notifier.js";
import { loadConfig } from "../src/config.js";
import { registerSourceAnnotationHandler } from "../src/modules/sourceAnnotation/job.js";
import { JobHandlerRegistry } from "../src/modules/jobs/handlerRegistry.js";
import { SOURCE_ANNOTATION_JOB_TYPE } from "../src/modules/sourceAnnotation/repository.js";
import { ANNOTATION_MAX_ATTEMPTS_PER_EPISODE, ANNOTATION_RETRY_DELAYS_MS } from "../src/modules/sourceAnnotation/retryPolicy.js";

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


const db = useTestDatabase(import.meta.filename);

beforeEach(async () => {
  if (!db.available) return;
  await resetTables(
    db.pool,
    ["settings", "activity_records", "source_item_annotations", "source_item_user_states", "source_channel_item_links", "source_channels", "source_items", "source_connections", "source_provider_connectors", "source_providers", "source_connectors", "space_memberships", "users", "spaces"],
    { cascade: true },
  );
  const now = new Date().toISOString();
  for (const [id, name] of [[SPACE, "Main"], [OTHER_SPACE, "Other"]] as const) {
    await db.pool.query(`INSERT INTO spaces (id, name, type, created_at, updated_at) VALUES ($1,$2,'personal',$3,$3)`, [id, name, now]);
  }
  for (const user of [OWNER, READER]) {
    await db.pool.query(`INSERT INTO users (id, display_name, status, created_at, updated_at, email, registration_source) VALUES ($1,$1,'active',$2,$2, lower(gen_random_uuid()::text || '@test.invalid'), 'system')`, [user, now]);
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

async function seedItem(options: { title?: string; firstSeenAt?: string; linkToChannel?: boolean; spaceId?: string; owner?: string; viaConnection?: boolean } = {}): Promise<string> {
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
      options.owner ?? OWNER,
      spaceId === SPACE && options.viaConnection !== false ? CONNECTION : null,
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

/** Moves a scheduled retry's time to now, as if its delay had passed. */
async function makeRunnable(itemId: string): Promise<void> {
  await db.pool.query(
    `UPDATE source_item_annotations SET next_retry_at = now() - interval '1 second'
      WHERE space_id = $1 AND source_item_id = $2 AND wait_reason = 'retry_scheduled'`,
    [SPACE, itemId],
  );
}

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

  it("schedules bounded retries on the documented delays, then pauses the episode", async () => {
    if (!db.available) return;
    const itemId = await seedItem();
    await repo().enqueueItems(SPACE, [itemId], CHANNEL);

    const delays: number[] = [];
    for (let attempt = 1; attempt <= ANNOTATION_MAX_ATTEMPTS_PER_EPISODE; attempt += 1) {
      await makeRunnable(itemId);
      const before = Date.now();
      await repo().markAttemptFailed(SPACE, [itemId], { error_code: "provider_timeout" }, null);
      const row = await repo().getByItemId(SPACE, itemId);
      expect(row?.attempt_count).toBe(attempt);
      if (attempt < ANNOTATION_MAX_ATTEMPTS_PER_EPISODE) {
        expect(row).toMatchObject({ status: "pending", wait_reason: "retry_scheduled" });
        delays.push(Math.round((Date.parse(row!.next_retry_at!) - before) / 60_000));
        // Not runnable before its time.
        expect(await repo().loadPendingBatch(SPACE, 10)).toEqual([]);
      } else {
        expect(row).toMatchObject({ status: "failed", wait_reason: "budget_exhausted", next_retry_at: null });
      }
    }
    // 1 min, 5 min, then the recovery round at 30 min, 2 h, 6 h.
    expect(delays).toEqual(ANNOTATION_RETRY_DELAYS_MS.map((ms) => ms / 60_000));
    expect(ANNOTATION_MAX_ATTEMPTS_PER_EPISODE).toBe(6);
    await makeRunnable(itemId);
    expect(await repo().loadPendingBatch(SPACE, 10)).toEqual([]);
    expect(await repo().spacesWithPendingWork(10)).toEqual([]);
  });

  it("puts every failure of an episode under one episode id", async () => {
    if (!db.available) return;
    const first = await seedItem();
    const second = await seedItem();
    await repo().enqueueItems(SPACE, [first, second], CHANNEL);
    await repo().markAttemptFailed(SPACE, [first], { error_code: "provider_timeout" }, null);
    await repo().markAttemptFailed(SPACE, [second], { error_code: "provider_timeout" }, null);
    const a = await repo().getByItemId(SPACE, first);
    const b = await repo().getByItemId(SPACE, second);
    expect(a?.episode_id).toBeTruthy();
    expect(b?.episode_id).toBe(a?.episode_id);
  });

  it("saves a retry that succeeds, and leaves the retry schedule and episode behind", async () => {
    if (!db.available) return;
    const retried = await seedItem();
    const skipped = await seedItem();
    await repo().enqueueItems(SPACE, [retried, skipped], CHANNEL);
    await repo().markAttemptFailed(SPACE, [retried, skipped], { error_code: "provider_timeout" }, null);
    await makeRunnable(retried);
    await makeRunnable(skipped);

    await repo().markSucceeded(SPACE, {
      source_item_id: retried,
      domain_key: "artificial_intelligence",
      depth: "analysis",
      genre: "explainer",
      summary: "Explains retrieval augmentation.",
      topic_candidates: [],
      stance_target: null,
      stance_target_key: null,
      stance_polarity: "neutral",
      stance_confidence: 0,
    }, null);
    await repo().markSkipped(SPACE, [skipped], "no_usable_annotation", null);

    expect(await repo().getByItemId(SPACE, retried)).toMatchObject({ status: "succeeded", wait_reason: null, next_retry_at: null, episode_id: null });
    expect(await repo().getByItemId(SPACE, skipped)).toMatchObject({ status: "skipped", wait_reason: null, next_retry_at: null, episode_id: null });
    // Neither is offered to the model again, and no episode is left open.
    expect(await repo().loadPendingBatch(SPACE, 10)).toEqual([]);
    expect(await repo().episodeSummaries(SPACE)).toEqual([]);
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

    // Do not accept a partial result. It looks usable and then
    // ranks against a NULL domain.
    await expect(db.pool.query(
      `UPDATE source_item_annotations SET status = 'succeeded' WHERE space_id = $1 AND source_item_id = $2`,
      [SPACE, itemId],
    )).rejects.toThrow(/ck_source_item_annotations_succeeded_complete/);
  });

  it("reopens only rows waiting on the recovered condition, bounded, keeping the episode budget", async () => {
    if (!db.available) return;
    const denied = await seedItem();
    const brokeDown = await seedItem();
    const unanswerable = await seedItem();
    await repo().enqueueItems(SPACE, [denied, brokeDown, unanswerable], CHANNEL);

    await repo().markWaiting(SPACE, [denied], "egress_denied");
    await repo().markSkipped(SPACE, [unanswerable], "no_usable_annotation", null);
    await repo().markAttemptFailed(SPACE, [brokeDown], { error_code: "provider_timeout" }, null);
    expect(await repo().loadPendingBatch(SPACE, 10)).toEqual([]);
    // A condition wait spends nothing and schedules nothing.
    expect(await repo().getByItemId(SPACE, denied)).toMatchObject({ wait_reason: "egress_denied", next_retry_at: null, attempt_count: 0 });

    expect(await repo().requeueParked(SPACE, { reasons: ["egress_denied"], limit: 10 })).toBe(1);
    expect((await repo().loadPendingBatch(SPACE, 10)).map((row) => row.id)).toEqual([denied]);

    // The retry-scheduled row keeps its attempt count through a recovery reopen.
    expect(await repo().requeueParked(SPACE, { reasons: ["retry_scheduled"], limit: 10 })).toBe(1);
    expect(await repo().getByItemId(SPACE, brokeDown)).toMatchObject({ status: "pending", wait_reason: null, attempt_count: 1 });

    // A skipped item is not a wait; it is never reopened by a recovery.
    expect(await repo().getByItemId(SPACE, unanswerable)).toMatchObject({ status: "skipped" });
  });

  it("restarts the count only for a paused episode a person retries, and respects the limit", async () => {
    if (!db.available) return;
    const items = [await seedItem(), await seedItem(), await seedItem()];
    await repo().enqueueItems(SPACE, items, CHANNEL);
    for (let i = 0; i < ANNOTATION_MAX_ATTEMPTS_PER_EPISODE; i += 1) {
      for (const item of items) await makeRunnable(item);
      await repo().markAttemptFailed(SPACE, items, { error_code: "provider_timeout" }, null);
    }
    const paused = await repo().getByItemId(SPACE, items[0]!);
    expect(paused).toMatchObject({ status: "failed", wait_reason: "budget_exhausted" });

    expect(await repo().requeueParked(SPACE, { reasons: ["budget_exhausted"], limit: 2 })).toBe(2);
    const reopened = (await Promise.all(items.map((item) => repo().getByItemId(SPACE, item))))
      .filter((row) => row?.status === "pending");
    expect(reopened).toHaveLength(2);
    for (const row of reopened) expect(row).toMatchObject({ attempt_count: 0, episode_id: null, wait_reason: null });
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

    expect(await repo().requeueParked(SPACE, {
      reasons: ["retry_scheduled", "budget_exhausted", "provider_unavailable", "egress_denied", "consent_missing"],
      limit: 10,
    })).toBe(0);
    expect((await repo().getByItemId(SPACE, done))?.status).toBe("succeeded");
  });

  it("summarizes an episode per responsible person, never counting another member's items", async () => {
    if (!db.available) return;
    const mine = await seedItem();
    const theirs = await seedItem({ owner: READER, viaConnection: false });
    await repo().enqueueItems(SPACE, [mine, theirs], CHANNEL);
    await repo().markAttemptFailed(SPACE, [mine, theirs], { error_code: "provider_timeout" }, null);

    const ownerView = await repo().episodeSummaries(SPACE, { responsibleUserId: OWNER });
    expect(ownerView).toEqual([expect.objectContaining({ wait_reason: "retry_scheduled", affected_count: 1, responsible_user_id: OWNER })]);
    const readerView = await repo().episodeSummaries(SPACE, { responsibleUserId: READER });
    expect(readerView).toEqual([expect.objectContaining({ affected_count: 1, responsible_user_id: READER, connection_ids: [] })]);
    // The countdown the notice shows is the persisted schedule.
    const row = await repo().getByItemId(SPACE, mine);
    expect(ownerView[0]!.next_retry_at).toBe(new Date(row!.next_retry_at!).toISOString());
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

describe("annotation service", () => {
  function service(): SourceAnnotationService {
    return new SourceAnnotationService(db.pool, { ...loadConfig({}), databaseUrl: db.connectionUri });
  }

  it("tells the annotator the schema version its output is parsed against", async () => {
    if (!db.available) return;
    const agent = await ensureSourceAnnotatorAgent(db.pool, SPACE);
    const prompt = await db.pool.query<{ system_prompt: string }>(
      `SELECT v.system_prompt FROM agents a JOIN agent_versions v ON v.id = a.current_version_id
        WHERE a.space_id = $1 AND a.id = $2`,
      [SPACE, agent.id],
    );
    expect(prompt.rows[0]?.system_prompt).toContain(`matching schema ${SOURCE_ANNOTATION_SCHEMA_ID}.`);
  });

  it("moves on past a batch every source of which refused egress, instead of stopping the space", async () => {
    if (!db.available) return;
    const itemId = await seedItem();
    await repo().enqueueItems(SPACE, [itemId], CHANNEL);
    await ensureSourceAnnotatorAgent(db.pool, SPACE);
    await db.pool.query(
      `UPDATE source_connections
          SET consent_json = consent_json || '{"allow_local_provider_egress": false, "allow_external_model_egress": false}'::jsonb
        WHERE id = $1`,
      [CONNECTION],
    );

    const result = await service().annotatePendingBatch(SPACE);

    // The refused items left the runnable queue to wait on the condition, so
    // this batch made progress and the job may take the next one; `blocked` is
    // for a space that cannot.
    expect(result).toMatchObject({ status: "ok", skipped: 1, annotated: 0, failed: 0, reason: "source_egress_denied" });
    expect(await repo().getByItemId(SPACE, itemId)).toMatchObject({ status: "pending", wait_reason: "consent_missing", attempt_count: 0, next_retry_at: null });
    // No loop: a second pass finds nothing runnable and spends nothing.
    expect(await service().annotatePendingBatch(SPACE)).toMatchObject({ status: "no_work" });

    // Still refused: a recovery check reopens nothing.
    expect(await service().recoverWaiting(SPACE)).toBe(0);
    // Consent granted again: the sweep's recovery reopens exactly that Source's items.
    await db.pool.query(
      `UPDATE source_connections
          SET consent_json = consent_json || '{"allow_local_provider_egress": true, "allow_external_model_egress": true}'::jsonb
        WHERE id = $1`,
      [CONNECTION],
    );
    expect(await service().recoverWaiting(SPACE)).toBe(1);
    expect(await repo().getByItemId(SPACE, itemId)).toMatchObject({ status: "pending", wait_reason: null, attempt_count: 0 });
  });

  it("tells a Space that turned external egress off apart from a Source without consent, and rechecks it before any model call", async () => {
    if (!db.available) return;
    const itemId = await seedItem();
    await repo().enqueueItems(SPACE, [itemId], CHANNEL);
    await ensureSourceAnnotatorAgent(db.pool, SPACE);
    await updateSpaceRetrievalSettings(db.pool, SPACE, { external_egress_enabled: false });

    await service().annotatePendingBatch(SPACE);

    expect(await repo().getByItemId(SPACE, itemId)).toMatchObject({ status: "pending", wait_reason: "egress_denied", attempt_count: 0, next_retry_at: null });
    expect(await service().recoverWaiting(SPACE)).toBe(0);
    await updateSpaceRetrievalSettings(db.pool, SPACE, { external_egress_enabled: true });
    expect(await service().recoverWaiting(SPACE)).toBe(1);
    expect(await repo().getByItemId(SPACE, itemId)).toMatchObject({ status: "pending", wait_reason: null, attempt_count: 0 });
  });

  it("notifies the responsible person once per episode with the waiting condition and no countdown, and clears it on recovery", async () => {
    if (!db.available) return;
    const itemId = await seedItem();
    await repo().enqueueItems(SPACE, [itemId], CHANNEL);
    await ensureSourceAnnotatorAgent(db.pool, SPACE);
    await db.pool.query(
      `UPDATE source_connections
          SET consent_json = consent_json || '{"allow_local_provider_egress": false, "allow_external_model_egress": false}'::jsonb
        WHERE id = $1`,
      [CONNECTION],
    );
    await service().annotatePendingBatch(SPACE);
    await service().annotatePendingBatch(SPACE);
    const alerts = await db.pool.query<{ user_id: string; status: string; payload_json: Record<string, unknown>; visibility: string }>(
      `SELECT user_id, status, payload_json, visibility FROM activity_records
        WHERE space_id = $1 AND activity_type = 'operational_alert' AND payload_json->>'alert_kind' = 'source_annotation_recovery'`,
      [SPACE],
    );
    expect(alerts.rows).toHaveLength(1);
    expect(alerts.rows[0]).toMatchObject({ user_id: OWNER, visibility: "private", status: "raw" });
    expect(alerts.rows[0]!.payload_json).toMatchObject({ reason: "consent_missing", affected_count: 1, next_retry_at: null, retry_available: true });

    await db.pool.query(
      `UPDATE source_connections
          SET consent_json = consent_json || '{"allow_local_provider_egress": true, "allow_external_model_egress": true}'::jsonb
        WHERE id = $1`,
      [CONNECTION],
    );
    await service().manualRetry(SPACE, OWNER);
    const after = await db.pool.query<{ status: string }>(
      `SELECT status FROM activity_records
        WHERE space_id = $1 AND activity_type = 'operational_alert' AND payload_json->>'alert_kind' = 'source_annotation_recovery'`,
      [SPACE],
    );
    expect(after.rows.map((row) => row.status)).toEqual(["archived"]);
  });

  it("leaves a dismissed notice alone while its episode is unchanged, and brings it back when it changes", async () => {
    if (!db.available) return;
    const first = await seedItem();
    await repo().enqueueItems(SPACE, [first], CHANNEL);
    await repo().markAttemptFailed(SPACE, [first], { error_code: "provider_timeout" }, null);
    const notifier = new SourceAnnotationRecoveryNotifier(db.pool);
    await notifier.sync(SPACE);
    const status = async () => (await db.pool.query<{ status: string }>(
      `SELECT status FROM activity_records
        WHERE space_id = $1 AND activity_type = 'operational_alert' AND payload_json->>'alert_kind' = 'source_annotation_recovery'`,
      [SPACE],
    )).rows.map((row) => row.status);
    expect(await status()).toEqual(["raw"]);
    await db.pool.query(
      `UPDATE activity_records SET status = 'archived', discarded_at = now()
        WHERE space_id = $1 AND activity_type = 'operational_alert'`,
      [SPACE],
    );
    // Every sweep re-syncs the same state: the person's dismissal holds.
    await notifier.sync(SPACE);
    expect(await status()).toEqual(["archived"]);
    // One more of their items joins the episode: that is news.
    const second = await seedItem();
    await repo().enqueueItems(SPACE, [second], CHANNEL);
    await repo().markAttemptFailed(SPACE, [second], { error_code: "provider_timeout" }, null);
    await notifier.sync(SPACE);
    expect(await status()).toEqual(["raw"]);
  });

  it("visits every waiting space in turn, not the same first few every sweep", async () => {
    if (!db.available) return;
    const mine = await seedItem();
    const theirs = await seedItem({ spaceId: OTHER_SPACE });
    await repo().enqueueItems(SPACE, [mine], CHANNEL);
    await repo().enqueueItems(OTHER_SPACE, [theirs], null);
    await repo().markWaiting(SPACE, [mine], "provider_unavailable");
    await repo().markWaiting(OTHER_SPACE, [theirs], "provider_unavailable");
    const [firstSpace, secondSpace] = [SPACE, OTHER_SPACE].sort();

    expect(await repo().spacesWithWaitingConditions(1, null)).toEqual([firstSpace]);
    expect(await repo().spacesWithWaitingConditions(1, firstSpace!)).toEqual([secondSpace]);
    // Past the last one it wraps round.
    expect(await repo().spacesWithWaitingConditions(1, secondSpace!)).toEqual([firstSpace]);
  });

  it("waits without spending or a countdown while the space has no usable annotator", async () => {
    if (!db.available) return;
    const itemId = await seedItem();
    await repo().enqueueItems(SPACE, [itemId], CHANNEL);
    const agent = await ensureSourceAnnotatorAgent(db.pool, SPACE);
    await db.pool.query(`UPDATE agent_runtime_profiles SET enabled = FALSE, is_default = FALSE WHERE space_id = $1 AND agent_id = $2`, [SPACE, agent.id]);

    expect(await service().annotatePendingBatch(SPACE)).toMatchObject({ status: "blocked", failed: 0 });
    expect(await repo().getByItemId(SPACE, itemId)).toMatchObject({ status: "pending", wait_reason: "provider_unavailable", attempt_count: 0, next_retry_at: null });
    expect(await service().annotatePendingBatch(SPACE)).toMatchObject({ status: "no_work" });
  });

  it("runs one annotation pass per space at a time, whoever queued the job", async () => {
    if (!db.available) return;
    const handlers = new JobHandlerRegistry();
    registerSourceAnnotationHandler(handlers, { ...loadConfig({}), databaseUrl: db.connectionUri });
    const holder = await db.pool.connect();
    try {
      await holder.query("SELECT pg_advisory_lock(hashtextextended($1, 0))", [`source_annotation:${SPACE}`]);
      const result = await handlers.dispatch({
        id: randomUUID(), space_id: SPACE, user_id: OWNER, job_type: SOURCE_ANNOTATION_JOB_TYPE,
        payload: { trigger: "manual_retry" }, attempts: 1, max_attempts: 1,
      } as never);
      expect(result).toMatchObject({ last_status: "already_running", passes: 0 });
    } finally {
      await holder.query("SELECT pg_advisory_unlock(hashtextextended($1, 0))", [`source_annotation:${SPACE}`]);
      holder.release();
    }
  });

  it("keeps items queued when the egress check fails for a reason other than a denial", async () => {
    if (!db.available) return;
    const itemId = await seedItem();
    await repo().enqueueItems(SPACE, [itemId], CHANNEL);
    const agent = await ensureSourceAnnotatorAgent(db.pool, SPACE);
    // An Agent with no enabled runtime profile cannot be resolved to an egress
    // destination: a configuration gap of the annotator, not the source's refusal.
    await db.pool.query(`UPDATE agent_runtime_profiles SET enabled = FALSE, is_default = FALSE WHERE space_id = $1 AND agent_id = $2`, [SPACE, agent.id]);

    const result = await service().annotatePendingBatch(SPACE);

    expect(result).toMatchObject({ status: "blocked", skipped: 0, failed: 0 });
    const row = await repo().getByItemId(SPACE, itemId);
    expect(row).toMatchObject({ status: "pending", attempt_count: 0, wait_reason: "provider_unavailable" });
  });
});
