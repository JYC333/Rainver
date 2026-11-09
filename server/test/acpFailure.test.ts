import { afterEach, describe, expect, it, vi } from "vitest";
import { createCliConversationController } from "../src/modules/runs/cliConversationProtocol.js";
import { acpFailureRunCode, normalizeAcpFailure, withAcpFailureTimezone } from "../src/modules/runtimeAdapters/acpFailure.js";
import { isRetryableRunErrorCode } from "../src/modules/runs/retryPolicy.js";

const now = new Date("2026-11-05T18:53:32Z");
const quotaMessage = "You’ve hit your usage limit. Try again at 7:10 PM.";
const rpc = (data: unknown) => ({ code: -32603, message: "Internal error", data });
afterEach(() => { vi.useRealTimers(); });

describe("ACP failure evidence", () => {
  it.each([
    ["gateway_signin_required", "auth"], ["org_pin_mismatch", "auth"], ["org_config_refused", "auth"],
    ["cwd_unavailable", "configuration"], ["proxy_invalid", "configuration"],
  ])("retains the allowlisted Claude startup reason %s", (startupFailureReason, category) => {
    expect(normalizeAcpFailure("claude_code", rpc({ startupFailureReason, secret: "sk-not-for-storage" }), now))
      .toMatchObject({ vendor_code: startupFailureReason, category, message: "Internal error" });
  });

  it.each([
    { message: quotaMessage, codexErrorInfo: "usageLimitExceeded" },
    { details: quotaMessage },
    quotaMessage,
  ])("keeps Codex's real quota refusal inside a generic wrapper: %j", data => {
    const failure = normalizeAcpFailure("codex_cli", rpc(data), now);
    expect(failure).toMatchObject({ rpc_code: -32603, category: "quota", occurred_at: now.toISOString(), resets_at: null });
    expect(failure.message).toContain(quotaMessage);
    expect(acpFailureRunCode(failure, false)).toBe("subscription_quota_exhausted");
    expect(isRetryableRunErrorCode(acpFailureRunCode(failure, false)!)).toBe(false);
    expect(acpFailureRunCode(failure, true)).toBeNull();
  });

  it("reads structured reset timestamps before falling back to an executing Host's clock", () => {
    const reset = Date.parse("2026-11-05T19:10:00Z") / 1000;
    const failure = normalizeAcpFailure("codex_cli", rpc({
      message: quotaMessage, codexErrorInfo: "usageLimitExceeded",
      additionalDetails: JSON.stringify({ error: { code: "usage_limit_reached", resets_at: reset } }),
    }), now);
    expect(failure.resets_at).toBe("2026-11-05T19:10:00.000Z");
    expect(withAcpFailureTimezone("codex_cli", failure, "America/New_York").resets_at).toBe(failure.resets_at);
    const clock = normalizeAcpFailure("codex_cli", rpc({ message: quotaMessage }), now);
    expect(withAcpFailureTimezone("codex_cli", clock, "Europe/London").resets_at).toBe("2026-11-05T19:10:00.000Z");
    expect(withAcpFailureTimezone("codex_cli", clock).resets_at).toBeNull();
    expect(withAcpFailureTimezone("codex_cli", clock, "Not/AZone").resets_at).toBeNull();
  });

  it.each([
    ["codex_cli", { codexErrorInfo: "unauthorized", message: "Please sign in again" }, "auth", "runtime_auth_required"],
    ["codex_cli", { codexErrorInfo: "rateLimitExceeded", message: "Too many requests" }, "rate_limit", "provider_rate_limit"],
    ["codex_cli", { codexErrorInfo: "serverOverloaded", message: "Try later" }, "transient", "adapter_runtime_error"],
    ["codex_cli", { codexErrorInfo: { httpConnectionFailed: { httpStatusCode: 401 } } }, "auth", "runtime_auth_required"],
    ["codex_cli", { codexErrorInfo: { httpConnectionFailed: { httpStatusCode: 429 } } }, "rate_limit", "provider_rate_limit"],
    ["claude_code", { details: "Failed to authenticate: OAuth token revoked. Please log in again." }, "auth", "runtime_auth_required"],
    ["claude_code", { errorKind: "authentication_failed" }, "auth", "runtime_auth_required"],
    ["claude_code", { errorKind: "oauth_org_not_allowed" }, "auth", "runtime_auth_required"],
    ["claude_code", { errorKind: "billing_error" }, "quota", "subscription_quota_exhausted"],
    ["claude_code", { errorKind: "rate_limit" }, "rate_limit", "provider_rate_limit"],
    ["claude_code", { errorKind: "overloaded" }, "transient", "adapter_runtime_error"],
    ["claude_code", { errorKind: "server_error" }, "transient", "adapter_runtime_error"],
    ["claude_code", { errorKind: "model_not_found" }, "configuration", null],
    ["claude_code", { details: { error: { type: "overloaded_error", message: "Overloaded" } } }, "transient", "adapter_runtime_error"],
    ["claude_code", { details: { error: { type: "rate_limit_error", message: "Too many requests" } } }, "rate_limit", "provider_rate_limit"],
    ["claude_code", { details: "You've hit your session limit · resets 7pm (Europe/London)" }, "quota", "subscription_quota_exhausted"],
  ])("distinguishes %s failures by their actual cause", (runtime, data, category, code) => {
    const failure = normalizeAcpFailure(runtime as string, rpc(data), now);
    expect(failure.category).toBe(category);
    expect(acpFailureRunCode(failure, false)).toBe(code);
    if (category === "auth" || category === "quota") expect(isRetryableRunErrorCode(code as string)).toBe(false);
  });

  it("does not treat an opaque internal error or another vendor's metadata as a transient failure", () => {
    for (const failure of [normalizeAcpFailure("codex_cli", rpc(null), now),
      normalizeAcpFailure("opencode", rpc({ codexErrorInfo: "usageLimitExceeded" }), now)]) {
      expect(failure.category).toBe("unknown");
      expect(acpFailureRunCode(failure, false)).toBeNull();
    }
    expect(normalizeAcpFailure("codex_cli", rpc({ reason: "auth_required", codexErrorInfo: "usageLimitExceeded" }), now).category).toBe("auth");
    expect(normalizeAcpFailure("codex_cli", { code: -32000, message: "Session not found" }, now).category).toBe("unknown");
    expect(normalizeAcpFailure("codex_cli", rpc({ code: "constructor" }), now).category).toBe("unknown");
  });

  it("redacts diagnostic secrets and ignores arbitrary raw error metadata", () => {
    const secret = "sk-example_private_key_1234567890";
    const failure = normalizeAcpFailure("claude_code", rpc({
      details: `Failed to authenticate. api_key=${secret}; Authorization: Bearer private_credential_1234567890`,
      access_token: "hidden-access-token", request: { body: "hidden-request-body" },
    }), now);
    const serialized = JSON.stringify(failure);
    for (const value of [secret, "private_credential_1234567890", "hidden-access-token", "hidden-request-body"]) {
      expect(serialized).not.toContain(value);
    }
    expect(failure.message).toContain("[REDACTED_SECRET]");
    expect(normalizeAcpFailure("codex_cli", rpc({ message: "x".repeat(100_000) }), now).message.length).toBeLessThan(33_000);
  });

  it("does not expose truncated secret prefixes or raw malformed JSON diagnostic metadata", () => {
    const boundary = normalizeAcpFailure("codex_cli", { data: { message: `${"x ".repeat(15_997)}sk-private_credential_1234567890${" ".repeat(1000)}` } }, now);
    expect(boundary.message).not.toContain("sk-pr");
    for (const additionalDetails of ['{"request":{"body":"private-request"},', JSON.stringify({ request: { body: "private-request" }, padding: "x".repeat(100_000) })]) {
      expect(normalizeAcpFailure("codex_cli", rpc({ additionalDetails }), now).message).not.toContain("private-request");
    }
  });
});

