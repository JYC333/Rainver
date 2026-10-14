import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { InformationDigestService } from "../src/modules/informationDigest/service.js";
import { digestPeriod } from "../src/modules/informationDigest/digestPeriod.js";
import { PgAutomationRepository } from "../src/modules/automations/repository.js";
import { automationTargetHandlerRegistry } from "../src/modules/automations/targetRegistry.js";
import { registerInformationDigestAutomationTarget } from "../src/modules/informationDigest/automationTarget.js";
import { PgInformationDigestRepository } from "../src/modules/informationDigest/repository.js";
import { reconcileInformationDigestAutomations } from "../src/modules/informationDigest/automationProvisioning.js";
import { PgSerendipityRepository } from "../src/modules/informationDigest/serendipityRepository.js";
import { SerendipityProbeService, type SerendipityProbeProvider } from "../src/modules/informationDigest/serendipityProbe.js";
import { SourceChannelService } from "../src/modules/sources/channels/sourceChannelService.js";
import { INTERESTING_COOLDOWN_DAYS, NEUTRAL_COOLDOWN_DAYS, SerendipityFeedbackService } from "../src/modules/informationDigest/feedbackService.js";
import { InterestProfileService } from "../src/modules/interestProfile/service.js";
import { InterestStarterPackService } from "../src/modules/informationDigest/starterPacks.js";
import { PgSourceAnnotationRepository } from "../src/modules/sourceAnnotation/repository.js";
import { materializeExternalDiscovery } from "../src/modules/sources/externalDiscoveryMaterializer.js";
import { useTestDatabase } from "./support/testDatabase.js";
import { resetTables } from "./support/resetTables.js";
import { seedMainlineRoomsForAllProjects } from "./support/domainSeeds.js";
import { waitForLockWaiter } from "./support/lockWait.js";
import { buildModuleServer } from "./support/moduleServer.js";
import { loadConfig } from "../src/config.js";
import { informationDigestModule } from "../src/modules/informationDigest/index.js";
import { __setAuthIdentityForTests } from "../src/modules/auth/identity.js";

const SPACE = "11111111-1111-4111-8111-111111111111";
const OWNER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OTHER = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const THIRD = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const CONNECTOR = "33333333-3333-4333-8333-333333333333";
const CONNECTION = "44444444-4444-4444-8444-444444444444";
const CHANNEL = "55555555-5555-4555-8555-555555555555";
const PROJECT = "66666666-6666-4666-8666-666666666666";
const AGENT = "77777777-7777-4777-8777-777777777777";
const AGENT_VERSION = "88888888-8888-4888-8888-888888888888";
const MANAGED_ASSISTANT = "99999999-9999-4999-8999-999999999999";
const MANAGED_ASSISTANT_VERSION = "99999999-9999-4999-8999-999999999998";
const DATE = new Date().toISOString().slice(0, 10);
/** The test day as the UTC period the scheduled pass reports on. */
const PERIOD = digestPeriod(DATE, "UTC");


const db = useTestDatabase(import.meta.filename);

// The route test below sets the auth identity seam; files share a worker.
afterEach(() => {
  __setAuthIdentityForTests(null);
});

beforeEach(async () => {
  if (!db.available) return;
  await resetTables(
    db.pool,
    ["information_digest_items", "information_digests", "interest_topics", "interest_profiles", "project_corpus_items", "project_members", "projects", "source_item_annotations", "source_item_user_states", "source_channel_user_subscriptions", "source_channel_item_links", "source_channels", "source_items", "source_connections", "source_provider_connectors", "source_providers", "source_connectors", "space_memberships", "users", "spaces"],
    { cascade: true },
  );
  const now = `${DATE}T08:00:00.000Z`;
  await db.pool.query(`INSERT INTO spaces (id,name,type,created_at,updated_at) VALUES ($1,'Team','team',$2,$2)`, [SPACE, now]);
  for (const user of [OWNER, OTHER, THIRD]) {
    await db.pool.query(`INSERT INTO users (id,display_name,status,created_at,updated_at, email, registration_source) VALUES ($1,$1,'active',$2,$2, lower(gen_random_uuid()::text || '@test.invalid'), 'system')`, [user, now]);
    await db.pool.query(
      `INSERT INTO space_memberships (id,space_id,user_id,role,status,created_at,updated_at)
       VALUES ($1,$2,$3,'member','active',$4,$4)`,
      [randomUUID(), SPACE, user, now],
    );
  }
  await db.pool.query(
    `INSERT INTO source_connectors (id,connector_key,display_name,connector_type,ingestion_mode,status,capabilities_json,created_at,updated_at)
     VALUES ($1,'rss','RSS','external_feed','pull','active','{}'::jsonb,$2,$2)`,
    [CONNECTOR, now],
  );
  await db.pool.query(
    `INSERT INTO source_providers (id,provider_key,display_name,provider_kind,category,status,capabilities_json,created_at,updated_at)
     VALUES ($1,'rss','RSS','named','general','active','{}'::jsonb,$2,$2)`,
    [CONNECTOR, now],
  );
  const mapping = randomUUID();
  await db.pool.query(
    `INSERT INTO source_provider_connectors (id,provider_id,connector_id,status,priority,capabilities_json,created_at,updated_at)
     VALUES ($1,$2,$2,'active',0,'{}'::jsonb,$3,$3)`,
    [mapping, CONNECTOR, now],
  );
  await db.pool.query(
    `INSERT INTO source_connections
       (id,space_id,provider_connector_id,owner_user_id,name,status,capture_policy,trust_level,consent_json,policy_json,config_json,created_at,updated_at)
     VALUES ($1,$2,$3,$4,'Feed','active','reference_only','normal','{}','{}','{}',$5,$5)`,
    [CONNECTION, SPACE, mapping, OWNER, now],
  );
  await db.pool.query(
    `INSERT INTO source_channels
       (id,space_id,source_connection_id,created_by_user_id,name,channel_type,status,fetch_frequency,created_at,updated_at)
     VALUES ($1,$2,$3,$4,'Daily feed','feed','active','daily',$5,$5)`,
    [CHANNEL, SPACE, CONNECTION, OWNER, now],
  );
  await db.pool.query(
    `INSERT INTO source_channel_user_subscriptions
       (id,space_id,source_channel_id,user_id,status,library_enabled,digest_enabled,created_at,updated_at)
     VALUES ($1,$2,$3,$4,'subscribed',true,true,$5,$5)`,
    [randomUUID(), SPACE, CHANNEL, OWNER, now],
  );
  await db.pool.query(
    `INSERT INTO projects (id,space_id,owner_user_id,name,status,settings_json,created_at,updated_at)
     VALUES ($1,$2,$3,'Digest Project','active','{}',$4,$4)`,
    [PROJECT, SPACE, OWNER, now],
  );
  await seedMainlineRoomsForAllProjects(db.pool);
  await db.pool.query(
    `INSERT INTO project_members (id,space_id,project_id,user_id,role,status,created_at,updated_at)
     VALUES ($1,$2,$3,$4,'viewer','active',$5,$5)`,
    [randomUUID(), SPACE, PROJECT, OTHER, now],
  );
  for (const user of [OWNER, THIRD]) {
    await db.pool.query(
      `INSERT INTO project_members (id,space_id,project_id,user_id,role,status,created_at,updated_at)
       VALUES ($1,$2,$3,$4,'viewer','active',$5,$5)`,
      [randomUUID(), SPACE, PROJECT, user, now],
    );
  }
  await db.pool.query(
    `INSERT INTO agents (id,space_id,owner_user_id,name,status,current_version_id,visibility,created_at,updated_at)
     VALUES ($1,$2,$3,'Digest attribution','active',NULL,'space_shared',$4,$4)`,
    [AGENT, SPACE, OWNER, now],
  );
  await db.pool.query(
    `INSERT INTO agent_versions
       (
       id,
       agent_id,
       space_id,
       version_label,
       system_prompt,
       context_policy_json,
       memory_policy_json,
       capabilities_json,
       tool_permissions_json,
       created_at
     )
     VALUES ($1, $2, $3, 'v1', 'test', '{}', '{}', '[]', '{"allowed_tools":[]}', $4)`,
    [AGENT_VERSION, AGENT, SPACE, now],
  );
  await db.pool.query(`UPDATE agents SET current_version_id=$2 WHERE id=$1`, [AGENT, AGENT_VERSION]);
});

