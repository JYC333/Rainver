import { describe, expect, it } from "vitest";
import {
  computeNextRunAtFromScheduleRule,
  resolveRequestedSourceSchedule,
} from "../src/modules/sources/sourceScheduleInput.js";

describe("resolveRequestedSourceSchedule", () => {
  const now = new Date("2026-07-03T10:20:00.000Z");

  it("requires a schedule_rule for active scheduled sources", () => {
    expect(() => resolveRequestedSourceSchedule({
      body: {},
      status: "active",
      fetchFrequency: "daily",
      now,
    })).toThrow(/schedule_rule is required/);

    expect(resolveRequestedSourceSchedule({
      body: { schedule_rule: { frequency: "daily", hour: 9, minute: 30 } },
      status: "active",
      fetchFrequency: "daily",
      now,
    })).toEqual({
      nextRunAt: "2026-07-04T09:30:00.000Z",
      scheduleRule: { frequency: "daily", hour: 9, minute: 30 },
    });
  });

  it("supports hourly minute, daily hour/minute, and weekly weekday/hour/minute", () => {
    expect(computeNextRunAtFromScheduleRule({ frequency: "hourly", minute: 15 }, now))
      .toBe("2026-07-03T11:15:00.000Z");
    expect(computeNextRunAtFromScheduleRule({ frequency: "daily", hour: 11, minute: 0 }, now))
      .toBe("2026-07-03T11:00:00.000Z");
    expect(computeNextRunAtFromScheduleRule({ frequency: "weekly", weekday: 5, hour: 10, minute: 30 }, now))
      .toBe("2026-07-03T10:30:00.000Z");
    expect(computeNextRunAtFromScheduleRule({ frequency: "weekly", weekday: 5, hour: 10, minute: 10 }, now))
      .toBe("2026-07-10T10:10:00.000Z");
  });

  it("preserves explicit schedules for paused sources without making them due", () => {
    expect(resolveRequestedSourceSchedule({
      body: { schedule_rule: { frequency: "weekly", weekday: 1, hour: 9, minute: 0 } },
      status: "paused",
      fetchFrequency: "weekly",
      now,
    })).toEqual({
      nextRunAt: "2026-07-06T09:00:00.000Z",
      scheduleRule: { frequency: "weekly", weekday: 1, hour: 9, minute: 0 },
    });

    expect(resolveRequestedSourceSchedule({
      body: {},
      status: "paused",
      fetchFrequency: "weekly",
      now,
    })).toEqual({ nextRunAt: null, scheduleRule: null });
  });

  it("ignores schedule_rule for manual sources", () => {
    expect(resolveRequestedSourceSchedule({
      body: { schedule_rule: { frequency: "hourly", minute: 15 } },
      status: "active",
      fetchFrequency: "manual",
      now,
    })).toEqual({ nextRunAt: null, scheduleRule: null });
  });
});
