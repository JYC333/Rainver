import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { platform } from "node:os";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openLoginSession, resolveLoginCommand } from "../src/login.js";
import { toolsDir } from "../src/tools.js";

let configDir: string;
const LOGIN = { command: ["goose", "login"], home_subdir: ".goose", credential_file: "auth.json" };

beforeEach(async () => {
  configDir = await mkdtemp(join(tmpdir(), "rainver-host-login-"));
  process.env.RAINVER_HOST_CONFIG_DIR = configDir;
});
afterEach(async () => {
  delete process.env.RAINVER_HOST_CONFIG_DIR;
  await rm(configDir, { recursive: true, force: true });
});

const hasScript = platform() !== "win32" && spawnSync("script", ["--version"], { encoding: "utf8" }).status !== null;

describe("login sessions", () => {
  it("logs the machine's own copy in as the machine, and a managed copy inside its own HOME", async () => {
    const own = resolveLoginCommand({ session_id: "s", adapter_type: "acp_goose", installation: "own", login: LOGIN });
    expect(own.command).toEqual(["goose", "login"]);
    expect(own.env.HOME).toBe(process.env.HOME);

    const dir = join(toolsDir(), "acp_goose", "1.2.3");
    await mkdir(join(dir, "home"), { recursive: true });
    await writeFile(join(dir, "manifest.json"), JSON.stringify({
      adapter_type: "acp_goose", version: "1.2.3", command: "/opt/goose", args: [], env: { GOOSE_X: "1" }, home: join(dir, "home"),
      login_command: ["/opt/goose", "login"], login: LOGIN, installed_at: "",
    }));
    const managed = resolveLoginCommand({ session_id: "s", adapter_type: "acp_goose", installation: "managed:1.2.3", login: null });
    expect(managed.command).toEqual(["/opt/goose", "login"]);
    expect(managed.env).toMatchObject({ HOME: join(dir, "home"), GOOSE_X: "1" });
    expect(managed.login).toEqual(LOGIN);

    // No declared method must fail closed: a login endpoint is never a remote
    // shell on the host, even inside a managed copy's HOME.
    await writeFile(join(dir, "manifest.json"), JSON.stringify({
      adapter_type: "acp_goose", version: "1.2.3", command: "/opt/goose", args: [], env: {}, home: join(dir, "home"),
      login_command: null, login: null, installed_at: "",
    }));
    expect(() => resolveLoginCommand({ session_id: "s", adapter_type: "acp_goose", installation: "managed:1.2.3", login: null })).toThrow(/does not declare/);
    expect(() => resolveLoginCommand({ session_id: "s", adapter_type: "acp_goose", installation: "own", login: null })).toThrow(/does not declare/);
    expect(() => resolveLoginCommand({ session_id: "s", adapter_type: "acp_goose", installation: "managed:9", login: null })).toThrow(/not have/);
  });

  it("appends terminal-auth arguments and environment to the installed ACP command", async () => {
    const dir = join(toolsDir(), "registry_agent", "2.0.0");
    await mkdir(join(dir, "home"), { recursive: true });
    await writeFile(join(dir, "manifest.json"), JSON.stringify({
      adapter_type: "registry_agent", version: "2.0.0", command: "/opt/agent", args: ["acp"], env: { BASE: "yes" }, home: join(dir, "home"),
      login_command: null, login: null, installed_at: "",
    }));
    const resolved = resolveLoginCommand({
      session_id: "terminal", adapter_type: "registry_agent", installation: "managed:2.0.0", login: null,
      auth_method: { id: "device", name: "Device", description: null, type: "terminal", args: ["login", "--device"], env: { AUTH: "1" } },
    });
    expect(resolved.command).toEqual(["/opt/agent", "acp", "login", "--device"]);
    expect(resolved.env).toMatchObject({ BASE: "yes", AUTH: "1", HOME: join(dir, "home") });

    const own = resolveLoginCommand({
      session_id: "own-terminal", adapter_type: "registry_agent", installation: "own", login: null, argv: ["git", "status"],
      auth_method: { id: "device", name: "Device", description: null, type: "terminal", args: ["login"], env: { AUTH: "own" } },
    });
    expect(own.command).toEqual(["git", "status", "login"]);
    expect(own.env).toMatchObject({ AUTH: "own", HOME: process.env.HOME });

    const fixed = resolveLoginCommand({
      session_id: "fixed", adapter_type: "registry_agent", installation: "managed:2.0.0", login: null,
      // This action carries no remotely programmable argv or environment;
      // the daemon reconstructs the fixed command from its local manifest.
      login_action: "cli",
    });
    expect(fixed.command).toEqual(["/opt/agent", "login"]);
    expect(fixed.env.UNTRUSTED).toBeUndefined();
  });

  it("performs protocol-driven Agent Auth using an advertised method id", async () => {
    const frames: Record<string, unknown>[] = [];
    const logs: string[] = [];
    const dir = join(toolsDir(), "registry_agent", "3.0.0");
    const home = join(dir, "home");
    await mkdir(home, { recursive: true });
    const initialized = JSON.stringify({ jsonrpc: "2.0", id: 1, result: { authMethods: [{ id: "browser", name: "Browser login" }] } });
    const authenticated = JSON.stringify({ jsonrpc: "2.0", id: 2, result: {} });
    await writeFile(join(dir, "manifest.json"), JSON.stringify({
      adapter_type: "registry_agent", version: "3.0.0", command: "/bin/sh",
      args: ["-c", `printf '%s\\n' '${initialized}'; sleep 0.1; printf '%s\\n' '${authenticated}'; sleep 10`], env: {}, home,
      login_command: null, login: null, installed_at: "",
    }));
    openLoginSession({
      session_id: "agent", adapter_type: "registry_agent", installation: "managed:3.0.0", login: null,
      auth_method: { id: "browser", name: "Browser login", description: null, type: "agent", args: [], env: {} },
    }, frame => frames.push(frame), line => logs.push(line));
    await waitFor(() => frames.some(frame => frame.type === "login_exit"));
    expect(logs).toContain("ACP authenticate registry_agent managed:3.0.0: browser");
    expect(frames).toContainEqual(expect.objectContaining({ type: "login_output", data: expect.stringContaining("Browser login") }));
    expect(frames).toContainEqual({ type: "login_exit", session_id: "agent", exit_code: 0, logged_in: true });
  });


  it.skipIf(!hasScript)("runs the login on a PTY, relays typed input, and reports the login state on exit", async () => {
    const frames: Record<string, unknown>[] = [];
    const home = join(configDir, "home");
    await mkdir(home, { recursive: true });
    // A fake vendor login: reads a code, then writes its credential file.
    const login = { command: ["sh", "-c", `printf 'code? '; read -r code; mkdir -p "$HOME/.fake" && echo "$code" > "$HOME/.fake/auth.json"; echo done:$code`], home_subdir: ".fake", credential_file: "auth.json" };
    const saved = process.env.HOME;
    process.env.HOME = home;
    try {
      const session = openLoginSession({ session_id: "s1", adapter_type: "fake", installation: "own", login }, (frame) => frames.push(frame), () => {});
      await waitFor(() => frames.some((frame) => frame.type === "login_output" && String(frame.data).includes("code?")));
      session.write("abc\n");
      await waitFor(() => frames.some((frame) => frame.type === "login_exit"));
    } finally {
      process.env.HOME = saved;
    }
    const output = frames.filter((frame) => frame.type === "login_output").map((frame) => frame.data).join("");
    expect(output).toContain("done:abc");
    expect(frames.find((frame) => frame.type === "login_exit")).toMatchObject({ session_id: "s1", exit_code: 0, logged_in: true });
  }, 20_000);
});

async function waitFor(condition: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("timed out");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}