/** An annotated, subscribed item at an exact instant. */
async function seedItemAt(title: string, at: string, options: { linked?: boolean } = {}): Promise<string> {
  const id = await seedItem({ title, hour: 0, linked: options.linked });
  await db.pool.query(
    `UPDATE source_items SET occurred_at=$3, first_seen_at=$3, last_seen_at=$3 WHERE space_id=$1 AND id=$2`,
    [SPACE, id, at],
  );
  return id;
}

async function seedItem(input: {
  title: string;
  hour: number;
  topics?: string[];
  project?: boolean;
  linked?: boolean;
  domain?: string;
  stance?: { target: string; key: string; polarity: "supports" | "opposes" };
}): Promise<string> {
  const id = randomUUID();
  const at = `${DATE}T${String(input.hour).padStart(2, "0")}:00:00.000Z`;
  await db.pool.query(
    `INSERT INTO source_items
       (id,space_id,owner_user_id,visibility,connection_id,item_type,title,source_uri,occurred_at,
        first_seen_at,last_seen_at,content_state,retention_policy,created_at,updated_at)
     VALUES ($1,$2,$3,'space_shared',$4,'feed_entry',$5,$6,$7,$7,$7,'excerpt_saved','summary_only',$7,$7)`,
    [id, SPACE, OWNER, CONNECTION, input.title, `https://example.test/${id}`, at],
  );
  await db.pool.query(
    `INSERT INTO source_item_annotations
       (id,space_id,source_item_id,source_channel_id,status,domain_key,depth,genre,summary,topic_candidates_json,
        stance_target,stance_target_key,stance_polarity,stance_confidence,attempt_count,annotated_at,created_at,updated_at)
     VALUES ($1,$2,$3,$4,'succeeded',$5,'analysis','explainer',$6,$7::jsonb,$8,$9,$10,$11,1,$12,$12,$12)`,
    [randomUUID(), SPACE, id, CHANNEL, input.domain ?? "artificial_intelligence", `${input.title} summary`,
      JSON.stringify(input.topics ?? []), input.stance?.target ?? null, input.stance?.key ?? null,
      input.stance?.polarity ?? "neutral", input.stance ? 90 : 0, at],
  );
  if (input.linked !== false) {
    await db.pool.query(
      `INSERT INTO source_channel_item_links (id,space_id,source_channel_id,source_item_id,status,matched_at,created_at,updated_at)
       VALUES ($1,$2,$3,$4,'active',$5,$5,$5)`,
      [randomUUID(), SPACE, CHANNEL, id, at],
    );
  }
  if (input.project) {
    for (const user of [OTHER, THIRD]) {
      await db.pool.query(
        `INSERT INTO source_channel_user_subscriptions
           (id,space_id,source_channel_id,user_id,status,library_enabled,digest_enabled,created_at,updated_at)
         VALUES ($1,$2,$3,$4,'subscribed',false,false,$5,$5)
         ON CONFLICT (space_id,source_channel_id,user_id) DO NOTHING`,
        [randomUUID(), SPACE, CHANNEL, user, at],
      );
    }
    await db.pool.query(
      `INSERT INTO project_corpus_items
         (id,space_id,project_id,source_item_id,source_connection_id,role,status,triage_status,
          triage_confirmed_by_user,read_status,relevance,confidence,metadata_json,created_at,updated_at)
       VALUES ($1,$2,$3,$4,$5,'candidate','active','relevant',false,'unread','relevant',0.9,'{}',$6,$6)`,
      [randomUUID(), SPACE, PROJECT, id, CONNECTION, at],
    );
  }
  return id;
}

describe("external discovery materialization", () => {
  it("reuses an item whose source_uri the sample names, instead of colliding with it", async () => {
    if (!db.available) return;
    // A Custom Source item whose URL drifted: `source_uri` moved on, its
    // `canonical_uri` did not. The active-row unique index is on `source_uri`.
    const id = randomUUID();
    await db.pool.query(
      `INSERT INTO source_items
         (id,space_id,owner_user_id,visibility,connection_id,item_type,title,source_uri,canonical_uri,occurred_at,
          first_seen_at,last_seen_at,content_state,retention_policy,created_at,updated_at)
       VALUES ($1,$2,$3,'space_shared',$4,'feed_entry','Moved','https://example.test/new-path','https://example.test/old-path',now(),now(),now(),'excerpt_saved','summary_only',now(),now())`,
      [id, SPACE, OWNER, CONNECTION],
    );
    const ids = await materializeExternalDiscovery(db.pool, {
      spaceId: SPACE,
      projectId: null,
      userId: OWNER,
      discoveryKey: "probe:1",
      samples: [
        { source_uri: "https://example.test/new-path", title: "Moved", excerpt: null, author: null, occurred_at: null },
        { source_uri: "https://example.test/brand-new", title: "New", excerpt: null, author: null, occurred_at: null },
      ],
    });
    expect(ids).toHaveLength(2);
    expect(ids[0]).toBe(id);
    const rows = await db.pool.query<{ n: string }>(`SELECT count(*)::text AS n FROM source_items WHERE space_id = $1`, [SPACE]);
    expect(rows.rows[0]!.n).toBe("2");
  });
});

