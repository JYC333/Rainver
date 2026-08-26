import { HttpError, type Queryable } from "../routeUtils/common.js";
import {
  ScopedSettingsStore,
  SETTINGS_KEYS,
  defineScopedSetting,
  parseSpaceUserSettingsScopeId,
  settingsRecord,
  spaceUserSettingsScopeId,
  type ScopedSettingsRead,
} from "../settings/index.js";
import { PgSchedulerTaskStore, type SchedulerTaskRow } from "../scheduler/taskStore.js";

export interface DailyReportSettingRow {
  id: string;
  space_id: string;
  user_id: string;
  enabled: boolean;
  local_time: string;
  timezone: string;
  include_source_types_json: unknown;
  create_experience_proposals: boolean;
  create_memory_proposals: boolean;
  experience_confidence_threshold: number;
  memory_confidence_threshold: number;
  max_experience_proposals_per_day: number;
  max_memory_proposals_per_day: number;
  last_report_date: string | null;
  next_run_at: string | null;
  created_at: string;
  updated_at: string;
}

interface DailyReportSettingsValue {
  enabled: boolean;
  local_time: string;
  timezone: string;
  include_source_types: string[];
  create_experience_proposals: boolean;
  create_memory_proposals: boolean;
  experience_confidence_threshold: number;
  memory_confidence_threshold: number;
  max_experience_proposals_per_day: number;
  max_memory_proposals_per_day: number;
}

const VALID_SOURCE_TYPES = new Set(["user_capture"]);
export const DAILY_CAPTURE_REPORT_SETTINGS_KEY = SETTINGS_KEYS.dailyCaptureReport;
const DAILY_REPORT_SCHEDULER_TASK_TYPE = "daily_capture_report";

const DEFAULT_DAILY_REPORT_SETTINGS: DailyReportSettingsValue = {
  enabled: false,
  local_time: "09:00",
  timezone: "UTC",
  include_source_types: ["user_capture"],
  create_experience_proposals: true,
  create_memory_proposals: true,
  experience_confidence_threshold: 0.6,
  memory_confidence_threshold: 0.7,
  max_experience_proposals_per_day: 5,
  max_memory_proposals_per_day: 3,
};

const DAILY_CAPTURE_REPORT_SETTINGS_DEFINITION = defineScopedSetting<DailyReportSettingsValue>({
  key: DAILY_CAPTURE_REPORT_SETTINGS_KEY,
  scopeType: "space_user",
  defaults: DEFAULT_DAILY_REPORT_SETTINGS,
  parse: parseDailyReportSettings,
  serialize: dailyReportSettingsJson,
});

export class PgDailyReportSettingsRepository {
  private readonly settingsStore: ScopedSettingsStore;
  private readonly schedulerTaskStore: PgSchedulerTaskStore;

  constructor(db: Queryable) {
    this.settingsStore = new ScopedSettingsStore(db);
    this.schedulerTaskStore = new PgSchedulerTaskStore(db);
  }

  async getOrCreate(spaceId: string, userId: string): Promise<DailyReportSettingRow> {
    const read = await this.settingsStore.getOrCreate(
      DAILY_CAPTURE_REPORT_SETTINGS_DEFINITION,
      dailyReportSettingsScopeId(spaceId, userId),
    );
    return settingRowFromRead(spaceId, userId, read, await this.getSchedulerTask(spaceId, userId));
  }

  async get(spaceId: string, userId: string): Promise<DailyReportSettingRow | null> {
    const read = await this.settingsStore.get(
      DAILY_CAPTURE_REPORT_SETTINGS_DEFINITION,
      dailyReportSettingsScopeId(spaceId, userId),
    );
    if (!read.row) return null;
    return settingRowFromRead(spaceId, userId, read, await this.getSchedulerTask(spaceId, userId));
  }

  async getById(spaceId: string, settingId: string): Promise<DailyReportSettingRow | null> {
    const read = await this.settingsStore.getById(
      DAILY_CAPTURE_REPORT_SETTINGS_DEFINITION,
      settingId,
    );
    if (!read?.row) return null;
    const parsed = parseSpaceUserSettingsScopeId(read.row.scope_id);
    if (!parsed || parsed.spaceId !== spaceId) return null;
    return settingRowFromRead(
      parsed.spaceId,
      parsed.userId,
      read,
      await this.getSchedulerTask(parsed.spaceId, parsed.userId),
    );
  }

