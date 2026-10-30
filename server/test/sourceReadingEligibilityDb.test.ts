import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { useTestDatabase } from "./support/testDatabase.js";
import { resetTables } from "./support/resetTables.js";
import { PgSourceAnnotationRepository } from "../src/modules/sourceAnnotation/repository.js";
import { InterestProfileService } from "../src/modules/interestProfile/service.js";
import { PgInterestProfileRepository } from "../src/modules/interestProfile/repository.js";
import { SourceChannelService } from "../src/modules/sources/channels/sourceChannelService.js";
import { PgSourcesRepository } from "../src/modules/sources/repository.js";
import { sourceItemReadableClause } from "../src/modules/sources/sourceItemAccess.js";
import { PgFrontendSupportService } from "../src/modules/frontendSupport/service.js";
import { openSubscriptionWindow } from "../src/modules/sources/channels/subscriptionWindows.js";
import { PgReaderRepository } from "../src/modules/reader/repository.js";
import { PgArtifactRepository } from "../src/modules/artifacts/repository.js";
import { materializeExternalDiscovery } from "../src/modules/sources/externalDiscoveryMaterializer.js";
import { readerContentFromFetchedText } from "../src/modules/sources/contentParsing.js";

// Real-Postgres coverage for reading eligibility (plan P07): what a reader may
// still open after leaving a source, what counts as their interest evidence,
// how a URL save is deduplicated, what Today counts as *their* reading, and
// who an Inbox briefing pointer reaches.

const SPACE = "11111111-1111-4111-8111-111111111111";
const OWNER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const READER = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const CONNECTOR = "33333333-3333-4333-8333-333333333333";
const CONNECTION = "44444444-4444-4444-8444-444444444444";

const config = loadConfig({ SERVER_DATABASE_URL: "postgresql://server@db:5432/rainver" });
const db = useTestDatabase(import.meta.filename);

