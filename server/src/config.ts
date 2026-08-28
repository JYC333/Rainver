/**
 * Server configuration — parsed and validated from the environment at
 * startup.
 *
 * The server is the default client-facing TypeScript service. It
 * normally holds no secrets of its own. Provider/credential internal ports use
 * `SERVER_INTERNAL_TOKEN` only for service-to-service calls. This module
 * never logs that token and redacts it from config snapshot hashes.
 *
 * Beyond the validated config object, this module provides:
 * - {@link ConfigError} with a machine `code` for every validation failure.
 * - {@link ConfigSnapshot} — an immutable snapshot (schema version + content
 *   hash + load timestamp) distributed to server-owned modules via `ModuleContext`.
 * - {@link collectConfigDiagnostics} — non-fatal startup diagnostics with
 *   severity + machine codes (e.g. unrecognized `SERVER_*` variables).
 */

import { createHash } from "node:crypto";
import { resolve } from "node:path";

export interface ServerConfig {
  host: string;
  port: number;
  logLevel: string;
  requestTimeoutMs: number;
  /** Absolute path of the built-in `catalog/` directory read by the catalog module. */
  catalogRoot: string;
  /** Poll cadence for the server-owned run-event SSE edge. */
  runEventStreamPollIntervalMs: number;
  /** Page size used when the SSE edge reads run events from Postgres. */
  runEventStreamPageLimit: number;
  /** Whether outbound webhook notification egress is enabled. Disabled by default. */
  enableNotificationWebhookEgress: boolean;
  /** Exact, normalized webhook URLs allowed for outbound notification egress. */
  notificationWebhookAllowlist: string[];
  /** Maximum JSON body sent to an outbound notification webhook. */
  notificationMaxPayloadBytes: number;
  /** PostgreSQL connection string for server-owned reads/commands. */
  databaseUrl: string | null;
  /** Instance root used for provider key material and CLI credential profiles. */
  rainverHome: string;
  /** Instance-owned runtime CLI installation root. */
  cliToolsRoot: string;
  /** Immutable image used for one-shot Docker CLI execution. */
  cliSandboxImage: string;
  /** Dedicated scoped Sandbox Runner endpoint. File-capable CLIs fail closed when unavailable. */
  sandboxRunnerHost: string;
  sandboxRunnerPort: number;
  /** Compose-network hostname advertised to isolated Runner namespaces. */
  sandboxRunnerServerHost: string;
  /**
   * Fixed listen port for the provider proxy. `0` keeps the historical
   * OS-assigned port, which is reachable only inside the deployment network —
   * a paired execution host needs a published, therefore fixed, port.
   */
  providerProxyPort: number;
  /**
   * Base URL a *remote* execution host should use to reach the provider proxy,
   * when that differs from the in-network one. Unset means remote runs cannot
   * be provider-bound, and dispatch says so rather than handing out a URL the
   * host cannot resolve.
   */
  providerProxyExternalBaseUrl: string | null;
  /** Root for registered workspace directories. */
  workspaceRoot: string;
  /** Root for short-lived run sandboxes (worktrees, ephemeral working dirs). */
  sandboxRoot: string;
  /** Root for persisted artifact file storage. Artifact.storage_path is relative to this. */
  artifactStorageRoot: string;
  /** Unix socket for the host deployer process. */
  deployerSocketPath: string;
  /** Service-to-service token for internal providers/credentials ports. */
  internalToken: string | null;
  /** Google OAuth client id. Empty means Google login is disabled. */
  googleClientId: string;
  /** Google OAuth client secret. Redacted from diagnostics and snapshots. */
  googleClientSecret: string;
  /** Redirect URI registered with Google. */
  googleRedirectUri: string;
  /** Frontend base URL used for post-login redirects. */
  frontendUrl: string;
  /** Email address allowed to perform instance-level administration. */
  instanceAdminEmail: string | null;
  /** Session cookie lifetime in days. */
  sessionExpireDays: number;
  /** Server debug flag for local-only cookie defaults. */
  debug: boolean;
  dailyReportSchedulerEnabled: boolean;
  dailyReportSchedulerIntervalSeconds: number;
  automationSchedulerEnabled: boolean;
  automationSchedulerIntervalSeconds: number;
  contentAccessLogRetentionEnabled: boolean;
  contentAccessLogRetentionDays: number;
  contentAccessLogPruneIntervalSeconds: number;
  memoryMaintenanceSchedulerEnabled: boolean;
  memoryMaintenanceSchedulerIntervalSeconds: number;
  memoryMaintenanceSchedulerBatchLimit: number;
  /** ADR 0003 §2 circuit breaker: direct Agent memory writes per session. */
  memoryDirectWritesPerSession: number;
  sourceExtractionSchedulerEnabled: boolean;
  sourceExtractionSchedulerIntervalSeconds: number;
  /** Instance hard limits for Source Custom Source handler execution. Runner availability is DB-backed. */
  customSourceAllowedLanguages: string[];
  /** Additional operator-specified network deny rules, on top of the always-applied private/metadata blocks. */
  customSourceNetworkHardDenyRules: string[];
  customSourceTimeoutMsMax: number;
  customSourceOutputBytesMax: number;
  customSourceLogBytesMax: number;
  customSourceMaxFiles: number;
  customSourceBrowserAutomationAvailable: boolean;
  customSourceShellAvailable: boolean;
  customSourceDependencyInstallationAvailable: boolean;
  /** Instance hard limit: max generate-handler/repair calls per connection per rolling hour. */
  customSourceGenerateRateLimitPerHour: number;
  customSourceArtifactRetentionEnabled: boolean;
  customSourceArtifactRetentionDays: number;
  customSourceArtifactRetentionIntervalSeconds: number;
  /** Legacy env gate parsed for older env files; route enablement is space-scoped. */
  retrievalRerankEnabled: boolean;
  /** Legacy env gate parsed for older env files; route enablement is space-scoped. */
  retrievalQueryRewriteEnabled: boolean;
  rainverEnv: string;
  appVersion: string | null;
  backupEnabled: boolean;
  backupIntervalHours: number;
  backupRetentionCount: number;
  backupIncludeLogs: boolean;
  backupOnStartup: boolean;
  backupRoot: string;
  backupAcceptNoBackup: boolean;
  /** Full-privilege database URL used only for full-system backup dumps. */
  backupDatabaseUrl: string | null;
}

