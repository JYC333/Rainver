/**
 * CLI credential profile broker.
 *
 * This mirrors the durable broker behavior: discover managed CLI login-state
 * profiles, grant one profile to one run, and never expose credential file
 * contents through public APIs.
 */

import { chmod, copyFile, lstat, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import type { FastifyBaseLogger, FastifyReply } from "fastify";
import type { ServerConfig } from "../../../config";
import { getDbPool, type Pool } from "../db";
import { resolveHostPath } from "./hostPath";
import { runCliLogin, sendCliLoginInput } from "./loginEngine";
import { CLI_LOGIN_ADAPTERS, cliLoginAdapterFor } from "./loginAdapters";
import { readClaudeTokenUsage, unsupportedTokenUsage, type TokenUsage } from "./usageReader";
import { readCodexTokenUsage } from "./codexUsageReader";
import { probeClaudeQuota, type QuotaResult } from "./usageProbe";
import { probeClaudeOAuthQuota } from "./claudeOAuthUsageProbe";
import { probeCodexQuota } from "./codexUsageProbe";
import { CLI_USAGE_REFRESH_INTERVAL_MS } from "./usageScheduler";
import { RuntimeToolRegistry } from "../../runtimeTools";
import { resolveNetworkProfileRepository } from "../../networkProfiles";
import { isSpaceOwnerOrAdmin } from "../../access/roles";
import {
  ProviderCommandNotFoundError,
  ProviderCommandValidationError,
} from "../commands/types";

export interface CredentialProfile {
  id: string;
  owner_user_id?: string | null;
  runtime: string;
  name: string;
  source_path: string;
  target_path: string;
  readonly: boolean;
  notes: string;
  network_profile_id: string | null;
  grant_id?: string | null;
  is_default?: boolean;
  manageable?: boolean;
}

export interface CliCredentialProfileCreateInput {
  runtime: string;
  name: string;
  readonly?: boolean;
  notes?: string;
  network_profile_id?: string | null;
  is_default?: boolean;
}

export interface CliCredentialSpaceGrantInput {
  space_id: string;
  enabled?: boolean;
  is_default?: boolean;
  network_profile_id?: string | null;
}

interface CredentialProfileRow {
  id: string;
  owner_user_id: string | null;
  runtime: string;
  name: string;
  source_path: string;
  target_path: string;
  readonly: boolean;
  notes: string;
  grant_id: string | null;
  grant_enabled: boolean | null;
  is_default: boolean | null;
  network_profile_id: string | null;
  manageable: boolean | null;
}

interface CliCredentialGrantRow {
  id: string;
  profile_id: string;
  space_id: string;
  owner_user_id: string;
  granted_by_user_id: string | null;
  enabled: boolean;
  is_default: boolean;
  network_profile_id: string | null;
  created_at: Date;
  updated_at: Date;
}

/** Subscription quota snapshot from the cached runtime-specific usage probe. */
export interface QuotaUsage {
  available: boolean;
  session_pct: number | null;
  session_resets: string | null;
  week_pct: number | null;
  week_resets: string | null;
  checked_at: string | null;
  error: string | null;
}

export interface CliUsageEntry {
  runtime: string;
  label: string;
  tokens: TokenUsage;
  quota: QuotaUsage | null;
}

export interface CliUsageAutoRefreshSettings {
  enabled: boolean;
  interval_ms: number;
  updated_at: string | null;
}

export interface CredentialGrant {
  granted: boolean;
  profile_id: string | null;
  runtime: string;
  executor_mode: "worktree" | "docker";
  readonly: boolean;
  temp_home: string | null;
  persistent_home?: boolean;
  host_source_path: string | null;
  target_path: string | null;
  env: Record<string, string>;
  network_profile_id: string | null;
  fallback_reason: string | null;
}

function defaultTargetPath(runtime: string): string {
  return cliLoginAdapterFor(runtime)?.target_path ?? `/home/agent/.${runtime}`;
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function fileCount(path: string): Promise<number> {
  try {
    return (await readdir(path)).length;
  } catch {
    return 0;
  }
}

async function sourceStats(
  profile: CredentialProfile,
): Promise<{ source_exists: boolean; file_count: number; logged_in: boolean }> {
  const sourceExists = await exists(profile.source_path);
  const count = sourceExists ? await fileCount(profile.source_path) : 0;
  if (!sourceExists) return { source_exists: false, file_count: 0, logged_in: false };

  const adapter = cliLoginAdapterFor(profile.runtime);
  if (adapter?.credential_file) {
    return {
      source_exists: true,
      file_count: count,
      logged_in: await exists(join(profile.source_path, adapter.credential_file)),
    };
  }
  return { source_exists: true, file_count: count, logged_in: count > 0 };
}

function cleanComponent(value: string, field: string): string {
  if (!/^[A-Za-z0-9_.-]+$/.test(value)) {
    throw new Error(`${field} may contain only letters, numbers, dot, underscore, and dash`);
  }
  return value;
}

function sse(event: Record<string, unknown>): string {
  return `data: ${JSON.stringify(event)}\n\n`;
}

type CliCredentialBrokerLogger = Pick<FastifyBaseLogger, "info" | "warn">;

function errorSummary(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

export class CliCredentialBroker {
  private pool: Pool | null = null;

  constructor(private config: ServerConfig, private logger?: CliCredentialBrokerLogger) {}

  private db(): Pool | null {
    if (!this.config.databaseUrl) return null;
    if (!this.pool) this.pool = getDbPool(this.config.databaseUrl);
    return this.pool;
  }

  private get credentialsRoot(): string {
    return join(this.config.agentSpaceHome, "secrets", "cli-credentials");
  }

  private get userCredentialsRoot(): string {
    return join(this.credentialsRoot, "users");
  }

  private get runtimeHomesRoot(): string {
    return join(this.config.agentSpaceHome, "cache", "runtime-homes");
  }

  private get conversationRuntimeHomesRoot(): string {
    return join(this.config.agentSpaceHome, "cache", "conversation-runtime-homes");
  }

  /** Transient HOME the interactive login writes into, kept under aspace so the
   * vendor CLI never touches the operator's real ~/.<runtime>. */
  private get loginHomesRoot(): string {
    return join(this.config.agentSpaceHome, "cache", "login-homes");
  }

  private profileFromRow(row: CredentialProfileRow): CredentialProfile {
    return {
      id: row.id,
      owner_user_id: row.owner_user_id,
      runtime: row.runtime,
      name: row.name,
      source_path: row.source_path,
      target_path: row.target_path,
      readonly: Boolean(row.readonly),
      notes: row.notes ?? "",
      network_profile_id: row.network_profile_id ?? null,
      grant_id: row.grant_id ?? null,
      is_default: Boolean(row.is_default),
      manageable: Boolean(row.manageable),
    };
  }

  private grantOut(row: CliCredentialGrantRow): Record<string, unknown> {
    return {
      id: row.id,
      profile_id: row.profile_id,
      space_id: row.space_id,
      owner_user_id: row.owner_user_id,
      granted_by_user_id: row.granted_by_user_id,
      enabled: row.enabled,
      is_default: row.is_default,
      network_profile_id: row.network_profile_id,
      created_at: row.created_at.toISOString(),
      updated_at: row.updated_at.toISOString(),
    };
  }

  private managedProfilePath(ownerUserId: string, runtime: string, profileId: string): string {
    return join(
      this.userCredentialsRoot,
      cleanComponent(ownerUserId, "owner_user_id"),
      cleanComponent(runtime, "runtime"),
      cleanComponent(profileId, "profile_id"),
    );
  }

  private async validateNetworkProfileId(
    spaceId: string,
    value: string | null | undefined,
  ): Promise<string | null> {
    const trimmed = typeof value === "string" && value.trim() ? value.trim() : null;
    if (!trimmed) return null;
    const profile = await resolveNetworkProfileRepository(this.config).resolve(spaceId, trimmed);
    if (!profile) {
      throw new ProviderCommandValidationError(`NetworkProfile '${trimmed}' not found`);
    }
    return trimmed;
  }

  private async userSpaceRole(userId: string, spaceId: string): Promise<string | null> {
    const db = this.db();
    if (!db) return null;
    const result = await db.query<{ role: string }>(
      `SELECT role
         FROM space_memberships
        WHERE user_id = $1 AND space_id = $2 AND status = 'active'
        LIMIT 1`,
      [userId, spaceId],
    );
    return result.rows[0]?.role ?? null;
  }

  private async requireSpaceMembership(userId: string, spaceId: string): Promise<void> {
    if (await this.userSpaceRole(userId, spaceId)) return;
    throw new ProviderCommandNotFoundError(`Space '${spaceId}' not found`);
  }

  private async canAdminSpace(userId: string, spaceId: string): Promise<boolean> {
    const role = await this.userSpaceRole(userId, spaceId);
    return isSpaceOwnerOrAdmin(role);
  }

  async listProfiles(
    runtime?: string | null,
    spaceId?: string | null,
    userId?: string | null,
  ): Promise<CredentialProfile[]> {
    const profiles = await this.loadProfiles(spaceId, userId, "owned");
    const all = [...profiles.values()];
    return runtime ? all.filter((p) => p.runtime === runtime) : all;
  }

  async availableProfiles(
    spaceId: string,
    userId: string,
    runtime?: string | null,
  ): Promise<Record<string, unknown>[]> {
    const profiles = await this.loadProfiles(spaceId, userId, "granted");
    const all = [...profiles.values()].filter((p) => !runtime || p.runtime === runtime);
    return Promise.all(
      all.map(async (profile) => ({
        id: profile.id,
        owner_user_id: profile.owner_user_id ?? null,
        runtime: profile.runtime,
        name: profile.name,
        target_path: profile.target_path,
        readonly: profile.readonly,
        notes: profile.notes,
        network_profile_id: profile.network_profile_id,
        ...(await sourceStats(profile)),
        manageable: Boolean(profile.manageable),
        grant_id: profile.grant_id,
        is_default: Boolean(profile.is_default),
      })),
    );
  }

  async getProfile(
    profileId: string,
    spaceId?: string | null,
    userId?: string | null,
  ): Promise<CredentialProfile | null> {
    const profiles = await this.loadProfiles(spaceId, userId, userId ? "owned" : "all");
    return profiles.get(profileId) ?? null;
  }

  async getDefaultProfile(
    runtime: string,
    spaceId?: string | null,
    userId?: string | null,
  ): Promise<CredentialProfile | null> {
    const profiles = await this.loadProfiles(spaceId, userId, spaceId ? "granted" : "all");
    const exact = this.findDefaultProfile(profiles, runtime);
    if (exact && (await sourceStats(exact)).logged_in) return exact;
    for (const profile of profiles.values()) {
      if (profile.runtime === runtime && (await sourceStats(profile)).logged_in) {
        return profile;
      }
    }
    return null;
  }

  async profileOut(profile: CredentialProfile): Promise<Record<string, unknown>> {
    return {
      ...profile,
      ...(await sourceStats(profile)),
    };
  }

  async detectProfile(
    profileId: string,
    spaceId?: string | null,
    userId?: string | null,
  ): Promise<Record<string, unknown>> {
    const profile = await this.getProfile(profileId, spaceId, userId);
    if (!profile) throw new Error(`Profile '${profileId}' not found`);
    const stats = await sourceStats(profile);
    return {
      profile_id: profileId,
      source_path: profile.source_path,
      exists: stats.source_exists,
      non_empty: stats.file_count > 0,
      logged_in: stats.logged_in,
      file_count: stats.file_count,
      target_path: profile.target_path,
      readonly: profile.readonly,
      network_profile_id: profile.network_profile_id,
    };
  }

  async updateProfileNetworkProfileId(
    profileId: string,
    networkProfileId: string | null,
    spaceId?: string | null,
    userId?: string | null,
  ): Promise<Record<string, unknown>> {
    const db = this.db();
    if (!db || !spaceId || !userId) {
      throw new Error("CLI credential profile updates require SERVER_DATABASE_URL and an authenticated space");
    }
    const profile = await this.getOwnedProfile(userId, profileId, spaceId);
    if (!profile) throw new ProviderCommandNotFoundError(`Profile '${profileId}' not found`);
    await this.grantCliProfileToSpace(spaceId, userId, profile.id, {
      space_id: spaceId,
      network_profile_id: networkProfileId,
      enabled: true,
      is_default: profile.is_default,
    });
    const updated = await this.getProfile(profile.id, spaceId, userId);
    if (!updated) throw new Error("updated profile was not readable");
    return this.profileOut(updated);
  }

  listLoginMethods(): Record<string, unknown>[] {
    return CLI_LOGIN_ADAPTERS.map((cfg) => ({
      runtime: cfg.runtime,
      method: cfg.method,
      label: cfg.label,
      hint_cli: cfg.hint_cli ?? "",
      supports_cli: Boolean(cfg.command),
    }));
  }

  async status(spaceId?: string | null, userId?: string | null): Promise<Record<string, unknown>[]> {
    const result: Record<string, unknown>[] = [];
    for (const cfg of CLI_LOGIN_ADAPTERS) {
      const profile = await this.getDefaultProfile(cfg.runtime, spaceId, userId);
      const stats = profile
        ? await sourceStats(profile)
        : { source_exists: false, file_count: 0, logged_in: false };
      result.push({
        runtime: cfg.runtime,
        label: cfg.label,
        method: cfg.method,
        profile_id: profile?.id ?? null,
        network_profile_id: profile?.network_profile_id ?? null,
        logged_in: stats.logged_in,
        file_count: stats.file_count,
      });
    }
    return result;
  }

  /**
   * Per-runtime usage for the Credentials panel: cumulative token usage parsed
   * from local CLI transcripts/sessions (offline). `quota` is filled by the
   * cached runtime-specific probe and stays null for runtimes/builds without it.
   */
  async cliUsage(spaceId?: string | null, userId?: string | null): Promise<CliUsageEntry[]> {
    const result: CliUsageEntry[] = [];
    for (const cfg of CLI_LOGIN_ADAPTERS) {
      const profile = await this.getDefaultProfile(cfg.runtime, spaceId, userId);
      let tokens: TokenUsage = unsupportedTokenUsage();
      let quota: QuotaResult | null = null;
      if (cfg.runtime === "claude_code" && profile) {
        tokens = await readClaudeTokenUsage(profile.source_path);
        quota = await this.readQuotaCache(cfg.runtime, profile.id); // last probed value; UI refreshes on demand
      } else if (cfg.runtime === "codex_cli" && profile) {
        tokens = await readCodexTokenUsage(profile.source_path);
        quota = await this.readQuotaCache(cfg.runtime, profile.id);
      }
      result.push({ runtime: cfg.runtime, label: cfg.label, tokens, quota });
    }
    return result;
  }

  /**
   * Run the live quota probe for a runtime, persist it to the cache, and return
   * the combined (tokens + fresh quota) entry. Runtimes without a quota adapter
   * return token usage with quota=null.
   */
  async refreshCliQuota(
    runtime: string,
    spaceId?: string | null,
    userId?: string | null,
    profileId?: string | null,
  ): Promise<CliUsageEntry> {
    const cfg = cliLoginAdapterFor(runtime);
    if (!cfg) throw new Error(`Unknown runtime: ${runtime}`);
    const profile = await this.resolveProfile(
      runtime,
      profileId,
      true,
      spaceId,
      userId,
    );
    let tokens: TokenUsage = unsupportedTokenUsage();
    let quota: QuotaResult | null = null;

    if (runtime === "claude_code") {
      if (profile) tokens = await readClaudeTokenUsage(profile.source_path);
      if (!profile) {
        this.logger?.info(
          { runtime, source: "none" },
          "Claude usage quota probe skipped: no CLI credential profile",
        );
        quota = {
          available: false,
          session_pct: null,
          session_resets: null,
          week_pct: null,
          week_resets: null,
          checked_at: null,
          error: "Log in to Claude Code before reading usage.",
        };
      } else {
        try {
          this.logger?.info(
            {
              runtime,
              profile_id: profile.id,
              source: "claude_oauth_usage_api",
            },
            "Claude usage quota probe starting",
          );
          quota = await probeClaudeOAuthQuota(profile.source_path);
          this.logger?.info(
            {
              runtime,
              profile_id: profile.id,
              source: "claude_oauth_usage_api",
              available: quota.available,
              session_pct: quota.session_pct,
              week_pct: quota.week_pct,
            },
            "Claude usage quota probe succeeded",
          );
        } catch (oauthError) {
          this.logger?.warn(
            {
              runtime,
              profile_id: profile.id,
              source: "claude_oauth_usage_api",
              fallback_source: "claude_pty_usage_fallback",
              error: errorSummary(oauthError),
            },
            "Claude OAuth usage probe failed; falling back to PTY usage probe",
          );
          // HOME with .claude symlinked to the profile, so the CLI fallback
          // authenticates with managed credentials and never touches host HOME.
          const probeRunId = `usage-probe-${randomUUID()}`;
          const probeHome = await this.createTempHome(probeRunId, profile);
          try {
            quota = await probeClaudeQuota(probeHome, new RuntimeToolRegistry(this.config));
            if (quota.available) {
              this.logger?.info(
                {
                  runtime,
                  profile_id: profile.id,
                  source: "claude_pty_usage_fallback",
                  available: quota.available,
                  session_pct: quota.session_pct,
                  week_pct: quota.week_pct,
                  error: quota.error,
                },
                "Claude PTY usage fallback probe succeeded",
              );
            } else {
              this.logger?.warn(
                {
                  runtime,
                  profile_id: profile.id,
                  source: "claude_pty_usage_fallback",
                  available: quota.available,
                  error: quota.error,
                },
                "Claude PTY usage fallback probe returned no quota",
              );
            }
          } catch (ptyError) {
            this.logger?.warn(
              {
                runtime,
                profile_id: profile.id,
                source: "claude_pty_usage_fallback",
                error: errorSummary(ptyError),
              },
              "Claude PTY usage fallback probe failed",
            );
            throw ptyError;
          } finally {
            await this.cleanupRunHome(probeRunId);
          }
        }
      }
      quota.checked_at = new Date().toISOString();
      if (profile) await this.writeQuotaCache(runtime, profile.id, quota);
    } else if (runtime === "codex_cli") {
      if (profile) tokens = await readCodexTokenUsage(profile.source_path);
      if (!profile) {
        quota = {
          available: false,
          session_pct: null,
          session_resets: null,
          week_pct: null,
          week_resets: null,
          checked_at: null,
          error: "Log in to Codex CLI before reading usage.",
        };
      } else {
        const probeRunId = `usage-probe-codex-${randomUUID()}`;
        const probeHome = await this.createTempHome(probeRunId, profile);
        try {
          quota = await probeCodexQuota(
            profile.source_path,
            probeHome,
            new RuntimeToolRegistry(this.config),
          );
        } finally {
          await this.cleanupRunHome(probeRunId);
        }
      }
      quota.checked_at = new Date().toISOString();
      if (profile) await this.writeQuotaCache(runtime, profile.id, quota);
    }
    return { runtime, label: cfg.label, tokens, quota };
  }

  async refreshStaleCliQuota(
    runtime: string,
    maxAgeMs: number,
    spaceId?: string | null,
    userId?: string | null,
    profileId?: string | null,
  ): Promise<CliUsageEntry | null> {
    const cfg = cliLoginAdapterFor(runtime);
    if (!cfg) throw new Error(`Unknown runtime: ${runtime}`);
    if (runtime !== "claude_code" && runtime !== "codex_cli") return null;

    const profile = await this.resolveProfile(runtime, profileId, true, spaceId, userId);
    if (!profile) return null;
    const cached = await this.readQuotaCache(runtime, profile.id);
    const checkedAt = cached?.checked_at ? Date.parse(cached.checked_at) : Number.NaN;
    if (Number.isFinite(checkedAt) && Date.now() - checkedAt < maxAgeMs) {
      return null;
    }
    return this.refreshCliQuota(runtime, spaceId, userId, profile.id);
  }

  async recordLiveQuota(
    runtime: string,
    profileId: string,
    live: {
      status: string;
      rate_limit_type: string;
      utilization: number;
      resets_at: number;
      is_using_overage: boolean;
    },
  ): Promise<void> {
    const existing = await this.readQuotaCache(runtime, profileId);
    const quota: QuotaResult = existing ?? {
      available: true,
      session_pct: null,
      session_resets: null,
      week_pct: null,
      week_resets: null,
      checked_at: null,
      error: null,
    };
    quota.available = true;
    quota.checked_at = new Date().toISOString();
    quota.error = live.status === "rejected"
      ? "The CLI subscription quota rejected this request."
      : null;
    const percent = Math.max(0, Math.min(100, Math.round(live.utilization * 100)));
    const resetsAt = new Date(live.resets_at * 1000).toISOString();
    if (live.rate_limit_type.includes("seven") || live.rate_limit_type.includes("week")) {
      quota.week_pct = percent;
      quota.week_resets = resetsAt;
    } else {
      quota.session_pct = percent;
      quota.session_resets = resetsAt;
    }
    await this.writeQuotaCache(runtime, profileId, quota);
  }

  async listQuotaRefreshTargets(runtime: string): Promise<Array<{
    profile_id: string;
    space_id: string;
    owner_user_id: string;
  }>> {
    const db = this.db();
    if (!db) return [];
    const result = await db.query<{
      profile_id: string;
      space_id: string;
      owner_user_id: string;
      source_path: string;
    }>(
      `SELECT DISTINCT ON (p.id)
              p.id AS profile_id,
              g.space_id,
              p.owner_user_id,
              p.source_path
         FROM cli_credential_profiles p
         JOIN cli_credential_space_grants g
           ON g.profile_id = p.id
          AND g.owner_user_id = p.owner_user_id
        WHERE p.runtime = $1
          AND p.owner_user_id IS NOT NULL
          AND g.enabled = true
        ORDER BY p.id, g.is_default DESC, g.created_at ASC`,
      [runtime],
    );
    const targets = [];
    for (const row of result.rows) {
      const profile: CredentialProfile = {
        id: row.profile_id,
        owner_user_id: row.owner_user_id,
        runtime,
        name: "",
        source_path: row.source_path,
        target_path: "",
        readonly: true,
        notes: "",
        network_profile_id: null,
      };
      if ((await sourceStats(profile)).logged_in) {
        targets.push({
          profile_id: row.profile_id,
          space_id: row.space_id,
          owner_user_id: row.owner_user_id,
        });
      }
    }
    return targets;
  }

  private quotaCachePath(runtime: string, profileId: string): string {
    return join(
      this.config.agentSpaceHome,
      "cache",
      "cli-quota",
      cleanComponent(runtime, "runtime"),
      `${cleanComponent(profileId, "profile_id")}.json`,
    );
  }

  private get usageAutoRefreshSettingsPath(): string {
    return join(this.config.agentSpaceHome, "config", "cli-usage-auto-refresh.json");
  }

  async cliUsageAutoRefreshSettings(): Promise<CliUsageAutoRefreshSettings> {
    try {
      const raw = JSON.parse(await readFile(this.usageAutoRefreshSettingsPath, "utf8")) as Record<string, unknown>;
      return {
        enabled: typeof raw.enabled === "boolean" ? raw.enabled : true,
        interval_ms: CLI_USAGE_REFRESH_INTERVAL_MS,
        updated_at: typeof raw.updated_at === "string" ? raw.updated_at : null,
      };
    } catch {
      return {
        enabled: true,
        interval_ms: CLI_USAGE_REFRESH_INTERVAL_MS,
        updated_at: null,
      };
    }
  }

  async setCliUsageAutoRefresh(enabled: boolean): Promise<CliUsageAutoRefreshSettings> {
    const settings: CliUsageAutoRefreshSettings = {
      enabled,
      interval_ms: CLI_USAGE_REFRESH_INTERVAL_MS,
      updated_at: new Date().toISOString(),
    };
    await mkdir(dirname(this.usageAutoRefreshSettingsPath), { recursive: true });
    await writeFile(this.usageAutoRefreshSettingsPath, JSON.stringify(settings), "utf8");
    return settings;
  }

  async isCliUsageAutoRefreshEnabled(): Promise<boolean> {
    return (await this.cliUsageAutoRefreshSettings()).enabled;
  }

  async createProfile(
    spaceId: string,
    userId: string,
    input: CliCredentialProfileCreateInput,
  ): Promise<Record<string, unknown>> {
    const db = this.db();
    if (!db) throw new Error("CLI credential profile creation requires SERVER_DATABASE_URL");
    await this.requireSpaceMembership(userId, spaceId);

    const runtime = cleanComponent(input.runtime.trim(), "runtime");
    const name = cleanComponent(input.name.trim(), "name");
    const profileId = randomUUID();
    const sourcePath = this.managedProfilePath(userId, runtime, profileId);
    const targetPath = defaultTargetPath(runtime);
    const networkProfileId = await this.validateNetworkProfileId(
      spaceId,
      input.network_profile_id,
    );
    const now = new Date();
    await mkdir(sourcePath, { recursive: true, mode: 0o700 });
    if (input.is_default) await this.clearDefaultGrant(spaceId, runtime, profileId);

    try {
      await db.query(
        `INSERT INTO cli_credential_profiles
          (id, owner_user_id, runtime, name, source_path, target_path, readonly,
           notes, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $9)`,
        [
          profileId,
          userId,
          runtime,
          name,
          sourcePath,
          targetPath,
          Boolean(input.readonly),
          input.notes ?? "",
          now,
        ],
      );
    } catch (error) {
      if ((error as { code?: string }).code === "23505") {
        throw new ProviderCommandValidationError(
          `CLI credential profile '${runtime}/${name}' already exists`,
        );
      }
      throw error;
    }

    await db.query(
      `INSERT INTO cli_credential_space_grants
        (id, profile_id, space_id, owner_user_id, granted_by_user_id, enabled,
         is_default, network_profile_id, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $4, true, $5, $6, $7, $7)`,
      [randomUUID(), profileId, spaceId, userId, Boolean(input.is_default), networkProfileId, now],
    );
    const profile = await this.getProfile(profileId, spaceId, userId);
    if (!profile) throw new Error("created CLI credential profile was not readable");
    return this.profileOut(profile);
  }

  async grantCliProfileToSpace(
    activeSpaceId: string,
    userId: string,
    profileId: string,
    input: CliCredentialSpaceGrantInput,
  ): Promise<Record<string, unknown>> {
    const db = this.db();
    if (!db) throw new Error("CLI credential grants require SERVER_DATABASE_URL");
    const profile = await this.getOwnedProfile(userId, profileId, activeSpaceId);
    if (!profile) throw new ProviderCommandNotFoundError(`Profile '${profileId}' not found`);
    const targetSpaceId = input.space_id || activeSpaceId;
    await this.requireSpaceMembership(userId, targetSpaceId);
    const networkProfileId =
      input.network_profile_id === undefined
        ? undefined
        : await this.validateNetworkProfileId(targetSpaceId, input.network_profile_id);
    const existingGrant = await db.query<{ is_default: boolean }>(
      `SELECT is_default
         FROM cli_credential_space_grants
        WHERE profile_id = $1 AND space_id = $2
        LIMIT 1`,
      [profile.id, targetSpaceId],
    );
    const isDefault =
      input.is_default === undefined
        ? Boolean(existingGrant.rows[0]?.is_default)
        : Boolean(input.is_default);
    if (isDefault) await this.clearDefaultGrant(targetSpaceId, profile.runtime, profile.id);
    const now = new Date();
    const result = await db.query<CliCredentialGrantRow>(
      `INSERT INTO cli_credential_space_grants
        (id, profile_id, space_id, owner_user_id, granted_by_user_id, enabled,
         is_default, network_profile_id, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $9)
       ON CONFLICT ON CONSTRAINT uq_cli_credential_space_grants_profile_space
       DO UPDATE SET enabled = EXCLUDED.enabled,
                     is_default = EXCLUDED.is_default,
                     network_profile_id = CASE
                       WHEN $10::boolean THEN EXCLUDED.network_profile_id
                       ELSE cli_credential_space_grants.network_profile_id
                     END,
                     granted_by_user_id = EXCLUDED.granted_by_user_id,
                     owner_user_id = EXCLUDED.owner_user_id,
                     updated_at = EXCLUDED.updated_at
       RETURNING id, profile_id, space_id, owner_user_id, granted_by_user_id,
                 enabled, is_default, network_profile_id, created_at, updated_at`,
      [
        randomUUID(),
        profile.id,
        targetSpaceId,
        profile.owner_user_id ?? userId,
        userId,
        input.enabled ?? true,
        isDefault,
        networkProfileId ?? null,
        now,
        input.network_profile_id !== undefined,
      ],
    );
    return this.grantOut(result.rows[0]);
  }

  async revokeCliProfileGrant(
    userId: string,
    profileId: string,
    grantSpaceId: string,
  ): Promise<void> {
    const db = this.db();
    if (!db) throw new Error("CLI credential grants require SERVER_DATABASE_URL");
    const owned = await this.getOwnedProfile(userId, profileId, grantSpaceId);
    if (!owned && !(await this.canAdminSpace(userId, grantSpaceId))) {
      throw new ProviderCommandNotFoundError(`Profile '${profileId}' not found`);
    }
    const result = await db.query(
      `UPDATE cli_credential_space_grants g
          SET enabled = false,
              is_default = false,
              updated_at = $3
         FROM cli_credential_profiles p
        WHERE g.profile_id = p.id
          AND g.space_id = $2
          AND p.id = $1
          AND g.enabled = true
        RETURNING g.id`,
      [profileId, grantSpaceId, new Date()],
    );
    if (result.rowCount === 0) {
      throw new ProviderCommandNotFoundError("CLI credential grant not found");
    }
  }

  private async readQuotaCache(runtime: string, profileId: string): Promise<QuotaResult | null> {
    try {
      return JSON.parse(
        await readFile(this.quotaCachePath(runtime, profileId), "utf8"),
      ) as QuotaResult;
    } catch {
      return null;
    }
  }

  private async writeQuotaCache(
    runtime: string,
    profileId: string,
    quota: QuotaResult,
  ): Promise<void> {
    try {
      const cachePath = this.quotaCachePath(runtime, profileId);
      await mkdir(dirname(cachePath), { recursive: true });
      await writeFile(cachePath, JSON.stringify(quota), "utf8");
    } catch {
      // Best-effort cache; a probe is still returned to the caller.
    }
  }

  async resolveProfile(
    runtime: string,
    profileId?: string | null,
    requireExisting = true,
    spaceId?: string | null,
    userId?: string | null,
  ): Promise<CredentialProfile | null> {
    const profile = profileId
      ? await this.getGrantedProfile(runtime, profileId, spaceId, userId)
      : await this.getDefaultProfile(runtime, spaceId, userId);
    if (!profile) return null;
    if (requireExisting && !(await sourceStats(profile)).logged_in) return null;
    return profile;
  }

  async grantForRun(
    runId: string,
    spaceId: string,
    runtime: string,
    executorMode: "worktree" | "docker",
    profileId?: string | null,
    options?: {
      conversation_state_key?: string | null;
      user_id?: string | null;
    },
  ): Promise<CredentialGrant> {
    const profile = await this.resolveProfile(
      runtime,
      profileId,
      true,
      spaceId,
      options?.user_id,
    );
    if (!profile) {
      return {
        granted: false,
        profile_id: null,
        runtime,
        executor_mode: executorMode,
        readonly: false,
        temp_home: null,
        persistent_home: false,
        host_source_path: null,
        target_path: null,
        env: {},
        network_profile_id: null,
        fallback_reason: profileId ? "credential_grant_denied" : "no_profile_configured",
      };
    }
    if (executorMode === "docker") {
      if (options?.conversation_state_key) {
        throw new Error("Persistent CLI conversation sessions do not support one-shot Docker");
      }
      return {
        granted: true,
        profile_id: profile.id,
        runtime,
        executor_mode: "docker",
        readonly: profile.readonly,
        temp_home: null,
        persistent_home: false,
        // The sandbox launcher mounts this through the HOST Docker daemon.
        host_source_path: resolveHostPath(profile.source_path),
        target_path: profile.target_path,
        env: {},
        network_profile_id: profile.network_profile_id,
        fallback_reason: null,
      };
    }
    const persistent = Boolean(options?.conversation_state_key);
    const tempHome = options?.conversation_state_key
      ? await this.createConversationHome(options.conversation_state_key, profile)
      : await this.createTempHome(runId, profile);
    return {
      granted: true,
      profile_id: profile.id,
      runtime,
      executor_mode: "worktree",
      readonly: false,
      temp_home: tempHome,
      persistent_home: persistent,
      host_source_path: null,
      target_path: null,
      env: { HOME: tempHome },
      network_profile_id: profile.network_profile_id,
      fallback_reason: null,
    };
  }

  async cleanupRunHome(runId: string): Promise<void> {
    await rm(join(this.runtimeHomesRoot, cleanComponent(runId, "run_id")), {
      recursive: true,
      force: true,
    });
  }

  async prepareRunHome(runId: string): Promise<string> {
    const tempHome = join(this.runtimeHomesRoot, cleanComponent(runId, "run_id"));
    await rm(tempHome, { recursive: true, force: true });
    await mkdir(tempHome, { recursive: true, mode: 0o700 });
    return tempHome;
  }

  async prepareConversationHome(stateKey: string): Promise<string> {
    await ensureRealDirectoryChain(
      resolve(this.config.agentSpaceHome),
      "cache/conversation-runtime-homes",
      "conversation",
    );
    const tempHome = join(
      this.conversationRuntimeHomesRoot,
      cleanComponent(stateKey, "conversation_state_key"),
    );
    await ensureRealDirectoryChain(
      this.conversationRuntimeHomesRoot,
      cleanComponent(stateKey, "conversation_state_key"),
      "conversation",
    );
    return tempHome;
  }

  async streamLogin(
    runtime: string,
    reply: FastifyReply,
    spaceId?: string | null,
    userId?: string | null,
    profileId?: string | null,
  ): Promise<void> {
    reply.raw.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      "x-accel-buffering": "no",
    });
    // Only known runtimes reach a real login; a clean component keeps the
    // login HOME path inside aspace even if an unknown runtime slips through.
    const adapter = cliLoginAdapterFor(runtime);
    const safeRuntime = adapter ? cleanComponent(runtime, "runtime") : "_invalid";
    const db = this.db();
    if (!db || !spaceId || !userId) {
      throw new Error("CLI login requires SERVER_DATABASE_URL and an authenticated space");
    }
    let profileDir = "";
    let resolvedProfileId: string | null = null;
    let sessionKey: string | undefined;
    let profile = profileId
      ? await this.getOwnedProfile(userId, profileId, spaceId)
      : await this.getOwnedDefaultForRuntime(userId, runtime, spaceId);
    if (!profile && !profileId) {
      await this.createProfile(spaceId, userId, {
        runtime,
        name: "default",
        is_default: true,
      });
      profile = await this.getOwnedDefaultForRuntime(userId, runtime, spaceId);
    }
    if (!profile) throw new ProviderCommandNotFoundError(`Profile '${profileId ?? "default"}' not found`);
    await mkdir(profile.source_path, { recursive: true, mode: 0o700 });
    profileDir = profile.source_path;
    resolvedProfileId = profile.id;
    sessionKey = `${runtime}:${profile.id}`;
    const loginHome = join(this.loginHomesRoot, safeRuntime, resolvedProfileId ?? "default");
    const tools = new RuntimeToolRegistry(this.config);
    reply.raw.write(sse({ type: "profile", profile_id: resolvedProfileId }));
    await runCliLogin(runtime, adapter, profileDir, (event) => {
      reply.raw.write(sse(event));
    }, undefined, tools, loginHome, resolvedProfileId, sessionKey);
    reply.raw.end();
  }

  async sendLoginInput(
    runtime: string,
    input: string,
    spaceId: string,
    userId: string,
    profileId?: string | null,
  ): Promise<boolean> {
    const profile = profileId
      ? await this.getOwnedProfile(userId, profileId, spaceId)
      : await this.getOwnedDefaultForRuntime(userId, runtime, spaceId);
    if (!profile || profile.runtime !== runtime) return false;
    return sendCliLoginInput(
      runtime,
      input,
      `${runtime}:${profile.id}`,
    );
  }

  private findDefaultProfile(
    profiles: Map<string, CredentialProfile>,
    runtime: string,
  ): CredentialProfile | null {
    const defaultByGrant = [...profiles.values()].find(
      (profile) => profile.runtime === runtime && profile.is_default,
    );
    if (defaultByGrant) return defaultByGrant;
    return null;
  }

  private async loadOwnedProfiles(
    spaceId: string,
    userId: string,
  ): Promise<Map<string, CredentialProfile>> {
    const db = this.db();
    if (!db) return new Map();
    const result = await db.query<CredentialProfileRow>(
      `SELECT p.id,
              p.owner_user_id,
              p.runtime,
              p.name,
              p.source_path,
              p.target_path,
              p.readonly,
              p.notes,
              g.id AS grant_id,
              g.enabled AS grant_enabled,
              g.is_default,
              g.network_profile_id,
              true AS manageable
         FROM cli_credential_profiles p
         LEFT JOIN cli_credential_space_grants g
           ON g.profile_id = p.id
          AND g.space_id = $2
        WHERE p.owner_user_id = $1
        ORDER BY p.runtime ASC, p.name ASC, p.created_at ASC`,
      [userId, spaceId],
    );
    return this.rowsToProfileMap(result.rows);
  }

  private async loadGrantedProfiles(
    spaceId: string,
    userId?: string | null,
  ): Promise<Map<string, CredentialProfile>> {
    const db = this.db();
    if (!db) return new Map();
    const result = await db.query<CredentialProfileRow>(
      `SELECT p.id,
              p.owner_user_id,
              p.runtime,
              p.name,
              p.source_path,
              p.target_path,
              p.readonly,
              p.notes,
              g.id AS grant_id,
              g.enabled AS grant_enabled,
              g.is_default,
              g.network_profile_id,
              (p.owner_user_id = $2) AS manageable
         FROM cli_credential_space_grants g
         JOIN cli_credential_profiles p ON p.id = g.profile_id
        WHERE g.space_id = $1
          AND g.enabled = true
          AND ($2::varchar IS NULL OR (
            g.owner_user_id = $2
            AND p.owner_user_id = $2
          ))
        ORDER BY p.runtime ASC, g.is_default DESC, p.name ASC, p.created_at ASC`,
      [spaceId, userId ?? null],
    );
    return this.rowsToProfileMap(result.rows);
  }

  private rowsToProfileMap(rows: CredentialProfileRow[]): Map<string, CredentialProfile> {
    const profiles = new Map<string, CredentialProfile>();
    for (const row of rows) {
      const profile = this.profileFromRow(row);
      profiles.set(profile.id, profile);
    }
    return profiles;
  }

  private async getOwnedProfile(
    userId: string,
    profileId: string,
    spaceId?: string | null,
  ): Promise<CredentialProfile | null> {
    const db = this.db();
    if (!db) return null;
    const result = await db.query<CredentialProfileRow>(
      `SELECT p.id,
              p.owner_user_id,
              p.runtime,
              p.name,
              p.source_path,
              p.target_path,
              p.readonly,
              p.notes,
              g.id AS grant_id,
              g.enabled AS grant_enabled,
              g.is_default,
              g.network_profile_id,
              true AS manageable
         FROM cli_credential_profiles p
         LEFT JOIN cli_credential_space_grants g
           ON g.profile_id = p.id
          AND g.space_id = $3
        WHERE p.owner_user_id = $1
          AND p.id = $2
        LIMIT 1`,
      [userId, profileId, spaceId ?? null],
    );
    return result.rows[0] ? this.profileFromRow(result.rows[0]) : null;
  }

  private async getOwnedDefaultForRuntime(
    userId: string,
    runtime: string,
    spaceId: string,
  ): Promise<CredentialProfile | null> {
    const profiles = await this.loadOwnedProfiles(spaceId, userId);
    const defaultProfile = this.findDefaultProfile(profiles, runtime);
    if (defaultProfile) return defaultProfile;
    for (const profile of profiles.values()) {
      if (profile.runtime === runtime) return profile;
    }
    return null;
  }

  private async getGrantedProfile(
    runtime: string,
    profileId?: string | null,
    spaceId?: string | null,
    userId?: string | null,
  ): Promise<CredentialProfile | null> {
    if (!profileId) return this.getDefaultProfile(runtime, spaceId, userId);
    const db = this.db();
    if (!db || !spaceId) return null;
    const result = await db.query<CredentialProfileRow>(
      `SELECT p.id,
              p.owner_user_id,
              p.runtime,
              p.name,
              p.source_path,
              p.target_path,
              p.readonly,
              p.notes,
              g.id AS grant_id,
              g.enabled AS grant_enabled,
              g.is_default,
              g.network_profile_id,
              (p.owner_user_id = $4) AS manageable
         FROM cli_credential_space_grants g
         JOIN cli_credential_profiles p ON p.id = g.profile_id
        WHERE g.space_id = $1
          AND g.enabled = true
          AND p.runtime = $2
          AND p.id = $3
          AND ($4::varchar IS NULL OR (
            g.owner_user_id = $4
            AND p.owner_user_id = $4
          ))
        LIMIT 1`,
      [spaceId, runtime, profileId, userId ?? null],
    );
    return result.rows[0] ? this.profileFromRow(result.rows[0]) : null;
  }

  private async clearDefaultGrant(
    spaceId: string,
    runtime: string,
    exceptProfileId?: string,
  ): Promise<void> {
    const db = this.db();
    if (!db) return;
    await db.query(
      `UPDATE cli_credential_space_grants g
          SET is_default = false,
              updated_at = $3
         FROM cli_credential_profiles p
        WHERE g.profile_id = p.id
          AND g.space_id = $1
          AND p.runtime = $2
          AND ($4::text IS NULL OR g.profile_id <> $4)`,
      [spaceId, runtime, new Date(), exceptProfileId ?? null],
    );
  }

  private async loadProfiles(
    spaceId?: string | null,
    userId?: string | null,
    scope: "all" | "owned" | "granted" = "all",
  ): Promise<Map<string, CredentialProfile>> {
    const db = this.db();
    if (!db) return new Map();
    if (scope === "granted" && spaceId) return this.loadGrantedProfiles(spaceId, userId);
    if ((scope === "owned" || scope === "all") && spaceId && userId) {
      return this.loadOwnedProfiles(spaceId, userId);
    }
    return new Map();
  }

  private async createTempHome(runId: string, profile: CredentialProfile): Promise<string> {
    const tempHome = await this.prepareRunHome(runId);
    await materializeRunCredentialHome({
      tempHome,
      runtime: profile.runtime,
      sourcePath: profile.source_path,
    });
    return tempHome;
  }

  private async createConversationHome(
    stateKey: string,
    profile: CredentialProfile,
  ): Promise<string> {
    const tempHome = await this.prepareConversationHome(stateKey);
    await materializeRunCredentialHome({
      tempHome,
      runtime: profile.runtime,
      sourcePath: profile.source_path,
    });
    return tempHome;
  }
}

export async function materializeRunCredentialHome(input: {
  tempHome: string;
  runtime: string;
  sourcePath: string;
}): Promise<void> {
  const adapter = cliLoginAdapterFor(input.runtime);
  if (!adapter?.home_subdir || !adapter.credential_file) {
    throw new Error(`Runtime '${input.runtime}' has no credential materialization contract`);
  }
  const tempHome = input.tempHome;
  const homeRoot = resolve(tempHome);
  const targetDir = resolve(tempHome, adapter.home_subdir);
  if (targetDir === homeRoot || !targetDir.startsWith(`${homeRoot}/`)) {
    throw new Error(`Runtime '${input.runtime}' credential target escapes the run HOME`);
  }
  await ensureRealDirectoryChain(homeRoot, adapter.home_subdir, input.runtime);
  const credentialTarget = join(targetDir, adapter.credential_file);
  const credentialSource = join(input.sourcePath, adapter.credential_file);
  await assertRegularCredentialFile(credentialSource, input.runtime);
  await rm(credentialTarget, { force: true });
  await copyFile(credentialSource, credentialTarget);
  await chmod(credentialTarget, 0o600);
  const claudeJson = join(input.sourcePath, ".claude.json");
  if (await optionalRegularCredentialFile(claudeJson, input.runtime)) {
    const claudeJsonTarget = join(tempHome, ".claude.json");
    await rm(claudeJsonTarget, { force: true });
    await copyFile(claudeJson, claudeJsonTarget);
    await chmod(claudeJsonTarget, 0o600);
  }
}

async function ensureRealDirectoryChain(
  root: string,
  relativePath: string,
  runtime: string,
): Promise<void> {
  const rootStats = await lstat(root);
  if (!rootStats.isDirectory() || rootStats.isSymbolicLink()) {
    throw new Error(`Runtime '${runtime}' credential HOME is not a real directory`);
  }
  let current = root;
  for (const component of relativePath.split("/").filter(Boolean)) {
    current = join(current, component);
    try {
      const stats = await lstat(current);
      if (!stats.isDirectory() || stats.isSymbolicLink()) {
        throw new Error(`Runtime '${runtime}' credential target contains a symlink`);
      }
    } catch (error) {
      if (!isMissingPathError(error)) throw error;
      await mkdir(current, { mode: 0o700 });
    }
  }
}

async function assertRegularCredentialFile(path: string, runtime: string): Promise<void> {
  const stats = await lstat(path);
  if (!stats.isFile() || stats.isSymbolicLink()) {
    throw new Error(`Runtime '${runtime}' credential source is not a regular file`);
  }
}

async function optionalRegularCredentialFile(
  path: string,
  runtime: string,
): Promise<boolean> {
  try {
    await assertRegularCredentialFile(path, runtime);
    return true;
  } catch (error) {
    if (isMissingPathError(error)) return false;
    throw error;
  }
}

function isMissingPathError(error: unknown): boolean {
  return error instanceof Error
    && "code" in error
    && (error as NodeJS.ErrnoException).code === "ENOENT";
}
