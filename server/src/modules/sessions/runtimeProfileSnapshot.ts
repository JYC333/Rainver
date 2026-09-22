import { stripSecretFieldsFromRecord } from "@rainver/protocol";
import type { Queryable } from "../routeUtils/common.js";

export interface RuntimeProfileSnapshot {
  runtime_key: string;
  backend_mode: "runtime_native" | "model_provider";
  model_name: string | null;
  model_provider_id: string | null;
  runtime_config_json: Record<string, unknown>;
  runtime_policy_json: Record<string, unknown>;
}

/**
 * The Run-scoped projection: the canonical Profile snapshot plus the execution
 * target the route selected. `runs.runtime_profile_snapshot_json` is written
 * only through this shape, so the backend mode a consumer branches on is the
 * same field a Conversation binding freezes.
 */
export interface RunRuntimeProfileSnapshot extends RuntimeProfileSnapshot {
  id: string;
  name: string;
  execution_host_id: string | null;
  workspace_location_id: string | null;
  workspace_mode: "location" | "managed" | null;
  runtime_installation: string | null;
  is_default: boolean;
  /** Conversation-supplied workspace overrides, carried through unchanged. */
  workspace?: unknown;
  workspace_access?: Array<{ workspace_location_id: string; access_mode: "read" | "write" }>;
}

type RuntimeProfileSnapshotRow = RuntimeProfileSnapshot & { id: string };

/**
 * Load and lock a Profile's execution configuration before persisting it as a
 * Conversation snapshot. The row lock keeps both JSON documents and their
 * runtime/provider identity from drifting between read and snapshot write.
 */
export async function loadRuntimeProfileSnapshot(
  db: Queryable,
  input: { spaceId: string; agentId: string; profileId: string },
): Promise<RuntimeProfileSnapshot | null> {
  const result = await db.query<RuntimeProfileSnapshotRow>(
    `SELECT id, runtime_key, backend_mode, model_name, model_provider_id,
            runtime_config_json, runtime_policy_json
       FROM agent_runtime_profiles
      WHERE id = $1 AND space_id = $2 AND agent_id = $3
      FOR SHARE`,
    [input.profileId, input.spaceId, input.agentId],
  );
  const profile = result.rows[0];
  return profile ? projectRuntimeProfileSnapshot(profile) : null;
}

/** Apply the canonical protocol projection to current or historical Profile JSON. */
export function projectRuntimeProfileSnapshot<T extends RuntimeProfileSnapshot>(
  profile: T,
): T {
  return {
    ...profile,
    runtime_config_json: stripSecretFieldsFromRecord(profile.runtime_config_json),
    runtime_policy_json: stripSecretFieldsFromRecord(profile.runtime_policy_json),
  };
}

/** The same projection for the Run snapshot routing stamps before dispatch. */
export function projectRunRuntimeProfileSnapshot(
  profile: RunRuntimeProfileSnapshot,
): RunRuntimeProfileSnapshot {
  const projected = projectRuntimeProfileSnapshot(profile);
  return {
    ...projected,
    // The installation is also inside the adapter config, because that is what
    // a Run's `adapter_config` is built from — the execution-control snapshot,
    // the CLI continuity fingerprint and the usage record all read the copy
    // from there. The retired `credential_profile_id` was merged in exactly
    // here, and nothing replaced the merge when it went.
    runtime_config_json: projected.runtime_installation
      ? { ...projected.runtime_config_json, runtime_installation: projected.runtime_installation }
      : projected.runtime_config_json,
  };
}
