import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { __setLoginFactoriesForTests, runCliLogin, sendCliLoginInput, type LoginEvent, type LoginRuntimeConfig, type PtyFactory } from "../src/modules/providers/cli/loginEngine.js";
import { __setMountinfoReaderForTests, resolveHostPath } from "../src/modules/providers/cli/hostPath.js";
import { cliLoginAdapterFor } from "../src/modules/providers/cli/loginAdapters/index.js";

let tempDir: string | undefined;

afterEach(async () => {
  __setLoginFactoriesForTests({});
  __setMountinfoReaderForTests(null);
  if (tempDir) await rm(tempDir, { recursive: true, force: true });
  tempDir = undefined;
});

const FAST = { outputSettleMs: 20, actionCooldownMs: 30, pollMs: 5, deadlineMs: 2_000 };
const shResolver = {
  resolveForExecution: async () => ({ executable_path: "sh" }),
  resolveVendorCliForExecution: async () => ({ executable_path: "sh" }),
};

class FakePty {
  written: string[] = [];
  private pending: string[] = [];
  private dataListeners: Array<(d: string) => void> = [];
  private exitListeners: Array<(code: number) => void> = [];

  write(data: string): void {
    this.written.push(data);
  }
  onData(listener: (d: string) => void): void {
    this.dataListeners.push(listener);
    for (const data of this.pending.splice(0)) listener(data);
  }
  onExit(listener: (code: number) => void): void {
    this.exitListeners.push(listener);
  }
  kill(): void {
    this.exit(-1);
  }
  emit(data: string): void {
    if (this.dataListeners.length === 0) {
      this.pending.push(data);
      return;
    }
    for (const l of this.dataListeners) l(data);
  }
  exit(code: number): void {
    for (const l of this.exitListeners) l(code);
  }
}

function until(events: LoginEvent[], type: string, timeoutMs = 1_500): Promise<LoginEvent> {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const poll = () => {
      const found = events.find((e) => e.type === type);
      if (found) return resolve(found);
      if (Date.now() - start > timeoutMs) {
        return reject(new Error(`no '${type}' event; saw ${events.map((e) => e.type).join(",")}`));
      }
      setTimeout(poll, 5);
    };
    poll();
  });
}