export interface RawEnv {
  [key: string]: string | undefined;
}

const VALID_LOG_LEVELS = new Set([
  "fatal",
  "error",
  "warn",
  "info",
  "debug",
  "trace",
  "silent",
]);

/** Environment variables this config recognizes (used by diagnostics). */
const KNOWN_ENV_KEYS = new Set([
  "SERVER_LOG_LEVEL",
  "SERVER_REQUEST_TIMEOUT_MS",
  "SERVER_CATALOG_ROOT",
  "SERVER_RUN_EVENT_STREAM_POLL_INTERVAL_MS",
  "SERVER_RUN_EVENT_STREAM_PAGE_LIMIT",
  "SERVER_ENABLE_NOTIFICATION_WEBHOOK_EGRESS",
  "SERVER_NOTIFICATION_WEBHOOK_ALLOWLIST",
  "SERVER_NOTIFICATION_MAX_PAYLOAD_BYTES",
  "SERVER_DATABASE_URL",
  "RAINVER_HOME",
  "RUNTIME_TOOLS_ROOT",
  "SERVER_CLI_SANDBOX_IMAGE",
  "SANDBOX_RUNNER_HOST",
  "SANDBOX_RUNNER_PORT",
  "SANDBOX_RUNNER_SERVER_HOST",
  "WORKSPACE_ROOT",
  "SANDBOX_ROOT",
  "ARTIFACT_STORAGE_ROOT",
  "DEPLOYER_SOCKET_PATH",
  "SERVER_INTERNAL_TOKEN",
  "GOOGLE_CLIENT_ID",
  "GOOGLE_CLIENT_SECRET",
  "GOOGLE_REDIRECT_URI",
  "FRONTEND_URL",
  "INSTANCE_ADMIN_EMAIL",
  "SESSION_EXPIRE_DAYS",
  "SERVER_DEBUG",
  "DEBUG",
  "SERVER_DAILY_REPORT_SCHEDULER_ENABLED",
  "SERVER_DAILY_REPORT_SCHEDULER_INTERVAL_SECONDS",
  "SERVER_AUTOMATION_SCHEDULER_ENABLED",
  "SERVER_AUTOMATION_SCHEDULER_INTERVAL_SECONDS",
  "SERVER_CONTENT_ACCESS_LOG_RETENTION_ENABLED",
  "SERVER_CONTENT_ACCESS_LOG_RETENTION_DAYS",
  "SERVER_CONTENT_ACCESS_LOG_PRUNE_INTERVAL_SECONDS",
  "SERVER_MEMORY_MAINTENANCE_SCHEDULER_ENABLED",
  "SERVER_MEMORY_MAINTENANCE_SCHEDULER_INTERVAL_SECONDS",
  "SERVER_MEMORY_MAINTENANCE_SCHEDULER_BATCH_LIMIT",
  "SERVER_SOURCE_EXTRACTION_SCHEDULER_ENABLED",
  "SERVER_SOURCE_EXTRACTION_SCHEDULER_INTERVAL_SECONDS",
  "SERVER_CUSTOM_SOURCE_ALLOWED_LANGUAGES",
  "SERVER_CUSTOM_SOURCE_NETWORK_HARD_DENY_RULES",
  "SERVER_CUSTOM_SOURCE_TIMEOUT_MS_MAX",
  "SERVER_CUSTOM_SOURCE_OUTPUT_BYTES_MAX",
  "SERVER_CUSTOM_SOURCE_LOG_BYTES_MAX",
  "SERVER_CUSTOM_SOURCE_MAX_FILES",
  "SERVER_CUSTOM_SOURCE_BROWSER_AUTOMATION_AVAILABLE",
  "SERVER_CUSTOM_SOURCE_SHELL_AVAILABLE",
  "SERVER_CUSTOM_SOURCE_DEPENDENCY_INSTALLATION_AVAILABLE",
  "SERVER_CUSTOM_SOURCE_GENERATE_RATE_LIMIT_PER_HOUR",
  "SERVER_CUSTOM_SOURCE_ARTIFACT_RETENTION_ENABLED",
  "SERVER_CUSTOM_SOURCE_ARTIFACT_RETENTION_DAYS",
  "SERVER_CUSTOM_SOURCE_ARTIFACT_RETENTION_INTERVAL_SECONDS",
  "RAINVER_ENV",
  "APP_VERSION",
  "BACKUP_ENABLED",
  "BACKUP_INTERVAL_HOURS",
  "BACKUP_RETENTION_COUNT",
  "BACKUP_INCLUDE_LOGS",
  "BACKUP_ON_STARTUP",
  "BACKUP_ROOT",
  "BACKUP_ACCEPT_NO_BACKUP",
  "BACKUP_DATABASE_URL",
]);

