import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HostServerFrameSchema, type OrdinaryAccountSessionEvent } from "@rainver/protocol";
import {
  closeAllOrdinaryAccountSessions,
  closeOrdinaryAccountSession,
  handleOrdinaryAccountRequest,
  openOrdinaryAccountSession,
  ordinaryAccountRoot,
  ordinaryToolAccountsCapability,
} from "../src/ordinaryToolAccounts.js";
import { __clearOrdinaryToolVersionCache, handleOrdinaryToolAction } from "../src/ordinaryTools.js";

const A = "a".repeat(40);
const B = "b".repeat(40);
let root: string;
let control: string;
let savedEnv: NodeJS.ProcessEnv;

/**
 * A stand-in for lark-cli 1.0.99 with the same argv and output shapes
 * (see the module comment in `ordinaryToolAccounts.ts`). It keeps its state
 * only where the official CLI does — the config and data directories it is
 * given — records the environment it saw, and prints secret-looking noise
 * that must never leave the daemon.
 */
const FAKE = (controlDir: string) => `#!${process.execPath}
const fs = require("fs"), path = require("path");
const args = process.argv.slice(2).join(" ");
if (args === "--version") { console.log("lark-cli version 1.0.99"); process.exit(0); }
const cfg = process.env.LARKSUITE_CLI_CONFIG_DIR, data = process.env.LARKSUITE_CLI_DATA_DIR;
fs.writeFileSync(path.join(${JSON.stringify(controlDir)}, "env-" + process.pid + ".json"), JSON.stringify(process.env));
const mode = (() => { try { return fs.readFileSync(path.join(${JSON.stringify(controlDir)}, "mode"), "utf8").trim(); } catch { return "complete"; } })();
const user = (() => { try { return fs.readFileSync(path.join(cfg, "..", "who"), "utf8").trim(); } catch { return "Someone"; } })();
const configured = fs.existsSync(path.join(cfg, "config.json"));
const token = path.join(data, "lark-cli", "user.enc");
const notConfigured = () => { process.stderr.write(JSON.stringify({ ok: false, error: { type: "config", subtype: "not_configured", message: "not configured" } }, null, 2) + "\\n"); process.exit(3); };
const hang = () => setInterval(() => {}, 1000);
// Every real invocation is recorded, so a test can tell whether a login ever started.
fs.writeFileSync(path.join(${JSON.stringify(controlDir)}, "argv-" + process.pid + ".txt"), args);
// A CLI that takes a while to stop when asked, as a real one finishing a poll might.
if (mode === "slowstop") process.on("SIGTERM", () => setTimeout(() => process.exit(0), 800));
if (args.startsWith("auth status")) {
  // A gate the test controls: the status read waits while the file exists.
  const gate = path.join(${JSON.stringify(controlDir)}, "status-gate");
  if (fs.existsSync(gate)) {
    fs.writeFileSync(path.join(${JSON.stringify(controlDir)}, "status-waiting-" + process.pid), "");
    const wait = () => fs.existsSync(gate) ? setTimeout(wait, 20) : finishStatus();
    return wait();
  }
  finishStatus();
}
function finishStatus() {
  if (!configured) notConfigured();
  const signed = fs.existsSync(token);
  const userState = signed ? { status: "ready", available: true, userName: fs.readFileSync(token, "utf8"), openId: "ou_x", expiresAt: "2026-11-05T12:00:00Z", ...(args.includes("--verify") ? { verified: mode !== "reject" } : {}) }
    : { status: "missing", available: false, message: "User identity: missing (no user logged in)" };
  console.log(JSON.stringify({ appId: "cli_fake", brand: "feishu", identities: { bot: { status: "ready", available: true }, user: userState }, identity: signed ? "user" : "bot" }, null, 2));
  process.exit(0);
}
if (args === "config init --new") {
  process.stderr.write("See https://evil.example.com/phish first\\nOpen this link in a browser:\\n  https://open.feishu.cn/page/cli?code=SETUP1\\napp_secret=SUPERSECRET\\n");
  if (mode === "hang") return hang();
  fs.mkdirSync(cfg, { recursive: true });
  fs.writeFileSync(path.join(cfg, "config.json"), JSON.stringify({ apps: [{ appId: "cli_fake", appSecret: "SUPERSECRET", brand: "feishu", users: [] }] }));
  console.log(JSON.stringify({ appId: "cli_fake", appSecret: "****", brand: "feishu" }, null, 2));
  process.exit(0);
}
if (args === "auth login --recommend --json") {
  if (!configured) notConfigured();
  console.log(JSON.stringify({ event: "device_authorization", verification_uri: "https://accounts.feishu.cn/oauth/v1/device/verify", verification_uri_complete: "https://accounts.feishu.cn/oauth/v1/device/verify?user_code=ABCD-EFGH", user_code: "ABCD-EFGH", expires_in: 600 }));
  process.stderr.write("refresh_token=SUPERSECRET access_token=SUPERSECRET\\n");
  if (mode === "hang" || mode === "slowstop") return hang();
  if (mode === "deny") { console.log(JSON.stringify({ event: "authorization_failed", error: "access_denied SUPERSECRET" })); process.exit(4); }
  fs.mkdirSync(path.dirname(token), { recursive: true });
  fs.writeFileSync(token, user);
  console.log(JSON.stringify({ event: "authorization_complete", user_open_id: "ou_x", user_name: user, scope: "x" }));
  process.exit(0);
}
if (args === "auth logout --json") {
  if (!configured) { console.log(JSON.stringify({ ok: true, loggedOut: false, reason: "not_configured" })); process.exit(0); }
  if (!fs.existsSync(token)) { console.log(JSON.stringify({ ok: true, loggedOut: false, reason: "not_logged_in" })); process.exit(0); }
  fs.rmSync(token);
  console.log(JSON.stringify({ ok: true, loggedOut: true }));
  process.exit(0);
}
process.exit(2);
`;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "rainver-ordinary-accounts-"));
  control = join(root, "control");
  const bin = join(root, "bin");
  await mkdir(control);
  await mkdir(bin);
  await writeFile(join(bin, "lark-cli"), FAKE(control));
  await chmod(join(bin, "lark-cli"), 0o755);
  savedEnv = { ...process.env };
  process.env.RAINVER_HOST_CONFIG_DIR = join(root, "config");
  process.env.PATH = `${bin}:/usr/bin:/bin`;
  // What a daemon's own environment may hold; none of it may reach the CLI.
  process.env.ANTHROPIC_API_KEY = "provider-key";
  process.env.LARKSUITE_CLI_APP_SECRET = "inherited-secret";
  process.env.LARKSUITE_CLI_USER_ACCESS_TOKEN = "inherited-token";
  process.env.OPENCLAW_HOME = "/elsewhere";
  __clearOrdinaryToolVersionCache();
});

