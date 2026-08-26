import { spawn, type ChildProcess } from "node:child_process";
import { homedir, platform } from "node:os";
import { join } from "node:path";
import { loggedIn, OWN_INSTALLATION, readToolManifestSync, renderManagedLoginCommand, toolsDir, type ToolLoginSpec } from "./tools.js";

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
export interface LoginOpenFrame {
  session_id: string;
  adapter_type: string;
  installation: string;
  login: ToolLoginSpec | null;
}

export interface LoginSession {
  write(data: string): void;
  close(): void;
}

const sessions = new Map<string, LoginSession>();

/** What to run and where, for one copy. A runtime with no login command gets a shell in that copy's environment. */
export function resolveLoginCommand(frame: LoginOpenFrame): { command: string[]; env: Record<string, string>; home: string; login: ToolLoginSpec | null } {
  const ambient = Object.fromEntries(Object.entries(process.env).filter((pair): pair is [string, string] => typeof pair[1] === "string"));
  if (frame.installation === OWN_INSTALLATION) {
    const command = frame.login?.command ?? [ambient.SHELL || "/bin/sh"];
    return { command, env: ambient, home: homedir(), login: frame.login };
  }
  const manifest = readToolManifestSync(frame.adapter_type, frame.installation);
  if (!manifest) throw new Error(`This daemon does not have ${frame.adapter_type} ${frame.installation} installed.`);
  // Rendered now rather than trusted from the manifest: the template's
  // placeholders can gain meanings after a copy was installed.
  const tree = join(toolsDir(), manifest.adapter_type, manifest.version);
  const command = renderManagedLoginCommand(tree, manifest.login ?? frame.login) ?? manifest.login_command ?? [ambient.SHELL || "/bin/sh"];
  return { command, env: { ...ambient, ...manifest.env, HOME: manifest.home }, home: manifest.home, login: manifest.login ?? frame.login };
}

/** `script(1)` differs between util-linux and BSD; both give the command a PTY and relay stdin. */
function ptyArgv(command: string[]): { command: string; args: string[] } {
  const shellLine = command.map((part) => `'${part.replace(/'/g, "'\\''")}'`).join(" ");
  // Size the terminal first: nothing else in the chain will, and a 0×0
  // terminal makes TUIs misbehave and wrap auth URLs.
  const sized = `stty cols 200 rows 40 2>/dev/null; exec ${shellLine}`;
  if (platform() === "darwin") return { command: "script", args: ["-q", "/dev/null", "sh", "-c", sized] };
  // util-linux runs `-c` through the shell itself.
  return { command: "script", args: ["-qfec", sized, "/dev/null"] };
}

export function openLoginSession(
  frame: LoginOpenFrame,
  send: (frame: Record<string, unknown>) => void,
  log: (line: string) => void,
): LoginSession {
  if (platform() === "win32") throw new Error("Interactive login is not supported on Windows hosts yet.");
  sessions.get(frame.session_id)?.close();
  const resolved = resolveLoginCommand(frame);
  const pty = ptyArgv(resolved.command);
  log(`login ${frame.adapter_type} ${frame.installation}: ${resolved.command.join(" ")}`);
  const env: Record<string, string> = { ...resolved.env, TERM: "xterm-256color", COLUMNS: "200", LINES: "40" };
  // A vendor login must not pick up an API key from the ambient environment
  // and skip the flow the person came here for.
  delete env.ANTHROPIC_API_KEY;
  delete env.OPENAI_API_KEY;
  const child: ChildProcess = spawn(pty.command, pty.args, { env, cwd: resolved.home, stdio: ["pipe", "pipe", "pipe"] });
  let exited = false;
  const finish = (code: number | null) => {
    if (exited) return;
    exited = true;
    sessions.delete(frame.session_id);
    send({
      type: "login_exit",
      session_id: frame.session_id,
      exit_code: code ?? -1,
      logged_in: loggedIn(resolved.home, resolved.login),
    });
  };
  child.stdout?.on("data", (chunk: Buffer) => send({ type: "login_output", session_id: frame.session_id, data: chunk.toString("utf8") }));
  child.stderr?.on("data", (chunk: Buffer) => send({ type: "login_output", session_id: frame.session_id, data: chunk.toString("utf8") }));
  child.on("error", (error) => {
    send({ type: "login_output", session_id: frame.session_id, data: `${error.message}\n` });
    finish(-1);
  });
  child.on("close", (code) => finish(code));
  const session: LoginSession = {
    write(data) {
      try { child.stdin?.write(data); } catch { /* the process is gone; exit follows */ }
    },
    close() {
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

export function parseLoginOpenFrame(frame: Record<string, unknown>): LoginOpenFrame {
  const { session_id, adapter_type, installation } = frame;
  if (typeof session_id !== "string" || typeof adapter_type !== "string" || typeof installation !== "string") {
    throw new Error("login_open frame is missing session_id, adapter_type, or installation");
  }
  const login = frame.login as Record<string, unknown> | null | undefined;
  return {
    session_id,
    adapter_type,
    installation,
    login: login && Array.isArray(login.command) && typeof login.home_subdir === "string" && typeof login.credential_file === "string"
      ? {
          command: login.command.map(String),
          ...(Array.isArray(login.managed_command) ? { managed_command: login.managed_command.map(String) } : {}),
          home_subdir: login.home_subdir,
          credential_file: login.credential_file,
          ...(typeof login.hint === "string" ? { hint: login.hint } : {}),
        }
      : null,
  };
}
