/**
 * In-process scheduled-task registry.
 *
 * Beyond timing, this owns each task's *liveness*: how long a pass may take
 * before it is reported, whether the loop is still turning, and what the last
 * outcome was. Without that, a task whose `run()` never settles — a query or
 * HTTP call with no timeout of its own — stops forever while the process stays
 * healthy and `/health` keeps returning 200. A silently stopped loop produces
 * no error, so failure alerting alone cannot detect it.
 *
 * A timed-out pass cannot be cancelled (there is no cancellation in a bare
 * promise), so the deadline is a *reporting* deadline: it records and alerts,
 * and it blocks further passes of that task until the hung one settles, so
 * hung passes cannot pile up.
 */

/** Reporting deadline for one pass when a task does not declare its own. */
export const DEFAULT_TASK_TIMEOUT_SECONDS = 600;

/** A task is stalled once it has not completed a pass for this many intervals. */
const STALL_INTERVAL_MULTIPLIER = 3;

export interface ScheduledTask {
  name: string;
  intervalSeconds: number;
  run: () => Promise<void>;
  runOnStart?: boolean;
  awaitRunOnStart?: boolean;
  /**
   * Reporting deadline for a single pass. Tasks that legitimately run long
   * (backup) must raise this, otherwise a normal pass is reported as a stall.
   */
  timeoutSeconds?: number;
}

export interface SchedulerLogger {
  warn(message: string): void;
  error(message: string): void;
}

export type ScheduledTaskHealth = "ok" | "pending" | "failing" | "stalled";

export interface ScheduledTaskStatus {
  name: string;
  interval_seconds: number;
  timeout_seconds: number;
  state: "idle" | "running";
  health: ScheduledTaskHealth;
  last_started_at: string | null;
  last_success_at: string | null;
  last_failure_at: string | null;
  last_error: string | null;
  consecutive_failures: number;
  timeouts_total: number;
  /** Seconds since the last completed pass, either outcome. */
  seconds_since_completion: number | null;
}

export interface SchedulerHandle {
  readonly started: Promise<void>;
  readonly taskNames: readonly string[];
  statuses(now?: Date): ScheduledTaskStatus[];
  stop(): Promise<void>;
}

export type SchedulerTaskErrorHandler = (taskName: string, error: unknown) => Promise<void>;

/** Raised when a pass exceeds its reporting deadline. */
export class ScheduledTaskTimeoutError extends Error {
  constructor(taskName: string, timeoutSeconds: number) {
    super(`Scheduled task ${taskName} did not complete within ${timeoutSeconds}s`);
    this.name = "ScheduledTaskTimeoutError";
  }
}

interface TaskLiveness {
  registeredAt: number;
  lastStartedAt: number | null;
  lastSuccessAt: number | null;
  lastFailureAt: number | null;
  lastCompletedAt: number | null;
  lastError: string | null;
  consecutiveFailures: number;
  timeouts: number;
  /** Set while a pass is outstanding, including a pass that already timed out. */
  inFlight: Promise<void> | null;
}

export class SchedulerRegistry implements SchedulerHandle {
  private readonly tasks = new Map<string, ScheduledTask>();
  private readonly liveness = new Map<string, TaskLiveness>();
  private readonly loops = new Map<string, Promise<void>>();
  private readonly sleepers = new Map<ReturnType<typeof setTimeout>, () => void>();
  private running = false;
  private stopping = false;
  private stopPromise: Promise<void> | null = null;
  private startPromise: Promise<void> = Promise.resolve();
  private stopSignal: Promise<void> = new Promise(() => {});
  private releaseStopSignal: () => void = () => {};

  constructor(
    private readonly log?: SchedulerLogger,
    private readonly onTaskError?: SchedulerTaskErrorHandler,
  ) {
    this.resetStopSignal();
  }

  get started(): Promise<void> {
    return this.startPromise;
  }

  get taskNames(): readonly string[] {
    return Array.from(this.tasks.keys());
  }

  register(task: ScheduledTask): void {
    validateTask(task);
    if (this.running) {
      throw new Error("cannot register scheduled tasks after start");
    }
    if (this.tasks.has(task.name)) {
      throw new Error(`scheduled task already registered: ${task.name}`);
    }
    this.tasks.set(task.name, task);
    this.liveness.set(task.name, {
      registeredAt: Date.now(),
      lastStartedAt: null,
      lastSuccessAt: null,
      lastFailureAt: null,
      lastCompletedAt: null,
      lastError: null,
      consecutiveFailures: 0,
      timeouts: 0,
      inFlight: null,
    });
  }

