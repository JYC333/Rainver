/**
 * Process-local handle on the running background services.
 *
 * The status route only receives `ModuleContext` (config/snapshot/pluginHost),
 * but component status has to report the *live* scheduler and jobs worker of
 * this process, not what config says should exist. There is exactly one
 * background-services instance per process, so a module-level holder is the
 * honest representation — the same shape as the other module-level registries
 * in this codebase.
 *
 * Absence is meaningful and must not be reported as healthy: a server started
 * without a database runs no worker and no DB-backed tasks, so the status
 * route reports "not running" as its own condition rather than as healthy.
 */

import type { ScheduledTaskStatus } from "./registry";

export interface BackgroundServicesStatusSource {
  schedulerStatuses(now?: Date): ScheduledTaskStatus[];
  workerId(): string | null;
  /** Pending + running rows in the durable job queue, or null when unavailable. */
  queueDepth(): Promise<{ pending: number; running: number } | null>;
}

let current: BackgroundServicesStatusSource | null = null;

export function setBackgroundServicesStatusSource(
  source: BackgroundServicesStatusSource | null,
): void {
  current = source;
}

export function getBackgroundServicesStatusSource(): BackgroundServicesStatusSource | null {
  return current;
}
