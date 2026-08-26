import type {
  CustomSourceInstanceRunnerSettingsUpdate,
  CustomSourceSpacePolicyUpdate,
} from "@rainver/protocol";
import type { ServerConfig } from "../../../config.js";
import { isSpaceOwnerOrAdmin } from "../../access/roles.js";
import {
  HttpError,
  countFromRow,
  dateIso,
  page,
  type Queryable,
  type SpaceUserIdentity,
} from "../../routeUtils/common.js";
import {
  ScopedSettingsStore,
  SETTINGS_KEYS,
  defineScopedSetting,
  settingsRecord,
  type ScopedSettingsRead,
} from "../../settings/index.js";
import { SOURCE_CAPTURE_POLICY_SET } from "../capturePolicy.js";
import type { CustomSourceRunnerSettings } from "./customSourceRunner.js";

export const HANDLER_VERSION_COLUMNS = `id, space_id, source_connection_id, version_number, language, entrypoint, handler_artifact_id, manifest_json, input_schema_json, output_schema_json, policy_envelope_json, requested_capabilities_json, checksum, status, created_by_user_id, created_by_run_id, proposal_id, test_result_json, created_at, activated_at, superseded_at`;
export const HANDLER_RUN_COLUMNS = `id, space_id, source_connection_id, handler_version_id, extraction_job_id, status, input_artifact_id, output_artifact_id, logs_artifact_id, failure_class, failure_detail_json, validation_result_json, resource_usage_json, created_at, started_at, completed_at`;
const CUSTOM_SOURCE_SPACE_POLICY_SETTINGS_KEY = SETTINGS_KEYS.customSourceSpacePolicy;
const CUSTOM_SOURCE_INSTANCE_RUNNER_SETTINGS_KEY = SETTINGS_KEYS.customSourceInstanceRunner;

export interface HandlerVersionRow {
  id: string;
  space_id: string;
  source_connection_id: string;
  version_number: number;
  language: string;
  entrypoint: string;
  handler_artifact_id: string | null;
  manifest_json: unknown;
  input_schema_json: unknown;
  output_schema_json: unknown;
  policy_envelope_json: unknown;
  requested_capabilities_json: unknown;
  checksum: string;
  status: string;
  created_by_user_id: string | null;
  created_by_run_id: string | null;
  proposal_id: string | null;
  test_result_json: unknown;
  created_at: unknown;
  activated_at: unknown;
  superseded_at: unknown;
}

export interface HandlerRunRow {
  id: string;
  space_id: string;
  source_connection_id: string;
  handler_version_id: string;
  extraction_job_id: string | null;
  status: string;
  input_artifact_id: string | null;
  output_artifact_id: string | null;
  logs_artifact_id: string | null;
  failure_class: string | null;
  failure_detail_json: unknown;
  validation_result_json: unknown;
  resource_usage_json: unknown;
  created_at: unknown;
  started_at: unknown;
  completed_at: unknown;
}

const CREATOR_ROLE_VALUES = new Set(["owner", "admin", "reviewer", "member"]);
const RETENTION_POLICY_VALUES = new Set([
  "metadata_only",
  "summary_only",
  "full_text",
  "full_snapshot",
  "archived",
]);

export function handlerVersionOut(row: HandlerVersionRow) {
  return {
    id: row.id,
    space_id: row.space_id,
    source_connection_id: row.source_connection_id,
    version_number: row.version_number,
    language: row.language,
    entrypoint: row.entrypoint,
    handler_artifact_id: row.handler_artifact_id,
    manifest_json: row.manifest_json ?? {},
    input_schema_json: row.input_schema_json ?? null,
    output_schema_json: row.output_schema_json ?? null,
    policy_envelope_json: row.policy_envelope_json ?? {},
    requested_capabilities_json: row.requested_capabilities_json ?? null,
    checksum: row.checksum,
    status: row.status,
    created_by_user_id: row.created_by_user_id,
    created_by_run_id: row.created_by_run_id,
    proposal_id: row.proposal_id,
    test_result_json: row.test_result_json ?? null,
    created_at: dateIso(row.created_at),
    activated_at: dateIso(row.activated_at),
    superseded_at: dateIso(row.superseded_at),
  };
}