export class ConfigError extends Error {
  /** Machine-readable error code (e.g. `invalid_log_level`). */
  readonly code: string;

  constructor(message: string, code = "invalid_config") {
    super(message);
    this.name = "ConfigError";
    this.code = code;
  }
}

function parseBool(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value === "") return fallback;
  const v = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(v)) return true;
  if (["0", "false", "no", "off"].includes(v)) return false;
  throw new ConfigError(
    `Invalid boolean value: ${JSON.stringify(value)}`,
    "invalid_boolean",
  );
}

function parseIntStrict(
  value: string | undefined,
  fallback: number,
  name: string,
): number {
  if (value === undefined || value === "") return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) {
    throw new ConfigError(
      `${name} must be a positive integer, got ${JSON.stringify(value)}`,
      "invalid_positive_integer",
    );
  }
  return n;
}

function parseBoundedInt(
  value: string | undefined,
  fallback: number,
  name: string,
  min: number,
  max: number,
): number {
  const n = parseIntStrict(value, fallback, name);
  if (n < min || n > max) {
    throw new ConfigError(
      `${name} must be between ${min} and ${max}, got ${JSON.stringify(n)}`,
      "invalid_bounded_integer",
    );
  }
  return n;
}

function validateHttpBaseUrl(value: string, name: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ConfigError(
      `${name} is not a valid URL: ${JSON.stringify(value)}`,
      "invalid_base_url",
    );
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new ConfigError(
      `${name} must be http(s), got ${JSON.stringify(url.protocol)}`,
      "invalid_url_protocol",
    );
  }
  // Normalise: drop a trailing slash so we can concatenate request paths cleanly.
  return value.replace(/\/+$/, "");
}

function normalizeEmail(value: string | undefined): string | null {
  const normalized = value?.trim().toLowerCase() ?? "";
  return normalized || null;
}

function isLocalHttpWebhookHost(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
}

function normalizeWebhookUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ConfigError(
      `Notification webhook URL is not valid: ${JSON.stringify(value)}`,
      "invalid_notification_webhook_url",
    );
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new ConfigError(
      `Notification webhook URL must be http(s), got ${JSON.stringify(url.protocol)}`,
      "invalid_notification_webhook_protocol",
    );
  }
  if (url.protocol === "http:" && !isLocalHttpWebhookHost(url.hostname)) {
    throw new ConfigError(
      "Notification webhook URL may use http only for localhost targets",
      "insecure_notification_webhook_url",
    );
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new ConfigError(
      "Notification webhook URL must not include credentials, query strings, or fragments",
      "secret_bearing_notification_webhook_url",
    );
  }
  return url.toString();
}

/** Comma-separated list parser. Returns `null` (not `[]`) when unset, so callers can fall back to a default list. */
function parseStringList(value: string | undefined): string[] | null {
  if (value === undefined || value.trim() === "") return null;
  return [
    ...new Set(
      value
        .split(",")
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0),
    ),
  ];
}

function parseWebhookAllowlist(value: string | undefined): string[] {
  if (value === undefined || value.trim() === "") return [];
  const urls = value
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .map(normalizeWebhookUrl);
  return [...new Set(urls)].sort();
}

function validateDatabaseUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ConfigError(
      "SERVER_DATABASE_URL is not a valid URL",
      "invalid_database_url",
    );
  }
  if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") {
    throw new ConfigError(
      `SERVER_DATABASE_URL must be postgres(ql)://, got ${JSON.stringify(url.protocol)}`,
      "invalid_database_url_protocol",
    );
  }
  return value;
}

