import { describe, expect, it } from "vitest";
import {
  isTestPostgresUnavailableError,
  TestPostgresUnavailableError,
} from "./support/sharedPostgres";

describe("shared PostgreSQL availability classification", () => {
  it("downgrades an explicitly unavailable shared container", () => {
    expect(isTestPostgresUnavailableError(new TestPostgresUnavailableError("Docker unavailable"))).toBe(true);
  });

  it("downgrades PostgreSQL connection errors, including nested causes", () => {
    const connectionError = Object.assign(new Error("connect failed"), { code: "ECONNREFUSED" });
    expect(isTestPostgresUnavailableError(connectionError)).toBe(true);
    expect(isTestPostgresUnavailableError(new Error("pool failed", { cause: connectionError }))).toBe(true);
    expect(isTestPostgresUnavailableError(Object.assign(new Error("connection lost"), { code: "08006" }))).toBe(true);
    expect(isTestPostgresUnavailableError(new AggregateError([connectionError], "all addresses failed"))).toBe(true);
  });

  it("does not downgrade schema, seed, or ordinary setup failures", () => {
    expect(isTestPostgresUnavailableError(Object.assign(new Error("missing column"), { code: "42703" }))).toBe(false);
    expect(isTestPostgresUnavailableError(new Error("service construction failed"))).toBe(false);
  });
});