describe("information digest persistence", () => {
  it("uses the deterministic cold branch and persists complete slot attribution", async () => {
    if (!db.available) return;
    await seedItem({ title: "Older", hour: 7 });
    await seedItem({ title: "Newer", hour: 20 });

    const first = (await new InformationDigestService(db.pool).scheduledPersonal(SPACE, OWNER, PERIOD, null)).digest;
    const second = (await new InformationDigestService(db.pool).scheduledPersonal(SPACE, OWNER, PERIOD, null)).digest;

    expect(second.id).toBe(first.id);
    expect(first.profile_maturity).toBe("cold");
    expect(first.items.map((item) => item.title)).toEqual(["Newer", "Older"]);
    expect(first.items.every((item) => item.quota_slot.startsWith("interest:") && item.component_scores.recency !== undefined)).toBe(true);
    expect(first.items.every((item) => item.matched_topic_id === null)).toBe(true);
    const profiles = await db.pool.query(`SELECT settings_json FROM interest_profiles WHERE space_id=$1 AND user_id=$2`, [SPACE, OWNER]);
    expect(profiles.rows).toEqual([{ settings_json: {} }]);
  });

  it("updates the fact layer before scheduled selection and excludes explicitly ignored items", async () => {
    if (!db.available) return;
    const kept = await seedItem({ title: "Kept signal", hour: 12, topics: ["model evaluation"] });
    const ignored = await seedItem({ title: "Ignored signal", hour: 13, topics: ["celebrity gossip"] });
    const now = `${DATE}T15:00:00.000Z`;
    for (const [itemId, libraryStatus, readStatus] of [[kept, "selected", "read"], [ignored, "ignored", "unread"]] as const) {
      await db.pool.query(
        `INSERT INTO source_item_user_states
           (id,space_id,source_item_id,user_id,library_status,read_status,last_opened_at,progress_json,created_at,updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'{}',$7,$7)`,
        [randomUUID(), SPACE, itemId, OWNER, libraryStatus, readStatus, now],
      );
    }
    await new InterestProfileService(db.pool).updateSettings(SPACE, OWNER, {
      new_topic_occurrence_threshold: 1,
      new_topic_read_threshold: 1,
      warming_min_read_items: 1,
      interest_slots: 1,
    });

    const digest = (await new InformationDigestService(db.pool).scheduledPersonal(SPACE, OWNER, PERIOD, null)).digest;
    const snapshot = await new InterestProfileService(db.pool).snapshot(SPACE, OWNER);

    expect(digest.items.map((item) => item.source_item_id)).toEqual([kept]);
    expect(snapshot.ready_candidates.map((candidate) => candidate.phrase_key)).toEqual(["model-evaluation"]);
    expect(snapshot.ready_candidates.map((candidate) => candidate.phrase_key)).not.toContain("celebrity-gossip");
    expect(digest.settings.interest_slots).toBe(1);
  });

  it("applies optional starter packs idempotently without rewriting an existing topic", async () => {
    if (!db.available) return;
    const profiles = new InterestProfileService(db.pool);
    await profiles.createTopic(SPACE, OWNER, { label: "Artificial intelligence", domainKey: "artificial_intelligence", weight: 4 });
    const service = new InterestStarterPackService(db.pool);
    const first = await service.apply(SPACE, OWNER, "technology");
    const second = await service.apply(SPACE, OWNER, "technology");
    const snapshot = await profiles.snapshot(SPACE, OWNER);

    expect(first.topics).toBe(2);
    expect(second.topics).toBe(0);
    expect(snapshot.topics).toHaveLength(3);
    expect(snapshot.topics.find((topic) => topic.topic_key === "artificial-intelligence")?.weight).toBe(4);
  });

  it("queues subscribed historical items only through the explicit bounded backfill", async () => {
    if (!db.available) return;
    const id = randomUUID();
    const at = `${DATE}T04:00:00.000Z`;
    await db.pool.query(
      `INSERT INTO source_items
         (id,space_id,owner_user_id,visibility,connection_id,item_type,title,source_uri,occurred_at,
          first_seen_at,last_seen_at,content_state,retention_policy,created_at,updated_at)
       VALUES ($1,$2,$3,'space_shared',$4,'feed_entry','Historical','https://example.test/history',$5,$5,$5,'excerpt_saved','summary_only',$5,$5)`,
      [id, SPACE, OWNER, CONNECTION, at],
    );
    await db.pool.query(
      `INSERT INTO source_channel_item_links (id,space_id,source_channel_id,source_item_id,status,matched_at,created_at,updated_at)
       VALUES ($1,$2,$3,$4,'active',$5,$5,$5)`,
      [randomUUID(), SPACE, CHANNEL, id, at],
    );

    const repo = new PgSourceAnnotationRepository(db.pool);
    expect(await repo.enqueueSubscriptionHistory(SPACE, OWNER, 1)).toBe(1);
    expect(await repo.enqueueSubscriptionHistory(SPACE, OWNER, 1)).toBe(0);
    expect((await db.pool.query(`SELECT status FROM source_item_annotations WHERE source_item_id=$1`, [id])).rows).toEqual([{ status: "pending" }]);
  });

  it("backfills the most recent subscribed history first, whatever the item ids sort like", async () => {
    if (!db.available) return;
    // Ids sort the other way round from recency, so a LIMIT applied in id
    // order would pick the older item.
    const older = { id: "00000000-0000-4000-8000-00000000aaaa", at: `${DATE}T01:00:00.000Z` };
    const newer = { id: "ffffffff-ffff-4fff-8fff-ffffffffffff", at: `${DATE}T05:00:00.000Z` };
    for (const item of [older, newer]) {
      await db.pool.query(
        `INSERT INTO source_items
           (id,space_id,owner_user_id,visibility,connection_id,item_type,title,source_uri,occurred_at,
            first_seen_at,last_seen_at,content_state,retention_policy,created_at,updated_at)
         VALUES ($1,$2,$3,'space_shared',$4,'feed_entry','Historical',$5,$6,$6,$6,'excerpt_saved','summary_only',$6,$6)`,
        [item.id, SPACE, OWNER, CONNECTION, `https://example.test/history/${item.id}`, item.at],
      );
      await db.pool.query(
        `INSERT INTO source_channel_item_links (id,space_id,source_channel_id,source_item_id,status,matched_at,created_at,updated_at)
         VALUES ($1,$2,$3,$4,'active',$5,$5,$5)`,
        [randomUUID(), SPACE, CHANNEL, item.id, item.at],
      );
    }

    const repo = new PgSourceAnnotationRepository(db.pool);
    expect(await repo.enqueueSubscriptionHistory(SPACE, OWNER, 1)).toBe(1);
    expect((await db.pool.query(`SELECT source_item_id FROM source_item_annotations WHERE space_id=$1`, [SPACE])).rows)
      .toEqual([{ source_item_id: newer.id }]);
    expect(await repo.enqueueSubscriptionHistory(SPACE, OWNER, 1)).toBe(1);
    expect(await repo.enqueueSubscriptionHistory(SPACE, OWNER, 1)).toBe(0);
  });

  it("selects personal and Project candidates by UTC day regardless of the database session timezone", async () => {
    if (!db.available) return;
    const personalItem = await seedItem({ title: "UTC personal", hour: 1 });
    const projectItem = await seedItem({ title: "UTC Project", hour: 2, project: true });
    const client = await db.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL TIME ZONE 'America/Los_Angeles'");
      const repo = new PgInformationDigestRepository(client);
      expect((await repo.personalCandidates(SPACE, OWNER, PERIOD)).map((item) => item.source_item_id)).toContain(personalItem);
      expect((await repo.projectCandidates(SPACE, PROJECT, PERIOD)).map((item) => item.source_item_id)).toContain(projectItem);
      await client.query("ROLLBACK");
    } finally {
      client.release();
    }
  });

  it("applies canonical Source access and redacts full fields for a summary-only personal reader", async () => {
    if (!db.available) return;
    const itemId = await seedItem({ title: "Shared summary", hour: 10 });
    const now = `${DATE}T11:00:00.000Z`;
    await db.pool.query(
      `INSERT INTO source_channel_user_subscriptions
         (id,space_id,source_channel_id,user_id,status,library_enabled,digest_enabled,created_at,updated_at)
       VALUES ($1,$2,$3,$4,'subscribed',false,true,$5,$5)`,
      [randomUUID(), SPACE, CHANNEL, OTHER, now],
    );
    await db.pool.query(
      `UPDATE source_items
          SET visibility='selected_users', access_level='full', excerpt='full source body'
        WHERE space_id=$1 AND id=$2`,
      [SPACE, itemId],
    );
    await db.pool.query(
      `INSERT INTO content_access_grants
         (id,space_id,resource_type,resource_id,grantee_user_id,granted_by_user_id,
          access_level,created_at,updated_at)
       VALUES ($1,$2,'source_item',$3,$4,$5,'summary',$6,$6)`,
      [randomUUID(), SPACE, itemId, OTHER, OWNER, now],
    );

    const candidates = await new PgInformationDigestRepository(db.pool).personalCandidates(SPACE, OTHER, PERIOD);

    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({
      source_item_id: itemId,
      title: "Shared summary",
      summary: "Shared summary summary",
      source_uri: null,
      excerpt: null,
    });
  });

  it("excludes a Project Source unless every current Project reader has full access", async () => {
    if (!db.available) return;
    const itemId = await seedItem({ title: "Owner-only Project source", hour: 12, project: true });
    await db.pool.query(
      `UPDATE source_items SET visibility='private' WHERE space_id=$1 AND id=$2`,
      [SPACE, itemId],
    );

    expect(await new PgInformationDigestRepository(db.pool).projectCandidates(SPACE, PROJECT, PERIOD)).toEqual([]);
  });

  it("makes one snapshot when two passes for the same day race, and never rewrites it", async () => {
    if (!db.available) return;
    await seedItem({ title: "Concurrent snapshot", hour: 12 });
    const [first, second] = await Promise.all([
      new InformationDigestService(db.pool).scheduledPersonal(SPACE, OWNER, PERIOD, null),
      new InformationDigestService(db.pool).scheduledPersonal(SPACE, OWNER, PERIOD, null),
    ]);
    expect(second.digest.id).toBe(first.digest.id);
    expect([first.created, second.created].sort()).toEqual([false, true]);
    expect(second.digest.items.map((item) => item.id)).toEqual(first.digest.items.map((item) => item.id));

    // A restart that replays the same slot later finds the snapshot and changes nothing.
    await seedItem({ title: "Arrived after the snapshot", hour: 13 });
    const replay = await new InformationDigestService(db.pool).scheduledPersonal(SPACE, OWNER, PERIOD, null);
    expect(replay.created).toBe(false);
    expect(replay.digest.items.map((item) => item.id)).toEqual(first.digest.items.map((item) => item.id));
    expect(replay.digest.generated_at).toBe(first.digest.generated_at);
  });

  it("records the day, its timezone and its half-open interval, and attributes each item to exactly one day", async () => {
    if (!db.available) return;
    const day = "2026-03-08";
    const next = "2026-03-09";
    const timezone = "America/New_York";
    // 2026-03-08 is the US spring-forward day: 23 hours long.
    const before = await seedItemAt("End of the 7th", "2026-03-08T04:59:59.000Z");
    const early = await seedItemAt("Start of the 8th", "2026-03-08T05:00:00.000Z");
    const lastSecond = await seedItemAt("Last second of the 8th", "2026-03-09T03:59:59.000Z");
    const boundary = await seedItemAt("Midnight of the 9th", "2026-03-09T04:00:00.000Z");
    const dayPeriod = digestPeriod(day, timezone);
    const nextPeriod = digestPeriod(next, timezone);
    expect(dayPeriod).toEqual({ date: day, timezone, startUtc: "2026-03-08T05:00:00.000Z", endUtc: "2026-03-09T04:00:00.000Z" });
    expect(nextPeriod.startUtc).toBe(dayPeriod.endUtc);

    const repo = new PgInformationDigestRepository(db.pool);
    const onDay = (await repo.personalCandidates(SPACE, OWNER, dayPeriod)).map((item) => item.source_item_id);
    const onNext = (await repo.personalCandidates(SPACE, OWNER, nextPeriod)).map((item) => item.source_item_id);
    expect(onDay.sort()).toEqual([early, lastSecond].sort());
    expect(onNext).toEqual([boundary]);
    expect([...onDay, ...onNext]).not.toContain(before);

    const generated = await new InformationDigestService(db.pool).scheduledPersonal(SPACE, OWNER, dayPeriod, null);
    expect(generated.digest).toMatchObject({
      digest_date: day,
      timezone,
      period_start_utc: dayPeriod.startUtc,
      period_end_utc: dayPeriod.endUtc,
      generation_kind: "scheduled",
    });
  });

  it("stores one shared Project digest while hydrating each reader's private read state", async () => {
    if (!db.available) return;
    const itemId = await seedItem({ title: "Project item", hour: 12, project: true });
    const now = `${DATE}T14:00:00.000Z`;
    await db.pool.query(
      `INSERT INTO source_item_user_states
         (id,space_id,source_item_id,user_id,library_status,read_status,last_opened_at,progress_json,created_at,updated_at)
       VALUES ($1,$2,$3,$4,'selected','read',$5,'{}',$5,$5)`,
      [randomUUID(), SPACE, itemId, OTHER, now],
    );

    const ownerView = (await new InformationDigestService(db.pool).scheduledProject(SPACE, PROJECT, OWNER, PERIOD, null)).digest;
    const memberView = (await new InformationDigestService(db.pool).scheduledProject(SPACE, PROJECT, OTHER, PERIOD, null)).digest;

    expect(memberView.id).toBe(ownerView.id);
    expect(ownerView.items[0].read_status).toBe("unread");
    expect(memberView.items[0].read_status).toBe("read");
    expect(memberView.settings.serendipity).toBe(false);
  });

  it("rechecks Source access when a reader hydrates an existing Project digest", async () => {
    if (!db.available) return;
    await seedItem({ title: "Revoked Project source", hour: 12, project: true });
    const ownerView = (await new InformationDigestService(db.pool).scheduledProject(SPACE, PROJECT, OWNER, PERIOD, null)).digest;
    expect(ownerView.items).toHaveLength(1);

    await db.pool.query(
      `UPDATE source_channel_user_subscriptions SET status='muted'
        WHERE space_id=$1 AND source_channel_id=$2 AND user_id=$3`,
      [SPACE, CHANNEL, OTHER],
    );

    const memberView = (await new InformationDigestService(db.pool).scheduledProject(SPACE, PROJECT, OTHER, PERIOD, null)).digest;
    expect(memberView.id).toBe(ownerView.id);
    expect(memberView.items).toEqual([]);
  });

  it("shows only thresholded Project read aggregates and zero-reader domain blind spots", async () => {
    if (!db.available) return;
    const broadlyRead = await seedItem({ title: "Broadly read", hour: 12, project: true, domain: "history" });
    await seedItem({ title: "Unread domain", hour: 13, project: true, domain: "biology" });
    const now = `${DATE}T15:00:00.000Z`;
    for (const user of [OWNER, OTHER, THIRD]) {
      await db.pool.query(
        `INSERT INTO source_item_user_states
           (id,space_id,source_item_id,user_id,library_status,read_status,last_opened_at,progress_json,created_at,updated_at)
         VALUES ($1,$2,$3,$4,'selected','read',$5,'{}',$5,$5)`,
        [randomUUID(), SPACE, broadlyRead, user, now],
      );
    }

    const digest = (await new InformationDigestService(db.pool).scheduledProject(SPACE, PROJECT, OWNER, PERIOD, null)).digest;
    expect(digest.team_aggregates_available).toBe(true);
    expect(digest.team_blind_spot_domains).toEqual(["biology"]);
    expect(digest.items.find((item) => item.source_item_id === broadlyRead)?.anonymous_read_count).toBe(3);
    expect(digest.items.find((item) => item.title === "Unread domain")?.anonymous_read_count).toBeNull();

    await db.pool.query(`DELETE FROM project_members WHERE project_id=$1 AND user_id=$2`, [PROJECT, THIRD]);
    const suppressed = (await new InformationDigestService(db.pool).scheduledProject(SPACE, PROJECT, OWNER, PERIOD, null)).digest;
    expect(suppressed.team_aggregates_available).toBe(false);
    expect(suppressed.team_blind_spot_domains).toEqual([]);
    expect(suppressed.items.every((item) => item.anonymous_read_count === null)).toBe(true);
  });

  it("derives stance matching from only the current reader's high-confidence reading", async () => {
    if (!db.available) return;
    const supporting = await seedItem({
      title: "Supporting conclusion", hour: 12,
      stance: { target: "Open source models improve safety", key: "open source models improve safety", polarity: "supports" },
    });
    const now = `${DATE}T15:00:00.000Z`;
    await db.pool.query(
      `INSERT INTO source_item_user_states
         (id,space_id,source_item_id,user_id,library_status,read_status,last_opened_at,progress_json,created_at,updated_at)
       VALUES ($1,$2,$3,$4,'selected','read',$5,'{}',$5,$5)`,
      [randomUUID(), SPACE, supporting, OWNER, now],
    );

    expect((await new PgSerendipityRepository(db.pool).readingShape(SPACE, OWNER)).stanceByTarget)
      .toEqual({ "open source models improve safety": "supports" });
    expect((await new PgSerendipityRepository(db.pool).readingShape(SPACE, OTHER)).stanceByTarget).toEqual({});
  });

  it("allocates outside-subscription candidates to a separate distant slot and consumes them once", async () => {
    if (!db.available) return;
    await seedItem({ title: "Familiar", hour: 10 });
    const outside = await seedItem({ title: "Outside", hour: 11, linked: false });
    await new PgSerendipityRepository(db.pool).addPoolItem({
      spaceId: SPACE,
      userId: OWNER,
      sourceItemId: outside,
      targetDomainKey: "artificial_intelligence",
      origin: "weekly_probe",
      probePeriod: DATE,
    });

    const digest = (await new InformationDigestService(db.pool).scheduledPersonal(SPACE, OWNER, PERIOD, null)).digest;
    expect(digest.items.map((item) => item.section)).toEqual(["interest", "serendipity"]);
    expect(digest.items[1]).toMatchObject({
      title: "Outside",
      quota_slot: "serendipity:distant:1",
      target_domain_key: "artificial_intelligence",
      discovery_origin: "weekly_probe",
      serendipity_feedback: null,
    });
    expect(digest.items[1].rationale).toContain("Why you are seeing this");
    const poolState = await db.pool.query(`SELECT status FROM information_digest_serendipity_pool WHERE source_item_id=$1`, [outside]);
    expect(poolState.rows).toEqual([{ status: "consumed" }]);
  });

  it("never spends the standby pool on a backfilled day", async () => {
    if (!db.available) return;
    const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
    const outside = await seedItemAt("Outside, yesterday", `${yesterday}T11:00:00.000Z`, { linked: false });
    await seedItemAt("Familiar, yesterday", `${yesterday}T10:00:00.000Z`);
    await new PgSerendipityRepository(db.pool).addPoolItem({
      spaceId: SPACE, userId: OWNER, sourceItemId: outside,
      targetDomainKey: "artificial_intelligence", origin: "weekly_probe", probePeriod: DATE,
    });

    const backfilled = await new InformationDigestService(db.pool).backfillPersonal(SPACE, OWNER, yesterday);

    expect(backfilled.created).toBe(true);
    expect(backfilled.digest).toMatchObject({ digest_date: yesterday, generation_kind: "backfill", timezone: "UTC" });
    expect(backfilled.digest.items.length).toBeGreaterThan(0);
    expect(backfilled.digest.items.every((item) => item.section === "interest")).toBe(true);
    expect(backfilled.digest.settings).toMatchObject({ serendipity_slots: 0, history_note: expect.stringContaining("retained now") });
    const pool = await db.pool.query<{ status: string }>(
      `SELECT status FROM information_digest_serendipity_pool WHERE user_id=$1`, [OWNER],
    );
    expect(pool.rows).toEqual([{ status: "standby" }]);
  });

  it("records explicit feedback in independent cooldown state without touching the interest profile", async () => {
    if (!db.available) return;
    const outside = await seedItem({ title: "Outside feedback", hour: 11, linked: false });
    await new PgSerendipityRepository(db.pool).addPoolItem({
      spaceId: SPACE, userId: OWNER, sourceItemId: outside,
      targetDomainKey: "artificial_intelligence", origin: "weekly_probe", probePeriod: DATE,
    });
    const digest = (await new InformationDigestService(db.pool).scheduledPersonal(SPACE, OWNER, PERIOD, null)).digest;
    const item = digest.items.find((row) => row.section === "serendipity")!;
    const at = new Date(`${DATE}T21:00:00Z`);

    const first = await new SerendipityFeedbackService(db.pool).record(SPACE, OWNER, item.id, "interesting", at);
    const repeated = await new SerendipityFeedbackService(db.pool).record(SPACE, OWNER, item.id, "never", at);

    expect(first.feedback).toBe("interesting");
    expect(first.cooldown_until).toBe(new Date(at.getTime() + INTERESTING_COOLDOWN_DAYS * 86_400_000).toISOString());
    expect(repeated).toEqual(first);
    const waiting = await seedItem({ title: "Wait through cooldown", hour: 22, linked: false });
    await new PgSerendipityRepository(db.pool).addPoolItem({
      spaceId: SPACE, userId: OWNER, sourceItemId: waiting,
      targetDomainKey: "artificial_intelligence", origin: "weekly_probe", probePeriod: DATE,
    });
    expect(await new PgSerendipityRepository(db.pool).listStandby(SPACE, OWNER, `${DATE}T23:00:00Z`)).toEqual([]);

    const otherOutside = await seedItem({ title: "Neutral direction", hour: 12, linked: false });
    await db.pool.query(
      `INSERT INTO source_channel_user_subscriptions
         (id,space_id,source_channel_id,user_id,status,library_enabled,digest_enabled,created_at,updated_at)
       VALUES ($1,$2,$3,$4,'subscribed',false,false,$5,$5)`,
      [randomUUID(), SPACE, CHANNEL, OTHER, `${DATE}T12:00:00.000Z`],
    );
    await new PgSerendipityRepository(db.pool).addPoolItem({
      spaceId: SPACE, userId: OTHER, sourceItemId: otherOutside,
      targetDomainKey: "artificial_intelligence", origin: "weekly_probe", probePeriod: DATE,
    });
    const otherDigest = (await new InformationDigestService(db.pool).scheduledPersonal(SPACE, OTHER, PERIOD, null)).digest;
    const otherItem = otherDigest.items.find((row) => row.section === "serendipity")!;
    const neutral = await new SerendipityFeedbackService(db.pool).record(SPACE, OTHER, otherItem.id, "neutral", at);
    expect(neutral.cooldown_until).toBe(new Date(at.getTime() + NEUTRAL_COOLDOWN_DAYS * 86_400_000).toISOString());
    expect((await db.pool.query(`SELECT id FROM interest_topics WHERE space_id=$1 AND user_id=$2`, [SPACE, OWNER])).rows).toEqual([]);
    await expect(new SerendipityFeedbackService(db.pool).record(SPACE, OTHER, item.id, "neutral", at)).rejects.toMatchObject({ statusCode: 404 });
  });

  it("keeps a permanent block when another item of the same domain gets interesting feedback at the same time", async () => {
    if (!db.available) return;
    const first = await seedItem({ title: "Sports one", hour: 11, linked: false, domain: "sports" });
    const second = await seedItem({ title: "Sports two", hour: 12, linked: false, domain: "sports" });
    const pool = new PgSerendipityRepository(db.pool);
    for (const sourceItemId of [first, second]) {
      await pool.addPoolItem({ spaceId: SPACE, userId: OWNER, sourceItemId, targetDomainKey: "sports", origin: "weekly_probe", probePeriod: DATE });
    }
    const digest = (await new InformationDigestService(db.pool).scheduledPersonal(SPACE, OWNER, PERIOD, null)).digest;
    const shown = digest.items.filter((row) => row.section === "serendipity");
    const x = shown[0]!;
    let y = shown[1];
    if (!y) {
      // Selection filled one slot; the second item of the domain is placed
      // beside it the way a wider quota would have placed it.
      const standby = await db.pool.query<{ id: string; source_item_id: string }>(
        `SELECT id, source_item_id FROM information_digest_serendipity_pool WHERE space_id=$1 AND user_id=$2 AND status='standby'`,
        [SPACE, OWNER],
      );
      const other = standby.rows[0]!;
      const id = randomUUID();
      await db.pool.query(
        `INSERT INTO information_digest_items
           (id, space_id, digest_id, source_item_id, section, position, quota_slot, serendipity_pool_item_id, score, component_scores_json, created_at)
         SELECT $1, space_id, digest_id, $3, section, position + 100, quota_slot, $4, score, component_scores_json, created_at
           FROM information_digest_items WHERE id=$2`,
        [id, x.id, other.source_item_id, other.id],
      );
      y = { id } as typeof x;
    }
    const at = new Date(`${DATE}T21:00:00Z`);
    const blocking = await db.pool.connect();
    try {
      await blocking.query("BEGIN");
      await new SerendipityFeedbackService(blocking).record(SPACE, OWNER, x.id, "never", at);
      let settled = false;
      const liking = new SerendipityFeedbackService(db.pool).record(SPACE, OWNER, y.id, "interesting", at).finally(() => { settled = true; });
      await waitForLockWaiter(db.pool, { settled: () => settled });
      await blocking.query("COMMIT");
      await expect(liking).rejects.toMatchObject({ statusCode: 409 });
    } finally {
      await blocking.query("ROLLBACK").catch(() => undefined);
      blocking.release();
    }
    const state = await db.pool.query<{ blocked_at: string | null; last_feedback: string }>(
      `SELECT blocked_at, last_feedback FROM information_digest_serendipity_domain_states WHERE space_id=$1 AND user_id=$2 AND domain_key='sports'`,
      [SPACE, OWNER],
    );
    expect(state.rows[0]?.blocked_at).not.toBeNull();
    expect(state.rows[0]?.last_feedback).toBe("never");
  });

  it("answers a history read without writing anything, and backfills only on request, once", async () => {
    if (!db.available) return;
    const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
    await seedItemAt("Yesterday's item", `${yesterday}T09:00:00.000Z`);
    __setAuthIdentityForTests({ spaceId: SPACE, userId: OWNER });
    const app = buildModuleServer(loadConfig({ SERVER_DATABASE_URL: db.connectionUri }), [informationDigestModule]);
    try {
      const footprint = async () => (await db.pool.query<{ digests: string; items: string; consumed: string }>(
        `SELECT (SELECT count(*) FROM information_digests)::text AS digests,
                (SELECT count(*) FROM information_digest_items)::text AS items,
                (SELECT count(*) FROM information_digest_serendipity_pool WHERE status <> 'standby')::text AS consumed`,
      )).rows[0];
      const before = await footprint();
      const missing = await app.inject({ method: "GET", url: `/api/v1/spaces/${SPACE}/information-digests/personal` });
      expect(missing.statusCode).toBe(200);
      expect(missing.json()).toMatchObject({ status: "missing", digest_date: yesterday, timezone: "UTC", backfill_available: true });
      const today = await app.inject({ method: "GET", url: `/api/v1/spaces/${SPACE}/information-digests/personal?date=${DATE}` });
      expect(today.json()).toMatchObject({ status: "missing", backfill_available: false });
      expect(await footprint()).toEqual(before);

      // Today has not ended: no backfill for it.
      const early = await app.inject({ method: "POST", url: `/api/v1/spaces/${SPACE}/information-digests/personal/backfill`, payload: { date: DATE } });
      expect(early.statusCode).toBe(422);
      expect(early.json()).toMatchObject({ code: "digest_day_not_complete" });

      const [a, b] = await Promise.all([
        app.inject({ method: "POST", url: `/api/v1/spaces/${SPACE}/information-digests/personal/backfill`, payload: { date: yesterday } }),
        app.inject({ method: "POST", url: `/api/v1/spaces/${SPACE}/information-digests/personal/backfill`, payload: { date: yesterday } }),
      ]);
      expect([a.statusCode, b.statusCode].sort()).toEqual([200, 201]);
      expect(a.json().digest.id).toBe(b.json().digest.id);
      expect((await db.pool.query(`SELECT id FROM information_digests WHERE digest_date=$1`, [yesterday])).rows).toHaveLength(1);

      const read = await app.inject({ method: "GET", url: `/api/v1/spaces/${SPACE}/information-digests/personal?date=${yesterday}` });
      expect(read.json()).toMatchObject({ status: "available", digest: { id: a.json().digest.id, generation_kind: "backfill" } });
    } finally {
      __setAuthIdentityForTests(null);
      await app.close();
    }
  });

  it("refuses a Project backfill to a reader who cannot write the Project", async () => {
    if (!db.available) return;
    const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
    __setAuthIdentityForTests({ spaceId: SPACE, userId: OTHER });
    const app = buildModuleServer(loadConfig({ SERVER_DATABASE_URL: db.connectionUri }), [informationDigestModule]);
    try {
      const response = await app.inject({
        method: "POST", url: `/api/v1/spaces/${SPACE}/projects/${PROJECT}/information-digests/backfill`, payload: { date: yesterday },
      });
      expect(response.statusCode).toBe(403);
      expect((await db.pool.query(`SELECT id FROM information_digests WHERE project_id=$1`, [PROJECT])).rows).toEqual([]);
    } finally {
      __setAuthIdentityForTests(null);
      await app.close();
    }
  });

  it("reports the scheduled slot's previous local day in the scope's configured timezone, even when the fire runs late", async () => {
    if (!db.available) return;
    expect(await reconcileInformationDigestAutomations(db.pool)).toBeGreaterThan(0);
    const updated = await db.pool.query<{ id: string }>(
      `UPDATE automations SET config_json = config_json || '{"timezone":"Asia/Shanghai"}'::jsonb
        WHERE space_id=$1 AND owner_user_id=$2 AND config_json->>'scope'='personal' AND config_json->>'operation'='daily'
        RETURNING id`,
      [SPACE, OWNER],
    );
    const row = await new PgAutomationRepository(db.pool).get(SPACE, updated.rows[0]!.id);
    // The slot 2026-01-01 07:00 in Shanghai is 2025-12-31T23:00Z; the worker
    // gets to it days later. The day reported is still 2025-12-31 there.
    const automation = { ...row!, next_run_at: "2025-12-31T23:00:00.000Z" };
    registerInformationDigestAutomationTarget();
    const handler = automationTargetHandlerRegistry.get("information_digest")!;
    const execute = async () => await handler.execute({
      config: loadConfig({ SERVER_DATABASE_URL: db.connectionUri }),
      repo: new PgAutomationRepository(db.pool),
      host: {} as never,
      automation,
      fireInput: { spaceId: SPACE, automationId: automation.id, actorUserId: OWNER, triggerType: "schedule" },
      triggerType: "schedule",
      responsibility: { triggerOrigin: "automation", instructedByUserId: OWNER },
      preflightSnapshot: {},
      advanceSchedule: false,
    } as never) as Record<string, unknown>;
    const result = await execute();
    expect(result).toMatchObject({ digest_date: "2025-12-31", timezone: "Asia/Shanghai", created: true });
    const stored = await db.pool.query<{ period_start_utc: Date; period_end_utc: Date }>(
      `SELECT period_start_utc, period_end_utc FROM information_digests WHERE id=$1`, [result.digest_id],
    );
    expect(stored.rows[0]!.period_start_utc.toISOString()).toBe("2025-12-30T16:00:00.000Z");
    expect(stored.rows[0]!.period_end_utc.toISOString()).toBe("2025-12-31T16:00:00.000Z");
    // A restart replaying the same slot answers with the same snapshot.
    expect(await execute()).toMatchObject({ digest_id: result.digest_id, created: false });
  });

  it("uses the reader's configured serendipity cooldown", async () => {
    if (!db.available) return;
    await new InterestProfileService(db.pool).updateSettings(SPACE, OWNER, { interesting_cooldown_days: 2 });
    const outside = await seedItem({ title: "Configured cooldown", hour: 11, linked: false });
    await new PgSerendipityRepository(db.pool).addPoolItem({
      spaceId: SPACE, userId: OWNER, sourceItemId: outside,
      targetDomainKey: "artificial_intelligence", origin: "weekly_probe", probePeriod: DATE,
    });
    const digest = (await new InformationDigestService(db.pool).scheduledPersonal(SPACE, OWNER, PERIOD, null)).digest;
    const item = digest.items.find((row) => row.section === "serendipity")!;
    const at = new Date(`${DATE}T21:00:00Z`);

    const result = await new SerendipityFeedbackService(db.pool).record(SPACE, OWNER, item.id, "interesting", at);

    expect(result.cooldown_until).toBe(new Date(at.getTime() + 2 * 86_400_000).toISOString());
  });

  it("turns only explicit never feedback into a permanent domain block", async () => {
    if (!db.available) return;
    const outside = await seedItem({ title: "Block direction", hour: 11, linked: false });
    await new PgSerendipityRepository(db.pool).addPoolItem({
      spaceId: SPACE, userId: OWNER, sourceItemId: outside,
      targetDomainKey: "artificial_intelligence", origin: "weekly_probe", probePeriod: DATE,
    });
    const digest = (await new InformationDigestService(db.pool).scheduledPersonal(SPACE, OWNER, PERIOD, null)).digest;
    const item = digest.items.find((row) => row.section === "serendipity")!;

    const result = await new SerendipityFeedbackService(db.pool).record(
      SPACE, OWNER, item.id, "never", new Date(`${DATE}T21:00:00Z`),
    );

    expect(result).toMatchObject({ feedback: "never", blocked: true, cooldown_until: null });
    expect(await new PgSerendipityRepository(db.pool).blockedDomainKeys(SPACE, OWNER)).toEqual(["artificial_intelligence"]);
    expect((await db.pool.query(`SELECT id FROM interest_topics`)).rows).toEqual([]);
  });
});

