import { describe, expect, it } from "vitest";
import { assertDate } from "../src/modules/informationDigest/service.js";

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
