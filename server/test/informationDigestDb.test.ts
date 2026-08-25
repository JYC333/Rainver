import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { InformationDigestService } from "../src/modules/informationDigest/service";
import { PgInformationDigestRepository } from "../src/modules/informationDigest/repository";
import type { Queryable, QueryResult } from "../src/modules/routeUtils/common";
import { reconcileInformationDigestAutomations } from "../src/modules/informationDigest/automationProvisioning";
import { PgSerendipityRepository } from "../src/modules/informationDigest/serendipityRepository";
import { SerendipityProbeService, type SerendipityProbeProvider } from "../src/modules/informationDigest/serendipityProbe";
import { SourceChannelService } from "../src/modules/sources/channels/sourceChannelService";
import { INTERESTING_COOLDOWN_DAYS, NEUTRAL_COOLDOWN_DAYS, SerendipityFeedbackService } from "../src/modules/informationDigest/feedbackService";
import { InterestProfileService } from "../src/modules/interestProfile/service";
import { InterestStarterPackService } from "../src/modules/informationDigest/starterPacks";
import { PgSourceAnnotationRepository } from "../src/modules/sourceAnnotation/repository";
import { getTestPostgres, isTestPostgresUnavailableError, type TestPostgresDatabase } from "./support/sharedPostgres";
import { resetTables } from "./support/resetTables";

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

let container: TestPostgresDatabase | undefined;
let pool: Pool | undefined;
let available = false;

