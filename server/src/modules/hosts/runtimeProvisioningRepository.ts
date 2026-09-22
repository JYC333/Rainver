import type { Queryable } from "../routeUtils/common.js";
import { withQueryableTransaction } from "../routeUtils/common.js";
import { recordHostRuntimeChange } from "./usageService.js";

export type RuntimeProvisioningState = "queued" | "installing" | "ready" | "failed";

export interface RuntimeProvisioningRecord {
  host_id: string;
  runtime_key: string;
  desired_version: string;
  state: RuntimeProvisioningState;
  installed_version: string | null;
  error: string | null;
  attempts: number;
  last_attempt_at: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * The message `failInterrupted` leaves behind. It is a placeholder, not a
 * diagnosis: the process that owned the claim may still be waiting on the
 * daemon, so `fail` is allowed to replace exactly this text with the real
 * error when the daemon finally answers.
 */
export const INTERRUPTED_INSTALL_ERROR =
  "The Server restarted during installation. Retry explicitly to continue.";

const COLUMNS = `host_id, runtime_key, desired_version, state,
  installed_version, error, attempts, last_attempt_at, created_at, updated_at`;

/** Durable state for the Server Host's desired runtime; audit history stays in host_runtime_changes. */
export class PgRuntimeProvisioningRepository {
  constructor(private readonly db: Queryable) {}

  async ensureDesired(hostId: string, runtimeKey: string, version: string): Promise<RuntimeProvisioningRecord> {
    const now = new Date().toISOString();
    const result = await this.db.query<RuntimeProvisioningRecord>(
      `INSERT INTO host_runtime_provisioning (
         host_id, runtime_key, desired_version, state, installed_version,
         error, attempts, last_attempt_at, created_at, updated_at
       ) VALUES ($1, $2, $3, 'queued', NULL, NULL, 0, NULL, $4, $4)
       ON CONFLICT (host_id, runtime_key) DO UPDATE SET
         desired_version = EXCLUDED.desired_version,
         state = CASE
           WHEN host_runtime_provisioning.desired_version <> EXCLUDED.desired_version THEN 'queued'
           ELSE host_runtime_provisioning.state
         END,
         error = CASE
           WHEN host_runtime_provisioning.desired_version <> EXCLUDED.desired_version THEN NULL
           ELSE host_runtime_provisioning.error
         END,
         attempts = CASE
           WHEN host_runtime_provisioning.desired_version <> EXCLUDED.desired_version THEN 0
           ELSE host_runtime_provisioning.attempts
         END,
         last_attempt_at = CASE
           WHEN host_runtime_provisioning.desired_version <> EXCLUDED.desired_version THEN NULL
           ELSE host_runtime_provisioning.last_attempt_at
         END,
         updated_at = CASE
           WHEN host_runtime_provisioning.desired_version <> EXCLUDED.desired_version THEN EXCLUDED.updated_at
           ELSE host_runtime_provisioning.updated_at
         END
       RETURNING ${COLUMNS}`,
      [hostId, runtimeKey, version, now],
    );
    const row = result.rows[0];
    if (!row) throw new Error("Runtime provisioning state was not returned");
    return row;
  }

  async get(hostId: string, runtimeKey: string): Promise<RuntimeProvisioningRecord | null> {
    const result = await this.db.query<RuntimeProvisioningRecord>(
      `SELECT ${COLUMNS} FROM host_runtime_provisioning
        WHERE host_id = $1 AND runtime_key = $2 LIMIT 1`,
      [hostId, runtimeKey],
    );
    return result.rows[0] ?? null;
  }

  /** Atomic claim: only one process can own a queued install at a time. */
  async claim(hostId: string, runtimeKey: string, version: string): Promise<RuntimeProvisioningRecord | null> {
    const now = new Date().toISOString();
    const result = await this.db.query<RuntimeProvisioningRecord>(
      `UPDATE host_runtime_provisioning
          SET state = 'installing', attempts = attempts + 1,
              last_attempt_at = $4, error = NULL, updated_at = $4
        WHERE host_id = $1 AND runtime_key = $2
          AND desired_version = $3 AND state = 'queued'
       RETURNING ${COLUMNS}`,
      [hostId, runtimeKey, version, now],
    );
    return result.rows[0] ?? null;
  }

  /**
   * Proof that the process holding this claim is still alive and still waiting
   * on the daemon. Without it `last_attempt_at` only records when the install
   * started, so a legitimately long install looks identical to one whose owner
   * died — and any other process would fail it out from under its owner.
   */
  async heartbeatInstall(hostId: string, runtimeKey: string, version: string): Promise<boolean> {
    const now = new Date().toISOString();
    const result = await this.db.query(
      `UPDATE host_runtime_provisioning
          SET last_attempt_at = $4, updated_at = $4
        WHERE host_id = $1 AND runtime_key = $2
          AND desired_version = $3 AND state = 'installing'`,
      [hostId, runtimeKey, version, now],
    );
    return (result.rowCount ?? 0) > 0;
  }