export function handlerRunOut(row: HandlerRunRow) {
  return {
    id: row.id,
    space_id: row.space_id,
    source_connection_id: row.source_connection_id,
    handler_version_id: row.handler_version_id,
    extraction_job_id: row.extraction_job_id,
    status: row.status,
    input_artifact_id: row.input_artifact_id,
    output_artifact_id: row.output_artifact_id,
    logs_artifact_id: row.logs_artifact_id,
    failure_class: row.failure_class,
    failure_detail_json: row.failure_detail_json ?? null,
    validation_result_json: row.validation_result_json ?? null,
    resource_usage_json: row.resource_usage_json ?? null,
    created_at: dateIso(row.created_at),
    started_at: dateIso(row.started_at),
    completed_at: dateIso(row.completed_at),
  };
}

const SPACE_POLICY_DEFAULTS = {
  creator_roles: ["owner", "admin"] as string[],
  default_capture_policy: "extract_text",
  default_retention_policy: "full_text",
  allowed_domains: [] as string[],
  download_bytes_max: 5_242_880,
  credentialed_sources_allowed: false,
  same_envelope_repair_auto_apply: false,
};
const DOWNLOAD_BYTES_MIN = 1_024;
const DOWNLOAD_BYTES_MAX = 104_857_600;

const INSTANCE_SETTINGS_DEFAULTS = {
  runner_enabled: true,
};

interface CustomSourceSpacePolicySettings {
  creator_roles: string[];
  default_capture_policy: string;
  default_retention_policy: string;
  allowed_domains: string[];
  download_bytes_max: number;
  credentialed_sources_allowed: boolean;
  same_envelope_repair_auto_apply: boolean;
}

interface CustomSourceInstanceRunnerSettings {
  runner_enabled: boolean;
}

function normalizeCreatorRoles(value: unknown): string[] {
  const roles = Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : SPACE_POLICY_DEFAULTS.creator_roles;
  const normalized = ["owner", "admin"];
  for (const role of roles) {
    if (!CREATOR_ROLE_VALUES.has(role)) {
      throw new HttpError(422, `Unsupported Custom Source creator role: ${role}`);
    }
    if (!normalized.includes(role)) normalized.push(role);
  }
  return normalized;
}

function normalizeCapturePolicy(value: unknown): string {
  if (typeof value === "string" && SOURCE_CAPTURE_POLICY_SET.has(value)) return value;
  throw new HttpError(422, "Unsupported Custom Source capture policy");
}

function normalizeRetentionPolicy(value: unknown): string {
  if (typeof value === "string" && RETENTION_POLICY_VALUES.has(value)) return value;
  throw new HttpError(422, "Unsupported Custom Source retention policy");
}

function normalizeAllowedDomain(value: string): string {
  const raw = value.trim().toLowerCase().replace(/^\*\./, "");
  if (!raw) throw new HttpError(422, "allowed_domains entries must be non-empty");
  const candidate = raw.includes("://") ? raw : `https://${raw}`;
  let hostname: string;
  try {
    hostname = new URL(candidate).hostname.toLowerCase().replace(/\.$/, "");
  } catch {
    throw new HttpError(422, `Invalid allowed domain: ${value}`);
  }
  if (!hostname || hostname.includes("..") || /\s/.test(hostname)) {
    throw new HttpError(422, `Invalid allowed domain: ${value}`);
  }
  return hostname;
}

function normalizeAllowedDomains(value: unknown): string[] {
  if (!Array.isArray(value)) return SPACE_POLICY_DEFAULTS.allowed_domains;
  const domains = value.map((item) => {
    if (typeof item !== "string") throw new HttpError(422, "allowed_domains must contain strings");
    return normalizeAllowedDomain(item);
  });
  return [...new Set(domains)];
}

function normalizeDownloadBytesMax(value: unknown): number {
  const numberValue = typeof value === "number"
    ? value
    : typeof value === "string" && value.trim()
      ? Number(value)
      : NaN;
  if (!Number.isInteger(numberValue)) throw new HttpError(422, "download_bytes_max must be an integer byte count");
  if (numberValue < DOWNLOAD_BYTES_MIN || numberValue > DOWNLOAD_BYTES_MAX) {
    throw new HttpError(422, "download_bytes_max must be between 1024 and 104857600 bytes");
  }
  return numberValue;
}

