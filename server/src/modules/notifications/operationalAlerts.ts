import { randomUUID } from "node:crypto";
import type { ServerConfig } from "../../config.js";
import { getDbPool } from "../../db/pool.js";
import type { Queryable } from "../routeUtils/common.js";
import { redactEvidenceText, sanitizeEvidenceJson } from "../runs/evidenceRedaction.js";

export interface OperationalAlertInput {
  kind: "job_exhausted" | "automation_fire_failed" | "scheduler_task_failed" | "autonomous_review_timeout";
  title: string;
  message: string;
  dedupeKey: string;
  spaceId: string;
  userId?: string | null;
  projectId?: string | null;
  sourceRunId?: string | null;
  payload?: Record<string, unknown>;
}

export interface OperationalAlertPort {
  emit(input: OperationalAlertInput): Promise<void>;
}

export class OperationalAlertService implements OperationalAlertPort {
  constructor(private readonly db: Queryable) {}

  static fromConfig(config: ServerConfig): OperationalAlertService | null {
    return config.databaseUrl ? new OperationalAlertService(getDbPool(config.databaseUrl)) : null;
  }

  async emit(input: OperationalAlertInput): Promise<void> {
    const now = new Date().toISOString();
    const aggregateKey = `operational_alert:${input.dedupeKey}`.slice(0, 128);
    const payload = sanitizeEvidenceJson({
      pointer_type: "operational_alert",
      alert_kind: input.kind,
      ...input.payload,
    });
    await this.db.query(
      `INSERT INTO activity_records (
         id, space_id, user_id, project_id, source_run_id, activity_type, title, content, payload_json,
         occurred_at, created_at, status, updated_at, source_kind, source_trust,
         visibility, owner_user_id, aggregate_key
       ) VALUES (
         $1, $2, $3, $4, $5, 'operational_alert', $6, $7, $8::jsonb,
         $9::timestamptz, $9::timestamptz, 'raw', $9::timestamptz,
         'system_event', 'internal_system', $10, $3, $11
       )
       ON CONFLICT (space_id, aggregate_key) WHERE aggregate_key IS NOT NULL
       DO UPDATE SET user_id = EXCLUDED.user_id,
                     owner_user_id = EXCLUDED.owner_user_id,
                     project_id = EXCLUDED.project_id,
                     source_run_id = EXCLUDED.source_run_id,
                     visibility = EXCLUDED.visibility,
                     title = EXCLUDED.title,
                     content = EXCLUDED.content,
                     payload_json = EXCLUDED.payload_json,
                     occurred_at = EXCLUDED.occurred_at,
                     updated_at = EXCLUDED.updated_at,
                     status = 'raw',
                     processed_at = NULL,
                     discarded_at = NULL`,
      [
        randomUUID(),
        input.spaceId,
        input.userId ?? null,
        input.projectId ?? null,
        input.sourceRunId ?? null,
        input.title.slice(0, 512),
        redactEvidenceText(input.message),
        JSON.stringify(payload),
        now,
        input.userId ? "private" : "space_shared",
        aggregateKey,
      ],
    );
  }

  async emitInstance(input: Omit<OperationalAlertInput, "spaceId" | "userId">): Promise<void> {
    const recipients = await this.db.query<{ space_id: string; user_id: string }>(
      `SELECT DISTINCT ON (m.space_id) m.space_id, m.user_id
         FROM space_memberships m
        WHERE m.status = 'active'
          AND m.role IN ('owner', 'admin')
        ORDER BY m.space_id, m.created_at ASC, m.user_id`,
    );
    for (const recipient of recipients.rows) {
      await this.emit({ ...input, spaceId: recipient.space_id, userId: recipient.user_id });
    }
  }
}

export async function safelyEmitOperationalAlert(
  alerts: OperationalAlertPort | null | undefined,
  input: OperationalAlertInput,
): Promise<void> {
  if (!alerts) return;
  try {
    await alerts.emit(input);
  } catch {
    // Alert persistence must not replace the originating failure or retry state.
  }
}
