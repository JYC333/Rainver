/**
 * Tests for the official optional modules (plugins) framework.
 *
 * Covers:
 *   - Registry: descriptor uniqueness, bundled legacy descriptors are disabled by default
 *   - Service: list, effective map, enable, disable, settings patch
 *   - Guards: disabled guard fails closed, enabled guard passes
 *   - Cross-space leakage prevention
 *   - DB integration tests through `useTestDatabase`
 */

import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { useTestDatabase } from "./support/testDatabase.js";
import { waitForLockWaiter } from "./support/lockWait.js";
import {
  listOfficialPlugins,
  getOfficialPlugin,
  assertPluginRegistryIntegrity,
  registerOperationDescriptors,
} from "../src/modules/plugins/registry.js";
import { pluginServiceFor } from "../src/modules/plugins/service.js";
import { pluginRepository } from "../src/modules/plugins/repository.js";
import { loadConfig } from "../src/config.js";
import { installOfficialPlugin } from "../src/modules/plugins/installer.js";
import { BUILT_IN_PLUGINS } from "../src/modules/plugins/builtInPlugins.js";
import type { OfficialPluginDescriptor } from "@rainver/protocol";

/**
 * A personal (user-scope) descriptor for the enablement service. Diary, the
 * bundled user-scope plugin, is an operation package now (Plan 7); the
 * service rules below do not depend on what the plugin does.
 */
const PROBE_ID = "personal_probe";
const probeDescriptor: OfficialPluginDescriptor = {
  id: PROBE_ID, name: "Personal probe", description: "User-scope enablement fixture", version: "1.0.0",
  category: "personal", default_enabled: false, default_visible: true, scope: "user", lifecycle_status: "available",
  frontend_entries: [], backend_feature_ids: [],
  permissions: { creates_activity: false, can_propose_memory: false, can_contribute_context: "never", uses_ai: false, uses_scheduler: false },
  settings_defaults: { daily_reminder_enabled: false, ai_reflection_enabled: false },
};
const serviceConfig = loadConfig({});
registerOperationDescriptors(serviceConfig, [probeDescriptor]);
const pluginService = pluginServiceFor(serviceConfig);

// ── Registry unit tests (no DB needed) ────────────────────────────────────────

describe("OfficialPluginRegistry", () => {
  it("has no duplicate plugin ids", () => {
    const ids = listOfficialPlugins().map((d) => d.id);
    const unique = new Set(ids);
    expect(unique.size).toBe(ids.length);
  });

  it("assertPluginRegistryIntegrity does not throw for valid registry", () => {
    expect(() => assertPluginRegistryIntegrity()).not.toThrow();
  });

  it("has no legacy descriptor left: every bundled package is an operation package (Plan 7)", () => {
    expect(listOfficialPlugins()).toEqual([]);
    expect(getOfficialPlugin("finance_ledger")).toBeUndefined();
  });

  it("no longer lists diary as a legacy descriptor (it is an operation package)", () => {
    expect(getOfficialPlugin("diary")).toBeUndefined();
  });

  it("all descriptors are serializable (no functions)", () => {
    for (const descriptor of listOfficialPlugins()) {
      expect(() => JSON.stringify(descriptor)).not.toThrow();
      const roundTripped = JSON.parse(JSON.stringify(descriptor));
      expect(roundTripped.id).toBe(descriptor.id);
    }
  });

  it("all descriptors have non-empty id and name", () => {
    for (const descriptor of listOfficialPlugins()) {
      expect(descriptor.id.trim()).toBeTruthy();
      expect(descriptor.name.trim()).toBeTruthy();
    }
  });

  it("returns undefined for unknown plugin id", () => {
    expect(getOfficialPlugin("nonexistent_plugin")).toBeUndefined();
  });

});

// ── DB integration tests ──────────────────────────────────────────────────────

