import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { platform } from "node:os";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LOGIN_INPUT_BURST_CHARS, LOGIN_INPUT_SESSION_MAX_CHARS, createLoginInputGovernor, openLoginSession, resolveLoginCommand } from "../src/login.js";
import { LOGIN_INPUT_MAX_CHARS } from "@rainver/protocol";
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

  it("drops leftover vendor credential variables so login cannot bill an API account", () => {
    const previousKey = process.env.ANTHROPIC_API_KEY;
    const previousOauth = process.env.CLAUDE_CODE_OAUTH_TOKEN;
    process.env.ANTHROPIC_API_KEY = "sk-machine";
    process.env.CLAUDE_CODE_OAUTH_TOKEN = "oauth-machine";
    try {
      const own = resolveLoginCommand({
        session_id: "s",
        adapter_type: "claude_code",
        installation: "own",
        login: { command: ["claude", "auth", "login"], home_subdir: ".claude", credential_file: ".credentials.json" },
      });
      expect(own.env.ANTHROPIC_API_KEY).toBeUndefined();
      expect(own.env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
      expect(own.env.HOME).toBe(process.env.HOME);
    } finally {
      if (previousKey === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = previousKey;
      if (previousOauth === undefined) delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
      else process.env.CLAUDE_CODE_OAUTH_TOKEN = previousOauth;
    }
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

describe("logout", () => {
  const SPEC = {
    command: ["opencode", "auth", "login"], managed_command: ["{tree}/opencode", "auth", "login"],
    logout_command: ["opencode", "auth", "logout"], managed_logout_command: ["{tree}/opencode", "auth", "logout"],
    home_subdir: ".local/share/opencode", credential_file: "auth.json",
  };

  it("runs the vendor's logout for the machine's own copy and, inside its tree, for a managed copy", async () => {
    const own = resolveLoginCommand({ session_id: "s", adapter_type: "opencode", installation: "own", login: SPEC, login_action: "logout" });
    expect(own.command).toEqual(["opencode", "auth", "logout"]);
    expect(own.env.HOME).toBe(process.env.HOME);

    const dir = join(toolsDir(), "opencode", "1.0.0");
    await mkdir(join(dir, "home"), { recursive: true });
    await writeFile(join(dir, "manifest.json"), JSON.stringify({
      adapter_type: "opencode", version: "1.0.0", command: join(dir, "opencode"), args: ["acp"], env: {}, home: join(dir, "home"),
      login_command: [join(dir, "opencode"), "auth", "login"], login: SPEC, installed_at: "",
    }));
    const managed = resolveLoginCommand({ session_id: "s", adapter_type: "opencode", installation: "managed:1.0.0", login: null, login_action: "logout" });
    expect(managed.command).toEqual([join(dir, "opencode"), "auth", "logout"]);
    expect(managed.env.HOME).toBe(join(dir, "home"));
  });

  it("uses the fixed entry's `logout` for a registry agent Rainver logs in through `login`, and refuses everything else", async () => {
    const dir = join(toolsDir(), "acp_cursor", "latest");
    await mkdir(join(dir, "home"), { recursive: true });
    await writeFile(join(dir, "manifest.json"), JSON.stringify({
      adapter_type: "acp_cursor", version: "latest", command: join(dir, "cursor-agent"), args: ["acp"], entry_args: [], env: {}, home: join(dir, "home"),
      login_command: null, login: null, installed_at: "",
    }));
    const registry = resolveLoginCommand({ session_id: "s", adapter_type: "acp_cursor", installation: "managed:latest", login: null, login_action: "logout" });
    expect(registry.command).toEqual([join(dir, "cursor-agent"), "logout"]);

    // A spec without a logout command fails closed rather than guessing one.
    const noLogout = { command: ["goose", "login"], home_subdir: ".goose", credential_file: "auth.json" };
    expect(() => resolveLoginCommand({ session_id: "s", adapter_type: "acp_goose", installation: "own", login: noLogout, login_action: "logout" })).toThrow(/logout command/);
    expect(() => resolveLoginCommand({ session_id: "s", adapter_type: "acp_goose", installation: "managed:9", login: null, login_action: "logout" })).toThrow(/not have/);
  });
});

describe("login input governor", () => {
  it("admits typing and a paste of the largest frame the wire allows", () => {
    const admit = createLoginInputGovernor(() => 0);
    expect(admit("a")).toBeNull();
    expect(admit("\u001b[A")).toBeNull();
    expect(admit("x".repeat(LOGIN_INPUT_MAX_CHARS))).toBeNull();
  });

  it("refuses input that outruns the per-second budget and admits again once it refills", () => {
    let clock = 0;
    const admit = createLoginInputGovernor(() => clock);
    // Drain the burst allowance in maximal frames.
    for (let sent = 0; sent < LOGIN_INPUT_BURST_CHARS; sent += LOGIN_INPUT_MAX_CHARS) {
      expect(admit("x".repeat(LOGIN_INPUT_MAX_CHARS))).toBeNull();
    }
    expect(admit("y")).toMatchObject({ fatal: false, reason: expect.stringMatching(/faster than/) });
    clock += 1000;
    expect(admit("y")).toBeNull();
  });

  it("does not drain the bucket when the clock steps backwards", () => {
    let clock = 10_000;
    const admit = createLoginInputGovernor(() => clock);
    expect(admit("a")).toBeNull();
    clock -= 60_000;
    expect(admit("b")).toBeNull();
  });

  it("refuses a session that has received more than its lifetime budget", () => {
    let clock = 0;
    const admit = createLoginInputGovernor(() => clock);
    let sent = 0;
    while (sent < LOGIN_INPUT_SESSION_MAX_CHARS) {
      clock += 1000;
      expect(admit("x".repeat(LOGIN_INPUT_MAX_CHARS))).toBeNull();
      sent += LOGIN_INPUT_MAX_CHARS;
    }
    clock += 1000;
    expect(admit("x")).toMatchObject({ fatal: true, reason: expect.stringMatching(/more than/) });
  });
});
