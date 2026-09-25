import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  ARGON2ID_OPTIONS,
  DEVELOPMENT_PASSWORD_MIN_LENGTH,
  PASSWORD_MAX_LENGTH,
  PRODUCTION_PASSWORD_MIN_LENGTH,
  assertPasswordPolicy,
  hashOpaqueToken,
  hashPassword,
  normalizeAuthEmail,
  PasswordPolicyError,
  passwordMinimumLength,
  verifyPassword,
} from "../src/modules/auth/securityPolicy.js";
import { guardedHibpRangeTransport, isPasswordCompromised } from "../src/modules/auth/hibp.js";
import { sanitizeAuthEventDetails } from "../src/modules/auth/securityEvents.js";

describe("auth security policy", () => {
  function thrownCode(fn: () => void): string {
    try {
      fn();
    } catch (error) {
      if (error instanceof PasswordPolicyError) return error.code;
      throw error;
    }
    throw new Error("expected password policy failure");
  }

  it("normalizes only trim and lowercase", () => {
    expect(normalizeAuthEmail("  Owner+tag@Example.COM ")).toBe("owner+tag@example.com");
  });

  it("rejects empty, short, and overlong passwords without composition rules", () => {
    expect(thrownCode(() => assertPasswordPolicy(""))).toBe("password_required");
    expect(thrownCode(() => assertPasswordPolicy("12345678901234"))).toBe("password_too_short");
    expect(thrownCode(() => assertPasswordPolicy("a".repeat(PASSWORD_MAX_LENGTH + 1)))).toBe("password_too_long");
    expect(() => assertPasswordPolicy("仅使用空格和Unicode字符 ".repeat(2))).not.toThrow();
    expect(PRODUCTION_PASSWORD_MIN_LENGTH).toBe(15);
    expect(PASSWORD_MAX_LENGTH).toBe(128);
  });

  it("relaxes only explicit development and test environments", () => {
    expect(DEVELOPMENT_PASSWORD_MIN_LENGTH).toBe(8);
    expect(passwordMinimumLength("dev")).toBe(8);
    expect(passwordMinimumLength("test")).toBe(8);
    expect(passwordMinimumLength("prod")).toBe(15);
    expect(passwordMinimumLength("")).toBe(15);
    expect(() => assertPasswordPolicy("12345678", passwordMinimumLength("dev"))).not.toThrow();
    expect(() => assertPasswordPolicy("1234567", passwordMinimumLength("dev"))).toThrowError("password_too_short");
  });

  it("counts Unicode code points rather than UTF-16 code units", () => {
    const astral = "🦊";
    expect(() => assertPasswordPolicy(astral.repeat(14))).toThrowError("password_too_short");
    expect(() => assertPasswordPolicy(astral.repeat(15))).not.toThrow();
    expect(() => assertPasswordPolicy(astral.repeat(128))).not.toThrow();
    expect(() => assertPasswordPolicy(astral.repeat(129))).toThrowError("password_too_long");
  });

  it("uses Argon2id and verifies the resulting PHC hash", async () => {
    const password = "正确长度的密码 with spaces";
    const encoded = await hashPassword(password);
    expect(encoded).toMatch(/^\$argon2id\$/);
    expect(encoded).toContain(`m=${ARGON2ID_OPTIONS.memoryCost}`);
    expect(encoded).toContain(`t=${ARGON2ID_OPTIONS.timeCost}`);
    expect(encoded).toContain(`p=${ARGON2ID_OPTIONS.parallelism}`);
    await expect(verifyPassword(encoded, password)).resolves.toBe(true);
    await expect(verifyPassword(encoded, "另一个密码 with spaces")).resolves.toBe(false);
  });

  it("hashes opaque tokens deterministically without exposing the raw value", () => {
    const digest = hashOpaqueToken("one-time-secret");
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
    expect(digest).not.toContain("one-time-secret");
    expect(hashOpaqueToken("one-time-secret")).toBe(digest);
  });

  it("allowlists auth event details and drops secret-shaped or oversized values", () => {
    expect(sanitizeAuthEventDetails({
      provider: "google",
      reason_code: "invalid_password",
      session_count: 2,
      password: "never persist me",
      raw_token: "never persist me",
      nested: { secret: true },
      route: "x".repeat(257),
    })).toEqual({ provider: "google", reason_code: "invalid_password", session_count: 2 });
  });

  it("uses the HIBP range protocol without sending a full password hash", async () => {
    const requests: string[] = [];
    const password = "a valid password with spaces";
    const digest = createHash("sha1").update(password).digest("hex").toUpperCase();
    const compromised = await isPasswordCompromised(password, {
      fetchRange: async (prefix) => {
        requests.push(prefix);
        return `${digest.slice(5)}:2\n`;
      },
    });
    expect(compromised).toBe(true);
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatch(/^[0-9A-F]{5}$/);
  });

  it("routes HIBP through the guarded HTTPS transport", async () => {
    const originalFetch = globalThis.fetch;
    let requestedUrl = "";
    let requestedHeaders: Record<string, string> | undefined;
    globalThis.fetch = (async (input, init) => {
      requestedUrl = String(input);
      requestedHeaders = init?.headers as Record<string, string> | undefined;
      return new Response("ABCDEF0123456789:1\n", { status: 200 });
    }) as typeof fetch;
    try {
      const transport = guardedHibpRangeTransport({
        pin: async () => [{ address: "1.1.1.1", family: 4 }],
      });
      await expect(transport.fetchRange("abcde")).resolves.toContain("ABCDEF");
      expect(requestedUrl).toBe("https://api.pwnedpasswords.com/range/ABCDE");
      expect(new Headers(requestedHeaders).get("add-padding")).toBe("true");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
