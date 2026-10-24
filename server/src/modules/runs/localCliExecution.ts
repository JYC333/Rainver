import type { CanonicalUsage } from "@rainver/protocol";

export interface CliExecutionResult {
  returncode: number;
  stdout: string;
  stderr: string;
  timed_out: boolean;
  failure_code?: "timeout" | "launch_wait_timeout" | "stall_timeout" | "sandbox_runner_unavailable" | "sandbox_namespace_unavailable" | "output_limit_exceeded";
  /**
   * How long the runtime had been silent when the run was given up on. Set on
   * a timeout or stall so the failure can say whether the runtime was working
   * and slow or had stopped saying anything at all — the two are
   * indistinguishable in the message otherwise, and telling them apart is
   * most of diagnosing a stuck run.
   */
  idle_seconds?: number;
  /**
   * What this Run reached through the host's egress proxy, and what it was
   * refused. Present only for a strict host that ran one; a paired machine
   * uses the machine's own network and reports nothing.
   */
  egress?: Array<{ allowed: boolean; host: string; port: number; reason: string | null; at: string }>;
  /**
   * The Run executed in its Task's worktree on a host: the Task branch and
   * the commit the worktree stood at when the process started (ADR 0016 §11).
   */
  task_worktree?: { branch: string; start_commit: string };
}

export interface ReadOnlyCliExecutionOptions {
  workspace_cwd: string;
  context_cwd: string;
  sandbox_root: string;
  rainver_home: string;
  cli_tools_root: string;
  readable_paths: string[];
  writable_paths: string[];
}

export interface CliProcessRegistry {
  register(runId: string, pid: number): void;
  /**
   * Marks a Run's adapter invocation in flight before it has a process. Its
   * signal is aborted by `terminate`/`forceTerminate`, so a stop that lands
   * while the dispatch is still being prepared, with nothing registered to
   * reach, still stops the launch. Close it when the invocation returns.
   */
  openInvocation?(runId: string): { signal: AbortSignal; close: () => void };
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
    /**
     * Aborted at the Run's explicit time limit, after which orchestration
     * stops the runtime through the normal stop path. An executor that still
     * has not finished soon after must give the Run up rather than hold it.
     */
    deadline_signal?: AbortSignal;
    /**
     * Aborted when the Run was stopped. An executor must not launch once it is
     * aborted; a process already launched is stopped through `process_registry`.
     */
    cancel_signal?: AbortSignal;
    /** Legacy setting name: delay before an informational silence notice, never a deadline. */
    stall_timeout_seconds?: number;
    on_silence?: (idleSeconds: number) => Promise<void> | void;
    on_stdout_chunk?: (chunk: string) => void;
    on_stderr_chunk?: (chunk: string) => void;
    stdio_controller?: CliStdioController;
    raw_stdio_controller?: CliRawStdioController;
    terminal?: boolean;
    read_only?: ReadOnlyCliExecutionOptions;
    workspace_access?: Array<{ workspace_location_id: string; access_mode: "read" | "write"; path: string }>;
  }): Promise<CliExecutionResult>;
}

export interface CliRawStdioController {
  start(send: (value: string) => void): void;
  receive(value: string): void;
}

export interface CliStdioController {
  start(send: (message: Record<string, unknown>) => void): void;
  /**
   * Async by contract. An SDK-backed implementation's next `send()` can depend on a
   * Promise resolving, which never happens synchronously within this call.
   * The remote CLI adapter's own controller stays synchronous in effect by
   * resolving immediately.
   */
  receive(message: Record<string, unknown>, send: (message: Record<string, unknown>) => void, closeStdin: () => void): Promise<void>;
  reject(message: string): void;
  result(): {
    completed: boolean;
    error: string | null;
    resume_handshake_failed?: boolean;
    resume_unanswered?: boolean;
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
    context_window?: { used: number; size: number } | null;
    /** `usage_update` notifications received this turn and the sum of their `used`. */
    usage_updates?: { count: number; used_total: number } | null;
    /** ACP prompts sent, not the model calls inside those prompts. */
    acp_prompt_count?: number;
    /** The runtime's own question that ended the turn (`vendorQuestion.ts`). */
    asked_user?: { question: string; options: string[] } | null;
    /** Saved session options the live session did not offer or apply; the runtime kept its default. */
    dropped_session_config?: Array<{
      id: string;
      category: string | null;
      value: string | boolean;
      reason: "option_unavailable" | "value_unavailable" | "not_applied";
    }>;
  };
}

/** Tracks a daemon Run's stop callbacks. Do not register an application-server process. */
export class LocalCliProcessRegistry implements CliProcessRegistry {
  private readonly processes = new Map<string, { terminate: () => void; forceTerminate: () => void; lastActivityAt: number }>();
  private readonly exitWaiters = new Map<string, Set<(exited: boolean) => void>>();
  private readonly invocations = new Map<string, Set<AbortController>>();

  register(): void {
    throw new Error("Application-server subprocess registration is disabled; use registerRemote.");
  }

  openInvocation(runId: string): { signal: AbortSignal; close: () => void } {
    const controller = new AbortController();
    const open = this.invocations.get(runId) ?? new Set<AbortController>();
    open.add(controller);
    this.invocations.set(runId, open);
    return {
      signal: controller.signal,
      close: () => {
        open.delete(controller);
        if (open.size === 0 && this.invocations.get(runId) === open) this.invocations.delete(runId);
      },
    };
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

  /** True only when a registered process was signalled; an invocation still preparing is stopped either way. */
  terminate(runId: string): boolean {
    this.stopInvocations(runId);
    const process = this.processes.get(runId);
    if (!process) return false;
    process.terminate();
    return true;
  }

  forceTerminate(runId: string): boolean {
    this.stopInvocations(runId);
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

  private stopInvocations(runId: string): void {
    for (const controller of this.invocations.get(runId) ?? []) controller.abort();
  }

  touchActivity(runId: string): void {
    const process = this.processes.get(runId);
    if (process) process.lastActivityAt = Date.now();
  }
}
