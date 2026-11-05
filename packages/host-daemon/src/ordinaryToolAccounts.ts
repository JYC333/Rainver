import {
  ORDINARY_TOOL_ACCOUNTS_PROTOCOL,
  type HostServerFrameOf,
  type OrdinaryAccountFlow,
  type OrdinaryAccountResult,
  type OrdinaryAccountSessionEvent,
  type OrdinaryAccountStatus,
  type OrdinaryAccountSummary,
  type OrdinaryToolAccountsCapability,
} from "@rainver/protocol";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { configDir } from "./config.js";
import { leaseOrdinaryToolCommand } from "./ordinaryTools.js";

/**
 * Personal accounts for ordinary CLI tools (protocol `ordinaryToolAccounts.ts`),
 * using the official lark-cli 1.0.99 commands only:
 *
 * - `config init --new`: the official app setup; prints a verification URL on
 *   stderr, then `{"appId","appSecret":"****","brand"}` on stdout.
 * - `auth login --recommend --json`: the device flow; a `device_authorization`
 *   event (URL, user code), then `authorization_complete` or `_failed`.
 * - `auth status [--verify]`: JSON identities; only `identities.user` is read,
 *   so a ready bot identity never stands in for the person.
 * - `auth logout --json`: removes the local token after a revoke call whose
 *   outcome the CLI ignores.
 *
 * Each Rainver user on this Host gets `<config>/ordinary-tool-state/<tool>/<key>/`
 * with its own HOME, `LARKSUITE_CLI_CONFIG_DIR` and `LARKSUITE_CLI_DATA_DIR`
 * (where lark-cli keeps its master key and encrypted tokens on Linux). The
 * binary is shared (`leaseOrdinaryToolCommand`). The child environment is an
 * allowlist, so no provider key, inherited `LARKSUITE_CLI_*` credential or
 * workspace selector (`OPENCLAW_*`, `HERMES_*`) reaches it. Nothing reads the
 * credential files, and no command output is logged or forwarded except the
 * fields named in the protocol.
 */

const STATUS_TIMEOUT_MS = 20_000;
const VERIFY_TIMEOUT_MS = 30_000;
const SESSION_TIMEOUT_MS = 15 * 60_000;
const KILL_GRACE_MS = 3_000;
const MAX_OUTPUT_BYTES = 256 * 1024;
const MAX_LINE_BYTES = 16 * 1024;
/** Hosts the official CLI sends people to for setup and login. */
const AUTHORIZATION_HOSTS = [/(^|\.)feishu\.cn$/, /(^|\.)larksuite\.com$/, /(^|\.)larkoffice\.com$/];
const ENV_ALLOWLIST = [
  "PATH", "LANG", "LC_ALL", "LC_CTYPE", "TZ", "SSL_CERT_FILE", "SSL_CERT_DIR",
  "HTTPS_PROXY", "HTTP_PROXY", "NO_PROXY", "https_proxy", "http_proxy", "no_proxy",
];

export function ordinaryToolAccountsCapability(platform: NodeJS.Platform = process.platform): OrdinaryToolAccountsCapability {
  if (platform === "linux") return { protocol: ORDINARY_TOOL_ACCOUNTS_PROTOCOL, supported: true, reason: null };
  return {
    protocol: ORDINARY_TOOL_ACCOUNTS_PROTOCOL,
    supported: false,
    reason: platform === "darwin"
      ? "On macOS the official CLI keeps its master key in the system Keychain, so one user's credentials cannot be kept apart from another's."
      : "Personal accounts are supported on Linux Hosts only.",
  };
}

interface AccountDirs { home: string; config: string; data: string }

export function ordinaryAccountRoot(toolId: string, accountKey: string): string {
  if (!/^[a-z_]+$/.test(toolId) || !/^[a-f0-9]{40}$/.test(accountKey)) throw new Error("Unusable account key");
  return join(configDir(), "ordinary-tool-state", toolId, accountKey);
}

async function accountDirs(toolId: string, accountKey: string): Promise<AccountDirs> {
  const root = ordinaryAccountRoot(toolId, accountKey);
  const dirs = { home: join(root, "home"), config: join(root, "config"), data: join(root, "data") };
  for (const dir of [root, ...Object.values(dirs)]) await mkdir(dir, { recursive: true, mode: 0o700 });
  return dirs;
}

