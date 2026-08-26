import { describe, expect, it } from "vitest";
import {
  createManagedSubscriptionLoginSession,
  parseManagedSubscriptionType,
} from "../src/modules/providers/subscriptionOAuth.js";

describe("managed subscription OAuth interaction", () => {
  it("selects Codex device-code login without exposing a generic prompt", async () => {
    const events: unknown[] = [];
    const session = createManagedSubscriptionLoginSession("openai_codex", event => events.push(event));

    await expect(session.interaction.prompt({
      type: "select",
      message: "Choose login method",
      options: [{ id: "device_code", label: "Device code" }],
    })).resolves.toBe("device_code");
    expect(events).toEqual([]);
  });

  it("relays Claude manual-code input through the owning login session", async () => {
    const events: Array<Record<string, unknown>> = [];
    const session = createManagedSubscriptionLoginSession("anthropic", event => events.push(event));
    const pending = session.interaction.prompt({
      type: "manual_code",
      message: "Paste redirect URL",
      placeholder: "https://console.anthropic.com/oauth/code/callback?...",
    });

    expect(events[0]).toMatchObject({ type: "prompt", promptType: "manual_code" });
    expect(session.submit("redirect-code")).toBe(true);
    await expect(pending).resolves.toBe("redirect-code");
    expect(session.submit("late-code")).toBe(false);
  });

  it("rejects unsupported subscription provider types", () => {
    expect(() => parseManagedSubscriptionType("github_copilot")).toThrow(/anthropic.*openai_codex/i);
  });
});
