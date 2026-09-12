import type { HostDaemonFrame, HostServerFrameOf } from "@rainver/protocol";
import { LOGIN_TERMINAL_COLS, LOGIN_TERMINAL_ROWS } from "@rainver/protocol";
import { spawn, type ChildProcess } from "node:child_process";
import { homedir, platform } from "node:os";
import { join } from "node:path";
import { loggedIn, OWN_INSTALLATION, readToolManifestSync, renderManagedLoginCommand, toolsDir, type ToolLoginSpec, renderManagedCommand } from "./tools.js";
import { parseAcpAuthMethods } from "./acpProbe.js";
import { holdAdapter, resolveAcpLaunch, substituteCwd } from "./execution.js";
import { terminalAuthAvailable } from "./terminalAuth.js";
import { clearVendorCredentialEnv } from "./providerBinding.js";

/**
 * An interactive login for one installation of a runtime, run on this
 * machine in a real terminal and mirrored to the control plane frame by
 * frame. Vendor login flows are terminal-sensitive (REPLs, device-code
 * prompts, browser hand-offs), so the command gets a PTY — from `script(1)`,
 * which every Linux and macOS has, rather than a native addon this daemon
 * would have to build on the host.
 *
 * The person types in the browser; the daemon only relays. A managed copy
 * logs in with `HOME` set to its own home, so the state lands in that copy
 * and nowhere else; the machine's own copy logs in as the machine.
 */
/** The wire's `login_open` frame, minus its type tag. */
export type LoginOpenFrame = Omit<HostServerFrameOf<"login_open">, "type">;

export interface LoginSession {
  write(data: string): void;
  close(): void;
}

const sessions = new Map<string, LoginSession>();

function resolveAuthAgentLaunch(frame: LoginOpenFrame): { command: string; args: string[]; env: Record<string, string>; home: string } {
  if (frame.installation !== OWN_INSTALLATION) {
    const manifest = readToolManifestSync(frame.adapter_type, frame.installation);
    if (!manifest) throw new Error(`This daemon does not have ${frame.adapter_type} ${frame.installation} installed.`);
    return { command: manifest.command, args: manifest.args, env: manifest.env, home: manifest.home };
  }
  if (!frame.argv?.length) throw new Error("This ACP authentication flow has no launch command");
  const home = homedir();
  const [rawCommand, ...args] = frame.argv.map((arg) => substituteCwd(arg, home));
  return { ...resolveAcpLaunch(rawCommand!, args, OWN_INSTALLATION, frame.adapter_type), home };
}

function loginAmbient(adapterType: string): Record<string, string> {
  return clearVendorCredentialEnv(process.env, adapterType);
}

/** What fixed login program to run for one copy. */
export function resolveLoginCommand(frame: LoginOpenFrame): { command: string[]; env: Record<string, string>; home: string; login: ToolLoginSpec | null } {
  const ambient = loginAmbient(frame.adapter_type);
  if (frame.auth_method && frame.login_action) throw new Error("Choose either ACP authentication or CLI login");
  if (frame.login_action === "logout") return resolveLogoutCommand(frame, ambient);
  if (frame.login_action === "cli") {
    if (frame.installation === OWN_INSTALLATION) throw new Error("CLI login fallback is only available for managed Agents");
    const manifest = readToolManifestSync(frame.adapter_type, frame.installation);
    if (!manifest) throw new Error(`This daemon does not have ${frame.adapter_type} ${frame.installation} installed.`);
    const entryArgs = manifest.entry_args ?? (manifest.command === process.execPath ? null : []);
    if (!entryArgs) throw new Error("Reinstall this managed Agent before using CLI login");
    return {
      command: [manifest.command, ...entryArgs, "login"],
      env: { ...ambient, ...manifest.env, HOME: manifest.home },
      home: manifest.home,
      login: null,
    };
  }
  if (frame.auth_method?.type === "terminal") {
    const launch = resolveAuthAgentLaunch(frame);
    return {
      command: [launch.command, ...launch.args, ...frame.auth_method.args],
      env: { ...ambient, ...launch.env, ...frame.auth_method.env, HOME: launch.home },
      home: launch.home,
      login: null,
    };
  }
  if (frame.installation === OWN_INSTALLATION) {
    const command = frame.login?.command;
    if (!command) throw new Error("This installation does not declare a supported login method");
    return { command, env: ambient, home: homedir(), login: frame.login };
  }
  const manifest = readToolManifestSync(frame.adapter_type, frame.installation);
  if (!manifest) throw new Error(`This daemon does not have ${frame.adapter_type} ${frame.installation} installed.`);
  // Rendered now rather than trusted from the manifest: the template's
  // placeholders can gain meanings after a copy was installed.
  const tree = join(toolsDir(), manifest.adapter_type, manifest.version);
  const command = renderManagedLoginCommand(tree, manifest.login ?? frame.login) ?? manifest.login_command;
  if (!command) throw new Error("This installation does not declare a supported login method");
  return { command, env: { ...ambient, ...manifest.env, HOME: manifest.home }, home: manifest.home, login: manifest.login ?? frame.login };
}