beforeAll(async () => {
  try {
    container = await getTestPostgres(__filename);
    pool = new Pool({ connectionString: container.getConnectionUri(), max: 3 });
    available = true;
  } catch (error) {
    if (!isTestPostgresUnavailableError(error)) throw error;
    console.warn(`[information-digest-db] skipped — Docker/Postgres unavailable: ${error instanceof Error ? error.message : String(error)}`);
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
    ["information_digest_items", "information_digests", "interest_topics", "interest_profiles", "project_corpus_items", "project_members", "projects", "source_item_annotations", "source_item_user_states", "source_channel_user_subscriptions", "source_channel_item_links", "source_channels", "source_items", "source_connections", "source_provider_connectors", "source_providers", "source_connectors", "space_memberships", "users", "spaces"],
    { cascade: true },
  );
  const now = `${DATE}T08:00:00.000Z`;
  await pool.query(`INSERT INTO spaces (id,name,type,created_at,updated_at) VALUES ($1,'Team','team',$2,$2)`, [SPACE, now]);
  for (const user of [OWNER, OTHER, THIRD]) {
    await pool.query(`INSERT INTO users (id,display_name,status,created_at,updated_at) VALUES ($1,$1,'active',$2,$2)`, [user, now]);
    await pool.query(
      `INSERT INTO space_memberships (id,space_id,user_id,role,status,created_at,updated_at)
       VALUES ($1,$2,$3,'member','active',$4,$4)`,
      [randomUUID(), SPACE, user, now],
    );
  }
  await pool.query(
    `INSERT INTO source_connectors (id,connector_key,display_name,connector_type,ingestion_mode,status,capabilities_json,created_at,updated_at)
     VALUES ($1,'rss','RSS','external_feed','pull','active','{}'::jsonb,$2,$2)`,
    [CONNECTOR, now],
  );
  await pool.query(
    `INSERT INTO source_providers (id,provider_key,display_name,provider_kind,category,status,capabilities_json,created_at,updated_at)
     VALUES ($1,'rss','RSS','named','general','active','{}'::jsonb,$2,$2)`,
    [CONNECTOR, now],
  );
  const mapping = randomUUID();
  await pool.query(
    `INSERT INTO source_provider_connectors (id,provider_id,connector_id,status,priority,capabilities_json,created_at,updated_at)
     VALUES ($1,$2,$2,'active',0,'{}'::jsonb,$3,$3)`,
    [mapping, CONNECTOR, now],
  );
  await pool.query(
    `INSERT INTO source_connections
       (id,space_id,provider_connector_id,owner_user_id,name,status,capture_policy,trust_level,consent_json,policy_json,config_json,created_at,updated_at)
     VALUES ($1,$2,$3,$4,'Feed','active','reference_only','normal','{}','{}','{}',$5,$5)`,
    [CONNECTION, SPACE, mapping, OWNER, now],
  );
  await pool.query(
    `INSERT INTO source_channels
       (id,space_id,source_connection_id,created_by_user_id,name,channel_type,status,fetch_frequency,created_at,updated_at)
     VALUES ($1,$2,$3,$4,'Daily feed','feed','active','daily',$5,$5)`,
    [CHANNEL, SPACE, CONNECTION, OWNER, now],
  );
  await pool.query(
    `INSERT INTO source_channel_user_subscriptions
       (id,space_id,source_channel_id,user_id,status,library_enabled,digest_enabled,created_at,updated_at)
     VALUES ($1,$2,$3,$4,'subscribed',true,true,$5,$5)`,
    [randomUUID(), SPACE, CHANNEL, OWNER, now],
  );
  await pool.query(
    `INSERT INTO projects (id,space_id,owner_user_id,name,status,settings_json,created_at,updated_at)
     VALUES ($1,$2,$3,'Digest Project','active','{}',$4,$4)`,
    [PROJECT, SPACE, OWNER, now],
  );
  await pool.query(
    `INSERT INTO project_members (id,space_id,project_id,user_id,role,status,created_at,updated_at)
     VALUES ($1,$2,$3,$4,'viewer','active',$5,$5)`,
    [randomUUID(), SPACE, PROJECT, OTHER, now],
  );
  for (const user of [OWNER, THIRD]) {
    await pool.query(
      `INSERT INTO project_members (id,space_id,project_id,user_id,role,status,created_at,updated_at)
       VALUES ($1,$2,$3,$4,'viewer','active',$5,$5)`,
      [randomUUID(), SPACE, PROJECT, user, now],
    );
  }
  await pool.query(
    `INSERT INTO agents (id,space_id,owner_user_id,name,status,current_version_id,visibility,created_at,updated_at)
     VALUES ($1,$2,$3,'Digest attribution','active',NULL,'space_shared',$4,$4)`,
    [AGENT, SPACE, OWNER, now],
  );
  await pool.query(
    `INSERT INTO agent_versions
       (id,agent_id,space_id,version_label,system_prompt,model_config_json,runtime_config_json,
        context_policy_json,memory_policy_json,capabilities_json,tool_permissions_json,runtime_policy_json,created_at)
     VALUES ($1,$2,$3,'v1','test','{}','{}','{}','{}','[]','{"allowed_tools":[]}','{}',$4)`,
    [AGENT_VERSION, AGENT, SPACE, now],
  );
  await pool.query(`UPDATE agents SET current_version_id=$2 WHERE id=$1`, [AGENT, AGENT_VERSION]);
});

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
  await pool!.query(
    `INSERT INTO source_items
       (id,space_id,owner_user_id,visibility,connection_id,item_type,title,source_uri,occurred_at,
        first_seen_at,last_seen_at,content_state,retention_policy,created_at,updated_at)
     VALUES ($1,$2,$3,'space_shared',$4,'feed_entry',$5,$6,$7,$7,$7,'excerpt_saved','summary_only',$7,$7)`,
    [id, SPACE, OWNER, CONNECTION, input.title, `https://example.test/${id}`, at],
  );
  await pool!.query(
    `INSERT INTO source_item_annotations
       (id,space_id,source_item_id,source_channel_id,status,domain_key,depth,genre,summary,topic_candidates_json,
        stance_target,stance_target_key,stance_polarity,stance_confidence,attempt_count,annotated_at,created_at,updated_at)
     VALUES ($1,$2,$3,$4,'succeeded',$5,'analysis','explainer',$6,$7::jsonb,$8,$9,$10,$11,1,$12,$12,$12)`,
    [randomUUID(), SPACE, id, CHANNEL, input.domain ?? "artificial_intelligence", `${input.title} summary`,
      JSON.stringify(input.topics ?? []), input.stance?.target ?? null, input.stance?.key ?? null,
      input.stance?.polarity ?? "neutral", input.stance ? 90 : 0, at],
  );
  if (input.linked !== false) {
    await pool!.query(
      `INSERT INTO source_channel_item_links (id,space_id,source_channel_id,source_item_id,status,matched_at,created_at,updated_at)
       VALUES ($1,$2,$3,$4,'active',$5,$5,$5)`,
      [randomUUID(), SPACE, CHANNEL, id, at],
    );
  }
  if (input.project) {
    for (const user of [OTHER, THIRD]) {
      await pool!.query(
        `INSERT INTO source_channel_user_subscriptions
           (id,space_id,source_channel_id,user_id,status,library_enabled,digest_enabled,created_at,updated_at)
         VALUES ($1,$2,$3,$4,'subscribed',false,false,$5,$5)
         ON CONFLICT (space_id,source_channel_id,user_id) DO NOTHING`,
        [randomUUID(), SPACE, CHANNEL, user, at],
      );
    }
    await pool!.query(
      `INSERT INTO project_corpus_items
         (id,space_id,project_id,source_item_id,source_connection_id,role,status,triage_status,
          triage_confirmed_by_user,read_status,relevance,confidence,metadata_json,created_at,updated_at)
       VALUES ($1,$2,$3,$4,$5,'candidate','active','relevant',false,'unread','relevant',0.9,'{}',$6,$6)`,
      [randomUUID(), SPACE, PROJECT, id, CONNECTION, at],
    );
  }
  return id;
}