  async update(
    spaceId: string,
    userId: string,
    body: Record<string, unknown>,
  ): Promise<DailyReportSettingRow> {
    const row = await this.getOrCreate(spaceId, userId);
    const now = new Date().toISOString();
    const enabled =
      body.enabled !== undefined ? requiredBoolean(body.enabled, "enabled") : row.enabled;
    const localTime =
      body.local_time !== undefined ? requiredLocalTime(body.local_time) : row.local_time;
    const timezone =
      body.timezone !== undefined ? requiredTimezone(body.timezone) : row.timezone;
    const includeSourceTypes =
      body.include_source_types !== undefined
        ? requiredSourceTypes(body.include_source_types)
        : sourceTypesFromSettingRow(row);
    const createExperienceProposals =
      body.create_experience_proposals !== undefined
        ? requiredBoolean(body.create_experience_proposals, "create_experience_proposals")
        : row.create_experience_proposals;
    const createMemoryProposals =
      body.create_memory_proposals !== undefined
        ? requiredBoolean(body.create_memory_proposals, "create_memory_proposals")
        : row.create_memory_proposals;
    const experienceConfidenceThreshold =
      body.experience_confidence_threshold !== undefined
        ? requiredThreshold(
            body.experience_confidence_threshold,
            "experience_confidence_threshold",
          )
        : row.experience_confidence_threshold;
    const memoryConfidenceThreshold =
      body.memory_confidence_threshold !== undefined
        ? requiredThreshold(body.memory_confidence_threshold, "memory_confidence_threshold")
        : row.memory_confidence_threshold;
    const maxExperienceProposalsPerDay =
      body.max_experience_proposals_per_day !== undefined
        ? requiredIntegerRange(
            body.max_experience_proposals_per_day,
            "max_experience_proposals_per_day",
            0,
            20,
          )
        : row.max_experience_proposals_per_day;
    const maxMemoryProposalsPerDay =
      body.max_memory_proposals_per_day !== undefined
        ? requiredIntegerRange(
            body.max_memory_proposals_per_day,
            "max_memory_proposals_per_day",
            0,
            10,
          )
        : row.max_memory_proposals_per_day;
    const scheduleChanged =
      body.enabled !== undefined || body.local_time !== undefined || body.timezone !== undefined;
    if (scheduleChanged) {
      requiredLocalTime(localTime);
      requiredTimezone(timezone);
    }

    const nextValue: DailyReportSettingsValue = {
      enabled,
      local_time: localTime,
      timezone,
      include_source_types: includeSourceTypes,
      create_experience_proposals: createExperienceProposals,
      create_memory_proposals: createMemoryProposals,
      experience_confidence_threshold: experienceConfidenceThreshold,
      memory_confidence_threshold: memoryConfidenceThreshold,
      max_experience_proposals_per_day: maxExperienceProposalsPerDay,
      max_memory_proposals_per_day: maxMemoryProposalsPerDay,
    };
    const updated = await this.settingsStore.upsert(
      DAILY_CAPTURE_REPORT_SETTINGS_DEFINITION,
      dailyReportSettingsScopeId(spaceId, userId),
      nextValue,
      { updatedByUserId: userId },
    );
    const state = scheduleChanged
      ? await this.setNextRunAt(
          spaceId,
          userId,
          computeInitialNextRunAt({ enabled, local_time: localTime, timezone }),
          now,
        )
      : await this.getSchedulerTask(spaceId, userId);
    return settingRowFromRead(spaceId, userId, updated, state);
  }

  async listDue(nowIso: string): Promise<DailyReportSettingRow[]> {
    const tasks = await this.schedulerTaskStore.listDue(DAILY_REPORT_SCHEDULER_TASK_TYPE, nowIso);
    const due: DailyReportSettingRow[] = [];
    for (const task of tasks) {
      const parsed = parseSpaceUserSettingsScopeId(task.scope_id);
      const spaceId = task.space_id ?? parsed?.spaceId;
      const userId = task.user_id ?? parsed?.userId;
      if (!spaceId || !userId) continue;
      const read = await this.settingsStore.get(
        DAILY_CAPTURE_REPORT_SETTINGS_DEFINITION,
        dailyReportSettingsScopeId(spaceId, userId),
      );
      if (!read.row) continue;
      const setting = settingRowFromRead(spaceId, userId, read, task);
      if (setting.enabled) due.push(setting);
    }
    return due;
  }

  async advanceNextRun(setting: DailyReportSettingRow, slotUtcIso: string): Promise<void> {
    await this.setNextRunAt(
      setting.space_id,
      setting.user_id,
      computeNextRunAfterSlot(setting, slotUtcIso),
    );
  }

