import { describe, it, expect } from "vitest";
import {
  collectConfigDiagnostics,
  ConfigError,
  createConfigSnapshot,
  describeConfig,
  loadConfig,
  loadConfigSnapshot,
} from "../src/config.js";

describe("loadConfig", () => {
  it("applies documented defaults from an empty env", () => {
    const c = loadConfig({});
    expect(c.host).toBe("0.0.0.0");
    expect(c.port).toBe(8010);
    expect(c.logLevel).toBe("info");
    expect(c.requestTimeoutMs).toBe(300000);
    expect(c.runEventStreamPollIntervalMs).toBe(1000);
    expect(c.runEventStreamPageLimit).toBe(100);
    expect(c.enableNotificationWebhookEgress).toBe(false);
    expect(c.notificationWebhookAllowlist).toEqual([]);
    expect(c.notificationMaxPayloadBytes).toBe(65536);
    expect(c.backupDatabaseUrl).toBeNull();
    expect(c.rainverHome).toBe("/rainver");
    expect(c.cliToolsRoot).toBe("/rainver/runtime-tools");
    expect(c.cliSandboxImage).toBe("rainver-sandbox");
    expect(c.workspaceRoot).toBe("/rainver/workspaces");
    expect(c.artifactStorageRoot).toBe("/rainver/storage/artifacts");
    expect(c.deployerSocketPath).toBe("/rainver/run/deployer.sock");
    expect(c.internalToken).toBeNull();
    expect(c.googleClientId).toBe("");
    expect(c.googleClientSecret).toBe("");
    expect(c.googleRedirectUri).toBe("http://localhost:5173/api/v1/auth/google/callback");
    expect(c.frontendUrl).toBe("http://localhost:5173");
    expect(c.instanceAdminEmail).toBeNull();
    expect(c.sessionExpireDays).toBe(30);
    expect(c.debug).toBe(false);
  });

  it("honors SERVER_* overrides and normalizes a trailing slash", () => {
    const c = loadConfig({
      SERVER_LOG_LEVEL: "debug",
      SERVER_REQUEST_TIMEOUT_MS: "1000",
      SERVER_RUN_EVENT_STREAM_POLL_INTERVAL_MS: "250",
      SERVER_RUN_EVENT_STREAM_PAGE_LIMIT: "25",
      SERVER_ENABLE_NOTIFICATION_WEBHOOK_EGRESS: "true",
      SERVER_NOTIFICATION_WEBHOOK_ALLOWLIST: "https://hooks.example.com/proposal",
      SERVER_NOTIFICATION_MAX_PAYLOAD_BYTES: "4096",
      SERVER_DATABASE_URL: "postgresql://server@db:5432/rainver",
      BACKUP_DATABASE_URL: "postgresql://backup:secret@db:5432/rainver",
      SERVER_INTERNAL_TOKEN: "service-token",
      GOOGLE_CLIENT_ID: "google-client",
      GOOGLE_CLIENT_SECRET: "google-secret",
      GOOGLE_REDIRECT_URI: "http://localhost:8010/api/v1/auth/google/callback",
      FRONTEND_URL: "http://localhost:5173/",
      INSTANCE_ADMIN_EMAIL: "Owner@Example.COM ",
      SESSION_EXPIRE_DAYS: "7",
      SERVER_DEBUG: "true",
      RAINVER_HOME: "/tmp/rainver",
      RUNTIME_TOOLS_ROOT: "/tmp/rainver/tools",
      SERVER_CLI_SANDBOX_IMAGE: "registry.example.com/rainver-sandbox:v1",
      WORKSPACE_ROOT: "/tmp/rainver/workspaces-root",
      ARTIFACT_STORAGE_ROOT: "/tmp/rainver/artifacts-root",
      DEPLOYER_SOCKET_PATH: "/tmp/rainver/run/deployer.sock",
    });
    expect(c.host).toBe("0.0.0.0");
    expect(c.port).toBe(8010);
    expect(c.logLevel).toBe("debug");
    expect(c.requestTimeoutMs).toBe(1000);
    expect(c.runEventStreamPollIntervalMs).toBe(250);
    expect(c.runEventStreamPageLimit).toBe(25);
    expect(c.enableNotificationWebhookEgress).toBe(true);
    expect(c.notificationWebhookAllowlist).toEqual([
      "https://hooks.example.com/proposal",
    ]);
    expect(c.notificationMaxPayloadBytes).toBe(4096);
    expect(c.databaseUrl).toBe("postgresql://server@db:5432/rainver");
    expect(c.backupDatabaseUrl).toBe("postgresql://backup:secret@db:5432/rainver");
    expect(c.internalToken).toBe("service-token");
    expect(c.googleClientId).toBe("google-client");
    expect(c.googleClientSecret).toBe("google-secret");
    expect(c.googleRedirectUri).toBe("http://localhost:8010/api/v1/auth/google/callback");
    expect(c.frontendUrl).toBe("http://localhost:5173");
    expect(c.instanceAdminEmail).toBe("owner@example.com");
    expect(c.sessionExpireDays).toBe(7);
    expect(c.debug).toBe(true);
    expect(c.rainverHome).toBe("/tmp/rainver");
    expect(c.cliToolsRoot).toBe("/tmp/rainver/tools");
    expect(c.cliSandboxImage).toBe("registry.example.com/rainver-sandbox:v1");
    expect(c.workspaceRoot).toBe("/tmp/rainver/workspaces-root");
    expect(c.artifactStorageRoot).toBe("/tmp/rainver/artifacts-root");
    expect(c.deployerSocketPath).toBe("/tmp/rainver/run/deployer.sock");
  });

  it("accepts legacy DEBUG only when SERVER_DEBUG is unset", () => {
    expect(loadConfig({ DEBUG: "true" }).debug).toBe(true);
    expect(loadConfig({ SERVER_DEBUG: "false", DEBUG: "true" }).debug).toBe(false);
  });

  it("fails fast on a malformed FRONTEND_URL", () => {
    expect(() => loadConfig({ FRONTEND_URL: "not a url" })).toThrow(ConfigError);
    expect(() => loadConfig({ FRONTEND_URL: "ftp://x:1" })).toThrow(ConfigError);
  });

  it("rejects invalid bounded values, boolean and log level", () => {
    expect(() => loadConfig({ SERVER_LOG_LEVEL: "loud" })).toThrow(ConfigError);
    expect(() =>
      loadConfig({ SERVER_RUN_EVENT_STREAM_POLL_INTERVAL_MS: "50" }),
    ).toThrow(ConfigError);
    expect(() =>
      loadConfig({ SERVER_RUN_EVENT_STREAM_PAGE_LIMIT: "999" }),
    ).toThrow(ConfigError);
    expect(() =>
      loadConfig({ SERVER_NOTIFICATION_MAX_PAYLOAD_BYTES: "64" }),
    ).toThrow(ConfigError);
  });

  it("validates notification webhook egress semantics", () => {
    expect(() =>
      loadConfig({ SERVER_ENABLE_NOTIFICATION_WEBHOOK_EGRESS: "true" }),
    ).toThrow(ConfigError);
    expect(() =>
      loadConfig({
        SERVER_NOTIFICATION_WEBHOOK_ALLOWLIST:
          "https://user:pass@hooks.example.com/proposal",
      }),
    ).toThrow(ConfigError);
    expect(() =>
      loadConfig({
        SERVER_NOTIFICATION_WEBHOOK_ALLOWLIST:
          "http://hooks.example.com/proposal",
      }),
    ).toThrow(ConfigError);
    expect(
      loadConfig({
        SERVER_ENABLE_NOTIFICATION_WEBHOOK_EGRESS: "true",
        SERVER_NOTIFICATION_WEBHOOK_ALLOWLIST:
          "http://127.0.0.1:9123/proposal",
      }).notificationWebhookAllowlist,
    ).toEqual(["http://127.0.0.1:9123/proposal"]);
  });

  it("describeConfig is a single line with no secret-bearing fields", () => {
    const line = describeConfig(loadConfig({}));
    expect(line).toContain("port=8010");
    expect(line).toContain("internalTokenConfigured=false");
    expect(line).toContain("googleOAuthConfigured=false");
    expect(line).not.toMatch(/authorization|cookie|password|secret/i);
    expect(describeConfig(loadConfig({ SERVER_INTERNAL_TOKEN: "secret-token" }))).not
      .toContain("secret-token");
    expect(describeConfig(loadConfig({ GOOGLE_CLIENT_SECRET: "google-secret" }))).not
      .toContain("google-secret");
    expect(describeConfig(loadConfig({ BACKUP_DATABASE_URL: "postgresql://backup:secret@db/app" }))).not
      .toContain("secret");
  });

  it("carries a machine code on every validation failure", () => {
    const codeOf = (env: Record<string, string>): string => {
      try {
        loadConfig(env);
      } catch (err) {
        if (err instanceof ConfigError) return err.code;
        throw err;
      }
      throw new Error("expected ConfigError");
    };
    expect(codeOf({ FRONTEND_URL: "not a url" })).toBe("invalid_base_url");
    expect(codeOf({ FRONTEND_URL: "ftp://x:1" })).toBe("invalid_url_protocol");
    expect(codeOf({ SERVER_LOG_LEVEL: "loud" })).toBe("invalid_log_level");
    expect(codeOf({ SERVER_RUN_EVENT_STREAM_PAGE_LIMIT: "999" })).toBe(
      "invalid_bounded_integer",
    );
    expect(
      codeOf({ SERVER_ENABLE_NOTIFICATION_WEBHOOK_EGRESS: "true" }),
    ).toBe("missing_notification_webhook_allowlist");
  });
});

