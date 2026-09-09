import { spawn } from "node:child_process";
import { mkdir, readdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { HostLaunchIsolation } from "@rainver/protocol";
import { configDir, requireConfig, workspacesRoot } from "./config.js";
import { buildStrictNamespaceCommand } from "./strictNamespace.js";
import { adapterIsBeingReplaced, daemonRuntimeRoot, holdingAdapter, resolveAcpLaunch, resolveLocationCwd, strictBindsForRun } from "./execution.js";
import { OWN_INSTALLATION, readToolManifestSync } from "./tools.js";
import { ensureManagedWorkspace, type ManagedWorkspaceContainer } from "./managedWorkspaces.js";

/**
 * A fixed command the control plane runs in a workspace on this host.
 *
 * The Verification Engine needs to ask a question about a workspace — did the
 * tests pass — and used to reach a Runner that only ever existed beside the
 * server. Answering it here is what makes verification available on a paired
 * host at all.
 *
 * It is not a `launch`: no runtime, no session, no provider binding, no work
 * surface, and one answer instead of a stream. A strict host still wraps it in
 * the same namespace a Run gets — a question about a Run's workspace has no
 * more right to the machine than the Run did — while a trusted host runs it
 * natively, exactly as it runs that owner's Runs.
 */
export interface CommandRunRequest {
  request_id: string;
  workspace?: { kind: "location"; workspace_location_id?: string; workspace_relative_path?: string } | { kind: "managed"; agent_id?: string; container?: ManagedWorkspaceContainer };
  workspace_location_id?: string;
  run_id?: string;
  scratch_workspace?: boolean;
  adapter_type?: string;
  installation?: string;
  command: string[];
  stdin?: string | null;
  report_entries?: boolean;
  timeout_seconds: number;
  isolation?: HostLaunchIsolation;
}

export interface CommandRunResult {
  exit_code: number;
  stdout: string;
  stderr: string;
  timed_out: boolean;
  error: string | null;
  entries?: string[];
}

/**
 * Output is bounded because nothing downstream streams it: a recipe that
 * prints a gigabyte would otherwise be held whole in memory here and then
 * again in the frame. The tail is what a failing command explains itself with.
 */
const MAX_OUTPUT_BYTES = 256 * 1024;

function boundedTail(value: string): string {
  return value.length > MAX_OUTPUT_BYTES ? value.slice(-MAX_OUTPUT_BYTES) : value;
}

/**
 * Where this command runs. The control plane names a Location or a managed
 * container and never a path (B64), the same as a launch.
 */
async function resolveCwd(request: CommandRunRequest, scratch: string): Promise<string> {
  // A question about an installed copy rather than about anyone's work gets a
  // directory of its own, removed with the request.
  if (request.scratch_workspace) {
    await mkdir(scratch, { recursive: true, mode: 0o700 });
    return scratch;
  }
  if (request.workspace?.kind === "managed") {
    if (!request.workspace.agent_id || !request.workspace.container) {
      throw new Error("managed command workspace is incomplete");
    }
    return ensureManagedWorkspace(request.workspace.agent_id, request.workspace.container);
  }
  const locationId = request.workspace?.kind === "location"
    ? request.workspace.workspace_location_id
    : request.workspace_location_id;
  if (!locationId) throw new Error("command_run names no workspace");
  const config = await requireConfig();
  const cwd = resolveLocationCwd(
    config.workspaces,
    locationId,
    request.workspace?.kind === "location" ? request.workspace.workspace_relative_path : undefined,
    workspacesRoot(),
  );
  if (!cwd) throw new Error(`This daemon has no local path registered for workspace ${locationId}.`);
  return cwd;
}

/** One path segment, the same shape a run id is held to and for the same reason. */
const REQUEST_ID_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$/;

export async function runHostCommand(
  request: CommandRunRequest,
  log: (line: string) => void = () => {},
): Promise<CommandRunResult> {
  // Held for the whole command, not merely checked at the door: a verification
  // recipe runs for minutes and is in neither run registry, so without this a
  // drain reports quiet and the replacement deletes the tree it is executing
  // from.
  return holdingAdapter(request.adapter_type, () => runHostCommandInner(request, log));
}

async function runHostCommandInner(
  request: CommandRunRequest,
  log: (line: string) => void,
): Promise<CommandRunResult> {
  const config = await requireConfig();
  if (!REQUEST_ID_SEGMENT.test(request.request_id)) {
    // `join` would turn `../..` into a real parent directory that `resolve()`
    // then considers perfectly normal — and in strict mode that directory
    // becomes a read-write bind. The same guard the run directory already has.
    return { exit_code: 1, stdout: "", stderr: "", timed_out: false, error: `command request id is not a usable directory name: ${request.request_id}` };
  }
  // A verification recipe or C3 probe launches the same copy a Run does, and
  // it is in neither run registry — so the drain cannot see it and the closed
  // door has to. Refused, not queued: the caller is waiting on an HTTP request.
  if (adapterIsBeingReplaced(request.adapter_type)) {
    return {
      exit_code: 1, stdout: "", stderr: "", timed_out: false,
      error: `${request.adapter_type} is being upgraded on this host; retry in a moment.`,
    };
  }
  const scratch = join(configDir(), "commands", request.request_id);
  let cwd: string;
  try {
    cwd = await resolveCwd(request, scratch);
  } catch (error) {
    return { exit_code: 1, stdout: "", stderr: "", timed_out: false, error: error instanceof Error ? error.message : String(error) };
  }

  // Either a command on PATH, or the installed copy of an adapter with these
  // as its arguments — the executable then comes from the manifest the daemon
  // itself wrote, never from the frame.
  let resolved: { command: string; args: string[]; env: Record<string, string> };
  let tool: ReturnType<typeof readToolManifestSync> = null;
  try {
    const [first, ...rest] = request.command;
    if (request.adapter_type) {
      const installation = request.installation ?? OWN_INSTALLATION;
      // The manifest's own `env` is not optional decoration: for a managed copy
      // it carries `HOME`, which is that copy's login home. Dropping it ran the
      // copy as though it had never been logged in.
      resolved = resolveAcpLaunch(request.adapter_type, request.command, installation, request.adapter_type);
      tool = installation === OWN_INSTALLATION ? null : readToolManifestSync(request.adapter_type, installation);
    } else {
      resolved = { command: first!, args: rest, env: {} };
    }
  } catch (error) {
    return { exit_code: 1, stdout: "", stderr: "", timed_out: false, error: error instanceof Error ? error.message : String(error) };
  }
  let spawnCommand = resolved.command;
  let spawnArgs = resolved.args;
  // A fixed, minimal environment either way. A verification recipe is not an
  // Agent run: it carries no credential, no provider and no tool token, so
  // there is nothing for the machine's environment to contribute and every
  // reason for it not to.
  // HOME is the request's own scratch directory, never the workspace: a probe
  // or a recipe that writes caches belongs in a directory that is removed with
  // it, not in someone's checkout. A managed copy's manifest `HOME` overrides
  // it, because that copy's login lives there and is the whole point of naming
  // an installation.
  let spawnEnv: Record<string, string> = {
    PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
    HOME: scratch,
    LANG: "C.UTF-8",
    ...resolved.env,
  };
  const strict = config.trust === "strict";
  try {
    await mkdir(scratch, { recursive: true, mode: 0o700 });
    if (strict) {
      const namespace = buildStrictNamespaceCommand({
        command: resolved.command,
        args: resolved.args,
        cwd,
        home: scratch,
        binds: strictBindsForRun({
          runDir: scratch,
          profileDir: null,
          // A managed copy lives under the daemon's own config directory, not
          // under its install root, so the namespace has neither the
          // executable nor its login home unless the tree is bound in.
          loginHome: tool?.home ?? null,
          toolTree: tool ? dirname(tool.home) : null,
          runtimeRoot: daemonRuntimeRoot(),
        }),
        // Read-write because a verification recipe builds and tests; no
        // network because it has no upstream to reach — the recipe's inputs
        // are the workspace, and a build that wants the Internet is a
        // dependency problem, not something to open a hole for.
        isolation: request.isolation ?? { sandbox_mode: "read_write", egress_profile: "none" },
        env: spawnEnv,
      });
      spawnCommand = namespace.command;
      spawnArgs = namespace.args;
      spawnEnv = { PATH: "/usr/local/bin:/usr/bin:/bin" };
    }
    return await new Promise<CommandRunResult>((resolve) => {
      // Four streams in strict mode: the namespace reports readiness on fd 3
      // before `exec`, and without a descriptor there the redirection fails and
      // its error lands in the command's own stderr — which a verifier records
      // as evidence and the credential-leakage probe scans.
      const child = spawn(spawnCommand, spawnArgs, {
        cwd,
        env: spawnEnv,
        stdio: strict ? ["pipe", "pipe", "pipe", "pipe"] : ["pipe", "pipe", "pipe"],
        detached: true,
      });
      if (request.stdin) child.stdin?.write(request.stdin);
      child.stdin?.end();
      let stdout = "";
      let stderr = "";
      let timedOut = false;
      let outputOverflow = false;
      let outputBytes = 0;
      const timer = setTimeout(() => {
        timedOut = true;
        try {
          process.kill(-(child.pid ?? 0), "SIGKILL");
        } catch {
          child.kill("SIGKILL");
        }
      }, request.timeout_seconds * 1000);
      timer.unref?.();
      const capture = (chunk: Buffer, errorStream: boolean) => {
        outputBytes += chunk.length;
        if (outputBytes > MAX_OUTPUT_BYTES) {
          if (!outputOverflow) {
            outputOverflow = true;
            if (child.pid) {
              try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); }
            }
          }
          return;
        }
        if (errorStream) stderr = boundedTail(stderr + chunk.toString("utf8"));
        else stdout = boundedTail(stdout + chunk.toString("utf8"));
      };
      child.stdout?.on("data", (chunk: Buffer) => capture(chunk, false));
      child.stderr?.on("data", (chunk: Buffer) => capture(chunk, true));
      child.on("error", (error) => {
        clearTimeout(timer);
        resolve({ exit_code: 1, stdout, stderr, timed_out: false, error: error.message });
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        void (async () => {
          const entries = request.report_entries
            ? await readdir(cwd).catch(() => [] as string[])
            : undefined;
          resolve({ exit_code: outputOverflow ? 1 : code ?? 1, stdout, stderr, timed_out: timedOut, error: outputOverflow ? "command_output_limit_exceeded" : null, ...(entries ? { entries } : {}) });
        })();
      });
    });
  } catch (error) {
    return {
      exit_code: 1,
      stdout: "",
      stderr: "",
      timed_out: false,
      error: `Could not run this command in an isolated namespace: ${error instanceof Error ? error.message : String(error)}`,
    };
  } finally {
    {
      await rm(scratch, { recursive: true, force: true }).catch((error: unknown) => {
        log(`command ${request.request_id}: scratch cleanup failed: ${error instanceof Error ? error.message : String(error)}`);
      });
    }
  }
}