/**
 * The vendor's own logout, from the login spec (`logout_command`, or its
 * managed form in the copy's tree), or — for a registry agent Rainver logs in
 * through its fixed `<entry> login` — the same entry's `logout`. Runs in the
 * same isolated HOME as the login did; it is one more fixed command, never a
 * remotely supplied one.
 */
function resolveLogoutCommand(
  frame: LoginOpenFrame,
  ambient: Record<string, string>,
): { command: string[]; env: Record<string, string>; home: string; login: ToolLoginSpec | null } {
  if (frame.installation === OWN_INSTALLATION) {
    const command = frame.login?.logout_command;
    if (!command) throw new Error("This installation does not declare a logout command");
    return { command, env: ambient, home: homedir(), login: frame.login };
  }
  const manifest = readToolManifestSync(frame.adapter_type, frame.installation);
  if (!manifest) throw new Error(`This daemon does not have ${frame.adapter_type} ${frame.installation} installed.`);
  const login = manifest.login ?? frame.login;
  const tree = join(toolsDir(), manifest.adapter_type, manifest.version);
  const specCommand = renderManagedCommand(tree, login?.managed_logout_command);
  if (specCommand) {
    return { command: specCommand, env: { ...ambient, ...manifest.env, HOME: manifest.home }, home: manifest.home, login };
  }
  if (login) throw new Error("This installation does not declare a logout command");
  const entryArgs = manifest.entry_args ?? (manifest.command === process.execPath ? null : []);
  if (!entryArgs) throw new Error("Reinstall this managed Agent before using CLI logout");
  return {
    command: [manifest.command, ...entryArgs, "logout"],
    env: { ...ambient, ...manifest.env, HOME: manifest.home },
    home: manifest.home,
    login: null,
  };
}

function sanitizedEnv(extra: Record<string, string>, home: string, adapterType: string): Record<string, string> {
  return { ...loginAmbient(adapterType), ...extra, HOME: home };
}

function acpErrorText(value: unknown): string {
  if (value && typeof value === "object" && "message" in value && typeof value.message === "string") {
    return value.message.slice(0, 1000);
  }
  return "Agent returned an error";
}