describe("CLI login engine", () => {
  it("drives the PTY TUI: Enter until a URL, needs_input, code, /exit, then syncs credentials", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "aspace-login-"));
    const home = join(tempDir, "home");
    const profileDir = join(tempDir, "profile");
    await mkdir(join(home, ".claude"), { recursive: true });
    await writeFile(join(home, ".claude", "credentials.json"), '{"session":"s"}');
    await writeFile(join(home, ".claude.json"), '{"cfg":true}');

    const pty = new FakePty();
    const factory: PtyFactory = { spawn: () => pty };
    __setLoginFactoriesForTests({ pty: factory, home });

    const cfg: LoginRuntimeConfig = {
      method: "cli",
      command: ["sh", "-c", "true"], // exists in PATH; never actually run (fake pty)
      home_subdir: ".claude",
      label: "Claude Code",
      hint_cli: "hint",
    };

    const events: LoginEvent[] = [];
    const run = runCliLogin("claude_code", cfg, profileDir, (e) => events.push(e), FAST, shResolver);

    // Menu output settles without a URL → the engine presses Enter.
    pty.emit("Choose your theme:\n");
    await until(events, "output");
    const start = Date.now();
    while (pty.written.length === 0 && Date.now() - start < 1_000) {
      await new Promise((r) => setTimeout(r, 5));
    }
    expect(pty.written).toContain("\r");

    // A URL appears → needs_input for the OAuth code.
    pty.emit("Open https://claude.ai/oauth/authorize?code=abc to continue\n");
    await until(events, "needs_input");

    // The user pastes the code → it reaches the PTY and /exit follows.
    expect(sendCliLoginInput("claude_code", "my-oauth-code")).toBe(true);
    expect(pty.written).toContain("my-oauth-code\r");
    const exitStart = Date.now();
    while (!pty.written.includes("/exit\r") && Date.now() - exitStart < 1_000) {
      await new Promise((r) => setTimeout(r, 5));
    }
    expect(pty.written).toContain("/exit\r");

    pty.exit(0);
    await run;

    expect(events.find((e) => e.type === "synced")).toMatchObject({
      profile_id: null,
    });
    expect(events.at(-1)).toMatchObject({ type: "done", exit_code: 0 });
    expect(await readFile(join(profileDir, "credentials.json"), "utf8")).toBe('{"session":"s"}');
    expect(await readFile(join(profileDir, ".claude.json"), "utf8")).toBe('{"cfg":true}');
  });

  it("syncs and reports success when the credential file is written despite a non-zero exit", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "aspace-login-"));
    const home = join(tempDir, "home");
    const profileDir = join(tempDir, "profile");
    await mkdir(join(home, ".claude"), { recursive: true });

    const pty = new FakePty();
    __setLoginFactoriesForTests({ pty: { spawn: () => pty }, home });

    const cfg: LoginRuntimeConfig = {
      method: "cli",
      command: ["sh", "-c", "true"],
      home_subdir: ".claude",
      credential_file: "credentials.json", // success signal, not the exit code
      label: "Claude Code",
    };

    const events: LoginEvent[] = [];
    const run = runCliLogin("claude_code", cfg, profileDir, (e) => events.push(e), FAST, shResolver);

    pty.emit("Open https://claude.ai/oauth/authorize?code=abc to continue\n");
    await until(events, "needs_input");
    expect(sendCliLoginInput("claude_code", "my-oauth-code")).toBe(true);

    // The CLI persists the token after a successful login, then exits non-zero
    // when we /exit its REPL — the file (newer than login start) is what counts.
    await writeFile(join(home, ".claude", "credentials.json"), '{"session":"fresh"}');
    pty.exit(7);
    await run;

    expect(events.find((e) => e.type === "synced")).toMatchObject({
      profile_id: null,
    });
    expect(events.at(-1)).toMatchObject({ type: "done", exit_code: 0 });
    expect(await readFile(join(profileDir, "credentials.json"), "utf8")).toBe('{"session":"fresh"}');
  });

  it("completes as soon as the credential file appears, without the CLI exiting itself", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "aspace-login-"));
    const home = join(tempDir, "home");
    const profileDir = join(tempDir, "profile");
    await mkdir(join(home, ".claude"), { recursive: true });

    const pty = new FakePty();
    __setLoginFactoriesForTests({ pty: { spawn: () => pty }, home });

    const cfg: LoginRuntimeConfig = {
      method: "cli",
      command: ["sh", "-c", "true"],
      home_subdir: ".claude",
      credential_file: "credentials.json",
      label: "Claude Code",
    };

    const events: LoginEvent[] = [];
    const run = runCliLogin("claude_code", cfg, profileDir, (e) => events.push(e), FAST, shResolver);

    pty.emit("Open https://claude.ai/oauth/authorize?code=abc to continue\n");
    await until(events, "needs_input");
    expect(sendCliLoginInput("claude_code", "my-oauth-code")).toBe(true);

    // The CLI stays in its REPL (never exits, ignores /exit). Once the token is
    // written, the engine must detect it and kill the process itself — FakePty
    // .kill() resolves the exit. No manual pty.exit() here.
    await writeFile(join(home, ".claude", "credentials.json"), '{"session":"repl"}');

    await run; // resolves promptly; does not block on the deadline
    expect(events.find((e) => e.type === "synced")).toBeTruthy();
    expect(events.at(-1)).toMatchObject({ type: "done", exit_code: 0 });
    expect(await readFile(join(profileDir, "credentials.json"), "utf8")).toBe('{"session":"repl"}');
  });

  it("does not sync a stale credential file when login fails (non-zero exit)", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "aspace-login-"));
    const home = join(tempDir, "home");
    const profileDir = join(tempDir, "profile");
    await mkdir(join(home, ".claude"), { recursive: true });
    // Pre-existing token from an earlier session — older than this login start.
    await writeFile(join(home, ".claude", "credentials.json"), '{"session":"stale"}');
    await new Promise((r) => setTimeout(r, 10));

    const pty = new FakePty();
    __setLoginFactoriesForTests({ pty: { spawn: () => pty }, home });

    const cfg: LoginRuntimeConfig = {
      method: "cli",
      command: ["sh", "-c", "true"],
      home_subdir: ".claude",
      credential_file: "credentials.json",
      label: "Claude Code",
    };

    const events: LoginEvent[] = [];
    const run = runCliLogin("claude_code", cfg, profileDir, (e) => events.push(e), FAST, shResolver);
    pty.emit("Open https://claude.ai/oauth/authorize?code=abc to continue\n");
    await until(events, "needs_input");
    pty.exit(7); // user abandoned the flow; token never refreshed
    await run;

    expect(events.find((e) => e.type === "synced")).toBeUndefined();
    expect(events.at(-1)).toMatchObject({ type: "done", exit_code: 7 });
    await expect(readFile(join(profileDir, "credentials.json"), "utf8")).rejects.toThrow();
  });

  it("rejects runtime tools that are not installed", async () => {
    const events: LoginEvent[] = [];
    await runCliLogin(
      "gemini_cli",
      {
        method: "cli",
        command: ["gemini", "auth"],
        label: "Gemini CLI",
      },
      "/tmp/unused",
      (e) => events.push(e),
      FAST,
      {
        async resolveForExecution() {
          throw new Error("Runtime tool 'gemini_cli' is not installed.");
        },
        async resolveVendorCliForExecution() {
          throw new Error("Runtime tool 'gemini_cli' is not installed.");
        },
      },
    );
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: "error" });
    expect(String(events[0].text)).toContain("not installed");
  });

  it("runs the login under the aspace login HOME, not the host home", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "aspace-login-"));
    const loginHome = join(tempDir, "login-home"); // aspace-managed, passed by the broker
    const profileDir = join(tempDir, "profile");
    // Host home that must stay untouched by the login.
    const hostHome = join(tempDir, "host-home");
    await mkdir(hostHome, { recursive: true });
    const pty = new FakePty();
    __setLoginFactoriesForTests({
      home: hostHome,
      pty: {
        spawn: (_command, _args, options) => {
          void (async () => {
            const target = join(String(options.env.HOME), ".local/share/opencode");
            await mkdir(target, { recursive: true });
            await writeFile(join(target, "auth.json"), "tok");
            pty.exit(0);
          })();
          return pty;
        },
      },
    });

    const cfg: LoginRuntimeConfig = {
      method: "cli",
      // Real subprocess: the CLI writes its login state into $HOME.
      command: ["sh", "-c", 'mkdir -p "$HOME/.local/share/opencode" && printf tok > "$HOME/.local/share/opencode/auth.json"'],
      home_subdir: ".local/share/opencode",
      credential_file: "auth.json",
      label: "OpenCode",
    };

    const events: LoginEvent[] = [];
    await runCliLogin(
      "opencode",
      cfg,
      profileDir,
      (e) => events.push(e),
      FAST,
      shResolver,
      loginHome, // broker-supplied HOME under aspace
    );

    // Credentials landed in the aspace login HOME and were synced to the profile…
    expect(await readFile(join(loginHome, ".local/share/opencode", "auth.json"), "utf8")).toBe("tok");
    expect(await readFile(join(profileDir, "auth.json"), "utf8")).toBe("tok");
    // …and the host home was never written to.
    await expect(readFile(join(hostHome, ".local/share/opencode", "auth.json"), "utf8")).rejects.toThrow();
    expect(events.at(-1)).toMatchObject({ type: "done", exit_code: 0 });
  });

  it("parses Codex device-auth from PTY output without asking for CLI input", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "aspace-login-"));
    const loginHome = join(tempDir, "login-home");
    const profileDir = join(tempDir, "profile");
    const previousOpenAiKey = process.env.OPENAI_API_KEY;
    const previousCodexHome = process.env.CODEX_HOME;
    const previousCodexToken = process.env.CODEX_ACCESS_TOKEN;
    const previousCodexSandboxNetwork = process.env.CODEX_SANDBOX_NETWORK_DISABLED;
    const previousCodexCi = process.env.CODEX_CI;
    process.env.OPENAI_API_KEY = "sk-host-should-not-pass";
    process.env.CODEX_HOME = join(tempDir, "host-codex-home");
    process.env.CODEX_ACCESS_TOKEN = "host-token-should-not-pass";
    process.env.CODEX_SANDBOX_NETWORK_DISABLED = "1";
    process.env.CODEX_CI = "1";
    await mkdir(join(loginHome, ".codex"), { recursive: true });
    await writeFile(join(loginHome, ".codex", "auth.json"), '{"token":"fresh"}');

    const pty = new FakePty();
    let spawnedEnv: Record<string, string> | undefined;
    __setLoginFactoriesForTests({
      pty: {
        spawn: (_command, _args, options) => {
          spawnedEnv = options.env;
          return pty;
        },
      },
      home: loginHome,
    });

    const codexAdapter = cliLoginAdapterFor("codex_cli");
    expect(codexAdapter).toBeTruthy();

    const events: LoginEvent[] = [];
    const run = runCliLogin(
      "codex_cli",
      { ...codexAdapter!, command: ["sh", "-c", "true"] },
      profileDir,
      (e) => events.push(e),
      FAST,
      shResolver,
      loginHome,
    );

    pty.emit([
      "Welcome to Codex [v0.139.0]\r\n",
      "1. Open this link in your browser and sign in to your account\r\n",
      "   https://auth.openai.com/codex/device\r\n",
      "2. Enter this one-time code (expires in 15 minutes)\r\n",
      "   LC0F-0KCU4\r\n",
    ].join(""));
    await until(events, "device_auth");

    // Give the default URL prompt a chance to fire; the Codex parser should suppress it.
    await new Promise((r) => setTimeout(r, FAST.outputSettleMs + FAST.actionCooldownMs + 30));
    expect(events.find((e) => e.type === "needs_input")).toBeUndefined();

    pty.exit(0);
    try {
      await run;
    } finally {
      if (previousOpenAiKey === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = previousOpenAiKey;
      if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = previousCodexHome;
      if (previousCodexToken === undefined) delete process.env.CODEX_ACCESS_TOKEN;
      else process.env.CODEX_ACCESS_TOKEN = previousCodexToken;
      if (previousCodexSandboxNetwork === undefined) delete process.env.CODEX_SANDBOX_NETWORK_DISABLED;
      else process.env.CODEX_SANDBOX_NETWORK_DISABLED = previousCodexSandboxNetwork;
      if (previousCodexCi === undefined) delete process.env.CODEX_CI;
      else process.env.CODEX_CI = previousCodexCi;
    }

    expect(events.find((e) => e.type === "device_auth")).toMatchObject({
      url: "https://auth.openai.com/codex/device",
      code: "LC0F-0KCU4",
      expires_in_minutes: 15,
    });
    expect(spawnedEnv?.OPENAI_API_KEY).toBeUndefined();
    expect(spawnedEnv?.CODEX_HOME).toBeUndefined();
    expect(spawnedEnv?.CODEX_ACCESS_TOKEN).toBeUndefined();
    expect(spawnedEnv?.CODEX_SANDBOX_NETWORK_DISABLED).toBeUndefined();
    expect(spawnedEnv?.CODEX_CI).toBeUndefined();
    expect(await readFile(join(profileDir, "auth.json"), "utf8")).toBe('{"token":"fresh"}');
    expect(events.at(-1)).toMatchObject({ type: "done", exit_code: 0 });
  });
});

