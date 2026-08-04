import type { Queryable } from "../routeUtils/common";

export const PROJECT_RESEARCH_MONITORING_OVERLAP_HOURS = 48;

export function publicationWindowStart(
  watermark: string | null,
  overlapHours = PROJECT_RESEARCH_MONITORING_OVERLAP_HOURS,
): string | null {
  if (!watermark) return null;
  const parsed = Date.parse(watermark);
  if (!Number.isFinite(parsed)) return null;
  return new Date(parsed - overlapHours * 60 * 60 * 1000).toISOString();
}

export function laterPublicationWatermark(
  left: string | null,
  right: string | null,
): string | null {
  const candidates = [left, right]
    .filter((value): value is string => typeof value === "string")
    .map((value) => ({ value, parsed: Date.parse(value) }))
    .filter((value) => Number.isFinite(value.parsed))
    .sort((a, b) => b.parsed - a.parsed);
  return candidates[0]?.value ?? null;
}

export async function latestPublicationWatermarkForItems(
  db: Queryable,
  input: {
    spaceId: string;
    sourceItemIds: string[];
    sourceChannelId?: string;
  },
): Promise<string | null> {
  if (input.sourceItemIds.length === 0) return null;
  const result = await db.query<{ watermark: string | null }>(
    `SELECT max(item.occurred_at)::text AS watermark
       FROM source_items item
       ${input.sourceChannelId
        ? `JOIN source_channel_item_links link
             ON link.space_id=item.space_id AND link.source_item_id=item.id
            AND link.source_channel_id=$3`
        : ""}
      WHERE item.space_id=$1 AND item.id=ANY($2::text[])
        AND item.deleted_at IS NULL`,
    input.sourceChannelId
      ? [input.spaceId, input.sourceItemIds, input.sourceChannelId]
      : [input.spaceId, input.sourceItemIds],
  );
  return result.rows[0]?.watermark ?? null;
}

export async function filterItemsForPublicationWindow(
  db: Queryable,
  input: {
    spaceId: string;
    sourceItemIds: string[];
    watermark: string | null;
    overlapHours?: number;
  },
): Promise<string[]> {
  if (input.sourceItemIds.length === 0) return [];
  const windowStart = publicationWindowStart(
    input.watermark,
    input.overlapHours ?? PROJECT_RESEARCH_MONITORING_OVERLAP_HOURS,
  );
  if (!windowStart) return [...input.sourceItemIds];
  const eligible = await db.query<{ id: string }>(
    `SELECT id
       FROM source_items
      WHERE space_id=$1 AND id=ANY($2::text[]) AND deleted_at IS NULL
        AND (occurred_at IS NULL OR occurred_at >= $3::timestamptz)`,
    [input.spaceId, input.sourceItemIds, windowStart],
  );
  const allowed = new Set(eligible.rows.map((row) => row.id));
  return input.sourceItemIds.filter((id) => allowed.has(id));
}
