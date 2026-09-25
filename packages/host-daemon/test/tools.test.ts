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
  managedToolTree,
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

async function writeManifest(runtimeKey: string, version: string, command: string, login = LOGIN) {
  const dir = join(toolsDir(), runtimeKey, version);
  const home = join(configDir, "managed-state", runtimeKey, "home");
  await mkdir(dir, { recursive: true });
  await mkdir(home, { recursive: true });
  await writeFile(join(dir, "manifest.json"), JSON.stringify({
    runtime_key: runtimeKey, version, command, args: ["acp"], env: { TOOL_HOME: dir }, home,
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
    expect(managedToolTree("codex_cli", "managed:1.2.3")).toBe(join(toolsDir(), "codex_cli", "1.2.3"));
    expect(managedToolTree("codex_cli", "own")).toBeNull();
    expect(managedToolTree("../codex_cli", "managed:1.2.3")).toBeNull();
    expect(packageName("@scope/name@1.2.3")).toBe("@scope/name");
    expect(packageName("name")).toBe("name");
  });

  it("launches a managed copy from its manifest with its own HOME, and refuses one that is not installed", async () => {
    const dir = await writeManifest("acp_goose", "1.2.3", "/opt/goose/bin/goose");
    expect(readToolManifestSync("acp_goose", "managed:1.2.3")?.command).toBe("/opt/goose/bin/goose");
    expect(resolveAcpLaunch("acp_goose", ["--cwd", "/w"], "managed:1.2.3")).toEqual({
      command: "/opt/goose/bin/goose",
      args: ["acp", "--cwd", "/w"],
      env: { TOOL_HOME: dir, HOME: join(configDir, "managed-state", "acp_goose", "home") },
    });
    // The manifest and the own-copy template can name the same ACP entrypoint.
    // The managed copy must receive that entrypoint exactly once on Runs and probes.
    expect(resolveAcpLaunch("acp_goose", ["acp", "--cwd", "/w"], "managed:1.2.3")).toEqual({
      command: "/opt/goose/bin/goose",
      args: ["acp", "--cwd", "/w"],
      env: { TOOL_HOME: dir, HOME: join(configDir, "managed-state", "acp_goose", "home") },
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

  it("reads a manifest only when it names runtime_key, and only the key its path declares", async () => {
    const dir = join(toolsDir(), "acp_goose", "1.2.3");
    const home = join(configDir, "managed-state", "acp_goose", "home");
    await mkdir(dir, { recursive: true });
    await mkdir(home, { recursive: true });
    const manifestPath = join(dir, "manifest.json");
    const manifest = {
      runtime_key: "acp_goose", version: "1.2.3", command: "/opt/goose/bin/goose",
      args: ["acp"], env: {}, home, login_command: null, login: null,
      installed_at: "2026-08-26T00:00:00.000Z",
    };
    await writeFile(manifestPath, JSON.stringify(manifest));
    expect(readToolManifestSync("acp_goose", "managed:1.2.3")).toMatchObject({ runtime_key: "acp_goose" });

    // `runtime_key` is the only identity on this wire: a manifest that names
    // the runtime under any other field is unreadable, not aliased.
    const { runtime_key: runtimeKey, ...withoutRuntimeKey } = manifest;
    await writeFile(manifestPath, JSON.stringify({ ...withoutRuntimeKey, adapter_type: runtimeKey }));
    expect(readToolManifestSync("acp_goose", "managed:1.2.3")).toBeNull();

    await writeFile(manifestPath, JSON.stringify({ ...manifest, runtime_key: "other_runtime" }));
    expect(readToolManifestSync("acp_goose", "managed:1.2.3")).toBeNull();
  });

  it("reports every copy with its login state, and a managed-only runtime under its adapter type", async () => {
    await writeManifest("acp_goose", "1.2.3", "/opt/goose/bin/goose");
    const home = join(configDir, "managed-state", "acp_goose", "home");
    await mkdir(join(toolsDir(), "half", "0.1"), { recursive: true }); // no manifest: not installed
    expect([...(await installedTools()).keys()]).toEqual(["acp_goose"]);
    expect(loggedIn(home, LOGIN)).toBe(false);
    await mkdir(join(home, ".goose"), { recursive: true });
    await writeFile(join(home, ".goose", "auth.json"), "{}");
    expect(loggedIn(home, LOGIN)).toBe(true);
    expect(loggedIn(home, null)).toBeNull();

    const capabilities = await detectCapabilities(undefined, [
      { runtime_key: "acp_goose", runtime: null, login: LOGIN },
      { runtime_key: "acp_other", runtime: null, login: null },
    ]);
    // `rollback_version: null` because this is the first version installed:
    // there is nothing behind it to undo an upgrade to (ADR 0016 §9).
    expect(capabilities.installations).toEqual({
      acp_goose: [{
        id: "managed:1.2.3",
        version: "1.2.3",
        runtime_version: null,
        health_check_protocol: null,
        logged_in: true,
        options: null,
        rollback_version: null,
      }],
    });
    // A managed copy is not a PATH binary; it exists only under its adapter.
    expect(capabilities.runtimes).not.toContain("acp_goose");
    expect(capabilities.installations.acp_other).toBeUndefined();
  });

  it("refuses a runtime key or version that could escape the tools directory, and removes what it installed", async () => {
    // The wire shape is the contract's (`HostServerFrameSchema`); what stays
    // here is the path policy, which no schema can know.
    await expect(installTool({
      request_id: "r1", runtime_key: "../x", version: "1",
      distribution: { kind: "npx", package: "goose@1", args: [], env: {} }, login: LOGIN,
    }, () => {})).rejects.toThrow(/Unusable runtime key or version/);

    await writeManifest("acp_goose", "1.2.3", "/opt/goose/bin/goose");
    expect(await uninstallTool({ request_id: "r2", runtime_key: "acp_goose", version: "1.2.3" })).toBe(true);
    expect(await uninstallTool({ request_id: "r2", runtime_key: "acp_goose", version: "1.2.3" })).toBe(false);
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