function validateConfigSemantics(config: ServerConfig): void {
  if (
    config.enableNotificationWebhookEgress &&
    config.notificationWebhookAllowlist.length === 0
  ) {
    throw new ConfigError(
      "SERVER_NOTIFICATION_WEBHOOK_ALLOWLIST is required when notification webhook egress is enabled",
      "missing_notification_webhook_allowlist",
    );
  }
}

/**
 * Build a validated config from an environment map. Throws {@link ConfigError}
 * on any invalid value (fail-fast).
 */
export function loadConfig(env: RawEnv = process.env): ServerConfig {
  const host = "0.0.0.0";
  const port = 8010;
  const logLevel = (env.SERVER_LOG_LEVEL?.trim() || "info").toLowerCase();
  if (!VALID_LOG_LEVELS.has(logLevel)) {
    throw new ConfigError(
      `SERVER_LOG_LEVEL must be one of ${[...VALID_LOG_LEVELS].join(", ")}, got ${JSON.stringify(logLevel)}`,
      "invalid_log_level",
    );
  }
  const requestTimeoutMs = parseIntStrict(
    env.SERVER_REQUEST_TIMEOUT_MS,
    300_000,
    "SERVER_REQUEST_TIMEOUT_MS",
  );
  // Default: the repo/image layout places `catalog/` next to `server/`
  // (locally: <repo>/catalog; in the image: /app/catalog with cwd /app/server).
  const catalogRoot = resolve(
    env.SERVER_CATALOG_ROOT?.trim() || resolve(process.cwd(), "..", "catalog"),
  );
  const runEventStreamPollIntervalMs = parseBoundedInt(
    env.SERVER_RUN_EVENT_STREAM_POLL_INTERVAL_MS,
    1_000,
    "SERVER_RUN_EVENT_STREAM_POLL_INTERVAL_MS",
    100,
    60_000,
  );
  const runEventStreamPageLimit = parseBoundedInt(
    env.SERVER_RUN_EVENT_STREAM_PAGE_LIMIT,
    100,
    "SERVER_RUN_EVENT_STREAM_PAGE_LIMIT",
    1,
    500,
  );
  const enableNotificationWebhookEgress = parseBool(
    env.SERVER_ENABLE_NOTIFICATION_WEBHOOK_EGRESS,
    false,
  );
  const notificationWebhookAllowlist = parseWebhookAllowlist(
    env.SERVER_NOTIFICATION_WEBHOOK_ALLOWLIST,
  );
  const notificationMaxPayloadBytes = parseBoundedInt(
    env.SERVER_NOTIFICATION_MAX_PAYLOAD_BYTES,
    64 * 1024,
    "SERVER_NOTIFICATION_MAX_PAYLOAD_BYTES",
    1_024,
    1024 * 1024,
  );
  const rawDatabaseUrl = env.SERVER_DATABASE_URL?.trim();
  const databaseUrl = rawDatabaseUrl ? validateDatabaseUrl(rawDatabaseUrl) : null;
  const rainverHome = resolve(env.RAINVER_HOME?.trim() || "/rainver");
  const cliToolsRoot = resolve(
    env.RUNTIME_TOOLS_ROOT?.trim() || resolve(rainverHome, "runtime-tools"),
  );
  const cliSandboxImage = env.SERVER_CLI_SANDBOX_IMAGE?.trim() || "rainver-sandbox";
  if (!/^[A-Za-z0-9][A-Za-z0-9_.:/@-]*$/.test(cliSandboxImage)) {
    throw new ConfigError(
      "SERVER_CLI_SANDBOX_IMAGE must be a valid local image reference",
      "invalid_sandbox_image",
    );
  }
  const sandboxRunnerHost = env.SANDBOX_RUNNER_HOST?.trim() || "sandbox-runner";
  if (!/^[A-Za-z0-9.-]+$/.test(sandboxRunnerHost)) {
    throw new ConfigError("SANDBOX_RUNNER_HOST must be a hostname", "invalid_sandbox_runner_host");
  }
  const sandboxRunnerPort = parseBoundedInt(
    env.SANDBOX_RUNNER_PORT,
    8020,
    "SANDBOX_RUNNER_PORT",
    1,
    65_535,
  );
  const sandboxRunnerServerHost = env.SANDBOX_RUNNER_SERVER_HOST?.trim() || "server";
  if (!/^[A-Za-z0-9.-]+$/.test(sandboxRunnerServerHost)) {
    throw new ConfigError("SANDBOX_RUNNER_SERVER_HOST must be a hostname", "invalid_sandbox_runner_server_host");
  }
  const providerProxyPort = parseBoundedInt(
    env.PROVIDER_PROXY_PORT,
    0,
    "PROVIDER_PROXY_PORT",
    0,
    65_535,
  );
  const rawProviderProxyExternalBaseUrl = env.PROVIDER_PROXY_EXTERNAL_BASE_URL?.trim();
  const providerProxyExternalBaseUrl = rawProviderProxyExternalBaseUrl
    ? validateHttpBaseUrl(rawProviderProxyExternalBaseUrl, "PROVIDER_PROXY_EXTERNAL_BASE_URL")
    : null;
  if (providerProxyExternalBaseUrl) {
    // The external URL names a port that has to stay the same across restarts
    // for a daemon to keep reaching it, and an OS-assigned one does not.
    if (providerProxyPort === 0) {
      throw new ConfigError(
        "PROVIDER_PROXY_EXTERNAL_BASE_URL requires a fixed PROVIDER_PROXY_PORT",
        "provider_proxy_external_requires_fixed_port",
      );
    }
    // Deliberately not required to name the same port: a container port is
    // routinely remapped on the host (`18021:8021`), and that address is
    // perfectly reachable. What cannot work is an OS-assigned listen port,
    // which the check above catches.
  }
  const workspaceRoot = resolve(
    env.WORKSPACE_ROOT?.trim() || resolve(rainverHome, "workspaces"),
  );
  // Keep ephemeral dirs and workspace worktrees under one sandbox root.
  const sandboxRoot = resolve(
    env.SANDBOX_ROOT?.trim() || resolve(rainverHome, "sandboxes"),
  );
  const artifactStorageRoot = resolve(
    env.ARTIFACT_STORAGE_ROOT?.trim() || resolve(rainverHome, "storage", "artifacts"),
  );
  const deployerSocketPath = resolve(
    env.DEPLOYER_SOCKET_PATH?.trim() || resolve(rainverHome, "run", "deployer.sock"),
  );
  const internalToken = env.SERVER_INTERNAL_TOKEN?.trim() || null;
  const googleClientId = env.GOOGLE_CLIENT_ID?.trim() || "";
  const googleClientSecret = env.GOOGLE_CLIENT_SECRET?.trim() || "";
  const googleRedirectUri =
    env.GOOGLE_REDIRECT_URI?.trim() ||
    "http://localhost:5173/api/v1/auth/google/callback";
  const frontendUrl = validateHttpBaseUrl(
    env.FRONTEND_URL?.trim() || "http://localhost:5173",
    "FRONTEND_URL",
  );
  const instanceAdminEmail = normalizeEmail(env.INSTANCE_ADMIN_EMAIL);
  const sessionExpireDays = parseIntStrict(
    env.SESSION_EXPIRE_DAYS,
    30,
    "SESSION_EXPIRE_DAYS",
  );
  const debug = parseBool(env.SERVER_DEBUG ?? env.DEBUG, false);
  const dailyReportSchedulerEnabled = parseBool(
    env.SERVER_DAILY_REPORT_SCHEDULER_ENABLED,
    true,
  );
  const dailyReportSchedulerIntervalSeconds = parseBoundedInt(
    env.SERVER_DAILY_REPORT_SCHEDULER_INTERVAL_SECONDS,
    60,
    "SERVER_DAILY_REPORT_SCHEDULER_INTERVAL_SECONDS",
    30,
    86_400,
  );
  const automationSchedulerEnabled = parseBool(
    env.SERVER_AUTOMATION_SCHEDULER_ENABLED,
    true,
  );
  const automationSchedulerIntervalSeconds = parseBoundedInt(
    env.SERVER_AUTOMATION_SCHEDULER_INTERVAL_SECONDS,
    60,
    "SERVER_AUTOMATION_SCHEDULER_INTERVAL_SECONDS",
    30,
    86_400,
  );
  const contentAccessLogRetentionEnabled = parseBool(
    env.SERVER_CONTENT_ACCESS_LOG_RETENTION_ENABLED,
    true,
  );
  const contentAccessLogRetentionDays = parseBoundedInt(
    env.SERVER_CONTENT_ACCESS_LOG_RETENTION_DAYS,
    90,
    "SERVER_CONTENT_ACCESS_LOG_RETENTION_DAYS",
    1,
    3650,
  );
  const contentAccessLogPruneIntervalSeconds = parseBoundedInt(
    env.SERVER_CONTENT_ACCESS_LOG_PRUNE_INTERVAL_SECONDS,
    3600,
    "SERVER_CONTENT_ACCESS_LOG_PRUNE_INTERVAL_SECONDS",
    300,
    86_400,
  );
  const memoryMaintenanceSchedulerEnabled = parseBool(
    env.SERVER_MEMORY_MAINTENANCE_SCHEDULER_ENABLED,
    true,
  );
  const memoryMaintenanceSchedulerIntervalSeconds = parseBoundedInt(
    env.SERVER_MEMORY_MAINTENANCE_SCHEDULER_INTERVAL_SECONDS,
    900,
    "SERVER_MEMORY_MAINTENANCE_SCHEDULER_INTERVAL_SECONDS",
    60,
    86_400,
  );
  const memoryMaintenanceSchedulerBatchLimit = parseBoundedInt(
    env.SERVER_MEMORY_MAINTENANCE_SCHEDULER_BATCH_LIMIT,
    5,
    "SERVER_MEMORY_MAINTENANCE_SCHEDULER_BATCH_LIMIT",
    1,
    100,
  );
  // Not a budget on remembering — a fault detector. The number is set where a
  // real session never reaches it and a loop does within one turn.
  const memoryDirectWritesPerSession = parseBoundedInt(
    env.SERVER_MEMORY_DIRECT_WRITES_PER_SESSION,
    50,
    "SERVER_MEMORY_DIRECT_WRITES_PER_SESSION",
    1,
    1000,
  );
  const sourceExtractionSchedulerEnabled = parseBool(
    env.SERVER_SOURCE_EXTRACTION_SCHEDULER_ENABLED,
    true,
  );
  const sourceExtractionSchedulerIntervalSeconds = parseBoundedInt(
    env.SERVER_SOURCE_EXTRACTION_SCHEDULER_INTERVAL_SECONDS,
    30,
    "SERVER_SOURCE_EXTRACTION_SCHEDULER_INTERVAL_SECONDS",
    5,
    3600,
  );
  // Source Custom Source runner/sandbox instance hard limits. Runner
  // availability itself is DB-backed through Instance Settings.
  const customSourceAllowedLanguages = parseStringList(env.SERVER_CUSTOM_SOURCE_ALLOWED_LANGUAGES) ?? [
    "typescript_node",
    "declarative_pipeline_v1",
  ];
  const customSourceNetworkHardDenyRules =
    parseStringList(env.SERVER_CUSTOM_SOURCE_NETWORK_HARD_DENY_RULES) ?? [];
  const customSourceTimeoutMsMax = parseBoundedInt(
    env.SERVER_CUSTOM_SOURCE_TIMEOUT_MS_MAX,
    30_000,
    "SERVER_CUSTOM_SOURCE_TIMEOUT_MS_MAX",
    1_000,
    300_000,
  );
  const customSourceOutputBytesMax = parseBoundedInt(
    env.SERVER_CUSTOM_SOURCE_OUTPUT_BYTES_MAX,
    1_048_576,
    "SERVER_CUSTOM_SOURCE_OUTPUT_BYTES_MAX",
    1_024,
    104_857_600,
  );
  const customSourceLogBytesMax = parseBoundedInt(
    env.SERVER_CUSTOM_SOURCE_LOG_BYTES_MAX,
    65_536,
    "SERVER_CUSTOM_SOURCE_LOG_BYTES_MAX",
    1_024,
    10_485_760,
  );
  const customSourceMaxFiles = parseBoundedInt(
    env.SERVER_CUSTOM_SOURCE_MAX_FILES,
    50,
    "SERVER_CUSTOM_SOURCE_MAX_FILES",
    1,
    1_000,
  );
  const customSourceBrowserAutomationAvailable = parseBool(
    env.SERVER_CUSTOM_SOURCE_BROWSER_AUTOMATION_AVAILABLE,
    false,
  );
  const customSourceShellAvailable = parseBool(env.SERVER_CUSTOM_SOURCE_SHELL_AVAILABLE, false);
  const customSourceDependencyInstallationAvailable = parseBool(
    env.SERVER_CUSTOM_SOURCE_DEPENDENCY_INSTALLATION_AVAILABLE,
    false,
  );
  const customSourceGenerateRateLimitPerHour = parseBoundedInt(
    env.SERVER_CUSTOM_SOURCE_GENERATE_RATE_LIMIT_PER_HOUR,
    30,
    "SERVER_CUSTOM_SOURCE_GENERATE_RATE_LIMIT_PER_HOUR",
    1,
    1_000,
  );
  const customSourceArtifactRetentionEnabled = parseBool(
    env.SERVER_CUSTOM_SOURCE_ARTIFACT_RETENTION_ENABLED,
    true,
  );
  const customSourceArtifactRetentionDays = parseBoundedInt(
    env.SERVER_CUSTOM_SOURCE_ARTIFACT_RETENTION_DAYS,
    30,
    "SERVER_CUSTOM_SOURCE_ARTIFACT_RETENTION_DAYS",
    1,
    3650,
  );
  const customSourceArtifactRetentionIntervalSeconds = parseBoundedInt(
    env.SERVER_CUSTOM_SOURCE_ARTIFACT_RETENTION_INTERVAL_SECONDS,
    3600,
    "SERVER_CUSTOM_SOURCE_ARTIFACT_RETENTION_INTERVAL_SECONDS",
    300,
    86_400,
  );
  // Legacy compatibility for pre-space-setting local env files. The active
  // retrieval LLM-stage gate is the `retrieval.space.settings` scoped setting;
  // these keys remain deliberately absent from KNOWN_ENV_KEYS.
  const retrievalRerankEnabled = parseBool(env.SERVER_RETRIEVAL_RERANK_ENABLED, false);
  const retrievalQueryRewriteEnabled = parseBool(env.SERVER_RETRIEVAL_QUERY_REWRITE_ENABLED, false);
  const rainverEnv = env.RAINVER_ENV?.trim() || "";
  const appVersion = env.APP_VERSION?.trim() || null;
  const backupEnabled = parseBool(env.BACKUP_ENABLED, false);
  const backupIntervalHours = parseBoundedInt(
    env.BACKUP_INTERVAL_HOURS,
    24,
    "BACKUP_INTERVAL_HOURS",
    1,
    168,
  );
  const backupRetentionCount = parseBoundedInt(
    env.BACKUP_RETENTION_COUNT,
    7,
    "BACKUP_RETENTION_COUNT",
    1,
    365,
  );
  const backupIncludeLogs = parseBool(env.BACKUP_INCLUDE_LOGS, false);
  const backupOnStartup = parseBool(env.BACKUP_ON_STARTUP, true);
  const backupRoot = resolve(
    env.BACKUP_ROOT?.trim() || resolve(rainverHome, "backups"),
  );
  const backupAcceptNoBackup = parseBool(env.BACKUP_ACCEPT_NO_BACKUP, false);
  const backupDatabaseUrl = env.BACKUP_DATABASE_URL?.trim() || null;

  const config: ServerConfig = {
    host,
    port,
    logLevel,
    requestTimeoutMs,
    catalogRoot,
    runEventStreamPollIntervalMs,
    runEventStreamPageLimit,
    enableNotificationWebhookEgress,
    notificationWebhookAllowlist,
    notificationMaxPayloadBytes,
    databaseUrl,
    rainverHome,
    cliToolsRoot,
    cliSandboxImage,
    sandboxRunnerHost,
    sandboxRunnerPort,
    sandboxRunnerServerHost,
    providerProxyPort,
    providerProxyExternalBaseUrl,
    workspaceRoot,
    sandboxRoot,
    artifactStorageRoot,
    deployerSocketPath,
    internalToken,
    googleClientId,
    googleClientSecret,
    googleRedirectUri,
    frontendUrl,
    instanceAdminEmail,
    sessionExpireDays,
    debug,
    dailyReportSchedulerEnabled,
    dailyReportSchedulerIntervalSeconds,
    automationSchedulerEnabled,
    automationSchedulerIntervalSeconds,
    contentAccessLogRetentionEnabled,
    contentAccessLogRetentionDays,
    contentAccessLogPruneIntervalSeconds,
    memoryMaintenanceSchedulerEnabled,
    memoryMaintenanceSchedulerIntervalSeconds,
    memoryMaintenanceSchedulerBatchLimit,
    memoryDirectWritesPerSession,
    sourceExtractionSchedulerEnabled,
    sourceExtractionSchedulerIntervalSeconds,
    customSourceAllowedLanguages,
    customSourceNetworkHardDenyRules,
    customSourceTimeoutMsMax,
    customSourceOutputBytesMax,
    customSourceLogBytesMax,
    customSourceMaxFiles,
    customSourceBrowserAutomationAvailable,
    customSourceShellAvailable,
    customSourceDependencyInstallationAvailable,
    customSourceGenerateRateLimitPerHour,
    customSourceArtifactRetentionEnabled,
    customSourceArtifactRetentionDays,
    customSourceArtifactRetentionIntervalSeconds,
    retrievalRerankEnabled,
    retrievalQueryRewriteEnabled,
    rainverEnv,
    appVersion,
    backupEnabled,
    backupIntervalHours,
    backupRetentionCount,
    backupIncludeLogs,
    backupOnStartup,
    backupRoot,
    backupAcceptNoBackup,
    backupDatabaseUrl,
  };
  validateConfigSemantics(config);
  return config;
}