  async recordReportCompleted(
    spaceId: string,
    userId: string,
    localDate: string,
    nextRunAt: string | null,
    completedAt: string = new Date().toISOString(),
  ): Promise<void> {
    const existing = await this.getSchedulerTask(spaceId, userId);
    await this.schedulerTaskStore.upsert({
      taskType: DAILY_REPORT_SCHEDULER_TASK_TYPE,
      taskKey: dailyReportSchedulerTaskKey(spaceId, userId),
      scopeType: "space_user",
      scopeId: dailyReportSettingsScopeId(spaceId, userId),
      spaceId,
      userId,
      nextRunAt,
      lastRunAt: completedAt,
      stateJson: {
        ...(existing?.state_json ?? {}),
        last_report_date: localDate,
      },
      updatedAt: completedAt,
    });
  }

  toOut(row: DailyReportSettingRow): Record<string, unknown> {
    return {
      id: row.id,
      space_id: row.space_id,
      user_id: row.user_id,
      enabled: row.enabled,
      local_time: row.local_time,
      timezone: row.timezone,
      include_source_types: row.include_source_types_json,
      create_experience_proposals: row.create_experience_proposals,
      create_memory_proposals: row.create_memory_proposals,
      experience_confidence_threshold: row.experience_confidence_threshold,
      memory_confidence_threshold: row.memory_confidence_threshold,
      max_experience_proposals_per_day: row.max_experience_proposals_per_day,
      max_memory_proposals_per_day: row.max_memory_proposals_per_day,
      last_report_date: row.last_report_date,
      next_run_at: row.next_run_at,
      created_at: row.created_at,
      updated_at: row.updated_at,
    };
  }

  private async getSchedulerTask(
    spaceId: string,
    userId: string,
  ): Promise<SchedulerTaskRow | null> {
    return this.schedulerTaskStore.get(
      DAILY_REPORT_SCHEDULER_TASK_TYPE,
      dailyReportSchedulerTaskKey(spaceId, userId),
    );
  }

  private async setNextRunAt(
    spaceId: string,
    userId: string,
    nextRunAt: string | null,
    updatedAt: string = new Date().toISOString(),
  ): Promise<SchedulerTaskRow> {
    const existing = await this.getSchedulerTask(spaceId, userId);
    return this.schedulerTaskStore.upsert({
      taskType: DAILY_REPORT_SCHEDULER_TASK_TYPE,
      taskKey: dailyReportSchedulerTaskKey(spaceId, userId),
      scopeType: "space_user",
      scopeId: dailyReportSettingsScopeId(spaceId, userId),
      spaceId,
      userId,
      nextRunAt,
      stateJson: existing?.state_json ?? {},
      updatedAt,
    });
  }
}

function dailyReportSettingsScopeId(spaceId: string, userId: string): string {
  return spaceUserSettingsScopeId(spaceId, userId);
}

function dailyReportSchedulerTaskKey(spaceId: string, userId: string): string {
  return dailyReportSettingsScopeId(spaceId, userId);
}

function settingRowFromRead(
  spaceId: string,
  userId: string,
  read: ScopedSettingsRead<DailyReportSettingsValue>,
  task: SchedulerTaskRow | null,
): DailyReportSettingRow {
  if (!read.row) {
    throw new Error("daily capture report settings row was not created");
  }
  const value = read.value;
  return {
    id: read.row.id,
    space_id: spaceId,
    user_id: userId,
    enabled: value.enabled,
    local_time: value.local_time,
    timezone: value.timezone,
    include_source_types_json: value.include_source_types,
    create_experience_proposals: value.create_experience_proposals,
    create_memory_proposals: value.create_memory_proposals,
    experience_confidence_threshold: value.experience_confidence_threshold,
    memory_confidence_threshold: value.memory_confidence_threshold,
    max_experience_proposals_per_day: value.max_experience_proposals_per_day,
    max_memory_proposals_per_day: value.max_memory_proposals_per_day,
    last_report_date: stringValue(task?.state_json.last_report_date),
    next_run_at: nullableTimestampString(task?.next_run_at),
    created_at: timestampString(read.row.created_at),
    updated_at: timestampString(read.row.updated_at),
  };
}

