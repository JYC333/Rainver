import { randomUUID } from "node:crypto";
import type { Queryable } from "../routeUtils/common.js";
import { isKnownDomain } from "../sourceAnnotation/index.js";
import { topicKeyFor } from "./topicKey.js";
import { DEFAULT_INTEREST_PROFILE_SETTINGS, type InterestProfileSettings } from "./settings.js";

export type TopicOrigin = "user" | "agent";
export type TopicStatus = "active" | "archived";
export type CandidateStatus = "accumulating" | "ready" | "dismissed";

export interface InterestProfileRow {
  id: string;
  space_id: string;
  user_id: string;
  settings_json: Record<string, unknown>;
}

export interface InterestTopicRow {
  id: string;
  topic_key: string;
  label: string;
  domain_key: string;
  aliases: string[];
  weight: number;
  origin: TopicOrigin;
  status: TopicStatus;
}

export interface TopicCandidateRow {
  id: string;
  phrase_key: string;
  display_phrase: string;
  domain_key: string | null;
  occurrence_count: number;
  read_count: number;
  status: CandidateStatus;
}

export interface CoverageEntry {
  domain_key: string;
  item_count: number;
  /** Recency-weighted count; see `coverageByDomain`. */
  weighted_count: number;
}

/**
 * Half-life of a read item's contribution to coverage, in days.
 *
 * Coverage answers "what is this reader's world right now", so material from
 * two years ago should not hold a domain open forever. A half-life rather than
 * a cutoff window: a hard cutoff makes a domain vanish from coverage the day
 * its last item ages out, which reads downstream as a brand-new gap in
 * something the reader followed for years.
 */
export const COVERAGE_HALF_LIFE_DAYS = DEFAULT_INTEREST_PROFILE_SETTINGS.coverage_half_life_days;

/** Times a phrase must recur before it is worth showing as a possible topic. */
export const NEW_TOPIC_OCCURRENCE_THRESHOLD = DEFAULT_INTEREST_PROFILE_SETTINGS.new_topic_occurrence_threshold;

/** Of those occurrences, how many must be on material the reader actually read. */
export const NEW_TOPIC_READ_THRESHOLD = DEFAULT_INTEREST_PROFILE_SETTINGS.new_topic_read_threshold;

export class PgInterestProfileRepository {
  constructor(private readonly db: Queryable) {}

  async ensureProfile(spaceId: string, userId: string): Promise<InterestProfileRow> {
    const now = new Date().toISOString();
    await this.db.query(
      `INSERT INTO interest_profiles (id, space_id, user_id, settings_json, created_at, updated_at)
       VALUES ($1, $2, $3, '{}'::jsonb, $4, $4)
       ON CONFLICT (space_id, user_id) DO NOTHING`,
      [randomUUID(), spaceId, userId, now],
    );
    const result = await this.db.query<InterestProfileRow>(
      `SELECT id, space_id, user_id, settings_json
         FROM interest_profiles
        WHERE space_id = $1 AND user_id = $2`,
      [spaceId, userId],
    );
    const row = result.rows[0];
    if (!row) throw new Error("interest profile missing after upsert");
    return { ...row, settings_json: recordValue(row.settings_json) };
  }

  async getProfile(spaceId: string, userId: string): Promise<InterestProfileRow | null> {
    const result = await this.db.query<InterestProfileRow>(
      `SELECT id, space_id, user_id, settings_json
         FROM interest_profiles
        WHERE space_id = $1 AND user_id = $2`,
      [spaceId, userId],
    );
    const row = result.rows[0];
    return row ? { ...row, settings_json: recordValue(row.settings_json) } : null;
  }

  async updateSettings(profileId: string, settings: InterestProfileSettings): Promise<void> {
    await this.db.query(
      `UPDATE interest_profiles SET settings_json=$2::jsonb, updated_at=$3 WHERE id=$1`,
      [profileId, JSON.stringify(settings), new Date().toISOString()],
    );
  }

  async listTopics(profileId: string, includeArchived = false): Promise<InterestTopicRow[]> {
    const result = await this.db.query<InterestTopicRow & { aliases_json: unknown }>(
      `SELECT id, topic_key, label, domain_key, aliases_json, weight, origin, status
         FROM interest_topics
        WHERE profile_id = $1
          AND ($2::boolean OR status = 'active')
        ORDER BY weight DESC, label ASC`,
      [profileId, includeArchived],
    );
    return result.rows.map((row) => ({ ...row, aliases: stringArray(row.aliases_json) }));
  }