/** ACP Agent Auth: initialize a fresh copy, verify the method, then authenticate by id. */
function openAgentAuthSession(
  frame: LoginOpenFrame,
  send: (frame: HostDaemonFrame) => void,
  log: (line: string) => void,
): LoginSession {
  const launch = resolveAuthAgentLaunch(frame);
  const method = frame.auth_method!;
  const child = spawn(launch.command, launch.args, {
    cwd: launch.home,
    stdio: ["pipe", "pipe", "pipe"],
    env: sanitizedEnv(launch.env, launch.home, frame.adapter_type),
  });
  log(`ACP authenticate ${frame.adapter_type} ${frame.installation}: ${method.id}`);
  let buffer = "";
  let exited = false;
  let waitingTimer: ReturnType<typeof setTimeout> | null = null;
  const finish = (code: number, loggedInState: boolean) => {
    if (exited) return;
    exited = true;
    if (waitingTimer) clearTimeout(waitingTimer);
    sessions.delete(frame.session_id);
    try { child.kill(); } catch { /* already gone */ }
    send({ type: "login_exit", session_id: frame.session_id, exit_code: code, logged_in: loggedInState });
  };
  const write = (message: Record<string, unknown>) => child.stdin?.write(`${JSON.stringify(message)}\n`);
  child.stdout?.on("data", (chunk: Buffer) => {
    buffer += chunk.toString("utf8");
    let at = buffer.indexOf("\n");
    while (at !== -1) {
      const line = buffer.slice(0, at);
      buffer = buffer.slice(at + 1);
      at = buffer.indexOf("\n");
      if (!line.trim()) continue;
      let message: Record<string, unknown>;
      try { message = JSON.parse(line) as Record<string, unknown>; } catch { continue; }
      if (message.id === 1) {
        if (message.error) {
          send({ type: "login_output", session_id: frame.session_id, data: `ACP initialize failed: ${acpErrorText(message.error)}\n` });
          finish(1, false);
          continue;
        }
        const advertised = parseAcpAuthMethods((message.result as Record<string, unknown> | undefined)?.authMethods);
        if (!advertised.some((candidate) => candidate.id === method.id && candidate.type === "agent")) {
          send({ type: "login_output", session_id: frame.session_id, data: `Authentication method '${method.id}' is no longer advertised.\n` });
          finish(1, false);
          continue;
        }
        send({ type: "login_output", session_id: frame.session_id, data: `Starting ${method.name}…\n` });
        write({ jsonrpc: "2.0", id: 2, method: "authenticate", params: { methodId: method.id } });
        waitingTimer = setTimeout(() => {
          send({
            type: "login_output",
            session_id: frame.session_id,
            data: "Still waiting for the Agent. It may require its own CLI login first; close this session and choose CLI login.\n",
          });
        }, 5_000);
        waitingTimer.unref?.();
        continue;
      }
      if (message.id === 2) {
        if (message.error) {
          send({ type: "login_output", session_id: frame.session_id, data: `Authentication failed: ${acpErrorText(message.error)}\n` });
          finish(1, false);
        } else {
          send({ type: "login_output", session_id: frame.session_id, data: "Authentication completed.\n" });
          finish(0, true);
        }
      }
    }
  });
  child.stderr?.on("data", (chunk: Buffer) => send({ type: "login_output", session_id: frame.session_id, data: chunk.toString("utf8") }));
  child.on("error", (error) => {
    send({ type: "login_output", session_id: frame.session_id, data: `${error.message}\n` });
    finish(1, false);
  });
  child.on("close", (code) => { if (!exited) finish(code ?? 1, false); });
  write({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: 1,
      clientCapabilities: {
        fs: { readTextFile: false, writeTextFile: false },
        ...(terminalAuthAvailable() ? { auth: { terminal: true } } : {}),
      },
      clientInfo: { name: "rainver-host", version: "1" },
    },
  });
  return {
    write() { /* Agent Auth is protocol-driven; there is no terminal stdin. */ },
    close() { try { child.kill("SIGTERM"); } catch { /* already gone */ } },
  };
}

/**
 * What a login session accepts from the browser. The command behind the PTY
 * is fixed by the adapter spec and stdin reaches only it, so this is not an
 * authorization boundary; it bounds what a keyboard can plausibly produce
 * so a misbehaving client cannot turn the channel into a firehose.
 */
export const LOGIN_INPUT_SESSION_MAX_CHARS = 256 * 1024;
export const LOGIN_INPUT_BURST_CHARS = 32 * 1024;
export const LOGIN_INPUT_CHARS_PER_SECOND = 8 * 1024;

export interface LoginInputRefusal {
  reason: string;
  /** Too fast: the frame is dropped and the session goes on. Over the lifetime budget: the session ends. */
  fatal: boolean;
}

/**
 * Token bucket plus a per-session total; returns why a frame is refused, or
 * null to admit it. A single frame's size is bounded by the wire schema
 * (`LOGIN_INPUT_MAX_CHARS`) before any frame reaches this.
 */
export function createLoginInputGovernor(now: () => number = Date.now): (data: string) => LoginInputRefusal | null {
  let tokens = LOGIN_INPUT_BURST_CHARS;
  let last = now();
  let total = 0;
  return (data) => {
    const at = now();
    // A wall clock can step backwards (NTP after sleep); never let that
    // drain the bucket.
    tokens = Math.min(LOGIN_INPUT_BURST_CHARS, tokens + (Math.max(0, at - last) / 1000) * LOGIN_INPUT_CHARS_PER_SECOND);
    last = at;
    if (data.length > tokens) {
      return { reason: `input arrived faster than ${LOGIN_INPUT_CHARS_PER_SECOND} characters per second; that input was dropped`, fatal: false };
    }
    tokens -= data.length;
    total += data.length;
    if (total > LOGIN_INPUT_SESSION_MAX_CHARS) {
      return { reason: `this session has received more than ${LOGIN_INPUT_SESSION_MAX_CHARS} characters of input`, fatal: true };
    }
    return null;
  };
}

