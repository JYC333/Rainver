import { randomUUID } from "node:crypto";
import { HttpError, type Queryable, withQueryableTransaction } from "../routeUtils/common";
import { InterestProfileService } from "../interestProfile/service";
import { DEFAULT_INTEREST_PROFILE_SETTINGS } from "../interestProfile/settings";

export type SerendipityFeedback = "interesting" | "neutral" | "never";

export const INTERESTING_COOLDOWN_DAYS = DEFAULT_INTEREST_PROFILE_SETTINGS.interesting_cooldown_days;
export const NEUTRAL_COOLDOWN_DAYS = DEFAULT_INTEREST_PROFILE_SETTINGS.neutral_cooldown_days;

export interface SerendipityFeedbackResult {
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

  async record(
    spaceId: string,
    userId: string,
    digestItemId: string,
    feedback: SerendipityFeedback,
    at = new Date(),
  ): Promise<SerendipityFeedbackResult> {
    return withQueryableTransaction(this.db, async (tx) => {
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
              AND pool.source_channel_id=sub.source_channel_id AND pool.target_domain_key=$3`,
          [spaceId, userId, item.domain_key, now],
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
              )`,
          [spaceId, userId, item.domain_key, now],
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