const SCHEMA = `
CREATE TABLE official_plugin_enablements (
  id                  VARCHAR(36)   NOT NULL PRIMARY KEY,
  space_id            VARCHAR(36),
  user_id             VARCHAR(36),
  plugin_id           VARCHAR(128)  NOT NULL,
  enabled             BOOLEAN       NOT NULL,
  visible             BOOLEAN       NOT NULL DEFAULT TRUE,
  settings_json       JSONB         NOT NULL DEFAULT '{}'::JSONB,
  enabled_at          TIMESTAMPTZ,
  enabled_by_user_id  VARCHAR(36),
  disabled_at         TIMESTAMPTZ,
  disabled_by_user_id VARCHAR(36),
  created_at          TIMESTAMPTZ   NOT NULL,
  updated_at          TIMESTAMPTZ   NOT NULL,
  CONSTRAINT official_plugin_enablements_plugin_id_non_empty
    CHECK (plugin_id <> ''),
  CONSTRAINT official_plugin_enablements_settings_is_object
    CHECK (jsonb_typeof(settings_json) = 'object'),
  CONSTRAINT official_plugin_enablements_scope_check
    CHECK (
      (space_id IS NOT NULL AND user_id IS NULL) OR
      (space_id IS NULL AND user_id IS NOT NULL)
    )
);

CREATE UNIQUE INDEX official_plugin_enablements_space_unique
  ON official_plugin_enablements (plugin_id, space_id)
  WHERE (space_id IS NOT NULL AND user_id IS NULL);

CREATE UNIQUE INDEX official_plugin_enablements_user_unique
  ON official_plugin_enablements (plugin_id, user_id)
  WHERE (space_id IS NULL AND user_id IS NOT NULL);

CREATE INDEX official_plugin_enablements_space_idx
  ON official_plugin_enablements (space_id)
  WHERE (space_id IS NOT NULL);

CREATE TABLE official_plugin_events (
  id              VARCHAR(36)   NOT NULL PRIMARY KEY,
  space_id        VARCHAR(36),
  plugin_id       VARCHAR(128)  NOT NULL,
  event_type      VARCHAR(64)   NOT NULL,
  actor_user_id   VARCHAR(36),
  target_user_id  VARCHAR(36),
  metadata_json   JSONB         NOT NULL DEFAULT '{}'::JSONB,
  created_at      TIMESTAMPTZ   NOT NULL,
  CONSTRAINT official_plugin_events_plugin_id_non_empty
    CHECK (plugin_id <> ''),
  CONSTRAINT official_plugin_events_event_type_non_empty
    CHECK (event_type <> ''),
  CONSTRAINT official_plugin_events_metadata_is_object
    CHECK (jsonb_typeof(metadata_json) = 'object')
);

CREATE TABLE plugin_installs (
  id                   VARCHAR(36)  NOT NULL PRIMARY KEY,
  plugin_id            VARCHAR(64)  NOT NULL,
  installed_version    VARCHAR(32)  NOT NULL,
  status               VARCHAR(16)  NOT NULL DEFAULT 'active',
  source               VARCHAR(16)  NOT NULL DEFAULT 'official',
  installed_at         TIMESTAMPTZ  NOT NULL DEFAULT now(),
  installed_by_user_id VARCHAR(36),
  package_hash         TEXT,
  manifest_json        JSONB        NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT plugin_installs_plugin_id_unique UNIQUE (plugin_id),
  CONSTRAINT plugin_installs_status_valid CHECK (status IN ('active', 'disabled', 'removed'))
);

CREATE TABLE plugin_migrations (
  id               VARCHAR(36)  NOT NULL PRIMARY KEY,
  plugin_id        VARCHAR(64)  NOT NULL,
  plugin_version   VARCHAR(32)  NOT NULL,
  migration_id     VARCHAR(128) NOT NULL,
  checksum         TEXT,
  applied_at       TIMESTAMPTZ  NOT NULL DEFAULT now(),
  status           VARCHAR(16)  NOT NULL DEFAULT 'applied',
  error_message    TEXT,
  CONSTRAINT plugin_migrations_unique UNIQUE (plugin_id, migration_id),
  CONSTRAINT plugin_migrations_status_valid CHECK (status IN ('applied', 'failed'))
);
`;

interface DbQueryable {
  query<Row = Record<string, unknown>>(
    sql: string,
    params?: readonly unknown[],
  ): Promise<{ rows: Row[]; rowCount: number | null }>;
}

const testDb = useTestDatabase(import.meta.filename, { empty: true, max: 10 });
let db: DbQueryable;

const SPACE_A = "space-a-test";
const SPACE_B = "space-b-test";
const USER_1 = "user-1-test";
const USER_2 = "user-2-test";

beforeAll(async () => {
  if (!testDb.available) return;
  db = testDb.pool;
  await testDb.pool.query(SCHEMA);
});

beforeEach(async () => {
  await testDb.pool.query("DELETE FROM plugin_migrations");
  await testDb.pool.query("DELETE FROM plugin_installs");
  await testDb.pool.query("DELETE FROM official_plugin_events");
  await testDb.pool.query("DELETE FROM official_plugin_enablements");
});

