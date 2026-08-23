import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { configPath, loadConfig, requireConfig, saveConfig } from "../src/config.js";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "agent-space-host-config-"));
  process.env.AGENT_SPACE_HOST_CONFIG_DIR = dir;
});

afterEach(async () => {
  delete process.env.AGENT_SPACE_HOST_CONFIG_DIR;
  await rm(dir, { recursive: true, force: true });
});

describe("daemon config", () => {
  it("returns null before registration", async () => {
    expect(await loadConfig()).toBeNull();
  });

  it("rejects requireConfig before registration with an actionable message", async () => {
    await expect(requireConfig()).rejects.toThrow(/register --server/);
  });

  it("round-trips a saved config, including the workspace map", async () => {
    await saveConfig({
      server_url: "http://localhost:4000",
      host_id: "host-1",
      token: "secret-token",
      workspaces: { "folder-1": "/home/user/dev/mapping" },
    });
    const loaded = await loadConfig();
    expect(loaded).toEqual({
      server_url: "http://localhost:4000",
      host_id: "host-1",
      token: "secret-token",
      workspaces: { "folder-1": "/home/user/dev/mapping" },
    });
    expect(await requireConfig()).toEqual(loaded);
  });

  it("writes the config file with owner-only permissions", async () => {
    await saveConfig({ server_url: "http://localhost:4000", host_id: "host-1", token: "secret-token", workspaces: {} });
    const { stat } = await import("node:fs/promises");
    const info = await stat(configPath());
    expect(info.mode & 0o777).toBe(0o600);
  });

  it("throws on a malformed config file instead of silently treating it as unregistered", async () => {
    const { writeFile, mkdir } = await import("node:fs/promises");
    await mkdir(dir, { recursive: true });
    await writeFile(configPath(), JSON.stringify({ token: "only-a-token" }));
    await expect(loadConfig()).rejects.toThrow(/Malformed daemon config/);
  });
});
