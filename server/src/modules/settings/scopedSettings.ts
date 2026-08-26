import { randomUUID } from "node:crypto";
import type { Queryable } from "../routeUtils/common.js";

export type ScopedSettingsScopeType = "instance" | "space" | "user" | "space_user";

export interface ScopedSettingsDescriptor<TValue extends object> {
  key: string;
  scopeType: ScopedSettingsScopeType;
  defaults: TValue;
  parse(value: unknown): TValue;
  serialize?(value: TValue): Record<string, unknown>;
}

export interface ScopedSettingsRow {
  id: string;
  scope_type: ScopedSettingsScopeType;
  scope_id: string;
  settings_key: string;
  settings_json: Record<string, unknown>;
  updated_by_user_id: string | null;
  created_at: unknown;
  updated_at: unknown;
}

export interface ScopedSettingsRead<TValue extends object> {
  row: ScopedSettingsRow | null;
  value: TValue;
}

export interface ScopedSettingsWriteOptions {
  updatedByUserId?: string | null;
}

const SETTINGS_COLUMNS = `
  id, scope_type, scope_id, settings_key, settings_json, updated_by_user_id, created_at, updated_at
`;
const SPACE_USER_SCOPE_SEPARATOR = ":";

export class ScopedSettingsStore {
  constructor(private readonly db: Queryable) {}

  async get<TValue extends object>(
    descriptor: ScopedSettingsDescriptor<TValue>,
    scopeId: string,
  ): Promise<ScopedSettingsRead<TValue>> {
    const row = await this.getRaw(descriptor.scopeType, scopeId, descriptor.key);
    return {
      row,
      value: descriptor.parse(row?.settings_json ?? descriptor.defaults),
    };
  }

  async getOrCreate<TValue extends object>(
    descriptor: ScopedSettingsDescriptor<TValue>,
    scopeId: string,
    options: ScopedSettingsWriteOptions = {},
  ): Promise<ScopedSettingsRead<TValue>> {
    return this.createIfMissing(descriptor, scopeId, descriptor.defaults, options);
  }

  async createIfMissing<TValue extends object>(
    descriptor: ScopedSettingsDescriptor<TValue>,
    scopeId: string,
    value: TValue,
    options: ScopedSettingsWriteOptions = {},
  ): Promise<ScopedSettingsRead<TValue>> {
    const defaults = this.normalizeAndSerialize(descriptor, value);
    await this.db.query(
      `INSERT INTO settings (
         id, scope_type, scope_id, settings_key, settings_json, updated_by_user_id, created_at, updated_at
       ) VALUES ($1, $2, $3, $4, $5::jsonb, $6, now(), now())
       ON CONFLICT (scope_type, scope_id, settings_key) DO NOTHING`,
      [
        randomUUID(),
        descriptor.scopeType,
        scopeId,
        descriptor.key,
        JSON.stringify(defaults),
        options.updatedByUserId ?? null,
      ],
    );
    return this.get(descriptor, scopeId);
  }

  async upsert<TValue extends object>(
    descriptor: ScopedSettingsDescriptor<TValue>,
    scopeId: string,
    value: TValue,
    options: ScopedSettingsWriteOptions = {},
  ): Promise<ScopedSettingsRead<TValue>> {
    const stored = this.normalizeAndSerialize(descriptor, value);
    const result = await this.db.query<ScopedSettingsRow>(
      `INSERT INTO settings (
         id, scope_type, scope_id, settings_key, settings_json, updated_by_user_id, created_at, updated_at
       ) VALUES ($1, $2, $3, $4, $5::jsonb, $6, now(), now())
       ON CONFLICT (scope_type, scope_id, settings_key)
       DO UPDATE SET
         settings_json = EXCLUDED.settings_json,
         updated_by_user_id = EXCLUDED.updated_by_user_id,
         updated_at = EXCLUDED.updated_at
       RETURNING ${SETTINGS_COLUMNS}`,
      [
        randomUUID(),
        descriptor.scopeType,
        scopeId,
        descriptor.key,
        JSON.stringify(stored),
        options.updatedByUserId ?? null,
      ],
    );
    const row = normalizeSettingsRow(result.rows[0]!);
    return {
      row,
      value: descriptor.parse(row.settings_json),
    };
  }

