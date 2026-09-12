import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { detectCapabilities } from "../src/capabilities.js";
import { resolveAcpLaunch } from "../src/execution.js";
import {
  heldAccounts,
  installTool,
  installedTools,
  loggedIn,
  managedInstallationId,
  managedVersion,
  packageName,
  readToolManifestSync,
  toolsDir,
  uninstallTool,
} from "../src/tools.js";

let configDir: string;

beforeEach(async () => {
  configDir = await mkdtemp(join(tmpdir(), "rainver-host-tools-"));
  process.env.RAINVER_HOST_CONFIG_DIR = configDir;
});

afterEach(async () => {
  delete process.env.RAINVER_HOST_CONFIG_DIR;
  await rm(configDir, { recursive: true, force: true });
});

const LOGIN = { command: ["goose", "login"], home_subdir: ".goose", credential_file: "auth.json" };

async function writeManifest(adapterType: string, version: string, command: string, login = LOGIN) {
  const dir = join(toolsDir(), adapterType, version);
  await mkdir(join(dir, "home"), { recursive: true });
  await writeFile(join(dir, "manifest.json"), JSON.stringify({
    adapter_type: adapterType, version, command, args: ["acp"], env: { TOOL_HOME: dir }, home: join(dir, "home"),
    login_command: [command, "login"], login, installed_at: "2026-08-26T00:00:00.000Z",
  }));
  return dir;
}

describe("managed installations", () => {
  it("names installations and rejects anything that could leave the tools directory", () => {
    expect(managedInstallationId("1.2.3")).toBe("managed:1.2.3");
    expect(managedVersion("managed:1.2.3")).toBe("1.2.3");
    expect(managedVersion("own")).toBeNull();
    expect(managedVersion("managed:../x")).toBeNull();
    expect(packageName("@scope/name@1.2.3")).toBe("@scope/name");
    expect(packageName("name")).toBe("name");
  });

  it("launches a managed copy from its manifest with its own HOME, and refuses one that is not installed", async () => {
    const dir = await writeManifest("acp_goose", "1.2.3", "/opt/goose/bin/goose");
    expect(readToolManifestSync("acp_goose", "managed:1.2.3")?.command).toBe("/opt/goose/bin/goose");
    expect(resolveAcpLaunch("acp_goose", ["--cwd", "/w"], "managed:1.2.3")).toEqual({
      command: "/opt/goose/bin/goose",
      args: ["acp", "--cwd", "/w"],
      env: { TOOL_HOME: dir, HOME: join(dir, "home") },
    });
    expect(() => resolveAcpLaunch("acp_goose", [], "managed:9.9.9")).toThrow(/not have acp_goose managed:9.9.9 installed/);
    // A builtin's command name is its ACP adapter package, not its adapter
    // type; the managed copy is found by the adapter type the frame names.
    await writeManifest("claude_code", "0.70.0", "/node");
    expect(resolveAcpLaunch("claude-agent-acp", [], "managed:0.70.0", "claude_code").command).toBe("/node");
    expect(() => resolveAcpLaunch("claude-agent-acp", [], "managed:0.70.0")).toThrow(/not have claude-agent-acp/);
    // `own` is untouched by the tools directory.
    expect(resolveAcpLaunch("opencode", ["acp"])).toEqual({ command: "opencode", args: ["acp"], env: {} });
  });

  it("reports every copy with its login state, and a managed-only runtime under its adapter type", async () => {
    const dir = await writeManifest("acp_goose", "1.2.3", "/opt/goose/bin/goose");
    await mkdir(join(toolsDir(), "half", "0.1"), { recursive: true }); // no manifest: not installed
    expect([...(await installedTools()).keys()]).toEqual(["acp_goose"]);
    expect(loggedIn(join(dir, "home"), LOGIN)).toBe(false);
    await mkdir(join(dir, "home", ".goose"), { recursive: true });
    await writeFile(join(dir, "home", ".goose", "auth.json"), "{}");
    expect(loggedIn(join(dir, "home"), LOGIN)).toBe(true);
    expect(loggedIn(join(dir, "home"), null)).toBeNull();

    const capabilities = await detectCapabilities(undefined, [
      { adapter_type: "acp_goose", runtime: null, login: LOGIN },
      { adapter_type: "acp_other", runtime: null, login: null },
    ]);
    // `rollback_version: null` because this is the first version installed:
    // there is nothing behind it to undo an upgrade to (ADR 0016 §9).
    expect(capabilities.installations).toEqual({
      acp_goose: [{ id: "managed:1.2.3", version: "1.2.3", runtime_version: null, logged_in: true, options: null, rollback_version: null }],
    });
    // A managed copy is not a PATH binary; it exists only under its adapter.
    expect(capabilities.runtimes).not.toContain("acp_goose");
    expect(capabilities.installations.acp_other).toBeUndefined();
  });

  it("refuses an adapter or version that could escape the tools directory, and removes what it installed", async () => {
    // The wire shape is the contract's (`HostServerFrameSchema`); what stays
    // here is the path policy, which no schema can know.
    await expect(installTool({
      request_id: "r1", adapter_type: "../x", version: "1",
      distribution: { kind: "npx", package: "goose@1", args: [], env: {} }, login: LOGIN,
    }, () => {})).rejects.toThrow(/Unusable adapter or version/);

    await writeManifest("acp_goose", "1.2.3", "/opt/goose/bin/goose");
    expect(await uninstallTool({ request_id: "r2", adapter_type: "acp_goose", version: "1.2.3" })).toBe(true);
    expect(await uninstallTool({ request_id: "r2", adapter_type: "acp_goose", version: "1.2.3" })).toBe(false);
    expect((await installedTools()).size).toBe(0);
  });
});

describe("held accounts", () => {
  const LOGIN = { command: ["opencode", "auth", "login"], home_subdir: ".local/share/opencode", credential_file: "auth.json", accounts_format: "json_object_by_provider" as const };

  it("lists provider ids and credential kinds from a multi-account credential file, never the secrets", async () => {
    const home = join(configDir, "home");
    await mkdir(join(home, ".local/share/opencode"), { recursive: true });
    await writeFile(join(home, ".local/share/opencode/auth.json"), JSON.stringify({
      yitang: { type: "api", key: "sk-secret" },
      anthropic: { type: "oauth", access: "tok", refresh: "tok" },
      odd: "not-an-object",
    }));
    expect(heldAccounts(home, LOGIN)).toEqual([
      { id: "yitang", kind: "api" },
      { id: "anthropic", kind: "oauth" },
      { id: "odd", kind: "unknown" },
    ]);
    expect(JSON.stringify(heldAccounts(home, LOGIN))).not.toContain("sk-secret");
  });

  it("is absent for a single-account CLI and empty when the file is missing or unreadable", async () => {
    const home = join(configDir, "home2");
    expect(heldAccounts(home, { ...LOGIN, accounts_format: undefined })).toBeUndefined();
    expect(heldAccounts(home, LOGIN)).toEqual([]);
    await mkdir(join(home, ".local/share/opencode"), { recursive: true });
    await writeFile(join(home, ".local/share/opencode/auth.json"), "{ not json");
    expect(heldAccounts(home, LOGIN)).toEqual([]);
  });
});
