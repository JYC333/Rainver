import { HttpError, withQueryableTransaction, type Queryable } from "../../routeUtils/common.js";
import type { BriefingScopeAdapter } from "./contract.js";
import { selectExecution } from "./execution.js";

export interface DailyBriefingSetting {
  enabled: boolean;
  user_id: string | null;
  agent_id: string | null;
  runtime_profile_id: string | null;
}

/**
 * The scope's one hidden daily digest Automation (the Project's, or the
 * reader's personal one): briefings ride on it, never on a second schedule.
 */
async function scopeDigestAutomation(db: Queryable, adapter: BriefingScopeAdapter, forUpdate = false) {
  const { scope } = adapter;
  return (await db.query<{ id: string; config_json: Record<string, unknown> }>(
    `SELECT id, config_json FROM automations
      WHERE space_id = $1 AND status <> 'archived'
        AND config_json->>'target_type' = 'information_digest' AND config_json->>'scope' = $2
        AND COALESCE(config_json->>'operation','daily') = 'daily'
        AND (($2 = 'project' AND project_id = $3) OR ($2 = 'personal' AND project_id IS NULL AND owner_user_id = $4))
      ORDER BY created_at, id LIMIT 1${forUpdate ? " FOR UPDATE" : ""}`,
    [scope.spaceId, scope.type, scope.projectId, scope.ownerUserId],
  )).rows[0] ?? null;
}

export function dailyBriefingSetting(config: Record<string, unknown> | null | undefined): DailyBriefingSetting {
  const raw = (config?.briefing ?? {}) as Record<string, unknown>;
  const text = (value: unknown) => (typeof value === "string" && value ? value : null);
  return { enabled: raw.enabled === true, user_id: text(raw.user_id), agent_id: text(raw.agent_id), runtime_profile_id: text(raw.runtime_profile_id) };
}

export async function readDailyBriefingSetting(db: Queryable, adapter: BriefingScopeAdapter): Promise<DailyBriefingSetting> {
  return dailyBriefingSetting((await scopeDigestAutomation(db, adapter))?.config_json);
}

/**
 * Turns the daily briefing on (as this person, on their own validated Agent)
 * or off. Only someone who may generate the scope's briefing may change it
 * (a Project writer; for a personal briefing, its owner). Only the `briefing`
 * key of the existing Automation changes; its cadence, timezone and
 * attribution stay as they are.
 */
export async function setDailyBriefing(
  db: Queryable,
  adapter: BriefingScopeAdapter,
  userId: string,
  input: { daily_enabled: boolean; agent_id?: string; runtime_profile_id?: string },
): Promise<DailyBriefingSetting> {
  return withQueryableTransaction(db, async (tx) => {
    if (!(await adapter.canGenerate(tx, userId))) throw new HttpError(403, "Changing the daily briefing requires write access", { code: "briefing_writer_required" });
    const automation = await scopeDigestAutomation(tx, adapter, true);
    if (!automation) throw new HttpError(409, "This scope has no daily digest schedule yet", { code: "digest_schedule_missing" });
    const execution = input.daily_enabled ? await selectExecution(tx, adapter.scope.spaceId, userId, input) : null;
    const briefing = execution
      ? { enabled: true, user_id: userId, agent_id: execution.agent_id, runtime_profile_id: execution.runtime_profile_id }
      : { enabled: false };
    await tx.query(
      `UPDATE automations SET config_json = jsonb_set(config_json, '{briefing}', $3::jsonb, true), updated_at = now()
        WHERE space_id = $1 AND id = $2`,
      [adapter.scope.spaceId, automation.id, JSON.stringify(briefing)],
    );
    return dailyBriefingSetting({ briefing });
  });
}
