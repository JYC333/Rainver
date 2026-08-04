import { describe, expect, it } from "vitest";
import { nextBackfillRetryAt } from "../src/modules/sources/sourceBackfillRetry";

describe("source backfill deferred retry", () => {
  const now = new Date("2026-07-30T20:00:00.000Z");

  it("backs off repeated extraction jobs and caps at one retry per day", () => {
    expect(nextBackfillRetryAt(1, now)).toBe("2026-07-30T20:01:00.000Z");
    expect(nextBackfillRetryAt(2, now)).toBe("2026-07-30T20:05:00.000Z");
    expect(nextBackfillRetryAt(3, now)).toBe("2026-07-30T20:30:00.000Z");
    expect(nextBackfillRetryAt(4, now)).toBe("2026-07-30T22:00:00.000Z");
    expect(nextBackfillRetryAt(5, now)).toBe("2026-07-31T02:00:00.000Z");
    expect(nextBackfillRetryAt(6, now)).toBe("2026-07-31T20:00:00.000Z");
    expect(nextBackfillRetryAt(20, now)).toBe("2026-07-31T20:00:00.000Z");
  });
});
