import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { ServerConfig } from "../../config.js";
import { getDbPool } from "../../db/pool.js";
import type { Queryable } from "../routeUtils/common.js";
import { PgMachineRepository } from "./machineRepository.js";
import type { WorkspaceLocationHeartbeat } from "../projectFolders/workspaceLocations.js";

/**
 * ADR 0016: an execution host is the server host (exactly one row, seeded,
 * `owner_user_id` NULL, never authenticates over the daemon protocol) or a
 * personal machine a user has paired in trusted-host mode. Heartbeat
 * staleness is computed at read time (`HEARTBEAT_STALE_MS`) rather than by a
 * background sweep — a host that died without closing its connection
 * reports as offline the next time anyone lists hosts, which is sufficient
 * for phase 1's dispatch guard and does not need its own scheduler.
 */
const HEARTBEAT_STALE_MS = 45_000;
const PAIRING_CODE_TTL_MS = 10 * 60_000;

export interface HostRow {
  id: string;
  owner_user_id: string | null;
  machine_id: string;
  machine_name?: string | null;
  environment_kind: string;
  name: string;
  kind: string;
  status: string;
  token_hash: string | null;
  pairing_code_expires_at: string | null;
  last_heartbeat_at: string | null;
  platform: string | null;
  arch: string | null;
  daemon_version: string | null;
  daemon_server_url?: string | null;
  provider_proxy_base_url?: string | null;
  capabilities_json: Record<string, unknown> | null;
  created_at: string;
  updated_at: string;
}

export interface HostOut {
  id: string;
  owner_user_id: string | null;
  machine_id: string;
  machine_name: string | null;
  environment_kind: string;
  name: string;
  kind: string;
  status: string;
  last_heartbeat_at: string | null;
  platform: string | null;
  arch: string | null;
  daemon_version: string | null;
  /** The control-plane address this daemon reports it reaches. */
  daemon_server_url: string | null;
  /** Explicit per-host proxy address; null means it is derived. */
  provider_proxy_base_url: string | null;
  capabilities_json: Record<string, unknown> | null;
  created_at: string;
  updated_at: string;
}

export interface HostFailure {
  statusCode: number;
  detail: string;
}

export interface DaemonHelloInfo {
  platform?: string | null;
  arch?: string | null;
  daemon_version?: string | null;
  /** The control-plane address this daemon reaches; see `hosts.daemon_server_url`. */
  server_url?: string | null;
  capabilities_json?: Record<string, unknown> | null;
  /**
   * D1: which execution environment this is, distinct from `platform`
   * (Node's `process.platform`, which cannot tell WSL apart from native
   * Linux — both report `"linux"`). Not yet auto-detected by the daemon
   * (a real, deliberately deferred gap — see `environmentKindFromPlatform`);
   * a future daemon version can report it explicitly here without a
   * protocol change.
   */
  environment_kind?: string | null;
  workspace_reports?: WorkspaceLocationHeartbeat[] | null;
}

/** Safe default when a daemon does not (yet) report `environment_kind` explicitly. */
export function environmentKindFromPlatform(platform: string | null): string {
  if (platform === "win32") return "windows_native";
  if (platform === "darwin") return "macos_native";
  return "linux_native";
}

