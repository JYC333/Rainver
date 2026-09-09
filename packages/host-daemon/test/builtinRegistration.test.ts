import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { adoptBuiltinCredential } from "../src/builtinRegistration.js";
import { loadConfig, saveConfig } from "../src/config.js";

let configDir: string;
let credentialDir: string;
let credentialPath: string;

beforeEach(async () => {
  configDir = await mkdtemp(join(tmpdir(), "rainver-builtin-config-"));
  credentialDir = await mkdtemp(join(tmpdir(), "rainver-builtin-credential-"));
  credentialPath = join(credentialDir, "registration.json");
  process.env.RAINVER_HOST_CONFIG_DIR = configDir;
});

afterEach(async () => {
  delete process.env.RAINVER_HOST_CONFIG_DIR;
  delete process.env.RAINVER_BUILTIN_HOST_CREDENTIAL;
  await rm(configDir, { recursive: true, force: true });
  await rm(credentialDir, { recursive: true, force: true });
});

async function publish(credential: Record<string, unknown>): Promise<void> {
  await mkdir(credentialDir, { recursive: true });
  await writeFile(credentialPath, JSON.stringify(credential));
  process.env.RAINVER_BUILTIN_HOST_CREDENTIAL = credentialPath;
}

describe("adopting the built-in host credential", () => {
  it("does nothing on a paired machine, where no credential path is configured", async () => {
    expect(await adoptBuiltinCredential()).toBe("not_builtin");
    expect(await loadConfig()).toBeNull();
  });

  it("waits rather than failing while the control plane has not published one yet", async () => {
    process.env.RAINVER_BUILTIN_HOST_CREDENTIAL = credentialPath;
    // The container can start before the server has written the file; a daemon
    // that treated this as fatal would need a manual restart to ever come up.
    expect(await adoptBuiltinCredential()).toBe("unavailable");
    expect(await loadConfig()).toBeNull();
  });

  it("registers as a strict host, and is idempotent on the next reconnect", async () => {
    await publish({ server_url: "http://server:8010/", host_id: "host-server", token: "tok-1" });
    expect(await adoptBuiltinCredential()).toBe("adopted");
    expect(await loadConfig()).toEqual({
      // Normalized on the way in, like every other server URL this daemon holds.
      server_url: "http://server:8010",
      host_id: "host-server",
      token: "tok-1",
      trust: "strict",
      workspaces: {},
    });
    expect(await adoptBuiltinCredential()).toBe("unchanged");
  });

  it("picks up a rotated token and keeps the workspaces it had for that host", async () => {
    await saveConfig({
      server_url: "http://server:8010",
      host_id: "host-server",
      token: "tok-1",
      trust: "strict",
      workspaces: { "location-1": "/runner/workspaces/project" },
    });
    await publish({ server_url: "http://server:8010", host_id: "host-server", token: "tok-2" });
    expect(await adoptBuiltinCredential()).toBe("adopted");
    const config = await loadConfig();
    expect(config?.token).toBe("tok-2");
    // The row is the same host; its path map is this daemon's own and has
    // nothing to do with the credential being reissued.
    expect(config?.workspaces).toEqual({ "location-1": "/runner/workspaces/project" });
  });

  it("drops the path map when the credential names a different host row", async () => {
    await saveConfig({
      server_url: "http://server:8010",
      host_id: "host-old",
      token: "tok-1",
      trust: "strict",
      workspaces: { "location-1": "/runner/workspaces/project" },
    });
    await publish({ server_url: "http://server:8010", host_id: "host-new", token: "tok-2" });
    expect(await adoptBuiltinCredential()).toBe("adopted");
    expect((await loadConfig())?.workspaces).toEqual({});
  });

  it("reports an unusable credential without adopting it", async () => {
    await publish({ server_url: "http://server:8010", host_id: "host-server" });
    const lines: string[] = [];
    expect(await adoptBuiltinCredential((line) => lines.push(line))).toBe("unavailable");
    expect(lines.join("\n")).toMatch(/unusable/);
    expect(await loadConfig()).toBeNull();
  });
});