function parseDailyReportSettings(value: unknown): DailyReportSettingsValue {
  const record = settingsRecord(value);
  return {
    enabled: booleanValue(record.enabled, DEFAULT_DAILY_REPORT_SETTINGS.enabled),
    local_time:
      typeof record.local_time === "string" && record.local_time.trim()
        ? record.local_time
        : DEFAULT_DAILY_REPORT_SETTINGS.local_time,
    timezone:
      typeof record.timezone === "string" && record.timezone.trim()
        ? record.timezone
        : DEFAULT_DAILY_REPORT_SETTINGS.timezone,
    include_source_types: sourceTypesFromStored(
      record.include_source_types ?? record.include_source_types_json,
    ),
    create_experience_proposals: booleanValue(
      record.create_experience_proposals,
      DEFAULT_DAILY_REPORT_SETTINGS.create_experience_proposals,
    ),
    create_memory_proposals: booleanValue(
      record.create_memory_proposals,
      DEFAULT_DAILY_REPORT_SETTINGS.create_memory_proposals,
    ),
    experience_confidence_threshold: numberInRange(
      record.experience_confidence_threshold,
      0,
      1,
      DEFAULT_DAILY_REPORT_SETTINGS.experience_confidence_threshold,
    ),
    memory_confidence_threshold: numberInRange(
      record.memory_confidence_threshold,
      0,
      1,
      DEFAULT_DAILY_REPORT_SETTINGS.memory_confidence_threshold,
    ),
    max_experience_proposals_per_day: integerInRange(
      record.max_experience_proposals_per_day,
      0,
      20,
      DEFAULT_DAILY_REPORT_SETTINGS.max_experience_proposals_per_day,
    ),
    max_memory_proposals_per_day: integerInRange(
      record.max_memory_proposals_per_day,
      0,
      10,
      DEFAULT_DAILY_REPORT_SETTINGS.max_memory_proposals_per_day,
    ),
  };
}

function dailyReportSettingsJson(value: DailyReportSettingsValue): Record<string, unknown> {
  return {
    enabled: value.enabled,
    local_time: value.local_time,
    timezone: value.timezone,
    include_source_types: value.include_source_types,
    create_experience_proposals: value.create_experience_proposals,
    create_memory_proposals: value.create_memory_proposals,
    experience_confidence_threshold: value.experience_confidence_threshold,
    memory_confidence_threshold: value.memory_confidence_threshold,
    max_experience_proposals_per_day: value.max_experience_proposals_per_day,
    max_memory_proposals_per_day: value.max_memory_proposals_per_day,
  };
}

function sourceTypesFromSettingRow(row: DailyReportSettingRow): string[] {
  return sourceTypesFromStored(row.include_source_types_json);
}

function sourceTypesFromStored(value: unknown): string[] {
  if (!Array.isArray(value) || !value.every((item): item is string => typeof item === "string")) {
    return [...DEFAULT_DAILY_REPORT_SETTINGS.include_source_types];
  }
  const valid = value.filter((item) => VALID_SOURCE_TYPES.has(item));
  return valid.length > 0 || value.length === 0
    ? valid
    : [...DEFAULT_DAILY_REPORT_SETTINGS.include_source_types];
}

function booleanValue(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function numberInRange(value: unknown, min: number, max: number, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value >= min && value <= max
    ? value
    : fallback;
}

function integerInRange(value: unknown, min: number, max: number, fallback: number): number {
  return typeof value === "number" && Number.isInteger(value) && value >= min && value <= max
    ? value
    : fallback;
}

function timestampString(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  return String(value ?? "");
}

function nullableTimestampString(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return timestampString(value);
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function computeNextRunAfterSlot(setting: DailyReportSettingRow, slotUtcIso: string): string | null {
  if (!setting.enabled) return null;
  const localTime = parseLocalTime(setting.local_time);
  if (!localTime) return null;
  try {
    const tz = setting.timezone || "UTC";
    const slotLocal = zonedParts(new Date(slotUtcIso), tz);
    const nextLocal = addLocalDays(
      {
        year: slotLocal.year,
        month: slotLocal.month,
        day: slotLocal.day,
        hour: localTime.hour,
        minute: localTime.minute,
      },
      1,
    );
    return zonedLocalToUtc(nextLocal, tz).toISOString();
  } catch {
    return null;
  }
}

function requiredBoolean(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") {
    throw new HttpError(422, `${field} must be a boolean`);
  }
  return value;
}

function requiredLocalTime(value: unknown): string {
  if (typeof value !== "string") {
    throw new HttpError(422, "local_time must be HH:MM (e.g. 08:30)");
  }
  const parsed = parseLocalTime(value);
  if (!parsed) {
    throw new HttpError(422, "local_time hour must be 00-23 and minute must be 00-59");
  }
  return value;
}

function requiredTimezone(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new HttpError(422, "timezone must be a valid IANA timezone");
  }
  assertValidTimezone(value);
  return value;
}

