import { getDbPool } from "../../db/pool";
import { withTransaction } from "../../db/tx";
import { automationTargetHandlerRegistry } from "../automations/targetRegistry";
import { PgAutomationRepository } from "../automations/repository";
import { HttpError } from "../routeUtils/common";
import { AutonomyService } from "./service";
import { CliCredentialBroker } from "../providers/cli/credentialBroker";
import type {
  AutonomousAdmissionPolicy,
  AutonomousQuotaSnapshot,
} from "../runs/autonomousAdmission";

export function registerAutonomousTickAutomationTarget(): void {
  automationTargetHandlerRegistry.register("autonomous_tick", {
    preflight: async ({ config, repo, input }) => {
      const errors: string[] = [];
      const role = await repo.getMembershipRole(input.spaceId, input.actorUserId);
      if (!role) errors.push("Autonomous tick owner is not an active Space member");
      const agent = await repo.getAgentPreflight(input.spaceId, input.agentId);
      if (!agent || agent.status !== "active" || !agent.current_version_id || !agent.version_id) {
        errors.push("Autonomous tick requires an active attribution Agent with a current version");
      }
      if (!config.databaseUrl) errors.push("SERVER_DATABASE_URL is required");
      const launchRequested = input.configJson?.observe_only === false;
      if (launchRequested && !input.automationPreAuthorized) {
        errors.push("Autonomous launch requires the Automation credential pre-authorization");
      }
      if (launchRequested && !admissionPolicy(input.configJson)) {
        errors.push("Autonomous launch requires a complete autonomy_budget policy");
      }
      if (errors.length) throw new HttpError(422, errors.join("; "));
      return {
        executable: true,
        target_type: "autonomous_tick",
        autonomy_preflight: {
          executable: true,
          mode: launchRequested ? "launch" : "observe_only",
          owner_user_id: input.actorUserId,
          attribution_agent_id: input.agentId,
          attribution_agent_version_id: agent?.version_id ?? null,
          membership_role: role,
          candidate_kinds: ["periodic_digest", "evolution_review"],
          automation_pre_authorized: input.automationPreAuthorized,
          errors: [],
          warnings: [],
        },
      };
    },
    execute: async ({ config, automation, fireInput, advanceSchedule, preflightSnapshot, triggerType }) => {
      if (!config.databaseUrl) throw new HttpError(502, "SERVER_DATABASE_URL is required");
      const pool = getDbPool(config.databaseUrl);
      const launch = automation.config_json?.observe_only === false;
      const result = launch
        ? await launchTick(config, automation, triggerType, preflightSnapshot)
        : await withTransaction(pool, async (client) => {
            const tick = await new AutonomyService(client).observeTick({
              spaceId: fireInput.spaceId,
              automationId: automation.id,
              ownerUserId: automation.owner_user_id,
              config: automation.config_json,
            });
            const repository = new PgAutomationRepository(client);
            if (advanceSchedule) await repository.advanceSchedule(automation);
            return tick;
          });
      if (launch && advanceSchedule) {
        await withTransaction(pool, async (client) => {
          await new PgAutomationRepository(client).advanceSchedule(automation);
        });
      }
      return {
        ...result,
        target_type: "autonomous_tick",
        trigger_origin: "automation",
      };
    },
  });
}

async function launchTick(
  config: Parameters<typeof launchTickConfig>[0],
  automation: Parameters<AutonomyService["launchCandidates"]>[0]["automation"],
  triggerType: string,
  preflightSnapshot: Record<string, unknown>,
) {
  const resolved = await launchTickConfig(config, automation);
  return new AutonomyService(getDbPool(config.databaseUrl!)).launchCandidates({
    automation,
    triggerType,
    preflightSnapshot,
    policy: resolved.policy,
    quota: resolved.quota,
    runtimeProfileId: resolved.runtimeProfileId,
  });
}

