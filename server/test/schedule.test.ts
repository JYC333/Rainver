import { describe, expect, it } from "vitest";
import { computeNextRunAt, InvalidScheduleError } from "../src/modules/automations/schedule.js";

describe("automation schedule", () => {
  it("computes the next cron slot after a reference instant", () => {
    const next = computeNextRunAt(
      { cron: "0 9 * * *", timezone: "UTC" },
      new Date("2026-06-16T08:00:00.000Z"),
    );
    expect(next.toISOString()).toBe("2026-06-16T09:00:00.000Z");
  });

  it("supports stepped cron fields", () => {
    const next = computeNextRunAt(
      { cron: "*/15 9-10 * * *", timezone: "UTC" },
      new Date("2026-06-16T09:07:00.000Z"),
    );
    expect(next.toISOString()).toBe("2026-06-16T09:15:00.000Z");
  });

  it("computes cron slots in the configured timezone", () => {
    const next = computeNextRunAt(
      { cron: "0 9 * * *", timezone: "Europe/London" },
      new Date("2026-06-16T07:00:00.000Z"),
    );
    expect(next.toISOString()).toBe("2026-06-16T08:00:00.000Z");
  });

  it("rejects invalid cron expressions", () => {
    expect(() => computeNextRunAt({ cron: "not-a-cron", timezone: "UTC" })).toThrow(
      InvalidScheduleError,
    );
  });

  it("rejects invalid timezones", () => {
    expect(() => computeNextRunAt({ cron: "0 9 * * *", timezone: "Mars/Phobos" })).toThrow(
      InvalidScheduleError,
    );
  });

  it("shifts a schedule that falls inside a DST spring-forward gap forward by the gap length, rather than skipping to the next valid day", () => {
    // Europe/London jumps from 01:00 to 02:00 on 2026-03-29, so 01:30 local
    // time does not exist that day. cron-parser (via luxon) advances the
    // missing instant by the gap length instead of rolling to the next day
    // where 01:30 is valid — accepted behavior, see
    // REUSE_AND_DEPENDENCY_POLICY.md's cron-parser row.
    const next = computeNextRunAt(
      { cron: "30 1 * * *", timezone: "Europe/London" },
      new Date("2026-03-28T12:00:00.000Z"),
    );
    expect(next.toISOString()).toBe("2026-03-29T01:30:00.000Z");
  });
});