/** A one-line, secret-free description of the effective config for startup logs. */
export function describeConfig(config: ServerConfig): string {
  return [
    `host=${config.host}`,
    `port=${config.port}`,
    `logLevel=${config.logLevel}`,
    `requestTimeoutMs=${config.requestTimeoutMs}`,
    `catalogRoot=${config.catalogRoot}`,
    `runEventStreamPollIntervalMs=${config.runEventStreamPollIntervalMs}`,
    `runEventStreamPageLimit=${config.runEventStreamPageLimit}`,
    `notificationWebhookEgress=${config.enableNotificationWebhookEgress}`,
    `notificationWebhookAllowlistCount=${config.notificationWebhookAllowlist.length}`,
    `notificationMaxPayloadBytes=${config.notificationMaxPayloadBytes}`,
    `rainverHome=${config.rainverHome}`,
    `cliToolsRoot=${config.cliToolsRoot}`,
    `cliSandboxImage=${config.cliSandboxImage}`,
    `workspaceRoot=${config.workspaceRoot}`,
    `sandboxRoot=${config.sandboxRoot}`,
    `artifactStorageRoot=${config.artifactStorageRoot}`,
    `deployerSocketPath=${config.deployerSocketPath}`,
    `internalTokenConfigured=${config.internalToken !== null}`,
    `googleOAuthConfigured=${Boolean(config.googleClientId && config.googleClientSecret)}`,
    `frontendUrl=${config.frontendUrl}`,
    `instanceAdminConfigured=${config.instanceAdminEmail !== null}`,
    `sessionExpireDays=${config.sessionExpireDays}`,
    `debug=${config.debug}`,
    // The connection string may embed a password — never print it.
    `databaseUrlConfigured=${config.databaseUrl !== null}`,
    `backupDatabaseUrlConfigured=${config.backupDatabaseUrl !== null}`,
  ].join(" ");
}

