import { describe, expect, it } from "vitest";
import { assertDate } from "../src/modules/informationDigest/service.js";
import { latestCompleteDigestDate, scheduledDigestDate } from "../src/modules/informationDigest/digestPeriod.js";
import { isLocalDayComplete, localDayUtcBounds, previousLocalDate, reportDateForSlot } from "../src/modules/scheduler/localDay.js";

describe("information digest calendar dates", () => {
  it.each(["2024-02-29", "2026-08-08", "9999-12-31"])("accepts %s", (value) => {
    expect(() => assertDate(value)).not.toThrow();
  });

  it.each(["0000-01-01", "2026-02-29", "2026-02-31", "2026-04-31", "2026-13-01", "2026-00-01"])(
    "rejects invalid calendar date %s",
    (value) => {
      expect(() => assertDate(value)).toThrow(`Invalid digest date ${JSON.stringify(value)}`);
    },
  );
});

describe("the complete local day a scheduled slot reports on", () => {
  it.each([
    // [slot (UTC), timezone, reported day, start, end]
    ["2026-08-09T07:00:00.000Z", "UTC", "2026-08-08", "2026-08-08T00:00:00.000Z", "2026-08-09T00:00:00.000Z"],
    // 07:00 in Shanghai is 23:00 UTC the evening before: the local day decides.
    ["2026-08-08T23:00:00.000Z", "Asia/Shanghai", "2026-08-08", "2026-08-07T16:00:00.000Z", "2026-08-08T16:00:00.000Z"],
    // Month and year boundaries.
    ["2026-03-01T07:00:00.000Z", "UTC", "2026-02-28", "2026-02-28T00:00:00.000Z", "2026-03-01T00:00:00.000Z"],
    ["2025-12-31T23:00:00.000Z", "Asia/Shanghai", "2025-12-31", "2025-12-30T16:00:00.000Z", "2025-12-31T16:00:00.000Z"],
    // DST: the US spring-forward day is 23 hours, the fall-back day 25.
    ["2026-03-09T11:00:00.000Z", "America/New_York", "2026-03-08", "2026-03-08T05:00:00.000Z", "2026-03-09T04:00:00.000Z"],
    ["2026-11-02T12:00:00.000Z", "America/New_York", "2026-11-01", "2026-11-01T04:00:00.000Z", "2026-11-02T05:00:00.000Z"],
  ])("slot %s in %s reports %s", (slot, timezone, day, start, end) => {
    expect(reportDateForSlot(slot, timezone)).toBe(day);
    expect(localDayUtcBounds(day, timezone)).toEqual({ startUtcIso: start, endUtcIso: end });
  });

  it("names the slot's day, not the worker's: a fire delayed to the next day still reports the scheduled day", () => {
    const slot = "2026-08-09T07:00:00.000Z";
    expect(reportDateForSlot(slot, "UTC")).toBe("2026-08-08");
    // The slot carries the decision; when the worker runs is irrelevant.
    expect(scheduledDigestDate(slot, "UTC")).toBe("2026-08-08");
  });

  it("puts consecutive days end to end, so every instant belongs to exactly one day", () => {
    for (const timezone of ["UTC", "Asia/Shanghai", "America/New_York", "Europe/London"]) {
      let day = "2026-03-01";
      for (let index = 0; index < 300; index += 1) {
        const next = previousLocalDate(day, -1);
        expect(localDayUtcBounds(day, timezone).endUtcIso).toBe(localDayUtcBounds(next, timezone).startUtcIso);
        day = next;
      }
    }
  });

  it("treats a day as complete only once its last instant has passed in the configured timezone", () => {
    const now = new Date("2026-08-08T20:00:00.000Z");
    // Already 2026-08-09 04:00 in Shanghai: the 8th is over there.
    expect(isLocalDayComplete("2026-08-08", "Asia/Shanghai", now)).toBe(true);
    // Still the 8th in UTC.
    expect(isLocalDayComplete("2026-08-08", "UTC", now)).toBe(false);
    expect(latestCompleteDigestDate("Asia/Shanghai", now)).toBe("2026-08-08");
    expect(latestCompleteDigestDate("UTC", now)).toBe("2026-08-07");
  });
});