  async update<TValue extends object>(
    descriptor: ScopedSettingsDescriptor<TValue>,
    scopeId: string,
    updater: (current: TValue) => TValue | Promise<TValue>,
    options: ScopedSettingsWriteOptions = {},
  ): Promise<ScopedSettingsRead<TValue>> {
    const current = await this.getOrCreate(descriptor, scopeId);
    return this.upsert(descriptor, scopeId, await updater(current.value), options);
  }

  async getById<TValue extends object>(
    descriptor: ScopedSettingsDescriptor<TValue>,
    id: string,
  ): Promise<ScopedSettingsRead<TValue> | null> {
    const result = await this.db.query<ScopedSettingsRow>(
      `SELECT ${SETTINGS_COLUMNS}
         FROM settings
        WHERE id = $1 AND scope_type = $2 AND settings_key = $3
        LIMIT 1`,
      [id, descriptor.scopeType, descriptor.key],
    );
    const row = result.rows[0] ? normalizeSettingsRow(result.rows[0]) : null;
    return row
      ? {
          row,
          value: descriptor.parse(row.settings_json),
        }
      : null;
  }

  async getRaw(
    scopeType: ScopedSettingsScopeType,
    scopeId: string,
    settingsKey: string,
  ): Promise<ScopedSettingsRow | null> {
    const result = await this.db.query<ScopedSettingsRow>(
      `SELECT ${SETTINGS_COLUMNS}
         FROM settings
        WHERE scope_type = $1 AND scope_id = $2 AND settings_key = $3
        LIMIT 1`,
      [scopeType, scopeId, settingsKey],
    );
    return result.rows[0] ? normalizeSettingsRow(result.rows[0]) : null;
  }

  private serialize<TValue extends object>(
    descriptor: ScopedSettingsDescriptor<TValue>,
    value: TValue,
  ): Record<string, unknown> {
    return assertRecord(descriptor.serialize ? descriptor.serialize(value) : value);
  }

  private normalizeAndSerialize<TValue extends object>(
    descriptor: ScopedSettingsDescriptor<TValue>,
    value: TValue,
  ): Record<string, unknown> {
    const stored = this.serialize(descriptor, value);
    return this.serialize(descriptor, descriptor.parse(stored));
  }
}

export function defineScopedSetting<TValue extends object>(
  descriptor: ScopedSettingsDescriptor<TValue>,
): ScopedSettingsDescriptor<TValue> {
  return descriptor;
}

export function settingsRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

export function spaceUserSettingsScopeId(spaceId: string, userId: string): string {
  if (!spaceId || spaceId.includes(SPACE_USER_SCOPE_SEPARATOR)) {
    throw new Error("space_user settings scope requires a non-empty space id without ':'");
  }
  if (!userId || userId.includes(SPACE_USER_SCOPE_SEPARATOR)) {
    throw new Error("space_user settings scope requires a non-empty user id without ':'");
  }
  return `${spaceId}${SPACE_USER_SCOPE_SEPARATOR}${userId}`;
}

export function parseSpaceUserSettingsScopeId(
  scopeId: string,
): { spaceId: string; userId: string } | null {
  const parts = scopeId.split(SPACE_USER_SCOPE_SEPARATOR);
  if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
  return { spaceId: parts[0], userId: parts[1] };
}

function normalizeSettingsRow(row: ScopedSettingsRow): ScopedSettingsRow {
  return {
    ...row,
    settings_json: settingsRecord(row.settings_json),
  };
}

function assertRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Scoped settings serializers must return a JSON object");
  }
  return value as Record<string, unknown>;
}