  /**
   * Creates a topic, or revives an archived one under the same key.
   *
   * Reviving rather than erroring because archiving is how a reader says "not
   * any more", not "never again": if the same interest comes back, the row that
   * carries its aliases and history should come back with it rather than being
   * replaced by an empty duplicate.
   */
  async upsertTopic(input: {
    spaceId: string;
    userId: string;
    profileId: string;
    label: string;
    domainKey: string;
    origin?: TopicOrigin;
    weight?: number;
    aliases?: readonly string[];
  }): Promise<InterestTopicRow> {
    if (!isKnownDomain(input.domainKey)) {
      throw new Error(`unknown domain key ${JSON.stringify(input.domainKey)}`);
    }
    const topicKey = topicKeyFor(input.label);
    if (!topicKey) throw new Error("topic label does not normalize to a key");
    const aliases = normalizeAliases(input.aliases ?? [], topicKey);
    const now = new Date().toISOString();
    await this.db.query(
      `INSERT INTO interest_topics
         (id, space_id, user_id, profile_id, topic_key, label, domain_key, aliases_json, weight, origin, status, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,'active',$11,$11)
       ON CONFLICT (profile_id, topic_key) DO UPDATE
          SET label = EXCLUDED.label,
              domain_key = EXCLUDED.domain_key,
              aliases_json = EXCLUDED.aliases_json,
              weight = EXCLUDED.weight,
              status = 'active',
              updated_at = EXCLUDED.updated_at`,
      [
        randomUUID(),
        input.spaceId,
        input.userId,
        input.profileId,
        topicKey,
        input.label.trim().slice(0, 128),
        input.domainKey,
        JSON.stringify(aliases),
        input.weight ?? 1,
        input.origin ?? "user",
        now,
      ],
    );
    const topics = await this.db.query<InterestTopicRow & { aliases_json: unknown }>(
      `SELECT id, topic_key, label, domain_key, aliases_json, weight, origin, status
         FROM interest_topics WHERE profile_id = $1 AND topic_key = $2`,
      [input.profileId, topicKey],
    );
    const row = topics.rows[0];
    if (!row) throw new Error("interest topic missing after upsert");
    return { ...row, aliases: stringArray(row.aliases_json) };
  }

  async archiveTopic(profileId: string, topicKey: string): Promise<boolean> {
    const result = await this.db.query(
      `UPDATE interest_topics SET status = 'archived', updated_at = $3
        WHERE profile_id = $1 AND topic_key = $2 AND status = 'active'`,
      [profileId, topicKey, new Date().toISOString()],
    );
    return (result.rowCount ?? 0) > 0;
  }

  async updateTopic(profileId: string, topicKey: string, input: { label: string; domainKey: string; weight: number }): Promise<InterestTopicRow | null> {
    if (!isKnownDomain(input.domainKey)) throw new Error(`unknown domain key ${JSON.stringify(input.domainKey)}`);
    const label = input.label.trim().slice(0, 128);
    if (!label) throw new Error("topic label is required");
    const result = await this.db.query<InterestTopicRow & { aliases_json: unknown }>(
      `UPDATE interest_topics SET label=$3, domain_key=$4, weight=$5, updated_at=$6
        WHERE profile_id=$1 AND topic_key=$2 AND status='active'
        RETURNING id, topic_key, label, domain_key, aliases_json, weight, origin, status`,
      [profileId, topicKey, label, input.domainKey, input.weight, new Date().toISOString()],
    );
    const row = result.rows[0];
    return row ? { ...row, aliases: stringArray(row.aliases_json) } : null;
  }

  /**
   * Recency-weighted coverage per skeleton domain, over material this reader
   * actually engaged with.
   *
   * Unread material is not coverage. It arrived and the reader passed on it;
   * counting it would let a high-volume source they ignore mark its whole
   * domain as covered and suppress serendipity there permanently.
   */
  async coverageByDomain(spaceId: string, userId: string, halfLifeDays = COVERAGE_HALF_LIFE_DAYS): Promise<CoverageEntry[]> {
    const result = await this.db.query<{ domain_key: string; item_count: string; weighted_count: string }>(
      `SELECT a.domain_key,
              COUNT(*)::text AS item_count,
              SUM(POWER(0.5, EXTRACT(EPOCH FROM (now() - COALESCE(s.last_opened_at, s.updated_at))) / ($3 * 86400)))::text AS weighted_count
         FROM source_item_annotations a
         JOIN source_item_user_states s
           ON s.space_id = a.space_id AND s.source_item_id = a.source_item_id
        WHERE a.space_id = $1
          AND s.user_id = $2
          AND a.status = 'succeeded'
          AND a.domain_key IS NOT NULL
          AND s.read_status <> 'unread'
        GROUP BY a.domain_key
        ORDER BY weighted_count DESC`,
      [spaceId, userId, halfLifeDays],
    );
    return result.rows.map((row) => ({
      domain_key: row.domain_key,
      item_count: Number(row.item_count),
      weighted_count: Number(row.weighted_count),
    }));
  }

