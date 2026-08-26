import { describe, expect, it } from "vitest";
import { ScopedSettingsStore, defineScopedSetting, parseSpaceUserSettingsScopeId, settingsRecord, spaceUserSettingsScopeId } from "../src/modules/settings/scopedSettings.js";

interface DemoSettings {
  enabled: boolean;
  label: string | null;
}

const DEMO_SETTINGS = defineScopedSetting<DemoSettings>({
  key: "test.demo",
  scopeType: "space",
  defaults: { enabled: true, label: null },
  parse(value: unknown) {
    const record = settingsRecord(value);
    return {
      enabled: typeof record.enabled === "boolean" ? record.enabled : true,
      label: typeof record.label === "string" ? record.label : null,
    };
  },
});

class FakeSettingsDb {
  private readonly rows = new Map<string, Record<string, unknown>>();

  async query<Row = Record<string, unknown>>(
    sql: string,
    params: readonly unknown[] = [],
  ): Promise<{ rows: Row[]; rowCount: number | null }> {
    const norm = sql.replace(/\s+/g, " ").trim();
    if (norm.startsWith("SELECT")) {
      const row = norm.includes("WHERE id = $1")
        ? [...this.rows.values()].find(
            (item) =>
              item.id === params[0] &&
              item.scope_type === params[1] &&
              item.settings_key === params[2],
          )
        : this.rows.get(key(params[0], params[1], params[2]));
      return { rows: row ? [row as Row] : [], rowCount: row ? 1 : 0 };
    }
    if (norm.startsWith("INSERT INTO settings")) {
      const rowKey = key(params[1], params[2], params[3]);
      const existing = this.rows.get(rowKey);
      const next = existing && !norm.includes("RETURNING")
        ? existing
        : {
            id: existing?.id ?? params[0],
            scope_type: params[1],
            scope_id: params[2],
            settings_key: params[3],
            settings_json: JSON.parse(String(params[4] ?? "{}")),
            updated_by_user_id: params[5] ?? null,
            created_at: existing?.created_at ?? "2026-06-26T00:00:00.000Z",
            updated_at: "2026-06-26T00:01:00.000Z",
          };
      this.rows.set(rowKey, next);
      return norm.includes("RETURNING")
        ? { rows: [next as Row], rowCount: 1 }
        : { rows: [], rowCount: existing ? 0 : 1 };
    }
    return { rows: [], rowCount: 0 };
  }
}

describe("ScopedSettingsStore", () => {
  it("returns descriptor defaults without creating a row", async () => {
    const store = new ScopedSettingsStore(new FakeSettingsDb());

    const read = await store.get(DEMO_SETTINGS, "space-1");

    expect(read.row).toBeNull();
    expect(read.value).toEqual({ enabled: true, label: null });
  });

  it("creates defaults without overwriting an existing row", async () => {
    const store = new ScopedSettingsStore(new FakeSettingsDb());

    await store.upsert(DEMO_SETTINGS, "space-1", { enabled: false, label: "custom" });
    const read = await store.createIfMissing(DEMO_SETTINGS, "space-1", { enabled: true, label: null });

    expect(read.value).toEqual({ enabled: false, label: "custom" });
  });

  it("upserts normalized JSON and audit actor", async () => {
    const store = new ScopedSettingsStore(new FakeSettingsDb());

    const read = await store.upsert(
      DEMO_SETTINGS,
      "space-1",
      { enabled: false, label: "manual" },
      { updatedByUserId: "user-1" },
    );

    expect(read.row).toMatchObject({
      scope_type: "space",
      scope_id: "space-1",
      settings_key: "test.demo",
      settings_json: { enabled: false, label: "manual" },
      updated_by_user_id: "user-1",
    });
    expect(read.value).toEqual({ enabled: false, label: "manual" });
  });

  it("loads settings by row id within the descriptor scope", async () => {
    const store = new ScopedSettingsStore(new FakeSettingsDb());
    const written = await store.upsert(DEMO_SETTINGS, "space-1", {
      enabled: false,
      label: "manual",
    });

    const read = await store.getById(DEMO_SETTINGS, written.row!.id);

    expect(read?.row?.scope_id).toBe("space-1");
    expect(read?.value).toEqual({ enabled: false, label: "manual" });
  });

  it("encodes and parses space-user scope ids", () => {
    const scopeId = spaceUserSettingsScopeId("space-1", "user-1");

    expect(scopeId).toBe("space-1:user-1");
    expect(parseSpaceUserSettingsScopeId(scopeId)).toEqual({
      spaceId: "space-1",
      userId: "user-1",
    });
    expect(parseSpaceUserSettingsScopeId("space-1")).toBeNull();
  });
});

function key(scopeType: unknown, scopeId: unknown, settingsKey: unknown): string {
  return `${String(scopeType)}:${String(scopeId)}:${String(settingsKey)}`;
}
