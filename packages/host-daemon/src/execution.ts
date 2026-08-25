import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { createRequire } from "node:module";
import { configDir, requireConfig } from "./config.js";
import { uploadRunDiff, uploadRunOutputs } from "./api.js";
import { captureWorkspaceDiff } from "./gitDiff.js";
import { collectOutputFiles } from "./outputFiles.js";
import { filterAmbientEnv, materializeProviderBinding, sweepOrphanedProfiles } from "./providerBinding.js";

export interface LaunchFrame {
  run_id: string;
  workspace_location_id?: string;
  /** @deprecated pre-P1 wire/test alias; new frames use workspace_location_id. */
  project_folder_id?: string;
  argv: string[];
  stdin?: string | null;
  timeout_seconds?: number | null;
  /**
   * ACP runtime replatform P2: a bidirectional-protocol run (opencode's ACP
   * controller) drives the child's stdin across many `stdin` frames sent
   * over the run's lifetime, not just once at launch — the daemon must not
   * close stdin after the initial write the way it does for a one-shot
   * `argv_template` run.
   */
  keep_stdin_open?: boolean;
  /**
   * Backend selection for this run, when the control plane chose one. Absent
   * means the run uses whatever this machine is logged into, which is the
   * default and the pre-existing behavior.
   *
   * The daemon never sees a provider API key: `lease_token` authorizes one
   * short-lived lease at `lease_url`, and the server swaps in the real key
   * inside its own process.
   */
  provider_binding?: ProviderBindingFrame;
}

export interface ProviderBindingFrame {
  /**
   * Which profile directory this run's runtime uses, as
   * `<adapter_type>/<provider_id>`. Chosen by the control plane, validated
   * here before it becomes a path.
   *
   * Not per-run: a CLI keeps its conversation state inside the profile, so a
   * profile deleted with the run takes the session the next turn resumes with
   * it. Shared per adapter and provider, a conversation survives for as long
   * as its backend does not change.
   */
  profile_key: string;
  /**
   * Literal environment the runtime needs: the lease URL reachable from *this*
   * machine, its token, model names. No provider API key is ever among them —
   * the server swaps the real key in behind the proxy.
   */
  env: Record<string, string>;
  /**
   * Environment whose value is a path inside this run's profile directory,
   * which only this machine knows. Key → path relative to the profile root;
   * `"."` means the profile root itself.
   */
  profile_env: Record<string, string>;
  /**
   * Files to write under the profile root, paths relative to it. `contents`
   * may contain the profile-root placeholder; `escape` says how to encode the
   * substituted absolute path for that file's syntax.
   */
  files: Array<{ relative_path: string; contents: string; escape?: "toml_basic_string" }>;
}

export interface StdinFrame {
  run_id: string;
  value: string;
}

export interface StdinCloseFrame {
  run_id: string;
}

export interface TerminateFrame {
  run_id: string;
  force?: boolean;
}

interface ActiveRun {
  child: ChildProcess;
  cwd: string;
  timedOut: boolean;
  timeoutTimer: ReturnType<typeof setTimeout> | null;
  /** Removes this run's control-plane-provided profile, if it had one. */
}

/**
 * ACP runtime replatform P2 (A2): the daemon must not become a vendor
 * protocol translator, so it never parses the ACP JSON-RPC frames it relays
 * — but a remote ACP session still needs to tell the agent its real working
 * directory, and only the daemon (not the server, per ADR 0016 B64) knows
 * that path. This is the one deliberate exception: a plain, protocol-agnostic
 * text substitution on the outgoing byte stream, not JSON parsing or ACP
 * method awareness. The server embeds this exact literal wherever it would
 * otherwise need to write a real filesystem path
 * (`server/src/modules/runs/remoteHostCliAdapter.ts`'s
 * `REMOTE_HOST_ACP_CWD_PLACEHOLDER`); every run's registered workspace path
 * substitutes cleanly since every remote dispatch is workspace-bound
 * (phase 2 C9).
 *
 * Accepted risk (P2 discovery review, documented not fixed): this is a
 * blind substring replace over the outgoing byte stream, not a substitution
 * scoped to a specific JSON field. A registered workspace path containing a
 * character JSON must escape (`"`, `\`) would corrupt every ACP frame for
 * that workspace — the paths a user registers on their own paired machine
 * are operator-controlled, not attacker input, so this is judged low-risk
 * for now. If it is ever hit in practice, the fix is to serialize the
 * substituted value with `JSON.stringify` and splice it in as a JSON string
 * literal rather than a raw text swap.
 */