  statuses(now: Date = new Date()): ScheduledTaskStatus[] {
    const nowMs = now.getTime();
    return Array.from(this.tasks.values()).map((task) => {
      const state = this.liveness.get(task.name)!;
      const timeoutSeconds = taskTimeoutSeconds(task);
      const sinceCompletion =
        state.lastCompletedAt === null ? null : Math.max(0, nowMs - state.lastCompletedAt);
      return {
        name: task.name,
        interval_seconds: task.intervalSeconds,
        timeout_seconds: timeoutSeconds,
        state: state.inFlight ? "running" : "idle",
        health: computeHealth(task, state, nowMs),
        last_started_at: isoOrNull(state.lastStartedAt),
        last_success_at: isoOrNull(state.lastSuccessAt),
        last_failure_at: isoOrNull(state.lastFailureAt),
        last_error: state.lastError,
        consecutive_failures: state.consecutiveFailures,
        timeouts_total: state.timeouts,
        seconds_since_completion:
          sinceCompletion === null ? null : Math.round(sinceCompletion / 1000),
      };
    });
  }

  start(): Promise<void> {
    if (this.running) return this.startPromise;
    this.running = true;
    this.stopping = false;
    this.stopPromise = null;
    this.resetStopSignal();
    this.startPromise = this.startInternal();
    return this.startPromise;
  }

  async stop(): Promise<void> {
    if (!this.running && this.stopPromise) return this.stopPromise;
    if (!this.running) return;
    this.stopping = true;
    // Release both waits a loop can be sitting in: the interval sleep and an
    // outstanding pass. Shutdown must not block for a task's full deadline.
    this.releaseStopSignal();
    for (const wake of Array.from(this.sleepers.values())) wake();
    this.stopPromise = Promise.allSettled([
      this.startPromise,
      ...this.loops.values(),
    ]).then(() => {
      this.loops.clear();
      this.running = false;
      this.stopping = false;
    });
    return this.stopPromise;
  }

  private resetStopSignal(): void {
    this.stopSignal = new Promise<void>((resolve) => {
      this.releaseStopSignal = resolve;
    });
  }

  private async startInternal(): Promise<void> {
    for (const task of this.tasks.values()) {
      if (this.stopping) return;
      const runOnStart = task.runOnStart ?? true;
      if (runOnStart && task.awaitRunOnStart) {
        await this.runOnce(task);
        if (this.stopping) return;
        this.loops.set(task.name, this.runLoop(task, task.intervalSeconds));
      } else {
        this.loops.set(task.name, this.runLoop(task, runOnStart ? 0 : task.intervalSeconds));
      }
    }
  }