async function launchTickConfig(
  config: import("../../config").ServerConfig,
  automation: Parameters<AutonomyService["launchCandidates"]>[0]["automation"],
): Promise<{
  policy: AutonomousAdmissionPolicy;
  quota: AutonomousQuotaSnapshot;
  runtimeProfileId: string;
}> {
  if (!config.databaseUrl) throw new HttpError(502, "SERVER_DATABASE_URL is required");
  const policy = admissionPolicy(automation.config_json);
  if (!policy) throw new HttpError(422, "Autonomous launch policy is invalid");
  const pool = getDbPool(config.databaseUrl);
  const configuredProfileId = stringValue(automation.config_json?.runtime_profile_id);
  const profile = await pool.query<{ id: string; adapter_type: string }>(
    `SELECT id, adapter_type
       FROM agent_runtime_profiles
      WHERE space_id = $1 AND agent_id = $2 AND enabled = true
        AND ($3::varchar IS NOT NULL AND id = $3 OR $3::varchar IS NULL AND is_default = true)
      ORDER BY is_default DESC, created_at ASC
      LIMIT 1`,
    [automation.space_id, automation.agent_id, configuredProfileId],
  );
  const runtimeProfile = profile.rows[0];
  if (!runtimeProfile) throw new HttpError(422, "Autonomous launch requires an enabled Agent runtime profile");
  const runtime = runtimeProfile.adapter_type;
  if (runtime !== "claude_code" && runtime !== "codex_cli") {
    return {
      policy,
      runtimeProfileId: runtimeProfile.id,
      quota: unavailableQuota(runtime, "unsupported autonomous quota runtime"),
    };
  }
  const broker = new CliCredentialBroker(config);
  const credential = await broker.resolveProfile(
    runtime,
    null,
    true,
    automation.space_id,
    automation.owner_user_id,
  );
  if (!credential) {
    return {
      policy,
      runtimeProfileId: runtimeProfile.id,
      quota: unavailableQuota(runtime, "credential profile unavailable"),
    };
  }
  const cached = await broker.quotaForProfile(runtime, credential.id);
  const values = [cached?.session_pct, cached?.week_pct]
    .filter((value): value is number => typeof value === "number" && Number.isFinite(value));
  return {
    policy,
    runtimeProfileId: runtimeProfile.id,
    quota: {
      runtime,
      credential_profile_id: credential.id,
      available: cached?.available === true && values.length > 0,
      utilization_pct: values.length ? Math.max(...values) : null,
      checked_at: cached?.checked_at ?? null,
      // The cache is shared by the scheduled probe and a Run's piggybacked
      // reading, so provenance must come from the cached entry itself
      // (`claude_code` can legitimately be either) rather than an assumption
      // keyed off runtime — that would misrepresent the admission audit trace.
      source: cached?.source ?? "live_probe",
    },
  };
}

function admissionPolicy(value: Record<string, unknown> | null | undefined): AutonomousAdmissionPolicy | null {
  const policy = recordValue(value?.autonomy_budget);
  const dailyRunLimit = positiveInteger(policy.daily_run_limit);
  const maxUtilization = positiveNumber(policy.max_subscription_utilization_pct);
  const maxAge = positiveInteger(policy.quota_max_age_seconds);
  const cost = policy.daily_cost_limit_usd === null || policy.daily_cost_limit_usd === undefined
    ? null
    : nonNegativeNumber(policy.daily_cost_limit_usd);
  if (!dailyRunLimit || !maxUtilization || maxUtilization > 100 || !maxAge || (policy.daily_cost_limit_usd != null && cost === null)) {
    return null;
  }
  return {
    daily_run_limit: dailyRunLimit,
    daily_cost_limit_usd: cost,
    max_subscription_utilization_pct: maxUtilization,
    quota_max_age_seconds: maxAge,
  };
}

function unavailableQuota(runtime: string, _reason: string): AutonomousQuotaSnapshot {
  return {
    runtime,
    credential_profile_id: "unavailable",
    available: false,
    utilization_pct: null,
    checked_at: null,
    source: "live_probe",
  };
}

function recordValue(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function positiveInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : null;
}

function positiveNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

function nonNegativeNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}