// ---------------------------------------------------------------------------
// Immutable config snapshot
// ---------------------------------------------------------------------------

/** Bumped when the shape of {@link ServerConfig} changes incompatibly. */
export const CONFIG_SCHEMA_VERSION = 22 as const;

/**
 * An immutable, hash-identified view of the validated config. Built once at
 * startup and handed to every server-owned module via `ModuleContext`. The hash is
 * deterministic over the config content (it excludes `loaded_at`), so two
 * snapshots of the same config always agree.
 */
export interface ConfigSnapshot {
  schema_version: typeof CONFIG_SCHEMA_VERSION;
  /** SHA-256 hex of the canonical (key-sorted) config JSON with secrets redacted. */
  content_hash: string;
  /** ISO-8601 timestamp of when this snapshot was created. */
  loaded_at: string;
  config: Readonly<ServerConfig>;
}

function canonicalConfigJson(config: ServerConfig): string {
  const record = config as unknown as Record<string, unknown>;
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(record).sort()) {
    sorted[key] =
      key === "internalToken" || key === "googleClientSecret" || key === "backupDatabaseUrl"
        ? "<redacted>"
        : record[key];
  }
  return JSON.stringify(sorted);
}

export function createConfigSnapshot(
  config: ServerConfig,
  now: () => Date = () => new Date(),
): ConfigSnapshot {
  const frozen = Object.freeze({ ...config });
  return Object.freeze({
    schema_version: CONFIG_SCHEMA_VERSION,
    content_hash: createHash("sha256").update(canonicalConfigJson(frozen)).digest("hex"),
    loaded_at: now().toISOString(),
    config: frozen,
  });
}