describe("config snapshot", () => {
  it("is immutable and identifies the config by schema version + content hash", () => {
    const snapshot = loadConfigSnapshot({});
    expect(snapshot.schema_version).toBe(22);
    expect(snapshot.content_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(snapshot.loaded_at).toBeTruthy();
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.config)).toBe(true);
    expect(() => {
      (snapshot.config as { port: number }).port = 1;
    }).toThrow();
  });

  it("hashes deterministically over content (not load time) and changes with the config", () => {
    const a = createConfigSnapshot(loadConfig({}));
    const b = createConfigSnapshot(loadConfig({}));
    expect(a.content_hash).toBe(b.content_hash);
    const c = createConfigSnapshot(loadConfig({ SERVER_LOG_LEVEL: "debug" }));
    expect(c.content_hash).not.toBe(a.content_hash);
  });
});

describe("config diagnostics", () => {
  it("flags unrecognized SERVER_* variables as warnings with a machine code", () => {
    const diagnostics = collectConfigDiagnostics({
      SERVER_PROT: "8010", // typo of PORT
      SERVER_LOG_LEVEL: "info", // known — not flagged
      SERVER_EXTRA: "x", // unknown — flagged
      UNRELATED_VAR: "x", // outside the namespace — not flagged
    });
    expect(diagnostics).toEqual([
      {
        severity: "warning",
        code: "unknown_config_key",
        message: "Unrecognized environment variable SERVER_EXTRA (ignored)",
      },
      {
        severity: "warning",
        code: "unknown_config_key",
        message: "Unrecognized environment variable SERVER_PROT (ignored)",
      },
    ]);
  });

  it("returns no diagnostics for a fully-known environment", () => {
    expect(collectConfigDiagnostics({ SERVER_LOG_LEVEL: "info" })).toEqual([]);
  });

  it("adds semantic diagnostics for server-owned config relationships", () => {
    const config = loadConfig({
      SERVER_REQUEST_TIMEOUT_MS: "1000",
      SERVER_RUN_EVENT_STREAM_POLL_INTERVAL_MS: "1000",
      SERVER_NOTIFICATION_WEBHOOK_ALLOWLIST:
        "https://hooks.example.com/proposal",
    });
    const diagnostics = collectConfigDiagnostics({}, config);
    expect(diagnostics).toContainEqual({
      severity: "info",
      code: "notification_webhook_allowlist_inactive",
      message: "Notification webhook allowlist is configured but egress is disabled",
    });
    expect(diagnostics).toContainEqual({
      severity: "warning",
      code: "stream_poll_interval_exceeds_timeout",
      message:
        "Run-event stream poll interval is greater than or equal to the request timeout",
    });
  });

  it("describes fixed server authorities in diagnostics", () => {
    const config = loadConfig({});

    expect(collectConfigDiagnostics({}, config)).toContainEqual({
      severity: "info",
      code: "room_conversation_server_authority",
      message: "Room conversation turns are served by the fixed server authority",
    });
    expect(collectConfigDiagnostics({}, config)).toContainEqual({
      severity: "info",
      code: "context_assembly_server_authority",
      message:
        "Chat-path and full-run context assembly are served by the fixed server authority",
    });
    expect(collectConfigDiagnostics({}, config)).toContainEqual({
      severity: "info",
      code: "memory_server_authority",
      message:
        "Memory read routes, public memory proposal creation, and supported active-memory apply are served by the fixed server authority",
    });
    expect(collectConfigDiagnostics({}, config)).toContainEqual({
      severity: "info",
      code: "proposals_server_authority",
      message:
        "Proposal review and supported proposal apply routes are served by the fixed server authority",
    });
  });
});