describe("information digest persistence", () => {
  it("uses the deterministic cold branch and persists complete slot attribution", async () => {
    if (!available) return;
    await seedItem({ title: "Older", hour: 7 });
    await seedItem({ title: "Newer", hour: 20 });

    const first = await new InformationDigestService(pool!).personal(SPACE, OWNER, DATE);
    const second = await new InformationDigestService(pool!).personal(SPACE, OWNER, DATE);

    expect(second.id).toBe(first.id);
    expect(first.profile_maturity).toBe("cold");
    expect(first.items.map((item) => item.title)).toEqual(["Newer", "Older"]);
    expect(first.items.every((item) => item.quota_slot.startsWith("interest:") && item.component_scores.recency !== undefined)).toBe(true);
    expect(first.items.every((item) => item.matched_topic_id === null)).toBe(true);
    const profiles = await pool!.query(`SELECT settings_json FROM interest_profiles WHERE space_id=$1 AND user_id=$2`, [SPACE, OWNER]);
    expect(profiles.rows).toEqual([{ settings_json: {} }]);
  });

  it("updates the fact layer before scheduled selection and excludes explicitly ignored items", async () => {
    if (!available) return;
    const kept = await seedItem({ title: "Kept signal", hour: 12, topics: ["model evaluation"] });
    const ignored = await seedItem({ title: "Ignored signal", hour: 13, topics: ["celebrity gossip"] });
    const now = `${DATE}T15:00:00.000Z`;
    for (const [itemId, libraryStatus, readStatus] of [[kept, "selected", "read"], [ignored, "ignored", "unread"]] as const) {
      await pool!.query(
        `INSERT INTO source_item_user_states
           (id,space_id,source_item_id,user_id,library_status,read_status,last_opened_at,progress_json,created_at,updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'{}',$7,$7)`,
        [randomUUID(), SPACE, itemId, OWNER, libraryStatus, readStatus, now],
      );
    }
    await new InterestProfileService(pool!).updateSettings(SPACE, OWNER, {
      new_topic_occurrence_threshold: 1,
      new_topic_read_threshold: 1,
      warming_min_read_items: 1,
      interest_slots: 1,
    });

    const digest = await new InformationDigestService(pool!).personal(SPACE, OWNER, DATE, null);
    const snapshot = await new InterestProfileService(pool!).snapshot(SPACE, OWNER);

    expect(digest.items.map((item) => item.source_item_id)).toEqual([kept]);
    expect(snapshot.ready_candidates.map((candidate) => candidate.phrase_key)).toEqual(["model-evaluation"]);
    expect(snapshot.ready_candidates.map((candidate) => candidate.phrase_key)).not.toContain("celebrity-gossip");
    expect(digest.settings.interest_slots).toBe(1);
  });

  it("applies optional starter packs idempotently without rewriting an existing topic", async () => {
    if (!available) return;
    const profiles = new InterestProfileService(pool!);
    await profiles.createTopic(SPACE, OWNER, { label: "Artificial intelligence", domainKey: "artificial_intelligence", weight: 4 });
    const service = new InterestStarterPackService(pool!);
    const first = await service.apply(SPACE, OWNER, "technology");
    const second = await service.apply(SPACE, OWNER, "technology");
    const snapshot = await profiles.snapshot(SPACE, OWNER);

    expect(first.topics).toBe(2);
    expect(second.topics).toBe(0);
    expect(snapshot.topics).toHaveLength(3);
    expect(snapshot.topics.find((topic) => topic.topic_key === "artificial-intelligence")?.weight).toBe(4);
  });

  it("queues subscribed historical items only through the explicit bounded backfill", async () => {
    if (!available) return;
    const id = randomUUID();
    const at = `${DATE}T04:00:00.000Z`;
    await pool!.query(
      `INSERT INTO source_items
         (id,space_id,owner_user_id,visibility,connection_id,item_type,title,source_uri,occurred_at,
          first_seen_at,last_seen_at,content_state,retention_policy,created_at,updated_at)
       VALUES ($1,$2,$3,'space_shared',$4,'feed_entry','Historical','https://example.test/history',$5,$5,$5,'excerpt_saved','summary_only',$5,$5)`,
      [id, SPACE, OWNER, CONNECTION, at],
    );
    await pool!.query(
      `INSERT INTO source_channel_item_links (id,space_id,source_channel_id,source_item_id,status,matched_at,created_at,updated_at)
       VALUES ($1,$2,$3,$4,'active',$5,$5,$5)`,
      [randomUUID(), SPACE, CHANNEL, id, at],
    );

    const repo = new PgSourceAnnotationRepository(pool!);
    expect(await repo.enqueueSubscriptionHistory(SPACE, OWNER, 1)).toBe(1);
    expect(await repo.enqueueSubscriptionHistory(SPACE, OWNER, 1)).toBe(0);
    expect((await pool!.query(`SELECT status FROM source_item_annotations WHERE source_item_id=$1`, [id])).rows).toEqual([{ status: "pending" }]);
  });

  it("selects personal and Project candidates by UTC day regardless of the database session timezone", async () => {
    if (!available) return;
    const personalItem = await seedItem({ title: "UTC personal", hour: 1 });
    const projectItem = await seedItem({ title: "UTC Project", hour: 2, project: true });
    const client = await pool!.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL TIME ZONE 'America/Los_Angeles'");
      const repo = new PgInformationDigestRepository(client);
      expect((await repo.personalCandidates(SPACE, OWNER, DATE)).map((item) => item.source_item_id)).toContain(personalItem);
      expect((await repo.projectCandidates(SPACE, PROJECT, DATE)).map((item) => item.source_item_id)).toContain(projectItem);
      await client.query("ROLLBACK");
    } finally {
      client.release();
    }
  });

  it("applies canonical Source access and redacts full fields for a summary-only personal reader", async () => {
    if (!available) return;
    const itemId = await seedItem({ title: "Shared summary", hour: 10 });
    const now = `${DATE}T11:00:00.000Z`;
    await pool!.query(
      `INSERT INTO source_channel_user_subscriptions
         (id,space_id,source_channel_id,user_id,status,library_enabled,digest_enabled,created_at,updated_at)
       VALUES ($1,$2,$3,$4,'subscribed',false,true,$5,$5)`,
      [randomUUID(), SPACE, CHANNEL, OTHER, now],
    );
    await pool!.query(
      `UPDATE source_items
          SET visibility='selected_users', access_level='full', excerpt='full source body'
        WHERE space_id=$1 AND id=$2`,
      [SPACE, itemId],
    );
    await pool!.query(
      `INSERT INTO content_access_grants
         (id,space_id,resource_type,resource_id,grantee_user_id,granted_by_user_id,
          access_level,created_at,updated_at)
       VALUES ($1,$2,'source_item',$3,$4,$5,'summary',$6,$6)`,
      [randomUUID(), SPACE, itemId, OTHER, OWNER, now],
    );

    const candidates = await new PgInformationDigestRepository(pool!).personalCandidates(SPACE, OTHER, DATE);

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
    if (!available) return;
    const itemId = await seedItem({ title: "Owner-only Project source", hour: 12, project: true });
    await pool!.query(
      `UPDATE source_items SET visibility='private' WHERE space_id=$1 AND id=$2`,
      [SPACE, itemId],
    );

    expect(await new PgInformationDigestRepository(pool!).projectCandidates(SPACE, PROJECT, DATE)).toEqual([]);
  });

  it("rechecks the daily snapshot after acquiring the scope lock under concurrent lazy reads", async () => {
    if (!available) return;
    await seedItem({ title: "Concurrent snapshot", hour: 12 });
    let arrivals = 0;
    let releaseBarrier!: () => void;
    const barrier = new Promise<void>((resolve) => { releaseBarrier = resolve; });
    const synchronizedDb: Queryable & { connect: () => ReturnType<Pool["connect"]> } = {
      connect: () => pool!.connect(),
      async query<Row>(sql: string, params?: readonly unknown[]): Promise<QueryResult<Row>> {
        const result = await pool!.query(sql, params ? [...params] : undefined);
        if (sql.includes("SELECT id, generated_by_run_id FROM information_digests") && arrivals < 2) {
          arrivals += 1;
          if (arrivals === 2) releaseBarrier();
          await barrier;
        }
        return result as QueryResult<Row>;
      },
    };

    const [first, second] = await Promise.all([
      new InformationDigestService(synchronizedDb).personal(SPACE, OWNER, DATE),
      new InformationDigestService(synchronizedDb).personal(SPACE, OWNER, DATE),
    ]);

    expect(second.id).toBe(first.id);
    expect(second.items.map((item) => item.id)).toEqual(first.items.map((item) => item.id));
  });

  it("stores one shared Project digest while hydrating each reader's private read state", async () => {
    if (!available) return;
    const itemId = await seedItem({ title: "Project item", hour: 12, project: true });
    const now = `${DATE}T14:00:00.000Z`;
    await pool!.query(
      `INSERT INTO source_item_user_states
         (id,space_id,source_item_id,user_id,library_status,read_status,last_opened_at,progress_json,created_at,updated_at)
       VALUES ($1,$2,$3,$4,'selected','read',$5,'{}',$5,$5)`,
      [randomUUID(), SPACE, itemId, OTHER, now],
    );

    const ownerView = await new InformationDigestService(pool!).project(SPACE, PROJECT, OWNER, DATE);
    const memberView = await new InformationDigestService(pool!).project(SPACE, PROJECT, OTHER, DATE);

    expect(memberView.id).toBe(ownerView.id);
    expect(ownerView.items[0].read_status).toBe("unread");
    expect(memberView.items[0].read_status).toBe("read");
    expect(memberView.settings.serendipity).toBe(false);
  });

  it("rechecks Source access when a reader hydrates an existing Project digest", async () => {
    if (!available) return;
    await seedItem({ title: "Revoked Project source", hour: 12, project: true });
    const ownerView = await new InformationDigestService(pool!).project(SPACE, PROJECT, OWNER, DATE);
    expect(ownerView.items).toHaveLength(1);

    await pool!.query(
      `UPDATE source_channel_user_subscriptions SET status='muted'
        WHERE space_id=$1 AND source_channel_id=$2 AND user_id=$3`,
      [SPACE, CHANNEL, OTHER],
    );

    const memberView = await new InformationDigestService(pool!).project(SPACE, PROJECT, OTHER, DATE);
    expect(memberView.id).toBe(ownerView.id);
    expect(memberView.items).toEqual([]);
  });

  it("shows only thresholded Project read aggregates and zero-reader domain blind spots", async () => {
    if (!available) return;
    const broadlyRead = await seedItem({ title: "Broadly read", hour: 12, project: true, domain: "history" });
    await seedItem({ title: "Unread domain", hour: 13, project: true, domain: "biology" });
    const now = `${DATE}T15:00:00.000Z`;
    for (const user of [OWNER, OTHER, THIRD]) {
      await pool!.query(
        `INSERT INTO source_item_user_states
           (id,space_id,source_item_id,user_id,library_status,read_status,last_opened_at,progress_json,created_at,updated_at)
         VALUES ($1,$2,$3,$4,'selected','read',$5,'{}',$5,$5)`,
        [randomUUID(), SPACE, broadlyRead, user, now],
      );
    }

    const digest = await new InformationDigestService(pool!).project(SPACE, PROJECT, OWNER, DATE);
    expect(digest.team_aggregates_available).toBe(true);
    expect(digest.team_blind_spot_domains).toEqual(["biology"]);
    expect(digest.items.find((item) => item.source_item_id === broadlyRead)?.anonymous_read_count).toBe(3);
    expect(digest.items.find((item) => item.title === "Unread domain")?.anonymous_read_count).toBeNull();

    await pool!.query(`DELETE FROM project_members WHERE project_id=$1 AND user_id=$2`, [PROJECT, THIRD]);
    const suppressed = await new InformationDigestService(pool!).project(SPACE, PROJECT, OWNER, DATE);
    expect(suppressed.team_aggregates_available).toBe(false);
    expect(suppressed.team_blind_spot_domains).toEqual([]);
    expect(suppressed.items.every((item) => item.anonymous_read_count === null)).toBe(true);
  });

  it("derives stance matching from only the current reader's high-confidence reading", async () => {
    if (!available) return;
    const supporting = await seedItem({
      title: "Supporting conclusion", hour: 12,
      stance: { target: "Open source models improve safety", key: "open source models improve safety", polarity: "supports" },
    });
    const now = `${DATE}T15:00:00.000Z`;
    await pool!.query(
      `INSERT INTO source_item_user_states
         (id,space_id,source_item_id,user_id,library_status,read_status,last_opened_at,progress_json,created_at,updated_at)
       VALUES ($1,$2,$3,$4,'selected','read',$5,'{}',$5,$5)`,
      [randomUUID(), SPACE, supporting, OWNER, now],
    );

    expect((await new PgSerendipityRepository(pool!).readingShape(SPACE, OWNER)).stanceByTarget)
      .toEqual({ "open source models improve safety": "supports" });
    expect((await new PgSerendipityRepository(pool!).readingShape(SPACE, OTHER)).stanceByTarget).toEqual({});
  });

  it("allocates outside-subscription candidates to a separate distant slot and consumes them once", async () => {
    if (!available) return;
    await seedItem({ title: "Familiar", hour: 10 });
    const outside = await seedItem({ title: "Outside", hour: 11, linked: false });
    await new PgSerendipityRepository(pool!).addPoolItem({
      spaceId: SPACE,
      userId: OWNER,
      sourceItemId: outside,
      targetDomainKey: "artificial_intelligence",
      origin: "weekly_probe",
      probePeriod: DATE,
    });

    const digest = await new InformationDigestService(pool!).personal(SPACE, OWNER, DATE);
    expect(digest.items.map((item) => item.section)).toEqual(["interest", "serendipity"]);
    expect(digest.items[1]).toMatchObject({
      title: "Outside",
      quota_slot: "serendipity:distant:1",
      target_domain_key: "artificial_intelligence",
      discovery_origin: "weekly_probe",
      serendipity_feedback: null,
    });
    expect(digest.items[1].rationale).toContain("Why you are seeing this");
    const poolState = await pool!.query(`SELECT status FROM information_digest_serendipity_pool WHERE source_item_id=$1`, [outside]);
    expect(poolState.rows).toEqual([{ status: "consumed" }]);
  });

  it("records explicit feedback in independent cooldown state without touching the interest profile", async () => {
    if (!available) return;
    const outside = await seedItem({ title: "Outside feedback", hour: 11, linked: false });
    await new PgSerendipityRepository(pool!).addPoolItem({
      spaceId: SPACE, userId: OWNER, sourceItemId: outside,
      targetDomainKey: "artificial_intelligence", origin: "weekly_probe", probePeriod: DATE,
    });
    const digest = await new InformationDigestService(pool!).personal(SPACE, OWNER, DATE);
    const item = digest.items.find((row) => row.section === "serendipity")!;
    const at = new Date(`${DATE}T21:00:00Z`);

    const first = await new SerendipityFeedbackService(pool!).record(SPACE, OWNER, item.id, "interesting", at);
    const repeated = await new SerendipityFeedbackService(pool!).record(SPACE, OWNER, item.id, "never", at);

    expect(first.feedback).toBe("interesting");
    expect(first.cooldown_until).toBe(new Date(at.getTime() + INTERESTING_COOLDOWN_DAYS * 86_400_000).toISOString());
    expect(repeated).toEqual(first);
    const waiting = await seedItem({ title: "Wait through cooldown", hour: 22, linked: false });
    await new PgSerendipityRepository(pool!).addPoolItem({
      spaceId: SPACE, userId: OWNER, sourceItemId: waiting,
      targetDomainKey: "artificial_intelligence", origin: "weekly_probe", probePeriod: DATE,
    });
    expect(await new PgSerendipityRepository(pool!).listStandby(SPACE, OWNER, `${DATE}T23:00:00Z`)).toEqual([]);

    const otherOutside = await seedItem({ title: "Neutral direction", hour: 12, linked: false });
    await pool!.query(
      `INSERT INTO source_channel_user_subscriptions
         (id,space_id,source_channel_id,user_id,status,library_enabled,digest_enabled,created_at,updated_at)
       VALUES ($1,$2,$3,$4,'subscribed',false,false,$5,$5)`,
      [randomUUID(), SPACE, CHANNEL, OTHER, `${DATE}T12:00:00.000Z`],
    );
    await new PgSerendipityRepository(pool!).addPoolItem({
      spaceId: SPACE, userId: OTHER, sourceItemId: otherOutside,
      targetDomainKey: "artificial_intelligence", origin: "weekly_probe", probePeriod: DATE,
    });
    const otherDigest = await new InformationDigestService(pool!).personal(SPACE, OTHER, DATE);
    const otherItem = otherDigest.items.find((row) => row.section === "serendipity")!;
    const neutral = await new SerendipityFeedbackService(pool!).record(SPACE, OTHER, otherItem.id, "neutral", at);
    expect(neutral.cooldown_until).toBe(new Date(at.getTime() + NEUTRAL_COOLDOWN_DAYS * 86_400_000).toISOString());
    expect((await pool!.query(`SELECT id FROM interest_topics WHERE space_id=$1 AND user_id=$2`, [SPACE, OWNER])).rows).toEqual([]);
    await expect(new SerendipityFeedbackService(pool!).record(SPACE, OTHER, item.id, "neutral", at)).rejects.toMatchObject({ statusCode: 404 });
  });

  it("uses the reader's configured serendipity cooldown", async () => {
    if (!available) return;
    await new InterestProfileService(pool!).updateSettings(SPACE, OWNER, { interesting_cooldown_days: 2 });
    const outside = await seedItem({ title: "Configured cooldown", hour: 11, linked: false });
    await new PgSerendipityRepository(pool!).addPoolItem({
      spaceId: SPACE, userId: OWNER, sourceItemId: outside,
      targetDomainKey: "artificial_intelligence", origin: "weekly_probe", probePeriod: DATE,
    });
    const digest = await new InformationDigestService(pool!).personal(SPACE, OWNER, DATE);
    const item = digest.items.find((row) => row.section === "serendipity")!;
    const at = new Date(`${DATE}T21:00:00Z`);

    const result = await new SerendipityFeedbackService(pool!).record(SPACE, OWNER, item.id, "interesting", at);

    expect(result.cooldown_until).toBe(new Date(at.getTime() + 2 * 86_400_000).toISOString());
  });

  it("turns only explicit never feedback into a permanent domain block", async () => {
    if (!available) return;
    const outside = await seedItem({ title: "Block direction", hour: 11, linked: false });
    await new PgSerendipityRepository(pool!).addPoolItem({
      spaceId: SPACE, userId: OWNER, sourceItemId: outside,
      targetDomainKey: "artificial_intelligence", origin: "weekly_probe", probePeriod: DATE,
    });
    const digest = await new InformationDigestService(pool!).personal(SPACE, OWNER, DATE);
    const item = digest.items.find((row) => row.section === "serendipity")!;

    const result = await new SerendipityFeedbackService(pool!).record(
      SPACE, OWNER, item.id, "never", new Date(`${DATE}T21:00:00Z`),
    );

    expect(result).toMatchObject({ feedback: "never", blocked: true, cooldown_until: null });
    expect(await new PgSerendipityRepository(pool!).blockedDomainKeys(SPACE, OWNER)).toEqual(["artificial_intelligence"]);
    expect((await pool!.query(`SELECT id FROM interest_topics`)).rows).toEqual([]);
  });
});

