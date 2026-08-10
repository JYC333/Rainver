/**
 * CLI login engine — server owner of the interactive vendor-CLI login flows.
 *
 * CLI login always runs the vendor command on a real PTY supplied by the
 * scoped Sandbox Runner, because
 * vendor login flows are terminal-sensitive:
 *   navigating  → press Enter whenever output settles, until a URL appears,
 *                 then emit needs_input for CLIs that expect a code back;
 *   waiting_code→ the user's code arrives via sendCliLoginInput;
 *   post_code   → send /exit until the process closes.
 *
 * After a successful login the engine copies the login state from the
 * process HOME into the managed profile directory (the durable credential
 * store under AGENT_SPACE_HOME/secrets/cli-credentials) and emits a
 * `synced` event. Login state is the ADR 0008 CLI channel: it is never
 * pooled, rotated, or exposed through responses.
 */

import { cp, mkdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export interface LoginRuntimeConfig {
  method: "cli";
  command?: string[];
  home_subdir?: string;
  /**
   * Login-state file inside {@link home_subdir} that proves a successful login
   * (e.g. `.credentials.json`). When set, the engine syncs whenever this file
   * was (re)written after the login started, even if the CLI exits non-zero —
   * TUI exit codes are unreliable for REPL-style CLIs like `claude /login`.
   */
  credential_file?: string;
  label: string;
  hint_cli?: string;
  /** Runtime-specific output parser for terminal output. */
  createOutputParser?: () => LoginOutputParser;
}

export interface LoginOutputParserInput {
  buffer: string;
  chunk: string;
  stripAnsi: (text: string) => string;
}

export interface LoginOutputParserResult {
  events?: LoginEvent[];
  suppressDefaultCodePrompt?: boolean;
  resetBuffer?: boolean;
}

export type LoginOutputParser = (input: LoginOutputParserInput) => LoginOutputParserResult;

export interface LoginToolResolver {
  resolveForExecution(runtime: string): Promise<{ executable_path: string }>;
}

export type LoginEvent = Record<string, unknown> & { type: string };
export type LoginEmit = (event: LoginEvent) => void;

/** Minimal PTY surface; production supplies the scoped Runner implementation. */
export interface PtyHandle {
  write(data: string): void;
  onData(listener: (data: string) => void): void;
  onExit(listener: (exitCode: number) => void): void;
  kill(): void;
}

export interface PtyFactory {
  spawn(command: string, args: string[], options: {
    cols: number;
    rows: number;
    env: Record<string, string>;
  }): PtyHandle;
}

export interface LoginTimings {
  /** Wait this long after output stops before pressing Enter. */
  outputSettleMs: number;
  /** Minimum gap between consecutive automated keystrokes. */
  actionCooldownMs: number;
  /** State-machine poll interval. */
  pollMs: number;
  /** Total login timeout. */
  deadlineMs: number;
}

const DEFAULT_TIMINGS: LoginTimings = {
  outputSettleMs: 1_000,
  actionCooldownMs: 3_000,
  pollMs: 200,
  deadlineMs: 300_000,
};

// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g;
const URL_RE = /https?:\/\/\S+/;

// PTY auth URLs are 300+ chars; the terminal must not wrap them or the
// frontend URL regex misses them.
const PTY_COLS = 500;
const PTY_ROWS = 24;

interface ActiveLogin {
  write(input: string): boolean;
  kill(): void;
}

const activeLogins = new Map<string, ActiveLogin>();

let ptyFactoryOverride: PtyFactory | null = null;
let homeOverride: string | null = null;

export function __setLoginFactoriesForTests(overrides: {
  pty?: PtyFactory | null;
  home?: string | null;
}): void {
  ptyFactoryOverride = overrides.pty ?? null;
  homeOverride = overrides.home ?? null;
}

async function defaultPtyFactory(): Promise<PtyFactory> {
  throw new Error("Interactive CLI login requires the scoped Sandbox Runner PTY factory.");
}

function processHome(): string {
  return homeOverride ?? homedir();
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

function stripAnsi(text: string): string {
  return text.replace(ANSI_RE, "");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isolateVendorLoginEnv(env: Record<string, string>): void {
  // Vendor login commands should establish browser/device auth in their
  // isolated HOME, not silently fall back to API-key env credentials.
  delete env.ANTHROPIC_API_KEY;
  delete env.OPENAI_API_KEY;
  for (const key of Object.keys(env)) {
    if (key.startsWith("CODEX_")) delete env[key];
  }
}

// ---------------------------------------------------------------------------
// Credential sync (shared by both modes)
// ---------------------------------------------------------------------------

/**
 * True when the runtime's credential file inside `src` was written at or after
 * `since`. This is the reliable success signal for REPL-style CLIs whose exit
 * code we cannot trust: the OAuth token is only persisted once login completes.
 */
async function loginStateTouchedSince(
  src: string,
  cfg: LoginRuntimeConfig,
  since: number,
): Promise<boolean> {
  if (!cfg.credential_file) return false;
  try {
    const st = await stat(join(src, cfg.credential_file));
    return st.mtimeMs >= since;
  } catch {
    return false;
  }
}

/** Returns true when credentials were copied into the managed profile dir. */
async function syncCredentials(
  exitCode: number,
  cfg: LoginRuntimeConfig,
  profileDir: string,
  runtime: string,
  emit: LoginEmit,
  loginStartedAt: number,
  loginHome: string,
  profileId?: string | null,
): Promise<boolean> {
  if (!cfg.home_subdir) return false;

  const src = join(loginHome, cfg.home_subdir);
  const srcExists = await exists(src);

  // A non-zero exit does not mean failure: `claude /login` drops into a REPL we
  // quit with /exit, so the process often exits non-zero (or is killed) even
  // after a successful OAuth login. Trust the login state on disk — if the
  // credential file was (re)written after this login started, sync regardless.
  const freshlyAuthenticated =
    srcExists && (await loginStateTouchedSince(src, cfg, loginStartedAt));

  if (exitCode !== 0 && !freshlyAuthenticated) return false;

  if (!srcExists) {
    emit({
      type: "warning",
      text: `Login succeeded but ${src} not found — credentials not synced.\n`,
    });
    return false;
  }

  try {
    await mkdir(profileDir, { recursive: true, mode: 0o700 });
    await cp(src, profileDir, { recursive: true, force: true });
    // .claude.json lives at HOME root (not inside HOME/.claude/); copy it so
    // temp-HOME creation can symlink it back at the right level.
    const claudeJson = join(loginHome, ".claude.json");
    if (await exists(claudeJson)) {
      await cp(claudeJson, join(profileDir, ".claude.json"), { force: true });
    }
    emit({
      type: "synced",
      text: "Credentials copied to managed profile.\n",
      profile_id: profileId ?? null,
    });
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    emit({ type: "warning", text: `Login succeeded but copy failed: ${message}\n` });
    return false;
  }
}

// ---------------------------------------------------------------------------
// PTY login (TUI CLIs)
// ---------------------------------------------------------------------------

async function runPtyLogin(
  runtime: string,
  sessionKey: string,
  cfg: LoginRuntimeConfig,
  profileDir: string,
  emit: LoginEmit,
  loginHome: string,
  timings: LoginTimings,
  profileId?: string | null,
  suppliedFactory?: PtyFactory,
): Promise<void> {
  const command = cfg.command as string[];
  // Captured before spawn so a credential file written during login is newer.
  const startedAt = Date.now();
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value;
  }
  env.TERM = env.TERM || "xterm-256color";
  // Isolate the login from the host: the CLI writes its login state into an
  // aspace-managed HOME, never the operator's real ~/.<runtime>.
  env.HOME = loginHome;
  isolateVendorLoginEnv(env);

  activeLogins.get(sessionKey)?.kill();
  activeLogins.delete(sessionKey);

  await mkdir(loginHome, { recursive: true, mode: 0o700 });
  const factory = suppliedFactory ?? ptyFactoryOverride ?? (await defaultPtyFactory());
  const handle = factory.spawn(command[0], command.slice(1), {
    cols: PTY_COLS,
    rows: PTY_ROWS,
    env,
  });

  // Object-wrapped so the sendCliLoginInput closure's post_code transition is
  // visible to the polling loop (and to TS control-flow analysis).
  const machine = { state: "navigating" as "navigating" | "waiting_code" | "post_code" };
  let raw = "";
  let lastOutputAt = 0;
  let lastActionAt = 0;
  let suppressDefaultInputPrompt = false;
  let exited = false;
  let exitCode = -1;
  const parseRuntimeOutput = cfg.createOutputParser?.();

  const exitPromise = new Promise<void>((resolve) => {
    handle.onExit((code) => {
      exited = true;
      exitCode = code;
      resolve();
    });
  });

  handle.onData((data) => {
    raw += data;
    lastOutputAt = Date.now();
    emit({ type: "output", text: stripAnsi(data) });
    const parsed = parseRuntimeOutput?.({ buffer: raw, chunk: data, stripAnsi });
    for (const event of parsed?.events ?? []) {
      emit(event);
    }
    if (parsed?.suppressDefaultCodePrompt) {
      suppressDefaultInputPrompt = true;
    }
    if (parsed?.resetBuffer) {
      raw = "";
    }
  });

  activeLogins.set(sessionKey, {
    write(input: string): boolean {
      try {
        handle.write(`${input.trim()}\r`);
        machine.state = "post_code";
        return true;
      } catch {
        return false;
      }
    },
    kill: () => handle.kill(),
  });

  const deadline = Date.now() + timings.deadlineMs;
  try {
    while (!exited && Date.now() < deadline) {
      await Promise.race([exitPromise, sleep(timings.pollMs)]);
      if (exited) break;
      const now = Date.now();

      if (
        machine.state === "navigating" &&
        lastOutputAt > 0 &&
        now - lastOutputAt > timings.outputSettleMs &&
        now - lastActionAt > timings.actionCooldownMs
      ) {
        if (URL_RE.test(stripAnsi(raw))) {
          machine.state = "waiting_code";
          if (!suppressDefaultInputPrompt) {
            emit({
              type: "needs_input",
              step: "code",
              prompt: "Open the URL above in your browser, then paste the authorization code here.",
            });
          }
        } else {
          try {
            handle.write("\r");
            lastActionAt = now;
          } catch {
            // PTY already closed; the exit handler will end the loop.
          }
        }
      } else if (machine.state === "post_code") {
        // Primary completion signal: the credential file was (re)written after
        // login started. We must not wait for the REPL to honor /exit — claude
        // 2.x stays in its REPL and ignores it, which would otherwise block
        // until the deadline. Detecting the fresh credential file lets us close
        // and sync within a poll of a successful login.
        if (cfg.home_subdir && (await loginStateTouchedSince(join(loginHome, cfg.home_subdir), cfg, startedAt))) {
          handle.kill();
          break;
        }
        if (now - lastActionAt > timings.actionCooldownMs) {
          try {
            handle.write("/exit\r"); // best-effort graceful quit for CLIs that honor it
            lastActionAt = now;
          } catch {
            // PTY already closed; the exit handler will end the loop.
          }
        }
      }
    }
  } finally {
    activeLogins.delete(sessionKey);
  }

  if (!exited) {
    handle.kill();
    await Promise.race([exitPromise, sleep(5_000)]);
  }

  // Report success when credentials landed, even if the TUI exit code was non-zero.
  const synced = await syncCredentials(
    exitCode,
    cfg,
    profileDir,
    runtime,
    emit,
    startedAt,
    loginHome,
    profileId,
  );
  emit({ type: "done", exit_code: synced ? 0 : exitCode });
}

// ---------------------------------------------------------------------------
// Public entry points
// ---------------------------------------------------------------------------

export async function runCliLogin(
  runtime: string,
  cfg: LoginRuntimeConfig | undefined,
  profileDir: string,
  emit: LoginEmit,
  timings: LoginTimings = DEFAULT_TIMINGS,
  toolResolver?: LoginToolResolver,
  loginHome?: string,
  profileId?: string | null,
  sessionKey?: string,
  ptyFactory?: PtyFactory,
): Promise<void> {
  if (!cfg) {
    emit({ type: "error", text: `Unknown runtime: ${runtime}\n` });
    return;
  }
  if (!cfg.command || cfg.command.length === 0) {
    emit({ type: "error", text: `'${runtime}' does not support CLI login.\n` });
    return;
  }

  let command = cfg.command;
  if (!toolResolver) {
    emit({
      type: "error",
      text: `Controlled runtime tool resolver is required for ${cfg.label} login.\n`,
    });
    return;
  }
  try {
    const resolved = await toolResolver.resolveForExecution(runtime);
    command = [resolved.executable_path, ...cfg.command.slice(1)];
  } catch (error) {
    emit({
      type: "error",
      text: error instanceof Error
        ? `${error.message}\n`
        : `${cfg.label} runtime tool is not installed.\n`,
    });
    return;
  }

  const runtimeCfg = { ...cfg, command };
  // Default to the test/process home only when the caller (the broker) did not
  // supply an aspace-managed login HOME.
  const resolvedHome = loginHome ?? processHome();
  emit({ type: "output", text: `$ ${command.join(" ")}\n` });
  if (cfg.hint_cli) emit({ type: "hint", text: `${cfg.hint_cli}\n` });

  await runPtyLogin(
    runtime,
    sessionKey ?? runtime,
    runtimeCfg,
    profileDir,
    emit,
    resolvedHome,
    timings,
    profileId,
    ptyFactory,
  );
}

/**
 * Deliver user-provided text (e.g. an OAuth code) to an active login.
 * PTY logins also advance to the post_code state so the engine starts
 * sending /exit. Returns true when the input was delivered.
 */
export function sendCliLoginInput(runtime: string, input: string, sessionKey?: string): boolean {
  const session = activeLogins.get(sessionKey ?? runtime);
  if (!session) return false;
  return session.write(input);
}
