import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { useTestDatabase } from "./support/testDatabase.js";
import { resetTables } from "./support/resetTables.js";
import { buildModuleServer } from "./support/moduleServer.js";
import { PgSourceAnnotationRepository } from "../src/modules/sourceAnnotation/repository.js";
import { InterestProfileService } from "../src/modules/interestProfile/service.js";
import { PgInterestProfileRepository } from "../src/modules/interestProfile/repository.js";
import { SourceChannelService } from "../src/modules/sources/channels/sourceChannelService.js";
import { openSubscriptionWindow } from "../src/modules/sources/channels/subscriptionWindows.js";
import { sourceItemReadableClause } from "../src/modules/sources/sourceItemAccess.js";
import { PgReaderRepository } from "../src/modules/reader/repository.js";
import { PgArtifactRepository } from "../src/modules/artifacts/repository.js";
import { PgFrontendSupportService } from "../src/modules/frontendSupport/service.js";
import { PgMemoryReadRepository } from "../src/modules/memory/repository.js";
import { PgTaskRepository } from "../src/modules/tasks/repository.js";
import { canConfigureAssistant } from "../src/modules/agents/agentAccess.js";
import { informationDigestModule } from "../src/modules/informationDigest/index.js";
import { __setAuthIdentityForTests } from "../src/modules/auth/identity.js";

/**
 * Cross-module acceptance scenarios: each test drives the real services of
 * several modules over one shared fixture, the way a person moves through
 * the product, rather than one rule of one module at a time.
 *
 * Shared fixture: a team Space created by OWNER, with READER as an admin, and
 * a space-shared feed OWNER owns and both follow.
 */

const SPACE = "71111111-1111-4111-8111-111111111111";
const OWNER = "7aaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const READER = "7bbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const CONNECTOR = "73333333-3333-4333-8333-333333333333";
const CONNECTION = "74444444-4444-4444-8444-444444444444";

const config = loadConfig({ SERVER_DATABASE_URL: "postgresql://server@db:5432/rainver" });
const db = useTestDatabase(import.meta.filename);