function parseSpacePolicySettings(value: unknown): CustomSourceSpacePolicySettings {
  const settings = settingsRecord(value);
  return {
    creator_roles: normalizeCreatorRoles(settings.creator_roles),
    default_capture_policy:
      typeof settings.default_capture_policy === "string"
        ? normalizeCapturePolicy(settings.default_capture_policy)
        : SPACE_POLICY_DEFAULTS.default_capture_policy,
    default_retention_policy:
      typeof settings.default_retention_policy === "string"
        ? normalizeRetentionPolicy(settings.default_retention_policy)
        : SPACE_POLICY_DEFAULTS.default_retention_policy,
    allowed_domains: normalizeAllowedDomains(settings.allowed_domains),
    download_bytes_max:
      settings.download_bytes_max === undefined
        ? SPACE_POLICY_DEFAULTS.download_bytes_max
        : normalizeDownloadBytesMax(settings.download_bytes_max),
    credentialed_sources_allowed:
      typeof settings.credentialed_sources_allowed === "boolean"
        ? settings.credentialed_sources_allowed
        : SPACE_POLICY_DEFAULTS.credentialed_sources_allowed,
    same_envelope_repair_auto_apply:
      typeof settings.same_envelope_repair_auto_apply === "boolean"
        ? settings.same_envelope_repair_auto_apply
        : SPACE_POLICY_DEFAULTS.same_envelope_repair_auto_apply,
  };
}

function parseInstanceRunnerSettings(value: unknown): CustomSourceInstanceRunnerSettings {
  const settings = settingsRecord(value);
  return {
    runner_enabled:
      typeof settings.runner_enabled === "boolean"
        ? settings.runner_enabled
        : INSTANCE_SETTINGS_DEFAULTS.runner_enabled,
  };
}

const CUSTOM_SOURCE_SPACE_POLICY_DEFINITION = defineScopedSetting<CustomSourceSpacePolicySettings>({
  key: CUSTOM_SOURCE_SPACE_POLICY_SETTINGS_KEY,
  scopeType: "space",
  defaults: SPACE_POLICY_DEFAULTS,
  parse: parseSpacePolicySettings,
});

const CUSTOM_SOURCE_INSTANCE_RUNNER_DEFINITION = defineScopedSetting<CustomSourceInstanceRunnerSettings>({
  key: CUSTOM_SOURCE_INSTANCE_RUNNER_SETTINGS_KEY,
  scopeType: "instance",
  defaults: INSTANCE_SETTINGS_DEFAULTS,
  parse: parseInstanceRunnerSettings,
});

function spacePolicyOut(spaceId: string, read: ScopedSettingsRead<CustomSourceSpacePolicySettings>) {
  const settings = read.value;
  return {
    space_id: spaceId,
    ...settings,
    created_at: read.row ? dateIso(read.row.created_at) : null,
    updated_at: read.row ? dateIso(read.row.updated_at) : null,
  };
}

export function instanceRunnerSettingsOut(
  config: ServerConfig,
  read: ScopedSettingsRead<CustomSourceInstanceRunnerSettings> | null = null,
) {
  const settings = read?.value ?? INSTANCE_SETTINGS_DEFAULTS;
  return {
    runner_enabled: settings.runner_enabled,
    allowed_languages: config.customSourceAllowedLanguages,
    network_hard_deny_rules: config.customSourceNetworkHardDenyRules,
    timeout_ms_max: config.customSourceTimeoutMsMax,
    output_bytes_max: config.customSourceOutputBytesMax,
    log_bytes_max: config.customSourceLogBytesMax,
    max_files: config.customSourceMaxFiles,
    browser_automation_available: config.customSourceBrowserAutomationAvailable,
    shell_available: config.customSourceShellAvailable,
    dependency_installation_available: config.customSourceDependencyInstallationAvailable,
    generate_rate_limit_per_hour: config.customSourceGenerateRateLimitPerHour,
    artifact_retention_enabled: config.customSourceArtifactRetentionEnabled,
    artifact_retention_days: config.customSourceArtifactRetentionDays,
  };
}