  /** Items read, and distinct domains covered — the maturity inputs. */
  async maturityInputs(spaceId: string, userId: string): Promise<{ readItemCount: number; coveredDomainCount: number }> {
    const result = await this.db.query<{ read_items: string; domains: string }>(
      `SELECT COUNT(*)::text AS read_items,
              COUNT(DISTINCT a.domain_key)::text AS domains
         FROM source_item_annotations a
         JOIN source_item_user_states s
           ON s.space_id = a.space_id AND s.source_item_id = a.source_item_id
        WHERE a.space_id = $1
          AND s.user_id = $2
          AND a.status = 'succeeded'
          AND a.domain_key IS NOT NULL
          AND s.read_status <> 'unread'`,
      [spaceId, userId],
    );
    const row = result.rows[0];
    return {
      readItemCount: Number(row?.read_items ?? 0),
      coveredDomainCount: Number(row?.domains ?? 0),
    };
  }

  /**
   * Annotated items this profile still owes accounting for.
   *
   * Two kinds, distinguished by `already_observed`:
   *
   * - never seen — count every phrase's occurrence, and its read if the reader
   *   has already engaged with it.
   * - seen while unread, since read — count only the read, because the
   *   occurrence was already counted.
   *
   * Bounded by the ledger rather than by time, so the pass stays idempotent
   * however often it runs and over whatever window.
   */
  async loadPendingAnnotations(
    spaceId: string,
    userId: string,
    profileId: string,
    limit: number,
  ): Promise<{
    source_item_id: string;
    domain_key: string;
    topic_candidates: string[];
    was_read: boolean;
    was_ignored: boolean;
    already_observed: boolean;
  }[]> {
    const result = await this.db.query<{
      source_item_id: string;
      domain_key: string;
      topic_candidates_json: unknown;
      was_read: boolean;
      was_ignored: boolean;
      already_observed: boolean;
    }>(
      `SELECT a.source_item_id,
              a.domain_key,
              a.topic_candidates_json,
              COALESCE(s.read_status, 'unread') <> 'unread' AS was_read,
              COALESCE(s.library_status, 'new') = 'ignored' AS was_ignored,
              o.id IS NOT NULL AS already_observed
         FROM source_item_annotations a
         LEFT JOIN source_item_user_states s
           ON s.space_id = a.space_id AND s.source_item_id = a.source_item_id AND s.user_id = $2
         LEFT JOIN interest_topic_observations o
           ON o.profile_id = $3 AND o.source_item_id = a.source_item_id
        WHERE a.space_id = $1
          AND a.status = 'succeeded'
          AND a.domain_key IS NOT NULL
          AND (
            o.id IS NULL
            OR (o.counted_as_read = FALSE AND COALESCE(s.read_status, 'unread') <> 'unread')
          )
        ORDER BY a.annotated_at ASC NULLS LAST, a.id ASC
        LIMIT $4`,
      [spaceId, userId, profileId, limit],
    );
    return result.rows.map((row) => ({
      source_item_id: row.source_item_id,
      domain_key: row.domain_key,
      topic_candidates: stringArray(row.topic_candidates_json),
      was_read: row.was_read,
      was_ignored: row.was_ignored,
      already_observed: row.already_observed,
    }));
  }

  /**
   * Records that an item has been accounted for.
   *
   * `countedAsRead` latches: once true it stays true, so an item cannot be
   * counted as read twice if the reader reopens it.
   */
  async markObserved(
    spaceId: string,
    profileId: string,
    entries: readonly { sourceItemId: string; countedAsRead: boolean }[],
  ): Promise<void> {
    if (entries.length === 0) return;
    const now = new Date().toISOString();
    await this.db.query(
      `INSERT INTO interest_topic_observations (id, space_id, profile_id, source_item_id, counted_as_read, observed_at)
       SELECT gen_random_uuid()::text, $1::varchar, $2::varchar, entry.item_id, entry.was_read, $3
         FROM unnest($4::text[], $5::boolean[]) AS entry(item_id, was_read)
       ON CONFLICT (profile_id, source_item_id) DO UPDATE
          SET counted_as_read = interest_topic_observations.counted_as_read OR EXCLUDED.counted_as_read`,
      [
        spaceId,
        profileId,
        now,
        entries.map((entry) => entry.sourceItemId),
        entries.map((entry) => entry.countedAsRead),
      ],
    );
  }

