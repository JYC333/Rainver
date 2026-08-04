import { describe, expect, it } from "vitest";
import {
  laterPublicationWatermark,
  publicationWindowStart,
} from "../src/modules/projectResearch/monitoringWindow";
import { computeNextCheckAt } from "../src/modules/sources/sourceScanCadence";

describe("Project Research monitoring boundaries", () => {
  it("uses publication time for the overlap window and never moves its watermark backwards", () => {
    expect(publicationWindowStart("2026-07-30T12:00:00.000Z", 48))
      .toBe("2026-07-28T12:00:00.000Z");
    expect(laterPublicationWatermark(
      "2026-07-30T12:00:00.000Z",
      "2026-07-29T12:00:00.000Z",
    )).toBe("2026-07-30T12:00:00.000Z");
  });

  it("schedules monitoring at the next cadence boundary instead of immediately", () => {
    expect(computeNextCheckAt(
      "daily",
      "2026-07-30T22:56:31.000Z",
      { scheduleRule: { frequency: "daily", hour: 3, minute: 0 } },
    )).toBe("2026-07-31T03:00:00.000Z");
  });
});
