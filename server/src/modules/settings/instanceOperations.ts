import type {
  InstanceOperationsSettings,
  InstanceOperationsSettingsUpdate,
} from "@rainver/protocol";
import type { ServerConfig } from "../../config.js";
import { getDbPool } from "../../db/pool.js";
import {
  defineScopedSetting,
  ScopedSettingsStore,
  settingsRecord,
  type ScopedSettingsDescriptor,
} from "./scopedSettings.js";
import { SETTINGS_KEYS } from "./keys.js";

const INSTANCE_SCOPE_ID = "instance";

export interface InstanceOperationsPolicy {
  backup_interval_hours: number;
  backup_retention_count: number;
  backup_include_logs: boolean;
  backup_on_startup: boolean;
  content_access_log_retention_enabled: boolean;
  content_access_log_retention_days: number;
}

export function instanceOperationsDefaults(config: ServerConfig): InstanceOperationsPolicy {
  return {
    backup_interval_hours: config.backupIntervalHours,
    backup_retention_count: config.backupRetentionCount,
    backup_include_logs: config.backupIncludeLogs,
    backup_on_startup: config.backupOnStartup,
    content_access_log_retention_enabled: config.contentAccessLogRetentionEnabled,
    content_access_log_retention_days: config.contentAccessLogRetentionDays,
  };
}

function integerInRange(value: unknown, fallback: number, min: number, max: number): number {
  return typeof value === "number" && Number.isInteger(value) && value >= min && value <= max
    ? value
    : fallback;
}

function descriptor(config: ServerConfig): ScopedSettingsDescriptor<InstanceOperationsPolicy> {
  const defaults = instanceOperationsDefaults(config);
  return defineScopedSetting({
    key: SETTINGS_KEYS.instanceOperations,
    scopeType: "instance",
    defaults,
    parse(value: unknown) {
      const record = settingsRecord(value);
      return {
        backup_interval_hours: integerInRange(record.backup_interval_hours, defaults.backup_interval_hours, 1, 168),
        backup_retention_count: integerInRange(record.backup_retention_count, defaults.backup_retention_count, 1, 365),
        backup_include_logs: typeof record.backup_include_logs === "boolean" ? record.backup_include_logs : defaults.backup_include_logs,
        backup_on_startup: typeof record.backup_on_startup === "boolean" ? record.backup_on_startup : defaults.backup_on_startup,
        content_access_log_retention_enabled: typeof record.content_access_log_retention_enabled === "boolean"
          ? record.content_access_log_retention_enabled
          : defaults.content_access_log_retention_enabled,
        content_access_log_retention_days: integerInRange(
          record.content_access_log_retention_days,
          defaults.content_access_log_retention_days,
          1,
          3650,
        ),
      };
    },
  });
}

export class InstanceOperationsSettingsService {
  private readonly store: ScopedSettingsStore;

  constructor(private readonly config: ServerConfig) {
    if (!config.databaseUrl) throw new Error("Instance operations settings require a database");
    this.store = new ScopedSettingsStore(getDbPool(config.databaseUrl));
  }

  async get(): Promise<InstanceOperationsSettings> {
    const read = await this.store.get(descriptor(this.config), INSTANCE_SCOPE_ID);
    return {
      backup_service_enabled: this.config.backupEnabled,
      ...read.value,
      updated_at: read.row ? new Date(read.row.updated_at as string | Date).toISOString() : null,
    };
  }

  async update(userId: string, patch: InstanceOperationsSettingsUpdate): Promise<InstanceOperationsSettings> {
    const definition = descriptor(this.config);
    const current = await this.store.get(definition, INSTANCE_SCOPE_ID);
    const saved = await this.store.upsert(definition, INSTANCE_SCOPE_ID, {
      ...current.value,
      ...patch,
    }, { updatedByUserId: userId });
    return {
      backup_service_enabled: this.config.backupEnabled,
      ...saved.value,
      updated_at: new Date(saved.row!.updated_at as string | Date).toISOString(),
    };
  }
}

export async function readInstanceOperationsPolicy(config: ServerConfig): Promise<InstanceOperationsPolicy> {
  if (!config.databaseUrl) return instanceOperationsDefaults(config);
  const store = new ScopedSettingsStore(getDbPool(config.databaseUrl));
  return (await store.get(descriptor(config), INSTANCE_SCOPE_ID)).value;
}