/** Exported for tests: exactly what a child sees. */
export function accountChildEnv(dirs: AccountDirs, ambient: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of ENV_ALLOWLIST) if (ambient[key] !== undefined) env[key] = ambient[key]!;
  return {
    ...env,
    HOME: dirs.home,
    LARKSUITE_CLI_CONFIG_DIR: dirs.config,
    LARKSUITE_CLI_DATA_DIR: dirs.data,
    LARKSUITE_CLI_NO_SKILLS_NOTIFIER: "1",
  };
}

function boundedCollector() {
  let text = "";
  return {
    add(chunk: Buffer) { if (text.length < MAX_OUTPUT_BYTES) text += chunk.toString("utf8").slice(0, MAX_OUTPUT_BYTES - text.length); },
    get text() { return text; },
  };
}

function stop(child: ChildProcess): void {
  try { child.kill("SIGTERM"); } catch { /* gone */ }
  const timer = setTimeout(() => { try { child.kill("SIGKILL"); } catch { /* gone */ } }, KILL_GRACE_MS);
  timer.unref?.();
}

interface CommandOutcome { code: number | null; stdout: string; stderr: string; timedOut: boolean }

function runCommand(command: string, args: string[], env: Record<string, string>, cwd: string, timeoutMs: number): Promise<CommandOutcome> {
  return new Promise((resolve) => {
    const stdout = boundedCollector();
    const stderr = boundedCollector();
    let timedOut = false;
    const child = spawn(command, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    const timer = setTimeout(() => { timedOut = true; stop(child); }, timeoutMs);
    timer.unref?.();
    child.stdout?.on("data", (chunk: Buffer) => stdout.add(chunk));
    child.stderr?.on("data", (chunk: Buffer) => stderr.add(chunk));
    child.on("error", () => { clearTimeout(timer); resolve({ code: null, stdout: "", stderr: "", timedOut }); });
    child.on("close", (code) => { clearTimeout(timer); resolve({ code, stdout: stdout.text, stderr: stderr.text, timedOut }); });
  });
}

function jsonObject(text: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

const str = (value: unknown, max = 200) => typeof value === "string" && value.length > 0 ? value.slice(0, max) : null;

/** The CLI's own error subtype (`not_configured`, …) from its stderr JSON, never its message. */
function errorSubtype(stderr: string): string | null {
  const subtype = (jsonObject(stderr.trim())?.error as Record<string, unknown> | undefined)?.subtype;
  return typeof subtype === "string" && /^[a-z_]{1,40}$/.test(subtype) ? subtype : null;
}

/** Exported for tests: `auth status` output → the safe status. */
export function parseAccountStatus(outcome: CommandOutcome): OrdinaryAccountStatus {
  if (outcome.timedOut) return { state: "error", account: null, reason: "The CLI did not answer in time." };
  if (outcome.code !== 0) {
    const subtype = errorSubtype(outcome.stderr);
    if (subtype === "not_configured") return { state: "not_configured", account: null, reason: "Run the CLI's initialization first." };
    return { state: "error", account: null, reason: subtype ? `The CLI reported an error (${subtype}).` : "The CLI could not report its status." };
  }
  const result = jsonObject(outcome.stdout.trim());
  const user = (result?.identities as Record<string, unknown> | undefined)?.user as Record<string, unknown> | undefined;
  if (!result || !user) return { state: "error", account: null, reason: "The CLI's status output was not understood." };
  const brand = result.brand === "feishu" || result.brand === "lark" ? result.brand : null;
  const account: OrdinaryAccountSummary = {
    user_name: str(user.userName),
    app_id: str(result.appId, 100),
    brand,
    refresh_pending: user.status === "needs_refresh",
    expires_at: str(user.expiresAt, 64),
    refresh_expires_at: str(user.refreshExpiresAt, 64),
    verified: typeof user.verified === "boolean" ? user.verified : null,
  };
  switch (user.status) {
    case "ready":
    case "needs_refresh":
      if (user.verified === false) return { state: "verify_failed", account, reason: "The server did not accept this login." };
      return { state: "signed_in", account, reason: null };
    case "verify_failed":
      return { state: "verify_failed", account, reason: "The server did not accept this login." };
    case "not_configured":
      return { state: "not_configured", account: null, reason: "Run the CLI's initialization first." };
    case "missing":
      return user.tokenStatus === "expired"
        ? { state: "expired", account, reason: "This login has expired; log in again." }
        : { state: "not_logged_in", account: user.userName ? account : null, reason: null };
    default:
      return { state: "error", account: null, reason: "The CLI reported an error for this login." };
  }
}

/** Allowlisted official authorization link, or null. */
function authorizationUrl(candidate: unknown): string | null {
  if (typeof candidate !== "string" || candidate.length > 2048) return null;
  try {
    const url = new URL(candidate);
    return url.protocol === "https:" && AUTHORIZATION_HOSTS.some((host) => host.test(url.hostname)) ? url.toString() : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// One account at a time: an action or a session holds `<tool>:<key>`.
// ---------------------------------------------------------------------------

interface Session { id: string; claim: string; child: ChildProcess | null; cancelled: boolean; exited: Promise<void> }
const claims = new Map<string, "status" | "logout" | Session>();
/**
 * Runs currently using an account (`acquireRunAccountUse`). Several Runs of one
 * person may share it: the official CLI serializes token refresh across
 * processes with a lock file in its configuration directory. Setup, login and
 * logout are refused while any Run holds it, and a Run does not take an
 * account whose setup, login or logout is in progress.
 */
const runUses = new Map<string, number>();
const IN_USE_BY_RUN = "account_in_use_by_run";
const sessions = new Map<string, Session>();
/** The one session waiting to supersede an account's current holder. */
const successors = new Map<string, Session>();

export interface AccountDependencies {
  sessionTimeoutMs?: number;
  statusTimeoutMs?: number;
}

async function statusFor(command: string, dirs: AccountDirs, verify: boolean, timeoutMs?: number): Promise<OrdinaryAccountStatus> {
  return parseAccountStatus(await runCommand(command, verify ? ["auth", "status", "--verify"] : ["auth", "status"],
    accountChildEnv(dirs), dirs.home, timeoutMs ?? (verify ? VERIFY_TIMEOUT_MS : STATUS_TIMEOUT_MS)));
}

export async function handleOrdinaryAccountRequest(
  frame: Omit<HostServerFrameOf<"ordinary_account_request">, "type" | "request_id">,
  dependencies: AccountDependencies = {},
): Promise<OrdinaryAccountResult> {
  const claim = `${frame.tool_id}:${frame.account_key}`;
  if (claims.has(claim)) return { ok: false, error: "account_busy", status: null };
  // Reading status is harmless beside a Run; logging out under one is not.
  if (frame.action === "logout" && runUses.has(claim)) return { ok: false, error: IN_USE_BY_RUN, status: null };
  claims.set(claim, frame.action === "logout" ? "logout" : "status");
  let lease: Awaited<ReturnType<typeof leaseOrdinaryToolCommand>> | null = null;
  try {
    lease = await leaseOrdinaryToolCommand(frame.tool_id);
    const dirs = await accountDirs(frame.tool_id, frame.account_key);
    if (frame.action !== "logout") {
      return { ok: true, error: null, status: await statusFor(lease.command, dirs, frame.action === "verify", dependencies.statusTimeoutMs) };
    }
    // The official logout, then a fresh read. Never a directory removal.
    const outcome = await runCommand(lease.command, ["auth", "logout", "--json"], accountChildEnv(dirs), dirs.home, dependencies.statusTimeoutMs ?? STATUS_TIMEOUT_MS);
    const result = jsonObject(outcome.stdout.trim());
    if (outcome.code !== 0 || !result || result.ok !== true) {
      return { ok: false, error: "The CLI's logout did not complete.", status: await statusFor(lease.command, dirs, false, dependencies.statusTimeoutMs) };
    }
    const cleared = result.loggedOut === true;
    return {
      ok: true, error: null,
      status: await statusFor(lease.command, dirs, false, dependencies.statusTimeoutMs),
      logout: { local_cleared: cleared, remote_revocation: cleared ? "attempted_unconfirmed" : "not_applicable" },
    };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message.slice(0, 300) : "account_request_failed", status: null };
  } finally {
    lease?.release();
    claims.delete(claim);
  }
}

/**
 * Starts the official setup or login for one account. `emit` receives only
 * protocol events. A session for the same account supersedes the earlier one
 * once that one has stopped; an action in progress refuses it.
 */
export async function openOrdinaryAccountSession(
  frame: Omit<HostServerFrameOf<"ordinary_account_session_open">, "type">,
  emit: (event: OrdinaryAccountSessionEvent) => void,
  log: (line: string) => void = () => {},
  dependencies: AccountDependencies = {},
): Promise<void> {
  const claim = `${frame.tool_id}:${frame.account_key}`;
  // Registered before the first await, so a close or a disconnect reaches this
  // session even while it waits for the one it supersedes.
  let finish: () => void = () => {};
  const session: Session = { id: frame.session_id, claim, child: null, cancelled: false, exited: new Promise((resolve) => { finish = resolve; }) };
  sessions.set(session.id, session);
  let ownsClaim = false;
  let lease: Awaited<ReturnType<typeof leaseOrdinaryToolCommand>> | null = null;
  let ended = false;
  // Releases only what this session holds: never another session's claim,
  // registration or place in line.
  const end = (event: Extract<OrdinaryAccountSessionEvent, { kind: "exit" }>) => {
    if (ended) return;
    ended = true;
    lease?.release();
    if (sessions.get(session.id) === session) sessions.delete(session.id);
    if (ownsClaim && claims.get(claim) === session) claims.delete(claim);
    if (successors.get(claim) === session) successors.delete(claim);
    log(`ordinary account ${frame.flow} session ${frame.session_id} ended: ${event.outcome}`);
    emit(event);
    finish();
  };
  const cancelledExit = () => end({ kind: "exit", outcome: "cancelled", error: null, status: null });
  try {
    const holder = claims.get(claim);
    if (holder && typeof holder === "object") {
      // Newest request wins: an earlier one still waiting is cancelled, so at
      // most one successor ever takes the claim and starts the CLI.
      const waiting = successors.get(claim);
      if (waiting) cancel(waiting);
      successors.set(claim, session);
      cancel(holder);
      await holder.exited;
      if (successors.get(claim) === session) successors.delete(claim);
    }
    if (session.cancelled) return cancelledExit();
    if (claims.has(claim)) return end({ kind: "exit", outcome: "failed", error: "account_busy", status: null });
    if (runUses.has(claim)) return end({ kind: "exit", outcome: "failed", error: IN_USE_BY_RUN, status: null });
    claims.set(claim, session);
    ownsClaim = true;
    lease = await leaseOrdinaryToolCommand(frame.tool_id);
    if (session.cancelled) return cancelledExit();
    const dirs = await accountDirs(frame.tool_id, frame.account_key);
    if (session.cancelled) return cancelledExit();
    const result = await runSession(frame.flow, lease.command, dirs, session, emit, dependencies.sessionTimeoutMs ?? SESSION_TIMEOUT_MS);
    // The login process is gone; a cancel from here on must not signal its pid.
    session.child = null;
    // The claim and the tool lease stay held until this status process has
    // exited too, so nothing replaces the binary or starts another CLI on this
    // account underneath it.
    const status = await statusFor(lease.command, dirs, false, dependencies.statusTimeoutMs).catch(() => null);
    // Cancelled while the status was read (closed, superseded, disconnected):
    // the session ends cancelled. The status is still the account's real one;
    // a cancel does not undo an authorization the person already completed.
    if (session.cancelled && result.outcome !== "cancelled") return end({ kind: "exit", outcome: "cancelled", error: null, status });
    end({ kind: "exit", ...result, status });
  } catch (error) {
    end({ kind: "exit", outcome: "failed", error: error instanceof Error ? error.message.slice(0, 300) : "account_session_failed", status: null });
  }
}

/**
 * Lets one Run use this person's account directories until `release`, which
 * the daemon calls when the Run's process has exited. Unavailable while the
 * account's setup, login or logout is in progress.
 */
export async function acquireRunAccountUse(toolId: string, accountKey: string): Promise<
  { ok: true; config: string; data: string; release: () => void } | { ok: false; reason: "busy" }
> {
  const claim = `${toolId}:${accountKey}`;
  const holder = claims.get(claim);
  if (holder === "logout" || typeof holder === "object") return { ok: false, reason: "busy" };
  runUses.set(claim, (runUses.get(claim) ?? 0) + 1);
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    const count = (runUses.get(claim) ?? 1) - 1;
    if (count > 0) runUses.set(claim, count); else runUses.delete(claim);
  };
  try {
    const dirs = await accountDirs(toolId, accountKey);
    return { ok: true, config: dirs.config, data: dirs.data, release };
  } catch (error) {
    release();
    throw error;
  }
}

function cancel(session: Session): void {
  session.cancelled = true;
  if (session.child) stop(session.child);
}

/** The control plane closed this session (stream gone, superseded or cancelled). */
export function closeOrdinaryAccountSession(sessionId: string): void {
  const session = sessions.get(sessionId);
  if (session) cancel(session);
}

/** The connection to the control plane is gone: nobody can complete these. */
export function closeAllOrdinaryAccountSessions(): void {
  for (const session of sessions.values()) cancel(session);
}

function runSession(
  flow: OrdinaryAccountFlow,
  command: string,
  dirs: AccountDirs,
  session: Session,
  emit: (event: OrdinaryAccountSessionEvent) => void,
  timeoutMs: number,
): Promise<{ outcome: "completed" | "failed" | "cancelled" | "timed_out"; error: string | null }> {
  const args = flow === "init" ? ["config", "init", "--new"] : ["auth", "login", "--recommend", "--json"];
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd: dirs.home, env: accountChildEnv(dirs), stdio: ["ignore", "pipe", "pipe"] });
    session.child = child;
    let timedOut = false;
    let announced = false;
    let completed = false;
    let failed = false;
    let stderrTail = "";
    const timer = setTimeout(() => { timedOut = true; stop(child); }, timeoutMs);
    timer.unref?.();
    const announce = (url: string | null, userCode: unknown, expiresIn: unknown) => {
      if (!url || announced) return;
      announced = true;
      emit({
        kind: "authorization",
        url,
        user_code: typeof userCode === "string" && /^[A-Za-z0-9-]{1,64}$/.test(userCode) ? userCode : null,
        expires_in: typeof expiresIn === "number" && Number.isInteger(expiresIn) && expiresIn > 0 && expiresIn <= 86_400 ? expiresIn : null,
      });
    };
    const lines = (onLine: (line: string) => void) => {
      let buffer = "";
      let seen = 0;
      return (chunk: Buffer) => {
        if (seen > MAX_OUTPUT_BYTES) return;
        seen += chunk.length;
        buffer += chunk.toString("utf8");
        let newline: number;
        while ((newline = buffer.indexOf("\n")) >= 0) {
          onLine(buffer.slice(0, newline).slice(0, MAX_LINE_BYTES));
          buffer = buffer.slice(newline + 1);
        }
        if (buffer.length > MAX_LINE_BYTES) buffer = "";
      };
    };
    child.stdout?.on("data", lines((line) => {
      const event = jsonObject(line.trim());
      if (!event) return;
      if (flow === "login") {
        if (event.event === "device_authorization") announce(authorizationUrl(event.verification_uri_complete), event.user_code, event.expires_in);
        else if (event.event === "authorization_complete") completed = true;
        else if (event.event === "authorization_failed") failed = true;
      } else if (typeof event.appId === "string") {
        completed = true;
      }
    }));
    child.stderr?.on("data", lines((line) => {
      if (stderrTail.length < MAX_LINE_BYTES) stderrTail += `${line}\n`;
      // Setup prints its link as text; only an official https link is taken.
      if (flow === "init") for (const token of line.split(/\s+/)) announce(authorizationUrl(token), null, null);
    }));
    child.on("error", () => {
      clearTimeout(timer);
      resolve({ outcome: "failed", error: "The CLI could not be started." });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (session.cancelled) return resolve({ outcome: "cancelled", error: null });
      if (timedOut) return resolve({ outcome: "timed_out", error: "The authorization was not completed in time." });
      if (code === 0 && (completed || flow === "init") && !failed) return resolve({ outcome: "completed", error: null });
      const subtype = errorSubtype(stderrTail);
      resolve({
        outcome: "failed",
        error: failed ? "The authorization was not completed."
          : subtype === "not_configured" ? "Run the CLI's initialization first."
            : subtype ? `The CLI reported an error (${subtype}).` : "The CLI exited without completing.",
      });
    });
  });
}