describe("information digest Automation provisioning", () => {
  it("creates one hidden daily schedule per eligible scope and is idempotent", async () => {
    if (!db.available) return;
    expect(await reconcileInformationDigestAutomations(db.pool)).toBe(3);
    expect(await reconcileInformationDigestAutomations(db.pool)).toBe(0);
    const automations = await db.pool.query<{ scope: string; operation: string; project_id: string | null; cron: string }>(
      `SELECT config_json->>'scope' AS scope, config_json->>'operation' AS operation,
              project_id, config_json->>'cron' AS cron
         FROM automations WHERE config_json->>'target_type'='information_digest' ORDER BY scope, operation`,
    );
    expect(automations.rows).toEqual([
      { scope: "personal", operation: "daily", project_id: null, cron: "0 7 * * *" },
      { scope: "personal", operation: "probe", project_id: null, cron: "0 6 * * 1" },
      { scope: "project", operation: "daily", project_id: PROJECT, cron: "0 7 * * *" },
    ]);
  });

  it("repairs a native digest that was bound to the Room-only managed Assistant", async () => {
    if (!db.available) return;
    const now = `${DATE}T08:30:00.000Z`;
    await db.pool.query(
      `INSERT INTO agents (id,space_id,owner_user_id,name,status,current_version_id,visibility,agent_kind,created_at,updated_at)
       VALUES ($1,$2,$3,'Personal Assistant','active',NULL,'space_shared','system_assistant',$4,$4)`,
      [MANAGED_ASSISTANT, SPACE, OWNER, now],
    );
    await db.pool.query(
      `INSERT INTO agent_versions
         (
       id,
       agent_id,
       space_id,
       version_label,
       system_prompt,
       context_policy_json,
       memory_policy_json,
       capabilities_json,
       tool_permissions_json,
       created_at
     )
       VALUES ($1, $2, $3, 'v1', 'test', '{}', '{}', '[]', '{"allowed_tools":[]}', $4)`,
      [MANAGED_ASSISTANT_VERSION, MANAGED_ASSISTANT, SPACE, now],
    );
    await db.pool.query(`UPDATE agents SET current_version_id=$2 WHERE id=$1`, [MANAGED_ASSISTANT, MANAGED_ASSISTANT_VERSION]);
    await reconcileInformationDigestAutomations(db.pool);
    await db.pool.query(
      `UPDATE automations SET agent_id=$1
        WHERE config_json->>'target_type'='information_digest'`,
      [MANAGED_ASSISTANT],
    );

    expect(await reconcileInformationDigestAutomations(db.pool)).toBe(0);
    const repaired = await db.pool.query<{ agent_id: string; snapshot_agent_id: string }>(
      `SELECT agent_id,
              preflight_snapshot_json->'information_digest_preflight'->>'attribution_agent_id' AS snapshot_agent_id
         FROM automations WHERE config_json->>'target_type'='information_digest'`,
    );
    expect(repaired.rows).toHaveLength(3);
    expect(repaired.rows.every(row => row.agent_id === AGENT && row.snapshot_agent_id === AGENT)).toBe(true);
  });
});