export const REMOTE_CWD_PLACEHOLDER = "agent-space:remote-workspace-cwd";

function substituteCwd(value: string, cwd: string): string {
  return value.split(REMOTE_CWD_PLACEHOLDER).join(cwd);
}

/**
 * ACP runtime replatform P3/P4: the bundled ACP adapter commands are not
 * binaries a trusted host has on PATH — they are pinned dependencies of THIS
 * package (an ACP adapter is our client, not the vendor runtime). The daemon
 * resolves its own installed copy and spawns it through `node` rather than
 * relying on PATH lookup.
 */
const ACP_ADAPTER_ENTRYPOINTS: Readonly<Record<string, string>> = {
  // Resolve the published bin entrypoints explicitly. Claude ACP's package
  // intentionally has no default export, so resolving its package root is
  // not equivalent to resolving the executable that its `bin` field names.
  "claude-agent-acp": "@agentclientprotocol/claude-agent-acp/dist/index.js",
  "codex-acp": "@agentclientprotocol/codex-acp/dist/index.js",
};

const acpEntrypoints = new Map<string, string | null>();

/** Exported for direct testing; not part of this package's public API surface. */
export function resolveAcpEntrypoint(command: string): string | null {
  if (!Object.hasOwn(ACP_ADAPTER_ENTRYPOINTS, command)) return null;
  if (acpEntrypoints.has(command)) return acpEntrypoints.get(command)!;
  try {
    const entrypoint = createRequire(import.meta.url).resolve(ACP_ADAPTER_ENTRYPOINTS[command]!);
    acpEntrypoints.set(command, entrypoint);
    return entrypoint;
  } catch {
    acpEntrypoints.set(command, null);
    return null;
  }
}

/** Backward-compatible test helper for the original P3 adapter. */
export function resolveCodexAcpEntrypoint(): string | null {
  return resolveAcpEntrypoint("codex-acp");
}

/**
 * Keyed by run_id, not by connection: a run outlives a WebSocket reconnect
 * (control-center-plan.md §5 — "an interrupted connection while a run is
 * active keeps the process alive"). Same reasoning as
 * `sharedHostConnectionRegistry` on the server side — one instance for the
 * daemon process's lifetime.
 */
const activeRuns = new Map<string, ActiveRun>();
/** Runs whose launch frame has arrived but whose child is not registered yet. */
const launchingRuns = new Set<string>();

/**
 * Removes run profiles left behind by a daemon that was killed mid-run. Each
 * holds a live lease token, and nothing else would ever remove it — the same
 * run id never comes back.
 */
export async function sweepStaleRunProfiles(): Promise<number> {
  // `launchingRuns` as well as `activeRuns`: a reconnect can land between a
  // launch frame arriving and its child being registered, and deleting that
  // run's profile mid-launch is the exact silent-unbinding this phase exists
  // to prevent.
  return sweepOrphanedProfiles(
    join(configDir(), "runs"),
    new Set([...activeRuns.keys(), ...launchingRuns]),
  );
}

function runOutputsDir(runId: string): string {
  return join(configDir(), "runs", runId, "outputs");
}

/**
 * Where a bound run's runtime keeps its profile, including the conversation
 * state it will resume next turn. Shared by every run with the same adapter
 * and provider on this machine, which is why it is not under `runs/`.
 */
function providerProfileDir(profileKey: string): string {
  const segments = profileKey.split("/");
  if (segments.length !== 2 || segments.some((segment) => !/^[A-Za-z0-9._-]+$/.test(segment) || segment.startsWith("."))) {
    throw new Error(`provider binding carried an unusable profile key: ${profileKey}`);
  }
  return join(configDir(), "profiles", ...segments);
}

/**
 * Spawns the rendered command, streams stdout back as `output` frames, and
 * on exit uploads the workspace diff and output-directory contents before
 * sending `complete`. `send` is the frame sink for whichever connection is
 * live when a frame needs to go out — if the socket has since closed,
 * run.ts's wrapper drops the frame rather than throwing; the process is
 * still tracked and its artifacts still uploaded over plain HTTP.
 */
export async function handleLaunch(
  frame: LaunchFrame,
  send: (frame: Record<string, unknown>) => void,
  log: (line: string) => void,
): Promise<void> {
  launchingRuns.add(frame.run_id);
  try {
    await launchRun(frame, send, log);
  } finally {
    launchingRuns.delete(frame.run_id);
  }
}

