import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { useTestDatabase } from "./support/testDatabase.js";
import { resetTables } from "./support/resetTables.js";
import { PgSourceAnnotationRepository } from "../src/modules/sourceAnnotation/repository.js";
import { InterestProfileService } from "../src/modules/interestProfile/service.js";
import {
  PgInterestProfileRepository,
  NEW_TOPIC_OCCURRENCE_THRESHOLD,
  NEW_TOPIC_READ_THRESHOLD,
} from "../src/modules/interestProfile/repository.js";

// Real-Postgres coverage for the interest profile: coverage derives from what
// the reader actually read, topic growth is controlled, the fact layer is
// idempotent, and one member's profile never sees another's reading.

const SPACE = "11111111-1111-4111-8111-111111111111";
const OWNER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OTHER = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const CONNECTOR = "33333333-3333-4333-8333-333333333333";
const CONNECTION = "44444444-4444-4444-8444-444444444444";


const db = useTestDatabase(import.meta.filename);

beforeEach(async () => {
  if (!db.available) return;
  await resetTables(
    db.pool,
    ["interest_topic_observations", "interest_topic_candidates", "interest_topics", "interest_profiles", "source_item_annotations", "source_item_user_states", "source_items", "source_connections", "source_provider_connectors", "source_providers", "source_connectors", "space_memberships", "users", "spaces"],
    { cascade: true },
  );
  const now = new Date().toISOString();
  await db.pool.query(`INSERT INTO spaces (id, name, type, created_at, updated_at) VALUES ($1,'Main','team',$2,$2)`, [SPACE, now]);
  for (const user of [OWNER, OTHER]) {
    await db.pool.query(`INSERT INTO users (id, display_name, status, created_at, updated_at) VALUES ($1,$1,'active',$2,$2)`, [user, now]);
    await db.pool.query(
      `INSERT INTO space_memberships (id, space_id, user_id, role, status, created_at, updated_at)
       VALUES ($1,$2,$3,'member','active',$4,$4)`,
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
     ) VALUES ($1,$2,$3,$4,'Feed','active','reference_only','normal','{}'::jsonb,'{}'::jsonb,'{}'::jsonb,$5,$5)`,
    [CONNECTION, SPACE, mappingId, OWNER, now],
  );
});

const annotations = () => new PgSourceAnnotationRepository(db.pool);
const profiles = () => new PgInterestProfileRepository(db.pool);
const service = () => new InterestProfileService(db.pool);

async function seedAnnotatedItem(options: {
  domain: string;
  topics?: string[];
  readBy?: { user: string; readStatus: string; openedAt?: string }[];
}): Promise<string> {
  const itemId = randomUUID();
  const now = new Date().toISOString();
  await db.pool.query(
    `INSERT INTO source_items (
       id, space_id, owner_user_id, visibility, connection_id, item_type, title, source_uri,
       first_seen_at, last_seen_at, content_state, retention_policy, created_at, updated_at
     ) VALUES ($1,$2,$3,'space_shared',$4,'feed_entry',$5,$6,$7,$7,'excerpt_saved','summary_only',$7,$7)`,
    [itemId, SPACE, OWNER, CONNECTION, `Item ${itemId.slice(0, 8)}`, `https://example.com/${itemId}`, now],
  );
  await annotations().enqueueItems(SPACE, [itemId], null);
  await annotations().markSucceeded(SPACE, {
    source_item_id: itemId,
    domain_key: options.domain,
    depth: "analysis",
    genre: "explainer",
    summary: "s",
    topic_candidates: options.topics ?? [],
    stance_target: null,
    stance_target_key: null,
    stance_polarity: "neutral",
    stance_confidence: 0,
  }, null);
  for (const state of options.readBy ?? []) {
    await db.pool.query(
      `INSERT INTO source_item_user_states (id, space_id, source_item_id, user_id, library_status, read_status, last_opened_at, progress_json, created_at, updated_at)
       VALUES ($1,$2,$3,$4,'new',$5,$6,'{}'::jsonb,$7,$7)`,
      [randomUUID(), SPACE, itemId, state.user, state.readStatus, state.openedAt ?? now, now],
    );
  }
  return itemId;
}

describe("coverage derivation", () => {
  it("counts only what the reader engaged with", async () => {
    if (!db.available) return;
    await seedAnnotatedItem({ domain: "artificial_intelligence", readBy: [{ user: OWNER, readStatus: "read" }] });
    await seedAnnotatedItem({ domain: "artificial_intelligence", readBy: [{ user: OWNER, readStatus: "skimmed" }] });
    // Arrived and was passed on. Counting it would let a high-volume source the
    // reader ignores mark its domain covered and suppress serendipity there.
    await seedAnnotatedItem({ domain: "cooking", readBy: [{ user: OWNER, readStatus: "unread" }] });
    // Never touched at all.
    await seedAnnotatedItem({ domain: "sports" });

    const coverage = await profiles().coverageByDomain(SPACE, OWNER);
    expect(coverage.map((entry) => entry.domain_key)).toEqual(["artificial_intelligence"]);
    expect(coverage[0].item_count).toBe(2);
  });

  it("keeps one member's reading out of another's profile", async () => {
    if (!db.available) return;
    await seedAnnotatedItem({ domain: "sports", readBy: [{ user: OTHER, readStatus: "read" }] });
    await seedAnnotatedItem({ domain: "cooking", readBy: [{ user: OWNER, readStatus: "read" }] });

    expect((await profiles().coverageByDomain(SPACE, OWNER)).map((e) => e.domain_key)).toEqual(["cooking"]);
    expect((await profiles().coverageByDomain(SPACE, OTHER)).map((e) => e.domain_key)).toEqual(["sports"]);
  });

  it("weights recent reading above old reading", async () => {
    if (!db.available) return;
    const longAgo = new Date(Date.now() - 540 * 24 * 60 * 60 * 1000).toISOString();
    await seedAnnotatedItem({ domain: "history", readBy: [{ user: OWNER, readStatus: "read", openedAt: longAgo }] });
    await seedAnnotatedItem({ domain: "climate", readBy: [{ user: OWNER, readStatus: "read" }] });

    const coverage = await profiles().coverageByDomain(SPACE, OWNER);
    const history = coverage.find((entry) => entry.domain_key === "history")!;
    const climate = coverage.find((entry) => entry.domain_key === "climate")!;
    // Same raw count, very different current relevance.
    expect(history.item_count).toBe(climate.item_count);
    expect(history.weighted_count).toBeLessThan(climate.weighted_count / 2);
  });

  it("reports uncovered domains, and nearly everything when cold", async () => {
    if (!db.available) return;
    const snapshot = await service().snapshot(SPACE, OWNER);
    const uncovered = await service().uncoveredDomains(SPACE, OWNER);
    // Cold start: an empty distribution makes almost every domain a gap, which
    // is what makes serendipity computable on day one.
    expect(uncovered.length).toBe(snapshot.skeleton_size);
    expect(snapshot.maturity).toBe("cold");
    expect(snapshot.exploration_share).toBe(1);
    expect(snapshot.gaps_are_meaningful).toBe(false);
  });
});

describe("controlled topic growth", () => {
  it("does not create a topic from a phrase seen once", async () => {
    if (!db.available) return;
    await seedAnnotatedItem({
      domain: "artificial_intelligence",
      topics: ["retrieval-augmented generation"],
      readBy: [{ user: OWNER, readStatus: "read" }],
    });

    const result = await service().runFactLayer(SPACE, OWNER);
    expect(result.candidate_phrases).toBe(1);

    const snapshot = await service().snapshot(SPACE, OWNER);
    expect(snapshot.topics).toEqual([]);
    expect(snapshot.ready_candidates).toEqual([]);
  });

  it("promotes a phrase to ready once it recurs on material actually read", async () => {
    if (!db.available) return;
    for (let i = 0; i < NEW_TOPIC_OCCURRENCE_THRESHOLD; i += 1) {
      await seedAnnotatedItem({
        domain: "artificial_intelligence",
        topics: ["Retrieval Augmented Generation"],
        readBy: [{ user: OWNER, readStatus: i < NEW_TOPIC_READ_THRESHOLD ? "read" : "unread" }],
      });
    }
    await service().runFactLayer(SPACE, OWNER);

    const snapshot = await service().snapshot(SPACE, OWNER);
    expect(snapshot.ready_candidates).toHaveLength(1);
    expect(snapshot.ready_candidates[0].occurrence_count).toBe(NEW_TOPIC_OCCURRENCE_THRESHOLD);
    expect(snapshot.ready_candidates[0].read_count).toBe(NEW_TOPIC_READ_THRESHOLD);
    // Still not a topic — the owner has not confirmed it.
    expect(snapshot.topics).toEqual([]);
  });

  it("does not promote a phrase the reader never engages with", async () => {
    if (!db.available) return;
    for (let i = 0; i < NEW_TOPIC_OCCURRENCE_THRESHOLD + 3; i += 1) {
      await seedAnnotatedItem({
        domain: "sports",
        topics: ["fantasy football"],
        readBy: [{ user: OWNER, readStatus: "unread" }],
      });
    }
    await service().runFactLayer(SPACE, OWNER);

    // A prolific source the reader ignores must not manufacture an interest.
    expect((await service().snapshot(SPACE, OWNER)).ready_candidates).toEqual([]);
  });

  it("counts phrase spellings as one candidate", async () => {
    if (!db.available) return;
    for (const phrase of ["Large Language Models", "large language model", "LARGE  LANGUAGE  MODELS", "large-language-models"]) {
      await seedAnnotatedItem({
        domain: "artificial_intelligence",
        topics: [phrase],
        readBy: [{ user: OWNER, readStatus: "read" }],
      });
    }
    await service().runFactLayer(SPACE, OWNER);

    const ready = (await service().snapshot(SPACE, OWNER)).ready_candidates;
    expect(ready).toHaveLength(1);
    expect(ready[0].occurrence_count).toBe(4);
  });

  it("is idempotent: re-running does not double-count toward the threshold", async () => {
    if (!db.available) return;
    await seedAnnotatedItem({
      domain: "artificial_intelligence",
      topics: ["model evaluation"],
      readBy: [{ user: OWNER, readStatus: "read" }],
    });

    const first = await service().runFactLayer(SPACE, OWNER);
    expect(first.observed_items).toBe(1);
    for (let i = 0; i < 5; i += 1) await service().runFactLayer(SPACE, OWNER);

    const profile = await profiles().getProfile(SPACE, OWNER);
    const candidate = await profiles().getCandidate(profile!.id, "model-evaluation");
    // Without the observation ledger the threshold would fire off arithmetic
    // rather than off the reader's behaviour.
    expect(candidate?.occurrence_count).toBe(1);
  });

  it("counts the read when the reader opens an item after the pass already saw it", async () => {
    if (!db.available) return;
    // The real ordering: material is annotated on arrival, the pass runs while
    // it is still unread, and the reader opens it days later. A ledger that
    // only recorded "seen" would freeze every item unread and the read
    // threshold would essentially never be met.
    const itemIds: string[] = [];
    for (let i = 0; i < NEW_TOPIC_OCCURRENCE_THRESHOLD; i += 1) {
      itemIds.push(await seedAnnotatedItem({ domain: "energy", topics: ["grid storage"] }));
    }
    await service().runFactLayer(SPACE, OWNER);

    const profile = await profiles().getProfile(SPACE, OWNER);
    let candidate = await profiles().getCandidate(profile!.id, "grid-storage");
    expect(candidate?.occurrence_count).toBe(NEW_TOPIC_OCCURRENCE_THRESHOLD);
    expect(candidate?.read_count).toBe(0);
    expect(candidate?.status).toBe("accumulating");

    const now = new Date().toISOString();
    for (const itemId of itemIds.slice(0, NEW_TOPIC_READ_THRESHOLD)) {
      await db.pool.query(
        `INSERT INTO source_item_user_states (id, space_id, source_item_id, user_id, library_status, read_status, last_opened_at, progress_json, created_at, updated_at)
         VALUES ($1,$2,$3,$4,'new','read',$5,'{}'::jsonb,$5,$5)`,
        [randomUUID(), SPACE, itemId, OWNER, now],
      );
    }
    await service().runFactLayer(SPACE, OWNER);

    candidate = await profiles().getCandidate(profile!.id, "grid-storage");
    // Reads counted; occurrences not counted a second time.
    expect(candidate?.read_count).toBe(NEW_TOPIC_READ_THRESHOLD);
    expect(candidate?.occurrence_count).toBe(NEW_TOPIC_OCCURRENCE_THRESHOLD);
    expect(candidate?.status).toBe("ready");
  });

  it("counts an item's read exactly once however often it is reopened", async () => {
    if (!db.available) return;
    const itemId = await seedAnnotatedItem({ domain: "energy", topics: ["grid storage"] });
    await service().runFactLayer(SPACE, OWNER);

    const now = new Date().toISOString();
    await db.pool.query(
      `INSERT INTO source_item_user_states (id, space_id, source_item_id, user_id, library_status, read_status, last_opened_at, progress_json, created_at, updated_at)
       VALUES ($1,$2,$3,$4,'new','read',$5,'{}'::jsonb,$5,$5)`,
      [randomUUID(), SPACE, itemId, OWNER, now],
    );
    for (let i = 0; i < 4; i += 1) await service().runFactLayer(SPACE, OWNER);

    const profile = await profiles().getProfile(SPACE, OWNER);
    const candidate = await profiles().getCandidate(profile!.id, "grid-storage");
    expect(candidate?.occurrence_count).toBe(1);
    expect(candidate?.read_count).toBe(1);
  });

  it("resolves a phrase to an existing topic instead of re-proposing it", async () => {
    if (!db.available) return;
    const profile = await profiles().ensureProfile(SPACE, OWNER);
    await profiles().upsertTopic({
      spaceId: SPACE,
      userId: OWNER,
      profileId: profile.id,
      label: "Large language models",
      domainKey: "artificial_intelligence",
      aliases: ["LLMs"],
    });

    await seedAnnotatedItem({ domain: "artificial_intelligence", topics: ["large language models"], readBy: [{ user: OWNER, readStatus: "read" }] });
    await seedAnnotatedItem({ domain: "artificial_intelligence", topics: ["LLM"], readBy: [{ user: OWNER, readStatus: "read" }] });

    const result = await service().runFactLayer(SPACE, OWNER);
    expect(result.topic_hits).toBe(2);
    expect(result.candidate_phrases).toBe(0);
  });
});

describe("the confirmation boundary", () => {
  it("persists validated settings and supports direct topic editing without changing its stable key", async () => {
    if (!db.available) return;
    const updatedSettings = await service().updateSettings(SPACE, OWNER, {
      interest_slots: 3,
      serendipity_slots: 1,
      new_topic_occurrence_threshold: 2,
      new_topic_read_threshold: 1,
    });
    expect(updatedSettings).toMatchObject({
      interest_slots: 3,
      serendipity_slots: 1,
      new_topic_occurrence_threshold: 2,
      new_topic_read_threshold: 1,
    });
    await expect(service().updateSettings(SPACE, OWNER, {
      new_topic_occurrence_threshold: 1,
      new_topic_read_threshold: 2,
    })).rejects.toThrow(/cannot exceed/);

    const created = await service().createTopic(SPACE, OWNER, {
      label: "Model evaluation",
      domainKey: "artificial_intelligence",
      weight: 2,
    });
    const edited = await service().updateTopic(SPACE, OWNER, created.topic_key, {
      label: "Evaluation methods",
      domainKey: "research_practice",
      weight: 4,
    });
    expect(edited).toMatchObject({
      topic_key: "model-evaluation",
      label: "Evaluation methods",
      domain_key: "research_practice",
      weight: 4,
    });
    expect(await service().archiveTopic(SPACE, OWNER, created.topic_key)).toBe(true);
    expect((await service().snapshot(SPACE, OWNER)).topics).toEqual([]);
  });

  it("creates a topic only when the owner accepts a candidate", async () => {
    if (!db.available) return;
    for (let i = 0; i < NEW_TOPIC_OCCURRENCE_THRESHOLD; i += 1) {
      await seedAnnotatedItem({
        domain: "climate",
        topics: ["carbon removal"],
        readBy: [{ user: OWNER, readStatus: "read" }],
      });
    }
    await service().runFactLayer(SPACE, OWNER);

    const topic = await service().acceptCandidate(SPACE, OWNER, "carbon-removal");
    expect(topic.label).toBe("carbon removal");
    expect(topic.domain_key).toBe("climate");
    expect(topic.origin).toBe("user");

    const snapshot = await service().snapshot(SPACE, OWNER);
    expect(snapshot.topics.map((t) => t.topic_key)).toEqual(["carbon-removal"]);
    // The candidate is gone, so the same phrase is not offered again.
    expect(snapshot.ready_candidates).toEqual([]);
  });

  it("keeps a dismissed phrase dismissed however often it recurs", async () => {
    if (!db.available) return;
    await seedAnnotatedItem({ domain: "sports", topics: ["cricket"], readBy: [{ user: OWNER, readStatus: "read" }] });
    await service().runFactLayer(SPACE, OWNER);
    expect(await service().dismissCandidate(SPACE, OWNER, "cricket")).toBe(true);

    for (let i = 0; i < NEW_TOPIC_OCCURRENCE_THRESHOLD + 2; i += 1) {
      await seedAnnotatedItem({ domain: "sports", topics: ["cricket"], readBy: [{ user: OWNER, readStatus: "read" }] });
    }
    await service().runFactLayer(SPACE, OWNER);

    const profile = await profiles().getProfile(SPACE, OWNER);
    const candidate = await profiles().getCandidate(profile!.id, "cricket");
    // Counters still move — the reader may want to see they keep passing on it —
    // but arithmetic never lifts the status back.
    expect(candidate?.status).toBe("dismissed");
    expect(candidate!.occurrence_count).toBeGreaterThan(NEW_TOPIC_OCCURRENCE_THRESHOLD);
    expect((await service().snapshot(SPACE, OWNER)).ready_candidates).toEqual([]);
  });

  it("refuses a topic that cannot sit on the coverage axis", async () => {
    if (!db.available) return;
    const profile = await profiles().ensureProfile(SPACE, OWNER);
    await expect(profiles().upsertTopic({
      spaceId: SPACE,
      userId: OWNER,
      profileId: profile.id,
      label: "Vibes",
      domainKey: "not_a_domain",
    })).rejects.toThrow(/unknown domain key/);
  });

  it("revives an archived topic rather than duplicating it", async () => {
    if (!db.available) return;
    const profile = await profiles().ensureProfile(SPACE, OWNER);
    await profiles().upsertTopic({
      spaceId: SPACE, userId: OWNER, profileId: profile.id,
      label: "Urban planning", domainKey: "urbanism", aliases: ["city planning"],
    });
    expect(await profiles().archiveTopic(profile.id, "urban-planning")).toBe(true);
    expect(await profiles().listTopics(profile.id)).toEqual([]);

    await profiles().upsertTopic({
      spaceId: SPACE, userId: OWNER, profileId: profile.id,
      label: "Urban planning", domainKey: "urbanism", aliases: ["city planning"],
    });
    const topics = await profiles().listTopics(profile.id);
    expect(topics).toHaveLength(1);
    expect(topics[0].aliases).toContain("city-planning");
  });
});

describe("profile maturity over real data", () => {
  it("moves from cold through warming as reading accumulates", async () => {
    if (!db.available) return;
    const domains = ["artificial_intelligence", "climate", "economics", "history", "cooking", "medicine"];
    for (let i = 0; i < 20; i += 1) {
      await seedAnnotatedItem({ domain: domains[i % domains.length], readBy: [{ user: OWNER, readStatus: "read" }] });
    }
    const snapshot = await service().snapshot(SPACE, OWNER);
    expect(snapshot.read_item_count).toBe(20);
    expect(snapshot.covered_domain_count).toBe(6);
    expect(snapshot.maturity).toBe("warming");
    expect(snapshot.exploration_share).toBeLessThan(1);
    // Not warm yet: breadth alone is not enough to call an uncovered domain a
    // statement about the reader.
    expect(snapshot.gaps_are_meaningful).toBe(false);
  });
});
