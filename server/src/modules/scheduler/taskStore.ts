import { randomUUID } from "node:crypto";
import type { Queryable } from "../routeUtils/common.js";

export type SchedulerTaskScopeType = "instance" | "space" | "user" | "space_user";
export type SchedulerTaskStatus = "active" | "paused" | "archived";

export interface SchedulerTaskRow {
  id: string;
  task_type: string;
  task_key: string;
  scope_type: SchedulerTaskScopeType;
  scope_id: string;
  space_id: string | null;
  user_id: string | null;
  status: SchedulerTaskStatus;
  next_run_at: unknown;
  last_run_at: unknown;
  state_json: Record<string, unknown>;
  metadata_json: Record<string, unknown>;
  created_at: unknown;
  updated_at: unknown;
}

export interface SchedulerTaskUpsertInput {
  taskType: string;
  taskKey: string;
  scopeType: SchedulerTaskScopeType;
  scopeId: string;
  spaceId?: string | null;
  userId?: string | null;
  status?: SchedulerTaskStatus;
  nextRunAt?: string | null;
  lastRunAt?: string | null;
  stateJson?: Record<string, unknown>;
  metadataJson?: Record<string, unknown>;
  updatedAt?: string;
}

const SCHEDULER_TASK_COLUMNS = `
  id, task_type, task_key, scope_type, scope_id, space_id, user_id, status,
  next_run_at, last_run_at, state_json, metadata_json, created_at, updated_at
`;

export class PgSchedulerTaskStore {
  constructor(private readonly db: Queryable) {}

  async get(taskType: string, taskKey: string): Promise<SchedulerTaskRow | null> {
    const result = await this.db.query<SchedulerTaskRow>(
      `SELECT ${SCHEDULER_TASK_COLUMNS}
         FROM scheduler_tasks
        WHERE task_type = $1 AND task_key = $2
        LIMIT 1`,
      [taskType, taskKey],
    );
    return result.rows[0] ? normalizeSchedulerTaskRow(result.rows[0]) : null;
  }

  async listDue(taskType: string, nowIso: string, limit?: number): Promise<SchedulerTaskRow[]> {
    const params: unknown[] = [taskType, nowIso];
    let limitClause = "";
    if (typeof limit === "number") {
      params.push(limit);
      limitClause = `LIMIT $${params.length}`;
    }
    const result = await this.db.query<SchedulerTaskRow>(
      `SELECT ${SCHEDULER_TASK_COLUMNS}
         FROM scheduler_tasks
        WHERE task_type = $1
          AND status = 'active'
          AND next_run_at IS NOT NULL
          AND next_run_at <= $2
        ORDER BY next_run_at ASC
        ${limitClause}`,
      params,
    );
    return result.rows.map(normalizeSchedulerTaskRow);
  }

  async upsert(input: SchedulerTaskUpsertInput): Promise<SchedulerTaskRow> {
    const now = input.updatedAt ?? new Date().toISOString();
    const result = await this.db.query<SchedulerTaskRow>(
      `INSERT INTO scheduler_tasks (
         id, task_type, task_key, scope_type, scope_id, space_id, user_id, status,
         next_run_at, last_run_at, state_json, metadata_json, created_at, updated_at
       ) VALUES (
         $1, $2, $3, $4, $5, $6, $7, $8,
         $9, $10, $11::jsonb, $12::jsonb, $13, $13
       )
       ON CONFLICT (task_type, task_key)
       DO UPDATE SET
         scope_type = EXCLUDED.scope_type,
         scope_id = EXCLUDED.scope_id,
         space_id = EXCLUDED.space_id,
         user_id = EXCLUDED.user_id,
         status = EXCLUDED.status,
         next_run_at = EXCLUDED.next_run_at,
         last_run_at = COALESCE(EXCLUDED.last_run_at, scheduler_tasks.last_run_at),
         state_json = EXCLUDED.state_json,
         metadata_json = EXCLUDED.metadata_json,
         updated_at = EXCLUDED.updated_at
       RETURNING ${SCHEDULER_TASK_COLUMNS}`,
      [
        randomUUID(),
        input.taskType,
        input.taskKey,
        input.scopeType,
        input.scopeId,
        input.spaceId ?? null,
        input.userId ?? null,
        input.status ?? "active",
        input.nextRunAt ?? null,
        input.lastRunAt ?? null,
        JSON.stringify(jsonObject(input.stateJson ?? {})),
        JSON.stringify(jsonObject(input.metadataJson ?? {})),
        now,
      ],
    );
    return normalizeSchedulerTaskRow(result.rows[0]!);
  }
}

function normalizeSchedulerTaskRow(row: SchedulerTaskRow): SchedulerTaskRow {
  return {
    ...row,
    state_json: jsonObject(row.state_json),
    metadata_json: jsonObject(row.metadata_json),
  };
}

function jsonObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}
