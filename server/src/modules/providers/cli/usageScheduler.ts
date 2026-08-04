/**
 * CLI subscription-quota refresh, shaped as a `ScheduledTask`.
 *
 * This owns *what* to refresh, never *when*. It previously ran on its own
 * detached `setInterval` outside `SchedulerRegistry`, which meant shutdown did
 * not stop it, a failure never reached `scheduler_task_failed`, and its
 * liveness was invisible. Timing, cancellation, timeout, failure alerting, and
 * the liveness record all belong to the registry; this module only exposes the
 * work.
 *
 * The refresh is a fallback path: a `claude_code` Run piggybacks live quota on
 * every execution, so this exists so quota does not go stale when nobody is
 * running anything, and so runtimes without piggybacked quota
 * (`codex_cli`) refresh at all.
 */

import type { FastifyBaseLogger } from "fastify";
import type { CliUsageEntry } from "./credentialBroker";

export const CLI_USAGE_REFRESH_INTERVAL_SECONDS = 3 * 60 * 60;
const DEFAULT_RUNTIMES = ["claude_code", "codex_cli"] as const;

export interface CliUsageRefreshBroker {
  listQuotaRefreshTargets(runtime: string): Promise<Array<{
    profile_id: string;
    space_id: string;
    owner_user_id: string;
  }>>;
  refreshStaleCliQuota(
    runtime: string,
    maxAgeMs: number,
    spaceId: string,
    userId: string,
    profileId: string,
  ): Promise<CliUsageEntry | null>;
}

export interface CliUsageRefreshTaskOptions {
  intervalSeconds?: number;
  maxAgeMs?: number;
  runtimes?: readonly string[];
  isEnabled?: () => boolean | Promise<boolean>;
  logger?: Pick<FastifyBaseLogger, "debug" | "warn">;
}

export interface CliUsageRefreshTask {
  name: string;
  intervalSeconds: number;
  runOnStart: boolean;
  run(): Promise<void>;
}

export function createCliUsageRefreshTask(
  broker: CliUsageRefreshBroker,
  options: CliUsageRefreshTaskOptions = {},
): CliUsageRefreshTask {
  const intervalSeconds = options.intervalSeconds ?? CLI_USAGE_REFRESH_INTERVAL_SECONDS;
  const maxAgeMs = options.maxAgeMs ?? intervalSeconds * 1000;
  const runtimes = options.runtimes ?? DEFAULT_RUNTIMES;
  // The registry never re-enters a task, but `run` is also callable directly;
  // keep the guard so a manual call cannot overlap a scheduled pass.
  let running = false;

  async function run(): Promise<void> {
    if (running) return;
    running = true;
    try {
      if (options.isEnabled && !(await options.isEnabled())) {
        options.logger?.debug("CLI usage quota auto-refresh disabled");
        return;
      }
      for (const runtime of runtimes) {
        try {
          const targets = await broker.listQuotaRefreshTargets(runtime);
          for (const target of targets) {
            try {
              const entry = await broker.refreshStaleCliQuota(
                runtime,
                maxAgeMs,
                target.space_id,
                target.owner_user_id,
                target.profile_id,
              );
              if (entry) {
                options.logger?.debug(
                  {
                    runtime,
                    profile_id: target.profile_id,
                    checked_at: entry.quota?.checked_at,
                  },
                  "CLI usage quota refreshed",
                );
              }
            } catch (error) {
              // One unreachable profile must not stop the remaining profiles;
              // a probe failure is expected and self-heals on the next pass.
              options.logger?.warn(
                {
                  runtime,
                  profile_id: target.profile_id,
                  err: error instanceof Error ? error.message : String(error),
                },
                "CLI usage quota refresh failed",
              );
            }
          }
        } catch (error) {
          options.logger?.warn(
            {
              runtime,
              err: error instanceof Error ? error.message : String(error),
            },
            "CLI usage quota refresh failed",
          );
        }
      }
    } finally {
      running = false;
    }
  }

  return {
    name: "cli_usage_quota_refresh",
    intervalSeconds,
    runOnStart: false,
    run,
  };
}