  private async runOnce(task: ScheduledTask): Promise<void> {
    if (this.stopping) return;
    const state = this.liveness.get(task.name)!;
    if (state.inFlight) {
      // A previous pass timed out and has still not settled. Starting another
      // would stack unbounded work on whatever is already wedged.
      this.log?.warn(
        `[scheduler:${task.name}] previous pass still outstanding; skipping this interval`,
      );
      return;
    }

    const timeoutSeconds = taskTimeoutSeconds(task);
    state.lastStartedAt = Date.now();

    let settled = false;
    const pass = (async () => {
      try {
        await task.run();
      } finally {
        settled = true;
        state.inFlight = null;
      }
    })();
    // The pass is tracked even after a timeout; failures are reported below and
    // must not surface as an unhandled rejection from this detached handle.
    pass.catch(() => {});
    state.inFlight = pass;

    let timer: ReturnType<typeof setTimeout> | null = null;
    const deadline = new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => resolve("timeout"), timeoutSeconds * 1000);
      timer.unref?.();
    });

    try {
      const outcome = await Promise.race([
        pass.then(() => "done" as const, (error: unknown) => ({ error })),
        deadline,
        this.stopSignal.then(() => "stopped" as const),
      ]);

      if (outcome === "stopped") return;

      if (outcome === "timeout") {
        state.timeouts += 1;
        this.recordFailure(state, new ScheduledTaskTimeoutError(task.name, timeoutSeconds));
        await this.reportFailure(
          task.name,
          new ScheduledTaskTimeoutError(task.name, timeoutSeconds),
        );
        return;
      }

      if (typeof outcome === "object") {
        this.recordFailure(state, outcome.error);
        await this.reportFailure(task.name, outcome.error);
        return;
      }

      const completedAt = Date.now();
      state.lastSuccessAt = completedAt;
      state.lastCompletedAt = completedAt;
      state.lastError = null;
      state.consecutiveFailures = 0;
    } finally {
      if (timer) clearTimeout(timer);
      if (settled) state.inFlight = null;
    }
  }

  private recordFailure(state: TaskLiveness, error: unknown): void {
    const now = Date.now();
    state.lastFailureAt = now;
    state.lastCompletedAt = now;
    state.consecutiveFailures += 1;
    state.lastError = error instanceof Error ? error.message : String(error);
  }

  private async reportFailure(taskName: string, error: unknown): Promise<void> {
    this.log?.error(
      `[scheduler:${taskName}] ${error instanceof Error ? error.message : String(error)}`,
    );
    try {
      await this.onTaskError?.(taskName, error);
    } catch (alertError) {
      this.log?.error(
        `[scheduler:${taskName}] alert failed: ${
          alertError instanceof Error ? alertError.message : String(alertError)
        }`,
      );
    }
  }

  private sleep(ms: number): Promise<void> {
    if (this.stopping) return Promise.resolve();
    return new Promise((resolveSleep) => {
      const timer = setTimeout(() => {
        this.sleepers.delete(timer);
        resolveSleep();
      }, ms);
      timer.unref?.();
      this.sleepers.set(timer, () => {
        clearTimeout(timer);
        this.sleepers.delete(timer);
        resolveSleep();
      });
    });
  }

  private async runLoop(task: ScheduledTask, initialDelaySeconds: number): Promise<void> {
    if (initialDelaySeconds > 0) {
      await this.sleep(initialDelaySeconds * 1000);
    }
    while (!this.stopping) {
      await this.runOnce(task);
      if (!this.stopping) await this.sleep(task.intervalSeconds * 1000);
    }
  }
}

export function startSchedulerRegistry(
  tasks: ScheduledTask[],
  log?: SchedulerLogger,
  onTaskError?: SchedulerTaskErrorHandler,
): SchedulerHandle {
  const registry = new SchedulerRegistry(log, onTaskError);
  for (const task of tasks) {
    registry.register(task);
  }
  void registry.start();
  return registry;
}

export function taskTimeoutSeconds(task: ScheduledTask): number {
  return task.timeoutSeconds ?? DEFAULT_TASK_TIMEOUT_SECONDS;
}

function computeHealth(
  task: ScheduledTask,
  state: TaskLiveness,
  nowMs: number,
): ScheduledTaskHealth {
  const timeoutSeconds = taskTimeoutSeconds(task);
  // Stall is measured from the last *completed* pass, either outcome: the
  // failure mode is "the loop stopped turning", not "the work stopped
  // succeeding". A task that fails every pass is failing, not stalled.
  const stallAfterMs =
    Math.max(task.intervalSeconds * STALL_INTERVAL_MULTIPLIER, timeoutSeconds + task.intervalSeconds) *
    1000;
  const reference = state.lastCompletedAt ?? state.registeredAt;
  if (nowMs - reference > stallAfterMs) return "stalled";
  if (state.consecutiveFailures > 0) return "failing";
  if (state.lastSuccessAt === null) return "pending";
  return "ok";
}

function isoOrNull(value: number | null): string | null {
  return value === null ? null : new Date(value).toISOString();
}

function validateTask(task: ScheduledTask): void {
  if (!task.name) {
    throw new Error("scheduled task name is required");
  }
  if (task.intervalSeconds <= 0) {
    throw new Error(`scheduled task ${task.name} requires a positive interval`);
  }
  if (task.timeoutSeconds !== undefined && task.timeoutSeconds <= 0) {
    throw new Error(`scheduled task ${task.name} requires a positive timeout`);
  }
  if (task.awaitRunOnStart && !(task.runOnStart ?? true)) {
    throw new Error("awaitRunOnStart requires runOnStart");
  }
}