/** The enablement service needs an installed row; the probe has no runtime package to install. */
async function installDiary(): Promise<void> {
  await pluginRepository.upsertInstall(db, { pluginId: PROBE_ID, installedVersion: "1.0.0", source: "official", actorUserId: USER_1, manifest: { id: PROBE_ID } });
}


describe("pluginService.listPlugins", () => {
  it("returns diary as disabled when no row exists", async () => {
    const items = await pluginService.listPlugins(db, SPACE_A, USER_1);
    const diary = items.find((i) => i.descriptor.id === PROBE_ID);
    expect(diary).toBeDefined();
    expect(diary!.effective.installed).toBe(false);
    expect(diary!.effective.enabled).toBe(false);
    expect(diary!.effective.has_row).toBe(false);
  });

  it("returns all descriptors", async () => {
    const items = await pluginService.listPlugins(db, SPACE_A, USER_1);
    const allIds = listOfficialPlugins().map((d) => d.id);
    for (const id of allIds) {
      expect(items.some((i) => i.descriptor.id === id)).toBe(true);
    }
  });
});

describe("legacy public-table installer", () => {
  it("refuses every bundled package: they are operation packages, installed offline", async () => {
    for (const plugin of BUILT_IN_PLUGINS) {
      await expect(installOfficialPlugin(db, plugin.id, BUILT_IN_PLUGINS, { actorUserId: USER_1, source: "official" }))
        .rejects.toMatchObject({ statusCode: 409 });
    }
    expect((await testDb.pool.query("SELECT count(*)::int AS n FROM plugin_installs")).rows[0].n).toBe(0);
  });
});

describe("pluginService.enablePlugin", () => {
  it("fails closed when the plugin is not installed", async () => {
    await expect(
      pluginService.enablePlugin(db, PROBE_ID, SPACE_A, USER_1, {}),
    ).rejects.toThrow("Plugin is not installed: personal_probe");
  });

  it("persists enablement state", async () => {
    await installDiary();
    const result = await pluginService.enablePlugin(
      db,
      PROBE_ID,
      SPACE_A,
      USER_1,
      {},
    );
    expect(result.effective.enabled).toBe(true);
    expect(result.effective.has_row).toBe(true);
  });

  it("can be re-read after enable", async () => {
    await installDiary();
    await pluginService.enablePlugin(db, PROBE_ID, SPACE_A, USER_1, {});
    const item = await pluginService.getPlugin(db, PROBE_ID, SPACE_A, USER_1);
    expect(item.effective.enabled).toBe(true);
  });

  it("stores initial settings merged with defaults", async () => {
    await installDiary();
    const result = await pluginService.enablePlugin(
      db,
      PROBE_ID,
      SPACE_A,
      USER_1,
      { settings: { daily_reminder_enabled: true } },
    );
    expect(result.effective.settings.daily_reminder_enabled).toBe(true);
    // Defaults still present
    expect(result.effective.settings.ai_reflection_enabled).toBe(false);
  });

  it("listPlugins uses the descriptor scope when duplicate-scope rows exist", async () => {
    await installDiary();
    await pluginService.enablePlugin(
      db,
      PROBE_ID,
      SPACE_A,
      USER_1,
      { settings: { daily_reminder_enabled: true } },
    );
    await testDb.pool.query(
      `INSERT INTO official_plugin_enablements
         (id, space_id, user_id, plugin_id, enabled, visible, settings_json, created_at, updated_at)
       VALUES ($1, $2, NULL, $3, false, true, '{}'::jsonb, now(), now())`,
      ["wrong-scope-row", SPACE_A, PROBE_ID],
    );

    const items = await pluginService.listPlugins(db, SPACE_A, USER_1);
    const diary = items.find((i) => i.descriptor.id === PROBE_ID);
    expect(diary?.effective.enabled).toBe(true);
    expect(diary?.effective.settings.daily_reminder_enabled).toBe(true);
  });
});

describe("pluginService.disablePlugin", () => {
  it("persists disabled state after enable", async () => {
    await installDiary();
    await pluginService.enablePlugin(db, PROBE_ID, SPACE_A, USER_1, {});
    const result = await pluginService.disablePlugin(
      db,
      PROBE_ID,
      SPACE_A,
      USER_1,
    );
    expect(result.effective.enabled).toBe(false);
    expect(result.effective.has_row).toBe(true);
  });

  it("does not delete data — row still exists after disable", async () => {
    await installDiary();
    await pluginService.enablePlugin(db, PROBE_ID, SPACE_A, USER_1, {});
    await pluginService.disablePlugin(db, PROBE_ID, SPACE_A, USER_1);
    const rows = await testDb.pool.query(
      "SELECT * FROM official_plugin_enablements WHERE plugin_id = $1",
      [PROBE_ID],
    );
    expect(rows.rowCount).toBeGreaterThan(0);
  });

  it("preserves settings when disabling without a settings body", async () => {
    await installDiary();
    await pluginService.enablePlugin(db, PROBE_ID, SPACE_A, USER_1, {
      settings: { daily_reminder_enabled: true },
    });
    const result = await pluginService.disablePlugin(
      db,
      PROBE_ID,
      SPACE_A,
      USER_1,
    );
    expect(result.effective.enabled).toBe(false);
    expect(result.effective.settings.daily_reminder_enabled).toBe(true);
  });
});