async function launchRun(
  frame: LaunchFrame,
  send: (frame: Record<string, unknown>) => void,
  log: (line: string) => void,
): Promise<void> {
  const config = await requireConfig();
  const workspaceId = frame.workspace_location_id ?? frame.project_folder_id ?? "";
  const cwd = config.workspaces[workspaceId];
  if (!cwd) {
    send({
      type: "complete",
      run_id: frame.run_id,
      exit_code: 1,
      timed_out: false,
      error: "This daemon has no local path registered for that workspace.",
    });
    return;
  }
  const [rawCommand, ...args] = frame.argv.map((arg) => substituteCwd(arg, cwd));
  if (!rawCommand) {
    send({ type: "complete", run_id: frame.run_id, exit_code: 1, timed_out: false, error: "Empty command." });
    return;
  }

  let command = rawCommand;
  let spawnArgs = args;
  const acpAdapterEnv: Record<string, string> = {};
  if (ACP_ADAPTER_ENTRYPOINTS[rawCommand]) {
    const entrypoint = resolveAcpEntrypoint(rawCommand);
    if (!entrypoint) {
      send({
        type: "complete",
        run_id: frame.run_id,
        exit_code: 1,
        timed_out: false,
        error: `This daemon does not have the ${rawCommand} adapter installed.`,
      });
      return;
    }
    command = process.execPath;
    spawnArgs = [entrypoint, ...args];
    if (rawCommand === "codex-acp") {
      // NO_BROWSER: this daemon has no browser to open for ChatGPT login.
      // CODEX_PATH: drive the trusted host's own installed `codex` (found by
      // this same daemon's capability probe) rather than codex-acp's bundled
      // copy — hosts.md's rule is that a trusted host runs whatever it already
      // has, and running two divergent codex installs on one machine invites
      // confusing drift. A bare command name resolves via the child's own
      // inherited PATH below, same as the capability probe's own lookup.
      acpAdapterEnv.CODEX_PATH = "codex";
      acpAdapterEnv.NO_BROWSER = "1";
    }
  }

  const outputsDir = runOutputsDir(frame.run_id);
  await mkdir(outputsDir, { recursive: true });

  // B67: for a bound run the executing machine contributes nothing to which
  // backend, credential, or upstream the runtime reaches — so the ambient
  // environment is filtered rather than merged over, and the runtime is
  // pointed at a control-plane-provided profile instead of this machine's.
  // A run with no binding keeps the machine's own environment untouched.
  let baseEnv: Record<string, string> = { ...process.env } as Record<string, string>;
  let bindingEnv: Record<string, string> = {};
  if (frame.provider_binding) {
    try {
      bindingEnv = await materializeProviderBinding(
        frame.provider_binding,
        providerProfileDir(frame.provider_binding.profile_key),
      );
      baseEnv = filterAmbientEnv(process.env);
    } catch (error) {
      send({
        type: "complete",
        run_id: frame.run_id,
        exit_code: 1,
        timed_out: false,
        error: `Could not prepare the selected model backend: ${error instanceof Error ? error.message : String(error)}`,
      });
      return;
    }
  }

  const child: ChildProcess = spawn(command, spawnArgs, {
    cwd,
    env: { ...baseEnv, AGENT_SPACE_OUTPUT_DIR: outputsDir, ...acpAdapterEnv, ...bindingEnv },
    stdio: ["pipe", "pipe", "pipe"],
    detached: true,
  });
  const active: ActiveRun = { child, cwd, timedOut: false, timeoutTimer: null };
  activeRuns.set(frame.run_id, active);
  // ACP runtime replatform P2: the server must not write a `stdin` frame
  // (e.g. a controller's `initialize` request) until it knows this run is
  // actually registered here — `launch` and any immediately-following
  // `stdin` frame are two separate WS messages, and this handler reaches
  // this point only after two `await`s, so a same-tick follow-up `stdin`
  // frame's handler could otherwise run first and find no active run.
  send({ type: "launched", run_id: frame.run_id });

  if (frame.stdin) child.stdin?.write(substituteCwd(frame.stdin, cwd));
  if (!frame.keep_stdin_open) child.stdin?.end();

  child.stdout?.on("data", (chunk: Buffer) => {
    send({ type: "output", run_id: frame.run_id, chunk: chunk.toString("utf8") });
  });
  let stderrTail = "";
  child.stderr?.on("data", (chunk: Buffer) => {
    const text = chunk.toString("utf8");
    stderrTail = (stderrTail + text).slice(-4000);
    // control-center-phase2-plan.md P1 (C5): the full live stream, not just
    // the failure tail the `complete` frame still carries below — normalized
    // into diagnostic conversation events server-side.
    send({ type: "stderr", run_id: frame.run_id, chunk: text });
  });

  if (frame.timeout_seconds && frame.timeout_seconds > 0) {
    active.timeoutTimer = setTimeout(() => {
      active.timedOut = true;
      terminateWithEscalation(child, false, log);
    }, frame.timeout_seconds * 1000);
    active.timeoutTimer.unref?.();
  }

  child.on("close", (code) => {
    void (async () => {
      if (active.timeoutTimer) clearTimeout(active.timeoutTimer);
      activeRuns.delete(frame.run_id);

      try {
        const diff = await captureWorkspaceDiff(cwd);
        if (diff !== null) {
          await uploadRunDiff(config.server_url, config.token, frame.run_id, { diff, truncated: false });
        }
      } catch (error) {
        log(`run ${frame.run_id}: diff upload failed: ${error instanceof Error ? error.message : String(error)}`);
      }
      try {
        const files = await collectOutputFiles(outputsDir);
        await uploadRunOutputs(config.server_url, config.token, frame.run_id, files);
      } catch (error) {
        log(`run ${frame.run_id}: output upload failed: ${error instanceof Error ? error.message : String(error)}`);
      }
      await rm(outputsDir, { recursive: true, force: true });

      send({
        type: "complete",
        run_id: frame.run_id,
        exit_code: code ?? 1,
        timed_out: active.timedOut,
        error: code !== 0 && !active.timedOut ? (stderrTail || null) : null,
      });
    })();
  });
}