function runnerSettingsOut(
  config: ServerConfig,
  instanceRead: ScopedSettingsRead<CustomSourceInstanceRunnerSettings> | null,
  spaceRead: ScopedSettingsRead<CustomSourceSpacePolicySettings>,
): CustomSourceRunnerSettings {
  const instanceSettings = instanceRead?.value ?? INSTANCE_SETTINGS_DEFAULTS;
  return {
    ...instanceRunnerSettingsOut(config, instanceRead),
    runner_enabled: instanceSettings.runner_enabled,
    download_bytes_max: spaceRead.value.download_bytes_max,
  };
}

/**
 * Read model for Custom Source handler versions/runs and the Space/Instance
 * settings. Write-side create-flow logic (draft/generate/test/activate) lives
 * in `customSourceCreateFlowService.ts`, which reuses `handlerVersionOut` /
 * `handlerRunOut` / the column lists exported from this file so both read and
 * write paths render the same wire shape.
 */
export class PgCustomSourceHandlerRepository {
  private readonly settingsStore: ScopedSettingsStore;

  constructor(
    private readonly db: Queryable,
    private readonly config: ServerConfig,
  ) {
    this.settingsStore = new ScopedSettingsStore(db);
  }

  /** Confirms the connection exists in this space; throws 404 otherwise. Every other method depends on this same-space gate. */
  private async requireConnection(identity: SpaceUserIdentity, connectionId: string): Promise<void> {
    const result = await this.db.query<{ id: string }>(
      `SELECT id FROM source_connections WHERE space_id = $1 AND id = $2 AND deleted_at IS NULL`,
      [identity.spaceId, connectionId],
    );
    if (!result.rows[0]) throw new HttpError(404, "Source connection not found");
  }

  private async getSpacePolicySettings(spaceId: string) {
    return this.settingsStore.get(CUSTOM_SOURCE_SPACE_POLICY_DEFINITION, spaceId);
  }

  private async getInstanceRunnerSettingsRead() {
    return this.settingsStore.get(CUSTOM_SOURCE_INSTANCE_RUNNER_DEFINITION, "instance");
  }

  async getRunnerSettingsForSpace(spaceId: string): Promise<CustomSourceRunnerSettings> {
    const [instanceRead, spaceRead] = await Promise.all([
      this.getInstanceRunnerSettingsRead(),
      this.getSpacePolicySettings(spaceId),
    ]);
    return runnerSettingsOut(this.config, instanceRead, spaceRead);
  }

  private async getSpaceRole(identity: SpaceUserIdentity): Promise<string | null> {
    const result = await this.db.query<{ role: string }>(
      `SELECT role FROM space_memberships
        WHERE user_id = $1 AND space_id = $2 AND status = 'active'
        LIMIT 1`,
      [identity.userId, identity.spaceId],
    );
    return result.rows[0]?.role ?? null;
  }

  async requireCustomSourceCreator(identity: SpaceUserIdentity, creatorRoles: string[]): Promise<void> {
    const role = await this.getSpaceRole(identity);
    if (!role || !creatorRoles.includes(role)) {
      throw new HttpError(403, "Requires Custom Source creator role");
    }
  }

  private async requireSpaceAdmin(identity: SpaceUserIdentity): Promise<void> {
    const role = await this.getSpaceRole(identity);
    if (!isSpaceOwnerOrAdmin(role)) {
      throw new HttpError(403, "Requires space admin role");
    }
  }

  async listHandlerVersions(
    identity: SpaceUserIdentity,
    connectionId: string,
    filters: { limit: number; offset: number },
  ) {
    await this.requireConnection(identity, connectionId);
    const params = [identity.spaceId, connectionId];
    const total = await this.db.query<{ total: string }>(
      `SELECT count(*)::text AS total FROM source_handler_versions WHERE space_id = $1 AND source_connection_id = $2`,
      params,
    );
    const rows = await this.db.query<HandlerVersionRow>(
      `SELECT ${HANDLER_VERSION_COLUMNS} FROM source_handler_versions
        WHERE space_id = $1 AND source_connection_id = $2
        ORDER BY version_number DESC
        LIMIT $3 OFFSET $4`,
      [...params, filters.limit, filters.offset],
    );
    return page(rows.rows.map(handlerVersionOut), countFromRow(total.rows[0]), filters.limit, filters.offset);
  }

