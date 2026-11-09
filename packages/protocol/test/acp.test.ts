import { describe, expect, it } from "vitest";
import { acpRuntimeInfo, RunLiveInputRequestSchema } from "../src/acp.js";
const identity = (name: string, version: string) => ({ protocolVersion: 1, agentInfo: { name, version }, _meta: { steering: { supported: true } } });
describe("bounded ACP capabilities", () => {
  it("retains public identity and drops vendor/account payloads", () => {
    const input = { ...identity("@agentclientprotocol/codex-acp", "2.5.0"), email: "private@example.test", agentCapabilities: { sessionCapabilities: { compaction: {} } } };
    expect(acpRuntimeInfo(input)).toMatchObject({ version: "2.5.0", capabilities: { compaction: true, steering_idle_prompt_required: true } });
    expect(JSON.stringify(acpRuntimeInfo(input))).not.toContain("private");
    expect(acpRuntimeInfo({ ...input, protocolVersion: 2 })).toBeNull();
  });
  it.each(["3.0.0", "2.5.0-preview.1"])("does not assume idle-safe behavior on unverified Codex %s", version => {
    expect(acpRuntimeInfo(identity("@agentclientprotocol/codex-acp", version))?.capabilities.steering_idle_prompt_required).toBe(false);
  });
  it("accepts explicit negotiated idle-safe behavior independently of vendor identity", () => {
    const input = identity("other", "1.0.0");
    Object.assign(input._meta.steering, { idleBehavior: "promptRequired" });
    expect(acpRuntimeInfo(input)?.capabilities.steering_idle_prompt_required).toBe(true);
  });
  it("validates the public input binding and bounded text", () => {
    expect(RunLiveInputRequestSchema.safeParse({ binding_id: "arbitrary-native-session", content: "input" }).success).toBe(false);
    expect(RunLiveInputRequestSchema.safeParse({ binding_id: "30000000-0000-4000-8000-000000000099", content: " " }).success).toBe(false);
  });
});