  /**
   * Records phrase occurrences that did not resolve to an existing topic.
   *
   * A dismissed phrase stays dismissed. Its counters still move — the reader
   * may want to see that they keep passing on it — but its status is never
   * lifted back to `accumulating` by arithmetic, only by an explicit action.
   */
  async accumulateCandidates(
    input: {
      spaceId: string;
      userId: string;
      profileId: string;
      phrases: { phraseKey: string; display: string; domainKey: string; wasRead: boolean; occurrenceIsNew: boolean }[];
      settings?: Pick<InterestProfileSettings, "new_topic_occurrence_threshold" | "new_topic_read_threshold">;
    },
  ): Promise<void> {
    if (input.phrases.length === 0) return;
    const now = new Date().toISOString();
    for (const phrase of input.phrases) {
      const occurrenceDelta = phrase.occurrenceIsNew ? 1 : 0;
      const readDelta = phrase.wasRead ? 1 : 0;
      await this.db.query(
        `INSERT INTO interest_topic_candidates
           (id, space_id, user_id, profile_id, phrase_key, display_phrase, domain_key,
            occurrence_count, read_count, status, last_seen_at, created_at, updated_at)
         -- A fresh row is always one occurrence: reaching here at all means the
         -- phrase was seen. The delta only governs the conflict path, where the
         -- occurrence may already have been counted on an earlier pass.
         VALUES ($1,$2,$3,$4,$5,$6,$7,1,$9::integer,
                 CASE WHEN 1 >= $11::integer AND $9::integer >= $12::integer THEN 'ready' ELSE 'accumulating' END,
                 $10,$10,$10)
         ON CONFLICT (profile_id, phrase_key) DO UPDATE
            SET occurrence_count = interest_topic_candidates.occurrence_count + $8::integer,
                read_count = interest_topic_candidates.read_count + $9::integer,
                domain_key = COALESCE(interest_topic_candidates.domain_key, EXCLUDED.domain_key),
                status = CASE
                  WHEN interest_topic_candidates.status = 'dismissed' THEN 'dismissed'
                  WHEN interest_topic_candidates.occurrence_count + $8::integer >= $11::integer
                   AND interest_topic_candidates.read_count + $9::integer >= $12::integer THEN 'ready'
                  ELSE interest_topic_candidates.status
                END,
                last_seen_at = EXCLUDED.last_seen_at,
                updated_at = EXCLUDED.updated_at`,
        [
          randomUUID(),
          input.spaceId,
          input.userId,
          input.profileId,
          phrase.phraseKey,
          phrase.display,
          phrase.domainKey,
          occurrenceDelta,
          readDelta,
          now,
          input.settings?.new_topic_occurrence_threshold ?? NEW_TOPIC_OCCURRENCE_THRESHOLD,
          input.settings?.new_topic_read_threshold ?? NEW_TOPIC_READ_THRESHOLD,
        ],
      );
    }
  }

  /** Candidates that crossed the threshold and await the owner's decision. */
  async listReadyCandidates(profileId: string, limit = 20): Promise<TopicCandidateRow[]> {
    const result = await this.db.query<TopicCandidateRow>(
      `SELECT id, phrase_key, display_phrase, domain_key, occurrence_count, read_count, status
         FROM interest_topic_candidates
        WHERE profile_id = $1 AND status = 'ready'
        ORDER BY read_count DESC, occurrence_count DESC, display_phrase ASC
        LIMIT $2`,
      [profileId, limit],
    );
    return result.rows;
  }

  async dismissCandidate(profileId: string, phraseKey: string): Promise<boolean> {
    const result = await this.db.query(
      `UPDATE interest_topic_candidates
          SET status = 'dismissed', updated_at = $3
        WHERE profile_id = $1 AND phrase_key = $2 AND status <> 'dismissed'`,
      [profileId, phraseKey, new Date().toISOString()],
    );
    return (result.rowCount ?? 0) > 0;
  }

  async getCandidate(profileId: string, phraseKey: string): Promise<TopicCandidateRow | null> {
    const result = await this.db.query<TopicCandidateRow>(
      `SELECT id, phrase_key, display_phrase, domain_key, occurrence_count, read_count, status
         FROM interest_topic_candidates
        WHERE profile_id = $1 AND phrase_key = $2`,
      [profileId, phraseKey],
    );
    return result.rows[0] ?? null;
  }

  /** Removes a candidate that has become a topic. */
  async clearCandidate(profileId: string, phraseKey: string): Promise<void> {
    await this.db.query(
      `DELETE FROM interest_topic_candidates WHERE profile_id = $1 AND phrase_key = $2`,
      [profileId, phraseKey],
    );
  }
}

function normalizeAliases(aliases: readonly string[], topicKey: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>([topicKey]);
  for (const alias of aliases) {
    const key = topicKeyFor(alias);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(key);
  }
  return out;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

function recordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
