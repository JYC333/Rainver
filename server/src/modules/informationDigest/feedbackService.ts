import { randomUUID } from "node:crypto";
import { lockSourceRetrievalRelease } from '../sources/retrievalReleaseLocks.js';
import { canonical } from '../systemActions/operations/repository.js';
import { HttpError, type Queryable, withQueryableTransaction } from "../routeUtils/common.js";
import { InterestProfileService } from "../interestProfile/service.js";
import { DEFAULT_INTEREST_PROFILE_SETTINGS } from "../interestProfile/settings.js";

export type SerendipityFeedback = "interesting" | "neutral" | "never";

export const INTERESTING_COOLDOWN_DAYS = DEFAULT_INTEREST_PROFILE_SETTINGS.interesting_cooldown_days;
export const NEUTRAL_COOLDOWN_DAYS = DEFAULT_INTEREST_PROFILE_SETTINGS.neutral_cooldown_days;

interface SerendipityFeedbackResult {
  digest_item_id: string;
  domain_key: string;
  feedback: SerendipityFeedback;
  cooldown_until: string | null;
  blocked: boolean;
  created_at: string;
}

/** Explicit feedback updates only the independent rotation/blocklist state. */
export class SerendipityFeedbackService {
  constructor(private readonly db: Queryable) {}

  /** Authority-free discovery of all recommendation effects precedes the
   * shared Project/person/Space/Source lock order. No retained Source text is
   * read or released by this owner-private feedback operation. */
  private async authorize(spaceId:string,userId:string,digestItemId:string) {
    const discover=async()=> {
      const item=(await this.db.query<{domain_key:string;source_item_id:string|null}>(
        `SELECT p.target_domain_key AS domain_key,i.source_item_id
         FROM information_digest_items i JOIN information_digests d ON d.id=i.digest_id AND d.space_id=i.space_id
         JOIN information_digest_serendipity_pool p ON p.id=i.serendipity_pool_item_id AND p.space_id=i.space_id
         WHERE i.space_id=$1 AND i.id=$2 AND i.section='serendipity'
           AND d.digest_type='personal' AND d.owner_user_id=$3`,[spaceId,digestItemId,userId])).rows[0];
      if(!item)throw new HttpError(404,'Personal serendipity item not found');
      const pools=(await this.db.query<{id:string;source_item_id:string;source_connection_id:string|null}>(
        `SELECT p.id,p.source_item_id,c.source_connection_id FROM information_digest_serendipity_pool p
         LEFT JOIN source_channels c ON c.space_id=p.space_id AND c.id=p.source_channel_id
         WHERE p.space_id=$1 AND p.user_id=$2 AND p.target_domain_key=$3 ORDER BY p.id`,[spaceId,userId,item.domain_key])).rows;
      const activities=(await this.db.query<{id:string}>(
        `SELECT a.id FROM activity_records a WHERE a.space_id=$1 AND a.user_id=$2 AND EXISTS(
         SELECT 1 FROM information_digest_serendipity_pool p WHERE p.space_id=$1 AND p.user_id=$2 AND p.target_domain_key=$3
         AND p.source_channel_id IS NOT NULL AND a.aggregate_key='source:recommendation:' || $2 || ':' || p.source_channel_id) ORDER BY a.id`,[spaceId,userId,item.domain_key])).rows;
      return {item,pools,activities};
    };
    const before=await discover();
    const effects=[
      ...[...new Set(before.pools.flatMap(p=>p.source_connection_id?[p.source_connection_id]:[]))].map(id=>({object_type:'source_connection' as const,object_id:id})),
      ...before.activities.map(a=>({object_type:'activity' as const,object_id:a.id})),
    ];
    await lockSourceRetrievalRelease(this.db,spaceId,userId,[
      ...[...new Set([before.item.source_item_id,...before.pools.map(p=>p.source_item_id)].filter((id):id is string=>Boolean(id)))].map(id=>({object_type:'source_item' as const,object_id:id})),
      ...effects,
    ],[],undefined,[],[],effects);
    if(before.pools.length)await this.db.query('SELECT id FROM information_digest_serendipity_pool WHERE space_id=$1 AND id=ANY($2::varchar[]) ORDER BY id FOR SHARE',[spaceId,before.pools.map(p=>p.id)]);
    if(canonical(before)!==canonical(await discover()))throw new HttpError(409,'Serendipity recommendation references changed; reload before updating');
    return before;
  }