  async queueAfterOffline(hostId: string, runtimeKey: string, version: string): Promise<void> {
    await this.db.query(
      `UPDATE host_runtime_provisioning
          SET state = 'queued', error = NULL, updated_at = $4
        WHERE host_id = $1 AND runtime_key = $2
          AND desired_version = $3 AND state = 'installing'`,
      [hostId, runtimeKey, version, new Date().toISOString()],
    );
  }

  async queueForHealthCheck(hostId: string, runtimeKey: string, version: string): Promise<void> {
    await this.db.query(
      `UPDATE host_runtime_provisioning
          SET state = 'queued', error = NULL, updated_at = $4
        WHERE host_id = $1 AND runtime_key = $2
          AND desired_version = $3 AND state = 'ready'`,
      [hostId, runtimeKey, version, new Date().toISOString()],
    );
  }

  async rememberInstalledVersion(hostId: string, runtimeKey: string, version: string | null): Promise<void> {
    if (!version) return;
    await this.db.query(
      `UPDATE host_runtime_provisioning
          SET installed_version = $3, updated_at = $4
        WHERE host_id = $1 AND runtime_key = $2
          AND installed_version IS NULL AND state <> 'ready'`,
      [hostId, runtimeKey, version, new Date().toISOString()],
    );
  }

  /**
   * The real reason an install failed. It also replaces the interruption
   * placeholder, so a claim another process gave up on still ends with the
   * daemon's own error rather than a guess about a restart that never happened.
   * An explicit retry has already moved the row out of `failed`, so a genuinely
   * settled failure stays sticky.
   */
  async fail(hostId: string, runtimeKey: string, version: string, error: string): Promise<void> {
    await this.db.query(
      `UPDATE host_runtime_provisioning
          SET state = 'failed', error = $4, updated_at = $5
        WHERE host_id = $1 AND runtime_key = $2
          AND desired_version = $3
          AND (state = 'installing' OR (state = 'failed' AND error = $6))`,
      [hostId, runtimeKey, version, provisioningText(error), new Date().toISOString(), INTERRUPTED_INSTALL_ERROR],
    );
  }

  async failInterrupted(hostId: string, runtimeKey: string, version: string): Promise<void> {
    await this.fail(hostId, runtimeKey, version, INTERRUPTED_INSTALL_ERROR);
  }

  /** A lost server process can recover from the daemon's confirmed active copy without reinstalling it. */
  async complete(hostId: string, runtimeKey: string, version: string): Promise<void> {
    await withQueryableTransaction(this.db, async (tx) => {
      const now = new Date().toISOString();
      const locked = await tx.query<{ desired_version: string; installed_version: string | null }>(
        `SELECT desired_version, installed_version
           FROM host_runtime_provisioning
          WHERE host_id = $1 AND runtime_key = $2
          FOR UPDATE`,
        [hostId, runtimeKey],
      );
      const state = locked.rows[0];
      if (!state || state.desired_version !== version) return;
      const newlyActivated = state.installed_version !== version;
      await tx.query(
        `UPDATE host_runtime_provisioning
            SET state = 'ready', installed_version = $3,
                error = NULL, updated_at = $4
          WHERE host_id = $1 AND runtime_key = $2`,
        [hostId, runtimeKey, version, now],
      );
      await tx.query(
        `UPDATE agent_runtime_profiles
            SET runtime_installation = $3, updated_at = $4
          WHERE execution_host_id = $1 AND runtime_key = $2
            AND (runtime_installation = 'managed:pending'
              OR (is_default = true AND runtime_installation = $5::varchar))`,
        [hostId, runtimeKey, `managed:${version}`, now, state.installed_version ? `managed:${state.installed_version}` : null],
      );
      if (newlyActivated) {
        await recordHostRuntimeChange(tx, {
          hostId,
          runtimeKey,
          action: state.installed_version ? "upgrade" : "install",
          fromVersion: state.installed_version,
          toVersion: version,
          actorUserId: null,
        });
      }
    });
  }

  /** A failed automatic attempt is sticky until an explicit owner retry or a new release version. */
  async retry(hostId: string, runtimeKey: string, version: string): Promise<RuntimeProvisioningRecord | null> {
    const result = await this.db.query<RuntimeProvisioningRecord>(
      `UPDATE host_runtime_provisioning
          SET state = 'queued', error = NULL, updated_at = $4
        WHERE host_id = $1 AND runtime_key = $2
          AND desired_version = $3 AND state = 'failed'
       RETURNING ${COLUMNS}`,
      [hostId, runtimeKey, version, new Date().toISOString()],
    );
    return result.rows[0] ?? null;
  }
}

/**
 * One line of control-character-free text for a provisioning error, whether it
 * reaches the `error` column (1000 chars) or a log line. Installer output and
 * daemon errors arrive as multi-line terminal text; neither destination wants
 * it raw.
 */
export function provisioningText(value: unknown, maxChars = 1000): string {
  return (value instanceof Error ? value.message : String(value))
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxChars);
}
