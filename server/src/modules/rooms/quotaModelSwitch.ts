import type { RuntimeSessionConfigSelection } from "@rainver/protocol";
import type { RunRecord } from "../runs/repository.js";
import { hostInstallationOptions } from "../hosts/capabilities.js";
import { objectValue, type Queryable } from "../routeUtils/common.js";
import { fullerWindow } from "./subscriptionLogins.js";
import { readSubscriptionQuotaPolicy } from "../providers/subscriptionQuotaPolicy.js";
import { HostUsageQuotaSchema } from "@rainver/protocol";
import { runModelSelection } from "../runs/runModelSelection.js";

/** Same installed runtime and native login only; never a Provider/Host fallback. */
export async function quotaModelAlternative(db: Queryable, run: RunRecord): Promise<RuntimeSessionConfigSelection | null> {
  if (run.model_provider_id || objectValue(run.runtime_profile_snapshot_json).backend_mode !== "runtime_native"
    || objectValue(objectValue(run.model_override_json).conversation_backend).model_provider_id) return null;
  const row = (await db.query<{ capabilities_json: unknown; runtime_key: string; installation: string; quota_json: unknown }>(
    `SELECT host.capabilities_json, thread.runtime_key, thread.runtime_installation AS installation, usage.quota_json
       FROM host_threads thread JOIN hosts host ON host.id = thread.execution_host_id
       LEFT JOIN host_runtime_usage usage ON usage.host_id = host.id
         AND usage.runtime_key = thread.runtime_key AND usage.installation = thread.runtime_installation
      WHERE thread.id = $1 AND host.status <> 'revoked'`, [run.host_task_thread_id],
  )).rows[0];
  if (!row || row.runtime_key !== run.runtime_key) return null;
  const quota = HostUsageQuotaSchema.safeParse(row.quota_json);
  if (quota.success && quota.data.available) {
    const window = fullerWindow(quota.data, new Date());
    const policy = await readSubscriptionQuotaPolicy(db, run.space_id);
    // A model change cannot recover a genuinely exhausted shared account.
    if (window && window.utilization >= policy.reserve_pct) return null;
  }
  const option = hostInstallationOptions(row.capabilities_json, row.runtime_key, row.installation)
    .find(option => option.category === "model" && option.type === "select");
  if (!option || option.type !== "select") return null;
  const selection = runModelSelection(run.model_override_json, "failed");
  const current = [selection.reported, selection.requested, option.current_value]
    .find(value => value && value !== "default");
  if (!current) return null;
  const choice = option.options.find(choice => choice.value !== "default" && choice.value !== current);
  return choice ? { id: option.id, type: "select", category: "model", value: choice.value } : null;
}

/** Applies only the model choice, preserving the native thread and other options. */
export async function applyQuotaModelSwitch(db: Queryable, run: RunRecord, alternative: RuntimeSessionConfigSelection): Promise<string> {
  const override = objectValue(run.model_override_json);
  const selections = (Array.isArray(override.acp_session_config) ? override.acp_session_config : [])
    .filter(entry => objectValue(entry).category !== "model");
  override.acp_session_config = [...selections, alternative];
  override.acp_session_config_source = "request";
  delete override.runtime_reported_model;
  await db.query(`UPDATE runs SET model_override_json = $3::jsonb WHERE space_id = $1 AND id = $2`,
    [run.space_id, run.id, JSON.stringify(override)]);
  return String(alternative.value);
}
