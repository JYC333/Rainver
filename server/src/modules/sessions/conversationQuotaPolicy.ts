import { objectValue, type Queryable } from "../routeUtils/common.js";

/** Consent belongs to one person, conversation member and runtime profile. */
export async function conversationModelSwitchAllowed(db: Queryable, spaceId: string, sessionId: string,
  agentId: string, userId: string, profileId: string | null, runtimeKey: string | null): Promise<boolean> {
  const row = (await db.query<{ policy: unknown }>(
    `SELECT metadata_json->'quota_model_switch'->$3::text AS policy FROM sessions WHERE space_id = $1 AND id = $2`,
    [spaceId, sessionId, agentId],
  )).rows[0];
  const policy = objectValue(row?.policy);
  return policy.enabled === true && policy.user_id === userId && policy.runtime_profile_id === profileId && policy.runtime_key === runtimeKey;
}

/** Called only inside the authorized conversation settings transaction. */
export async function saveConversationModelSwitch(db: Queryable, spaceId: string, sessionId: string,
  agentId: string, userId: string, profileId: string, runtimeKey: string, enabled: boolean): Promise<void> {
  await db.query(
    `UPDATE sessions SET metadata_json = jsonb_set(COALESCE(metadata_json, '{}'::jsonb), '{quota_model_switch}',
       COALESCE(metadata_json->'quota_model_switch', '{}'::jsonb) || jsonb_build_object($3::text, $4::jsonb)), updated_at = now()
      WHERE space_id = $1 AND id = $2`,
    [spaceId, sessionId, agentId, JSON.stringify({ enabled, user_id: userId, runtime_profile_id: profileId, runtime_key: runtimeKey })],
  );
}
