import { randomUUID } from "node:crypto";
import type { Queryable } from "../routeUtils/common";
import { contentAccessLevelSql } from "../access/contentAccessSql";
import { contentResourceDefinition } from "../access/contentAccessRegistry";
import { sourceItemReadableClause } from "../sources/sourceItemAccess";

const SOURCE_ITEM_ACCESS = contentResourceDefinition("source_item")!;

type DigestCandidateRow = Omit<DigestCandidate, "topic_candidates"> & {
  topic_candidates_json: unknown;
  effective_access_level: "full" | "summary";
};

export interface DigestCandidate {
  source_item_id: string;
  connection_id: string | null;
  title: string;
  source_uri: string | null;
  source_domain: string | null;
  author: string | null;
  excerpt: string | null;
  occurred_at: string | null;
  first_seen_at: string;
  domain_key: string;
  depth: string;
  genre: string;
  summary: string | null;
  topic_candidates: string[];
  stance_target: string | null;
  stance_target_key: string | null;
  stance_polarity: string;
  stance_confidence: number;
  project_relevance: string | null;
  project_confidence: number | null;
}

export interface PersistedDigestItem extends DigestCandidate {
  id: string;
  section: "interest" | "serendipity";
  position: number;
  quota_slot: string;
  matched_topic_id: string | null;
  serendipity_pool_item_id: string | null;
  target_domain_key: string | null;
  discovery_origin: string | null;
  score: number;
  component_scores: Record<string, number>;
  rationale: string | null;
  read_status: string;
  serendipity_feedback: "interesting" | "neutral" | "never" | null;
  anonymous_read_count: number | null;
}

export interface PersistedDigest {
  id: string;
  digest_type: "personal" | "project";
  owner_user_id: string | null;
  project_id: string | null;
  digest_date: string;
  profile_maturity: "cold" | "warming" | "warm" | null;
  status: "ready" | "empty" | "failed";
  generated_by_run_id: string | null;
  settings: Record<string, unknown>;
  created_at: string;
  updated_at: string;
  items: PersistedDigestItem[];
  team_aggregates_available: boolean;
  team_blind_spot_domains: string[];
}

export class PgInformationDigestRepository {
  constructor(readonly db: Queryable) {}

  async personalCandidates(spaceId: string, userId: string, date: string): Promise<DigestCandidate[]> {
    const result = await this.db.query<DigestCandidateRow>(
      `SELECT DISTINCT ON (i.id)
              i.id AS source_item_id, i.connection_id, i.title, i.source_uri,
              i.source_domain, i.author, i.excerpt, i.occurred_at, i.first_seen_at,
              a.domain_key, a.depth, a.genre, a.summary, a.topic_candidates_json,
              a.stance_target, a.stance_target_key, a.stance_polarity, a.stance_confidence,
              NULL::varchar AS project_relevance, NULL::double precision AS project_confidence,
              ${contentAccessLevelSql({ definition: SOURCE_ITEM_ACCESS, alias: "i", userExpr: "$2" })} AS effective_access_level
         FROM source_channel_user_subscriptions sub
         JOIN source_channels c
           ON c.id = sub.source_channel_id AND c.space_id = sub.space_id
         JOIN source_channel_item_links l
           ON l.source_channel_id = c.id AND l.space_id = c.space_id AND l.status = 'active'
         JOIN source_items i
           ON i.id = l.source_item_id AND i.space_id = l.space_id AND i.deleted_at IS NULL
         JOIN source_item_annotations a
           ON a.source_item_id = i.id AND a.space_id = i.space_id AND a.status = 'succeeded'
         LEFT JOIN source_item_user_states state
           ON state.source_item_id=i.id AND state.space_id=i.space_id AND state.user_id=$2
        WHERE sub.space_id = $1 AND sub.user_id = $2
          AND sub.status = 'subscribed' AND sub.digest_enabled = true
          AND c.status = 'active'
          AND COALESCE(state.library_status, 'new') <> 'ignored'
          AND COALESCE(i.occurred_at, i.first_seen_at) >= ($3::date::timestamp AT TIME ZONE 'UTC')
          AND COALESCE(i.occurred_at, i.first_seen_at) < (($3::date + 1)::timestamp AT TIME ZONE 'UTC')
          AND ${sourceItemReadableClause("i", "$2", false)}
        ORDER BY i.id, COALESCE(i.occurred_at, i.first_seen_at) DESC`,
      [spaceId, userId, date],
    );
    return result.rows.map(hydrateCandidate);
  }

