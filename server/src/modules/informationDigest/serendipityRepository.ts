import { randomUUID } from "node:crypto";
import type { Queryable } from "../routeUtils/common.js";
import type { DigestCandidate } from "./repository.js";

export interface StandbyCandidate extends DigestCandidate {
  pool_id: string;
  target_domain_key: string;
  discovery_origin: "weekly_probe" | "source_recommendation";
  source_channel_id: string | null;
  last_surfaced_at: string | null;
}

export interface ReadingShape {
  coveredDomains: string[];
  depthCounts: Record<string, number>;
  genreCounts: Record<string, number>;
  stanceByTarget: Record<string, "supports" | "opposes">;
}

export class PgSerendipityRepository {
  constructor(private readonly db: Queryable) {}

  async readingShape(spaceId: string, userId: string): Promise<ReadingShape> {
    const result = await this.db.query<{ domain_key: string; depth: string; genre: string; stance_target_key: string | null; stance_polarity: string; stance_confidence: number; count: string }>(
      `SELECT a.domain_key, a.depth, a.genre, a.stance_target_key, a.stance_polarity, a.stance_confidence, COUNT(*)::text AS count
         FROM source_item_annotations a
         JOIN source_item_user_states s
           ON s.space_id=a.space_id AND s.source_item_id=a.source_item_id
        WHERE a.space_id=$1 AND s.user_id=$2 AND a.status='succeeded' AND s.read_status <> 'unread'
        GROUP BY a.domain_key, a.depth, a.genre, a.stance_target_key, a.stance_polarity, a.stance_confidence`,
      [spaceId, userId],
    );
    const coveredDomains = [...new Set(result.rows.map((row) => row.domain_key))];
    const depthCounts: Record<string, number> = {};
    const genreCounts: Record<string, number> = {};
    const stanceCounts = new Map<string, { supports: number; opposes: number }>();
    for (const row of result.rows) {
      depthCounts[row.depth] = (depthCounts[row.depth] ?? 0) + Number(row.count);
      genreCounts[row.genre] = (genreCounts[row.genre] ?? 0) + Number(row.count);
      if (row.stance_confidence >= 60 && row.stance_target_key && (row.stance_polarity === "supports" || row.stance_polarity === "opposes")) {
        const counts = stanceCounts.get(row.stance_target_key) ?? { supports: 0, opposes: 0 };
        counts[row.stance_polarity] += Number(row.count);
        stanceCounts.set(row.stance_target_key, counts);
      }
    }
    const stanceByTarget: Record<string, "supports" | "opposes"> = {};
    for (const [target, counts] of stanceCounts) {
      if (counts.supports !== counts.opposes) stanceByTarget[target] = counts.supports > counts.opposes ? "supports" : "opposes";
    }
    return { coveredDomains, depthCounts, genreCounts, stanceByTarget };
  }

  async listStandby(spaceId: string, userId: string, at: string): Promise<StandbyCandidate[]> {
    const result = await this.db.query<Omit<StandbyCandidate, "topic_candidates"> & { topic_candidates_json: unknown }>(
      `SELECT p.id AS pool_id, p.target_domain_key, p.discovery_origin, p.source_channel_id,
              i.id AS source_item_id, i.connection_id, i.title, i.source_uri, i.source_domain,
              i.author, i.excerpt, i.occurred_at, i.first_seen_at,
              a.domain_key, a.depth, a.genre, a.summary, a.topic_candidates_json,
              a.stance_target, a.stance_target_key, a.stance_polarity, a.stance_confidence,
              NULL::varchar AS project_relevance, NULL::double precision AS project_confidence,
              (SELECT MAX(d.created_at)
                 FROM information_digest_items di
                 JOIN information_digests d ON d.id=di.digest_id
                 JOIN information_digest_serendipity_pool prior ON prior.id=di.serendipity_pool_item_id
                WHERE d.space_id=p.space_id AND d.owner_user_id=p.user_id
                  AND prior.target_domain_key=p.target_domain_key) AS last_surfaced_at
         FROM information_digest_serendipity_pool p
         JOIN source_items i ON i.id=p.source_item_id AND i.space_id=p.space_id AND i.deleted_at IS NULL
         JOIN source_item_annotations a
           ON a.source_item_id=i.id AND a.space_id=i.space_id AND a.status='succeeded'
         LEFT JOIN information_digest_serendipity_domain_states control
           ON control.space_id=p.space_id AND control.user_id=p.user_id
          AND control.domain_key=p.target_domain_key
        WHERE p.space_id=$1 AND p.user_id=$2 AND p.status='standby' AND p.available_until > $3
          AND p.discovered_at <= $3
          AND control.blocked_at IS NULL
          AND (control.cooldown_until IS NULL OR control.cooldown_until <= $3)
          AND a.domain_key=p.target_domain_key
          AND NOT EXISTS (
            SELECT 1
              FROM source_channel_item_links linked
              JOIN source_channel_user_subscriptions sub
                ON sub.space_id=linked.space_id AND sub.source_channel_id=linked.source_channel_id
             WHERE linked.space_id=p.space_id AND linked.source_item_id=p.source_item_id
               AND linked.status='active' AND sub.user_id=p.user_id AND sub.status='subscribed'
          )
        ORDER BY p.discovered_at ASC, p.id ASC`,
      [spaceId, userId, at],
    );
    return result.rows.map((row) => ({
      ...row,
      topic_candidates: Array.isArray(row.topic_candidates_json)
        ? row.topic_candidates_json.filter((value): value is string => typeof value === "string")
        : [],
    }));
  }