beforeEach(async () => {
  if (!db.available) return;
  await resetTables(
    db.pool,
    [
      "information_digest_items", "information_digests", "interest_topic_observations", "interest_topic_candidates",
      "interest_topics", "interest_profiles", "source_item_annotations", "source_item_user_states", "source_items",
      "artifacts", "content_access_grants", "content_access_logs", "memory_entries", "tasks",
      "source_channel_subscription_windows", "source_channel_user_subscriptions", "source_channels",
      "source_connections", "source_provider_connectors", "source_providers", "source_connectors",
      "space_memberships", "users", "spaces",
    ],
    { cascade: true },
  );
  const now = new Date().toISOString();
  for (const user of [OWNER, READER]) {
    await db.pool.query(
      `INSERT INTO users (id, display_name, status, created_at, updated_at, email, registration_source)
       VALUES ($1,$1,'active',$2,$2, lower(gen_random_uuid()::text || '@test.invalid'), 'system')`,
      [user, now],
    );
  }
  await db.pool.query(
    `INSERT INTO spaces (id, name, type, created_by_user_id, created_at, updated_at) VALUES ($1,'Team','team',$2,$3,$3)`,
    [SPACE, OWNER, now],
  );
  for (const [user, role] of [[OWNER, "owner"], [READER, "admin"]] as const) {
    await db.pool.query(
      `INSERT INTO space_memberships (id, space_id, user_id, role, status, created_at, updated_at)
       VALUES ($1,$2,$3,$4,'active',$5,$5)`,
      [randomUUID(), SPACE, user, role, now],
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

afterEach(() => {
  __setAuthIdentityForTests(null);
});

const identity = (userId: string) => ({ spaceId: SPACE, userId });

async function seedItem(domain?: string): Promise<string> {
  const itemId = randomUUID();
  const seen = new Date(Date.now() - 60_000).toISOString();
  await db.pool.query(
    `INSERT INTO source_items (
       id, space_id, owner_user_id, visibility, connection_id, item_type, title, source_uri, excerpt,
       first_seen_at, last_seen_at, content_state, retention_policy, created_at, updated_at
     ) VALUES ($1,$2,$3,'space_shared',$4,'feed_entry',$5,$6,'Delivered text.',$7,$7,'excerpt_saved','summary_only',$7,$7)`,
    [itemId, SPACE, OWNER, CONNECTION, `Item ${itemId.slice(0, 8)}`, `https://example.com/${itemId}`, seen],
  );
  if (domain) {
    const annotations = new PgSourceAnnotationRepository(db.pool);
    await annotations.enqueueItems(SPACE, [itemId], null);
    await annotations.markSucceeded(SPACE, {
      source_item_id: itemId, domain_key: domain, depth: "analysis", genre: "explainer", summary: "s",
      topic_candidates: [], stance_target: null, stance_target_key: null, stance_polarity: "neutral", stance_confidence: 0,
    }, null);
  }
  return itemId;
}

async function markRead(userId: string, itemId: string): Promise<void> {
  await db.pool.query(
    `INSERT INTO source_item_user_states (id, space_id, source_item_id, user_id, library_status, read_status, last_opened_at, read_origin, progress_json, created_at, updated_at)
     VALUES ($1,$2,$3,$4,'new','read',now(),'library','{}'::jsonb,now(),now())`,
    [randomUUID(), SPACE, itemId, userId],
  );
}

async function libraryReadable(userId: string, itemId: string): Promise<boolean> {
  const result = await db.pool.query(
    `SELECT 1 FROM source_items si WHERE si.space_id = $1 AND si.id = $2 AND ${sourceItemReadableClause("si", "$3", false)}`,
    [SPACE, itemId, userId],
  );
  return (result.rowCount ?? 0) === 1;
}

async function readerServes(userId: string, itemId: string): Promise<boolean> {
  return new PgReaderRepository(db.pool, config)
    .getDocument(identity(userId), "source_item", itemId)
    .then((document) => document !== null, () => false);
}

describe("two people in one shared Space", () => {
  it("keeps each person's Memory, reading state and Assistant authority their own, while team work is shared", async () => {
    if (!db.available) return;
    // Personal Memory: the other member, even an admin, does not read it.
    const memoryId = randomUUID();
    await db.pool.query(
      `INSERT INTO memory_entries
         (id, space_id, scope_type, memory_type, content, status, owner_user_id, sensitivity_level, visibility,
          access_level, confidence, importance, version, access_count, created_at, updated_at)
       VALUES ($1,$2,'user','preference','Prefers morning briefings','active',$3,'normal','private','full',1,1,1,0,now(),now())`,
      [memoryId, SPACE, OWNER],
    );
    const memories = new PgMemoryReadRepository(db.pool);
    await expect(memories.get(SPACE, OWNER, memoryId)).resolves.toMatchObject({ content: "Prefers morning briefings" });
    expect((await memories.get(SPACE, READER, memoryId))?.content ?? null).toBeNull();

    // Reading state: each person's pending reading counts only their own reads.
    const first = await seedItem();
    await seedItem();
    await markRead(OWNER, first);
    const home = new PgFrontendSupportService(db.pool);
    expect((await home.homeSummary(identity(OWNER), {})).source_summary.pending_reading_items).toBe(1);
    expect((await home.homeSummary(identity(READER), {})).source_summary.pending_reading_items).toBe(2);

    // The shared Space's Assistant is configured by its creator, not by an admin.
    await expect(canConfigureAssistant(db.pool, identity(OWNER), { projectId: null })).resolves.toBe(true);
    await expect(canConfigureAssistant(db.pool, identity(READER), { projectId: null })).resolves.toBe(false);

    // Team work is visible to the team; a private Task stays its owner's.
    const tasks = new PgTaskRepository(db.pool);
    const shared = await tasks.createTask(identity(OWNER), { title: "Team plan", visibility: "space_shared" });
    const privateTask = await tasks.createTask(identity(OWNER), { title: "My errand", visibility: "private" });
    await expect(tasks.getTask(identity(READER), shared.id)).resolves.toMatchObject({ title: "Team plan" });
    const hidden = await tasks.getTask(identity(READER), privateTask.id).then((task) => task, () => null);
    expect(hidden).toBeNull();
  });
});

describe("leaving a source and losing it", () => {
  it("keeps what was delivered readable in Library, the Reader, the artifact and its export, stops the profile, and closes all of them when the source is withdrawn", async () => {
    if (!db.available) return;
    // A plain member subscriber: an admin's review is a separate path, below.
    await db.pool.query(`UPDATE space_memberships SET role = 'member' WHERE space_id = $1 AND user_id = $2`, [SPACE, READER]);
    const item = await seedItem("history");
    await markRead(READER, item);
    await new InterestProfileService(db.pool).runFactLayer(SPACE, READER);
    const coverage = async () =>
      (await new PgInterestProfileRepository(db.pool).coverageByDomain(SPACE, READER)).map((entry) => entry.domain_key);
    expect(await coverage()).toEqual(["history"]);

    const artifactId = randomUUID();
    await db.pool.query(
      `INSERT INTO artifacts (
         id, space_id, artifact_type, title, content, mime_type, exportable, export_formats_json, preview,
         metadata_json, created_at, updated_at, visibility, access_level, owner_user_id, trust_level
       ) VALUES ($1,$2,'source_reader_document','Extracted','Full extracted text','text/plain',true,'["text/plain"]'::jsonb,false,
         '{}'::jsonb, now(), now(), 'space_shared', 'full', $3, 'medium')`,
      [artifactId, SPACE, OWNER],
    );
    await db.pool.query(`UPDATE source_items SET extracted_artifact_id = $2 WHERE id = $1`, [item, artifactId]);
    const artifacts = new PgArtifactRepository(db.pool, { artifactStorageRoot: "/nonexistent", sandboxRoot: "/nonexistent" });
    const everyPath = async () => ({
      library: await libraryReadable(READER, item),
      reader: await readerServes(READER, item),
      artifact: (await artifacts.getVisible(SPACE, READER, artifactId)) !== null,
      export: (await artifacts.exportVisible(SPACE, READER, artifactId).then((exported) => exported, () => null)) !== null,
    });

    // Leaving: the delivered item stays readable on every path; the automatic
    // interest facts from that source stop counting.
    await new SourceChannelService(db.pool, config).setSubscription(identity(READER), CONNECTION, "muted");
    expect(await everyPath()).toEqual({ library: true, reader: true, artifact: true, export: true });
    expect(await coverage()).toEqual([]);

    // Losing the source (withdrawn from the reader) closes every path.
    await db.pool.query(`UPDATE source_connections SET visibility = 'private' WHERE id = $1`, [CONNECTION]);
    expect(await everyPath()).toEqual({ library: false, reader: false, artifact: false, export: false });

    // A Space admin may review the document where the consent allows it, and
    // then every single-document path agrees; it never joins their Library.
    await db.pool.query(`UPDATE space_memberships SET role = 'admin' WHERE space_id = $1 AND user_id = $2`, [SPACE, READER]);
    expect(await everyPath()).toEqual({ library: false, reader: true, artifact: true, export: true });
    await db.pool.query(
      `UPDATE source_connections SET consent_json = '{"allow_space_admins": false}'::jsonb WHERE id = $1`,
      [CONNECTION],
    );
    expect(await everyPath()).toEqual({ library: false, reader: false, artifact: false, export: false });
  });
});

describe("language never decides a report's day or its access", () => {
  it("answers the same digest day, interval and backfill for a request in Chinese as in English", async () => {
    if (!db.available) return;
    __setAuthIdentityForTests({ spaceId: SPACE, userId: OWNER });
    const app = buildModuleServer(loadConfig({ SERVER_DATABASE_URL: db.connectionUri }), [informationDigestModule]);
    try {
      const read = (language: string) => app.inject({
        method: "GET",
        url: `/api/v1/spaces/${SPACE}/information-digests/personal`,
        headers: { "accept-language": language },
      });
      const english = await read("en");
      const chinese = await read("zh-CN,zh;q=0.9");
      expect(english.statusCode).toBe(200);
      expect(chinese.json()).toEqual(english.json());
      const { digest_date: day } = english.json() as { digest_date: string };

      const backfilled = await app.inject({
        method: "POST",
        url: `/api/v1/spaces/${SPACE}/information-digests/personal/backfill`,
        headers: { "accept-language": "zh-CN" },
        payload: { date: day },
      });
      expect(backfilled.statusCode).toBe(201);
      expect(backfilled.json()).toMatchObject({ digest: { digest_date: day, timezone: english.json().timezone } });

      // Another member gets their own personal digest, never the first
      // person's, identically in either language.
      __setAuthIdentityForTests({ spaceId: SPACE, userId: READER });
      const otherEnglish = await read("en");
      const otherChinese = await read("zh-CN");
      expect(otherChinese.statusCode).toBe(otherEnglish.statusCode);
      expect(otherChinese.json()).toEqual(otherEnglish.json());
      expect(otherEnglish.json()).toMatchObject({ status: "missing", digest_date: day });
    } finally {
      await app.close();
    }
  });
});