  async projectCandidates(spaceId: string, projectId: string, date: string): Promise<DigestCandidate[]> {
    const result = await this.db.query<DigestCandidateRow>(
      `SELECT DISTINCT ON (i.id)
              i.id AS source_item_id, i.connection_id, i.title, i.source_uri,
              i.source_domain, i.author, i.excerpt, i.occurred_at, i.first_seen_at,
              a.domain_key, a.depth, a.genre, a.summary, a.topic_candidates_json,
              a.stance_target, a.stance_target_key, a.stance_polarity, a.stance_confidence,
              pci.relevance AS project_relevance, pci.confidence AS project_confidence,
              'full'::varchar AS effective_access_level
         FROM project_corpus_items pci
         LEFT JOIN project_corpus_item_sources pcis
           ON pcis.corpus_item_id = pci.id AND pcis.space_id = pci.space_id
         JOIN source_items i
           ON i.id = COALESCE(pci.source_item_id, pcis.source_item_id)
          AND i.space_id = pci.space_id AND i.deleted_at IS NULL
         JOIN source_item_annotations a
           ON a.source_item_id = i.id AND a.space_id = i.space_id AND a.status = 'succeeded'
        WHERE pci.space_id = $1 AND pci.project_id = $2 AND pci.status = 'active'
          AND pci.triage_status <> 'excluded'
          AND pci.created_at >= ($3::date::timestamp AT TIME ZONE 'UTC')
          AND pci.created_at < (($3::date + 1)::timestamp AT TIME ZONE 'UTC')
          AND NOT EXISTS (
            SELECT 1
              FROM (
                SELECT project.owner_user_id AS user_id
                  FROM projects project
                 WHERE project.space_id = pci.space_id AND project.id = pci.project_id
                   AND project.deleted_at IS NULL AND project.owner_user_id IS NOT NULL
                UNION
                SELECT member.user_id
                  FROM project_members member
                 WHERE member.space_id = pci.space_id AND member.project_id = pci.project_id
                   AND member.status = 'active'
              ) project_reader
             WHERE NOT (
               ${sourceItemReadableClause("i", "project_reader.user_id", false, { includeOversight: false })}
               AND ${contentAccessLevelSql({
                 definition: SOURCE_ITEM_ACCESS,
                 alias: "i",
                 userExpr: "project_reader.user_id",
                 includeOversight: false,
               })} = 'full'
             )
          )
        ORDER BY i.id, pci.updated_at DESC`,
      [spaceId, projectId, date],
    );
    return result.rows.map(hydrateCandidate);
  }

  async maturityInputs(spaceId: string, userId: string): Promise<{ readItemCount: number; coveredDomainCount: number }> {
    const result = await this.db.query<{ read_items: string; domains: string }>(
      `SELECT COUNT(*)::text AS read_items, COUNT(DISTINCT a.domain_key)::text AS domains
         FROM source_item_annotations a
         JOIN source_item_user_states s
           ON s.source_item_id = a.source_item_id AND s.space_id = a.space_id
        WHERE a.space_id = $1 AND s.user_id = $2 AND a.status = 'succeeded'
          AND s.read_status <> 'unread'`,
      [spaceId, userId],
    );
    return {
      readItemCount: Number(result.rows[0]?.read_items ?? 0),
      coveredDomainCount: Number(result.rows[0]?.domains ?? 0),
    };
  }

  async activeTopics(spaceId: string, userId: string): Promise<Array<{ id: string; topic_key: string; aliases: string[]; weight: number }>> {
    const result = await this.db.query<{ id: string; topic_key: string; aliases_json: unknown; weight: number }>(
      `SELECT t.id, t.topic_key, t.aliases_json, t.weight
         FROM interest_topics t
        WHERE t.space_id = $1 AND t.user_id = $2 AND t.status = 'active'`,
      [spaceId, userId],
    );
    return result.rows.map((row) => ({ ...row, aliases: stringArray(row.aliases_json) }));
  }