/** `script(1)` differs between util-linux and BSD; both give the command a PTY and relay stdin. */
function ptyArgv(command: string[]): { command: string; args: string[] } {
  const shellLine = command.map((part) => `'${part.replace(/'/g, "'\\''")}'`).join(" ");
  // Size the terminal first: nothing else in the chain will, and a 0×0
  // terminal makes TUIs misbehave and wrap auth URLs.
  const sized = `stty cols ${LOGIN_TERMINAL_COLS} rows ${LOGIN_TERMINAL_ROWS} 2>/dev/null; exec ${shellLine}`;
  if (platform() === "darwin") return { command: "script", args: ["-q", "/dev/null", "sh", "-c", sized] };
  // util-linux runs `-c` through the shell itself.
  return { command: "script", args: ["-qfec", sized, "/dev/null"] };
}

export function openLoginSession(
  frame: LoginOpenFrame,
  send: (frame: HostDaemonFrame) => void,
  log: (line: string) => void,
): LoginSession {
  if (frame.auth_method && frame.login_action) throw new Error("Choose either ACP authentication or CLI login");
  sessions.get(frame.session_id)?.close();
  if (frame.auth_method?.type === "agent") {
    const session = openAgentAuthSession(frame, send, log);
    sessions.set(frame.session_id, session);
    return session;
  }
  if (!terminalAuthAvailable()) throw new Error("Interactive login requires the script(1) terminal utility on this host.");
  const resolved = resolveLoginCommand(frame);
  const pty = ptyArgv(resolved.command);
  log(`login ${frame.adapter_type} ${frame.installation}: ${resolved.command.join(" ")}`);
  const env: Record<string, string> = { ...resolved.env, TERM: "xterm-256color", COLUMNS: String(LOGIN_TERMINAL_COLS), LINES: String(LOGIN_TERMINAL_ROWS) };
  const child: ChildProcess = spawn(pty.command, pty.args, { env, cwd: resolved.home, stdio: ["pipe", "pipe", "pipe"] });
  // Held until this session ends, so a replacement of this copy waits rather
  // than deleting the directory the login is writing its credential into.
  const releaseLogin = holdAdapter(frame.adapter_type);
  // A write that lands as the program exits fails asynchronously (EPIPE) on
  // stdin's own 'error' event; unhandled, that would take the daemon down.
  child.stdin?.on("error", () => { /* the exit that follows is the report */ });
  let exited = false;
  let closing = false;
  const finish = (code: number | null) => {
    if (exited) return;
    exited = true;
    releaseLogin();
    sessions.delete(frame.session_id);
    send({
      type: "login_exit",
      session_id: frame.session_id,
      exit_code: code ?? -1,
      logged_in: frame.login_action === "logout"
        ? (resolved.login ? loggedIn(resolved.home, resolved.login) : code === 0 ? false : null)
        : frame.auth_method?.type === "terminal" || frame.login_action === "cli" ? code === 0 : loggedIn(resolved.home, resolved.login),
    });
  };
  child.stdout?.on("data", (chunk: Buffer) => send({ type: "login_output", session_id: frame.session_id, data: chunk.toString("utf8") }));
  child.stderr?.on("data", (chunk: Buffer) => send({ type: "login_output", session_id: frame.session_id, data: chunk.toString("utf8") }));
  child.on("error", (error) => {
    send({ type: "login_output", session_id: frame.session_id, data: `${error.message}\n` });
    finish(-1);
  });
  child.on("close", (code) => finish(code));
  const admit = createLoginInputGovernor();
  let lastRefusal: string | null = null;
  const session: LoginSession = {
    write(data) {
      if (closing) return;
      const refused = admit(data);
      if (refused) {
        // Say it once per streak: a held key would otherwise paint the notice
        // as fast as it drops keystrokes.
        if (refused.reason !== lastRefusal) {
          lastRefusal = refused.reason;
          log(`login ${frame.adapter_type} ${frame.installation}: input refused (${refused.reason})${refused.fatal ? "; closing" : ""}`);
          send({ type: "login_output", session_id: frame.session_id, data: `\r\n[rainver] ${refused.reason}${refused.fatal ? "; closing this login session" : ""}.\r\n` });
        }
        if (refused.fatal) session.close();
        return;
      }
      lastRefusal = null;
      try { child.stdin?.write(data); } catch { /* the process is gone; exit follows */ }
    },
    close() {
      if (closing) return;
      closing = true;
      try { child.kill("SIGTERM"); } catch { /* already gone */ }
      setTimeout(() => { try { child.kill("SIGKILL"); } catch { /* gone */ } }, 3000).unref?.();
    },
  };
  sessions.set(frame.session_id, session);
  return session;
}

export function loginSession(sessionId: string): LoginSession | undefined {
  return sessions.get(sessionId);
}