describe("pluginService.patchSettings", () => {
  it("patches settings_json", async () => {
    await installDiary();
    await pluginService.enablePlugin(db, PROBE_ID, SPACE_A, USER_1, {});
    const result = await pluginService.patchSettings(
      db,
      PROBE_ID,
      SPACE_A,
      USER_1,
      { daily_reminder_enabled: true, ai_reflection_enabled: true },
    );
    expect(result.effective.settings.daily_reminder_enabled).toBe(true);
    expect(result.effective.settings.ai_reflection_enabled).toBe(true);
  });

  it("creates row if not exists when patching settings", async () => {
    const result = await pluginService.patchSettings(
      db,
      PROBE_ID,
      SPACE_A,
      USER_1,
      { include_in_context: true },
    );
    expect(result.effective.settings.include_in_context).toBe(true);
    expect(result.effective.has_row).toBe(true);
  });

  it("records pre-configuring a plugin nobody toggled as a settings update, not a disable", async () => {
    await pluginService.patchSettings(db, PROBE_ID, SPACE_A, USER_1, { include_in_context: true });
    const row = await testDb.pool.query<{ enabled: boolean; disabled_at: string | null; disabled_by_user_id: string | null }>(
      "SELECT enabled, disabled_at, disabled_by_user_id FROM official_plugin_enablements WHERE plugin_id = $1",
      [PROBE_ID],
    );
    expect(row.rows).toEqual([{ enabled: false, disabled_at: null, disabled_by_user_id: null }]);
    const events = await testDb.pool.query<{ event_type: string }>(
      "SELECT event_type FROM official_plugin_events WHERE plugin_id = $1 ORDER BY created_at",
      [PROBE_ID],
    );
    expect(events.rows).toEqual([{ event_type: "settings_updated" }]);
  });

  it("keeps both keys when two settings patches overlap", async () => {
    await installDiary();
    await pluginService.enablePlugin(db, PROBE_ID, SPACE_A, USER_1, {});
    const first = await testDb.pool.connect();
    try {
      await first.query("BEGIN");
      await pluginService.patchSettings(first, PROBE_ID, SPACE_A, USER_1, { daily_reminder_enabled: true });
      let settled = false;
      const second = pluginService
        .patchSettings(db, PROBE_ID, SPACE_A, USER_1, { ai_reflection_enabled: true })
        .finally(() => { settled = true; });
      await waitForLockWaiter(testDb.pool, { settled: () => settled });
      await first.query("COMMIT");
      const result = await second;
      expect(result.effective.settings).toMatchObject({ daily_reminder_enabled: true, ai_reflection_enabled: true });
    } finally {
      await first.query("ROLLBACK").catch(() => undefined);
      first.release();
    }
  });
});

describe("pluginService first-write concurrency", () => {
  it("lets two first enables of the same scope both succeed", async () => {
    await installDiary();
    const first = await testDb.pool.connect();
    try {
      await first.query("BEGIN");
      await pluginService.enablePlugin(first, PROBE_ID, SPACE_A, USER_1, {});
      let settled = false;
      const second = pluginService
        .enablePlugin(db, PROBE_ID, SPACE_A, USER_1, {})
        .finally(() => { settled = true; });
      await waitForLockWaiter(testDb.pool, { settled: () => settled });
      await first.query("COMMIT");
      await expect(second).resolves.toMatchObject({ effective: { enabled: true } });
    } finally {
      await first.query("ROLLBACK").catch(() => undefined);
      first.release();
    }
    const rows = await testDb.pool.query("SELECT 1 FROM official_plugin_enablements WHERE plugin_id = $1", [PROBE_ID]);
    expect(rows.rowCount).toBe(1);
  });
});