  async replace(input: {
    spaceId: string;
    type: "personal" | "project";
    ownerUserId?: string;
    projectId?: string;
    date: string;
    maturity: "cold" | "warming" | "warm" | null;
    runId?: string | null;
    settings: Record<string, unknown>;
    items: Array<{
      candidate: DigestCandidate;
      section: "interest" | "serendipity";
      position: number;
      quotaSlot: string;
      matchedTopicId: string | null;
      serendipityPoolItemId?: string | null;
      score: number;
      componentScores: Record<string, number>;
      rationale: string;
    }>;
  }): Promise<string> {
    const scopeKey = input.type === "personal" ? input.ownerUserId! : input.projectId!;
    await this.lockScope(input.spaceId, input.type, scopeKey, input.date);
    const existing = await this.db.query<{ id: string }>(
      `SELECT id FROM information_digests
        WHERE space_id = $1 AND digest_type = $2 AND digest_date = $3
          AND (($2 = 'personal' AND owner_user_id = $4) OR ($2 = 'project' AND project_id = $4))`,
      [input.spaceId, input.type, input.date, scopeKey],
    );
    const digestId = existing.rows[0]?.id ?? randomUUID();
    const now = new Date().toISOString();
    await this.db.query(
      `INSERT INTO information_digests
         (id, space_id, digest_type, owner_user_id, project_id, digest_date,
          profile_maturity, status, generated_by_run_id, settings_json, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,$11)
       ON CONFLICT (id) DO UPDATE SET
         profile_maturity = EXCLUDED.profile_maturity,
         status = EXCLUDED.status,
         generated_by_run_id = COALESCE(EXCLUDED.generated_by_run_id, information_digests.generated_by_run_id),
         settings_json = EXCLUDED.settings_json, updated_at = EXCLUDED.updated_at`,
      [digestId, input.spaceId, input.type, input.ownerUserId ?? null, input.projectId ?? null,
        input.date, input.maturity, input.items.length ? "ready" : "empty", input.runId ?? null,
        JSON.stringify(input.settings), now],
    );
    await this.db.query(`DELETE FROM information_digest_items WHERE digest_id = $1`, [digestId]);
    for (const item of input.items) {
      await this.db.query(
        `INSERT INTO information_digest_items
           (id, space_id, digest_id, source_item_id, section, position, quota_slot,
            matched_topic_id, serendipity_pool_item_id, score, component_scores_json, rationale, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12,$13)`,
        [randomUUID(), input.spaceId, digestId, item.candidate.source_item_id, item.section,
          item.position, item.quotaSlot, item.matchedTopicId, item.serendipityPoolItemId ?? null, item.score,
          JSON.stringify(item.componentScores), item.rationale, now],
      );
    }
    return digestId;
  }

