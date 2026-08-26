import { randomUUID } from "node:crypto";
import type { Queryable, SpaceUserIdentity } from "../routeUtils/common.js";
import { HttpError } from "../routeUtils/common.js";

export interface GraphViewStateRecord {
  scope_key: string;
  state_json: Record<string, unknown>;
  updated_at: string | null;
}

export class GraphViewStateRepository {
  constructor(private readonly db: Queryable) {}

  async get(identity: SpaceUserIdentity, scopeKey: string): Promise<GraphViewStateRecord> {
    validateScopeKey(scopeKey);
    const row = await this.db.query<{
      scope_key: string;
      state_json: Record<string, unknown>;
      updated_at: Date | string;
    }>(
      `SELECT scope_key, state_json, updated_at
         FROM graph_view_states
        WHERE space_id = $1
          AND user_id = $2
          AND scope_key = $3`,
      [identity.spaceId, identity.userId, scopeKey],
    );
    const state = row.rows[0];
    if (!state) return { scope_key: scopeKey, state_json: {}, updated_at: null };
    return {
      scope_key: state.scope_key,
      state_json: normalizeStateObject(state.state_json),
      updated_at: iso(state.updated_at),
    };
  }

  async upsert(
    identity: SpaceUserIdentity,
    scopeKey: string,
    stateJson: Record<string, unknown>,
  ): Promise<GraphViewStateRecord> {
    validateScopeKey(scopeKey);
    const normalized = normalizeStateObject(stateJson);
    const row = await this.db.query<{
      scope_key: string;
      state_json: Record<string, unknown>;
      updated_at: Date | string;
    }>(
      `INSERT INTO graph_view_states (
         id, space_id, user_id, scope_key, state_json, created_at, updated_at
       ) VALUES ($1, $2, $3, $4, $5::jsonb, now(), now())
       ON CONFLICT (space_id, user_id, scope_key)
       DO UPDATE SET state_json = EXCLUDED.state_json, updated_at = now()
       RETURNING scope_key, state_json, updated_at`,
      [randomUUID(), identity.spaceId, identity.userId, scopeKey, JSON.stringify(normalized)],
    );
    const state = row.rows[0];
    if (!state) throw new HttpError(500, "Graph view state was not saved");
    return {
      scope_key: state.scope_key,
      state_json: normalizeStateObject(state.state_json),
      updated_at: iso(state.updated_at),
    };
  }
}

export function validateScopeKey(scopeKey: string): void {
  if (!scopeKey.trim()) throw new HttpError(422, "scope_key is required");
  if (scopeKey.length > 128) throw new HttpError(422, "scope_key must be 128 characters or fewer");
}

export function normalizeStateObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new HttpError(422, "state_json must be an object");
  }
  return value as Record<string, unknown>;
}

function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}