describe("pluginService.isEnabled (guard helper)", () => {
  it("returns enabled=false for unknown plugin", async () => {
    const result = await pluginService.isEnabled(db, "nonexistent", SPACE_A, USER_1);
    expect(result.exists).toBe(false);
    expect(result.installed).toBe(false);
    expect(result.enabled).toBe(false);
  });

  it("returns enabled=false for a personal plugin before any row", async () => {
    const result = await pluginService.isEnabled(
      db,
      PROBE_ID,
      SPACE_A,
      USER_1,
    );
    expect(result.exists).toBe(true);
    expect(result.installed).toBe(false);
    expect(result.enabled).toBe(false);
  });

  it("returns enabled=true after enabling", async () => {
    await installDiary();
    await pluginService.enablePlugin(db, PROBE_ID, SPACE_A, USER_1, {});
    const result = await pluginService.isEnabled(
      db,
      PROBE_ID,
      SPACE_A,
      USER_1,
    );
    expect(result.exists).toBe(true);
    expect(result.installed).toBe(true);
    expect(result.enabled).toBe(true);
  });

  it("returns enabled=false after disabling", async () => {
    await installDiary();
    await pluginService.enablePlugin(db, PROBE_ID, SPACE_A, USER_1, {});
    await pluginService.disablePlugin(db, PROBE_ID, SPACE_A, USER_1);
    const result = await pluginService.isEnabled(
      db,
      PROBE_ID,
      SPACE_A,
      USER_1,
    );
    expect(result.exists).toBe(true);
    expect(result.enabled).toBe(false);
  });
});

describe("user-scope cross-space behaviour", () => {
  it("enabling (user-scope) is visible from any space for the same user", async () => {
    await installDiary();
    await pluginService.enablePlugin(db, PROBE_ID, SPACE_A, USER_1, {});
    // user-scope: enabled for USER_1 regardless of which space we check from
    const resultB = await pluginService.isEnabled(
      db,
      PROBE_ID,
      SPACE_B,
      USER_1,
    );
    expect(resultB.enabled).toBe(true);
  });

  it("enabling for user 1 does not affect user 2", async () => {
    await installDiary();
    await pluginService.enablePlugin(db, PROBE_ID, SPACE_A, USER_1, {});
    const result2 = await pluginService.isEnabled(
      db,
      PROBE_ID,
      SPACE_A,
      USER_2,
    );
    expect(result2.enabled).toBe(false);
  });

  it("getEffectiveMap reflects user-scope enablement across spaces", async () => {
    await installDiary();
    await pluginService.enablePlugin(db, PROBE_ID, SPACE_A, USER_1, {});
    // same user, different space context — should see enabled because it's user-scoped
    const mapB = await pluginService.getEffectiveMap(db, SPACE_B, USER_1);
    expect(mapB[PROBE_ID]?.enabled).toBe(true);
  });

  it("getEffectiveMap returns disabled for a different user", async () => {
    await installDiary();
    await pluginService.enablePlugin(db, PROBE_ID, SPACE_A, USER_1, {});
    const mapUser2 = await pluginService.getEffectiveMap(db, SPACE_A, USER_2);
    expect(mapUser2[PROBE_ID]?.enabled).toBe(false);
  });
});

describe("plugin events audit log", () => {
  it("inserts an enabled event when enabling", async () => {
    await installDiary();
    await pluginService.enablePlugin(db, PROBE_ID, SPACE_A, USER_1, {});
    const result = await testDb.pool.query(
      "SELECT * FROM official_plugin_events WHERE plugin_id = $1 AND event_type = 'enabled'",
      [PROBE_ID],
    );
    expect(result.rowCount).toBeGreaterThan(0);
  });

  it("inserts a disabled event when disabling", async () => {
    await installDiary();
    await pluginService.enablePlugin(db, PROBE_ID, SPACE_A, USER_1, {});
    await pluginService.disablePlugin(db, PROBE_ID, SPACE_A, USER_1);
    const result = await testDb.pool.query(
      "SELECT * FROM official_plugin_events WHERE plugin_id = $1 AND event_type = 'disabled'",
      [PROBE_ID],
    );
    expect(result.rowCount).toBeGreaterThan(0);
  });

  it("inserts a settings_updated event when patching settings", async () => {
    await installDiary();
    await pluginService.enablePlugin(db, PROBE_ID, SPACE_A, USER_1, {});
    await pluginService.patchSettings(db, PROBE_ID, SPACE_A, USER_1, {
      daily_reminder_enabled: true,
    });
    const result = await testDb.pool.query(
      "SELECT * FROM official_plugin_events WHERE plugin_id = $1 AND event_type = 'settings_updated'",
      [PROBE_ID],
    );
    expect(result.rowCount).toBeGreaterThan(0);
  });
});