  async getHandlerVersion(identity: SpaceUserIdentity, connectionId: string, versionId: string) {
    await this.requireConnection(identity, connectionId);
    const result = await this.db.query<HandlerVersionRow>(
      `SELECT ${HANDLER_VERSION_COLUMNS} FROM source_handler_versions
        WHERE space_id = $1 AND source_connection_id = $2 AND id = $3`,
      [identity.spaceId, connectionId, versionId],
    );
    return result.rows[0] ? handlerVersionOut(result.rows[0]) : null;
  }

  async listHandlerRuns(
    identity: SpaceUserIdentity,
    connectionId: string,
    filters: { limit: number; offset: number },
  ) {
    await this.requireConnection(identity, connectionId);
    const params = [identity.spaceId, connectionId];
    const total = await this.db.query<{ total: string }>(
      `SELECT count(*)::text AS total FROM source_handler_runs WHERE space_id = $1 AND source_connection_id = $2`,
      params,
    );
    const rows = await this.db.query<HandlerRunRow>(
      `SELECT ${HANDLER_RUN_COLUMNS} FROM source_handler_runs
        WHERE space_id = $1 AND source_connection_id = $2
        ORDER BY created_at DESC
        LIMIT $3 OFFSET $4`,
      [...params, filters.limit, filters.offset],
    );
    return page(rows.rows.map(handlerRunOut), countFromRow(total.rows[0]), filters.limit, filters.offset);
  }

  async getHandlerRun(identity: SpaceUserIdentity, connectionId: string, runId: string) {
    await this.requireConnection(identity, connectionId);
    const result = await this.db.query<HandlerRunRow>(
      `SELECT ${HANDLER_RUN_COLUMNS} FROM source_handler_runs
        WHERE space_id = $1 AND source_connection_id = $2 AND id = $3`,
      [identity.spaceId, connectionId, runId],
    );
    return result.rows[0] ? handlerRunOut(result.rows[0]) : null;
  }

  /**
   * Combined Source Detail read model: active handler version (if any),
   * most recent run, repair status, recent run failure-class breakdown, and
   * any pending proposal blocking activation. Phase 12 hardening: this is
   * the single read call an operator/admin needs to answer "why is this
   * source disabled, blocked, or proposal-gated" without cross-referencing
   * `handler-versions`/`handler-runs`/`proposals` separately.
   */
  async getHandlerSummary(identity: SpaceUserIdentity, connectionId: string) {
    await this.requireConnection(identity, connectionId);
    const connectionResult = await this.db.query<{
      active_handler_version_id: string | null;
      repair_status: string;
    }>(
      `SELECT active_handler_version_id, repair_status FROM source_connections WHERE space_id = $1 AND id = $2`,
      [identity.spaceId, connectionId],
    );
    const activeVersionId = connectionResult.rows[0]?.active_handler_version_id ?? null;
    const repairStatus = connectionResult.rows[0]?.repair_status ?? "ok";
    const activeVersion = activeVersionId
      ? await this.db.query<HandlerVersionRow>(
          `SELECT ${HANDLER_VERSION_COLUMNS} FROM source_handler_versions
            WHERE space_id = $1 AND source_connection_id = $2 AND id = $3`,
          [identity.spaceId, connectionId, activeVersionId],
        )
      : { rows: [] as HandlerVersionRow[] };
    const latestRun = await this.db.query<HandlerRunRow>(
      `SELECT ${HANDLER_RUN_COLUMNS} FROM source_handler_runs
        WHERE space_id = $1 AND source_connection_id = $2
        ORDER BY created_at DESC LIMIT 1`,
      [identity.spaceId, connectionId],
    );
    const recentRunStatusCounts = await this.db.query<{ status: string; count: string }>(
      `SELECT status, count(*)::text AS count FROM (
         SELECT status FROM source_handler_runs
          WHERE space_id = $1 AND source_connection_id = $2
          ORDER BY created_at DESC
          LIMIT 20
       ) recent
       GROUP BY status`,
      [identity.spaceId, connectionId],
    );
    // A connection can in principle have more than one handler version
    // sitting in pending_approval at once (nothing prevents generating and
    // attempting to activate a second draft before an earlier proposal is
    // resolved) — return every one still blocking activation, not just the
    // most recent, so an older still-pending proposal is never silently
    // hidden.
    const pendingProposals = await this.db.query<{
      proposal_id: string;
      proposal_type: string;
      created_at: unknown;
    }>(
      `SELECT p.id AS proposal_id, p.proposal_type, p.created_at
         FROM source_handler_versions v
         JOIN proposals p ON p.id = v.proposal_id
        WHERE v.space_id = $1 AND v.source_connection_id = $2
          AND v.status = 'pending_approval' AND p.status = 'pending'
        ORDER BY p.created_at DESC`,
      [identity.spaceId, connectionId],
    );
    return {
      active_handler_version: activeVersion.rows[0] ? handlerVersionOut(activeVersion.rows[0]) : null,
      latest_handler_run: latestRun.rows[0] ? handlerRunOut(latestRun.rows[0]) : null,
      repair_status: repairStatus,
      recent_run_status_counts: Object.fromEntries(
        recentRunStatusCounts.rows.map((row) => [row.status, Number(row.count)]),
      ),
      pending_proposals: pendingProposals.rows.map((row) => ({
        proposal_id: row.proposal_id,
        proposal_type: row.proposal_type,
        created_at: dateIso(row.created_at),
      })),
    };
  }

