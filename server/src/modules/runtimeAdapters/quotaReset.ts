import { getRuntimeAdapterSpec } from "./specs.js";

/** Only formats declared by the runtime count as a reset time. Unknown prose stays unknown. */
export function runtimeQuotaResetAt(runtimeKey: string | null, text: string | null, now: Date, timeZone?: string): string | null {
  if (!runtimeKey || !text) return null;
  for (const pattern of getRuntimeAdapterSpec(runtimeKey)?.usage.quota_reset_patterns ?? []) {
    const fields = new RegExp(pattern, "i").exec(text)?.groups;
    if (!fields) continue;
    if (fields.epoch) {
      const reset = validQuotaResetAt(Number(fields.epoch), now);
      if (reset) return reset;
      continue;
    }
    if (fields.delay_hours || fields.delay_minutes || fields.delay_seconds) {
      const delay = Number(fields.delay_hours ?? 0) * 3600 + Number(fields.delay_minutes ?? 0) * 60 + Number(fields.delay_seconds ?? 0);
      const reset = validQuotaResetAt(now.getTime() + delay * 1000, now);
      if (reset) return reset;
      continue;
    }
    const hour = Number(fields.hour);
    const minute = Number(fields.minute ?? 0);
    const zone = fields.zone ?? timeZone;
    if (hour < 1 || hour > 12 || minute > 59 || !zone) continue;
    try {
      const format = new Intl.DateTimeFormat("en-GB", {
        timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit",
        hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
      });
      const local = (time: number) => Object.fromEntries(format.formatToParts(time).map(part => [part.type, part.value]));
      const today = local(now.getTime());
      const target = Date.UTC(Number(today.year), Number(today.month) - 1, Number(today.day),
        hour % 12 + (fields.period?.toLowerCase() === "pm" ? 12 : 0), minute);
      const candidates: number[] = [];
      // Intl owns zone/DST rules. Sample offsets on either side of the next local day,
      // then round-trip candidates so a nonexistent DST clock time is never invented.
      for (const days of [0, 1]) for (const offsetDay of [-1, 0, 1]) {
        const probe = target + offsetDay * 86400_000;
        const parts = local(probe);
        const offset = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day),
          Number(parts.hour), Number(parts.minute), Number(parts.second)) - probe;
        const candidate = target + days * 86400_000 - offset;
        const check = local(candidate);
        if (candidate > now.getTime() && candidate - now.getTime() <= 25 * 3600_000
          && Number(check.hour) === hour % 12 + (fields.period?.toLowerCase() === "pm" ? 12 : 0)
          && Number(check.minute) === minute) candidates.push(candidate);
      }
      if (candidates.length) return new Date(Math.min(...candidates)).toISOString();
    } catch { /* An invalid vendor timezone is unknown, never the server's local zone. */ }
  }
  return null;
}

/** A reset must be an explicit instant within the vendor's maximum known window. */
export function validQuotaResetAt(value: unknown, now: Date): string | null {
  const time = typeof value === "number" && Number.isFinite(value)
    ? value < 1e12 ? value * 1000 : value
    : typeof value === "string" && /(?:Z|[+-]\d{2}:\d{2})$/i.test(value) ? Date.parse(value) : NaN;
  return Number.isFinite(time) && time > now.getTime() && time < now.getTime() + 8 * 86400_000
    ? new Date(time).toISOString() : null;
}
