import type {
  HostEgressTransport,
  InstanceOperationsSettings,
  InstanceOperationsSettingsUpdate,
  ManagedHostEgressMode,
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
import { HttpError } from "../routeUtils/common.js";

const INSTANCE_SCOPE_ID = "instance";

export interface InstanceOperationsPolicy {
  backup_interval_hours: number;
  backup_retention_count: number;
  backup_include_logs: boolean;
  backup_on_startup: boolean;
  content_access_log_retention_enabled: boolean;
  content_access_log_retention_days: number;
  managed_host_egress_mode: ManagedHostEgressMode;
  managed_host_proxy_url: string | null;
  managed_host_no_proxy: string | null;
}

export function instanceOperationsDefaults(config: ServerConfig): InstanceOperationsPolicy {
  return {
    backup_interval_hours: config.backupIntervalHours,
    backup_retention_count: config.backupRetentionCount,
    backup_include_logs: config.backupIncludeLogs,
    backup_on_startup: config.backupOnStartup,
    content_access_log_retention_enabled: config.contentAccessLogRetentionEnabled,
    content_access_log_retention_days: config.contentAccessLogRetentionDays,
    managed_host_egress_mode: "direct",
    managed_host_proxy_url: null,
    managed_host_no_proxy: null,
  };
}

function nullableTrimmed(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function validProxyUrl(value: unknown): string | null {
  const raw = nullableTrimmed(value);
  if (!raw) return null;
  try {
    const url = new URL(raw);
    if ((url.protocol !== "http:" && url.protocol !== "https:")
      || !url.hostname || url.pathname !== "/" || url.search || url.hash
      || url.username || url.password) return null;
    return url.toString().replace(/\/$/, "");
  } catch {
    return null;
  }
}

function normalizeManagedHostEgress(
  value: Pick<InstanceOperationsPolicy, "managed_host_egress_mode" | "managed_host_proxy_url" | "managed_host_no_proxy">,
  strict: boolean,
): Pick<InstanceOperationsPolicy, "managed_host_egress_mode" | "managed_host_proxy_url" | "managed_host_no_proxy"> {
  const mode = value.managed_host_egress_mode;
  if (mode !== "http_proxy") {
    return { managed_host_egress_mode: mode, managed_host_proxy_url: null, managed_host_no_proxy: null };
  }
  const proxyUrl = validProxyUrl(value.managed_host_proxy_url);
  if (!proxyUrl) {
    if (strict) {
      throw new HttpError(422, "HTTP proxy mode requires an http:// or https:// proxy URL without credentials, path, query, or fragment");
    }
    return { managed_host_egress_mode: "direct", managed_host_proxy_url: null, managed_host_no_proxy: null };
  }
  return {
    managed_host_egress_mode: mode,
    managed_host_proxy_url: proxyUrl,
    managed_host_no_proxy: nullableTrimmed(value.managed_host_no_proxy),
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
      const parsed: InstanceOperationsPolicy = {
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
        managed_host_egress_mode: record.managed_host_egress_mode === "system_tun" || record.managed_host_egress_mode === "http_proxy"
          ? record.managed_host_egress_mode
          : "direct",
        managed_host_proxy_url: nullableTrimmed(record.managed_host_proxy_url),
        managed_host_no_proxy: nullableTrimmed(record.managed_host_no_proxy),
      };
      return { ...parsed, ...normalizeManagedHostEgress(parsed, false) };
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
    const merged: InstanceOperationsPolicy = {
      ...current.value,
      ...patch,
    };
    const saved = await this.store.upsert(definition, INSTANCE_SCOPE_ID, {
      ...merged,
      ...normalizeManagedHostEgress(merged, true),
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

export function managedHostEgressTransport(policy: InstanceOperationsPolicy): HostEgressTransport {
  if (policy.managed_host_egress_mode === "system_tun") return { mode: "system_tun" };
  if (policy.managed_host_egress_mode === "http_proxy" && policy.managed_host_proxy_url) {
    return {
      mode: "http_proxy",
      proxy_url: policy.managed_host_proxy_url,
      no_proxy: policy.managed_host_no_proxy,
    };
  }
  return { mode: "direct" };
}
