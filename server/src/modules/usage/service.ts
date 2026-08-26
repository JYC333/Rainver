import type { ServerConfig } from "../../config.js";
import { getDbPool } from "../../db/pool.js";
import { HttpError, type Queryable } from "../routeUtils/common.js";
import { resolveUsageAttribution } from "./attribution.js";
import { normalizeUsageObservation } from "./normalizer.js";
import {
  eventToOut,
  PgUsageRepository,
  type UsageQueryFilters,
} from "./repository.js";
import {
  CliHistoryImportService,
  type CliHistoryImportCommitInput,
  type CliHistoryImportPreviewInput,
} from "./cliHistoryImport.js";
import type { UsageAttribution, UsageObservation } from "./types.js";

export interface UsageIdentity {
  spaceId: string;
  userId: string;
}

export interface UsageQueryInput {
  view?: string | null;
  from?: string | null;
  to?: string | null;
  groupBy?: string | null;
  accuracy?: string | null;
  executionChannel?: string | null;
  providerId?: string | null;
  model?: string | null;
  task?: string | null;
  subjectType?: string | null;
  subjectId?: string | null;
  sessionId?: string | null;
  externalSessionId?: string | null;
  sessionPath?: string | null;
  dimensionKey?: string | null;
  dimensionValue?: string | null;
  includeImported?: boolean;
  limit?: number;
  offset?: number;
  granularity?: "day" | "week" | "month";
}

export class UsageService {
  constructor(
    private readonly repository: PgUsageRepository,
    private readonly db: Queryable,
    private readonly config?: ServerConfig,
  ) {}

  static fromConfig(config: ServerConfig): UsageService {
    if (!config.databaseUrl) throw new HttpError(502, "SERVER_DATABASE_URL is required");
    const pool = getDbPool(config.databaseUrl);
    return new UsageService(new PgUsageRepository(pool), pool, config);
  }

  async record(input: UsageObservation): Promise<Record<string, unknown>> {
    const attribution = await resolveUsageAttribution(this.db, input);
    return this.recordAttributed(input, attribution);
  }

  async resolveAttribution(input: UsageObservation): Promise<UsageAttribution> {
    return resolveUsageAttribution(this.db, input);
  }

  async recordAttributed(
    input: UsageObservation,
    attribution: UsageAttribution,
  ): Promise<Record<string, unknown>> {
    const instanceId = await this.repository.getOrCreateInstanceId();
    const event = normalizeUsageObservation(input, instanceId, attribution);
    return eventToOut(await this.repository.appendEvent(event));
  }

  async previewCliHistoryImport(
    identity: UsageIdentity,
    input: CliHistoryImportPreviewInput,
  ): Promise<Record<string, unknown>> {
    return this.cliHistoryImports().preview(identity, input);
  }

  async commitCliHistoryImport(
    identity: UsageIdentity,
    input: CliHistoryImportCommitInput,
  ): Promise<Record<string, unknown>> {
    return this.cliHistoryImports().commit(identity, input);
  }

  async budgetPreview(
    identity: UsageIdentity,
    input: UsageQueryInput,
    projectionWindowDays: number,
  ): Promise<Record<string, unknown>> {
    if (!Number.isFinite(projectionWindowDays) || projectionWindowDays < 1 || projectionWindowDays > 366) {
      throw new HttpError(422, "projection_window_days must be between 1 and 366");
    }
    const filters = await this.filters(identity, input);
    const preview = await this.repository.budgetPreview(filters, Math.trunc(projectionWindowDays));
    return {
      from: filters.from,
      to: filters.to,
      ...preview,
    };
  }

  async summary(identity: UsageIdentity, input: UsageQueryInput): Promise<Record<string, unknown>> {
    const filters = await this.filters(identity, input);
    const result = await this.repository.aggregate(filters);
    return {
      view: filters.view,
      from: filters.from,
      to: filters.to,
      group_by: filters.groupBy ?? "provider",
      totals: result.totals,
      items: result.items,
    };
  }

  private cliHistoryImports(): CliHistoryImportService {
    if (!this.config) throw new HttpError(502, "Server config is required");
    return new CliHistoryImportService(this.config, this.repository);
  }

  async timeseries(identity: UsageIdentity, input: UsageQueryInput): Promise<Record<string, unknown>> {
    const filters = await this.filters(identity, input);
    const granularity = input.granularity ?? "day";
    const items = await this.repository.timeseries({ ...filters, granularity });
    return {
      from: filters.from,
      to: filters.to,
      granularity,
      group_by: filters.groupBy ?? "provider",
      items,
    };
  }

  async events(identity: UsageIdentity, input: UsageQueryInput): Promise<Record<string, unknown>> {
    const filters = await this.filters(identity, input);
    const result = await this.repository.listEvents(filters);
    return {
      items: result.items.map(eventToOut),
      total: result.total,
      limit: filters.limit ?? 50,
      offset: filters.offset ?? 0,
    };
  }

  async dimensions(identity: UsageIdentity, input: UsageQueryInput): Promise<Record<string, unknown>> {
    const filters = await this.filters(identity, input);
    return this.repository.dimensions(filters);
  }

  async subjects(identity: UsageIdentity, input: UsageQueryInput): Promise<Record<string, unknown>> {
    const filters = await this.filters(identity, input);
    const result = await this.repository.subjects(filters);
    return {
      items: result.items.map((item) => {
        const [type, ...rest] = item.group_key.split(":");
        return {
          meter_subject_type: type || "unknown",
          meter_subject_id: rest.join(":") || item.group_key,
          totals: item.totals,
          last_seen_at: item.last_seen_at,
        };
      }),
      total: result.total,
    };
  }