describe("ACP account failures preserve conversation continuity", () => {
  it("keeps the first failure and does not send a prompt after late resume replies", async () => {
    const sent: unknown[] = [];
    const send = (value: unknown) => { sent.push(value); };
    const controller = createCliConversationController({ runtime_key: "codex_cli", prompt: "continue", cwd: "/workspace", runtime_session_id: "stored-session" })!;
    controller.start(send);
    await controller.receive({ jsonrpc: "2.0", id: 1, result: { protocolVersion: 1 } }, send, () => {});
    await controller.receive({ jsonrpc: "2.0", id: 2, error: rpc({ codexErrorInfo: "unauthorized", message: "Please sign in" }) }, send, () => {});
    const count = sent.length;
    await controller.receive({ jsonrpc: "2.0", id: 2, error: rpc({ message: "Session not found" }) }, send, () => {});
    await controller.receive({ jsonrpc: "2.0", id: 2, result: { sessionId: "stored-session" } }, send, () => {});
    expect(sent).toHaveLength(count);
    expect(controller.result()).toMatchObject({ failure: { category: "auth", phase: "session_new" }, external_session_id: "stored-session" });
    expect(controller.result().resume_handshake_failed).toBeUndefined();
  });

  it("does not turn a completed prompt into a failure when an old error arrives", async () => {
    const send = () => {};
    const controller = createCliConversationController({ runtime_key: "codex_cli", prompt: "continue", cwd: "/workspace" })!;
    controller.start(send);
    await controller.receive({ jsonrpc: "2.0", id: 1, result: { protocolVersion: 1 } }, send, send);
    await controller.receive({ jsonrpc: "2.0", id: 2, result: { sessionId: "session" } }, send, send);
    await controller.receive({ jsonrpc: "2.0", id: 4, result: { stopReason: "end_turn" } }, send, send);
    await controller.receive({ jsonrpc: "2.0", id: 4, error: rpc({ codexErrorInfo: "unauthorized" }) }, send, send);
    controller.reject("late protocol fragment during shutdown");
    expect(controller.result()).toMatchObject({ completed: true, error: null, external_session_id: "session" });
    expect(controller.result().failure).toBeUndefined();
  });

  it("records time spent in the failing stage rather than total conversation time", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(now);
      const send = () => {};
      const controller = createCliConversationController({ runtime_key: "codex_cli", prompt: "continue", cwd: "/workspace" })!;
      controller.start(send);
      vi.setSystemTime(new Date(now.getTime() + 10_000));
      await controller.receive({ jsonrpc: "2.0", id: 1, result: { protocolVersion: 1 } }, send, send);
      vi.setSystemTime(new Date(now.getTime() + 11_200));
      await controller.receive({ jsonrpc: "2.0", id: 2, error: rpc({ codexErrorInfo: "unauthorized" }) }, send, send);
      expect(controller.result().failure).toMatchObject({ phase: "session_new", phase_elapsed_ms: 1200 });
    } finally { vi.useRealTimers(); }
  });
  it.each(["usageLimitExceeded", "unauthorized", "rateLimitExceeded", "serverOverloaded"])(
    "does not discard an existing vendor session after %s during resume", async codexErrorInfo => {
      const controller = createCliConversationController({ runtime_key: "codex_cli", prompt: "continue", cwd: "/workspace", runtime_session_id: "stored-session" })!;
      const send = () => {};
      controller.start(send);
      await controller.receive({ jsonrpc: "2.0", id: 1, result: { protocolVersion: 1 } }, send, send);
      await controller.receive({ jsonrpc: "2.0", id: 2, error: rpc({ codexErrorInfo, message: "Account cannot proceed" }) }, send, send);
      expect(controller.result()).toMatchObject({ completed: false, external_session_id: "stored-session" });
      expect(controller.result().resume_handshake_failed).toBeUndefined();
      expect(controller.result().resume_unanswered).toBeUndefined();
      expect(controller.result().error).toContain("Account cannot proceed");
    });

  it("retains an existing session when initialization itself fails with an account refusal", async () => {
    const controller = createCliConversationController({ runtime_key: "claude_code", prompt: "continue", cwd: "/workspace", runtime_session_id: "stored-session" })!;
    const send = () => {};
    controller.start(send);
    await controller.receive({ jsonrpc: "2.0", id: 1, error: rpc({ errorKind: "authentication_failed" }) }, send, send);
    expect(controller.result()).toMatchObject({ external_session_id: "stored-session", failure: { category: "auth" } });
  });

  it("still invalidates a resume whose session really is missing", async () => {
    const controller = createCliConversationController({ runtime_key: "codex_cli", prompt: "continue", cwd: "/workspace", runtime_session_id: "missing" })!;
    const send = () => {};
    controller.start(send);
    await controller.receive({ jsonrpc: "2.0", id: 1, result: { protocolVersion: 1 } }, send, send);
    await controller.receive({ jsonrpc: "2.0", id: 2, error: rpc({ message: "no rollout found" }) }, send, send);
    expect(controller.result()).toMatchObject({ resume_handshake_failed: true, external_session_id: null });
  });
});
