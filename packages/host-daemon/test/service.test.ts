import { describe, expect, it, vi } from "vitest";
import { disableInstalledService, startInstalledService, stopInstalledService } from "../src/service.js";

describe("installed host service", () => {
  it("starts systemd after an installed CLI registers", async () => {
    const run = vi.fn(async () => {});
    await expect(startInstalledService({ RAINVER_HOST_INSTALL_ROOT: "/opt/rainver-host" }, run)).resolves.toBe(true);
    expect(run).toHaveBeenCalledWith("systemctl", ["--user", "enable", "--now", "rainver-host.service"]);
  });

  it("does not manage a service when running from a source checkout", async () => {
    const run = vi.fn(async () => {});
    await expect(startInstalledService({}, run)).resolves.toBe(false);
    expect(run).not.toHaveBeenCalled();
  });

  it("disables and stops systemd when an installed CLI unregisters", async () => {
    const run = vi.fn(async () => {});
    await expect(stopInstalledService({ RAINVER_HOST_INSTALL_ROOT: "/opt/rainver-host" }, run)).resolves.toBe(true);
    expect(run).toHaveBeenCalledWith("systemctl", ["--user", "disable", "--now", "rainver-host.service"]);
  });

  it("can disable a revoked service from inside the daemon without stopping its caller", async () => {
    const run = vi.fn(async () => {});
    await expect(disableInstalledService({ RAINVER_HOST_INSTALL_ROOT: "/opt/rainver-host" }, run)).resolves.toBe(true);
    expect(run).toHaveBeenCalledWith("systemctl", ["--user", "disable", "rainver-host.service"]);
  });
});