  async sessions(identity: UsageIdentity, input: UsageQueryInput): Promise<Record<string, unknown>> {
    const filters = await this.filters(identity, input);
    return this.repository.sessions(filters);
  }

  private async filters(identity: UsageIdentity, input: UsageQueryInput): Promise<UsageQueryFilters> {
    const range = dateRange(input.from, input.to);
    return {
      activeSpaceId: identity.spaceId,
      userId: identity.userId,
      view: normalizeView(input.view),
      from: range.from,
      to: range.to,
      includeImported: input.includeImported,
      accuracy: allowedAccuracy(input.accuracy),
      executionChannel: allowedExecutionChannel(input.executionChannel),
      providerId: nonEmpty(input.providerId),
      model: nonEmpty(input.model),
      task: nonEmpty(input.task),
      subjectType: allowedLooseKey(input.subjectType),
      subjectId: nonEmpty(input.subjectId),
      sessionId: nonEmpty(input.sessionId),
      externalSessionId: nonEmpty(input.externalSessionId),
      sessionPath: nonEmpty(input.sessionPath),
      dimensionKey: allowedDimensionKey(input.dimensionKey),
      dimensionValue: nonEmpty(input.dimensionValue),
      groupBy: allowedGroupBy(input.groupBy),
      limit: input.limit,
      offset: input.offset,
    };
  }

  async operationalTotals(input: UsageQueryInput): Promise<Record<string, unknown>> {
    const range = dateRange(input.from, input.to);
    return {
      from: range.from,
      to: range.to,
      totals: await this.repository.operationalTotals(range),
    };
  }
}

export function usageServiceFromConfig(config: ServerConfig): UsageService {
  return UsageService.fromConfig(config);
}

export async function recordUsageObservation(
  config: ServerConfig,
  observation: UsageObservation,
): Promise<void> {
  if (!config.databaseUrl) throw new HttpError(502, "SERVER_DATABASE_URL is required");
  await UsageService.fromConfig(config).record(observation);
}

export async function resolveUsageObservationAttribution(
  config: ServerConfig,
  observation: UsageObservation,
): Promise<UsageAttribution> {
  if (!config.databaseUrl) throw new HttpError(502, "SERVER_DATABASE_URL is required");
  return UsageService.fromConfig(config).resolveAttribution(observation);
}

export async function recordAttributedUsageObservation(
  config: ServerConfig,
  observation: UsageObservation,
  attribution: UsageAttribution,
): Promise<void> {
  if (!config.databaseUrl) throw new HttpError(502, "SERVER_DATABASE_URL is required");
  await UsageService.fromConfig(config).recordAttributed(observation, attribution);
}

function normalizeView(value: string | null | undefined): "mine" | "shared" | "all_visible" {
  if (value === null || value === undefined || value === "") return "mine";
  if (value === "mine" || value === "shared" || value === "all_visible") return value;
  throw new HttpError(422, "view must be mine, shared, or all_visible");
}

function dateRange(from: string | null | undefined, to: string | null | undefined): { from: string; to: string } {
  const end = to ? new Date(to) : new Date();
  if (Number.isNaN(end.getTime())) throw new HttpError(422, "invalid to datetime");
  const start = from ? new Date(from) : new Date(end.getTime() - 30 * 24 * 60 * 60 * 1000);
  if (Number.isNaN(start.getTime())) throw new HttpError(422, "invalid from datetime");
  if (start >= end) throw new HttpError(422, "from must be before to");
  return { from: start.toISOString(), to: end.toISOString() };
}

function allowedAccuracy(value: string | null | undefined): string | null {
  return [
    "provider_reported",
    "proxy_observed",
    "transcript_lower_bound",
    "estimated",
    "quota_snapshot",
    "unknown",
  ].includes(value ?? "") ? value! : null;
}

function allowedExecutionChannel(value: string | null | undefined): string | null {
  return [
    "managed_api",
    "provider_proxy",
    "local_cli",
    "local_cli_transcript",
    "manual_import",
    "cross_instance_import",
    "unknown",
  ].includes(value ?? "") ? value! : null;
}

function allowedGroupBy(value: string | null | undefined): string {
  const normalized = nonEmpty(value) ?? "provider";
  if (normalized.startsWith("dimension:")) {
    const key = normalized.slice("dimension:".length);
    if (isSafeDimensionKey(key)) return normalized;
    return "provider";
  }
  return [
    "provider",
    "model",
    "platform",
    "date",
    "session",
    "session_path",
    "subject",
    "agent",
    "task",
  ].includes(normalized) ? normalized : "provider";
}

function allowedDimensionKey(value: string | null | undefined): string | null {
  const normalized = nonEmpty(value);
  return normalized && isSafeDimensionKey(normalized) ? normalized : null;
}

function allowedLooseKey(value: string | null | undefined): string | null {
  const normalized = nonEmpty(value);
  return normalized && /^[A-Za-z0-9_.:-]{1,64}$/.test(normalized) ? normalized : null;
}

function isSafeDimensionKey(value: string): boolean {
  return /^[A-Za-z0-9_.:-]{1,64}$/.test(value);
}

function nonEmpty(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}
