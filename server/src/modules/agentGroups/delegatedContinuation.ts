import { createHash } from "node:crypto";
import type { Queryable } from "../routeUtils/common.js";

export function delegationAudienceDigest(userIds: readonly string[]): string {
  return createHash("sha256").update(JSON.stringify([...new Set(userIds)].sort())).digest("hex");
}

/** Check a completed sibling's saved basis, then lock any reusable session. */
export async function lockDelegatedContinuation(
  db: Queryable,
  input: {
    previousRunId: string;
    spaceId: string;
    parentRunId: string;
    sessionId: string;
    agentId: string;
    agentVersionId: string;
    userId: string;
    profileId: string;
    hostId: string;
    locationId: string;
    runtimeKey: string;
    installation: string;
    config: unknown;
    granteeIds: readonly string[];
    audienceDigest: string;
    identityDigest: string;
  } & ({ access: "read" } | {
    access: "write";
    modelName: string | null;
    runtimeConfig: Record<string, unknown>;
    runtimePolicy: Record<string, unknown>;
    contextPolicy: Record<string, unknown>;
  }),
): Promise<{ thread_id: string | null; old_commit: string; workspace_id: string; generation: number } | null> {
  const { runtime_installation: _installation, ...runtimeConfig } = input.access === "write" ? input.runtimeConfig : {};
  const profile = input.access === "write" ? [input.modelName, runtimeConfig, input.runtimePolicy] : null;
  const result = await db.query<{ thread_id: string | null; old_commit: string; workspace_id: string; generation: number }>(`
    SELECT CASE WHEN thread.status = 'active'
                AND thread.last_run_id = previous.id AND thread.dispatch_lock_id IS NULL
                AND thread.vendor_session_id IS NOT NULL
                AND NOT (thread.retired_vendor_session_ids ? thread.vendor_session_id)
                AND thread.identity_digest_run_id = previous.id AND thread.identity_digest = $16
                AND thread.pending_archive_at IS NULL AND thread.handoff_artifact_id IS NULL
                AND thread.context_tokens BETWEEN 1 AND thread.context_window_tokens / 4
                THEN thread.id END AS thread_id,
           COALESCE(review.expected_commit, saved.checkpoint_commit) AS old_commit,
           workspace.id AS workspace_id, workspace.generation
      FROM runs previous
      JOIN run_delegations delegation ON delegation.id = previous.delegation_id AND delegation.space_id = previous.space_id
      JOIN host_threads thread ON thread.id = previous.host_task_thread_id AND thread.space_id = previous.space_id
      JOIN execution_workspace_runs parent ON parent.run_id = previous.parent_run_id AND parent.space_id = previous.space_id
        AND parent.access_mode = 'write'
      JOIN execution_workspaces workspace ON workspace.id = parent.workspace_id AND workspace.space_id = parent.space_id
        AND workspace.owner_kind = 'conversation' AND workspace.session_id = $4
        AND workspace.workspace_location_id = $10 AND workspace.execution_host_id = $9
      LEFT JOIN execution_workspace_reviews review ON $17 = 'read' AND review.run_id = previous.id
        AND review.space_id = previous.space_id AND review.workspace_id = workspace.id
      LEFT JOIN execution_workspace_runs saved ON $17 = 'write' AND saved.run_id = previous.id
        AND saved.space_id = previous.space_id AND saved.workspace_id = workspace.id
        AND saved.change_set_id = parent.change_set_id AND saved.access_mode = 'write'
      LEFT JOIN workspace_change_sets batch ON batch.id = saved.change_set_id AND batch.space_id = saved.space_id
     WHERE previous.id = $1 AND previous.space_id = $2 AND previous.parent_run_id = $3 AND previous.session_id = $4
       AND previous.agent_id = $5 AND previous.agent_version_id = $6 AND previous.instructed_by_user_id = $7
       AND previous.runtime_profile_id = $8 AND previous.model_provider_id IS NULL
       AND previous.status = 'succeeded' AND previous.delegation_id IS NOT NULL AND NOT previous.has_context_taint
       AND previous.contract_snapshot_json->>'workspace_access' = $17
       AND previous.model_override_json->(CASE WHEN $17 = 'read' THEN 'delegated_review' ELSE 'delegated_write' END)->>'audience_digest' = $15
       AND COALESCE(previous.model_override_json->'workspace_access', '[]'::jsonb) = '[]'::jsonb
       AND COALESCE(previous.model_override_json->'acp_session_config', '[]'::jsonb) = $13::jsonb
       AND workspace.state = 'ready'
       AND (($17 = 'read' AND review.state = 'verified' AND review.observed_commit = review.expected_commit
             AND workspace.generation = review.generation AND review.workspace_location_id = $10)
         OR ($17 = 'write' AND saved.checkpoint_state = 'saved' AND saved.checkpoint_commit IS NOT NULL
             AND parent.checkpoint_state = 'saved' AND batch.state = 'open' AND batch.generation = workspace.generation
             AND COALESCE(delegation.context_policy_json, '{}'::jsonb) = $19::jsonb
             AND previous.runtime_profile_snapshot_json->>'backend_mode' = 'runtime_native'
             AND previous.runtime_profile_snapshot_json->>'runtime_installation' = $12
             AND jsonb_build_array(previous.runtime_profile_snapshot_json->'model_name',
                   (previous.runtime_profile_snapshot_json->'runtime_config_json') - 'runtime_installation',
                   previous.runtime_profile_snapshot_json->'runtime_policy_json') = $18::jsonb))
       AND thread.agent_id = $5 AND thread.session_id = $4 AND thread.last_session_id = $4
       AND thread.execution_host_id = $9 AND thread.workspace_mode = 'location'
       AND thread.workspace_location_id = $10
       AND thread.runtime_key = $11 AND thread.runtime_installation = $12
       AND thread.container_kind = 'conversation' AND thread.delegation_id IS NOT NULL
       AND thread.execution_workspace_json->>'id' = workspace.id
       AND thread.execution_workspace_json->>'generation' = workspace.generation::text
       AND ARRAY(SELECT DISTINCT grant_row.grantee_user_id::text FROM content_access_grants grant_row
                  WHERE grant_row.space_id = previous.space_id AND grant_row.resource_type = 'run'
                    AND grant_row.resource_id = previous.id AND grant_row.revoked_at IS NULL
                    AND grant_row.access_level = 'full' ORDER BY 1)
           = ARRAY(SELECT DISTINCT user_id FROM unnest($14::text[]) AS ids(user_id) ORDER BY 1)
       AND ($17 = 'read' OR NOT EXISTS (
         SELECT 1 FROM runs history WHERE history.host_task_thread_id = thread.id AND history.space_id = previous.space_id
           AND history.id <> previous.id AND history.started_at IS NOT NULL
           AND (history.has_context_taint OR
             ARRAY(SELECT DISTINCT history_grant.grantee_user_id::text FROM content_access_grants history_grant
                     WHERE history_grant.space_id = history.space_id AND history_grant.resource_type = 'run'
                       AND history_grant.resource_id = history.id AND history_grant.revoked_at IS NULL
                       AND history_grant.access_level = 'full' ORDER BY 1)
               <> ARRAY(SELECT DISTINCT user_id FROM unnest($14::text[]) AS ids(user_id) ORDER BY 1))))
     FOR UPDATE OF thread`, [
    input.previousRunId, input.spaceId, input.parentRunId, input.sessionId, input.agentId, input.agentVersionId,
    input.userId, input.profileId, input.hostId, input.locationId, input.runtimeKey, input.installation,
    JSON.stringify(input.config), input.granteeIds, input.audienceDigest, input.identityDigest,
    input.access, JSON.stringify(profile), JSON.stringify(input.access === "write" ? input.contextPolicy : {}),
  ]);
  const candidate = result.rows[0];
  return candidate && (input.access === "write" || candidate.thread_id) ? candidate : null;
}
