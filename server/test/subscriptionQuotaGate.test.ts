import { describe, expect, it } from "vitest";
import { classifyRuntimeFailure, isRetryableRunErrorCode, SUBSCRIPTION_QUOTA_EXHAUSTED } from "../src/modules/runs/retryPolicy.js";
import { quotaVerdict } from "../src/modules/rooms/quotaGate.js";
import { fullerWindow, refusedWindow, resetsAtOf } from "../src/modules/rooms/subscriptionLogins.js";

describe("subscription quota exhaustion is a runtime refusal, not a retryable failure", () => {
  it("classifies each runtime's own refusal text", () => {
    expect(classifyRuntimeFailure("claude_code", "Claude AI usage limit reached|1790000000", { providerBound: false }))
      .toBe(SUBSCRIPTION_QUOTA_EXHAUSTED);
    expect(classifyRuntimeFailure("claude_code", "5-hour limit reached ∙ resets 3pm", { providerBound: false }))
      .toBe(SUBSCRIPTION_QUOTA_EXHAUSTED);
    expect(classifyRuntimeFailure("claude_code", "You've hit your limit · resets 7pm (Europe/Berlin)", { providerBound: false }))
      .toBe(SUBSCRIPTION_QUOTA_EXHAUSTED);
    expect(classifyRuntimeFailure("codex_cli", "error: usage_limit_reached", { providerBound: false }))
      .toBe(SUBSCRIPTION_QUOTA_EXHAUSTED);
    expect(classifyRuntimeFailure("codex_cli", "You've hit your usage limit. Try again in 2 hours 3 minutes.", { providerBound: false }))
      .toBe(SUBSCRIPTION_QUOTA_EXHAUSTED);
    expect(isRetryableRunErrorCode(SUBSCRIPTION_QUOTA_EXHAUSTED)).toBe(false);
  });

  it("leaves other failures, other runtimes and priced Runs to their own codes", () => {
    expect(classifyRuntimeFailure("claude_code", "Process exited with code 1: ENOENT", { providerBound: false })).toBeNull();
    // A provider's rate limit on a priced Run is the provider's, and retryable.
    expect(classifyRuntimeFailure("claude_code", "Claude AI usage limit reached", { providerBound: true })).toBeNull();
    // A runtime that declares no refusal text is never guessed at.
    expect(classifyRuntimeFailure("opencode", "usage limit reached", { providerBound: false })).toBeNull();
    expect(classifyRuntimeFailure("claude_code", null, { providerBound: false })).toBeNull();
    // Falling back from Opus is a notice, not a refusal.
    expect(classifyRuntimeFailure("claude_code", "Opus limit reached · now using Sonnet", { providerBound: false })).toBeNull();
  });
});

describe("a CLI refusal as a reading", () => {
  const refusedAt = "2026-09-24T10:00:00.000Z";
  const at = (iso: string) => new Date(iso);

  it("reads the window full until the reading's reset, or one session window when nothing says when", () => {
    const reading = { window: { kind: "week" as const, utilization: 60, resets_at: "2026-09-26T00:00:00.000Z" }, checked_at: "2026-09-24T09:00:00.000Z" };
    expect(refusedWindow(reading, refusedAt, at("2026-09-24T11:00:00.000Z")))
      .toEqual({ kind: "week", utilization: 100, resets_at: "2026-09-26T00:00:00.000Z" });
    const unreadable = { window: null, checked_at: null };
    expect(refusedWindow(unreadable, refusedAt, at("2026-09-24T11:00:00.000Z")))
      .toEqual({ kind: "session", utilization: 100, resets_at: "2026-09-24T15:00:00.000Z" });
    // A login nothing could read again is not held past that window.
    expect(refusedWindow(unreadable, refusedAt, at("2026-09-24T15:00:01.000Z"))).toBeNull();
  });

  it("gives way to a reading taken after the refusal that shows the window no longer full", () => {
    const later = { window: { kind: "session" as const, utilization: 20, resets_at: "2026-09-24T18:00:00.000Z" }, checked_at: "2026-09-24T12:00:00.000Z" };
    expect(refusedWindow(later, refusedAt, at("2026-09-24T12:30:00.000Z"))).toBeNull();
  });

  it("keeps the refusal when a probe after it could not read the window", () => {
    const unreadableLater = { window: null, checked_at: "2026-09-24T12:00:00.000Z" };
    expect(refusedWindow(unreadableLater, refusedAt, at("2026-09-24T12:30:00.000Z")))
      .toEqual({ kind: "session", utilization: 100, resets_at: "2026-09-24T15:00:00.000Z" });
  });
});

describe("the quota gate's verdict", () => {
  const now = new Date("2026-09-24T18:00:00.000Z");
  const window = (utilization: number, resets_at: string | null = "2026-09-24T19:40:00.000Z") =>
    ({ kind: "session" as const, utilization, resets_at });

  it("holds an Agent-triggered turn at or past the reserve line", () => {
    expect(quotaVerdict({ window: window(85), reservePct: 85, override: false, now })).toEqual({ hold: true, window: window(85) });
    expect(quotaVerdict({ window: window(100, null), reservePct: 85, override: false, now }).hold).toBe(true);
  });

  it("admits below the line, with nothing known, after the reset, or when a person continued anyway", () => {
    expect(quotaVerdict({ window: window(84), reservePct: 85, override: false, now }).hold).toBe(false);
    expect(quotaVerdict({ window: null, reservePct: 85, override: false, now }).hold).toBe(false);
    expect(quotaVerdict({ window: window(99, "2026-09-24T17:59:00.000Z"), reservePct: 85, override: false, now }).hold).toBe(false);
    expect(quotaVerdict({ window: window(99), reservePct: 85, override: true, now }).hold).toBe(false);
  });

  it("reads the fuller of a login's windows, and a reset time only when it is a date", () => {
    expect(fullerWindow({
      available: true,
      session_pct: 40,
      session_resets: "Resets 2026-09-24T19:40:00.000Z",
      week_pct: 91,
      week_resets: "Resets 2026-09-28T08:00:00Z",
      error: null,
    })).toEqual({ kind: "week", utilization: 91, resets_at: "2026-09-28T08:00:00.000Z" });
    expect(fullerWindow({ available: false, session_pct: null, session_resets: null, week_pct: null, week_resets: null, error: "offline" }))
      .toBeNull();
    expect(resetsAtOf("Resets 3pm")).toBeNull();
  });
});
