import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { createRequire } from "node:module";
import { configDir, requireConfig } from "./config.js";
import { uploadRunDiff, uploadRunOutputs } from "./api.js";
import { captureWorkspaceDiff } from "./gitDiff.js";
import { collectOutputFiles } from "./outputFiles.js";
import { filterAmbientEnv, materializeProviderBinding, sweepOrphanedRunDirectories } from "./providerBinding.js";
import { OWN_INSTALLATION, readToolManifestSync } from "./tools.js";

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
  /** Which copy of the runtime: `own` (PATH / bundled adapter) or `managed:<version>`. */
  installation?: string;
  /** The adapter the copy belongs to; a managed copy is keyed by it, not by the command. */
  adapter_type?: string;
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
  /**
   * How this run calls back into Rainver: its identity, the control-plane
   * address to use it at, and the Skill that says how. Materialized under
   * this run's own directory and removed with it.
   *
   * Runtime-agnostic on purpose — environment and one file, with no branch on
   * which agent is running. It is what replaced per-vendor tool configuration,
   * so a newly registered ACP agent needs nothing added here.
   */
  work_surface?: WorkSurfaceFrame;
}

export interface WorkSurfaceFrame {
  /** Literal values: the API base URL, the run id, and the run's tool token. */
  env: Record<string, string>;
  files: Array<{ relative_path: string; contents: string }>;
  /**
   * Variables whose value is a path inside this run's directory. The control
   * plane names the relative path; only this machine knows the absolute one.
   */
  dir_env: Record<string, string>;
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
export const REMOTE_CWD_PLACEHOLDER = "rainver:remote-workspace-cwd";

export function substituteCwd(value: string, cwd: string): string {
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

/** What actually gets spawned for an ACP argv: the vendor CLI as-is, or a bundled adapter through `node`. */
export interface AcpLaunch {
  command: string;
  args: string[];
  env: Record<string, string>;
}

/**
 * One place for the bundled-vs-vendor distinction, used both to run a job and
 * to ask a runtime for its options. Throws when the argv names a bundled
 * adapter this daemon does not have; a vendor CLI is spawned as named and
 * resolves via the child's own PATH, same as the capability probe's lookup.
 */
export function resolveAcpLaunch(
  rawCommand: string,
  args: string[],
  installation: string = OWN_INSTALLATION,
  /** Required for a managed copy: the tools directory is keyed by adapter, and the command name (`claude-agent-acp`) is not it. */
  adapterType: string = rawCommand,
): AcpLaunch {
  if (installation !== OWN_INSTALLATION) {
    // A managed copy: launched from its manifest with its own HOME, never
    // looked up on PATH (`tools.ts`).
    const tool = readToolManifestSync(adapterType, installation);
    if (!tool) throw new Error(`This daemon does not have ${adapterType} ${installation} installed.`);
    return { command: tool.command, args: [...tool.args, ...args], env: { ...tool.env, HOME: tool.home } };
  }
  if (!ACP_ADAPTER_ENTRYPOINTS[rawCommand]) return { command: rawCommand, args, env: {} };
  const entrypoint = resolveAcpEntrypoint(rawCommand);
  if (!entrypoint) throw new Error(`This daemon does not have the ${rawCommand} adapter installed.`);
  const env: Record<string, string> = {};
  if (rawCommand === "codex-acp") {
    // NO_BROWSER: this daemon has no browser to open for ChatGPT login.
    // CODEX_PATH: drive the trusted host's own installed `codex` (found by
    // this same daemon's capability probe) rather than codex-acp's bundled
    // copy — hosts.md's rule is that a trusted host runs whatever it already
    // has, and running two divergent codex installs on one machine invites
    // confusing drift.
    env.CODEX_PATH = "codex";
    env.NO_BROWSER = "1";
  }
  return { command: process.execPath, args: [entrypoint, ...args], env };
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
 * Runs whose child has exited but whose directory is still being read.
 *
 * The diff and output uploads happen after the child is gone and take as long
 * as the network does. A reconnect in that window would otherwise let
 * `sweepStaleRunProfiles` — which now removes the whole run directory — delete
 * the outputs out from under `collectOutputFiles`, losing the deliverables
 * silently and turning every `artifact.submit` declaration into "declared but
 * not delivered".
 */
const finishingRuns = new Set<string>();

/**
 * Removes run directories left behind by a daemon that was killed mid-run.
 * Each holds that run's outputs and work surface, and an older layout also put
 * a live lease token there; nothing else would ever remove one, because the
 * same run id never comes back.
 */
export async function sweepStaleRunProfiles(): Promise<number> {
  // `launchingRuns` as well as `activeRuns`: a reconnect can land between a
  // launch frame arriving and its child being registered, and deleting that
  // run's profile mid-launch is the exact silent-unbinding this phase exists
  // to prevent.
  return sweepOrphanedRunDirectories(
    join(configDir(), "runs"),
    new Set([...activeRuns.keys(), ...launchingRuns, ...finishingRuns]),
  );
}

function runOutputsDir(runId: string): string {
  return join(runDir(runId), "outputs");
}

/**
 * This run's own directory. Already swept for orphans by
 * `sweepOrphanedRunDirectories`, so anything materialized here is removed with
 * the run — including a work surface carrying its tool token.
 */
function runDir(runId: string): string {
  return join(configDir(), "runs", runId);
}

/**
 * Writes the run's work surface and returns the environment it contributes.
 *
 * `RAINVER_CLI` is resolved here, not sent by the control plane: it is a path
 * on this machine, and the command ships with this daemon so the two versions
 * cannot disagree. It is passed by absolute path rather than installed onto
 * `PATH` — the daemon puts nothing into the machine's global tool space
 * (ADR 0016 §6).
 */
async function materializeWorkSurface(
  surface: WorkSurfaceFrame,
  runId: string,
): Promise<Record<string, string>> {
  const root = runDir(runId);
  for (const file of surface.files) {
    const target = resolveInsideDir(root, file.relative_path);
    await mkdir(dirname(target), { recursive: true, mode: 0o700 });
    await writeFile(target, file.contents, { encoding: "utf8", mode: 0o600 });
  }
  const env: Record<string, string> = { ...surface.env };
  for (const [key, relativePath] of Object.entries(surface.dir_env)) {
    env[key] = relativePath === "." ? root : resolveInsideDir(root, relativePath);
  }
  env.RAINVER_CLI = await writeCliLauncher(root);
  return env;
}

/**
 * A launcher for the `rainver` command, written into this run's directory.
 *
 * The command itself is a `.js` file inside this package, and `tsc` emits it
 * without an executable bit — so pointing `RAINVER_CLI` straight at it makes
 * `$RAINVER_CLI list` fail with `EACCES` on any host running the daemon from a
 * checkout, and fail on Windows regardless. A generated launcher settles both:
 * it runs under the same Node that runs this daemon, needs nothing on `PATH`
 * (ADR 0016 §6), and is removed with the run.
 */
async function writeCliLauncher(root: string): Promise<string> {
  const cli = rainverCliPath();
  const windows = process.platform === "win32";
  // Inside `rainver/`, beside the Skill: the run directory also holds
  // `outputs/`, and a launcher named for the directory it sits next to would
  // collide with it.
  const target = join(root, "rainver", windows ? "rainver.cmd" : "rainver");
  const contents = windows
    ? `@echo off\r\n"${process.execPath}" "${cli}" %*\r\n`
    : `#!/bin/sh\nexec ${shellQuote(process.execPath)} ${shellQuote(cli)} "$@"\n`;
  await mkdir(dirname(target), { recursive: true, mode: 0o700 });
  await writeFile(target, contents, { encoding: "utf8", mode: 0o700 });
  return target;
}

/** Single-quoted for `sh`, so a path containing spaces survives. */
function shellQuote(value: string): string {
  return `'${value.split("'").join(`'\\''`)}'`;
}

/** Refuses a control-plane path that would write outside the run directory. */
function resolveInsideDir(root: string, relativePath: string): string {
  const target = resolve(root, relativePath);
  const prefix = resolve(root) + sep;
  if (target !== resolve(root) && !target.startsWith(prefix)) {
    throw new Error(`work surface path escapes the run directory: ${relativePath}`);
  }
  return target;
}

/**
 * The `rainver` command, from the package that owns it.
 *
 * `@rainver/agent-cli` is a workspace package with no runtime dependencies,
 * consumed by whoever has to put the command in front of a runtime — this
 * daemon for a paired machine, the server for a sandboxed run. One copy, so
 * the two paths cannot hand an agent different commands.
 *
 * The built entry is preferred; the source is the fallback for running this
 * daemon from a checkout under a TypeScript loader, where nothing is built.
 */
function rainverCliPath(): string {
  // `createRequire`, not `import.meta.resolve`: the ESM resolver maps the
  // export without checking the file is there, so a checkout with nothing
  // built would get a `dist/` path that does not exist — and Vitest's module
  // runner does not implement it at all. `require.resolve` honours the same
  // `exports` map and fails when the target is missing, which is what makes
  // the fallback correct. Same choice, same reason, as the ACP entrypoint
  // resolution above.
  const require = createRequire(import.meta.url);
  try {
    return require.resolve("@rainver/agent-cli");
  } catch {
    return require.resolve("@rainver/agent-cli/source");
  }
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

  let launch: AcpLaunch;
  try {
    launch = resolveAcpLaunch(rawCommand, args, frame.installation ?? OWN_INSTALLATION, frame.adapter_type ?? rawCommand);
  } catch (error) {
    send({
      type: "complete",
      run_id: frame.run_id,
      exit_code: 1,
      timed_out: false,
      error: error instanceof Error ? error.message : String(error),
    });
    return;
  }
  const { command, args: spawnArgs, env: acpAdapterEnv } = launch;

  const outputsDir = runOutputsDir(frame.run_id);
  await mkdir(outputsDir, { recursive: true });

  // B67: for a bound run the executing machine contributes nothing to which
  // backend, credential, or upstream the runtime reaches — so the ambient
  // environment is filtered rather than merged over, and the runtime is
  // pointed at a control-plane-provided profile instead of this machine's.
  // A run with no binding keeps the machine's own environment untouched.
  let baseEnv: Record<string, string> = { ...process.env } as Record<string, string>;
  let bindingEnv: Record<string, string> = {};
  let workSurfaceEnv: Record<string, string> = {};
  if (frame.work_surface) {
    try {
      workSurfaceEnv = await materializeWorkSurface(frame.work_surface, frame.run_id);
    } catch (error) {
      // Without its work surface the agent cannot report anything back, and a
      // run whose result never reaches Rainver is worse than one that did not
      // start: it looks finished and advanced nothing.
      send({
        type: "complete",
        run_id: frame.run_id,
        exit_code: 1,
        timed_out: false,
        error: `Could not prepare this run's Rainver work surface: ${error instanceof Error ? error.message : String(error)}`,
      });
      return;
    }
  }
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
    // The work surface is applied after the binding for the same reason the
    // binding is applied after the ambient environment: it is control-plane
    // authority, and this machine does not get to override which Rainver a run
    // reports to.
    env: { ...baseEnv, RAINVER_OUTPUT_DIR: outputsDir, ...acpAdapterEnv, ...bindingEnv, ...workSurfaceEnv },
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
      // Held until the directory is gone, so a reconnect mid-upload cannot
      // sweep the outputs this block is still reading.
      finishingRuns.add(frame.run_id);

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
      // The whole directory: its work surface carried this run's Skill, and
      // the run id never comes back to reclaim it. A failure here must not
      // swallow the `complete` frame or pin the run id in `finishingRuns` for
      // this daemon's lifetime — a directory the sweep may never touch again
      // is worse than one removed a reconnect later.
      await rm(runDir(frame.run_id), { recursive: true, force: true }).catch((error: unknown) => {
        log(`run ${frame.run_id}: run directory cleanup failed: ${error instanceof Error ? error.message : String(error)}`);
      });
      finishingRuns.delete(frame.run_id);

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
