import { randomUUID } from "node:crypto";
import type { Queryable } from "../../routeUtils/common.js";

interface SubscriptionRef {
  spaceId: string;
  channelId: string;
  userId: string;
  at: string;
}

/**
 * Opens the period in which this person receives the channel's items. Every
 * transition into `subscribed` calls it, in the transaction that makes it;
 * an already open period is kept, never restarted.
 */
export async function openSubscriptionWindow(db: Queryable, ref: SubscriptionRef): Promise<void> {
  await db.query(
    `INSERT INTO source_channel_subscription_windows (id, space_id, source_channel_id, user_id, subscribed_at)
     VALUES ($1, $2, $3, $4, $5::timestamptz)
     ON CONFLICT (space_id, source_channel_id, user_id) WHERE unsubscribed_at IS NULL DO NOTHING`,
    [randomUUID(), ref.spaceId, ref.channelId, ref.userId, ref.at],
  );
}

/**
 * Closes the open period when the person leaves `subscribed`. Items first
 * seen inside it stay readable to them (historical reading eligibility).
 */
export async function closeSubscriptionWindow(db: Queryable, ref: SubscriptionRef): Promise<void> {
  await db.query(
    `UPDATE source_channel_subscription_windows
        SET unsubscribed_at = $4::timestamptz
      WHERE space_id = $1 AND source_channel_id = $2 AND user_id = $3 AND unsubscribed_at IS NULL`,
    [ref.spaceId, ref.channelId, ref.userId, ref.at],
  );
}
