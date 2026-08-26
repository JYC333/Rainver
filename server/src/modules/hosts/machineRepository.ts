import { randomUUID } from "node:crypto";
import type { Queryable } from "../routeUtils/common.js";

/**
 * execution-topology-and-project-control-plane-plan.md P1 / D1: a physical
 * device's identity. See `server/src/db/schema/machines.ts` for what this
 * deliberately does not carry (paths, runtime state, capabilities — those
 * stay on the `hosts`/ExecutionHost rows it owns).
 */
export interface MachineRow {
  id: string;
  owner_user_id: string | null;
  display_name: string;
  device_kind: string | null;
  created_at: string;
  updated_at: string;
}

const MACHINE_COLUMNS = `id, owner_user_id, display_name, device_kind, created_at, updated_at`;

export class PgMachineRepository {
  constructor(private readonly pool: Queryable) {}

  /** Idempotent bootstrap, mirroring `PgHostRepository.ensureServerHostId` — at most one system Machine backs the server host. */
  async ensureServerMachineId(): Promise<string> {
    const existing = await this.pool.query<{ id: string }>(
      `SELECT m.id FROM machines m JOIN hosts h ON h.machine_id = m.id WHERE h.kind = 'server' LIMIT 1`,
    );
    if (existing.rows[0]) return existing.rows[0].id;
    return (await this.create(null, "Rainver Server", "server")).id;
  }

  async create(ownerUserId: string | null, displayName: string, deviceKind: string | null): Promise<MachineRow> {
    const id = randomUUID();
    const now = new Date().toISOString();
    const row = await this.pool.query<MachineRow>(
      `INSERT INTO machines (id, owner_user_id, display_name, device_kind, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $5)
       RETURNING ${MACHINE_COLUMNS}`,
      [id, ownerUserId, displayName, deviceKind, now],
    );
    return row.rows[0]!;
  }

  async get(ownerUserId: string, machineId: string): Promise<MachineRow | null> {
    const result = await this.pool.query<MachineRow>(
      `SELECT ${MACHINE_COLUMNS} FROM machines WHERE id = $1 AND owner_user_id = $2 LIMIT 1`,
      [machineId, ownerUserId],
    );
    return result.rows[0] ?? null;
  }

  async listOwned(ownerUserId: string): Promise<MachineRow[]> {
    const result = await this.pool.query<MachineRow>(
      `SELECT ${MACHINE_COLUMNS} FROM machines WHERE owner_user_id = $1 ORDER BY created_at ASC`,
      [ownerUserId],
    );
    return result.rows;
  }
}
