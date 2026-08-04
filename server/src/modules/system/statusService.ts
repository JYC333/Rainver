/**
 * Component-level runtime status.
 *
 * `/health` answers "is the process up and can it reach Postgres" — that is a
 * container probe and nothing more. It stays 200 while a scheduled task has
 * silently stopped turning or the jobs worker never started, which is exactly
 * the class of failure that matters for unattended work.
 *
 * This surface reports the components the server actually owns and can observe
 * from inside this process. Components documented in
 * `.agent/modules/server-status.md` that need separate probes (LLM provider
 * reachability, per-adapter runtime tools, sandbox runner) are not reported
 * here yet rather than being reported as healthy on no evidence.
 */

import type { ServerConfig } from "../../config";
import { getDbPool } from "../../db/pool";
import type { Queryable } from "../routeUtils/common";
import {
  getBackgroundServicesStatusSource,
  type BackgroundServicesStatusSource,
} from "../scheduler/runtimeStatus";
import type { ScheduledTaskStatus } from "../scheduler/registry";

export type ComponentStatus = "ok" | "degraded" | "error";

export interface StatusComponent {
  name: string;
  status: ComponentStatus;
  detail: string | null;
}

export interface StatusBody {
  overall: ComponentStatus;
  components: StatusComponent[];
  scheduler_tasks: ScheduledTaskStatus[];
  version: string | null;
  checked_at: string;
}

export async function isDatabaseReachable(
  config: ServerConfig,
  db?: Queryable | null,
): Promise<boolean> {
  const pool = db ?? (config.databaseUrl ? getDbPool(config.databaseUrl) : null);
  if (!pool) return false;
  try {
    await pool.query("SELECT 1 AS healthy");
    return true;
  } catch {
    return false;
  }
}

/** Body returned when the database is unreachable, before any authorization. */
export function databaseUnavailableStatusBody(
  config: ServerConfig,
  now: Date = new Date(),
): StatusBody {
  return {
    overall: "error",
    components: [
      {
        name: "database",
        status: "error",
        detail: config.databaseUrl ? "PostgreSQL unreachable" : "No database configured",
      },
    ],
    // Nothing beyond the database is reported: the caller could not be
    // authorized without it, and operational internals are not public.
    scheduler_tasks: [],
    version: config.appVersion,
    checked_at: now.toISOString(),
  };
}

export async function buildStatusBody(
  config: ServerConfig,
  options: {
    databaseOk: boolean;
    source?: BackgroundServicesStatusSource | null;
    now?: Date;
  },
): Promise<StatusBody> {
  const now = options.now ?? new Date();
  const source =
    options.source === undefined ? getBackgroundServicesStatusSource() : options.source;
  const components: StatusComponent[] = [
    {
      name: "database",
      status: options.databaseOk ? "ok" : "error",
      detail: options.databaseOk ? null : "PostgreSQL unreachable",
    },
  ];

  const tasks = source?.schedulerStatuses(now) ?? [];
  components.push(schedulerComponent(source !== null && source !== undefined, tasks));

  const workerId = source?.workerId() ?? null;
  const depth = source ? await safeQueueDepth(source) : null;
  components.push(workerComponent(workerId, depth));
  components.push(queueComponent(workerId, depth));

  return {
    overall: worstStatus(components.map((component) => component.status)),
    components,
    scheduler_tasks: tasks,
    version: config.appVersion,
    checked_at: now.toISOString(),
  };
}

function schedulerComponent(
  sourcePresent: boolean,
  tasks: ScheduledTaskStatus[],
): StatusComponent {
  if (!sourcePresent) {
    return { name: "scheduler", status: "error", detail: "Background services are not running" };
  }
  if (tasks.length === 0) {
    return { name: "scheduler", status: "degraded", detail: "No scheduled tasks registered" };
  }
  const stalled = tasks.filter((task) => task.health === "stalled");
  const failing = tasks.filter((task) => task.health === "failing");
  if (stalled.length > 0) {
    return {
      name: "scheduler",
      status: "error",
      // A stalled task is the silent failure: name it, because no exception
      // was ever raised for it and nothing else will surface it.
      detail: `Stalled: ${stalled.map((task) => task.name).join(", ")}`,
    };
  }
  if (failing.length > 0) {
    return {
      name: "scheduler",
      status: "degraded",
      detail: `Failing: ${failing.map((task) => task.name).join(", ")}`,
    };
  }
  return { name: "scheduler", status: "ok", detail: `${tasks.length} tasks healthy` };
}

function workerComponent(
  workerId: string | null,
  depth: { pending: number; running: number } | null,
): StatusComponent {
  if (workerId) {
    return { name: "jobs_worker", status: "ok", detail: workerId };
  }
  // No worker is correct for a database-less server and wrong for any server
  // with queued work, so the severity depends on whether work is waiting.
  const pending = depth?.pending ?? 0;
  return {
    name: "jobs_worker",
    status: pending > 0 ? "error" : "degraded",
    detail:
      pending > 0
        ? `No jobs worker running while ${pending} job(s) are pending`
        : "No jobs worker running",
  };
}

function queueComponent(
  workerId: string | null,
  depth: { pending: number; running: number } | null,
): StatusComponent {
  if (!depth) {
    return { name: "jobs_queue", status: "degraded", detail: "Queue depth unavailable" };
  }
  return {
    name: "jobs_queue",
    status: !workerId && depth.pending > 0 ? "error" : "ok",
    detail: `${depth.pending} pending, ${depth.running} running`,
  };
}

async function safeQueueDepth(
  source: BackgroundServicesStatusSource,
): Promise<{ pending: number; running: number } | null> {
  try {
    return await source.queueDepth();
  } catch {
    return null;
  }
}

export function worstStatus(statuses: ComponentStatus[]): ComponentStatus {
  if (statuses.includes("error")) return "error";
  if (statuses.includes("degraded")) return "degraded";
  return "ok";
}
