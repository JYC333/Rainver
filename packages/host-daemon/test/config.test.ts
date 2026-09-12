import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { configPath, loadConfig, normalizeServerUrl, assertPairableServerUrl, removeConfig, requireConfig, saveConfig } from "../src/config.js";
import { runService } from "../src/commands/run.js";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "rainver-host-config-"));
  process.env.RAINVER_HOST_CONFIG_DIR = dir;
});

afterEach(async () => {
  delete process.env.RAINVER_HOST_CONFIG_DIR;
  await rm(dir, { recursive: true, force: true });
});

describe("normalizeServerUrl", () => {
  it("drops trailing slashes so appended API paths do not double up", () => {
    expect(normalizeServerUrl("https://rainver.example/")).toBe("https://rainver.example");
    expect(normalizeServerUrl("https://rainver.example///")).toBe("https://rainver.example");
    expect(normalizeServerUrl("  https://rainver.example \n")).toBe("https://rainver.example");
  });

  it("keeps a path prefix and a port, and discards query and fragment", () => {
    expect(normalizeServerUrl("https://rainver.example/rainver/")).toBe("https://rainver.example/rainver");
    expect(normalizeServerUrl("http://localhost:3000/?x=1#y")).toBe("http://localhost:3000");
  });

  it("rejects anything that is not a plain http(s) origin", () => {
    expect(() => normalizeServerUrl("rainver.example")).toThrow(/Invalid --server URL/);
    expect(() => normalizeServerUrl("ftp://rainver.example")).toThrow(/http:\/\/ or https:\/\//);
    expect(() => normalizeServerUrl("https://user:pw@rainver.example")).toThrow(/credentials/);
  });
});

describe("assertPairableServerUrl", () => {
  it("allows https and loopback http", () => {
    expect(assertPairableServerUrl("https://rainver.example/")).toBe("https://rainver.example");
    expect(assertPairableServerUrl("http://127.0.0.1:8010")).toBe("http://127.0.0.1:8010");
    expect(assertPairableServerUrl("http://localhost:3000")).toBe("http://localhost:3000");
  });

  it("rejects cleartext pairing to a non-loopback host", () => {
    expect(() => assertPairableServerUrl("http://192.168.1.5:8010")).toThrow(/localhost/);
    expect(() => assertPairableServerUrl("http://rainver.example")).toThrow(/localhost/);
    // A name that merely begins `127.` is a hostname somebody else controls
    // and can point anywhere; only an address is loopback.
    expect(() => assertPairableServerUrl("http://127.evil.example")).toThrow(/localhost/);
    expect(() => assertPairableServerUrl("http://127.0.0.1.nip.io")).toThrow(/localhost/);
  });
});

describe("daemon config", () => {
  it("normalizes a stored server_url on load", async () => {
    await saveConfig({ server_url: "https://rainver.example/", host_id: "host-1", token: "t", trust: "trusted", workspaces: {} });
    expect((await loadConfig())?.server_url).toBe("https://rainver.example");
  });
  it("returns null before registration", async () => {
    expect(await loadConfig()).toBeNull();
  });

  it("lets the private daemon exit cleanly when a revoked service has no registration", async () => {
    const lines: string[] = [];
    await expect(runService({ log: (line) => lines.push(line) })).resolves.toBeUndefined();
    expect(lines).toEqual(["not registered; exiting without reconnecting"]);
  });

  it("rejects requireConfig before registration with an actionable message", async () => {
    await expect(requireConfig()).rejects.toThrow(/register --server/);
  });

  it("round-trips a saved config, including the workspace map", async () => {
    await saveConfig({
      server_url: "http://localhost:4000",
      host_id: "host-1",
      token: "secret-token",
      trust: "trusted",
      workspaces: { "folder-1": "/home/user/dev/mapping" },
    });
    const loaded = await loadConfig();
    expect(loaded).toEqual({
      server_url: "http://localhost:4000",
      host_id: "host-1",
      token: "secret-token",
      trust: "trusted",
      workspaces: { "folder-1": "/home/user/dev/mapping" },
    });
    expect(await requireConfig()).toEqual(loaded);
  });

  it("writes the config file with owner-only permissions", async () => {
    await saveConfig({ server_url: "http://localhost:4000", host_id: "host-1", token: "secret-token", trust: "trusted", workspaces: {} });
    const { stat } = await import("node:fs/promises");
    const info = await stat(configPath());
    expect(info.mode & 0o777).toBe(0o600);
  });

  it("removes only the registration config", async () => {
    await saveConfig({ server_url: "http://localhost:4000", host_id: "host-1", token: "secret-token", trust: "trusted", workspaces: {} });
    await removeConfig();
    expect(await loadConfig()).toBeNull();
  });

  it("throws on a malformed config file instead of silently treating it as unregistered", async () => {
    const { writeFile, mkdir } = await import("node:fs/promises");
    await mkdir(dir, { recursive: true });
    await writeFile(configPath(), JSON.stringify({ token: "only-a-token" }));
    await expect(loadConfig()).rejects.toThrow(/Malformed daemon config/);
  });

  async function writeConfig(config: Record<string, unknown>): Promise<void> {
    const { writeFile, mkdir } = await import("node:fs/promises");
    await mkdir(dir, { recursive: true });
    await writeFile(configPath(), JSON.stringify(config));
  }

  it("re-applies the pairing URL rule on every read, not only at pairing time", async () => {
    // The config file is an ordinary file on the owner's machine. One edited
    // after pairing — or written by anything else that can reach the
    // directory — would otherwise send this host's bearer token to a
    // plain-HTTP address off-box on the next start.
    await writeConfig({ server_url: "http://192.168.1.5:8010", host_id: "host-1", token: "t", trust: "trusted", workspaces: {} });
    await expect(loadConfig()).rejects.toThrow(/localhost/);
    await writeConfig({ server_url: "http://127.evil.example", host_id: "host-1", token: "t", trust: "trusted", workspaces: {} });
    await expect(loadConfig()).rejects.toThrow(/localhost/);
  });

  it("does not let the config's own trust field turn that re-check off", async () => {
    // `trust` lives in the file the check distrusts: an edit that pointed
    // `server_url` off-box could set `"trust":"strict"` in the same stroke.
    // The built-in host's exemption is decided by an environment variable set
    // only inside the `sandbox-runner` container instead.
    await writeConfig({ server_url: "http://192.168.1.5:8010", host_id: "host-1", token: "t", trust: "strict", workspaces: {} });
    await expect(loadConfig()).rejects.toThrow(/localhost/);
  });

  it("exempts the built-in host, which adopts a published credential over the Compose network", async () => {
    process.env.RAINVER_BUILTIN_HOST_CREDENTIAL = join(dir, "builtin-credential.json");
    try {
      await writeConfig({ server_url: "http://server:8010/", host_id: "host-1", token: "t", trust: "trusted", workspaces: {} });
      expect((await loadConfig())?.server_url).toBe("http://server:8010");
    } finally {
      delete process.env.RAINVER_BUILTIN_HOST_CREDENTIAL;
    }
  });
});