  async getSpacePolicy(identity: SpaceUserIdentity) {
    return spacePolicyOut(identity.spaceId, await this.getSpacePolicySettings(identity.spaceId));
  }

  async getInstanceRunnerSettings() {
    return instanceRunnerSettingsOut(this.config, await this.getInstanceRunnerSettingsRead());
  }

  async getSettings(identity: SpaceUserIdentity) {
    const [space, instance] = await Promise.all([
      this.getSpacePolicy(identity),
      this.getInstanceRunnerSettings(),
    ]);
    return {
      space,
      instance,
    };
  }

  async getEffectiveSettings(identity: SpaceUserIdentity) {
    const [space, runner] = await Promise.all([
      this.getSpacePolicy(identity),
      this.getRunnerSettingsForSpace(identity.spaceId),
    ]);
    return {
      space,
      runner,
    };
  }

  async updateInstanceRunnerSettings(
    identity: SpaceUserIdentity,
    input: CustomSourceInstanceRunnerSettingsUpdate,
  ) {
    const current = await this.getInstanceRunnerSettings();
    const next = {
      runner_enabled: input.runner_enabled ?? current.runner_enabled,
    };
    const result = await this.settingsStore.upsert(
      CUSTOM_SOURCE_INSTANCE_RUNNER_DEFINITION,
      "instance",
      next,
      { updatedByUserId: identity.userId },
    );
    return instanceRunnerSettingsOut(this.config, result);
  }

  async updateSpacePolicy(identity: SpaceUserIdentity, input: CustomSourceSpacePolicyUpdate) {
    await this.requireSpaceAdmin(identity);
    const current = spacePolicyOut(identity.spaceId, await this.getSpacePolicySettings(identity.spaceId));
    const next = {
      creator_roles: normalizeCreatorRoles(input.creator_roles ?? current.creator_roles),
      default_capture_policy: normalizeCapturePolicy(input.default_capture_policy ?? current.default_capture_policy),
      default_retention_policy: normalizeRetentionPolicy(input.default_retention_policy ?? current.default_retention_policy),
      allowed_domains: normalizeAllowedDomains(input.allowed_domains ?? current.allowed_domains),
      download_bytes_max: normalizeDownloadBytesMax(input.download_bytes_max ?? current.download_bytes_max),
      credentialed_sources_allowed: input.credentialed_sources_allowed ?? current.credentialed_sources_allowed,
      same_envelope_repair_auto_apply:
        input.same_envelope_repair_auto_apply ?? current.same_envelope_repair_auto_apply,
    };
    const result = await this.settingsStore.upsert(
      CUSTOM_SOURCE_SPACE_POLICY_DEFINITION,
      identity.spaceId,
      next,
      { updatedByUserId: identity.userId },
    );
    return spacePolicyOut(identity.spaceId, result);
  }
}
