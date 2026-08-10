import { resolveContentCreationContext } from "../access/creationContext";
import { PgKnowledgeRepository } from "../knowledge/repository";
import { HttpError, withDbTransaction, type Queryable } from "../routeUtils/common";
import { getDbPool, type Pool } from "../../db/pool";
import type { ServerConfig } from "../../config";

interface ActivityRow {
  id: string;
  space_id: string;
  title: string | null;
  content: string | null;
  payload_json: Record<string, unknown> | null;
  status: string;
  space_type: string;
}

export interface CaptureFilingResult {
  activity_id: string;
  object_id: string;
  target_space_id: string;
  target_project_id: string;
  visibility: "space_shared";
  filed_at: string;
}

/**
 * Files a personal capture into a Project (ADR 0013 decision 6).
 *
 * Both halves are writes and both are checked: the caller must own the capture,
 * and `resolveContentCreationContext` re-checks writer authority on the target
 * Project, which is what makes the Space hop safe without widening any read
 * path. Nothing is copied — the capture stays put and a new object is created.
 */
export class CaptureFilingService {
  constructor(private readonly pool: Pool) {}

  static fromConfig(config: ServerConfig): CaptureFilingService {
    if (!config.databaseUrl) throw new HttpError(502, "SERVER_DATABASE_URL is required");
    return new CaptureFilingService(getDbPool(config.databaseUrl));
  }

  async file(input: {
    userId: string;
    activityId: string;
    targetProjectId: string;
    title?: string;
  }): Promise<CaptureFilingResult> {
    return withDbTransaction(this.pool, async (client) => {
      const activity = await this.loadOwnedCapture(client, input.userId, input.activityId);
      const targetSpaceId = await this.targetSpaceId(client, input.targetProjectId);
      const context = await resolveContentCreationContext(client, {
        userId: input.userId,
        requestSpaceId: targetSpaceId,
        projectId: input.targetProjectId,
      });
      if (!context.projectId) throw new HttpError(422, "Filing requires a Project target");

      const title = input.title ?? activity.title ?? "Filed capture";
      const note = await new PgKnowledgeRepository(client).createNote(
        { spaceId: context.spaceId, userId: input.userId },
        {
          title,
          plain_text: activity.content ?? "",
          visibility: context.visibility,
          primary_project_id: context.projectId,
          created_from_activity_id: activity.id,
        },
      );
      const objectId = String(note.id);
      const filedAt = new Date().toISOString();
      await client.query(
        `UPDATE activity_records
            SET status = 'processed',
                processed_at = $3,
                updated_at = $3,
                payload_json = COALESCE(payload_json, '{}'::jsonb) || $4::jsonb
          WHERE id = $1 AND space_id = $2`,
        [activity.id, activity.space_id, filedAt, JSON.stringify({
          filed_into: {
            space_id: context.spaceId,
            project_id: context.projectId,
            object_id: objectId,
            filed_at: filedAt,
          },
        })],
      );
      return {
        activity_id: activity.id,
        object_id: objectId,
        target_space_id: context.spaceId,
        target_project_id: context.projectId,
        visibility: "space_shared",
        filed_at: filedAt,
      };
    });
  }

  /**
   * The capture must be the caller's own and must live in their personal Space.
   * Filing is the personal -> Project direction only; content already inside a
   * Space is moved with the ordinary content-access API, not this route.
   */
  private async loadOwnedCapture(db: Queryable, userId: string, activityId: string): Promise<ActivityRow> {
    const result = await db.query<ActivityRow>(
      `SELECT ar.id, ar.space_id, ar.title, ar.content, ar.payload_json, ar.status,
              space.type AS space_type
         FROM activity_records ar
         JOIN spaces space ON space.id = ar.space_id
         JOIN space_memberships membership
           ON membership.space_id = ar.space_id
          AND membership.user_id = $2
          AND membership.status = 'active'
        WHERE ar.id = $1
          AND ar.owner_user_id = $2
          AND ar.discarded_at IS NULL
        LIMIT 1
        FOR UPDATE OF ar`,
      [activityId, userId],
    );
    const row = result.rows[0];
    if (!row) throw new HttpError(404, "Capture not found");
    if (row.space_type !== "personal") {
      throw new HttpError(422, "Only personal captures are filed; use the content-access API in a shared Space");
    }
    if (row.status === "archived") throw new HttpError(409, "Capture is archived");
    const filed = (row.payload_json as { filed_into?: unknown } | null)?.filed_into;
    if (filed) throw new HttpError(409, "Capture has already been filed");
    return row;
  }

  private async targetSpaceId(db: Queryable, projectId: string): Promise<string> {
    const result = await db.query<{ space_id: string }>(
      `SELECT space_id FROM projects WHERE id = $1 AND deleted_at IS NULL LIMIT 1`,
      [projectId],
    );
    const spaceId = result.rows[0]?.space_id;
    if (!spaceId) throw new HttpError(404, "Project not found");
    return spaceId;
  }
}