  async blockedDomainKeys(spaceId: string, userId: string): Promise<string[]> {
    const result = await this.db.query<{ domain_key: string }>(
      `SELECT domain_key FROM information_digest_serendipity_domain_states
        WHERE space_id=$1 AND user_id=$2 AND blocked_at IS NOT NULL
        ORDER BY domain_key`,
      [spaceId, userId],
    );
    return result.rows.map((row) => row.domain_key);
  }

  async probeExcludedDomainKeys(spaceId: string, userId: string, at: string): Promise<string[]> {
    const result = await this.db.query<{ domain_key: string }>(
      `SELECT domain_key FROM information_digest_serendipity_domain_states
        WHERE space_id=$1 AND user_id=$2
          AND (blocked_at IS NOT NULL OR cooldown_until > $3)
        ORDER BY domain_key`,
      [spaceId, userId, at],
    );
    return result.rows.map((row) => row.domain_key);
  }

  async addPoolItem(input: {
    spaceId: string;
    userId: string;
    sourceItemId: string;
    sourceChannelId?: string | null;
    targetDomainKey: string;
    origin: "weekly_probe" | "source_recommendation";
    probePeriod?: string | null;
    metadata?: Record<string, unknown>;
    availableDays?: number;
  }): Promise<boolean> {
    const now = new Date().toISOString();
    const until = new Date(Date.now() + (input.availableDays ?? 21) * 86_400_000).toISOString();
    const result = await this.db.query(
      `INSERT INTO information_digest_serendipity_pool
         (id,space_id,user_id,source_item_id,source_channel_id,target_domain_key,
          discovery_origin,status,probe_period,metadata_json,discovered_at,available_until)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'standby',$8,$9::jsonb,$10,$11)
       ON CONFLICT (space_id,user_id,source_item_id) DO NOTHING`,
      [randomUUID(), input.spaceId, input.userId, input.sourceItemId, input.sourceChannelId ?? null,
        input.targetDomainKey, input.origin, input.probePeriod ?? null,
        JSON.stringify(input.metadata ?? {}), now, until],
    );
    return (result.rowCount ?? 0) > 0;
  }

  async markConsumed(poolIds: readonly string[], consumedAt: string): Promise<void> {
    if (poolIds.length === 0) return;
    await this.db.query(
      `UPDATE information_digest_serendipity_pool
          SET status='consumed', consumed_at=$2
        WHERE id=ANY($1::varchar[]) AND status='standby'`,
      [poolIds, consumedAt],
    );
  }

