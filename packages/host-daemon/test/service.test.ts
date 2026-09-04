import { describe, expect, it, vi } from "vitest";
import { startInstalledService } from "../src/service.js";

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
});