  async lockScope(spaceId: string, type: "personal" | "project", scopeId: string, date: string): Promise<void> {
    await this.db.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [
      `information-digest:${spaceId}:${type}:${scopeId}:${date}`,
    ]);
  }

  async get(spaceId: string, digestId: string, readerUserId: string): Promise<PersistedDigest | null> {
    const roots = await this.db.query<Omit<PersistedDigest, "items" | "settings"> & { settings_json: unknown }>(
      `SELECT id, digest_type, owner_user_id, project_id, digest_date, profile_maturity,
              status, generated_by_run_id, settings_json, created_at, updated_at
         FROM information_digests WHERE space_id = $1 AND id = $2`,
      [spaceId, digestId],
    );
    const root = roots.rows[0];
    if (!root) return null;
    const items = await this.db.query<Omit<PersistedDigestItem, "topic_candidates" | "component_scores"> & {
      topic_candidates_json: unknown;
      component_scores_json: unknown;
      effective_access_level: "full" | "summary";
    }>(
      `SELECT di.id, di.section, di.position, di.quota_slot, di.matched_topic_id,
              di.score, di.component_scores_json, di.rationale, di.serendipity_pool_item_id,
              sp.target_domain_key, sp.discovery_origin,
              i.id AS source_item_id, i.connection_id, i.title, i.source_uri,
              i.source_domain, i.author, i.excerpt, i.occurred_at, i.first_seen_at,
              a.domain_key, a.depth, a.genre, a.summary, a.topic_candidates_json,
              a.stance_target, a.stance_target_key, a.stance_polarity, a.stance_confidence,
              NULL::varchar AS project_relevance, NULL::double precision AS project_confidence,
              ${contentAccessLevelSql({ definition: SOURCE_ITEM_ACCESS, alias: "i", userExpr: "$3" })} AS effective_access_level,
              COALESCE(us.read_status, 'unread') AS read_status,
              feedback.feedback AS serendipity_feedback,
              team_read.anonymous_read_count
         FROM information_digest_items di
         JOIN source_items i ON i.id = di.source_item_id AND i.space_id = di.space_id
         JOIN source_item_annotations a ON a.source_item_id = i.id AND a.space_id = i.space_id
         LEFT JOIN information_digest_serendipity_pool sp ON sp.id=di.serendipity_pool_item_id
         LEFT JOIN information_digest_serendipity_feedback feedback
           ON feedback.digest_item_id=di.id AND feedback.user_id=$3
         LEFT JOIN source_item_user_states us
           ON us.source_item_id = i.id AND us.space_id = i.space_id AND us.user_id = $3
         LEFT JOIN LATERAL (
           SELECT CASE WHEN COUNT(DISTINCT member_state.user_id) >= 3
                       THEN COUNT(DISTINCT member_state.user_id)::integer ELSE NULL END AS anonymous_read_count
             FROM project_members member
             JOIN source_item_user_states member_state
               ON member_state.space_id=member.space_id AND member_state.user_id=member.user_id
              AND member_state.source_item_id=i.id AND member_state.read_status <> 'unread'
            WHERE member.space_id=di.space_id AND member.project_id=$4 AND member.status='active'
         ) team_read ON $4::varchar IS NOT NULL
        WHERE di.space_id = $1 AND di.digest_id = $2 AND i.deleted_at IS NULL
          AND ${sourceItemReadableClause("i", "$3", false)}
          AND ($5::boolean = false OR ${contentAccessLevelSql({
            definition: SOURCE_ITEM_ACCESS,
            alias: "i",
            userExpr: "$3",
          })} = 'full')
        ORDER BY di.position`,
      [spaceId, digestId, readerUserId, root.project_id, root.digest_type === "project"],
    );
    const teamInsights = root.project_id
      ? await this.projectTeamInsights(spaceId, root.project_id, readerUserId)
      : { available: false, blindSpots: [] as string[] };
    return {
      ...root,
      settings: recordValue(root.settings_json),
      team_aggregates_available: teamInsights.available,
      team_blind_spot_domains: teamInsights.blindSpots,
      items: items.rows.map(hydratePersistedItem),
    };
  }

  private async projectTeamInsights(spaceId: string, projectId: string, readerUserId: string): Promise<{ available: boolean; blindSpots: string[] }> {
    const cohort = await this.db.query<{ count: string }>(
      `SELECT COUNT(DISTINCT user_id)::text AS count FROM project_members
        WHERE space_id=$1 AND project_id=$2 AND status='active'`,
      [spaceId, projectId],
    );
    if (Number(cohort.rows[0]?.count ?? 0) < 3) return { available: false, blindSpots: [] };
    const result = await this.db.query<{ domain_key: string }>(
      `SELECT DISTINCT annotation.domain_key
         FROM project_corpus_items corpus
         LEFT JOIN project_corpus_item_sources bridge
           ON bridge.corpus_item_id=corpus.id AND bridge.space_id=corpus.space_id
         JOIN source_item_annotations annotation
           ON annotation.space_id=corpus.space_id
          AND annotation.source_item_id=COALESCE(corpus.source_item_id,bridge.source_item_id)
          AND annotation.status='succeeded'
         JOIN source_items source_item
           ON source_item.space_id=annotation.space_id AND source_item.id=annotation.source_item_id
          AND source_item.deleted_at IS NULL
        WHERE corpus.space_id=$1 AND corpus.project_id=$2 AND corpus.status='active'
          AND ${sourceItemReadableClause("source_item", "$3", false)}
          AND ${contentAccessLevelSql({ definition: SOURCE_ITEM_ACCESS, alias: "source_item", userExpr: "$3" })} = 'full'
          AND NOT EXISTS (
            SELECT 1 FROM project_members member
            JOIN source_item_user_states state
              ON state.space_id=member.space_id AND state.user_id=member.user_id
             AND state.source_item_id=annotation.source_item_id AND state.read_status <> 'unread'
            WHERE member.space_id=$1 AND member.project_id=$2 AND member.status='active'
          )
        ORDER BY annotation.domain_key`,
      [spaceId, projectId, readerUserId],
    );
    return { available: true, blindSpots: result.rows.map((row) => row.domain_key) };
  }

  async findByScope(spaceId: string, type: "personal" | "project", scopeId: string, date: string): Promise<{ id: string; generated_by_run_id: string | null } | null> {
    const result = await this.db.query<{ id: string; generated_by_run_id: string | null }>(
      `SELECT id, generated_by_run_id FROM information_digests
        WHERE space_id = $1 AND digest_type = $2 AND digest_date = $4
          AND (($2 = 'personal' AND owner_user_id = $3) OR ($2 = 'project' AND project_id = $3))`,
      [spaceId, type, scopeId, date],
    );
    return result.rows[0] ?? null;
  }
}

function hydrateCandidate(row: DigestCandidateRow): DigestCandidate {
  const { topic_candidates_json, effective_access_level, ...candidate } = row;
  return {
    ...candidate,
    source_uri: effective_access_level === "summary" ? null : candidate.source_uri,
    excerpt: effective_access_level === "summary" ? null : candidate.excerpt,
    topic_candidates: stringArray(topic_candidates_json),
  };
}

function hydratePersistedItem(
  row: Omit<PersistedDigestItem, "topic_candidates" | "component_scores"> & {
    topic_candidates_json: unknown;
    component_scores_json: unknown;
    effective_access_level: "full" | "summary";
  },
): PersistedDigestItem {
  const { topic_candidates_json, component_scores_json, effective_access_level, ...item } = row;
  return {
    ...item,
    source_uri: effective_access_level === "summary" ? null : item.source_uri,
    excerpt: effective_access_level === "summary" ? null : item.excerpt,
    topic_candidates: stringArray(topic_candidates_json),
    component_scores: numberRecord(component_scores_json),
  };
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function recordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function numberRecord(value: unknown): Record<string, number> {
  return Object.fromEntries(Object.entries(recordValue(value)).filter((entry): entry is [string, number] => typeof entry[1] === "number"));
}