function requiredSourceTypes(value: unknown): string[] {
  if (!Array.isArray(value) || !value.every((item): item is string => typeof item === "string")) {
    throw new HttpError(422, "include_source_types must be a list of strings");
  }
  const invalid = value.filter((item) => !VALID_SOURCE_TYPES.has(item));
  if (invalid.length > 0) {
    throw new HttpError(
      422,
      `include_source_types contains unsupported values: ${JSON.stringify(invalid)}`,
    );
  }
  return value;
}

function requiredThreshold(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new HttpError(422, `${field} must be between 0.0 and 1.0`);
  }
  return value;
}

function requiredIntegerRange(value: unknown, field: string, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
    throw new HttpError(422, `${field} must be between ${min} and ${max}`);
  }
  return value;
}

export function assertValidTimezone(timezone: string): void {
  if (isValidTimezone(timezone)) return;
  throw new HttpError(422, `timezone ${JSON.stringify(timezone)} is not a valid IANA timezone`);
}

export function isValidTimezone(timezone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format(new Date());
    return true;
  } catch {
    return false;
  }
}

export function assertValidLocalDate(localDate: string): void {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(localDate)) {
    throw new HttpError(422, "local_date must be YYYY-MM-DD");
  }
}

export function computeInitialNextRunAt(
  setting: Pick<DailyReportSettingRow, "enabled" | "local_time" | "timezone">,
  after: Date = new Date(),
): string | null {
  if (!setting.enabled) return null;
  const localTime = parseLocalTime(setting.local_time);
  if (!localTime) return null;
  try {
    const tz = setting.timezone || "UTC";
    const afterLocal = zonedParts(after, tz);
    let candidateLocal = {
      year: afterLocal.year,
      month: afterLocal.month,
      day: afterLocal.day,
      hour: localTime.hour,
      minute: localTime.minute,
    };
    let candidate = zonedLocalToUtc(candidateLocal, tz);
    if (candidate.getTime() <= after.getTime()) {
      candidateLocal = addLocalDays(candidateLocal, 1);
      candidate = zonedLocalToUtc(candidateLocal, tz);
    }
    return candidate.toISOString();
  } catch {
    return null;
  }
}

export function localDateFromSlot(slotUtcIso: string, timezone: string): string {
  try {
    const parts = zonedParts(new Date(slotUtcIso), timezone || "UTC");
    return `${parts.year}-${pad(parts.month)}-${pad(parts.day)}`;
  } catch {
    return new Date(slotUtcIso).toISOString().slice(0, 10);
  }
}

export function localDayUtcBounds(
  localDate: string,
  timezone: string,
): { startUtcIso: string; endUtcIso: string } {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(localDate);
  if (!match) throw new Error(`Invalid local_date ${JSON.stringify(localDate)}`);
  const startLocal = {
    year: Number(match[1]),
    month: Number(match[2]),
    day: Number(match[3]),
    hour: 0,
    minute: 0,
  };
  const endLocal = addLocalDays(startLocal, 1);
  return {
    startUtcIso: zonedLocalToUtc(startLocal, timezone || "UTC").toISOString(),
    endUtcIso: zonedLocalToUtc(endLocal, timezone || "UTC").toISOString(),
  };
}

interface LocalDateTimeParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
}

function parseLocalTime(value: string): { hour: number; minute: number } | null {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(value);
  if (!match) return null;
  return { hour: Number(match[1]), minute: Number(match[2]) };
}

function zonedParts(date: Date, timeZone: string): LocalDateTimeParts {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((item) => item.type === type)?.value ?? 0);
  return {
    year: part("year"),
    month: part("month"),
    day: part("day"),
    hour: part("hour"),
    minute: part("minute"),
  };
}

function zonedLocalToUtc(parts: LocalDateTimeParts, timeZone: string): Date {
  const target = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, 0, 0);
  let guess = target;
  for (let i = 0; i < 4; i += 1) {
    const actual = zonedParts(new Date(guess), timeZone);
    const actualAsUtc = Date.UTC(
      actual.year,
      actual.month - 1,
      actual.day,
      actual.hour,
      actual.minute,
      0,
      0,
    );
    const delta = actualAsUtc - target;
    if (delta === 0) break;
    guess -= delta;
  }
  return new Date(guess);
}

function addLocalDays(parts: LocalDateTimeParts, days: number): LocalDateTimeParts {
  const date = new Date(
    Date.UTC(parts.year, parts.month - 1, parts.day + days, parts.hour, parts.minute),
  );
  return {
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    day: date.getUTCDate(),
    hour: date.getUTCHours(),
    minute: date.getUTCMinutes(),
  };
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}