describe("bounded serendipity probe", () => {
  it("probes at most three gap domains per week and never writes the interest profile", async () => {
    if (!db.available) return;
    const searched: string[] = [];
    const provider: SerendipityProbeProvider = {
      available: async () => true,
      search: async (_identity, domainLabel) => {
        searched.push(domainLabel);
        return [{
          title: `${domainLabel} overview`,
          source_uri: `https://outside.example/${encodeURIComponent(domainLabel)}`,
          excerpt: "Outside-pool material",
        }];
      },
    };
    const service = new SerendipityProbeService(db.pool, provider);
    const first = await service.run(SPACE, OWNER, new Date(`${DATE}T12:00:00Z`));
    const second = await service.run(SPACE, OWNER, new Date(`${DATE}T12:00:00Z`));

    expect(first.request_count).toBe(3);
    expect(first.external_result_count).toBe(3);
    expect(searched).toHaveLength(3);
    expect(second.already_ran).toBe(true);
    const ledger = await db.pool.query(`SELECT request_count,result_count,status FROM information_digest_probe_runs`);
    expect(ledger.rows).toEqual([{ request_count: 3, result_count: 3, status: "succeeded" }]);
    expect((await db.pool.query(`SELECT id FROM interest_profiles`)).rows).toEqual([]);
  });

  it("records a probe whose every search failed as failed, not skipped", async () => {
    if (!db.available) return;
    const provider: SerendipityProbeProvider = {
      available: async () => true,
      search: async () => { throw new Error("quota exhausted"); },
    };

    const result = await new SerendipityProbeService(db.pool, provider).run(SPACE, OWNER, new Date(`${DATE}T12:00:00Z`));

    expect(result.request_count).toBeGreaterThan(0);
    expect(result.status).toBe("failed");
    const ledger = await db.pool.query(`SELECT status FROM information_digest_probe_runs`);
    expect(ledger.rows).toEqual([{ status: "failed" }]);
  });

  it("respects the reader's configured weekly probe budget", async () => {
    if (!db.available) return;
    await new InterestProfileService(db.pool).updateSettings(SPACE, OWNER, { probe_domain_budget: 1 });
    const searched: string[] = [];
    const provider: SerendipityProbeProvider = {
      available: async () => true,
      search: async (_identity, domainLabel) => {
        searched.push(domainLabel);
        return [];
      },
    };

    const result = await new SerendipityProbeService(db.pool, provider).run(
      SPACE, OWNER, new Date(`${DATE}T12:00:00Z`),
    );

    expect(result.domain_keys).toHaveLength(1);
    expect(result.request_count).toBe(1);
    expect(searched).toHaveLength(1);
  });

  it("keeps the weekly probe budget within what the probe ledger can record", async () => {
    if (!db.available) return;
    const profiles = new InterestProfileService(db.pool);
    await expect(profiles.updateSettings(SPACE, OWNER, { probe_domain_budget: 5 })).rejects.toThrow(/probe_domain_budget/);
    // A budget saved while the setting still allowed up to ten.
    await db.pool.query(
      `UPDATE interest_profiles SET settings_json = settings_json || '{"probe_domain_budget":10}'::jsonb
        WHERE space_id=$1 AND user_id=$2`,
      [SPACE, OWNER],
    );
    const provider: SerendipityProbeProvider = { available: async () => true, search: async () => [] };

    const result = await new SerendipityProbeService(db.pool, provider).run(SPACE, OWNER, new Date(`${DATE}T12:00:00Z`));

    expect(result.request_count).toBe(3);
    const ledger = await db.pool.query(`SELECT request_count,status FROM information_digest_probe_runs`);
    expect(ledger.rows).toEqual([{ request_count: 3, status: "succeeded" }]);
  });
});