/** Load + validate config from the environment and wrap it in a snapshot. */
export function loadConfigSnapshot(env: RawEnv = process.env): ConfigSnapshot {
  return createConfigSnapshot(loadConfig(env));
}

// ---------------------------------------------------------------------------
// Startup diagnostics
// ---------------------------------------------------------------------------

export type ConfigDiagnosticSeverity = "info" | "warning" | "error" | "fatal";

export interface ConfigDiagnostic {
  severity: ConfigDiagnosticSeverity;
  /** Machine-readable code (e.g. `unknown_config_key`). */
  code: string;
  message: string;
}

/**
 * Non-fatal configuration diagnostics. Flags `SERVER_*` variables this config
 * does not recognize (likely typos). Fatal problems are not diagnostics — they
 * throw {@link ConfigError} in {@link loadConfig}.
 */
export function collectConfigDiagnostics(
  env: RawEnv = process.env,
  config?: ServerConfig,
): ConfigDiagnostic[] {
  const diagnostics: ConfigDiagnostic[] = [];
  for (const key of Object.keys(env).sort()) {
    if (!key.startsWith("SERVER_")) continue;
    if (KNOWN_ENV_KEYS.has(key)) continue;
    diagnostics.push({
      severity: "warning",
      code: "unknown_config_key",
      message: `Unrecognized environment variable ${key} (ignored)`,
    });
  }
  if (config) {
    if (
      config.notificationWebhookAllowlist.length > 0 &&
      !config.enableNotificationWebhookEgress
    ) {
      diagnostics.push({
        severity: "info",
        code: "notification_webhook_allowlist_inactive",
        message:
          "Notification webhook allowlist is configured but egress is disabled",
      });
    }
    if (config.requestTimeoutMs <= config.runEventStreamPollIntervalMs) {
      diagnostics.push({
        severity: "warning",
        code: "stream_poll_interval_exceeds_timeout",
        message:
          "Run-event stream poll interval is greater than or equal to the request timeout",
      });
    }
    diagnostics.push({
      severity: "info",
      code: "proposals_server_authority",
      message:
        "Proposal review and supported proposal apply routes are served by the fixed server authority",
    });
    diagnostics.push({
      severity: "info",
      code: "room_conversation_server_authority",
      message:
        "Room conversation turns are served by the fixed server authority",
    });
    diagnostics.push({
      severity: "info",
      code: "context_assembly_server_authority",
      message:
        "Chat-path and full-run context assembly are served by the fixed server authority",
    });
    diagnostics.push({
      severity: "info",
      code: "memory_server_authority",
      message:
        "Memory read routes, public memory proposal creation, and supported active-memory apply are served by the fixed server authority",
    });
  }
  return diagnostics;
}
