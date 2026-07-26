import type { FastifyBaseLogger } from "fastify";
import type { CliUsageEntry } from "./credentialBroker";

export const CLI_USAGE_REFRESH_INTERVAL_MS = 3 * 60 * 60 * 1000;
const DEFAULT_RUNTIMES = ["claude_code", "codex_cli"] as const;

type TimerHandle = ReturnType<typeof setInterval>;

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

export interface CliUsageRefreshScheduler {
  refreshDueUsage(): Promise<void>;
  stop(): void;
}

export interface CliUsageRefreshSchedulerOptions {
  intervalMs?: number;
  maxAgeMs?: number;
  runtimes?: readonly string[];
  isEnabled?: () => boolean | Promise<boolean>;
  logger?: Pick<FastifyBaseLogger, "debug" | "warn">;
}

export function startCliUsageRefreshScheduler(
  broker: CliUsageRefreshBroker,
  options: CliUsageRefreshSchedulerOptions = {},
): CliUsageRefreshScheduler {
  const intervalMs = options.intervalMs ?? CLI_USAGE_REFRESH_INTERVAL_MS;
  const maxAgeMs = options.maxAgeMs ?? intervalMs;
  const runtimes = options.runtimes ?? DEFAULT_RUNTIMES;
  let stopped = false;
  let running = false;

  async function refreshDueUsage(): Promise<void> {
    if (stopped || running) return;
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

  const timer: TimerHandle = setInterval(() => {
    void refreshDueUsage();
  }, intervalMs);
  timer.unref?.();

  return {
    refreshDueUsage,
    stop() {
      stopped = true;
      clearInterval(timer);
    },
  };
}
