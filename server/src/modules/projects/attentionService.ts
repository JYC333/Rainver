import { randomUUID } from "node:crypto";
import type { ServerConfig } from "../../config";
import { HttpError, dateIso, type Queryable, type SpaceUserIdentity } from "../routeUtils/common";
import { getDbPool } from "../../db/pool";
import { assertProjectReadable } from "./access";
import {
  projectAttentionRegistry,
  sortAttentionItems,
  type ProjectAttentionAdapter,
  type ProjectAttentionItem,
} from "./attentionRegistry";

interface UserStateRow {
  source_type: string;
  source_id: string;
  seen_at: unknown;
  snoozed_until: unknown;
  pinned_at: unknown;
}

// Built-in adapter over the existing generic `project_operations` state
// machine: any operation waiting for a human decision is an attention item.
// This proves the registry mechanism end to end; Inquiry/Experiment/Decision
// register their own adapters at module initialization.
const projectOperationsAttentionAdapter: ProjectAttentionAdapter = {
  areaKind: "project_operations",
  async listAttentionItems(db, identity, projectId) {
    const rows = await db.query<{ id: string; title: string; kind: string; intent_text: string | null; updated_at: unknown }>(
      `SELECT id, title, kind, intent_text, updated_at
         FROM project_operations
        WHERE space_id = $1 AND project_id = $2 AND status = 'waiting_review'
        ORDER BY updated_at DESC`,
      [identity.spaceId, projectId],
    );
    return rows.rows.map((row): ProjectAttentionItem => ({
      id: `project_operation:${row.id}`,
      project_id: projectId,
      area_kind: "project_operations",
      source_type: "project_operation",
      source_id: row.id,
      severity: "normal",
      title: row.title,
      summary: row.intent_text,
      reason: `${row.kind} operation is waiting for review`,
      due_at: null,
      blocking_refs: [],
      action_descriptors: [{ label: "Review", href: `/projects/${projectId}/operations?open=${row.id}` }],
      href: `/projects/${projectId}/operations?open=${row.id}`,
    }));
  },
};

// `register` is an upsert, so calling this repeatedly (route module init,
// or a test that resets the registry between cases) is safe.
export function registerBuiltInAttentionAdapters(): void {
  projectAttentionRegistry.register(projectOperationsAttentionAdapter);
}

export class ProjectAttentionService {
  constructor(private readonly db: Queryable) {}

  static fromConfig(config: ServerConfig): ProjectAttentionService {
    if (!config.databaseUrl) throw new HttpError(502, "SERVER_DATABASE_URL is required");
    return new ProjectAttentionService(getDbPool(config.databaseUrl));
  }

  async listAttentionItems(identity: SpaceUserIdentity, projectId: string): Promise<Record<string, unknown>[]> {
    await assertProjectReadable(this.db, identity.spaceId, projectId, identity.userId);
    const perAdapter = await Promise.all(
      projectAttentionRegistry.list().map((adapter) => adapter.listAttentionItems(this.db, identity, projectId)),
    );
    const items = sortAttentionItems(perAdapter.flat());
    const states = await this.userStatesByKey(identity, projectId);
    const now = Date.now();
    return items
      .filter((item) => {
        const state = states.get(`${item.source_type}:${item.source_id}`);
        if (!state?.snoozed_until) return true;
        // Hide only while still within the snooze window; an elapsed snooze
        // must not permanently suppress the item.
        return Date.parse(state.snoozed_until) <= now;
      })
      .map((item) => ({
        ...item,
        user_state: states.get(`${item.source_type}:${item.source_id}`) ?? null,
      }));
  }

  private async userStatesByKey(
    identity: SpaceUserIdentity,
    projectId: string,
  ): Promise<Map<string, { seen_at: string | null; snoozed_until: string | null; pinned_at: string | null }>> {
    const rows = await this.db.query<UserStateRow>(
      `SELECT source_type, source_id, seen_at, snoozed_until, pinned_at
         FROM project_attention_user_states
        WHERE space_id = $1 AND project_id = $2 AND user_id = $3`,
      [identity.spaceId, projectId, identity.userId],
    );
    const map = new Map<string, { seen_at: string | null; snoozed_until: string | null; pinned_at: string | null }>();
    for (const row of rows.rows) {
      map.set(`${row.source_type}:${row.source_id}`, {
        seen_at: dateIso(row.seen_at),
        snoozed_until: dateIso(row.snoozed_until),
        pinned_at: dateIso(row.pinned_at),
      });
    }
    return map;
  }

  async setUserState(
    identity: SpaceUserIdentity,
    projectId: string,
    sourceType: string,
    sourceId: string,
    patch: { seen_at?: string | null; snoozed_until?: string | null; pinned_at?: string | null },
  ): Promise<Record<string, unknown>> {
    await assertProjectReadable(this.db, identity.spaceId, projectId, identity.userId);
    for (const [name, value] of Object.entries(patch)) {
      if (value !== null && value !== undefined && !Number.isFinite(Date.parse(value))) {
        throw new HttpError(422, `${name} must be an ISO timestamp or null`);
      }
    }
    const now = new Date().toISOString();
    const result = await this.db.query<UserStateRow>(
      `INSERT INTO project_attention_user_states (
         id, space_id, project_id, user_id, source_type, source_id, seen_at, snoozed_until, pinned_at, updated_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       ON CONFLICT (user_id, project_id, source_type, source_id)
       DO UPDATE SET
         seen_at = CASE WHEN $11::boolean THEN $12::timestamptz ELSE project_attention_user_states.seen_at END,
         snoozed_until = CASE WHEN $13::boolean THEN $14::timestamptz ELSE project_attention_user_states.snoozed_until END,
         pinned_at = CASE WHEN $15::boolean THEN $16::timestamptz ELSE project_attention_user_states.pinned_at END,
         updated_at = $17
       RETURNING source_type, source_id, seen_at, snoozed_until, pinned_at`,
      [
        randomUUID(),
        identity.spaceId,
        projectId,
        identity.userId,
        sourceType,
        sourceId,
        patch.seen_at ?? null,
        patch.snoozed_until ?? null,
        patch.pinned_at ?? null,
        now,
        Object.prototype.hasOwnProperty.call(patch, "seen_at"),
        patch.seen_at ?? null,
        Object.prototype.hasOwnProperty.call(patch, "snoozed_until"),
        patch.snoozed_until ?? null,
        Object.prototype.hasOwnProperty.call(patch, "pinned_at"),
        patch.pinned_at ?? null,
        now,
      ],
    );
    const row = result.rows[0]!;
    return {
      source_type: row.source_type,
      source_id: row.source_id,
      seen_at: dateIso(row.seen_at),
      snoozed_until: dateIso(row.snoozed_until),
      pinned_at: dateIso(row.pinned_at),
    };
  }
}