describe("docker grant host path translation", () => {
  it("maps a bind-mounted container path through the most specific mount's root field", () => {
    __setMountinfoReaderForTests(
      () =>
        [
          // Overlay root must never shadow the specific /aspace bind below.
          "678 677 0:59 / / rw,relatime - overlay overlay rw,lowerdir=/x",
          "1545 678 8:32 /home/me/.aspace/dev /aspace rw,relatime - ext4 /dev/sdc rw",
        ].join("\n") + "\n",
    );
    expect(resolveHostPath("/aspace/secrets/cli-credentials/users/user-1/claude_code/profile-1")).toBe(
      "/home/me/.aspace/dev/secrets/cli-credentials/users/user-1/claude_code/profile-1",
    );
    // Paths outside any bind stay untranslated (overlay root has no host path).
    expect(resolveHostPath("/etc/passwd")).toBe("/etc/passwd");
  });

  it("returns the original path when nothing matches or mountinfo is unreadable", () => {
    __setMountinfoReaderForTests(() => "");
    expect(resolveHostPath("/elsewhere/data")).toBe("/elsewhere/data");
    __setMountinfoReaderForTests(() => {
      throw new Error("no /proc here");
    });
    expect(resolveHostPath("/aspace/secrets")).toBe("/aspace/secrets");
  });
});