afterEach(async () => {
  closeAllOrdinaryAccountSessions();
  process.env = savedEnv;
  await rm(root, { recursive: true, force: true });
});

async function who(key: string, name: string) {
  await mkdir(ordinaryAccountRoot("lark_cli", key), { recursive: true });
  await writeFile(join(ordinaryAccountRoot("lark_cli", key), "who"), name);
}

function session(key: string, flow: "init" | "login", sessionId = `${key.slice(0, 4)}-${flow}-${Math.random()}`, options = {}) {
  const events: OrdinaryAccountSessionEvent[] = [];
  const done = openOrdinaryAccountSession({ session_id: sessionId, tool_id: "lark_cli", account_key: key, flow }, (event) => events.push(event), () => {}, options);
  return { events, done, sessionId };
}

const status = (key: string, action: "status" | "verify" | "logout" = "status") =>
  handleOrdinaryAccountRequest({ tool_id: "lark_cli", account_key: key, action });

describe("personal lark-cli accounts", () => {
  it("is offered only where credentials can be kept per user", () => {
    expect(ordinaryToolAccountsCapability("linux")).toMatchObject({ supported: true });
    expect(ordinaryToolAccountsCapability("darwin")).toMatchObject({ supported: false, reason: expect.stringMatching(/Keychain/) });
    expect(ordinaryToolAccountsCapability("win32").supported).toBe(false);
  });

  it("keeps two users' setup, login, status and logout apart", async () => {
    await who(A, "Alice");
    await who(B, "Bob");
    expect((await status(A)).status).toMatchObject({ state: "not_configured", account: null });

    for (const key of [A, B]) {
      const setup = session(key, "init");
      await setup.done;
      // Only the official link; never the other URL or the secret printed beside it.
      expect(setup.events).toEqual([
        { kind: "authorization", url: "https://open.feishu.cn/page/cli?code=SETUP1", user_code: null, expires_in: null },
        { kind: "exit", outcome: "completed", error: null, status: { state: "not_logged_in", account: null, reason: null } },
      ]);
    }
    const [loginA, loginB] = [session(A, "login"), session(B, "login")];
    await Promise.all([loginA.done, loginB.done]);
    expect(loginA.events[0]).toEqual({ kind: "authorization", url: "https://accounts.feishu.cn/oauth/v1/device/verify?user_code=ABCD-EFGH", user_code: "ABCD-EFGH", expires_in: 600 });
    expect(loginA.events[1]).toMatchObject({ kind: "exit", outcome: "completed", status: { state: "signed_in", account: { user_name: "Alice", app_id: "cli_fake", brand: "feishu" } } });
    expect(loginB.events[1]).toMatchObject({ status: { state: "signed_in", account: { user_name: "Bob" } } });
    expect(JSON.stringify([loginA.events, loginB.events])).not.toMatch(/SUPERSECRET|evil|ou_x/);

    // Each child saw only its own directories and none of the daemon's credentials.
    const envs = await Promise.all((await readdir(control)).filter((name) => name.startsWith("env-"))
      .map(async (name) => JSON.parse(await readFile(join(control, name), "utf8")) as Record<string, string>));
    for (const env of envs) {
      const owner = env.LARKSUITE_CLI_CONFIG_DIR!.includes(A) ? A : B;
      expect(env.LARKSUITE_CLI_CONFIG_DIR).toBe(join(ordinaryAccountRoot("lark_cli", owner), "config"));
      expect(env.LARKSUITE_CLI_DATA_DIR).toBe(join(ordinaryAccountRoot("lark_cli", owner), "data"));
      expect(env.HOME).toBe(join(ordinaryAccountRoot("lark_cli", owner), "home"));
      for (const leaked of ["ANTHROPIC_API_KEY", "LARKSUITE_CLI_APP_SECRET", "LARKSUITE_CLI_USER_ACCESS_TOKEN", "OPENCLAW_HOME", "RAINVER_HOST_CONFIG_DIR"]) {
        expect(env[leaked]).toBeUndefined();
      }
    }

    // The official logout, local only as far as Rainver can tell; Bob is untouched.
    const out = await status(A, "logout");
    expect(out).toMatchObject({ ok: true, logout: { local_cleared: true, remote_revocation: "attempted_unconfirmed" }, status: { state: "not_logged_in" } });
    expect((await status(A, "logout")).logout).toEqual({ local_cleared: false, remote_revocation: "not_applicable" });
    expect((await status(B)).status).toMatchObject({ state: "signed_in", account: { user_name: "Bob" } });
    expect((await status(B, "verify")).status).toMatchObject({ state: "signed_in", account: { verified: true } });
    // The configuration survives logout: only the token went.
    expect(await readFile(join(ordinaryAccountRoot("lark_cli", A), "config", "config.json"), "utf8")).toContain("cli_fake");
  });

  it("ends sessions on cancel, timeout, refusal and a lost connection, releasing the account and the tool", async () => {
    await who(A, "Alice");
    await session(A, "init").done;
    await writeFile(join(control, "mode"), "hang");

    const hanging = session(A, "login");
    await expect.poll(() => hanging.events.length).toBe(1);
    // One account operation at a time; another user's account is unaffected.
    expect(await status(A)).toEqual({ ok: false, error: "account_busy", status: null });
    expect((await status(B)).status?.state).toBe("not_configured");
    // The shared binary cannot be replaced or re-registered under a running login.
    expect(await handleOrdinaryToolAction({ action: "register", tool_id: "lark_cli", path: null }, () => {})).toMatchObject({
      ok: false, error: expect.stringMatching(/in use by an account login/),
    });
    closeOrdinaryAccountSession(hanging.sessionId);
    await hanging.done;
    expect(hanging.events.at(-1)).toMatchObject({ kind: "exit", outcome: "cancelled", status: { state: "not_logged_in" } });

    const slow = session(A, "login", undefined, { sessionTimeoutMs: 300 });
    await slow.done;
    expect(slow.events.at(-1)).toMatchObject({ kind: "exit", outcome: "timed_out" });

    // A second session for the same account supersedes the first.
    const first = session(A, "login");
    await expect.poll(() => first.events.length).toBe(1);
    await writeFile(join(control, "mode"), "complete");
    const second = session(A, "login");
    await Promise.all([first.done, second.done]);
    expect(first.events.at(-1)).toMatchObject({ outcome: "cancelled" });
    expect(second.events.at(-1)).toMatchObject({ outcome: "completed", status: { state: "signed_in" } });

    await writeFile(join(control, "mode"), "hang");
    const orphaned = session(A, "login");
    await expect.poll(() => orphaned.events.length).toBe(1);
    closeAllOrdinaryAccountSessions();
    await orphaned.done;
    expect(orphaned.events.at(-1)).toMatchObject({ outcome: "cancelled" });

    await writeFile(join(control, "mode"), "deny");
    const denied = session(A, "login");
    await denied.done;
    expect(denied.events.at(-1)).toEqual(expect.objectContaining({ outcome: "failed", error: "The authorization was not completed." }));
    expect(JSON.stringify(denied.events)).not.toMatch(/SUPERSECRET|access_denied/);

    // Everything was released: the tool can be registered again, and the account answers.
    expect((await handleOrdinaryToolAction({ action: "register", tool_id: "lark_cli", path: null }, () => {})).ok).toBe(true);
    expect((await status(A)).ok).toBe(true);
  });

  describe("a successor waiting for the session it supersedes", () => {
    const logins = async () => (await Promise.all((await readdir(control)).filter((name) => name.startsWith("argv-"))
      .map((name) => readFile(join(control, name), "utf8")))).filter((args) => args.startsWith("auth login")).length;
    async function slowlyStoppingLogin() {
      await who(A, "Alice");
      await session(A, "init").done;
      await writeFile(join(control, "mode"), "slowstop");
      const first = session(A, "login");
      await expect.poll(() => first.events.length).toBe(1);
      return first;
    }
    async function released() {
      await writeFile(join(control, "mode"), "complete");
      expect((await status(A)).ok).toBe(true);
      expect((await handleOrdinaryToolAction({ action: "register", tool_id: "lark_cli", path: null }, () => {})).ok).toBe(true);
      const next = session(A, "login");
      await next.done;
      expect(next.events.at(-1)).toMatchObject({ outcome: "completed", status: { state: "signed_in" } });
    }

    for (const [label, stopWaiter] of [
      ["its own close", (id: string) => closeOrdinaryAccountSession(id)],
      ["a lost connection", () => closeAllOrdinaryAccountSessions()],
    ] as const) {
      it(`never starts the CLI once cancelled by ${label}`, async () => {
        const first = await slowlyStoppingLogin();
        const waiter = session(A, "login");
        // The first is stopping (slowly); the waiter has not started anything.
        await new Promise((resolve) => setTimeout(resolve, 100));
        stopWaiter(waiter.sessionId);
        await Promise.all([first.done, waiter.done]);
        expect(first.events.at(-1)).toMatchObject({ outcome: "cancelled" });
        expect(waiter.events).toEqual([{ kind: "exit", outcome: "cancelled", error: null, status: null }]);
        expect(await logins()).toBe(1);
        await released();
      });
    }

    it("lets only the newest of several waiters take the account", async () => {
      const first = await slowlyStoppingLogin();
      await writeFile(join(control, "mode"), "complete");
      const older = session(A, "login");
      await new Promise((resolve) => setTimeout(resolve, 50));
      const newer = session(A, "login");
      await Promise.all([first.done, older.done, newer.done]);
      expect(older.events).toEqual([{ kind: "exit", outcome: "cancelled", error: null, status: null }]);
      expect(newer.events.map((event) => event.kind)).toEqual(["authorization", "exit"]);
      expect(newer.events.at(-1)).toMatchObject({ outcome: "completed" });
      expect(await logins()).toBe(2);
      expect((await status(A)).status).toMatchObject({ state: "signed_in", account: { user_name: "Alice" } });
    });
  });

  describe("a cancel that arrives while the final status is being read", () => {
    const logins = async () => (await Promise.all((await readdir(control)).filter((name) => name.startsWith("argv-"))
      .map((name) => readFile(join(control, name), "utf8")))).filter((args) => args.startsWith("auth login")).length;
    const statusWaiting = async () => (await readdir(control)).some((name) => name.startsWith("status-waiting-"));
    /** A login that completes, then a final status read held at the gate. */
    async function loginHeldAtFinalStatus() {
      await who(A, "Alice");
      await session(A, "init").done;
      await writeFile(join(control, "status-gate"), "");
      const login = session(A, "login");
      await expect.poll(statusWaiting).toBe(true);
      expect(login.events.map((event) => event.kind)).toEqual(["authorization"]);
      return login;
    }
    async function holdsAccountAndTool() {
      expect(await status(A)).toEqual({ ok: false, error: "account_busy", status: null });
      expect(await handleOrdinaryToolAction({ action: "register", tool_id: "lark_cli", path: null }, () => {})).toMatchObject({
        ok: false, error: expect.stringMatching(/in use by an account login/),
      });
    }

    it("ends cancelled with the real signed-in status, releasing only after the status process exits", async () => {
      const login = await loginHeldAtFinalStatus();
      closeOrdinaryAccountSession(login.sessionId);
      await holdsAccountAndTool();
      expect(login.events.map((event) => event.kind)).toEqual(["authorization"]);
      await rm(join(control, "status-gate"));
      await login.done;
      expect(login.events.at(-1)).toEqual({
        kind: "exit", outcome: "cancelled", error: null,
        status: expect.objectContaining({ state: "signed_in", account: expect.objectContaining({ user_name: "Alice" }) }),
      });
      expect((await status(A)).status).toMatchObject({ state: "signed_in" });
      expect((await handleOrdinaryToolAction({ action: "register", tool_id: "lark_cli", path: null }, () => {})).ok).toBe(true);
    });

    it("makes a superseding session wait for that status read before it starts", async () => {
      const login = await loginHeldAtFinalStatus();
      const next = session(A, "login");
      await holdsAccountAndTool();
      expect(await logins()).toBe(1);
      expect(next.events).toEqual([]);
      await rm(join(control, "status-gate"));
      await Promise.all([login.done, next.done]);
      expect(login.events.at(-1)).toMatchObject({ outcome: "cancelled", status: { state: "signed_in" } });
      expect(next.events.map((event) => event.kind)).toEqual(["authorization", "exit"]);
      expect(next.events.at(-1)).toMatchObject({ outcome: "completed", status: { state: "signed_in" } });
      expect(await logins()).toBe(2);
    });

    it("treats a lost connection during that read the same way", async () => {
      const login = await loginHeldAtFinalStatus();
      closeAllOrdinaryAccountSessions();
      await holdsAccountAndTool();
      await rm(join(control, "status-gate"));
      await login.done;
      expect(login.events.at(-1)).toMatchObject({ outcome: "cancelled", status: { state: "signed_in" } });
      expect((await status(A)).ok).toBe(true);
    });
  });

  it("refuses a login before setup and when the tool is not available", async () => {
    const early = session(A, "login");
    await early.done;
    expect(early.events).toEqual([{ kind: "exit", outcome: "failed", error: "Run the CLI's initialization first.", status: { state: "not_configured", account: null, reason: "Run the CLI's initialization first." } }]);
    process.env.PATH = "/usr/bin:/bin";
    __clearOrdinaryToolVersionCache();
    const missing = session(B, "login");
    await missing.done;
    expect(missing.events).toEqual([{ kind: "exit", outcome: "failed", error: expect.stringMatching(/not available on this Host/), status: null }]);
  });

  it("accepts only a derived account key and fixed actions on the wire", () => {
    const base = { type: "ordinary_account_session_open", session_id: "s-1", tool_id: "lark_cli", flow: "login" };
    expect(HostServerFrameSchema.safeParse({ ...base, account_key: A }).success).toBe(true);
    expect(HostServerFrameSchema.safeParse({ ...base, account_key: "../../etc" }).success).toBe(false);
    expect(HostServerFrameSchema.safeParse({ ...base, account_key: A, argv: ["sh", "-c", "id"] }).success).toBe(false);
    expect(HostServerFrameSchema.safeParse({ ...base, account_key: A, flow: "bot" }).success).toBe(false);
    expect(HostServerFrameSchema.safeParse({ type: "ordinary_account_request", request_id: "r", tool_id: "jq", account_key: A, action: "status" }).success).toBe(false);
    expect(() => ordinaryAccountRoot("lark_cli", "../x")).toThrow();
  });
});
