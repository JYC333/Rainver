import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { platform } from "node:os";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LOGIN_INPUT_BURST_CHARS, LOGIN_INPUT_SESSION_MAX_CHARS, __setAgentAuthDetachedGraceMsForTests, createLoginInputGovernor, openLoginSession, resolveLoginCommand } from "../src/login.js";
import { LOGIN_INPUT_MAX_CHARS } from "@rainver/protocol";
import { managedToolHome, toolsDir } from "../src/tools.js";
import { withRuntimeKeyDrained } from "../src/execution.js";

let configDir: string;
const LOGIN = { command: ["goose", "login"] };

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
  it("applies the declared update guard only to the login process and still strips provider credentials", () => {
    const before = process.env.DISABLE_AUTOUPDATER;
    const login = { ...LOGIN, env: { DISABLE_AUTOUPDATER: "1", ANTHROPIC_API_KEY: "must-not-reach-login" } };
    const resolved = resolveLoginCommand({ session_id: "guard", runtime_key: "claude_code", installation: "own", login });
    expect(resolved.env.DISABLE_AUTOUPDATER).toBe("1");
    expect(resolved.env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(process.env.DISABLE_AUTOUPDATER).toBe(before);
  });
  it.skipIf(!hasScript).each([false, true])("keeps the CLI intact during login and checks it before reporting success (damaged=%s)", async damaged => {
    const frames: Record<string, unknown>[] = [];
    const dir = join(toolsDir(), "claude_code", "login-guard");
    const home = managedToolHome("claude_code");
    await mkdir(dir, { recursive: true });
    await mkdir(home, { recursive: true });
    const command = join(dir, "fake-claude");
    await writeFile(command, `#!/bin/sh
if [ "$1" = "--version" ]; then
  echo checking > "$HOME/verification-started"
  while [ ! -e "$HOME/verification-allowed" ]; do sleep 0.05; done
  echo '1.2.3 (Test CLI)'; exit 0
fi
mkdir -p "$HOME/.fake"; echo credential > "$HOME/.fake/auth.json"
if [ "$DISABLE_AUTOUPDATER" != "1" ] || [ "${damaged}" = "true" ]; then rm "$0"; fi
exit 1
`, { mode: 0o755 });
    const login = { ...LOGIN, managed_command: ["{tree}/fake-claude", "login"],
      env: { DISABLE_AUTOUPDATER: "1" }, managed_verification_command: ["{tree}/fake-claude", "--version"] };
    const state = { env: {}, home_subdir: ".fake", credential_file: "auth.json" };
    // An existing installation predates the guard; the current server spec applies without reinstalling it.
    await writeFile(join(dir, "manifest.json"), JSON.stringify({ runtime_key: "claude_code", version: "login-guard", command, args: [], env: { DISABLE_AUTOUPDATER: "0" }, home,
      login_command: [command, "login"], login: { ...login, env: undefined }, installed_at: "" }));
    openLoginSession({ session_id: "guarded", runtime_key: "claude_code", installation: "managed:login-guard", login, state }, frame => frames.push(frame), () => {});
    if (!damaged) {
      await waitFor(() => existsSync(join(home, "verification-started")));
      try {
        expect(frames.some(frame => frame.type === "login_exit")).toBe(false);
        await expect(withRuntimeKeyDrained("claude_code", 0, async () => "replaced")).rejects.toThrow(/still using claude_code/);
      } finally { await writeFile(join(home, "verification-allowed"), "ready"); }
    }
    await waitFor(() => frames.some(frame => frame.type === "login_exit"));
    const exit = frames.find(frame => frame.type === "login_exit");
    if (damaged) {
      expect(exit).toMatchObject({ logged_in: null, exit_code: 1 });
      expect(frames).toContainEqual(expect.objectContaining({ type: "login_output", data: expect.stringContaining("runtime program is unavailable") }));
    } else {
      // Claude's interactive login can exit nonzero even after saving credentials.
      expect(exit).toMatchObject({ logged_in: true, exit_code: 1 });
    }
    await expect(withRuntimeKeyDrained("claude_code", 0, async () => "released")).resolves.toBe("released");
  });
  it("logs the machine's own copy in as the machine, and a managed copy inside its own HOME", async () => {
    const own = resolveLoginCommand({ session_id: "s", runtime_key: "acp_goose", installation: "own", login: LOGIN });
    expect(own.command).toEqual(["goose", "login"]);
    expect(own.env.HOME).toBe(process.env.HOME);

    const dir = join(toolsDir(), "acp_goose", "1.2.3");
    const home = managedToolHome("acp_goose");
    await mkdir(dir, { recursive: true });
    await mkdir(home, { recursive: true });
    await writeFile(join(dir, "manifest.json"), JSON.stringify({
      runtime_key: "acp_goose", version: "1.2.3", command: "/opt/goose", args: [], env: { GOOSE_X: "1" }, home,
      login_command: ["/opt/goose", "login"], login: LOGIN, installed_at: "",
    }));
    const managed = resolveLoginCommand({ session_id: "s", runtime_key: "acp_goose", installation: "managed:1.2.3", login: null });
    expect(managed.command).toEqual(["/opt/goose", "login"]);
    expect(managed.env).toMatchObject({ HOME: home, GOOSE_X: "1" });
    expect(managed.login).toEqual(LOGIN);

    // No declared method must fail closed: a login endpoint is never a remote
    // shell on the host, even inside a managed copy's HOME.
    await writeFile(join(dir, "manifest.json"), JSON.stringify({
      runtime_key: "acp_goose", version: "1.2.3", command: "/opt/goose", args: [], env: {}, home,
      login_command: null, login: null, installed_at: "",
    }));
    expect(() => resolveLoginCommand({ session_id: "s", runtime_key: "acp_goose", installation: "managed:1.2.3", login: null })).toThrow(/does not declare/);
    expect(() => resolveLoginCommand({ session_id: "s", runtime_key: "acp_goose", installation: "own", login: null })).toThrow(/does not declare/);
    expect(() => resolveLoginCommand({ session_id: "s", runtime_key: "acp_goose", installation: "managed:9", login: null })).toThrow(/not have/);
  });

  it("drops leftover vendor credential variables so login cannot bill an API account", () => {
    const previousKey = process.env.ANTHROPIC_API_KEY;
    const previousOauth = process.env.CLAUDE_CODE_OAUTH_TOKEN;
    process.env.ANTHROPIC_API_KEY = "sk-machine";
    process.env.CLAUDE_CODE_OAUTH_TOKEN = "oauth-machine";
    try {
      const own = resolveLoginCommand({
        session_id: "s",
        runtime_key: "claude_code",
        installation: "own",
        login: { command: ["claude", "auth", "login"] },
        state: { env: { CLAUDE_CONFIG_DIR: ".claude" }, home_subdir: ".claude", credential_file: ".credentials.json" },
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
    const home = managedToolHome("registry_agent");
    await mkdir(dir, { recursive: true });
    await mkdir(home, { recursive: true });
    await writeFile(join(dir, "manifest.json"), JSON.stringify({
      runtime_key: "registry_agent", version: "2.0.0", command: "/opt/agent", args: ["acp"], env: { BASE: "yes" }, home,
      login_command: null, login: null, installed_at: "",
    }));
    const resolved = resolveLoginCommand({
      session_id: "terminal", runtime_key: "registry_agent", installation: "managed:2.0.0", login: null,
      auth_method: { id: "device", name: "Device", description: null, type: "terminal", args: ["login", "--device"], env: { AUTH: "1" } },
    });
    expect(resolved.command).toEqual(["/opt/agent", "acp", "login", "--device"]);
    expect(resolved.env).toMatchObject({ BASE: "yes", AUTH: "1", HOME: home });

    const own = resolveLoginCommand({
      session_id: "own-terminal", runtime_key: "registry_agent", installation: "own", login: null, argv: ["git", "status"],
      auth_method: { id: "device", name: "Device", description: null, type: "terminal", args: ["login"], env: { AUTH: "own" } },
    });
    expect(own.command).toEqual(["git", "status", "login"]);
    expect(own.env).toMatchObject({ AUTH: "own", HOME: process.env.HOME });

    const fixed = resolveLoginCommand({
      session_id: "fixed", runtime_key: "registry_agent", installation: "managed:2.0.0", login: null,
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
    const home = managedToolHome("registry_agent");
    await mkdir(dir, { recursive: true });
    await mkdir(home, { recursive: true });
    const initialized = JSON.stringify({ jsonrpc: "2.0", id: 1, result: { authMethods: [{ id: "browser", name: "Browser login" }] } });
    const authenticated = JSON.stringify({ jsonrpc: "2.0", id: 2, result: {} });
    await writeFile(join(dir, "manifest.json"), JSON.stringify({
      runtime_key: "registry_agent", version: "3.0.0", command: "/bin/sh",
      args: ["-c", `printf '%s\\n' '${initialized}'; sleep 0.1; printf '%s\\n' '${authenticated}'; sleep 10`], env: {}, home,
      login_command: null, login: null, installed_at: "",
    }));
    openLoginSession({
      session_id: "agent", runtime_key: "registry_agent", installation: "managed:3.0.0", login: null,
      auth_method: { id: "browser", name: "Browser login", description: null, type: "agent", args: [], env: {} },
    }, frame => frames.push(frame), line => logs.push(line));
    await waitFor(() => frames.some(frame => frame.type === "login_exit"));
    expect(logs).toContain("ACP authenticate registry_agent managed:3.0.0: browser");
    expect(frames).toContainEqual(expect.objectContaining({ type: "login_output", data: expect.stringContaining("Browser login") }));
    expect(frames).toContainEqual({ type: "login_exit", session_id: "agent", exit_code: 0, logged_in: true });
  });


  it("holds the runtime copy while an Agent Auth is waiting, so a replacement does not pull it away", async () => {
    const frames: Record<string, unknown>[] = [];
    const dir = join(toolsDir(), "registry_agent", "4.0.0");
    const home = managedToolHome("registry_agent");
    await mkdir(dir, { recursive: true });
    await mkdir(home, { recursive: true });
    const initialized = JSON.stringify({ jsonrpc: "2.0", id: 1, result: { authMethods: [{ id: "browser", name: "Browser login" }] } });
    // Advertises the method, then waits on the browser for as long as it is left.
    await writeFile(join(dir, "manifest.json"), JSON.stringify({
      runtime_key: "registry_agent", version: "4.0.0", command: "/bin/sh",
      args: ["-c", `printf '%s\n' '${initialized}'; exec sleep 30`], env: {}, home,
      login_command: null, login: null, installed_at: "",
    }));
    const session = openLoginSession({
      session_id: "agent-held", runtime_key: "registry_agent", installation: "managed:4.0.0", login: null,
      auth_method: { id: "browser", name: "Browser login", description: null, type: "agent", args: [], env: {} },
    }, frame => frames.push(frame), () => {});
    try {
      await expect(withRuntimeKeyDrained("registry_agent", 0, async () => "replaced")).rejects.toThrow(/still using registry_agent/);
    } finally {
      // No grace here: the test is about the hold, not the detached wait.
      __setAgentAuthDetachedGraceMsForTests(0);
      session.close();
      __setAgentAuthDetachedGraceMsForTests(null);
    }
    await waitFor(() => frames.some(frame => frame.type === "login_exit"));
    await expect(withRuntimeKeyDrained("registry_agent", 0, async () => "replaced")).resolves.toBe("replaced");
  });

  it("lets an Agent Auth login finish after the client left, and reports it", async () => {
    // The browser round trip (Antigravity's Google OAuth redirect) lands on a
    // loopback port of the agent process; killing it when the page is left
    // made the redirect fail. The session keeps waiting within the grace.
    const frames: Record<string, unknown>[] = [];
    const logs: string[] = [];
    const dir = join(toolsDir(), "registry_agent", "5.0.0");
    const home = managedToolHome("registry_agent");
    await mkdir(dir, { recursive: true });
    await mkdir(home, { recursive: true });
    const initialized = JSON.stringify({ jsonrpc: "2.0", id: 1, result: { authMethods: [{ id: "browser", name: "Browser login" }] } });
    const authenticated = JSON.stringify({ jsonrpc: "2.0", id: 2, result: {} });
    await writeFile(join(dir, "manifest.json"), JSON.stringify({
      runtime_key: "registry_agent", version: "5.0.0", command: "/bin/sh",
      args: ["-c", `printf '%s\\n' '${initialized}'; sleep 0.6; printf '%s\\n' '${authenticated}'; sleep 10`], env: {}, home,
      login_command: null, login: null, installed_at: "",
    }));
    const session = openLoginSession({
      session_id: "agent-detached", runtime_key: "registry_agent", installation: "managed:5.0.0", login: null,
      auth_method: { id: "browser", name: "Browser login", description: null, type: "agent", args: [], env: {} },
    }, frame => frames.push(frame), line => logs.push(line));
    await waitFor(() => logs.some(line => line.includes("ACP authenticate registry_agent")));
    session.close();
    await waitFor(() => frames.some(frame => frame.type === "login_exit"), 5_000);
    expect(logs).toContainEqual(expect.stringContaining("client left; waiting up to 300s"));
    expect(frames).toContainEqual({ type: "login_exit", session_id: "agent-detached", exit_code: 0, logged_in: true });
  });

  it("gives up a detached Agent Auth login when the grace runs out", async () => {
    const frames: Record<string, unknown>[] = [];
    const dir = join(toolsDir(), "registry_agent", "6.0.0");
    const home = managedToolHome("registry_agent");
    await mkdir(dir, { recursive: true });
    await mkdir(home, { recursive: true });
    const initialized = JSON.stringify({ jsonrpc: "2.0", id: 1, result: { authMethods: [{ id: "browser", name: "Browser login" }] } });
    await writeFile(join(dir, "manifest.json"), JSON.stringify({
      runtime_key: "registry_agent", version: "6.0.0", command: "/bin/sh",
      args: ["-c", `printf '%s\\n' '${initialized}'; exec sleep 30`], env: {}, home,
      login_command: null, login: null, installed_at: "",
    }));
    __setAgentAuthDetachedGraceMsForTests(200);
    try {
      const session = openLoginSession({
        session_id: "agent-expired", runtime_key: "registry_agent", installation: "managed:6.0.0", login: null,
        auth_method: { id: "browser", name: "Browser login", description: null, type: "agent", args: [], env: {} },
      }, frame => frames.push(frame), () => {});
      await new Promise(resolve => setTimeout(resolve, 100));
      session.close();
      await waitFor(() => frames.some(frame => frame.type === "login_exit"), 5_000);
      expect(frames.find(frame => frame.type === "login_exit")).toMatchObject({ session_id: "agent-expired", logged_in: false });
    } finally {
      __setAgentAuthDetachedGraceMsForTests(null);
    }
  });

  it("announces the loopback redirect an Agent Auth login waits for and delivers a pasted callback to it", async () => {
    // Google's loopback flow: the agent prints an authorization URL whose
    // redirect_uri is 127.0.0.1:<port> on this host. A browser elsewhere
    // lands on an address it cannot open; pasted here, the daemon makes that
    // request locally — the path and query exactly as the browser had them.
    const { createServer } = await import("node:http");
    const received: string[] = [];
    const server = createServer((request, response) => { received.push(request.url ?? ""); response.end("ok"); });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as { port: number }).port;
    const frames: Record<string, unknown>[] = [];
    const dir = join(toolsDir(), "registry_agent", "7.0.0");
    const home = managedToolHome("registry_agent");
    await mkdir(dir, { recursive: true });
    await mkdir(home, { recursive: true });
    const initialized = JSON.stringify({ jsonrpc: "2.0", id: 1, result: { authMethods: [{ id: "oauth-personal", name: "Log in with Google" }] } });
    const authorize = `https://accounts.example/o/oauth2/auth?client_id=c&redirect_uri=http%3A%2F%2F127.0.0.1%3A${port}%2F&state=s1`;
    await writeFile(join(dir, "manifest.json"), JSON.stringify({
      runtime_key: "registry_agent", version: "7.0.0", command: "/bin/sh",
      args: ["-c", `printf '%s\\n' '${initialized}'; sleep 0.2; echo 'Open the following link to authenticate the ACP server: ${authorize}' >&2; exec sleep 30`], env: {}, home,
      login_command: null, login: null, installed_at: "",
    }));
    __setAgentAuthDetachedGraceMsForTests(0);
    const session = openLoginSession({
      session_id: "agent-callback", runtime_key: "registry_agent", installation: "managed:7.0.0", login: null,
      auth_method: { id: "oauth-personal", name: "Log in with Google", description: null, type: "agent", args: [], env: {} },
    }, frame => frames.push(frame), () => {});
    try {
      await waitFor(() => frames.some(frame => frame.type === "login_callback_wanted"));
      expect(frames).toContainEqual({ type: "login_callback_wanted", session_id: "agent-callback", port, authorize_url: authorize });

      // Wrong port: refused without a request.
      session.callback!(`http://127.0.0.1:${port + 1}/?state=s1&code=c1`);
      await waitFor(() => frames.some(frame => String(frame.data ?? "").includes("not the address this login is waiting for")));
      expect(received).toEqual([]);

      session.callback!(`http://127.0.0.1:${port}/?state=s1&code=c1`);
      await waitFor(() => received.length > 0);
      expect(received).toEqual(["/?state=s1&code=c1"]);
      await waitFor(() => frames.some(frame => String(frame.data ?? "").includes("Redirect delivered (HTTP 200)")));
    } finally {
      session.close();
      __setAgentAuthDetachedGraceMsForTests(null);
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });

  it.skipIf(!hasScript)("runs the login on a PTY, relays typed input, and reports the login state on exit", async () => {
    const frames: Record<string, unknown>[] = [];
    const home = join(configDir, "home");
    await mkdir(home, { recursive: true });
    // A fake vendor login: reads a code, then writes its credential file.
    const login = { command: ["sh", "-c", `printf 'code? '; read -r code; mkdir -p "$HOME/.fake" && echo "$code" > "$HOME/.fake/auth.json"; echo done:$code`] };
    const state = { env: {}, home_subdir: ".fake", credential_file: "auth.json" };
    const saved = process.env.HOME;
    process.env.HOME = home;
    try {
      const session = openLoginSession({ session_id: "s1", runtime_key: "fake", installation: "own", login, state }, (frame) => frames.push(frame), () => {});
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
  };

  it("runs the vendor's logout for the machine's own copy and, inside its tree, for a managed copy", async () => {
    const own = resolveLoginCommand({ session_id: "s", runtime_key: "opencode", installation: "own", login: SPEC, login_action: "logout" });
    expect(own.command).toEqual(["opencode", "auth", "logout"]);
    expect(own.env.HOME).toBe(process.env.HOME);

    const dir = join(toolsDir(), "opencode", "1.0.0");
    const home = managedToolHome("opencode");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "manifest.json"), JSON.stringify({
      runtime_key: "opencode", version: "1.0.0", command: join(dir, "opencode"), args: ["acp"], env: {}, home,
      login_command: [join(dir, "opencode"), "auth", "login"], login: SPEC, installed_at: "",
    }));
    const managed = resolveLoginCommand({ session_id: "s", runtime_key: "opencode", installation: "managed:1.0.0", login: null, login_action: "logout" });
    expect(managed.command).toEqual([join(dir, "opencode"), "auth", "logout"]);
    expect(managed.env.HOME).toBe(home);
  });

  it("uses the fixed entry's `logout` for a registry agent Rainver logs in through `login`, and refuses everything else", async () => {
    const dir = join(toolsDir(), "acp_cursor", "latest");
    const home = managedToolHome("acp_cursor");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "manifest.json"), JSON.stringify({
      runtime_key: "acp_cursor", version: "latest", command: join(dir, "cursor-agent"), args: ["acp"], entry_args: [], env: {}, home,
      login_command: null, login: null, installed_at: "",
    }));
    const registry = resolveLoginCommand({ session_id: "s", runtime_key: "acp_cursor", installation: "managed:latest", login: null, login_action: "logout" });
    expect(registry.command).toEqual([join(dir, "cursor-agent"), "logout"]);

    // A spec without a logout command fails closed rather than guessing one.
    const noLogout = { command: ["goose", "login"] };
    expect(() => resolveLoginCommand({ session_id: "s", runtime_key: "acp_goose", installation: "own", login: noLogout, login_action: "logout" })).toThrow(/logout command/);
    expect(() => resolveLoginCommand({ session_id: "s", runtime_key: "acp_goose", installation: "managed:9", login: null, login_action: "logout" })).toThrow(/not have/);
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