describe("source recommendation decisions", () => {
  it("exposes only pending shared recommendations and requires an explicit owner decision", async () => {
    if (!db.available) return;
    const now = `${DATE}T12:00:00.000Z`;
    await db.pool.query(`UPDATE source_connections SET visibility='space_shared' WHERE id=$1`, [CONNECTION]);
    await db.pool.query(
      `INSERT INTO source_channel_user_subscriptions
         (id,space_id,source_channel_id,user_id,status,library_enabled,digest_enabled,recommendation_message,created_at,updated_at)
       VALUES ($1,$2,$3,$4,'pending',true,true,'Broaden into systems',$5,$5)`,
      [randomUUID(), SPACE, CHANNEL, OTHER, now],
    );
    const service = new SourceChannelService(db.pool, {} as never);

    const pending = await service.listRecommendations({ spaceId: SPACE, userId: OTHER });
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({ id: CHANNEL, subscription_status: "pending", recommendation_message: "Broaden into systems" });

    await service.decideRecommendation({ spaceId: SPACE, userId: OTHER }, CHANNEL, "subscribed");
    expect(await service.listRecommendations({ spaceId: SPACE, userId: OTHER })).toEqual([]);
    expect((await db.pool.query(
      `SELECT status FROM source_channel_user_subscriptions WHERE source_channel_id=$1 AND user_id=$2`,
      [CHANNEL, OTHER],
    )).rows).toEqual([{ status: "subscribed" }]);
  });
});
