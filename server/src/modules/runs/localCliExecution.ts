import type { CanonicalUsage } from "@agent-space/protocol" with { "resolution-mode": "import" };

export interface CliExecutionResult {
  returncode: number;
  stdout: string;
  stderr: string;
  timed_out: boolean;
  failure_code?: "timeout" | "stall_timeout" | "sandbox_runner_unavailable" | "sandbox_namespace_unavailable" | "output_limit_exceeded";
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
  registerRemote?(runId: string, terminate: () => void, forceTerminate: () => void): void;
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
    scope_id?: string;
    stdin: string | null;
    process_registry?: CliProcessRegistry;
    stall_timeout_seconds?: number;
    on_stdout_chunk?: (chunk: string) => void;
    on_stderr_chunk?: (chunk: string) => void;
    stdio_controller?: CliStdioController;
    raw_stdio_controller?: CliRawStdioController;
    terminal?: boolean;
    read_only?: ReadOnlyCliExecutionOptions;
    egress_profile?: "none" | "provider" | "tools" | "provider_and_tools";
  }): Promise<CliExecutionResult>;
}

export interface CliRawStdioController {
  start(send: (value: string) => void): void;
  receive(value: string): void;
}

export interface CliStdioController {
  start(send: (message: Record<string, unknown>) => void): void;
  receive(message: Record<string, unknown>, send: (message: Record<string, unknown>) => void, closeStdin: () => void): void;
  reject(message: string): void;
  result(): {
    completed: boolean;
    error: string | null;
    resume_handshake_failed?: boolean;
    text: string;
    external_session_id?: string | null;
    usage?: CanonicalUsage | null;
    model_usage?: Array<{ model: string; usage: CanonicalUsage }>;
    subscription_quota?: {
      status: string;
      rate_limit_type: string;
      utilization: number;
      resets_at: number;
      is_using_overage: boolean;
    } | null;
  };
}

/** Tracks remote Runner executions without ever signalling a local application-server PID. */
export class LocalCliProcessRegistry implements CliProcessRegistry {
  private readonly processes = new Map<string, { terminate: () => void; forceTerminate: () => void; lastActivityAt: number }>();
  private readonly exitWaiters = new Map<string, Set<(exited: boolean) => void>>();

  register(): void {
    throw new Error("Application-server subprocess registration is disabled; use registerRemote.");
  }

  registerRemote(runId: string, terminate: () => void, forceTerminate: () => void): void {
    this.processes.set(runId, { terminate, forceTerminate, lastActivityAt: Date.now() });
  }

  deregister(runId: string): void {
    this.processes.delete(runId);
    const waiters = this.exitWaiters.get(runId);
    if (!waiters) return;
    this.exitWaiters.delete(runId);
    for (const resolve of waiters) resolve(true);
  }

  terminate(runId: string): boolean {
    const process = this.processes.get(runId);
    if (!process) return false;
    process.terminate();
    return true;
  }

  forceTerminate(runId: string): boolean {
    const process = this.processes.get(runId);
    if (!process) return false;
    process.forceTerminate();
    return true;
  }

  waitForExit(runId: string, timeoutMs: number): Promise<boolean> {
    if (!this.processes.has(runId)) return Promise.resolve(true);
    return new Promise((resolve) => {
      const waiters = this.exitWaiters.get(runId) ?? new Set<(exited: boolean) => void>();
      let timer: ReturnType<typeof setTimeout>;
      const done = (exited: boolean) => { clearTimeout(timer); resolve(exited); };
      timer = setTimeout(() => {
        waiters.delete(done);
        if (waiters.size === 0) this.exitWaiters.delete(runId);
        resolve(false);
      }, Math.max(0, timeoutMs));
      timer.unref?.();
      waiters.add(done);
      this.exitWaiters.set(runId, waiters);
    });
  }

  touchActivity(runId: string): void {
    const process = this.processes.get(runId);
    if (process) process.lastActivityAt = Date.now();
  }
}
