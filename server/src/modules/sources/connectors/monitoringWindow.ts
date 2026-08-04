const DEFAULT_OVERLAP_HOURS = 48;

/** Resolve the lower publication bound carried by a Channel scan cursor. */
export function scanPublicationWindowStart(cursor: Record<string, unknown>): string | null {
  const watermark = typeof cursor.last_published_at === "string"
    ? cursor.last_published_at
    : null;
  if (!watermark) return null;
  const parsed = Date.parse(watermark);
  if (!Number.isFinite(parsed)) return null;
  const configured = cursor.overlap_hours;
  const overlapHours = typeof configured === "number"
    && Number.isFinite(configured)
    && configured >= 0
    ? configured
    : DEFAULT_OVERLAP_HOURS;
  return new Date(parsed - overlapHours * 60 * 60 * 1000).toISOString();
}
