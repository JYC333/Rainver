import { describe, expect, it } from "vitest";
import { acpAgentAuthMethodId, isAcpAuthRequiredError } from "../src/hosts.js";

describe("ACP authentication helpers", () => {
  it("recognizes typed startup auth without treating every startup error as logout", () => {
    for (const startupFailureReason of ["gateway_signin_required", "org_pin_mismatch", "org_config_refused"]) {
      expect(isAcpAuthRequiredError({ code: -32000, data: { startupFailureReason } })).toBe(true);
    }
    expect(isAcpAuthRequiredError({ code: -32000, data: { startupFailureReason: "cwd_unavailable" } })).toBe(false);
  });
  it("recognizes the protocol's auth_required reason and the message-only phrasing some Agents use", () => {
    expect(isAcpAuthRequiredError({ code: -32000, data: { reason: "auth_required" } })).toBe(true);
    // Cursor: no reason, the message says it.
    expect(isAcpAuthRequiredError({ code: -32000, message: "Authentication required", data: { message: "run 'agent login' first" } })).toBe(true);
    expect(isAcpAuthRequiredError({ code: -32000, message: "Not logged in" })).toBe(true);
    expect(isAcpAuthRequiredError({ code: -32000, message: "workspace failed" })).toBe(false);
    expect(isAcpAuthRequiredError(null)).toBe(false);
    expect(isAcpAuthRequiredError("Authentication required")).toBe(false);
  });

  it("picks the first Agent-Auth method an initialize result advertised, skipping terminal ones", () => {
    expect(acpAgentAuthMethodId({ authMethods: [{ id: "device", name: "Device", type: "terminal" }, { id: "cursor_login", name: "Cursor Login" }] })).toBe("cursor_login");
    expect(acpAgentAuthMethodId({ authMethods: [{ id: "browser", type: "agent" }] })).toBe("browser");
    expect(acpAgentAuthMethodId({ authMethods: [{ id: "device", type: "terminal" }] })).toBeNull();
    expect(acpAgentAuthMethodId({ authMethods: [] })).toBeNull();
    expect(acpAgentAuthMethodId({})).toBeNull();
    expect(acpAgentAuthMethodId(undefined)).toBeNull();
  });
});