  async record(
    spaceId: string,
    userId: string,
    digestItemId: string,
    feedback: SerendipityFeedback,
    at = new Date(),
  ): Promise<SerendipityFeedbackResult> {
    return withQueryableTransaction(this.db, async (tx) => {
      const closure=await new SerendipityFeedbackService(tx).authorize(spaceId,userId,digestItemId);
      await tx.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [
        `information-digest-feedback:${spaceId}:${digestItemId}`,
      ]);
      const eligible = await tx.query<{ domain_key: string; feedback: SerendipityFeedback | null; created_at: string | Date | null }>(
        `SELECT pool.target_domain_key AS domain_key, existing.feedback, existing.created_at
           FROM information_digest_items item
           JOIN information_digests digest
             ON digest.id=item.digest_id AND digest.space_id=item.space_id
           JOIN information_digest_serendipity_pool pool
             ON pool.id=item.serendipity_pool_item_id AND pool.space_id=item.space_id
           LEFT JOIN information_digest_serendipity_feedback existing
             ON existing.digest_item_id=item.id
          WHERE item.id=$1 AND item.space_id=$2 AND item.section='serendipity'
            AND digest.digest_type='personal' AND digest.owner_user_id=$3`,
        [digestItemId, spaceId, userId],
      );
      const item = eligible.rows[0];
      if (!item) throw new HttpError(404, "Personal serendipity item not found");
      if (item.feedback && item.created_at) {
        return this.result(tx, spaceId, userId, digestItemId, item.domain_key, item.feedback, timestampIso(item.created_at)!);
      }
      // The block and the cooldown live per domain, and one digest may hold
      // two items of one domain. Do not update them without the lock. A "never" on one and an
      // "interesting" on the other, concurrently, would let the second write
      // the block back to null after answering the first as blocked.
      await tx.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [
        `information-digest-feedback-domain:${spaceId}:${userId}:${item.domain_key}`,
      ]);

      const state = await tx.query<{ blocked_at: string | null }>(
        `SELECT blocked_at FROM information_digest_serendipity_domain_states
          WHERE space_id=$1 AND user_id=$2 AND domain_key=$3`,
        [spaceId, userId, item.domain_key],
      );
      if (state.rows[0]?.blocked_at && feedback !== "never") {
        throw new HttpError(409, "This serendipity direction is already permanently blocked");
      }

      const now = at.toISOString();
      const settings = await new InterestProfileService(tx).settings(spaceId, userId);
      const cooldownUntil = feedback === "never"
        ? null
        : new Date(at.getTime() + (feedback === "interesting" ? settings.interesting_cooldown_days : settings.neutral_cooldown_days) * 86_400_000).toISOString();
      await tx.query(
        `INSERT INTO information_digest_serendipity_feedback
           (id,space_id,user_id,digest_item_id,domain_key,feedback,created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [randomUUID(), spaceId, userId, digestItemId, item.domain_key, feedback, now],
      );
      await tx.query(
        `INSERT INTO information_digest_serendipity_domain_states
           (id,space_id,user_id,domain_key,last_feedback,cooldown_until,blocked_at,created_at,updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$8)
         ON CONFLICT (space_id,user_id,domain_key) DO UPDATE SET
           last_feedback=EXCLUDED.last_feedback,
           cooldown_until=EXCLUDED.cooldown_until,
           blocked_at=EXCLUDED.blocked_at,
           updated_at=EXCLUDED.updated_at`,
        [randomUUID(), spaceId, userId, item.domain_key, feedback, cooldownUntil,
          feedback === "never" ? now : null, now],
      );
      if (feedback === "never") {
        // The blocklist also closes still-pending system recommendations for
        // this exact direction. It never changes an accepted subscription.
        await tx.query(
          `UPDATE source_channel_user_subscriptions sub
              SET status='dismissed', updated_at=$4
             FROM information_digest_serendipity_pool pool
            WHERE sub.space_id=$1 AND sub.user_id=$2 AND sub.status='pending'
              AND pool.space_id=sub.space_id AND pool.user_id=sub.user_id
              AND pool.source_channel_id=sub.source_channel_id AND pool.target_domain_key=$3
              AND pool.id=ANY($5::varchar[])`,
          [spaceId, userId, item.domain_key, now, closure.pools.map(p=>p.id)],
        );
        await tx.query(
          `UPDATE activity_records activity
              SET status='archived', updated_at=$4
            WHERE activity.space_id=$1 AND activity.user_id=$2 AND activity.status <> 'archived'
              AND EXISTS (
                SELECT 1 FROM information_digest_serendipity_pool pool
                 WHERE pool.space_id=$1 AND pool.user_id=$2 AND pool.target_domain_key=$3
                   AND pool.source_channel_id IS NOT NULL
                   AND activity.aggregate_key='source:recommendation:' || $2 || ':' || pool.source_channel_id
              ) AND activity.id=ANY($5::varchar[])`,
          [spaceId, userId, item.domain_key, now, closure.activities.map(a=>a.id)],
        );
      }
      return { digest_item_id: digestItemId, domain_key: item.domain_key, feedback,
        cooldown_until: cooldownUntil, blocked: feedback === "never", created_at: now };
    });
  }

  private async result(
    db: Queryable,
    spaceId: string,
    userId: string,
    digestItemId: string,
    domainKey: string,
    feedback: SerendipityFeedback,
    createdAt: string,
  ): Promise<SerendipityFeedbackResult> {
    const state = await db.query<{ cooldown_until: string | Date | null; blocked_at: string | Date | null }>(
      `SELECT cooldown_until, blocked_at FROM information_digest_serendipity_domain_states
        WHERE space_id=$1 AND user_id=$2 AND domain_key=$3`,
      [spaceId, userId, domainKey],
    );
    return { digest_item_id: digestItemId, domain_key: domainKey, feedback,
      cooldown_until: timestampIso(state.rows[0]?.cooldown_until),
      blocked: Boolean(state.rows[0]?.blocked_at), created_at: createdAt };
  }
}

function timestampIso(value: string | Date | null | undefined): string | null {
  if (!value) return null;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}