export function handleTerminate(frame: TerminateFrame, log: (line: string) => void = () => {}): void {
  const active = activeRuns.get(frame.run_id);
  if (!active) return;
  terminateWithEscalation(active.child, frame.force === true, log);
}

/** Writes a `stdin` frame's value to the run's child process, translating the cwd placeholder first. */
export function handleStdin(frame: StdinFrame): void {
  const active = activeRuns.get(frame.run_id);
  if (!active) return;
  active.child.stdin?.write(substituteCwd(frame.value, active.cwd));
}

/** Ends the run's child process stdin, mirroring the default (non-`keep_stdin_open`) behavior in `handleLaunch`. */
export function handleStdinClose(frame: StdinCloseFrame): void {
  const active = activeRuns.get(frame.run_id);
  active?.child.stdin?.end();
}

const KILL_ESCALATION_GRACE_MS = 5000;

/**
 * A CLI that ignores SIGTERM (or a process group SIGTERM that failed to
 * reach a wayward child) would otherwise run forever with nothing watching
 * it — this is the daemon's only backstop, since the server's own timeout
 * needs the WS connection up to deliver a forced-terminate frame at all.
 * Force-terminate skips straight to SIGKILL; a graceful one escalates only
 * if the process is still alive after the grace window.
 */
function terminateWithEscalation(child: ChildProcess, force: boolean, log: (line: string) => void): void {
  const sent = killProcessGroup(child, force ? "SIGKILL" : "SIGTERM");
  if (!sent) log(`could not signal process group for pid ${child.pid ?? "unknown"}`);
  if (force) return;
  const timer = setTimeout(() => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    log(`process for pid ${child.pid ?? "unknown"} ignored SIGTERM after ${KILL_ESCALATION_GRACE_MS}ms — escalating to SIGKILL`);
    if (!killProcessGroup(child, "SIGKILL")) log(`could not deliver escalated SIGKILL for pid ${child.pid ?? "unknown"}`);
  }, KILL_ESCALATION_GRACE_MS);
  timer.unref?.();
}

function killProcessGroup(child: ChildProcess, signal: NodeJS.Signals): boolean {
  if (typeof child.pid !== "number") return false;
  try {
    // Negative pid targets the whole process group `detached: true` created,
    // so a shell-spawned tool's children die too, not just the shell.
    process.kill(-child.pid, signal);
    return true;
  } catch {
    try {
      child.kill(signal);
      return true;
    } catch {
      return false;
    }
  }
}