describe("information digest Automation provisioning", () => {
  it("creates one hidden daily schedule per eligible scope and is idempotent", async () => {
    if (!available) return;
    expect(await reconcileInformationDigestAutomations(pool!)).toBe(3);
    expect(await reconcileInformationDigestAutomations(pool!)).toBe(0);
    const automations = await pool!.query<{ scope: string; operation: string; project_id: string | null; cron: string }>(
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
    if (!available) return;
    const now = `${DATE}T08:30:00.000Z`;
    await pool!.query(
      `INSERT INTO agents (id,space_id,owner_user_id,name,status,current_version_id,visibility,agent_kind,created_at,updated_at)
       VALUES ($1,$2,$3,'Personal Assistant','active',NULL,'space_shared','system_assistant',$4,$4)`,
      [MANAGED_ASSISTANT, SPACE, OWNER, now],
    );
    await pool!.query(
      `INSERT INTO agent_versions
         (id,agent_id,space_id,version_label,system_prompt,model_config_json,runtime_config_json,
          context_policy_json,memory_policy_json,capabilities_json,tool_permissions_json,runtime_policy_json,created_at)
       VALUES ($1,$2,$3,'v1','test','{}','{}','{}','{}','[]','{"allowed_tools":[]}','{}',$4)`,
      [MANAGED_ASSISTANT_VERSION, MANAGED_ASSISTANT, SPACE, now],
    );
    await pool!.query(`UPDATE agents SET current_version_id=$2 WHERE id=$1`, [MANAGED_ASSISTANT, MANAGED_ASSISTANT_VERSION]);
    await reconcileInformationDigestAutomations(pool!);
    await pool!.query(
      `UPDATE automations SET agent_id=$1
        WHERE config_json->>'target_type'='information_digest'`,
      [MANAGED_ASSISTANT],
    );

    expect(await reconcileInformationDigestAutomations(pool!)).toBe(0);
    const repaired = await pool!.query<{ agent_id: string; snapshot_agent_id: string }>(
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
    if (!available) return;
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
    const service = new SerendipityProbeService(pool!, provider);
    const first = await service.run(SPACE, OWNER, new Date(`${DATE}T12:00:00Z`));
    const second = await service.run(SPACE, OWNER, new Date(`${DATE}T12:00:00Z`));

    expect(first.request_count).toBe(3);
    expect(first.external_result_count).toBe(3);
    expect(searched).toHaveLength(3);
    expect(second.already_ran).toBe(true);
    const ledger = await pool!.query(`SELECT request_count,result_count,status FROM information_digest_probe_runs`);
    expect(ledger.rows).toEqual([{ request_count: 3, result_count: 3, status: "succeeded" }]);
    expect((await pool!.query(`SELECT id FROM interest_profiles`)).rows).toEqual([]);
  });

  it("respects the reader's configured weekly probe budget", async () => {
    if (!available) return;
    await new InterestProfileService(pool!).updateSettings(SPACE, OWNER, { probe_domain_budget: 1 });
    const searched: string[] = [];
    const provider: SerendipityProbeProvider = {
      available: async () => true,
      search: async (_identity, domainLabel) => {
        searched.push(domainLabel);
        return [];
      },
    };

    const result = await new SerendipityProbeService(pool!, provider).run(
      SPACE, OWNER, new Date(`${DATE}T12:00:00Z`),
    );

    expect(result.domain_keys).toHaveLength(1);
    expect(result.request_count).toBe(1);
    expect(searched).toHaveLength(1);
  });
});

describe("source recommendation decisions", () => {
  it("exposes only pending shared recommendations and requires an explicit owner decision", async () => {
    if (!available) return;
    const now = `${DATE}T12:00:00.000Z`;
    await pool!.query(`UPDATE source_connections SET visibility='space_shared' WHERE id=$1`, [CONNECTION]);
    await pool!.query(
      `INSERT INTO source_channel_user_subscriptions
         (id,space_id,source_channel_id,user_id,status,library_enabled,digest_enabled,recommendation_message,created_at,updated_at)
       VALUES ($1,$2,$3,$4,'pending',true,true,'Broaden into systems',$5,$5)`,
      [randomUUID(), SPACE, CHANNEL, OTHER, now],
    );
    const service = new SourceChannelService(pool!, {} as never);

    const pending = await service.listRecommendations({ spaceId: SPACE, userId: OTHER });
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({ id: CHANNEL, subscription_status: "pending", recommendation_message: "Broaden into systems" });

    await service.decideRecommendation({ spaceId: SPACE, userId: OTHER }, CHANNEL, "subscribed");
    expect(await service.listRecommendations({ spaceId: SPACE, userId: OTHER })).toEqual([]);
    expect((await pool!.query(
      `SELECT status FROM source_channel_user_subscriptions WHERE source_channel_id=$1 AND user_id=$2`,
      [CHANNEL, OTHER],
    )).rows).toEqual([{ status: "subscribed" }]);
  });
});
