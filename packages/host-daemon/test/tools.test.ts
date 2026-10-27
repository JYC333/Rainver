import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

const LOGIN = { command: ["goose", "login"] };
const STATE = { env: {}, home_subdir: ".goose", credential_file: "auth.json" };

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
  it("restores the previous uv installation when its replacement directory cannot be initialized", async () => {
    const dir = await writeManifest("acp_fake", "1.0.0", "/previous/runtime");
    const original = fs.promises.mkdir;
    const fail = vi.spyOn(fs.promises, "mkdir").mockImplementation(async (path, options) => {
      if (path === dir) throw Object.assign(new Error("staging I/O failure"), { code: "EIO" });
      return original(path, options as Parameters<typeof original>[1]);
    });
    syncBuiltinESMExports();
    try {
      await expect(installTool({ request_id: "replace", runtime_key: "acp_fake", version: "1.0.0",
        distribution: { kind: "uvx", package: "fake-agent@1.0.0", args: [], env: {} }, login: null,
      }, () => {})).rejects.toThrow("staging I/O failure");
      expect(readToolManifestSync("acp_fake", "managed:1.0.0")?.command).toBe("/previous/runtime");
      expect(await readdir(join(toolsDir(), "acp_fake"))).toEqual(["1.0.0"]);
    } finally {
      fail.mockRestore();
      syncBuiltinESMExports();
    }
  });
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
    expect(loggedIn(home, STATE)).toBe(false);
    await mkdir(join(home, ".goose"), { recursive: true });
    await writeFile(join(home, ".goose", "auth.json"), "{}");
    expect(loggedIn(home, STATE)).toBe(true);
    expect(loggedIn(home, null)).toBeNull();

    const capabilities = await detectCapabilities(undefined, [
      { runtime_key: "acp_goose", runtime: null, login: LOGIN, state: STATE },
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

  it("still reports a managed copy when the machine's own copy is held back", async () => {
    await writeManifest("acp_goose", "1.2.3", "/opt/goose/bin/goose");
    // An own copy that is on PATH, but whose packaged adapter could not be
    // installed: only that copy is unusable, not the managed one beside it.
    const capabilities = await detectCapabilities(
      undefined,
      [{ runtime_key: "acp_goose", runtime: process.execPath, login: LOGIN, state: STATE }],
      async () => false,
    );
    expect(capabilities.installations.acp_goose?.map((installation) => installation.id)).toEqual(["managed:1.2.3"]);
    expect(capabilities.runtimes).not.toContain(process.execPath);
  });

  it.skipIf(process.platform === "win32")("leaves a uv tool runnable at its final path", async () => {
    // A stand-in for `uv tool install`: like the real one it writes the venv
    // under UV_TOOL_DIR and links the entry point into UV_TOOL_BIN_DIR by
    // absolute path, so a directory renamed after the install strands it.
    const fakeBin = join(configDir, "fake-bin");
    await mkdir(fakeBin, { recursive: true });
    await writeFile(join(fakeBin, "uv"), [
      "#!/bin/sh",
      "set -e",
      'mkdir -p "$UV_TOOL_DIR/fake-agent/bin" "$UV_TOOL_BIN_DIR"',
      'printf \'#!/bin/sh\\necho fake-agent ok\\n\' > "$UV_TOOL_DIR/fake-agent/bin/fake-agent"',
      'chmod +x "$UV_TOOL_DIR/fake-agent/bin/fake-agent"',
      'ln -sf "$UV_TOOL_DIR/fake-agent/bin/fake-agent" "$UV_TOOL_BIN_DIR/fake-agent"',
      "",
    ].join("\n"), { mode: 0o755 });
    const savedPath = process.env.PATH;
    process.env.PATH = `${fakeBin}:${savedPath ?? ""}`;
    try {
      for (const attempt of ["install", "reinstall"]) {
        const manifest = await installTool({
          request_id: attempt, runtime_key: "acp_fake", version: "1.0.0",
          distribution: { kind: "uvx", package: "fake-agent@1.0.0", args: [], env: {} },
          login: null,
        }, () => {});
        expect(manifest.command).toBe(join(toolsDir(), "acp_fake", "1.0.0", "bin", "fake-agent"));
        expect(execFileSync(manifest.command, { encoding: "utf8" }).trim()).toBe("fake-agent ok");
      }
      const manifestPath = join(toolsDir(), "acp_fake", "1.0.0", "manifest.json");
      const originalWrite = fs.promises.writeFile;
      let writes = 0;
      const fail = vi.spyOn(fs.promises, "writeFile").mockImplementation(async (path, data, options) => {
        if (path === manifestPath && ++writes === 2) throw new Error("final manifest I/O failure");
        return originalWrite(path, data, options);
      });
      syncBuiltinESMExports();
      try {
        await expect(installTool({ request_id: "failed-reinstall", runtime_key: "acp_fake", version: "1.0.0",
          distribution: { kind: "uvx", package: "fake-agent@1.0.0", args: [], env: {} }, login: null,
        }, () => {})).rejects.toThrow("final manifest I/O failure");
        const previous = readToolManifestSync("acp_fake", "managed:1.0.0")!;
        expect(execFileSync(previous.command, { encoding: "utf8" }).trim()).toBe("fake-agent ok");
      } finally {
        fail.mockRestore();
        syncBuiltinESMExports();
      }
      expect(await readdir(join(toolsDir(), "acp_fake"))).toEqual(["1.0.0"]);
    } finally {
      process.env.PATH = savedPath;
    }
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
  const STATE = { env: {}, home_subdir: ".local/share/opencode", credential_file: "auth.json", accounts_format: "json_object_by_provider" as const };

  it("lists provider ids and credential kinds from a multi-account credential file, never the secrets", async () => {
    const home = join(configDir, "home");
    await mkdir(join(home, ".local/share/opencode"), { recursive: true });
    await writeFile(join(home, ".local/share/opencode/auth.json"), JSON.stringify({
      yitang: { type: "api", key: "sk-secret" },
      anthropic: { type: "oauth", access: "tok", refresh: "tok" },
      odd: "not-an-object",
    }));
    expect(heldAccounts(home, STATE)).toEqual([
      { id: "yitang", kind: "api" },
      { id: "anthropic", kind: "oauth" },
      { id: "odd", kind: "unknown" },
    ]);
    expect(JSON.stringify(heldAccounts(home, STATE))).not.toContain("sk-secret");
  });

  it("is absent for a single-account CLI and empty when the file is missing or unreadable", async () => {
    const home = join(configDir, "home2");
    expect(heldAccounts(home, { ...STATE, accounts_format: undefined })).toBeUndefined();
    expect(heldAccounts(home, STATE)).toEqual([]);
    await mkdir(join(home, ".local/share/opencode"), { recursive: true });
    await writeFile(join(home, ".local/share/opencode/auth.json"), "{ not json");
    expect(heldAccounts(home, STATE)).toEqual([]);
  });
});
