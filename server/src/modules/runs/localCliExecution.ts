import { spawn, type ChildProcess } from "node:child_process";
import { lstat, readdir, readlink, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import { resolveHostPath } from "../providers/cli/hostPath";
import type { CanonicalUsage } from "@agent-space/protocol" with { "resolution-mode": "import" };

const CONTAINER_HOME = "/home/sandbox";
const READ_ONLY_SYSTEM_ETC_PATHS = [
  "/etc/alternatives",
  "/etc/ca-certificates.conf",
  "/etc/gai.conf",
  "/etc/gitconfig",
  "/etc/group",
  "/etc/host.conf",
  "/etc/hostname",
  "/etc/hosts",
  "/etc/ld.so.cache",
  "/etc/ld.so.conf",
  "/etc/ld.so.conf.d",
  "/etc/localtime",
  "/etc/nsswitch.conf",
  "/etc/passwd",
  "/etc/resolv.conf",
  "/etc/ssl/certs",
  "/etc/ssl/openssl.cnf",
  "/etc/timezone",
] as const;

export interface CliExecutionResult {
  returncode: number;
  stdout: string;
  stderr: string;
  timed_out: boolean;
  failure_code?:
    | "timeout"
    | "stall_timeout"
    | "docker_sandbox_unavailable"
    | "read_only_sandbox_unavailable";
}

export interface DockerCliExecutionOptions {
  image: string;
  sandbox_cwd: string;
  sandbox_root: string;
  cli_tools_root: string;
  credential_root: string;
  credential_source_path: string | null;
  credential_target_path: string | null;
  exchange_input_cwd?: string | null;
  exchange_output_cwd?: string | null;
}

export interface ReadOnlyCliExecutionOptions {
  workspace_cwd: string;
  context_cwd: string;
  sandbox_root: string;
  agent_space_home: string;
  cli_tools_root: string;
  readable_paths: string[];
  writable_paths: string[];
}

export interface CliProcessRegistry {
  register(runId: string, pid: number): void;
  deregister(runId: string): void;
  terminate(runId: string): boolean;
  forceTerminate?(runId: string): boolean;
  waitForExit?(runId: string, timeoutMs: number): Promise<boolean>;
  touchActivity?(runId: string): void;
}

export interface CliCommandExecutor {
  runCommand(input: {
    command: string[];
    cwd: string | null;
    timeout_seconds: number;
    env: Record<string, string>;
    run_id: string;
    stdin: string | null;
    process_registry?: CliProcessRegistry;
    stall_timeout_seconds?: number;
    on_stdout_chunk?: (chunk: string) => void;
    stdio_controller?: CliStdioController;
    docker?: DockerCliExecutionOptions;
    read_only?: ReadOnlyCliExecutionOptions;
  }): Promise<CliExecutionResult>;
}

export interface CliStdioController {
  start(send: (message: Record<string, unknown>) => void): void;
  receive(
    message: Record<string, unknown>,
    send: (message: Record<string, unknown>) => void,
    closeStdin: () => void,
  ): void;
  reject(message: string): void;
  result(): {
    completed: boolean;
    error: string | null;
    text: string;
    external_session_id?: string | null;
    usage?: CanonicalUsage | null;
  };
}

export class LocalCliProcessRegistry implements CliProcessRegistry {
  private readonly processes = new Map<string, { pid: number; lastActivityAt: number }>();
  private readonly exitWaiters = new Map<string, Set<(exited: boolean) => void>>();

  register(runId: string, pid: number): void {
    this.processes.set(runId, { pid, lastActivityAt: Date.now() });
  }

  deregister(runId: string): void {
    this.processes.delete(runId);
    const waiters = this.exitWaiters.get(runId);
    if (!waiters) return;
    this.exitWaiters.delete(runId);
    for (const resolve of waiters) resolve(true);
  }

  terminate(runId: string): boolean {
    return this.signal(runId, "SIGTERM");
  }

  forceTerminate(runId: string): boolean {
    return this.signal(runId, "SIGKILL");
  }

  waitForExit(runId: string, timeoutMs: number): Promise<boolean> {
    if (!this.processes.has(runId)) return Promise.resolve(true);
    return new Promise((resolve) => {
      const waiters = this.exitWaiters.get(runId) ?? new Set<(exited: boolean) => void>();
      const resolveWithTimer = (exited: boolean) => {
        clearTimeout(timer);
        resolve(exited);
      };
      const timer = setTimeout(() => {
        waiters.delete(resolveWithTimer);
        if (waiters.size === 0) this.exitWaiters.delete(runId);
        resolve(false);
      }, Math.max(0, timeoutMs));
      timer.unref?.();
      waiters.add(resolveWithTimer);
      this.exitWaiters.set(runId, waiters);
    });
  }

  touchActivity(runId: string): void {
    const processInfo = this.processes.get(runId);
    if (processInfo) processInfo.lastActivityAt = Date.now();
  }

  private signal(runId: string, signal: NodeJS.Signals): boolean {
    const processInfo = this.processes.get(runId);
    if (!processInfo) return false;
    try {
      process.kill(-processInfo.pid, signal);
    } catch {
      try {
        process.kill(processInfo.pid, signal);
      } catch {
        return false;
      }
    }
    return true;
  }
}

export class LocalCliCommandExecutor implements CliCommandExecutor {
  async runCommand(input: {
    command: string[];
    cwd: string | null;
    timeout_seconds: number;
    env: Record<string, string>;
    run_id: string;
    stdin: string | null;
    process_registry?: CliProcessRegistry;
    stall_timeout_seconds?: number;
    on_stdout_chunk?: (chunk: string) => void;
    stdio_controller?: CliStdioController;
    docker?: DockerCliExecutionOptions;
  }): Promise<CliExecutionResult> {
    return new Promise((resolveResult) => {
      let settled = false;
      let stdout = "";
      let stderr = "";
      let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
      let stallTimer: ReturnType<typeof setTimeout> | undefined;
      let stallEscalationTimer: ReturnType<typeof setTimeout> | undefined;
      let terminationReason: CliExecutionResult["failure_code"];
      const stdin = input.stdin;
      const hasStdin = stdin !== null || Boolean(input.stdio_controller);
      let protocolBuffer = "";
      let proc: ChildProcess;

      const finish = (result: CliExecutionResult) => {
        if (settled) return;
        settled = true;
        if (timeoutTimer) clearTimeout(timeoutTimer);
        if (stallTimer) clearTimeout(stallTimer);
        if (stallEscalationTimer) clearTimeout(stallEscalationTimer);
        input.process_registry?.deregister(input.run_id);
        resolveResult(result);
      };

      const resetStallTimer = () => {
        if (!input.stall_timeout_seconds || input.stall_timeout_seconds <= 0) return;
        if (stallTimer) clearTimeout(stallTimer);
        stallTimer = setTimeout(() => {
          if (settled) return;
          terminationReason = "stall_timeout";
          const terminated = input.process_registry?.terminate(input.run_id) ?? false;
          if (!terminated) {
            try {
              if (proc?.pid) process.kill(-proc.pid, "SIGTERM");
            } catch {
              proc?.kill("SIGTERM");
            }
          }
          stallEscalationTimer = setTimeout(() => {
            if (settled) return;
            const forceKilled = input.process_registry?.forceTerminate?.(input.run_id) ?? false;
            if (!forceKilled) {
              try {
                if (proc?.pid) process.kill(-proc.pid, "SIGKILL");
              } catch {
                proc?.kill("SIGKILL");
              }
            }
          }, 2_000);
          stallEscalationTimer.unref?.();
        }, input.stall_timeout_seconds * 1000);
        stallTimer.unref?.();
      };

      try {
        proc = spawn(input.command[0], input.command.slice(1), {
          cwd: input.cwd ?? undefined,
          env: input.env,
          detached: true,
          shell: false,
          stdio: [hasStdin ? "pipe" : "ignore", "pipe", "pipe"],
        });
      } catch (error) {
        resolveResult({
          returncode: -1,
          stdout: "",
          stderr: error instanceof Error ? error.message : "CLI spawn failed.",
          timed_out: false,
        });
        return;
      }

      input.process_registry?.register(input.run_id, proc.pid ?? -1);
      resetStallTimer();
      proc.stdout?.on("data", (chunk: Buffer) => {
        const text = chunk.toString("utf8");
        stdout += text;
        input.on_stdout_chunk?.(text);
        if (input.stdio_controller) {
          protocolBuffer += text;
          const lines = protocolBuffer.split(/\r?\n/);
          protocolBuffer = lines.pop() ?? "";
          for (const line of lines) {
            const message = jsonRecord(line);
            if (message) {
              input.stdio_controller.receive(
                message,
                (value) => proc.stdin?.write(`${JSON.stringify(value)}\n`),
                () => proc.stdin?.end(),
              );
            } else if (line.trim()) {
              input.stdio_controller.reject("CLI protocol emitted invalid JSON");
              proc.stdin?.end();
            }
          }
        }
        input.process_registry?.touchActivity?.(input.run_id);
        resetStallTimer();
      });
      proc.stderr?.on("data", (chunk: Buffer) => {
        stderr += chunk.toString("utf8");
        input.process_registry?.touchActivity?.(input.run_id);
        resetStallTimer();
      });
      proc.stdin?.on("error", (error: Error) => {
        stderr = stderr || error.message;
      });
      proc.on("error", (error: Error) => {
        finish({
          returncode: -1,
          stdout,
          stderr: error.message,
          timed_out: Boolean(terminationReason),
          failure_code: terminationReason,
        });
      });
      proc.on("close", (code: number | null) => {
        if (input.stdio_controller && protocolBuffer.trim()) {
          const message = jsonRecord(protocolBuffer);
          protocolBuffer = "";
          if (message) {
            input.stdio_controller.receive(message, () => {}, () => {});
          } else {
            input.stdio_controller.reject("CLI protocol emitted invalid JSON");
          }
        }
        const protocol = input.stdio_controller?.result();
        finish({
          returncode:
            protocol && (!protocol.completed || protocol.error)
              ? -1
              : code ?? -1,
          stdout,
          stderr: protocol?.error
            ? protocol.error
            : terminationReason === "stall_timeout"
            ? stderr || "Command produced no output or activity before the stall timeout."
            : stderr,
          timed_out: Boolean(terminationReason),
          failure_code: terminationReason,
        });
      });
      if (input.stdio_controller) {
        input.stdio_controller.start(
          (value) => proc.stdin?.write(`${JSON.stringify(value)}\n`),
        );
      } else if (hasStdin) {
        proc.stdin?.end(stdin);
      }

      timeoutTimer = setTimeout(() => {
        if (settled) return;
        terminationReason = "timeout";
        try {
          if (proc.pid) process.kill(-proc.pid, "SIGKILL");
        } catch {
          proc.kill("SIGKILL");
        }
        finish({
          returncode: -1,
          stdout,
          stderr: stderr || "Command timed out.",
          timed_out: true,
          failure_code: "timeout",
        });
      }, input.timeout_seconds * 1000);
      timeoutTimer.unref?.();
    });
  }
}

/**
 * Runs a local CLI in a disposable, rootless sandbox container. The Docker
 * daemon is an execution dependency, never an authority exposed to the CLI:
 * the container receives only the run directory, the selected runtime tool
 * tree, and (optionally) one read-only credential profile.
 */
export class DockerCliCommandExecutor implements CliCommandExecutor {
  constructor(private readonly launcher: CliCommandExecutor = new LocalCliCommandExecutor()) {}

  async runCommand(input: {
    command: string[];
    cwd: string | null;
    timeout_seconds: number;
    env: Record<string, string>;
    run_id: string;
    stdin: string | null;
    process_registry?: CliProcessRegistry;
    stall_timeout_seconds?: number;
    on_stdout_chunk?: (chunk: string) => void;
    stdio_controller?: CliStdioController;
    docker?: DockerCliExecutionOptions;
  }): Promise<CliExecutionResult> {
    try {
      const docker = input.docker;
      if (!docker) return failedDockerResult("docker_execution_options_missing");
      const command = buildDockerCommand(input.command, docker, input.env);
      const env = dockerLauncherEnv(input.env);
      const result = await this.launcher.runCommand({
        command,
        cwd: null,
        timeout_seconds: input.timeout_seconds,
        stall_timeout_seconds: input.stall_timeout_seconds,
        env,
        run_id: input.run_id,
        stdin: input.stdin,
        process_registry: input.process_registry,
        on_stdout_chunk: input.on_stdout_chunk,
        stdio_controller: input.stdio_controller,
      });
      if (result.returncode === 125 || (result.returncode === -1 && !result.timed_out)) {
        return { ...result, failure_code: "docker_sandbox_unavailable" };
      }
      return result;
    } catch (error) {
      return failedDockerResult(error instanceof Error ? error.message : "Docker sandbox command construction failed.");
    }
  }
}

/**
 * Runs a network-capable local CLI inside a bubblewrap mount namespace. The
 * namespace starts empty and receives only system runtime files, the selected
 * Project Folder, generated context, and managed exchange/credential paths.
 * The real Project Folder is never chmodded, copied, or mounted writable.
 */
export class ReadOnlyCliCommandExecutor implements CliCommandExecutor {
  constructor(
    private readonly launcher: CliCommandExecutor = new LocalCliCommandExecutor(),
    private readonly executable = "/usr/bin/bwrap",
  ) {}

  async runCommand(
    input: Parameters<CliCommandExecutor["runCommand"]>[0],
  ): Promise<CliExecutionResult> {
    try {
      const options = input.read_only;
      if (!options) return failedReadOnlyResult("read_only_execution_options_missing");
      const preflight = await this.launcher.runCommand({
        command: [
          this.executable,
          "--die-with-parent",
          "--new-session",
          "--unshare-pid",
          "--ro-bind", "/", "/",
          "--proc", "/proc",
          "--dev", "/dev",
          "--", "/bin/true",
        ],
        cwd: null,
        timeout_seconds: 10,
        env: readOnlyLauncherEnv(input.env),
        run_id: `${input.run_id}:read-only-preflight`,
        stdin: null,
      });
      if (preflight.returncode !== 0) {
        return failedReadOnlyResult(
          preflight.stderr || "bubblewrap user namespace preflight failed",
        );
      }
      const command = await buildReadOnlyCommand(input.command, options, this.executable);
      const result = await this.launcher.runCommand({
        ...input,
        command,
        cwd: null,
        env: readOnlyLauncherEnv(input.env),
        read_only: undefined,
      });
      if (
        result.returncode !== 0
        && /(^|\n)bwrap:/i.test(result.stderr)
      ) {
        return { ...result, failure_code: "read_only_sandbox_unavailable" };
      }
      return result;
    } catch (error) {
      return failedReadOnlyResult(
        error instanceof Error ? error.message : "Read-only sandbox construction failed.",
      );
    }
  }
}

function jsonRecord(line: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(line);
    return value && typeof value === "object" && !Array.isArray(value)
      ? value as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function buildDockerCommand(
  command: string[],
  docker: DockerCliExecutionOptions,
  env: Record<string, string>,
): string[] {
  if (command.length === 0) throw new Error("CLI command is empty");
  const sandbox = hostPath(docker.sandbox_cwd, "sandbox_cwd");
  const sandboxRoot = hostPath(docker.sandbox_root, "sandbox_root");
  if (sandbox === sandboxRoot || !isInside(sandbox, sandboxRoot)) {
    throw new Error("sandbox_cwd must be inside the configured sandbox root");
  }
  const tools = hostPath(docker.cli_tools_root, "cli_tools_root");
  const executable = hostPath(command[0], "runtime executable");
  if (!isInside(executable, tools)) {
    throw new Error("runtime executable must be inside the configured runtime tools root");
  }
  const containerExecutable = `/runtime-tools/${relative(tools, executable)}`;
  const containerCommand = [containerExecutable, ...command.slice(1).map((arg) =>
    arg === docker.sandbox_cwd ? "/workspace" : arg,
  )];
  const args = [
    "docker", "run", "--rm", "--init", "--pull=never",
    "--network", "none",
    "--read-only",
    "--cap-drop", "ALL",
    "--security-opt", "no-new-privileges=true",
    "--pids-limit", "256",
    "--memory", "1g",
    "--cpus", "1",
    "--tmpfs", "/tmp:rw,noexec,nosuid,size=128m",
    "--tmpfs", "/run:rw,noexec,nosuid,size=16m",
    "--tmpfs", "/home/sandbox:rw,noexec,nosuid,size=64m",
    "--workdir", "/workspace",
    "--volume", `${sandbox}:/workspace:rw`,
    "--volume", `${tools}:/runtime-tools:ro`,
  ];
  if (docker.exchange_input_cwd || docker.exchange_output_cwd) {
    if (!docker.exchange_input_cwd || !docker.exchange_output_cwd) {
      throw new Error("both Run Exchange input and output paths are required");
    }
    const exchangeInput = hostPath(docker.exchange_input_cwd, "exchange_input_cwd");
    const exchangeOutput = hostPath(docker.exchange_output_cwd, "exchange_output_cwd");
    if (!isInside(exchangeInput, sandboxRoot) || !isInside(exchangeOutput, sandboxRoot)) {
      throw new Error("Run Exchange paths must be inside the configured sandbox root");
    }
    args.push("--volume", `${exchangeInput}:/run-exchange/input:ro`);
    args.push("--volume", `${exchangeOutput}:/run-exchange/output:rw`);
  }
  if (docker.credential_source_path) {
    const credentialSource = hostPath(docker.credential_source_path, "credential_source_path");
    const credentialRoot = hostPath(docker.credential_root, "credential_root");
    if (credentialSource === credentialRoot || !isInside(credentialSource, credentialRoot)) {
      throw new Error("credential source must be inside the managed credential root");
    }
    const target = docker.credential_target_path
      ? containerCredentialTarget(docker.credential_target_path)
      : `${CONTAINER_HOME}/.runtime-profile`;
    args.push("--volume", `${credentialSource}:${target}:ro`);
  }
  args.push("--env", "HOME=/home/sandbox");
  for (const [key, value] of Object.entries(dockerEnv(env))) {
    args.push("--env", `${key}=${value}`);
  }
  args.push(docker.image, ...containerCommand);
  return args;
}

async function buildReadOnlyCommand(
  command: string[],
  options: ReadOnlyCliExecutionOptions,
  bubblewrapExecutable: string,
): Promise<string[]> {
  if (command.length === 0) throw new Error("CLI command is empty");
  const workspace = localAbsolutePath(options.workspace_cwd, "workspace_cwd");
  const context = localAbsolutePath(options.context_cwd, "context_cwd");
  const sandboxRoot = localAbsolutePath(options.sandbox_root, "sandbox_root");
  const agentSpaceHome = localAbsolutePath(options.agent_space_home, "agent_space_home");
  const cliToolsRoot = localAbsolutePath(options.cli_tools_root, "cli_tools_root");
  const executable = localAbsolutePath(command[0]!, "runtime executable");
  const [
    realSandboxRoot,
    realAgentSpaceHome,
    realWorkspace,
    realContext,
    realCliToolsRoot,
    realExecutable,
  ] =
    await Promise.all([
      realpath(sandboxRoot),
      realpath(agentSpaceHome),
      realpath(workspace),
      realpath(context),
      realpath(cliToolsRoot),
      realpath(executable),
    ]);
  if (realContext === realSandboxRoot || !isInside(realContext, realSandboxRoot)) {
    throw new Error("read-only context must resolve inside the configured sandbox root");
  }
  if (
    realCliToolsRoot === realAgentSpaceHome
    || !isInside(realCliToolsRoot, realAgentSpaceHome)
  ) {
    throw new Error("runtime tools must be inside the managed instance root");
  }
  if (!isInside(realExecutable, realCliToolsRoot)) {
    throw new Error("runtime executable must be inside the configured runtime tools root");
  }
  if (context === sandboxRoot || !isInside(context, sandboxRoot)) {
    throw new Error("read-only context must be inside the configured sandbox root");
  }
  const workspaceInfo = await lstat(workspace);
  const contextInfo = await lstat(context);
  if (!workspaceInfo.isDirectory() || workspaceInfo.isSymbolicLink()) {
    throw new Error("read-only workspace must be a real directory");
  }
  if (!contextInfo.isDirectory() || contextInfo.isSymbolicLink()) {
    throw new Error("read-only context must be a real directory");
  }
  const args = [
    bubblewrapExecutable,
    "--die-with-parent",
    "--new-session",
    "--unshare-pid",
    "--tmpfs", "/",
    "--ro-bind", "/usr", "/usr",
    "--ro-bind", "/bin", "/bin",
    "--ro-bind", "/sbin", "/sbin",
    "--ro-bind", "/lib", "/lib",
    "--ro-bind", "/lib64", "/lib64",
    "--proc", "/proc",
    "--dev", "/dev",
    "--tmpfs", "/tmp",
    "--ro-bind", cliToolsRoot, cliToolsRoot,
  ];
  for (const systemPath of READ_ONLY_SYSTEM_ETC_PATHS) {
    if (await lstat(systemPath).then(() => true, () => false)) {
      args.push("--ro-bind", systemPath, systemPath);
    }
  }
  for (const path of uniquePaths(options.readable_paths)) {
    const readable = localAbsolutePath(path, "read-only readable path");
    const realReadable = await realpath(readable);
    if (
      (!isInside(realReadable, realSandboxRoot)
        && !isInside(realReadable, realAgentSpaceHome))
      || realReadable === realSandboxRoot
      || realReadable === realAgentSpaceHome
      || isInside(realReadable, realWorkspace)
    ) {
      throw new Error("read-only sandbox readable path is outside managed runtime roots");
    }
    const info = await lstat(readable);
    if (!info.isDirectory() || info.isSymbolicLink()) {
      throw new Error("read-only sandbox readable path must be a real directory");
    }
    args.push("--ro-bind", readable, readable);
  }
  for (const path of uniquePaths(options.writable_paths)) {
    const writable = localAbsolutePath(path, "read-only writable path");
    const realWritable = await realpath(writable);
    if (
      (!isInside(realWritable, realSandboxRoot)
        && !isInside(realWritable, realAgentSpaceHome))
      || realWritable === realSandboxRoot
      || realWritable === realAgentSpaceHome
      || isInside(realWritable, realWorkspace)
    ) {
      throw new Error("read-only sandbox writable path is outside managed runtime roots");
    }
    const info = await lstat(writable);
    if (!info.isDirectory() || info.isSymbolicLink()) {
      throw new Error("read-only sandbox writable path must be a real directory");
    }
    args.push("--bind", writable, writable);
  }
  const contextEntries = await readdir(context, { withFileTypes: true });
  const generatedNames = new Set(contextEntries.map((entry) => entry.name));
  args.push("--tmpfs", workspace);
  for (const entry of await readdir(workspace, { withFileTypes: true })) {
    if (generatedNames.has(entry.name)) continue;
    const source = join(workspace, entry.name);
    const target = join(workspace, entry.name);
    if (entry.isSymbolicLink()) {
      args.push("--symlink", await readlink(join(workspace, entry.name)), target);
      continue;
    }
    if (!entry.isDirectory() && !entry.isFile()) {
      throw new Error("Project Folder contains an unsupported top-level filesystem entry");
    }
    args.push("--ro-bind", source, target);
  }
  for (const entry of contextEntries) {
    if (entry.isSymbolicLink() || (!entry.isDirectory() && !entry.isFile())) {
      throw new Error("read-only context contains an unsupported filesystem entry");
    }
    const source = join(context, entry.name);
    const target = join(workspace, entry.name);
    args.push("--ro-bind", source, target);
  }
  args.push("--remount-ro", workspace, "--chdir", workspace, "--", ...command);
  return args;
}

function dockerEnv(env: Record<string, string>): Record<string, string> {
  const safe: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (key === "TERM" || key === "LANG" || key.startsWith("LC_")) safe[key] = value;
    if (key === "AGENT_SPACE_EXCHANGE_INPUT") safe[key] = "/run-exchange/input/run_input.json";
    if (key === "AGENT_SPACE_EXCHANGE_OUTPUT") safe[key] = "/run-exchange/output";
  }
  return safe;
}

function dockerLauncherEnv(env: Record<string, string>): Record<string, string> {
  const safe = dockerEnv(env);
  if (env.PATH) safe.PATH = env.PATH;
  return safe;
}

function readOnlyLauncherEnv(env: Record<string, string>): Record<string, string> {
  const safe = { ...env };
  if (process.env.PATH) safe.PATH = process.env.PATH;
  return safe;
}

function containerCredentialTarget(target: string): string {
  const normalized = target.replaceAll("\\", "/");
  const base = normalized.startsWith("/home/")
    ? normalized.slice(normalized.indexOf("/", "/home/".length) + 1)
    : normalized.replace(/^\/+/, "");
  if (!base || base.includes("..")) throw new Error("invalid credential target path");
  return `${CONTAINER_HOME}/${base}`;
}

function hostPath(value: string, field: string): string {
  if (!value.startsWith("/")) throw new Error(`${field} must be absolute`);
  return resolveHostPath(resolve(value));
}

function localAbsolutePath(value: string, field: string): string {
  if (!value.startsWith("/")) throw new Error(`${field} must be absolute`);
  return resolve(value);
}

function uniquePaths(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function isInside(child: string, parent: string): boolean {
  return child === parent || child.startsWith(`${parent}/`);
}

function relative(parent: string, child: string): string {
  const value = child.slice(parent.length).replace(/^\/+/, "");
  if (!value || value.includes("..")) throw new Error("runtime executable path is invalid");
  return value;
}

function failedDockerResult(message: string): CliExecutionResult {
  return { returncode: -1, stdout: "", stderr: message, timed_out: false };
}

function failedReadOnlyResult(message: string): CliExecutionResult {
  return {
    returncode: -1,
    stdout: "",
    stderr: message,
    timed_out: false,
    failure_code: "read_only_sandbox_unavailable",
  };
}
