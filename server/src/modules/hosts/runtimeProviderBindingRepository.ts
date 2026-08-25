import { randomUUID } from "node:crypto";
import type { Queryable } from "../routeUtils/common";

/**
 * Per-Host, per-adapter default model backend. See `server/src/db/schema/hostRuntimeProviderBindings.ts` for why
 * the key excludes Space.
 */
export interface HostRuntimeProviderBinding {
  id: string;
  host_id: string;
  adapter_type: string;
  model_provider_id: string;
  model: string | null;
  created_by_user_id: string;
  created_at: string;
  updated_at: string;
}

const COLUMNS = `id, host_id, adapter_type, model_provider_id, model, created_by_user_id, created_at, updated_at`;

export class PgHostRuntimeProviderBindingRepository {
  constructor(private readonly db: Queryable) {}

  async listForHost(hostId: string): Promise<HostRuntimeProviderBinding[]> {
    const result = await this.db.query<HostRuntimeProviderBinding>(
      `SELECT ${COLUMNS} FROM host_runtime_provider_bindings WHERE host_id = $1 ORDER BY adapter_type ASC`,
      [hostId],
    );
    return result.rows;
  }

  async get(hostId: string, adapterType: string): Promise<HostRuntimeProviderBinding | null> {
    const result = await this.db.query<HostRuntimeProviderBinding>(
      `SELECT ${COLUMNS} FROM host_runtime_provider_bindings WHERE host_id = $1 AND adapter_type = $2 LIMIT 1`,
      [hostId, adapterType],
    );
    return result.rows[0] ?? null;
  }

  /** Idempotent per (host, adapter) — setting a default twice replaces it. */
  async upsert(input: {
    hostId: string;
    adapterType: string;
    modelProviderId: string;
    model: string | null;
    createdByUserId: string;
  }): Promise<HostRuntimeProviderBinding> {
    const now = new Date().toISOString();
    const result = await this.db.query<HostRuntimeProviderBinding>(
      `INSERT INTO host_runtime_provider_bindings (
         id, host_id, adapter_type, model_provider_id, model, created_by_user_id, created_at, updated_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $7)
       ON CONFLICT (host_id, adapter_type) DO UPDATE SET
         model_provider_id = EXCLUDED.model_provider_id,
         model = EXCLUDED.model,
         updated_at = EXCLUDED.updated_at
       RETURNING ${COLUMNS}`,
      [randomUUID(), input.hostId, input.adapterType, input.modelProviderId, input.model, input.createdByUserId, now],
    );
    return result.rows[0]!;
  }

  /** Clearing a binding returns the host's runs to ambient login state. */
  async clear(hostId: string, adapterType: string): Promise<boolean> {
    const result = await this.db.query(
      `DELETE FROM host_runtime_provider_bindings WHERE host_id = $1 AND adapter_type = $2`,
      [hostId, adapterType],
    );
    return (result.rowCount ?? 0) > 0;
  }
}