  async recommendExistingSources(spaceId: string, userId: string, domainKeys: readonly string[], period: string, limit = 3): Promise<number> {
    if (domainKeys.length === 0) return 0;
    const result = await this.db.query<{
      source_channel_id: string;
      source_item_id: string;
      domain_key: string;
      channel_name: string;
    }>(
      `SELECT DISTINCT ON (a.domain_key)
              c.id AS source_channel_id, i.id AS source_item_id, a.domain_key, c.name AS channel_name
         FROM source_channels c
         JOIN source_connections conn
           ON conn.id=c.source_connection_id AND conn.space_id=c.space_id
          AND conn.status='active' AND conn.deleted_at IS NULL AND conn.visibility='space_shared'
         JOIN source_channel_item_links l ON l.source_channel_id=c.id AND l.space_id=c.space_id AND l.status='active'
         JOIN source_items i ON i.id=l.source_item_id AND i.space_id=l.space_id AND i.deleted_at IS NULL AND i.visibility='space_shared'
         JOIN source_item_annotations a ON a.source_item_id=i.id AND a.space_id=i.space_id AND a.status='succeeded'
        WHERE c.space_id=$1 AND c.status='active' AND a.domain_key=ANY($3::varchar[])
          AND NOT EXISTS (
            SELECT 1 FROM source_channel_user_subscriptions own
             WHERE own.space_id=c.space_id AND own.source_channel_id=c.id AND own.user_id=$2
          )
        ORDER BY a.domain_key, COALESCE(i.occurred_at,i.first_seen_at) DESC, i.id`,
      [spaceId, userId, domainKeys],
    );
    let added = 0;
    for (const row of result.rows.slice(0, limit)) {
      const now = new Date().toISOString();
      await this.db.query(
        `INSERT INTO source_channel_user_subscriptions
           (id,space_id,source_channel_id,user_id,status,library_enabled,digest_enabled,
            recommended_by_user_id,recommendation_message,created_at,updated_at)
         VALUES ($1,$2,$3,$4,'pending',true,true,NULL,$5,$6,$6)
         ON CONFLICT (space_id,source_channel_id,user_id) DO NOTHING`,
        [randomUUID(), spaceId, row.source_channel_id, userId,
          `Recommended to broaden coverage into ${row.domain_key}.`, now],
      );
      const subscription = await this.db.query<{ status: string }>(
        `SELECT status FROM source_channel_user_subscriptions
          WHERE space_id=$1 AND source_channel_id=$2 AND user_id=$3`,
        [spaceId, row.source_channel_id, userId],
      );
      if (subscription.rows[0]?.status !== "pending") continue;
      if (await this.addPoolItem({
        spaceId, userId, sourceItemId: row.source_item_id, sourceChannelId: row.source_channel_id,
        targetDomainKey: row.domain_key, origin: "source_recommendation", probePeriod: period,
        metadata: { channel_name: row.channel_name },
      })) added += 1;
      await this.upsertRecommendationActivity(spaceId, userId, row, now);
    }
    return added;
  }

  async startProbe(spaceId: string, userId: string, period: string, domainKeys: readonly string[]): Promise<string | null> {
    const id = randomUUID();
    const result = await this.db.query(
      `INSERT INTO information_digest_probe_runs
         (id,space_id,user_id,period_start,status,domain_keys_json,request_count,result_count,started_at)
       VALUES ($1,$2,$3,$4,'running',$5::jsonb,0,0,$6)
       ON CONFLICT (space_id,user_id,period_start) DO NOTHING`,
      [id, spaceId, userId, period, JSON.stringify(domainKeys), new Date().toISOString()],
    );
    return (result.rowCount ?? 0) > 0 ? id : null;
  }

  async finishProbe(id: string, input: { status: "succeeded" | "degraded" | "failed" | "skipped"; requests: number; results: number; error?: unknown }): Promise<void> {
    await this.db.query(
      `UPDATE information_digest_probe_runs
          SET status=$2, request_count=$3, result_count=$4, error_json=$5::jsonb, completed_at=$6
        WHERE id=$1`,
      [id, input.status, input.requests, input.results,
        input.error === undefined ? null : JSON.stringify({ message: input.error instanceof Error ? input.error.message : String(input.error) }),
        new Date().toISOString()],
    );
  }

  private async upsertRecommendationActivity(
    spaceId: string,
    userId: string,
    row: { source_channel_id: string; domain_key: string; channel_name: string },
    now: string,
  ): Promise<void> {
    const aggregateKey = `source:recommendation:${userId}:${row.source_channel_id}`;
    await this.db.query(
      `INSERT INTO activity_records
         (id,space_id,user_id,source_url,activity_type,title,content,payload_json,
          occurred_at,created_at,status,updated_at,source_kind,source_trust,visibility,
          access_level,owner_user_id,aggregate_key)
       VALUES ($1,$2,$3,NULL,'source',$4,$5,$6::jsonb,$7,$7,'raw',$7,'source',
               'internal_system','private','full',$3,$8)
       ON CONFLICT (space_id,aggregate_key) WHERE aggregate_key IS NOT NULL
       DO UPDATE SET content=EXCLUDED.content,payload_json=EXCLUDED.payload_json,
                     status='raw',processed_at=NULL,discarded_at=NULL,updated_at=EXCLUDED.updated_at`,
      [randomUUID(), spaceId, userId, `Source recommendation: ${row.channel_name}`,
        `A source covering ${row.domain_key} is ready for review.`,
        JSON.stringify({ source_channel_id: row.source_channel_id, domain_key: row.domain_key, path: "/sources" }),
        now, aggregateKey],
    );
  }
}
