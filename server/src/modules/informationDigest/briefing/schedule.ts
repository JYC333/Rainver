import { HttpError, withQueryableTransaction, type Queryable } from "../../routeUtils/common.js";
import { selectExecution, type BriefingExecution } from "./execution.js";

export interface DailyBriefingSetting {
  enabled: boolean;
  user_id: string | null;
  agent_id: string | null;
  runtime_profile_id: string | null;
}

/** The Project's one hidden daily digest Automation: briefings ride on it, never on a second schedule. */
async function projectDigestAutomation(db: Queryable, spaceId: string, projectId: string, forUpdate = false) {
  return (await db.query<{ id: string; config_json: Record<string, unknown> }>(
    `SELECT id, config_json FROM automations
      WHERE space_id = $1 AND project_id = $2 AND status <> 'archived'
        AND config_json->>'target_type' = 'information_digest' AND config_json->>'scope' = 'project'
        AND COALESCE(config_json->>'operation','daily') = 'daily'
      ORDER BY created_at, id LIMIT 1${forUpdate ? " FOR UPDATE" : ""}`,
    [spaceId, projectId],
  )).rows[0] ?? null;
}

export function dailyBriefingSetting(config: Record<string, unknown> | null | undefined): DailyBriefingSetting {
  const raw = (config?.briefing ?? {}) as Record<string, unknown>;
  const text = (value: unknown) => (typeof value === "string" && value ? value : null);
  return { enabled: raw.enabled === true, user_id: text(raw.user_id), agent_id: text(raw.agent_id), runtime_profile_id: text(raw.runtime_profile_id) };
}

export async function readDailyBriefingSetting(db: Queryable, spaceId: string, projectId: string): Promise<DailyBriefingSetting> {
  return dailyBriefingSetting((await projectDigestAutomation(db, spaceId, projectId))?.config_json);
}

/**
 * Turns the daily briefing on (as this writer, on their own validated Agent)
 * or off. Only the `briefing` key of the existing Automation changes; its
 * cadence, timezone and attribution stay as they are.
 */
export async function setDailyBriefing(
  db: Queryable,
  spaceId: string,
  projectId: string,
  userId: string,
  input: { daily_enabled: boolean; agent_id?: string; runtime_profile_id?: string },
): Promise<DailyBriefingSetting> {
  return withQueryableTransaction(db, async (tx) => {
    const automation = await projectDigestAutomation(tx, spaceId, projectId, true);
    if (!automation) throw new HttpError(409, "This Project has no daily digest schedule yet", { code: "project_digest_schedule_missing" });
    let execution: BriefingExecution | null = null;
    if (input.daily_enabled) execution = await selectExecution(tx, spaceId, userId, input);
    const briefing = input.daily_enabled
      ? { enabled: true, user_id: userId, agent_id: execution!.agent_id, runtime_profile_id: execution!.runtime_profile_id }
      : { enabled: false };
    await tx.query(
      `UPDATE automations SET config_json = jsonb_set(config_json, '{briefing}', $3::jsonb, true), updated_at = now()
        WHERE space_id = $1 AND id = $2`,
      [spaceId, automation.id, JSON.stringify(briefing)],
    );
    return dailyBriefingSetting({ briefing });
  });
}