beforeEach(async () => {
  if (!db.available) return;
  await resetTables(
    db.pool,
    [
      "activity_records", "source_post_processing_runs", "interest_topic_observations", "interest_topic_candidates",
      "interest_topics", "interest_profiles", "source_item_annotations", "source_item_user_states", "source_items",
      "artifacts", "content_access_grants", "source_channel_subscription_windows",
      "source_channel_user_subscriptions", "source_channels", "source_connections", "source_provider_connectors",
      "source_providers", "source_connectors", "space_memberships", "users", "spaces",
    ],
    { cascade: true },
  );
  const now = new Date().toISOString();
  await db.pool.query(`INSERT INTO spaces (id, name, type, created_at, updated_at) VALUES ($1,'Team','team',$2,$2)`, [SPACE, now]);
  for (const user of [OWNER, READER]) {
    await db.pool.query(
      `INSERT INTO users (id, display_name, status, created_at, updated_at, email, registration_source)
       VALUES ($1,$1,'active',$2,$2, lower(gen_random_uuid()::text || '@test.invalid'), 'system')`,
      [user, now],
    );
    await db.pool.query(
      `INSERT INTO space_memberships (id, space_id, user_id, role, status, created_at, updated_at)
       VALUES ($1,$2,$3,$4,'active',$5,$5)`,
      [randomUUID(), SPACE, user, user === OWNER ? "owner" : "member", now],
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
  // A shared feed both members read; READER is a subscriber, not the owner.
  await db.pool.query(
    `INSERT INTO source_connections (
       id, space_id, provider_connector_id, owner_user_id, name, status, visibility,
       capture_policy, trust_level, consent_json, policy_json, config_json, created_at, updated_at
     ) VALUES ($1,$2,$3,$4,'Feed','active','space_shared','reference_only','normal','{}'::jsonb,'{}'::jsonb,'{}'::jsonb,$5,$5)`,
    [CONNECTION, SPACE, mappingId, OWNER, now],
  );
  await db.pool.query(
    `INSERT INTO source_channels (
       id, space_id, source_connection_id, created_by_user_id, name, channel_type, endpoint_url,
       query_json, provider_query_json, query_fingerprint, status, fetch_frequency, schedule_rule_json, created_at, updated_at
     ) VALUES ($1,$2,$1,$3,'Feed Channel','feed','https://example.com/rss','{}'::jsonb,'{}'::jsonb,$1,'active','daily','{"frequency":"daily","hour":0,"minute":0}'::jsonb,$4,$4)`,
    [CONNECTION, SPACE, OWNER, now],
  );
  const subscribedAt = new Date(Date.now() - 86_400_000).toISOString();
  for (const user of [OWNER, READER]) {
    await db.pool.query(
      `INSERT INTO source_channel_user_subscriptions (
         id, space_id, source_channel_id, user_id, status, library_enabled, digest_enabled, created_at, updated_at
       ) VALUES ($1,$2,$3,$4,'subscribed',true,true,$5,$5)`,
      [randomUUID(), SPACE, CONNECTION, user, subscribedAt],
    );
    await openSubscriptionWindow(db.pool, { spaceId: SPACE, channelId: CONNECTION, userId: user, at: subscribedAt });
  }
});

const identity = (userId: string) => ({ spaceId: SPACE, userId });

async function seedItem(options: { domain?: string; firstSeenAt?: string } = {}): Promise<string> {
  const itemId = randomUUID();
  // A moment ago by default: a window is half-open, so an item stamped in the
  // same instant a reader leaves would fall outside it.
  const seen = options.firstSeenAt ?? new Date(Date.now() - 1_000).toISOString();
  await db.pool.query(
    `INSERT INTO source_items (
       id, space_id, owner_user_id, visibility, connection_id, item_type, title, source_uri,
       first_seen_at, last_seen_at, content_state, retention_policy, created_at, updated_at
     ) VALUES ($1,$2,$3,'space_shared',$4,'feed_entry',$5,$6,$7,$7,'excerpt_saved','summary_only',$7,$7)`,
    [itemId, SPACE, OWNER, CONNECTION, `Item ${itemId.slice(0, 8)}`, `https://example.com/${itemId}`, seen],
  );
  await db.pool.query(
    `UPDATE source_items SET excerpt = 'Delivered text for the reader.' WHERE id = $1`,
    [itemId],
  );
  if (options.domain) {
    const annotations = new PgSourceAnnotationRepository(db.pool);
    await annotations.enqueueItems(SPACE, [itemId], null);
    await annotations.markSucceeded(SPACE, {
      source_item_id: itemId, domain_key: options.domain, depth: "analysis", genre: "explainer", summary: "s",
      topic_candidates: [], stance_target: null, stance_target_key: null, stance_polarity: "neutral", stance_confidence: 0,
    }, null);
  }
  return itemId;
}

async function markRead(userId: string, itemId: string, origin: "library" | "serendipity"): Promise<void> {
  const now = new Date().toISOString();
  await db.pool.query(
    `INSERT INTO source_item_user_states (id, space_id, source_item_id, user_id, library_status, read_status, last_opened_at, read_origin, progress_json, created_at, updated_at)
     VALUES ($1,$2,$3,$4,'new','read',$5,$6,'{}'::jsonb,$5,$5)`,
    [randomUUID(), SPACE, itemId, userId, now, origin],
  );
}

async function readable(userId: string, itemId: string): Promise<boolean> {
  const result = await db.pool.query(
    `SELECT 1 FROM source_items si WHERE si.space_id = $1 AND si.id = $2 AND ${sourceItemReadableClause("si", "$3", true)}`,
    [SPACE, itemId, userId],
  );
  return (result.rowCount ?? 0) === 1;
}

/** Whether the Reader serves the item to this person, through its own gates. */
async function readerServes(userId: string, itemId: string): Promise<boolean> {
  return new PgReaderRepository(db.pool, config)
    .getDocument(identity(userId), "source_item", itemId)
    .then((document) => document !== null, () => false);
}

const coverage = async (userId: string) =>
  (await new PgInterestProfileRepository(db.pool).coverageByDomain(SPACE, userId)).map((entry) => entry.domain_key);

describe("interest evidence", () => {
  it("does not count a read reached through the serendipity section, and does count one the reader reached", async (ctx) => {
    if (!db.available) return ctx.skip();
    await markRead(READER, await seedItem({ domain: "sports" }), "serendipity");
    await markRead(READER, await seedItem({ domain: "cooking" }), "library");
    expect(await coverage(READER)).toEqual(["cooking"]);
  });
});

describe("leaving a source", () => {
  it("keeps what was delivered readable, stops new items, and drops the source's automatic facts", async (ctx) => {
    if (!db.available) return ctx.skip();
    const delivered = await seedItem({ domain: "history" });
    await markRead(READER, delivered, "library");
    const service = new InterestProfileService(db.pool);
    await service.runFactLayer(SPACE, READER);
    expect(await coverage(READER)).toEqual(["history"]);

    await new SourceChannelService(db.pool, config).setSubscription(identity(READER), CONNECTION, "muted");
    const later = await seedItem({ firstSeenAt: new Date(Date.now() + 60_000).toISOString() });

    // History stays readable; what arrives after leaving does not.
    expect(await readable(READER, delivered)).toBe(true);
    expect(await readable(READER, later)).toBe(false);
    // Automatic facts from the source stop counting.
    expect(await coverage(READER)).toEqual([]);
    const observations = await db.pool.query(`SELECT 1 FROM interest_topic_observations o JOIN interest_profiles p ON p.id = o.profile_id WHERE p.user_id = $1`, [READER]);
    expect(observations.rowCount).toBe(0);

    // Rejoining opens a new window: the new item becomes readable again.
    await new SourceChannelService(db.pool, config).setSubscription(identity(READER), CONNECTION, "subscribed");
    expect(await readable(READER, later)).toBe(true);
  });

  it("ends historical access when the source itself is withdrawn", async (ctx) => {
    if (!db.available) return ctx.skip();
    // Delivered before leaving: the window is half-open, so an item stamped in
    // the very instant of leaving would not be inside it.
    const delivered = await seedItem({ firstSeenAt: new Date(Date.now() - 60_000).toISOString() });
    await new SourceChannelService(db.pool, config).setSubscription(identity(READER), CONNECTION, "muted");
    expect(await readable(READER, delivered)).toBe(true);
    await db.pool.query(`UPDATE source_connections SET visibility = 'private' WHERE id = $1`, [CONNECTION]);
    expect(await readable(READER, delivered)).toBe(false);
    await db.pool.query(`UPDATE source_connections SET visibility = 'space_shared', status = 'archived' WHERE id = $1`, [CONNECTION]);
    expect(await readable(READER, delivered)).toBe(false);
  });

  it("keeps the owner's accepted topics when facts are rebuilt", async (ctx) => {
    if (!db.available) return ctx.skip();
    const service = new InterestProfileService(db.pool);
    await service.createTopic(SPACE, READER, { label: "Maritime history", domainKey: "history" });
    await new SourceChannelService(db.pool, config).setSubscription(identity(READER), CONNECTION, "muted");
    const topics = await db.pool.query(
      `SELECT t.label FROM interest_topics t JOIN interest_profiles p ON p.id = t.profile_id WHERE p.user_id = $1 AND t.status = 'active'`,
      [READER],
    );
    expect(topics.rows.map((row) => row.label)).toEqual(["Maritime history"]);
  });
});

describe("saved URLs", () => {
  it("deduplicates a personal save per owner, never across members", async (ctx) => {
    if (!db.available) return ctx.skip();
    const repo = new PgSourcesRepository(db.pool, config);
    const mine = await repo.createManualUrl(identity(OWNER), { url: "https://example.org/article" }) as { id: string };
    const again = await repo.createManualUrl(identity(OWNER), { url: "https://example.org/article" }) as { id: string };
    const theirs = await repo.createManualUrl(identity(READER), { url: "https://example.org/article" }) as { id: string };
    expect(again.id).toBe(mine.id);
    expect(theirs.id).not.toBe(mine.id);
    const owners = await db.pool.query(`SELECT owner_user_id FROM source_items WHERE canonical_uri LIKE 'https://example.org/article%' ORDER BY owner_user_id`);
    expect(owners.rows.map((row) => row.owner_user_id)).toEqual([OWNER, READER]);
  });
});

describe("Today", () => {
  it("counts each person's own unread items, untouched by another member's reading", async (ctx) => {
    if (!db.available) return ctx.skip();
    const a = await seedItem();
    await seedItem();
    await markRead(OWNER, a, "library");
    await db.pool.query(
      `INSERT INTO source_item_user_states (id, space_id, source_item_id, user_id, library_status, read_status, progress_json, created_at, updated_at)
       VALUES ($1,$2,$3,$4,'archived','unread','{}'::jsonb,now(),now())
       ON CONFLICT (space_id, source_item_id, user_id) DO UPDATE SET library_status = 'archived'`,
      [randomUUID(), SPACE, a, OWNER],
    );
    const service = new PgFrontendSupportService(db.pool);
    const owner = await service.homeSummary(identity(OWNER), {});
    const reader = await service.homeSummary(identity(READER), {});
    expect(owner.source_summary.pending_reading_items).toBe(1);
    expect(reader.source_summary.pending_reading_items).toBe(2);
  });
});

describe("reading eligibility across every reading path", () => {
  it("keeps the Reader open for what was delivered after leaving, and closes it when the source is withdrawn", async (ctx) => {
    if (!db.available) return ctx.skip();
    const delivered = await seedItem();
    expect(await readerServes(READER, delivered)).toBe(true);
    await new SourceChannelService(db.pool, config).setSubscription(identity(READER), CONNECTION, "muted");
    expect(await readerServes(READER, delivered)).toBe(true);
    await db.pool.query(`UPDATE source_connections SET status = 'archived' WHERE id = $1`, [CONNECTION]);
    expect(await readerServes(READER, delivered)).toBe(false);
  });

  it("keeps every earlier subscription period readable after leaving and rejoining", async (ctx) => {
    if (!db.available) return ctx.skip();
    const firstPeriod = await seedItem({ firstSeenAt: new Date(Date.now() - 3_600_000).toISOString() });
    const channels = new SourceChannelService(db.pool, config);
    await channels.setSubscription(identity(READER), CONNECTION, "muted");
    await channels.setSubscription(identity(READER), CONNECTION, "subscribed");
    await channels.setSubscription(identity(READER), CONNECTION, "muted");
    expect(await readable(READER, firstPeriod)).toBe(true);
    expect(await readerServes(READER, firstPeriod)).toBe(true);
    const windows = await db.pool.query(
      `SELECT unsubscribed_at FROM source_channel_subscription_windows WHERE user_id = $1 ORDER BY subscribed_at`,
      [READER],
    );
    expect(windows.rows).toHaveLength(2);
    expect(windows.rows.every((row) => row.unsubscribed_at !== null)).toBe(true);
  });

  it("cuts a current subscriber off when the channel is archived", async (ctx) => {
    if (!db.available) return ctx.skip();
    const item = await seedItem();
    expect(await readable(READER, item)).toBe(true);
    await db.pool.query(`UPDATE source_channels SET status = 'archived' WHERE id = $1`, [CONNECTION]);
    expect(await readable(READER, item)).toBe(false);
    expect(await readerServes(READER, item)).toBe(false);
  });

  it("keeps the connection's owner reading its items directly after archiving its only monitor", async (ctx) => {
    if (!db.available) return ctx.skip();
    const item = await seedItem();
    await db.pool.query(`UPDATE source_channels SET status = 'archived' WHERE id = $1`, [CONNECTION]);
    const direct = await db.pool.query(
      `SELECT 1 FROM source_items si WHERE si.space_id = $1 AND si.id = $2 AND ${sourceItemReadableClause("si", "$3", false)}`,
      [SPACE, item, OWNER],
    );
    // Reader and direct reads agree; only the Library listing follows the monitor.
    expect(direct.rowCount).toBe(1);
    expect(await readerServes(OWNER, item)).toBe(true);
    expect(await readable(OWNER, item)).toBe(false);
  });

  it("ends the owner's direct reads too once the connection itself is archived", async (ctx) => {
    if (!db.available) return ctx.skip();
    const item = await seedItem();
    // Only the owner path is under test: no consent exception for Space admins.
    await db.pool.query(
      `UPDATE source_connections SET status = 'archived', consent_json = consent_json || '{"allow_space_admins": false}'::jsonb WHERE id = $1`,
      [CONNECTION],
    );
    const direct = await db.pool.query(
      `SELECT 1 FROM source_items si WHERE si.space_id = $1 AND si.id = $2 AND ${sourceItemReadableClause("si", "$3", false)}`,
      [SPACE, item, OWNER],
    );
    expect(direct.rowCount).toBe(0);
    expect(await readerServes(OWNER, item)).toBe(false);
  });

  it.for(["item", "snapshot"])("keeps a Source-derived artifact behind its %s access level and consent", async (origin, ctx) => {
    if (!db.available) return ctx.skip();
    const item = await seedItem();
    const artifactId = randomUUID();
    const content = JSON.stringify(readerContentFromFetchedText("Full extracted text", "text/plain", "https://example.com/article"));
    await db.pool.query(
      `INSERT INTO artifacts (
         id, space_id, artifact_type, title, content, mime_type, exportable, export_formats_json, preview,
         metadata_json, created_at, updated_at, visibility, access_level, owner_user_id, trust_level
       ) VALUES ($1,$2,'source_reader_document','Extracted',$4,'application/json',true,'["application/json"]'::jsonb,false,
         '{}'::jsonb, now(), now(), 'space_shared', 'full', $3, 'medium')`,
      [artifactId, SPACE, OWNER, content],
    );
    const snapshotId = randomUUID();
    if (origin === "item") {
      await db.pool.query(`UPDATE source_items SET extracted_artifact_id = $2 WHERE id = $1`, [item, artifactId]);
    } else {
      await db.pool.query(
        `INSERT INTO source_snapshots (id, space_id, connection_id, source_item_id, artifact_id, snapshot_type,
          capture_method, trust_level, captured_at, created_at, updated_at, owner_user_id, visibility, access_level)
         VALUES ($1,$2,$3,$4,$5,'extracted','manual','normal',now(),now(),now(),$6,'space_shared','full')`,
        [snapshotId, SPACE, CONNECTION, item, artifactId, OWNER],
      );
    }
    const artifacts = new PgArtifactRepository(db.pool, { artifactStorageRoot: "/nonexistent", sandboxRoot: "/nonexistent" });
    await expect(artifacts.getVisible(SPACE, READER, artifactId, true)).resolves.toMatchObject({ content });
    await expect(artifacts.exportVisible(SPACE, READER, artifactId)).resolves.toMatchObject({ body: Buffer.from(content) });
    const reader = new PgReaderRepository(db.pool, config);
    const readDocument = () => reader.getDocument(identity(READER), origin === "item" ? "source_item" : "source_snapshot", origin === "item" ? item : snapshotId);
    await expect(readDocument()).resolves.toMatchObject({ plain_text: "Full extracted text" });

    await db.pool.query(`UPDATE source_items SET access_level = 'summary' WHERE id = $1`, [item]);
    await expect(artifacts.getVisible(SPACE, READER, artifactId, true)).resolves.toMatchObject({ content: null });
    await expect(artifacts.exportVisible(SPACE, READER, artifactId)).resolves.toBeNull();
    await expect(readDocument()).resolves.toBeNull();
    await expect(artifacts.exportVisible(SPACE, OWNER, artifactId)).resolves.not.toBeNull();
    await db.pool.query(`UPDATE source_items SET access_level = 'full' WHERE id = $1`, [item]);
    if (origin === "snapshot") {
      await db.pool.query(`UPDATE source_snapshots SET access_level = 'summary' WHERE id = $1`, [snapshotId]);
      await expect(artifacts.getVisible(SPACE, READER, artifactId, true)).resolves.toMatchObject({ content: null });
      await expect(artifacts.exportVisible(SPACE, READER, artifactId)).resolves.toBeNull();
      await db.pool.query(`UPDATE source_snapshots SET visibility = 'private' WHERE id = $1`, [snapshotId]);
      await expect(artifacts.getVisible(SPACE, READER, artifactId, true)).resolves.toBeNull();
      await db.pool.query(`UPDATE source_snapshots SET visibility = 'space_shared', access_level = 'full' WHERE id = $1`, [snapshotId]);
    }
    await db.pool.query(`UPDATE artifacts SET access_level = 'summary' WHERE id = $1`, [artifactId]);
    const withheldDocument = await readDocument();
    if (origin === "item") expect(withheldDocument?.plain_text).toBe("Delivered text for the reader.");
    else expect(withheldDocument).toBeNull();
    await db.pool.query(`UPDATE artifacts SET access_level = 'full' WHERE id = $1`, [artifactId]);

    // Narrowing the connection withdraws the copy with the item.
    await db.pool.query(`UPDATE source_connections SET visibility = 'private' WHERE id = $1`, [CONNECTION]);
    await expect(artifacts.getVisible(SPACE, READER, artifactId)).resolves.toBeNull();
    const listed = await artifacts.listVisible(SPACE, READER, { artifactType: "source_reader_document", limit: 50, offset: 0 });
    expect(listed.items.map((row) => row.id)).not.toContain(artifactId);
    expect(listed.total).toBe(0);
  });

  it("gives a discovery its own personal copy of a URL another member saved privately", async (ctx) => {
    if (!db.available) return ctx.skip();
    const saved = await new PgSourcesRepository(db.pool, config).createManualUrl(identity(OWNER), { url: "https://example.org/shared-paper", visibility: "private" }) as { id: string };
    const [discovered] = await materializeExternalDiscovery(db.pool, {
      spaceId: SPACE, projectId: null, userId: READER, discoveryKey: "probe",
      samples: [{ source_uri: "https://example.org/shared-paper", title: "Shared paper" }] as never,
    });
    expect(discovered).toBeDefined();
    expect(discovered).not.toBe(saved.id);
    const owner = await db.pool.query(`SELECT owner_user_id FROM source_items WHERE id = $1`, [saved.id]);
    expect(owner.rows[0]!.owner_user_id).toBe(OWNER);
  });

  it("does not count another member's private items in an admin's own reading", async (ctx) => {
    if (!db.available) return ctx.skip();
    await new PgSourcesRepository(db.pool, config).createManualUrl(identity(READER), { url: "https://example.org/private-note", visibility: "private" });
    const owner = await new PgFrontendSupportService(db.pool).homeSummary(identity(OWNER), {});
    expect(owner.source_summary.pending_reading_items).toBe(0);
  });
});
