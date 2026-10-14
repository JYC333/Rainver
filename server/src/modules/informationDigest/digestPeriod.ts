import type { Queryable } from "../routeUtils/common.js";
import {
  isLocalDayComplete,
  isValidTimezone,
  localDateNow,
  localDayUtcBounds,
  previousLocalDate,
  reportDateForSlot,
} from "../scheduler/localDay.js";
import type { DigestPeriod } from "./repository.js";

/**
 * Which calendar day a digest covers, and in which timezone.
 *
 * A digest covers one complete local day of its scope's configured timezone —
 * the `timezone` of the scope's daily digest Automation, `UTC` until someone
 * sets another. The scheduled fire reports on the day before its slot's own
 * local day, so a fire delayed past midnight still reports the day it was
 * scheduled for. The browser's locale and timezone never take part.
 */
export async function digestTimezone(
  db: Queryable,
  spaceId: string,
  scope: { type: "personal"; userId: string } | { type: "project"; projectId: string },
): Promise<string> {
  const result = await db.query<{ timezone: string | null }>(
    `SELECT config_json->>'timezone' AS timezone
       FROM automations
      WHERE space_id = $1 AND status <> 'archived'
        AND config_json->>'target_type' = 'information_digest'
        AND COALESCE(config_json->>'operation', 'daily') = 'daily'
        AND config_json->>'scope' = $2
        AND (($2 = 'personal' AND owner_user_id = $3) OR ($2 = 'project' AND project_id = $3))
      ORDER BY created_at ASC
      LIMIT 1`,
    [spaceId, scope.type, scope.type === "personal" ? scope.userId : scope.projectId],
  );
  const configured = result.rows[0]?.timezone;
  return configured && isValidTimezone(configured) ? configured : "UTC";
}

export function digestPeriod(date: string, timezone: string): DigestPeriod {
  const bounds = localDayUtcBounds(date, timezone);
  return { date, timezone, startUtc: bounds.startUtcIso, endUtc: bounds.endUtcIso };
}

/** The day a scheduled fire at `slotUtcIso` reports on. */
export function scheduledDigestDate(slotUtcIso: string, timezone: string): string {
  return reportDateForSlot(slotUtcIso, timezone);
}

/** The most recent complete local day: what a reader sees when no day is named. */
export function latestCompleteDigestDate(timezone: string, now: Date = new Date()): string {
  return previousLocalDate(localDateNow(timezone, now));
}

export function isCompleteDigestDay(date: string, timezone: string, now: Date = new Date()): boolean {
  return isLocalDayComplete(date, timezone, now);
}
