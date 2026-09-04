import { describe, expect, it, vi } from "vitest";
import { ApiError } from "../src/api.js";
import { unregisterHost } from "../src/commands/unregister.js";

const config = {
  server_url: "https://rainver.example.com",
  host_id: "host-1",
  token: "secret-token",
  workspaces: { "location-1": "/work/project" },
};

function dependencies(revoke: () => Promise<void> = async () => {}) {
  return {
    requireConfig: vi.fn(async () => config),
    revoke: vi.fn(revoke),
    removeConfig: vi.fn(async () => {}),
    stopService: vi.fn(async () => true),
  };
}

describe("host unregister", () => {
  it("revokes remotely before removing local credentials and stopping the service", async () => {
    const order: string[] = [];
    const deps = dependencies();
    deps.revoke.mockImplementation(async () => { order.push("revoke"); });
    deps.removeConfig.mockImplementation(async () => { order.push("remove"); });
    deps.stopService.mockImplementation(async () => { order.push("stop"); return true; });

    await expect(unregisterHost({}, deps)).resolves.toEqual({ remote: "revoked", service_stopped: true });
    expect(deps.revoke).toHaveBeenCalledWith(config.server_url, config.token);
    expect(order).toEqual(["revoke", "stop", "remove"]);
  });

  it("keeps local credentials when the control plane cannot be reached", async () => {
    const deps = dependencies(async () => { throw new Error("offline"); });
    await expect(unregisterHost({}, deps)).rejects.toThrow("offline");
    expect(deps.removeConfig).not.toHaveBeenCalled();
    expect(deps.stopService).not.toHaveBeenCalled();
  });

  it("does not forget a local-only credential until the running service has stopped", async () => {
    const deps = dependencies();
    deps.stopService.mockRejectedValue(new Error("systemd unavailable"));
    await expect(unregisterHost({ localOnly: true }, deps)).rejects.toThrow("systemd unavailable");
    expect(deps.removeConfig).not.toHaveBeenCalled();
  });

  it("finishes local cleanup when the server has already invalidated the token", async () => {
    const deps = dependencies(async () => { throw new ApiError(401, "Invalid host token"); });
    await expect(unregisterHost({}, deps)).resolves.toEqual({ remote: "already_invalid", service_stopped: true });
    expect(deps.removeConfig).toHaveBeenCalledOnce();
    expect(deps.stopService).toHaveBeenCalledOnce();
  });

  it("requires an explicit local-only option to skip remote revocation", async () => {
    const deps = dependencies();
    await expect(unregisterHost({ localOnly: true }, deps)).resolves.toEqual({ remote: "skipped", service_stopped: true });
    expect(deps.revoke).not.toHaveBeenCalled();
    expect(deps.removeConfig).toHaveBeenCalledOnce();
  });
});