function hashToken(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

function rawToken(): string {
  return randomBytes(32).toString("base64url");
}

function rawPairingCode(): string {
  // Short, easy to retype at a terminal prompt — this is a short-lived,
  // one-time credential, not the long-lived bearer token.
  return randomBytes(9).toString("base64url").replace(/[-_]/g, "").slice(0, 10).toUpperCase();
}

export function isStale(lastHeartbeatAt: string | null): boolean {
  if (!lastHeartbeatAt) return true;
  return Date.now() - new Date(lastHeartbeatAt).getTime() > HEARTBEAT_STALE_MS;
}

function hostOut(row: HostRow): HostOut {
  // The server host is an in-process execution boundary, not a daemon
  // connection. It has no heartbeat by design, so liveness staleness only
  // applies to remote hosts.
  const status = row.kind === "server"
    ? "online"
    : row.status === "online" && isStale(row.last_heartbeat_at)
      ? "offline"
      : row.status;
  return {
    id: row.id,
    owner_user_id: row.owner_user_id,
    machine_id: row.machine_id,
    machine_name: row.machine_name ?? null,
    environment_kind: row.environment_kind,
    name: row.name,
    kind: row.kind,
    status,
    last_heartbeat_at: row.last_heartbeat_at,
    platform: row.platform,
    arch: row.arch,
    daemon_version: row.daemon_version,
    // Both surfaced so the Command Center can show which proxy address a host
    // will actually be handed, rather than making the operator guess whether
    // the derived one is in play.
    daemon_server_url: row.daemon_server_url ?? null,
    provider_proxy_base_url: row.provider_proxy_base_url ?? null,
    capabilities_json: row.capabilities_json,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

const HOST_COLUMNS = `id, owner_user_id, machine_id, environment_kind, name, kind, status, token_hash, pairing_code_expires_at,
  last_heartbeat_at, platform, arch, daemon_version, daemon_server_url, provider_proxy_base_url,
  capabilities_json, created_at, updated_at`;

export class PgHostRepository {
  constructor(private readonly pool: Queryable) {}

  /** Idempotent bootstrap: at most one `kind = 'server'` row ever exists (`uq_hosts_single_server`). */
  async ensureServerHostId(): Promise<string> {
    const existing = await this.pool.query<{ id: string }>(`SELECT id FROM hosts WHERE kind = 'server' LIMIT 1`);
    if (existing.rows[0]) return existing.rows[0].id;
    const machineId = await new PgMachineRepository(this.pool).ensureServerMachineId();
    const id = randomUUID();
    const now = new Date().toISOString();
    const inserted = await this.pool.query<{ id: string }>(
      `INSERT INTO hosts (id, owner_user_id, machine_id, environment_kind, name, kind, status, created_at, updated_at)
       VALUES ($1, NULL, $2, 'server', 'server', 'server', 'online', $3, $3)
       ON CONFLICT DO NOTHING
       RETURNING id`,
      [id, machineId, now],
    );
    if (inserted.rows[0]) return inserted.rows[0].id;
    // Lost the race against a concurrent bootstrap; the winner's row exists now.
    const winner = await this.pool.query<{ id: string }>(`SELECT id FROM hosts WHERE kind = 'server' LIMIT 1`);
    if (!winner.rows[0]) throw new Error("Failed to bootstrap the server host");
    return winner.rows[0].id;
  }

  /**
   * `machineId` names an *existing* Machine this host should join (the
   * Windows-native + WSL case: two hosts, one physical device) — omitted,
   * a fresh Machine is auto-created and named after the host, matching the
   * common case where each personal host is its own device. There is no
   * "pick or create a Machine" UI yet (P1.10 is grouping/display only, per
   * the plan); this parameter exists so that flow has somewhere to land
   * without a further schema change.
   */
  async issuePairingCode(
    ownerUserId: string,
    name: string,
    machineId?: string | null,
  ): Promise<{ host_id: string; pairing_code: string; expires_at: string } | HostFailure> {
    const trimmed = name.trim();
    if (!trimmed) return { statusCode: 422, detail: "name is required" };
    const id = randomUUID();
    const code = rawPairingCode();
    const now = new Date();
    const expiresAt = new Date(now.getTime() + PAIRING_CODE_TTL_MS).toISOString();
    // Keep the newly-created Machine available for cleanup if the Host insert
    // loses the owner/name uniqueness race. A caller-supplied Machine is not
    // ours to delete.
    const createdMachine = machineId
      ? null
      : await new PgMachineRepository(this.pool).create(ownerUserId, trimmed, null);
    const createdMachineId = createdMachine?.id ?? null;
    const hostMachineId = machineId ?? createdMachine!.id;
    try {
      await this.pool.query(
        `INSERT INTO hosts (id, owner_user_id, machine_id, environment_kind, name, kind, status, token_hash, pairing_code_expires_at, created_at, updated_at)
         VALUES ($1, $2, $3, 'linux_native', $4, 'remote', 'pending_pairing', $5, $6, $7, $7)`,
        [id, ownerUserId, hostMachineId, trimmed, hashToken(code), expiresAt, now.toISOString()],
      );
    } catch (error) {
      if (createdMachineId) {
        await this.pool.query(`DELETE FROM machines WHERE id = $1 AND owner_user_id = $2`, [createdMachineId, ownerUserId]);
      }
      if (isUniqueViolation(error)) {
        return { statusCode: 409, detail: `A host named '${trimmed}' already exists` };
      }
      throw error;
    }
    return { host_id: id, pairing_code: code, expires_at: expiresAt };
  }

  /**
   * One atomic UPDATE, not select-then-update: the WHERE clause re-checks
   * `status = 'pending_pairing'` at commit time, so two concurrent exchanges
   * of the same code cannot both succeed — Postgres serializes the UPDATEs
   * on the row, and the loser's WHERE clause no longer matches once the
   * winner has flipped `status` away from `pending_pairing`.
   */
  async registerViaPairingCode(
    code: string,
    info: DaemonHelloInfo,
  ): Promise<{ host_id: string; token: string; name: string } | HostFailure> {
    const codeHash = hashToken(code);
    const token = rawToken();
    const result = await this.pool.query<{ id: string; name: string }>(
      `UPDATE hosts
          SET token_hash = $2, pairing_code_expires_at = NULL, status = 'offline',
              platform = $3, arch = $4, daemon_version = $5, capabilities_json = $6::jsonb,
              environment_kind = $7,
              updated_at = $8
        WHERE token_hash = $1 AND status = 'pending_pairing' AND pairing_code_expires_at > now()
        RETURNING id, name`,
      [
        codeHash,
        hashToken(token),
        info.platform ?? null,
        info.arch ?? null,
        info.daemon_version ?? null,
        JSON.stringify(info.capabilities_json ?? {}),
        info.environment_kind ?? environmentKindFromPlatform(info.platform ?? null),
        new Date().toISOString(),
      ],
    );
    const registered = result.rows[0];
    if (!registered) return { statusCode: 401, detail: "Pairing code is invalid or has expired" };
    return { host_id: registered.id, token, name: registered.name };
  }

  /**
   * Bearer-token auth for the daemon's own calls (workspace routes, WS
   * hello/heartbeat). Only a completed registration authenticates —
   * `pending_pairing` is deliberately excluded alongside `revoked`: a
   * pairing code shares the `token_hash` column with the real bearer token
   * before `/register` runs, so accepting `pending_pairing` here would let
   * the short-lived, low-care pairing code itself act as a full host
   * credential for its whole TTL, defeating the point of a one-time
   * exchange-only secret.
   */
  async authenticate(token: string): Promise<HostRow | null> {
    const result = await this.pool.query<HostRow>(
      `SELECT ${HOST_COLUMNS} FROM hosts WHERE token_hash = $1 AND status IN ('online', 'offline') LIMIT 1`,
      [hashToken(token)],
    );
    return result.rows[0] ?? null;
  }

  async recordHeartbeat(hostId: string, info: DaemonHelloInfo): Promise<void> {
    await this.pool.query(
      `UPDATE hosts
          SET status = 'online', last_heartbeat_at = now(),
              platform = COALESCE($2, platform), arch = COALESCE($3, arch),
              daemon_version = COALESCE($4, daemon_version),
              capabilities_json = COALESCE($5::jsonb, capabilities_json),
              -- Refreshed on every heartbeat, not only at pairing: a daemon
              -- pointed at a new control-plane address should not keep handing
              -- out lease URLs derived from the old one.
              daemon_server_url = COALESCE($6, daemon_server_url),
              updated_at = now()
        WHERE id = $1 AND status <> 'revoked'`,
      [
        hostId,
        info.platform ?? null,
        info.arch ?? null,
        info.daemon_version ?? null,
        info.capabilities_json ? JSON.stringify(info.capabilities_json) : null,
        info.server_url ?? null,
      ],
    );
    if (info.workspace_reports) {
      const { PgWorkspaceLocationRepository } = await import("../projectFolders/workspaceLocations.js");
      await new PgWorkspaceLocationRepository(this.pool).recordDaemonHeartbeat(hostId, info.workspace_reports);
    }
  }

  async markOffline(hostId: string): Promise<void> {
    await this.pool.query(`UPDATE hosts SET status = 'offline', updated_at = now() WHERE id = $1 AND status = 'online'`, [hostId]);
  }

  /**
   * The server host plus every remote host the caller owns. Bootstraps the
   * server host on first call rather than requiring some unrelated flow
   * (e.g. creating a Project Folder) to have run first — a fresh instance
   * must show its server host immediately.
   */
  async listVisibleTo(ownerUserId: string): Promise<HostOut[]> {
    await this.ensureServerHostId();
    const result = await this.pool.query<HostRow>(
      `SELECT h.*, m.display_name AS machine_name FROM hosts h
       JOIN machines m ON m.id = h.machine_id
        WHERE h.kind = 'server' OR h.owner_user_id = $1
        ORDER BY (h.kind = 'server') DESC, h.created_at ASC`,
      [ownerUserId],
    );
    return result.rows.map(hostOut);
  }

  async getOwned(ownerUserId: string, hostId: string): Promise<HostOut | null> {
    const result = await this.pool.query<HostRow>(
      `SELECT ${HOST_COLUMNS} FROM hosts WHERE id = $1 AND owner_user_id = $2 LIMIT 1`,
      [hostId, ownerUserId],
    );
    const row = result.rows[0];
    return row ? hostOut(row) : null;
  }

  async revoke(ownerUserId: string, hostId: string): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE hosts SET status = 'revoked', token_hash = NULL, updated_at = now()
        WHERE id = $1 AND owner_user_id = $2 AND kind = 'remote'`,
      [hostId, ownerUserId],
    );
    return (result.rowCount ?? 0) > 0;
  }

  /**
   * A host may only upload artifacts for a Run whose Project Folder is
   * bound to that same host — this is the only authorization check the
   * upload endpoints need (ADR 0016 P3): the bearer token already proves
   * "this daemon", this proves "for one of its own Runs".
   */
  /**
   * execution-topology-and-project-control-plane-plan.md P1 / D3: a Run
   * binds to a Location, not a Folder — the JOIN goes through
   * `workspace_locations` (a Location has exactly one host) rather than
   * `project_folders` (which, after P1, no longer names one at all).
   */
  async runOwnedByHost(hostId: string, runId: string): Promise<RunForUpload | null> {
    const result = await this.pool.query<RunForUpload>(
      `SELECT r.id, r.space_id, r.owner_user_id, r.project_id, r.project_folder_id
         FROM runs r
         JOIN workspace_locations wl ON wl.id = r.workspace_location_id
        WHERE r.id = $1 AND wl.execution_host_id = $2
        LIMIT 1`,
      [runId, hostId],
    );
    return result.rows[0] ?? null;
  }

  /**
   * D7: a remote diff is a read-only run artifact, never a code-patch
   * proposal. Visibility is `space_shared` (project-scoped, since the row
   * also carries `project_id`/`project_folder_id` — see the `artifact`
   * ontology entity's `contentAccessible` declaration), not `private`: P4's
   * `GET /api/v1/hosts/threads` deliberately shows a thread to any Project
   * reader, not just the host owner (a thread's visibility follows Project
   * read access, not host ownership). A `private` artifact here would have
   * let a non-owner reader see "Review diff" on a thread/run they can
   * legitimately see, then get a false "no diff was uploaded" instead of an
   * access-denied — found during the plan's final integration review.
   */
  async recordDiffArtifact(
    run: RunForUpload,
    hostOwnerUserId: string,
    input: { diff: string; truncated: boolean },
  ): Promise<{ artifact_id: string }> {
    const id = randomUUID();
    const now = new Date().toISOString();
    const diff = input.diff.length > MAX_DIFF_BYTES ? input.diff.slice(0, MAX_DIFF_BYTES) : input.diff;
    const truncated = input.truncated || input.diff.length > MAX_DIFF_BYTES;
    await this.pool.query(
      `INSERT INTO artifacts (
         id, space_id, run_id, artifact_type, title, content, mime_type,
         exportable, export_formats_json, preview, created_at, updated_at,
         metadata_json, visibility, owner_user_id, trust_level, project_id, project_folder_id
       ) VALUES (
         $1, $2, $3, 'remote_diff', $4, $5, 'text/x-diff',
         true, $6::jsonb, false, $7, $7,
         $8::jsonb, 'space_shared', $9, 'unknown', $10, $11
       )`,
      [
        id,
        run.space_id,
        run.id,
        `Remote diff for run ${run.id}`,
        diff,
        JSON.stringify(["text/x-diff"]),
        now,
        JSON.stringify({ truncated }),
        hostOwnerUserId,
        run.project_id,
        run.project_folder_id,
      ],
    );
    return { artifact_id: id };
  }

  /**
   * One artifact per uploaded output file, capped in count and size (see
   * MAX_OUTPUT_FILES/MAX_OUTPUT_FILE_BYTES). Same `space_shared` visibility
   * reasoning as `recordDiffArtifact`, above.
   */
  async recordOutputArtifacts(
    run: RunForUpload,
    hostOwnerUserId: string,
    files: Array<{ name: string; content: string }>,
  ): Promise<{ artifact_ids: string[]; skipped: string[] }> {
    const artifactIds: string[] = [];
    const skipped: string[] = [];
    const now = new Date().toISOString();
    for (const file of files.slice(0, MAX_OUTPUT_FILES)) {
      if (file.content.length > MAX_OUTPUT_FILE_BYTES) {
        skipped.push(file.name);
        continue;
      }
      const id = randomUUID();
      await this.pool.query(
        `INSERT INTO artifacts (
           id, space_id, run_id, artifact_type, title, content, mime_type,
           exportable, export_formats_json, preview, created_at, updated_at,
           metadata_json, visibility, owner_user_id, trust_level, project_id, project_folder_id
         ) VALUES (
           $1, $2, $3, 'remote_output', $4, $5, 'text/plain',
           true, $6::jsonb, false, $7, $7,
           $8::jsonb, 'space_shared', $9, 'unknown', $10, $11
         )`,
        [
          id,
          run.space_id,
          run.id,
          file.name,
          file.content,
          JSON.stringify(["text/plain"]),
          now,
          JSON.stringify({ source_filename: file.name }),
          hostOwnerUserId,
          run.project_id,
          run.project_folder_id,
        ],
      );
      artifactIds.push(id);
    }
    if (files.length > MAX_OUTPUT_FILES) skipped.push(...files.slice(MAX_OUTPUT_FILES).map((f) => f.name));
    return { artifact_ids: artifactIds, skipped };
  }
}

export interface RunForUpload {
  id: string;
  space_id: string;
  owner_user_id: string | null;
  project_id: string | null;
  project_folder_id: string;
}

const MAX_DIFF_BYTES = 1_048_576;
const MAX_OUTPUT_FILE_BYTES = 2_097_152;
const MAX_OUTPUT_FILES = 20;

function isUniqueViolation(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && (error as { code?: string }).code === "23505");
}

let repositoryOverride: PgHostRepository | null = null;

export function __setHostRepositoryForTests(repository: PgHostRepository | null): void {
  repositoryOverride = repository;
}

export function hostRepositoryFromConfig(config: ServerConfig): PgHostRepository | null {
  if (repositoryOverride) return repositoryOverride;
  if (!config.databaseUrl) return null;
  return new PgHostRepository(getDbPool(config.databaseUrl));
}
