import { randomUUID } from "node:crypto";
import type { Queryable } from "../routeUtils/common.js";

export interface PluginEnablementRow {
  id: string;
  space_id: string | null;  // null = user-scope
  user_id: string | null;   // null = space-scope
  plugin_id: string;
  enabled: boolean;
  visible: boolean;
  settings_json: Record<string, unknown>;
  enabled_at: Date | null;
  enabled_by_user_id: string | null;
  disabled_at: Date | null;
  disabled_by_user_id: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface PluginInstallRow {
  id: string;
  plugin_id: string;
  installed_version: string;
  status: "active" | "disabled" | "removed";
  source: "built_in" | "official" | "local";
  installed_at: Date;
  installed_by_user_id: string | null;
  package_hash: string | null;
  manifest_json: Record<string, unknown>;
}

interface PluginMigrationRow {
  id: string;
  plugin_id: string;
  plugin_version: string;
  migration_id: string;
  checksum: string | null;
  applied_at: Date;
  status: "applied" | "failed";
  error_message: string | null;
}

interface UpsertEnablementInput {
  spaceId: string | null;  // null = user-scope
  userId: string | null;   // null = space-scope
  pluginId: string;
  enabled: boolean;
  visible?: boolean;
  settings?: Record<string, unknown>;
  actorUserId: string;
}

interface PatchSettingsInput {
  spaceId: string | null;
  userId: string | null;
  pluginId: string;
  settings: Record<string, unknown>;
  /** The enabled state a row created by this patch starts in (the plugin's default). */
  defaultEnabled: boolean;
  actorUserId: string;
}

/**
 * The conflict target for the scope's partial unique index, so an INSERT that
 * races another first write of the same scope updates that row instead of
 * failing on the index.
 */
function scopeConflictTarget(spaceId: string | null): string {
  return spaceId != null
    ? "ON CONFLICT (plugin_id, space_id) WHERE space_id IS NOT NULL AND user_id IS NULL"
    : "ON CONFLICT (plugin_id, user_id) WHERE space_id IS NULL AND user_id IS NOT NULL";
}

interface UpsertInstallInput {
  pluginId: string;
  installedVersion: string;
  source: PluginInstallRow["source"];
  actorUserId: string | null;
  manifest?: Record<string, unknown>;
}

/** DB-backed repository for official_plugin_enablements. */
export const pluginRepository = {
  async findInstall(db: Queryable, pluginId: string): Promise<PluginInstallRow | null> {
    const result = await db.query<PluginInstallRow>(
      `SELECT * FROM plugin_installs WHERE plugin_id = $1 LIMIT 1`,
      [pluginId],
    );
    return result.rows[0] ?? null;
  },

  async findAllInstalls(db: Queryable): Promise<PluginInstallRow[]> {
    const result = await db.query<PluginInstallRow>(
      `SELECT * FROM plugin_installs ORDER BY plugin_id`,
    );
    return result.rows;
  },

  async upsertInstall(db: Queryable, input: UpsertInstallInput): Promise<PluginInstallRow> {
    const result = await db.query<PluginInstallRow>(
      `INSERT INTO plugin_installs
         (id, plugin_id, installed_version, status, source, installed_by_user_id, manifest_json)
       VALUES ($1, $2, $3, 'active', $4, $5, $6::jsonb)
       ON CONFLICT (plugin_id) DO UPDATE
         SET installed_version = EXCLUDED.installed_version,
             status = 'active',
             source = EXCLUDED.source,
             installed_by_user_id = EXCLUDED.installed_by_user_id,
             manifest_json = EXCLUDED.manifest_json
       RETURNING *`,
      [
        randomUUID(),
        input.pluginId,
        input.installedVersion,
        input.source,
        input.actorUserId,
        JSON.stringify(input.manifest ?? {}),
      ],
    );
    return result.rows[0]!;
  },

  async findMigration(
    db: Queryable,
    pluginId: string,
    migrationId: string,
  ): Promise<PluginMigrationRow | null> {
    const result = await db.query<PluginMigrationRow>(
      `SELECT * FROM plugin_migrations
        WHERE plugin_id = $1 AND migration_id = $2
        LIMIT 1`,
      [pluginId, migrationId],
    );
    return result.rows[0] ?? null;
  },

  async insertAppliedMigration(
    db: Queryable,
    input: {
      pluginId: string;
      pluginVersion: string;
      migrationId: string;
      checksum: string | null;
    },
  ): Promise<PluginMigrationRow> {
    const result = await db.query<PluginMigrationRow>(
      `INSERT INTO plugin_migrations
         (id, plugin_id, plugin_version, migration_id, checksum, status)
       VALUES ($1, $2, $3, $4, $5, 'applied')
       RETURNING *`,
      [
        randomUUID(),
        input.pluginId,
        input.pluginVersion,
        input.migrationId,
        input.checksum,
      ],
    );
    return result.rows[0]!;
  },

  async findEnablement(
    db: Queryable,
    pluginId: string,
    spaceId: string | null,
    userId: string | null,
  ): Promise<PluginEnablementRow | null> {
    let sql: string;
    let params: unknown[];

    if (spaceId != null) {
      // space scope: keyed by (plugin_id, space_id), user_id IS NULL
      sql = `SELECT * FROM official_plugin_enablements
             WHERE plugin_id = $1 AND space_id = $2 AND user_id IS NULL
             LIMIT 1`;
      params = [pluginId, spaceId];
    } else if (userId != null) {
      // user scope: keyed by (plugin_id, user_id), space_id IS NULL
      sql = `SELECT * FROM official_plugin_enablements
             WHERE plugin_id = $1 AND space_id IS NULL AND user_id = $2
             LIMIT 1`;
      params = [pluginId, userId];
    } else {
      return null;
    }

    const result = await db.query<PluginEnablementRow>(sql, params);
    return result.rows[0] ?? null;
  },

  /** Fetch all relevant rows for a given space+user context.
   * Returns space-scope rows for the space AND user-scope rows for the user. */
  async findAllForContext(
    db: Queryable,
    spaceId: string,
    userId: string,
  ): Promise<PluginEnablementRow[]> {
    const sql = `
      SELECT * FROM official_plugin_enablements
      WHERE (space_id = $1 AND user_id IS NULL)
         OR (space_id IS NULL AND user_id = $2)
      ORDER BY plugin_id`;
    const result = await db.query<PluginEnablementRow>(sql, [spaceId, userId]);
    return result.rows;
  },

  async upsertEnablement(
    db: Queryable,
    input: UpsertEnablementInput,
  ): Promise<PluginEnablementRow> {
    const now = new Date().toISOString();
    const enabledAt = input.enabled ? now : null;
    const disabledAt = input.enabled ? null : now;
    const enabledBy = input.enabled ? input.actorUserId : null;
    const disabledBy = input.enabled ? null : input.actorUserId;
    const settings = input.settings === undefined ? null : JSON.stringify(input.settings);
    const visible = input.visible ?? null;

    // One statement for create and update: a SELECT-then-INSERT let two first
    // writes of the same scope both miss the row and the loser fail on the
    // unique index. On conflict the existing row keeps whatever this write
    // does not set (visibility, settings, the other state's timestamps).
    const result = await db.query<PluginEnablementRow>(
      `INSERT INTO official_plugin_enablements
         (id, space_id, user_id, plugin_id, enabled, visible, settings_json,
          enabled_at, enabled_by_user_id, disabled_at, disabled_by_user_id,
          created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, COALESCE($6, true), COALESCE($7::jsonb, '{}'::jsonb),
               $8::timestamptz, $9, $10::timestamptz, $11,
               $12::timestamptz, $12::timestamptz)
       ${scopeConflictTarget(input.spaceId)} DO UPDATE
       SET enabled = EXCLUDED.enabled,
           visible = COALESCE($6, official_plugin_enablements.visible),
           settings_json = COALESCE($7::jsonb, official_plugin_enablements.settings_json),
           enabled_at = CASE WHEN EXCLUDED.enabled THEN EXCLUDED.enabled_at
                             ELSE official_plugin_enablements.enabled_at END,
           enabled_by_user_id = CASE WHEN EXCLUDED.enabled THEN EXCLUDED.enabled_by_user_id
                                     ELSE official_plugin_enablements.enabled_by_user_id END,
           disabled_at = CASE WHEN NOT EXCLUDED.enabled THEN EXCLUDED.disabled_at
                              ELSE official_plugin_enablements.disabled_at END,
           disabled_by_user_id = CASE WHEN NOT EXCLUDED.enabled THEN EXCLUDED.disabled_by_user_id
                                      ELSE official_plugin_enablements.disabled_by_user_id END,
           updated_at = EXCLUDED.updated_at
       RETURNING *`,
      [
        randomUUID(),
        input.spaceId,
        input.userId,
        input.pluginId,
        input.enabled,
        visible,
        settings,
        enabledAt,
        enabledBy,
        disabledAt,
        disabledBy,
        now,
      ],
    );
    await this.insertEvent(db, {
      spaceId: input.spaceId,
      pluginId: input.pluginId,
      eventType: input.enabled ? "enabled" : "disabled",
      actorUserId: input.actorUserId,
      targetUserId: input.userId,
    });
    return result.rows[0]!;
  },

  /**
   * Merges `settings` into the scope's row, creating the row in the plugin's
   * default enabled state when there is none yet (settings may be configured
   * before a plugin is enabled). The merge happens in SQL so two concurrent
   * patches of different keys both land; a row this patch creates carries no
   * enabled/disabled stamps, since nobody toggled it.
   */
  async patchSettings(
    db: Queryable,
    input: PatchSettingsInput,
  ): Promise<PluginEnablementRow> {
    const now = new Date().toISOString();
    const result = await db.query<PluginEnablementRow>(
      `INSERT INTO official_plugin_enablements
         (id, space_id, user_id, plugin_id, enabled, visible, settings_json, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, true, $6::jsonb, $7::timestamptz, $7::timestamptz)
       ${scopeConflictTarget(input.spaceId)} DO UPDATE
       SET settings_json = official_plugin_enablements.settings_json || EXCLUDED.settings_json,
           updated_at = EXCLUDED.updated_at
       RETURNING *`,
      [
        randomUUID(),
        input.spaceId,
        input.userId,
        input.pluginId,
        input.defaultEnabled,
        JSON.stringify(input.settings),
        now,
      ],
    );
    await this.insertEvent(db, {
      spaceId: input.spaceId,
      pluginId: input.pluginId,
      eventType: "settings_updated",
      actorUserId: input.actorUserId,
      targetUserId: input.userId,
      metadata: { keys_patched: Object.keys(input.settings) },
    });
    return result.rows[0]!;
  },

  async insertEvent(
    db: Queryable,
    opts: {
      spaceId: string | null;
      pluginId: string;
      eventType: string;
      actorUserId: string | null;
      targetUserId?: string | null;
      metadata?: Record<string, unknown>;
    },
  ): Promise<void> {
    const id = randomUUID();
    const now = new Date().toISOString();
    await db.query(
      `INSERT INTO official_plugin_events
         (id, space_id, plugin_id, event_type, actor_user_id, target_user_id, metadata_json, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::timestamptz)`,
      [
        id,
        opts.spaceId ?? null,
        opts.pluginId,
        opts.eventType,
        opts.actorUserId ?? null,
        opts.targetUserId ?? null,
        JSON.stringify(opts.metadata ?? {}),
        now,
      ],
    );
  },
};
