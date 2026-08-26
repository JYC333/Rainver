import { randomUUID } from "node:crypto";
import { getDbPool, type Pool } from "../../db/pool.js";
import type { ServerConfig } from "../../config.js";
import {
  validateNetworkProfileInput,
  type NetworkProfileMode,
  type ResolvedNetworkProfile,
} from "./transport.js";

export interface NetworkProfileCreateInput {
  name: string;
  mode?: NetworkProfileMode;
  proxy_url?: string | null;
  no_proxy?: string | null;
  enabled?: boolean;
}

export interface NetworkProfileUpdateInput {
  name?: string;
  mode?: NetworkProfileMode;
  proxy_url?: string | null;
  no_proxy?: string | null;
  enabled?: boolean;
}

interface NetworkProfileRow {
  id: string;
  space_id: string;
  name: string;
  mode: NetworkProfileMode;
  proxy_url: string | null;
  no_proxy: string | null;
  enabled: boolean;
  created_at: Date;
  updated_at: Date;
}

export class NetworkProfileError extends Error {
  constructor(readonly statusCode: number, message: string) {
    super(message);
    this.name = "NetworkProfileError";
  }
}

export class NetworkProfileRepository {
  private pool: Pool;

  constructor(config: ServerConfig) {
    if (!config.databaseUrl) {
      throw new Error("Network profiles require SERVER_DATABASE_URL");
    }
    this.pool = getDbPool(config.databaseUrl);
  }

  async list(spaceId: string): Promise<Record<string, unknown>[]> {
    const result = await this.pool.query<NetworkProfileRow>(
      `SELECT id, space_id, name, mode, proxy_url, no_proxy, enabled, created_at, updated_at
         FROM network_profiles
        WHERE space_id = $1
        ORDER BY created_at DESC`,
      [spaceId],
    );
    return result.rows.map(mapNetworkProfileRow);
  }

  async get(spaceId: string, id: string): Promise<Record<string, unknown> | null> {
    const row = await this.getRow(spaceId, id, false);
    return row ? mapNetworkProfileRow(row) : null;
  }

  async create(spaceId: string, input: NetworkProfileCreateInput): Promise<Record<string, unknown>> {
    const name = input.name.trim();
    if (!name) throw new NetworkProfileError(400, "name must not be empty");
    const normalized = validateNetworkProfileInput({
      mode: input.mode ?? "http_proxy",
      proxy_url: input.proxy_url,
      no_proxy: input.no_proxy,
    });
    const id = randomUUID();
    const now = new Date();
    const result = await this.pool.query<NetworkProfileRow>(
      `INSERT INTO network_profiles
        (id, space_id, name, mode, proxy_url, no_proxy, enabled, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8)
       RETURNING id, space_id, name, mode, proxy_url, no_proxy, enabled, created_at, updated_at`,
      [
        id,
        spaceId,
        name,
        normalized.mode,
        normalized.proxy_url,
        normalized.no_proxy,
        input.enabled ?? true,
        now,
      ],
    );
    return mapNetworkProfileRow(result.rows[0]);
  }

  async update(
    spaceId: string,
    id: string,
    input: NetworkProfileUpdateInput,
  ): Promise<Record<string, unknown>> {
    const current = await this.getRow(spaceId, id, true);
    const name = input.name === undefined ? current.name : input.name.trim();
    if (!name) throw new NetworkProfileError(400, "name must not be empty");
    const normalized = validateNetworkProfileInput({
      mode: input.mode ?? current.mode,
      proxy_url: input.proxy_url === undefined ? current.proxy_url : input.proxy_url,
      no_proxy: input.no_proxy === undefined ? current.no_proxy : input.no_proxy,
    });
    const result = await this.pool.query<NetworkProfileRow>(
      `UPDATE network_profiles
          SET name = $3,
              mode = $4,
              proxy_url = $5,
              no_proxy = $6,
              enabled = $7,
              updated_at = $8
        WHERE id = $1 AND space_id = $2
        RETURNING id, space_id, name, mode, proxy_url, no_proxy, enabled, created_at, updated_at`,
      [
        id,
        spaceId,
        name,
        normalized.mode,
        normalized.proxy_url,
        normalized.no_proxy,
        input.enabled ?? current.enabled,
        new Date(),
      ],
    );
    return mapNetworkProfileRow(result.rows[0]);
  }

  async delete(spaceId: string, id: string): Promise<void> {
    const result = await this.pool.query(
      `DELETE FROM network_profiles WHERE id = $1 AND space_id = $2`,
      [id, spaceId],
    );
    if (result.rowCount === 0) {
      throw new NetworkProfileError(404, `NetworkProfile '${id}' not found`);
    }
  }

  async resolve(spaceId: string, id: string | null | undefined): Promise<ResolvedNetworkProfile | null> {
    if (!id) return null;
    return this.getRow(spaceId, id, false);
  }

  private async getRow(
    spaceId: string,
    id: string,
    required: true,
  ): Promise<NetworkProfileRow>;
  private async getRow(
    spaceId: string,
    id: string,
    required: false,
  ): Promise<NetworkProfileRow | null>;
  private async getRow(
    spaceId: string,
    id: string,
    required: boolean,
  ): Promise<NetworkProfileRow | null> {
    const result = await this.pool.query<NetworkProfileRow>(
      `SELECT id, space_id, name, mode, proxy_url, no_proxy, enabled, created_at, updated_at
         FROM network_profiles
        WHERE space_id = $1 AND id = $2
        LIMIT 1`,
      [spaceId, id],
    );
    const row = result.rows[0] ?? null;
    if (!row && required) {
      throw new NetworkProfileError(404, `NetworkProfile '${id}' not found`);
    }
    return row;
  }
}

let repository: NetworkProfileRepository | null = null;
let repositoryKey: string | null = null;

export function resolveNetworkProfileRepository(config: ServerConfig): NetworkProfileRepository {
  const key = config.databaseUrl ?? "";
  if (!repository || repositoryKey !== key) {
    repository = new NetworkProfileRepository(config);
    repositoryKey = key;
  }
  return repository;
}

export function mapNetworkProfileRow(row: NetworkProfileRow): Record<string, unknown> {
  return {
    id: row.id,
    space_id: row.space_id,
    name: row.name,
    mode: row.mode,
    proxy_url: row.proxy_url,
    no_proxy: row.no_proxy,
    enabled: Boolean(row.enabled),
    created_at: row.created_at.toISOString(),
    updated_at: row.updated_at.toISOString(),
  };
}
