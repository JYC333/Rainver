import { describe, it, expect } from "vitest";
import {
  CliCredentialProfileDTOSchema,
  CliCredentialProfileDetectResponseSchema,
  CliCredentialStatusDTOSchema,
  CliUsageAutoRefreshSettingsSchema,
  CliUsageAutoRefreshUpdateRequestSchema,
  CliLoginInputRequestSchema,
  CliLoginInputResponseSchema,
  CliLoginMethodDTOSchema,
  CliLoginStreamEventSchema,
  isCliLoginEventType,
  isCliLoginMethod,
} from "../src/index";

const profile = {
  id: "claude_code/default",
  runtime: "claude_code",
  name: "default",
  source_path: "/rainver/credentials/cli/claude_code/default",
  target_path: "/home/agent/.claude",
  readonly: true,
  notes: "",
  source_exists: true,
  logged_in: true,
  file_count: 2,
};

describe("cli credential contracts", () => {
  it("parses the current public CredentialProfileOut shape", () => {
    expect(CliCredentialProfileDTOSchema.parse(profile).runtime).toBe("claude_code");
  });

  it("rejects secret material in cli credential responses", () => {
    expect(
      CliCredentialProfileDTOSchema.safeParse({ ...profile, api_key: "sk-leak" }).success,
    ).toBe(false);
    expect(
      CliCredentialStatusDTOSchema.safeParse({
        runtime: "claude_code",
        label: "Claude Code",
        method: "cli",
        profile_id: "claude_code/default",
        logged_in: true,
        file_count: 2,
        secret_ref: "cli_login_state:v1:x",
      }).success,
    ).toBe(false);
  });

  it("parses detect, methods, and status responses", () => {
    expect(
      CliCredentialProfileDetectResponseSchema.parse({
        profile_id: "claude_code/default",
        source_path: profile.source_path,
        exists: true,
        non_empty: true,
        logged_in: true,
        file_count: 3,
        target_path: profile.target_path,
        readonly: true,
      }).non_empty,
    ).toBe(true);

    expect(
      CliLoginMethodDTOSchema.parse({
        runtime: "codex_cli",
        method: "cli",
        label: "Codex CLI",
        hint_cli: "A browser URL will appear",
        supports_cli: true,
      }).supports_cli,
    ).toBe(true);

    expect(
      CliCredentialStatusDTOSchema.parse({
        runtime: "opencode",
        label: "OpenCode",
        method: "cli",
        profile_id: null,
        logged_in: false,
        file_count: 0,
      }).profile_id,
    ).toBeNull();
  });

  it("parses login stream events permissively and pins documented types", () => {
    expect(CliLoginStreamEventSchema.parse({ type: "output", text: "$ claude /login\n" }).type).toBe(
      "output",
    );
    expect(CliLoginStreamEventSchema.parse({ type: "needs_input", prompt: "Code:" }).prompt).toBe(
      "Code:",
    );
    expect(CliLoginStreamEventSchema.parse({ type: "done", exit_code: 0 }).exit_code).toBe(0);
    expect(
      CliLoginStreamEventSchema.parse({
        type: "device_auth",
        url: "https://auth.openai.com/codex/device",
        code: "L84P-3A4MT",
        expires_in_minutes: 15,
      }).code,
    ).toBe("L84P-3A4MT");
    // A server-added future event type is never rejected.
    expect(CliLoginStreamEventSchema.parse({ type: "future_event" }).type).toBe("future_event");
    expect(CliLoginStreamEventSchema.safeParse({ text: "missing type" }).success).toBe(false);
    expect(
      CliLoginStreamEventSchema.safeParse({ type: "synced", api_key: "sk-leak" }).success,
    ).toBe(false);

    expect(isCliLoginEventType("profile")).toBe(true);
    expect(isCliLoginEventType("synced")).toBe(true);
    expect(isCliLoginEventType("device_auth")).toBe(true);
    expect(isCliLoginEventType("future_event")).toBe(false);
    expect(isCliLoginMethod("cli")).toBe(true);
    expect(isCliLoginMethod("oauth")).toBe(false);
  });

  it("parses CLI login input requests", () => {
    expect(CliLoginInputRequestSchema.parse({ input: "auth-code" }).input).toBe("auth-code");
    expect(CliLoginInputResponseSchema.parse({ status: "sent" }).status).toBe("sent");
  });

  it("parses CLI usage auto-refresh settings", () => {
    expect(
      CliUsageAutoRefreshSettingsSchema.parse({
        enabled: true,
        interval_ms: 10_800_000,
        updated_at: null,
      }).enabled,
    ).toBe(true);
    expect(
      CliUsageAutoRefreshUpdateRequestSchema.parse({ enabled: false }).enabled,
    ).toBe(false);
    expect(
      CliUsageAutoRefreshSettingsSchema.safeParse({
        enabled: true,
        interval_ms: 10_800_000,
        updated_at: null,
        api_key: "sk-leak",
      }).success,
    ).toBe(false);
  });
});
